import Fraction from "fraction.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dataAdapter from "./data-adapter";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { saveModelPriceBinding } from "./model-price-binding-store";
import { mutatePricingState } from "./model-pricing-store";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { ModelPricingWalletRepository } from "./database/model-pricing-wallet-repository";
import {
    reserveModelPricePoints,
    settleModelPricePoints,
    releaseModelPricePoints,
    refundModelPricePoints,
    pricingDailySourceKey,
    claimModelPriceSubmission,
    recordModelPriceSubmissionOutcome,
    getModelPriceReservation,
    reviewModelPriceSubmission,
} from "./model-pricing-wallet-service";
import type { AudioWalletRequest } from "./model-pricing-audio-wallet-request";
import { inspectAudioUsage } from "./model-pricing-audio-usage";
import { savePricedAudioResponse, recoverPricedAudioResponse } from "./model-pricing-audio-response";
import { readAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";
import { ModelPricingAudioResponseRepository } from "./database/model-pricing-audio-response-repository";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { consumePoints, getPointsWalletSnapshot } from "./points-wallet-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const now = new Date("2026-10-02T08:00:00+08:00");
describe.each(providers)("OpenAI native audio wallet and raw response transactions (%s)", (provider) => {
    let userId: string;
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-wallet-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        userId = randomUUID();
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            const planId = settings.settings!.defaultPlanId;
            await postgresQuery("UPDATE app_settings SET free_daily_points_enabled = true, free_daily_points = 5, entitlements_enabled = true WHERE id = 'default'");
            await repos.users.createWithNextAccountId({
                id: userId,
                username: `price_${userId}`,
                displayName: "计费事务夹具",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId,
                pointsBalance: 200,
                passwordHash: "fixture-only",
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });
        } else {
            const db = emptyDb();
            db.settings = structuredClone(db.settings);
            db.settings.freeDailyPoints = 5;
            db.settings.freeDailyPointsEnabled = true;
            db.settings.entitlements.enabled = true;
            db.users.push({
                id: userId,
                accountId: "0001",
                username: "pricing_fixture",
                displayName: "计费事务夹具",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId: db.settings.entitlements.defaultPlanId,
                pointsBalance: 200,
                passwordHash: "fixture-only",
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });
            await writeAuthDb(db);
        }
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") await createPostgresRepositories().users.delete(userId);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    function input(maximum = "8.75") {
        const publishedAt = "2026-10-01T00:00:00Z";
        const version: OfficialPriceVersion = {
            id: "official",
            candidateId: "fixture",
            logicalModelId: "priced-model",
            manufacturer: "Fixture",
            series: "Text",
            officialVersion: "v1",
            sku: "model",
            tier: "paid",
            conditions: "fixture",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [{ key: "units", unit: "second", per: "1", price: "0.01", currency: "CNY" }],
        };
        const policy: SalesVersion = {
            id: "sales",
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "priced-model": "official" },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        return {
            userId,
            requestId: randomUUID(),
            requestFingerprint: "a".repeat(64),
            modelId: "priced-model",
            usageKind: "audio" as const,
            units: 1,
            version,
            policy,
            maximumUsage: { units: maximum },
            contractId: "reviewed-fixture",
            upperBoundEvidence: "verified fixture duration",
            now,
        };
    }
    async function state(requestId: string) {
        if (provider === "file") {
            const db = await readAuthDb();
            return {
                reservation: db.pricingReservations.find((item) => item.userId === userId && item.requestId === requestId),
                exact: db.pricingAccruals
                    .filter((item) => item.userId === userId)
                    .reduce((sum, item) => sum.add(item.exactPoints), new Fraction(0))
                    .toFraction(),
                records: db.pointRecords.filter((item) => item.userId === userId),
                quota: db.quotaUsage.filter((item) => item.userId === userId),
            };
        }
        const repo = new ModelPricingWalletRepository({ query: postgresQuery });
        const records = await createPostgresRepositories().points.listRecords(userId);
        const quota = await postgresQuery('SELECT units, points_spent AS "pointsSpent" FROM quota_usage WHERE user_id = $1 AND date = $2', [userId, "2026-10-02"]);
        const reservation = await repo.get(userId, requestId);
        const dailyKey = reservation && pricingDailySourceKey(reservation.allocation);
        const exact = new Fraction(await repo.getExact(userId, "permanent")).add(dailyKey ? await repo.getExact(userId, dailyKey) : "0").toFraction();
        return { reservation, exact, records: records.items, quota: quota.rows.map((row) => ({ units: Number(row.units), pointsSpent: Number(row.pointsSpent) })) };
    }

    const model = "gpt-audio-1.5";
    const meters = ["inputTextTokens", "inputAudioTokens", "outputTextTokens", "outputAudioTokens"] as const;
    function audioInput(format = "wav", n = 1) {
        const base = input();
        const version = { ...base.version, sku: model, items: meters.map((key, index) => ({ key, unit: "token", per: "1000000", price: String(index + 1), currency: "USD" })) };
        const audioRequest: AudioWalletRequest = {
            channelId: "openai-audio",
            requestedModel: model,
            declaredProtocol: "openai",
            payload: { model, messages: [{ role: "user", content: "PRIVATE_PROMPT" }], modalities: ["text", "audio"], audio: { voice: "alloy", format }, max_completion_tokens: 100, n, stream: false },
            contract: {
                id: "openai-audio-contract",
                officialVersionId: version.id,
                channelId: "openai-audio",
                requestedModel: model,
                reportedModel: model,
                protocol: "openai-chat-audio",
                declaredProtocol: "openai",
                scope: "global-standard-openai-chat-audio-uncached",
                itemKeys: Object.fromEntries(meters.map((key) => [key, key])) as Record<(typeof meters)[number], string>,
                evidence: "Synthetic ordinary rates",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
        };
        return { userId, requestId: base.requestId, requestFingerprint: base.requestFingerprint, modelId: base.modelId, usageKind: "audio" as const, units: 1, version, policy: base.policy, now, audioRequest };
    }
    const response = () => ({
        model,
        service_tier: "default",
        choices: [{ index: 0, message: { audio: { data: Buffer.from("PRIVATE_AUDIO_BYTES").toString("base64"), transcript: "PRIVATE_TRANSCRIPT" } } }],
        usage: {
            prompt_tokens: 8,
            completion_tokens: 12,
            total_tokens: 20,
            prompt_tokens_details: { text_tokens: 8, audio_tokens: 0, image_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
            completion_tokens_details: { text_tokens: 2, audio_tokens: 10, reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
    });
    async function submit(request = audioInput()) {
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        return { request, claimId };
    }
    it.skipIf(provider !== "file")("settles frozen independent OpenAI audio after its reviewed binding changes", async () => {
        const base = audioInput();
        const version = { ...base.version, logicalModelId: "", capability: "audio" as const, processingTier: "standard" as const };
        const binding = {
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId: base.modelId,
            capability: "audio" as const,
            operation: "chat/completions" as const,
            processingMode: "standard" as const,
            scope: "audio:chat/completions:standard",
            officialVersionId: version.id,
            status: "active" as const,
            current: true,
            evidence: "original OpenAI audio selection",
            reviewedBy: "admin",
            reviewedAt: version.publishedAt,
        };
        const priceSelection = { logicalModelId: base.modelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: version.id };
        const policy = { ...base.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId: base.modelId, coefficient: "2" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "openai-audio", name: "OpenAI audio fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "openai", models: [model], enabled: true }];
        db.settings.logicalModels = [
            { id: base.modelId, name: "OpenAI audio fixture", manufacturer: "Fixture", capability: "audio", enabled: true, bindings: [{ id: "audio-binding", channelId: "openai-audio", upstreamModel: model, enabled: true, priority: 0 }] },
        ];
        await writeAuthDb(db);
        await mutatePricingState((state) => ({ next: { ...state, officialVersions: [version], salesVersions: [policy], priceBindings: [binding] }, result: undefined }));
        const request = { ...base, version, policy, priceSelection };
        const { claimId } = await submit(request);
        await saveModelPriceBinding({ ...binding, evidence: "replacement OpenAI audio selection" }, binding.revision);
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectAudioUsage("openai-chat-audio", response()), responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation).toMatchObject({ status: "settled", frozen: { priceSelection }, settlement: { chargedPoints: "0.08" } });
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID() })).rejects.toThrow("独立选价绑定或售价已变化");
    });
    it("freezes all four ordinary prices, settles once, and refunds original fractional usage", async () => {
        const request = audioInput();
        const holds = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
        expect(holds.filter((item) => item.applied)).toHaveLength(1);
        expect(holds[0].reservation.allocation).toMatchObject({ heldPoints: "90.09", dailyHeld: "5.00", permanentHeld: "85.09" });
        expect(holds[0].reservation.frozen.maximumUsage).toEqual({ inputTextTokens: "128000", inputAudioTokens: "0", outputTextTokens: "100", outputAudioTokens: "100" });
        expect(holds[0].reservation.frozen.audio).toMatchObject({ responseFormat: "wav", call: { operation: "chat/completions" } });
        const claims = await Promise.all([claimModelPriceSubmission(request), claimModelPriceSubmission(request)]);
        expect(claims.filter((item) => item.claimed)).toHaveLength(1);
        const key = { ...request, claimId: claims[0].reservation.submission!.id };
        const observation = inspectAudioUsage("openai-chat-audio", response());
        await recordModelPriceSubmissionOutcome({ ...key, kind: "response", observation, responseComplete: true });
        await recordModelPriceSubmissionOutcome({ ...key, kind: "response", observation: { ...observation, quantities: Object.fromEntries(Object.entries(observation.quantities).reverse()) }, responseComplete: true });
        request.version.items[0].price = "99";
        request.policy.userPriceRules = [{ scope: "default", coefficient: "9" }];
        expect((await reserveModelPricePoints(request)).reservation.allocation.heldPoints).toBe("90.09");
        const settlements = await Promise.all([settleModelPricePoints({ ...key, resume: true }), settleModelPricePoints({ ...key, resume: true })]);
        expect(settlements.filter((item) => item.applied)).toHaveLength(1);
        expect(settlements[0].reservation.settlement).toMatchObject({ actualExactPoints: "189/5000", chargedPoints: "0.04" });
        expect(settlements[0].reservation.settledAudioUsageFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "inputAudioTokens", value: "0", status: "reported", sourcePaths: ["usage.prompt_tokens_details.audio_tokens"] }),
                expect.objectContaining({ meter: "outputAudioTokens", value: "10", status: "reported", sourcePaths: ["usage.completion_tokens_details.audio_tokens"] }),
                expect.objectContaining({ meter: "inputCachedTokens", value: "0", status: "reported", sourcePaths: ["usage.prompt_tokens_details.cached_tokens"] }),
            ]),
        );
        expect(settlements[0].reservation.settledAudioQuote).toMatchObject({ purpose: "settlement", contractId: "openai-audio-contract", attemptId: key.claimId, exactPoints: "189/5000" });
        expect(settlements[0].reservation.settledAudioQuote?.lines.every((line) => line.consumedFactIds.length === 1)).toBe(true);
        expect(settlements[0].snapshot.totalPoints).toBe(204.96);
        const refund = { ...request, refundId: "original", usage: settlements[0].reservation.settledUsage!, units: 1, evidence: "original cancelled" };
        const refunds = await Promise.all([refundModelPricePoints(refund), refundModelPricePoints(refund)]);
        expect(refunds.filter((item) => item.applied)).toHaveLength(1);
        expect(refunds[0].snapshot.totalPoints).toBe(205);
        expect((await state(request.requestId)).exact).toBe("0");
    });
    it.each(["wav", "mp3", "flac", "opus"])("preserves %s format and every original candidate without storing transcript or prompt", async (format) => {
        const { request, claimId } = await submit(audioInput(format, 2));
        const payload = response();
        payload.choices.push({ index: 1, message: { audio: { data: Buffer.from("SECOND_AUDIO").toString("base64"), transcript: "PRIVATE_OTHER" } } });
        const key = { ...request, claimId };
        const saves = await Promise.all([savePricedAudioResponse({ ...key, payload, responseComplete: true }), savePricedAudioResponse({ ...key, payload, responseComplete: true })]);
        expect(saves.filter((item) => item.applied)).toHaveLength(1);
        expect(saves[0].receipt.audio.map((item) => item.candidateIndex)).toEqual([0, 1]);
        expect(saves[0].receipt.audio[0].mimeType).toBe({ wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", opus: "audio/ogg" }[format]);
        expect(JSON.stringify(saves[0].receipt)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_TRANSCRIPT|PRIVATE_OTHER|payload|contract/);
        payload.choices.reverse();
        expect((await savePricedAudioResponse({ ...key, payload, responseComplete: true })).applied).toBe(false);
        request.audioRequest.payload = { audio: { format: "pcm16" } };
        request.version.items[0].price = "99";
        const recovered = await Promise.all([recoverPricedAudioResponse(key), recoverPricedAudioResponse(key)]);
        expect(recovered.filter((item) => item?.applied)).toHaveLength(1);
        expect(recovered[0]?.receipt).toEqual(saves[0].receipt);
        expect(recovered[0]?.reservation.settlement?.chargedPoints).toBe("0.04");
        expect((await state(request.requestId)).records).toHaveLength(1);
        expect(JSON.stringify(await getPricingWalletView(userId, { now }))).not.toMatch(/PRIVATE_|U0VDT05EX0FVRElP|responseFormat|payloadFingerprint/);
        expect((await claimModelPriceSubmission(key)).claimed).toBe(false);
    });
    it.each(["free", "missing", "pcm16", "aac", "stream", "alias", "tools", "funds"])("rejects %s before holding points or permitting submission", async (mode) => {
        const request = audioInput();
        if (mode === "free") request.version.items[1].price = "0";
        if (mode === "missing") request.version.items.splice(1, 1);
        if (mode === "alias") request.audioRequest.requestedModel = "gpt-4o-audio-preview";
        if (mode === "pcm16" || mode === "aac") request.audioRequest = audioInput(mode).audioRequest;
        if (mode === "stream") Object.assign(request.audioRequest.payload as object, { stream: true });
        if (mode === "tools") Object.assign(request.audioRequest.payload as object, { tools: [] });
        if (mode === "funds") Object.assign(request.audioRequest.payload as object, { n: 128, max_completion_tokens: 16384 });
        await expect(reserveModelPricePoints(request)).rejects.toThrow();
        expect((await state(request.requestId)).reservation).toBeUndefined();
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(205);
    });
    it.each(["missing", "excess", "model", "tier", "contradictory", "input-audio", "cache"])("retains raw %s evidence and refuses inferred charges or refunds", async (mode) => {
        const { request, claimId } = await submit();
        const payload = response();
        if (mode === "missing") Reflect.deleteProperty(payload.usage.completion_tokens_details, "audio_tokens");
        if (mode === "excess") Object.assign(payload.usage, { completion_tokens: 102, total_tokens: 110, completion_tokens_details: { ...payload.usage.completion_tokens_details, audio_tokens: 100 } });
        if (mode === "model") payload.model = "alias";
        if (mode === "tier") payload.service_tier = "priority";
        if (mode === "contradictory") payload.usage.total_tokens = 99;
        if (mode === "input-audio") Object.assign(payload.usage.prompt_tokens_details, { text_tokens: 7, audio_tokens: 1 });
        if (mode === "cache") payload.usage.prompt_tokens_details.cached_tokens = 1;
        const key = { ...request, claimId };
        const saved = await savePricedAudioResponse({ ...key, payload, responseComplete: true });
        await expect(recoverPricedAudioResponse(key)).rejects.toThrow();
        expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toEqual(saved.receipt);
        expect((await state(request.requestId)).reservation?.status).toBe("reserved");
        expect((await state(request.requestId)).records).toHaveLength(0);
        await expect(recordModelPriceSubmissionOutcome({ ...key, kind: "not_charged", evidence: "timeout" })).rejects.toThrow();
        await expect(releaseModelPricePoints({ ...key, reason: "confirmed-no-charge", evidence: "timeout" })).rejects.toThrow();
        await expect(
            reviewModelPriceSubmission({ ...key, review: { id: "forged", claimId, reviewedBy: "admin", reviewedAt: now.toISOString(), evidence: "no task provenance", outcome: { kind: "response", observation: saved.receipt.observation } } }),
        ).rejects.toThrow("专用任务凭据");
    });
    it.each(["empty", "base64", "duplicate", "index", "count", "incomplete", "gemini"])("rejects %s raw responses without reopening submission", async (mode) => {
        const { request, claimId } = await submit();
        const payload = response();
        if (mode === "empty") payload.choices = [];
        if (mode === "base64") payload.choices[0].message.audio.data = "AA$A=";
        if (mode === "duplicate" || mode === "count") payload.choices.push({ ...payload.choices[0], index: mode === "duplicate" ? 0 : 1 });
        if (mode === "index") payload.choices[0].index = -1;
        const key = { ...request, claimId };
        await expect(savePricedAudioResponse({ ...key, payload: mode === "gemini" ? { candidates: [] } : payload, responseComplete: (mode !== "incomplete") as true })).rejects.toThrow();
        expect(await recoverPricedAudioResponse(key)).toBeUndefined();
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
    });
    it("rejects changed request, raw bytes, meters and cross-protocol observations", async () => {
        const { request, claimId } = await submit();
        const key = { ...request, claimId };
        const payload = response();
        await savePricedAudioResponse({ ...key, payload, responseComplete: true });
        for (const patch of [{ channelId: "other" }, { payload: audioInput("mp3").audioRequest.payload }]) await expect(reserveModelPricePoints({ ...request, audioRequest: { ...request.audioRequest, ...patch } })).rejects.toThrow("请求已变化");
        for (const patch of [{ requestFingerprint: "b".repeat(64) }, { claimId: "other" }, { userId: "other" }]) await expect(recoverPricedAudioResponse({ ...key, ...patch })).rejects.toThrow();
        for (const change of ["data", "usage"]) {
            const changed = response();
            if (change === "data") changed.choices[0].message.audio.data = Buffer.from("changed").toString("base64");
            else changed.usage.total_tokens = 99;
            await expect(savePricedAudioResponse({ ...key, payload: changed, responseComplete: true })).rejects.toThrow("不能改写");
        }
        await expect(recordModelPriceSubmissionOutcome({ ...key, kind: "response", observation: inspectAudioUsage("gemini-tts", {}), responseComplete: true })).rejects.toThrow("能力不匹配");
        await expect(settleModelPricePoints({ ...key, observation: inspectAudioUsage("openai-chat-audio", payload), responseComplete: true })).rejects.toThrow("受控提交");
        await recoverPricedAudioResponse(key);
        expect((await state(request.requestId)).records).toHaveLength(1);
    });
    it("serializes raw media and no-charge proof, preventing both from committing", async () => {
        const { request, claimId } = await submit();
        const key = { ...request, claimId };
        const results = await Promise.allSettled([savePricedAudioResponse({ ...key, payload: response(), responseComplete: true }), recordModelPriceSubmissionOutcome({ ...key, kind: "not_charged", evidence: "supplier confirmed original request free" })]);
        expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect((await getModelPriceReservation(request))?.submission?.phase === "not_charged").toBe(!(await readAudioPriceResponseReceipt(userId, request.requestId)));
    });
    it("recovers only local storage after raw write and settlement failures", async () => {
        const { request, claimId } = await submit();
        const key = { ...request, claimId };
        const failure =
            provider === "postgres" ? vi.spyOn(ModelPricingAudioResponseRepository.prototype, "insert").mockRejectedValueOnce(new Error("raw interrupted")) : vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("raw interrupted"));
        await expect(savePricedAudioResponse({ ...key, payload: response(), responseComplete: true })).rejects.toThrow("raw interrupted");
        failure.mockRestore();
        expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toBeUndefined();
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        const raw = await savePricedAudioResponse({ ...key, payload: response(), responseComplete: true });
        await recordModelPriceSubmissionOutcome({ ...key, kind: "response", observation: raw.receipt.observation, responseComplete: true });
        const settlementFailure =
            provider === "postgres"
                ? vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("settlement interrupted"))
                : vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("settlement interrupted"));
        await expect(settleModelPricePoints({ ...key, resume: true })).rejects.toThrow("settlement interrupted");
        settlementFailure.mockRestore();
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await recoverPricedAudioResponse(key))?.reservation.settlement?.chargedPoints).toBe("0.04");
    });
    it("accumulates sub-cent four-meter calls and refunds exact original usage", async () => {
        await consumePoints({ userId, usageKind: "text", model: "fixed", units: 1, amount: 5, idempotencyKey: randomUUID(), description: "consume daily source", now });
        const calls = [await submit(), await submit()];
        const payload = response();
        Object.assign(payload.usage, { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 });
        Object.assign(payload.usage.prompt_tokens_details, { text_tokens: 4 });
        Object.assign(payload.usage.completion_tokens_details, { text_tokens: 0, audio_tokens: 0 });
        await Promise.all(calls.map(({ request, claimId }) => savePricedAudioResponse({ ...request, claimId, payload, responseComplete: true })));
        const results = await Promise.all(calls.map(({ request, claimId }) => recoverPricedAudioResponse({ ...request, claimId })));
        expect(results.map((item) => item!.reservation.settlement!.chargedPoints).sort()).toEqual(["0.00", "0.01"]);
        expect((await state(calls[0].request.requestId)).exact).toBe("7/1250");
        await Promise.all(results.map((item) => refundModelPricePoints({ ...item!.reservation, now, refundId: "original", usage: item!.reservation.settledUsage!, evidence: "original unavailable" })));
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(200);
        expect((await state(calls[0].request.requestId)).exact).toBe("0");
    });
    it("holds unknown submissions and releases only explicit no-charge proof", async () => {
        const { request, claimId } = await submit();
        const key = { ...request, claimId };
        await recordModelPriceSubmissionOutcome({ ...key, kind: "unknown", reason: "transport_error" });
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "timeout" })).rejects.toThrow();
        await recordModelPriceSubmissionOutcome({ ...key, kind: "not_charged", evidence: "upstream request-specific no-charge proof" });
        expect((await releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "upstream request-specific no-charge proof" })).snapshot.totalPoints).toBe(205);
        await expect(savePricedAudioResponse({ ...key, payload: response(), responseComplete: true })).rejects.toThrow();
    });
    it("recovers actual Chat audio bytes from a local TCP response without another upstream call", async () => {
        const fixture = createProtocolFixtureServer({ port: 0 });
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("fixture missing port");
            const { request, claimId } = await submit();
            const upstream = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-key" }, body: JSON.stringify(request.audioRequest.payload) });
            expect(upstream.ok).toBe(true);
            await savePricedAudioResponse({ ...request, claimId, payload: await upstream.json(), responseComplete: true });
            const recovered = await recoverPricedAudioResponse({ ...request, claimId });
            expect(Buffer.from(recovered!.receipt.audio[0].data, "base64").subarray(0, 4).toString()).toBe("RIFF");
            await recoverPricedAudioResponse({ ...request, claimId });
            expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(1);
            expect((await state(request.requestId)).records).toHaveLength(1);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
