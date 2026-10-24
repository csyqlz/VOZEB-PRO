import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { writeAuthDb } from "@/lib/auth/store-repository";
import { consumePoints, refundPoints } from "./points-wallet-service";
import * as shadowService from "./model-pricing-shadow-service";
import { observeFixedMediaRefund, reconcileMediaShadowRefundBatch } from "./model-pricing-shadow-refund";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import { saveVideoPriceContract } from "./model-pricing-video-contract-store";
import { beginShadowVideoCall, acknowledgeShadowVideoCall, finishShadowVideoCall, observeVideoShadowResult, recoverVideoShadowResult } from "./model-pricing-shadow-video-call";
import { HAILUO_PRICE_TIERS, inspectHailuoObservation } from "./model-pricing-hailuo-contract";
import { inspectMinimaxVideoUsage } from "./model-pricing-video-usage";
import type { VideoTask } from "./video-task-store";
import { saveImagePriceContract } from "./model-pricing-image-contract-store";
import { beginShadowImageCall, finishShadowImageCall, revalueShadowImageCall } from "./model-pricing-shadow-image-call";
import { inspectOpenAiImageUsage } from "./model-pricing-image-usage";
import { hasShadowPriceReversal, getShadowPriceExactTotal, mutateShadowImageCall } from "./model-pricing-shadow-store";

import { saveAudioPriceContract } from "./model-pricing-audio-contract-store";
import { beginShadowAudioCall, finishShadowAudioCall, recoverAudioShadowResult } from "./model-pricing-shadow-audio-call";
import { inspectAudioUsage } from "./model-pricing-audio-usage";
import type { AudioTask } from "./audio-task-store";
import * as shadowStore from "./model-pricing-shadow-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const payload = {
    data: [{ b64_json: "PRIVATE_IMAGE", revised_prompt: "PRIVATE_REPLY" }],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 0 } },
};
const publishedAt = "2026-10-01T00:00:00Z";
describe.each(["image", "video", "hailuo", "audio", "openai-audio"] as const)("%s fixed refund reconciliation", (kind) => {
    describe.each(providers)("%s", (provider) => {
        const usageKind = kind === "openai-audio" ? "audio" : kind === "hailuo" ? "video" : kind;
        const isVideo = usageKind === "video";
        const videoModel = kind === "hailuo" ? "MiniMax-Hailuo-2.3" : "MiniMax-H3";
        const queryPath = kind === "hailuo" ? "/v1/query/video_generation?task_id=original" : "/v2/query/video_generation/original";
        const isAudio = usageKind === "audio";
        const audioProtocol = kind === "openai-audio" ? "openai" : "gemini";
        const audioUsageProtocol = kind === "openai-audio" ? "openai-chat-audio" : "gemini-tts";
        let directory: string;
        let userId: string;
        const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-image-shadow-"));
            process.env.VOZEB_PRO_DATA_DIR = directory;
            process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
            userId = randomUUID();
            if (provider === "postgres") await initializePostgresSchema();
            const db = emptyDb();
            const settings = provider === "postgres" ? await getFreshAuthSettings() : db.settings;
            const now = new Date().toISOString();
            const user = {
                id: userId,
                accountId: "0001",
                username: `refund_${userId}`,
                displayName: "图片退款测试",
                bio: "",
                role: "user" as const,
                adminPermissions: [],
                status: "active" as const,
                planId: settings.entitlements.defaultPlanId,
                pointsBalance: 10,
                passwordHash: "fixture",
                createdAt: now,
                updatedAt: now,
            };
            if (provider === "postgres") await createPostgresRepositories().users.createWithNextAccountId(user);
            else {
                db.users.push(user);
                await writeAuthDb(db);
            }
            await publish();
        });
        afterEach(async () => {
            vi.restoreAllMocks();
            if (provider === "postgres") await createPostgresRepositories().users.delete(userId);
            if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
            else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
            if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
            else process.env.VOZEB_PRO_DATA_DIR = original.directory;
            await rm(directory, { recursive: true, force: true });
        });
        const input = (operation = "generations") => ({
            userId,
            requestId: `system-ai:${randomUUID()}`,
            requestFingerprint: "a".repeat(64),
            modelId: "image-model",
            channelId: "channel",
            requestedModel: "image",
            path: ["v1", "images", operation],
            payload: { model: "image", prompt: "PRIVATE_PROMPT", image: "PRIVATE_REFERENCE" },
        });
        const videoPayload =
            kind === "hailuo"
                ? { task_id: "original", status: "Success", file_id: "original-file", video_width: 1920, video_height: 1080, base_resp: { status_code: 0 } }
                : {
                      task: {
                          id: "original",
                          model: "MiniMax-H3",
                          resolution: "768P",
                          status: "succeeded",
                          task_type: "generation",
                          modality: "video",
                          content: { url: "https://fixture.example.com/private-video" },
                          usage: { total_seconds: 1e-7, input_seconds: 0, output_seconds: 1e-7, input_image_count: 0, input_audio_seconds: 0 },
                      },
                  };
        const audioModel = kind === "openai-audio" ? "gpt-audio-1.5" : "gemini-2.5-flash-preview-tts";
        const audioPayload =
            kind === "openai-audio"
                ? {
                      model: audioModel,
                      service_tier: "default",
                      choices: [{ message: { audio: { data: "PRIVATE_AUDIO" } } }],
                      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, prompt_tokens_details: { text_tokens: 1, audio_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { text_tokens: 0, audio_tokens: 0 } },
                  }
                : {
                      modelVersion: audioModel,
                      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "PRIVATE_AUDIO" } }] } }],
                      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, totalTokenCount: 1, promptTokensDetails: [{ modality: "TEXT", tokenCount: 1 }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 0 }] },
                  };
        const exact = () => (kind === "hailuo" ? "21/20" : kind !== "video" ? "7/10000" : "7/1250000");
        const doubled = () => (kind === "hailuo" ? "21/10" : kind !== "video" ? "7/5000" : "7/625000");
        async function publish(coefficient = "1", operation: "generations" | "edits" = "generations") {
            const version: OfficialPriceVersion = {
                id: randomUUID(),
                candidateId: "fixture",
                logicalModelId: "image-model",
                manufacturer: "Fixture",
                series: "Image",
                officialVersion: "image",
                sku: "image",
                tier: "paid",
                conditions: "Synthetic global standard direct image tokens",
                sourceKind: "manual",
                sourceUrl: "https://example.com/fixture",
                evidence: "fixture",
                observedAt: publishedAt,
                publishedAt,
                reviewedBy: "fixture-admin",
                items: [
                    { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                    { key: "output", unit: "token", per: "1000000", price: "1", currency: "USD" },
                ],
            };
            if (kind === "video") {
                version.sku = "MiniMax-H3";
                version.manufacturer = "MiniMax";
                version.series = "H3";
                version.officialVersion = "MiniMax-H3";
                version.items = [
                    ...["768P", "2K"].flatMap((r) => ["input", "output"].map((k) => ({ key: `${r}-${k}`, unit: "second", per: "1", price: "0.08", currency: "USD" }))),
                    { key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" },
                    { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
                ];
            }
            if (kind === "hailuo") {
                version.sku = videoModel;
                version.items = HAILUO_PRICE_TIERS.map((key) => ({ key, unit: "video", per: "1", price: "0.0015", currency: "USD" }));
            }
            if (isAudio) version.sku = audioModel;
            if (kind === "openai-audio") version.items = ["inputText", "inputAudio", "outputText", "outputAudio"].map((key) => ({ key, unit: "token", per: "1000000", price: "1", currency: "USD" }));
            const policy: SalesVersion = {
                id: randomUUID(),
                publishedAt,
                publishedBy: "fixture-admin",
                priceVersionIds: { [version.logicalModelId]: version.id },
                userPriceRules: [{ scope: "default", coefficient }],
                conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
                usdPerCurrency: { USD: "1" },
                pointsPerCurrency: { USD: "700", CNY: "100" },
                rateEvidence: { USD: "fixture" },
            };
            if (provider === "postgres") {
                await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [version.id, version.logicalModelId, publishedAt, JSON.stringify(version)]);
                await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [policy.id, publishedAt, JSON.stringify(policy)]);
                await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1 WHERE id = 'default'", [policy.id]);
            } else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
            if (kind === "hailuo")
                return {
                    version,
                    policy,
                    contract: await saveVideoPriceContract(
                        {
                            officialVersionId: version.id,
                            channelId: "channel",
                            requestedModel: "MiniMax-Hailuo-2.3",
                            protocol: "minimax-hailuo-v1",
                            scope: "global-standard-minimax-hailuo-generation",
                            tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
                            evidence: "Synthetic three-tier proof",
                            reviewedAt: publishedAt,
                            reviewedBy: "fixture-admin",
                        },
                        null,
                    ),
                };
            if (kind === "video")
                return {
                    version,
                    policy,
                    contract: await saveVideoPriceContract(
                        {
                            officialVersionId: version.id,
                            channelId: "channel",
                            requestedModel: "MiniMax-H3",
                            protocol: "minimax-video-v2",
                            scope: "global-standard-minimax-h3-generation",
                            resolutionItems: Object.fromEntries(["768P", "2K"].map((r) => [r, { inputSeconds: `${r}-input`, outputSeconds: `${r}-output` }])),
                            inputImageItem: "images",
                            inputImagePricing: "all-at-standard-rate",
                            inputAudioItem: "inputAudioSeconds",
                            evidence: "Synthetic channel proof",
                            reviewedAt: publishedAt,
                            reviewedBy: "fixture-admin",
                        },
                        null,
                    ),
                };
            if (kind === "openai-audio")
                return {
                    version,
                    policy,
                    contract: await saveAudioPriceContract(
                        {
                            officialVersionId: version.id,
                            channelId: "channel",
                            requestedModel: "gpt-audio-1.5",
                            reportedModel: "gpt-audio-1.5",
                            protocol: "openai-chat-audio",
                            declaredProtocol: "openai",
                            scope: "global-standard-openai-chat-audio-uncached",
                            itemKeys: { inputTextTokens: "inputText", inputAudioTokens: "inputAudio", outputTextTokens: "outputText", outputAudioTokens: "outputAudio" },
                            evidence: "Synthetic four-rate channel proof",
                            reviewedAt: publishedAt,
                            reviewedBy: "fixture-admin",
                        },
                        null,
                    ),
                };
            if (kind === "audio")
                return {
                    version,
                    policy,
                    contract: await saveAudioPriceContract(
                        {
                            officialVersionId: version.id,
                            channelId: "channel",
                            requestedModel: "gemini-2.5-flash-preview-tts",
                            reportedModel: "gemini-2.5-flash-preview-tts",
                            modelIdentity: "response-required",
                            protocol: "gemini-tts",
                            declaredProtocol: "gemini",
                            scope: "global-standard-gemini-tts",
                            inputTextItem: "input",
                            outputAudioItem: "output",
                            evidence: "Synthetic channel proof",
                            reviewedAt: publishedAt,
                            reviewedBy: "fixture-admin",
                        },
                        null,
                    ),
                };
            const contract = await saveImagePriceContract(
                {
                    officialVersionId: version.id,
                    channelId: "channel",
                    requestedModel: "image",
                    reportedModel: "image",
                    modelIdentity: "reviewed-request",
                    protocol: "openai-images",
                    operation,
                    scope: "global-standard-direct-image-tokens",
                    region: "global",
                    itemMeters: { input: ["inputTextTokens", "inputImageTokens"], output: ["outputImageTokens"] },
                    zeroMeters: ["outputTextTokens"],
                    evidence: "Synthetic native channel proof",
                    reviewedAt: publishedAt,
                    reviewedBy: "fixture-admin",
                },
                null,
            );
            return { version, policy, contract };
        }
        async function prepare(amount = 0.01, mismatchedFingerprint = false) {
            const request = input();
            const consumed = await consumePoints({ userId, amount, units: 1, usageKind, model: request.modelId, description: "fixture image", idempotencyKey: request.requestId, requestFingerprint: request.requestFingerprint });
            const identity = { ...request, requestFingerprint: mismatchedFingerprint ? "b".repeat(64) : request.requestFingerprint };
            const call = isAudio
                ? await beginShadowAudioCall({
                      ...identity,
                      requestedModel: audioModel,
                      declaredProtocol: audioProtocol,
                      ...(kind === "openai-audio"
                          ? { path: ["chat", "completions"], payload: { model: audioModel, messages: [{ role: "user", content: "PRIVATE_PROMPT" }], modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" } } }
                          : { path: ["models", `${audioModel}:generateContent`], payload: { contents: [{ parts: [{ text: "PRIVATE_PROMPT" }] }], generationConfig: { responseModalities: ["AUDIO"] } } }),
                  })
                : kind === "image"
                  ? await beginShadowImageCall(identity)
                  : await acknowledgeShadowVideoCall(
                        await beginShadowVideoCall({
                            ...identity,
                            requestedModel: videoModel,
                            declaredProtocol: "minimax",
                            path: [kind === "hailuo" ? "v1" : "v2", "video_generation"],
                            payload: kind === "hailuo" ? { model: videoModel, prompt: "PRIVATE_PROMPT" } : { model: videoModel, resolution: "768P", duration: 5, ratio: "16:9", content: [{ type: "text", text: "private prompt" }] },
                        }),
                        { payload: { task_id: "original", base_resp: { status_code: 0 } } },
                    );
            expect(call.reasons).toEqual([]);
            const finish = () => ("kind" in call ? (call.kind === "audio" ? finishShadowAudioCall(call, { payload: audioPayload }) : finishShadowVideoCall(call, "original", videoPayload)) : finishShadowImageCall(call, { payload }));
            const refund = () => refundPoints({ userId, sourceRecordId: consumed.record.id, idempotencyKey: `refund:${consumed.record.id}`, usageKind, units: 1, model: "image-model", description: "fixture failure" });
            return { call, consumed, refund, finish };
        }
        it.each(["before", "after", "concurrent"])("reverses original exact quote when refund occurs %s completion", async (order) => {
            const task = await prepare();
            if (order === "before") {
                await task.refund();
                await task.finish();
            }
            if (order === "after") {
                await task.finish();
                await publish("9");
                await task.refund();
            }
            if (order === "concurrent") await Promise.all([task.refund(), task.finish()]);
            expect(await getShadowPriceExactTotal(userId)).toBe("0");
            expect(await hasShadowPriceReversal(userId, task.call.requestId)).toBe(true);
            await Promise.all([task.refund(), task.refund(), task.finish()]);
            expect(await getShadowPriceExactTotal(userId)).toBe("0");
            expect(await reconcileMediaShadowRefundBatch(1)).toEqual({ checked: 0, reversed: 0, failed: 0 });
        });
        if (kind === "image")
            it("reverses an old fixed charge refunded before its saved zero-metadata response is revalued", async () => {
                const task = await prepare();
                if ("kind" in task.call) throw new Error("Expected image shadow call");
                const oldUnknown = ["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"];
                const observed = inspectOpenAiImageUsage({
                    ...payload,
                    usage: { ...payload.usage, input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 0 }, output_tokens_details: { ...payload.usage.output_tokens_details, reasoning_tokens: 0 } },
                });
                await mutateShadowImageCall(task.call.userId, task.call.requestId, (saved) => ({
                    call: { ...saved!, result: { status: "unpriced", completedAt: new Date().toISOString(), reasons: [], observation: { ...observed, unmappedUsageFields: oldUnknown, invalid: [`未解释的图片用量字段：${oldUnknown.join("、")}`] } } },
                }));
                await task.refund();
                const saved = await revalueShadowImageCall(task.call);
                expect(saved.result?.status).toBe("unpriced");
                expect(saved.revaluation?.receiptId).toBeTruthy();
                expect(await hasShadowPriceReversal(userId, task.call.requestId)).toBe(true);
                expect(await getShadowPriceExactTotal(userId)).toBe("0");
            });
        it("reverses positive shadow usage even when real fixed billing and refund are zero", async () => {
            const task = await prepare(0);
            await task.finish();
            expect(await getShadowPriceExactTotal(userId)).toBe(exact());
            expect((await task.refund()).record.amount).toBe(0);
            expect(await getShadowPriceExactTotal(userId)).toBe("0");
        });
        it("requires an actual refund and the original owner and request fingerprint", async () => {
            const task = await prepare();
            await task.finish();
            expect(await observeFixedMediaRefund(userId, task.consumed.record.id)).toBe(false);
            expect(await observeFixedMediaRefund(randomUUID(), task.consumed.record.id)).toBe(false);
            const mismatch = await prepare(0.01, true);
            await mismatch.finish();
            await mismatch.refund();
            expect(await getShadowPriceExactTotal(userId)).toBe(doubled());
            expect(await reconcileMediaShadowRefundBatch(1)).toEqual({ checked: 0, reversed: 0, failed: 0 });
        });
        it("preserves real refunds on diagnostic failure and repairs interrupted entries in configured batches", async () => {
            const tasks = [await prepare(), await prepare()];
            for (const task of tasks) await task.finish();
            const log = vi.spyOn(console, "error").mockImplementation(() => {});
            const reverse = vi.spyOn(shadowService, "reverseShadowPrice").mockRejectedValue(new Error("PRIVATE_FAILURE"));
            for (const task of tasks) expect((await task.refund()).record.type).toBe("refund");
            expect(await getShadowPriceExactTotal(userId)).toBe(doubled());
            expect(await reconcileMediaShadowRefundBatch(1)).toEqual({ checked: 1, reversed: 0, failed: 1 });
            expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_FAILURE");
            reverse.mockRestore();
            expect(await reconcileMediaShadowRefundBatch(1)).toEqual({ checked: 1, reversed: 1, failed: 0 });
            expect(await getShadowPriceExactTotal(userId)).toBe(exact());
            expect(await reconcileMediaShadowRefundBatch(1)).toEqual({ checked: 1, reversed: 1, failed: 0 });
            expect(await getShadowPriceExactTotal(userId)).toBe("0");
            expect(await reconcileMediaShadowRefundBatch(1)).toEqual({ checked: 0, reversed: 0, failed: 0 });
        });
        if (isAudio)
            it("recovers only the matching private attempt receipt and isolates diagnostic failures", async () => {
                const prepared = await prepare();
                const task: AudioTask = {
                    id: randomUUID(),
                    userId,
                    status: "success",
                    prompt: "PRIVATE_PROMPT",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    attemptNo: 1,
                    config: {
                        apiSource: "system",
                        baseUrl: "/api/ai/system/channel",
                        apiKey: "system",
                        apiFormat: audioProtocol,
                        model: audioModel,
                        logicalModel: prepared.call.modelId,
                        channelId: "channel",
                        advancedConfig: { ...emptyAdvancedConfig(), protocol: audioProtocol },
                    },
                    billing: { pointsRecordId: prepared.consumed.record.id, pointsCost: 0.01, refunded: false },
                };
                const receipt = {
                    id: randomUUID(),
                    attemptNo: 1,
                    channelId: "channel",
                    pointsRecordId: prepared.consumed.record.id,
                    requestedModel: audioModel,
                    logicalModel: prepared.call.modelId,
                    observedAt: new Date().toISOString(),
                    observation: inspectAudioUsage(audioUsageProtocol, audioPayload),
                };
                for (const patch of [{ attemptNo: 2 }, { channelId: "fallback" }, { requestedModel: "alias" }, { logicalModel: "other" }, { pointsRecordId: "other" }])
                    await recoverAudioShadowResult({ ...task, usageObservations: [{ ...receipt, ...patch }] });
                await recoverAudioShadowResult({ ...task, userId: randomUUID(), usageObservations: [receipt] });
                await recoverAudioShadowResult({ ...task, config: { ...task.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "dataeyes-gemini" } }, usageObservations: [receipt] });
                expect(await getShadowPriceExactTotal(userId)).toBe("0");
                const logger = vi.spyOn(console, "error").mockImplementation(() => {});
                const failure = vi.spyOn(shadowStore, "mutateShadowAudioCall").mockRejectedValueOnce(new Error("PRIVATE_STORAGE_FAILURE"));
                await expect(recoverAudioShadowResult({ ...task, usageObservations: [receipt] })).resolves.toBeUndefined();
                expect(await getShadowPriceExactTotal(userId)).toBe("0");
                expect(JSON.stringify(logger.mock.calls)).not.toContain("PRIVATE_STORAGE_FAILURE");
                failure.mockRestore();
                await publish("9");
                await Promise.all([recoverAudioShadowResult({ ...task, usageObservations: [receipt] }), recoverAudioShadowResult({ ...task, usageObservations: [receipt] })]);
                expect(await getShadowPriceExactTotal(userId)).toBe(exact());
                await prepared.refund();
                await recoverAudioShadowResult({ ...task, usageObservations: [receipt] });
                expect(await getShadowPriceExactTotal(userId)).toBe("0");
            });
        if (isVideo)
            it("matches private query and recovery receipts to the original fixed charge and attempt", async () => {
                const prepared = await prepare();
                const call = prepared.call;
                const task: VideoTask = {
                    id: randomUUID(),
                    userId,
                    status: "running",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    config: {
                        apiSource: "system",
                        baseUrl: "/api/ai/system/channel",
                        apiKey: "system",
                        apiFormat: "openai",
                        model: videoModel,
                        logicalModel: call.modelId,
                        channelId: "channel",
                        advancedConfig: { ...emptyAdvancedConfig(), protocol: "minimax" },
                    },
                    upstream: { id: "original", provider: "generation", model: videoModel, pointsRecordId: prepared.consumed.record.id },
                };
                for (const changed of [
                    { ...task, userId: randomUUID() },
                    { ...task, config: { ...task.config, channelId: "other" } },
                    { ...task, upstream: { ...task.upstream, pointsRecordId: "other" } },
                ])
                    await observeVideoShadowResult(changed, videoPayload, queryPath);
                await observeVideoShadowResult(task, videoPayload, "/wrong/original");
                expect(await getShadowPriceExactTotal(userId)).toBe("0");
                const receipt = {
                    id: randomUUID(),
                    attemptNo: 1,
                    channelId: "channel",
                    upstreamTaskId: "original",
                    pointsRecordId: prepared.consumed.record.id,
                    requestedModel: videoModel,
                    logicalModel: call.modelId,
                    observedAt: new Date().toISOString(),
                    observation: kind === "hailuo" ? inspectHailuoObservation(videoPayload, "original") : inspectMinimaxVideoUsage(videoPayload, "original", videoModel),
                };
                await recoverVideoShadowResult({ ...task, usageObservations: [{ ...receipt, attemptNo: 2 }] });
                expect(await getShadowPriceExactTotal(userId)).toBe("0");
                await recoverVideoShadowResult({ ...task, usageObservations: [receipt] });
                expect(await getShadowPriceExactTotal(userId)).toBe(exact());
                await observeVideoShadowResult(task, videoPayload, queryPath);
                expect(await getShadowPriceExactTotal(userId)).toBe(exact());
            });
    });
});
