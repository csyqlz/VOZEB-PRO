import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    consumeUserPoints: vi.fn(),
    fetchInternalApi: vi.fn(),
    getCurrentUser: vi.fn(),
    mediaAccess: vi.fn(),
    refundUserPoints: vi.fn(),
    safeRecordAuditLog: vi.fn(),
    taskAccess: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/auth/store")>();
    return { ...actual, consumeUserPoints: mocks.consumeUserPoints, refundUserPoints: mocks.refundUserPoints };
});
vi.mock("@/lib/server/generation-media-access", () => ({ authorizeGenerationMediaProxyRequest: mocks.mediaAccess }));
vi.mock("@/lib/server/generation-task-authorization", () => ({ userOwnsGenerationUpstreamTask: mocks.taskAccess }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "proxy-admin" })), safeRecordAuditLog: mocks.safeRecordAuditLog }));
vi.mock("@/lib/server/internal-origin", () => ({
    fetchInternalApi: mocks.fetchInternalApi,
    isInternalApiBaseUrl: (value: string) => value.trim().startsWith("/"),
    resolveInternalOrigin: () => INTERNAL_ORIGIN,
}));
vi.mock("@/lib/server/media-concurrency", () => ({ acquireMediaConcurrency: () => ({ release: vi.fn() }), withMediaConcurrency: (response: Response) => response }));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));

import { runCustomImageTask, pollCustomImageTask } from "@/app/api/image-tasks/image-task-custom";
import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import { runGeminiImageTask } from "@/app/api/image-tasks/image-task-gemini";
import { DELETE as proxyDelete, GET as proxyGet, HEAD as proxyHead, POST as proxyPost } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { PATCH as saveAdminSettings } from "@/app/api/admin/settings/route";
import { createUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import type { LogicalModelCapability, SystemChannelAdvancedConfig, SystemChannelModelConfig, SystemChannelProtocol, SystemDefaultModels, SystemModelChannel } from "@/lib/auth/store-types";
import { channelProtocolDefinitions, emptyAdvancedConfig, protocolAuthHeaders, protocolModelConfig, registeredChannelProtocolDefinitions, type ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";
import type { SystemGenerationChannelConfig } from "@/lib/server/generation-channel";
import type { ImageTask } from "@/lib/server/image-task-store";
import { requestStructuredText } from "@/lib/server/text-planning-runtime";
import { createVideoTask, getVideoTask, type VideoTask } from "@/lib/server/video-task-store";
import { queryVideoTaskUpstream } from "@/lib/server/video-task-runtime";
import { requestUpstreamGenerationCancellation } from "@/lib/server/generation-task-cancellation-service";
import { geminiAudioRequest } from "@/lib/server/gemini-audio-provider";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { writeJsonDataFile } from "./data-adapter";
import { saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import { saveImagePriceContract } from "./model-pricing-image-contract-store";
import { saveAudioPriceContract } from "./model-pricing-audio-contract-store";
import { getShadowAudioCall, getShadowImageCall, getShadowPriceExactTotal, getShadowTextCall } from "./model-pricing-shadow-store";
import { systemAiBillingHeaders } from "./system-ai-billing";
import type { FlatTextMeter } from "./model-pricing-token-contract";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";

const INTERNAL_ORIGIN = "http://internal.vozeb.test";
const MULTIPLIERS = { imageQuality: { auto: 1, high: 1 }, videoQuality: { "720": 1, "1080": 1 }, videoSeconds: { "5": 1, "8": 1 } };
const TEXT_PROTOCOLS = protocolCases("text");
const IMAGE_PROTOCOLS = protocolCases("image");
const VIDEO_PROTOCOLS = protocolCases("video");
const AUDIO_PROTOCOLS = protocolCases("audio");
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
let fixture: ReturnType<typeof createProtocolFixtureServer>;
let fixtureOrigin = "";
let dataDir = "";

describe("active protocols through persisted admin settings and the system proxy", () => {
    beforeEach(async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        dataDir = await mkdtemp(join(tmpdir(), "vozeb-pro-protocol-roundtrip-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", dataDir);
        fixture = createProtocolFixtureServer({ mountPrefixes: ["/relay", "/kling"] });
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        fixtureOrigin = `http://127.0.0.1:${address.port}`;
        mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "proxy-user", role: "admin", status: "active", adminPermissions: ["upstream.manage"], pointsBalance: 100 });
        mocks.consumeUserPoints.mockReset().mockResolvedValue({ cost: 1, remaining: 99, permanentRemaining: 99, dailyRemaining: 0, dailyExpiresAt: "", recordId: "points-record" });
        mocks.refundUserPoints.mockReset();
        mocks.mediaAccess.mockReset().mockResolvedValue(true);
        mocks.taskAccess.mockReset().mockResolvedValue(true);
        mocks.fetchInternalApi.mockReset().mockImplementation(dispatchInternalRequest);
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        await rm(dataDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });

    it.each([
        { id: "openai", stream: false },
        { id: "openai", stream: true },
        { id: "gemini", stream: true },
    ])("records one priced shadow call from TCP ($id, stream=$stream) while preserving fixed billing", async ({ id, stream }) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === id)!;
        const model = "mock-text";
        const operation = protocolOperation(definition, "text", model);
        const channel = await configureProxyChannel(definition, "text", model, protocolAdvancedConfig(definition.id, operation, model));
        const publishedAt = "2026-10-01T00:00:00Z";
        const version: OfficialPriceVersion = {
            id: "shadow-official",
            candidateId: "fixture",
            logicalModelId: channel.logicalModelId,
            manufacturer: "Fixture",
            series: "Text",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "fixture standard text",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "fixture-admin",
            items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
        };
        const policy: SalesVersion = {
            id: "shadow-sales",
            publishedAt,
            publishedBy: "fixture-admin",
            priceVersionIds: { [channel.logicalModelId]: version.id },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        const meters: FlatTextMeter[] = id === "gemini" ? ["inputTokens", "cachedInputTokens", "outputTokens"] : ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"];
        await saveFlatTextPriceContract(
            {
                officialVersionId: version.id,
                channelId: channel.channelId,
                protocol: id === "gemini" ? "gemini-generate" : "openai-chat",
                requestedModel: model,
                reportedModel: model,
                scope: "global-standard-text-flat",
                region: "global",
                serviceTier: "default",
                itemMeters: { tokens: meters },
                requestLimits: { maxInputTokens: 100000, maxOutputTokens: 100000, maxCandidates: 1, includesReasoning: true, sourceUrl: "https://example.com/fixture-limits", evidence: "Synthetic upper bounds for this local fixture" },
                reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://example.com/fixture-estimate", evidence: "Synthetic request-size estimate reviewed for the local fixture" },
                evidence: "fixture",
                reviewedAt: publishedAt,
                reviewedBy: "fixture-admin",
            },
            null,
        );
        const path = id === "gemini" ? `/models/${model}:streamGenerateContent` : "/chat/completions";
        const body = id === "gemini" ? { contents: [{ role: "user", parts: [{ text: "hello" }] }] } : { model, messages: [{ role: "user", content: "hello" }], stream };
        const invoke = () =>
            dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", ...systemAiBillingHeaders(channel.logicalModelId, "shadow-business-request", model) },
                body: JSON.stringify(body),
            });
        const response = await invoke();
        expect(response.status).toBe(200);
        expect(response.headers.get("x-vozeb-pro-points-cost")).toBe("1");
        if (stream) expect(await response.text()).toContain(id === "gemini" ? "mock-text" : "协议测试文本返回成功");
        else expect(await response.json()).toMatchObject({ choices: [{ message: { content: "协议测试文本返回成功" } }] });
        const requestId = mocks.consumeUserPoints.mock.calls[0][4] as string;
        const saved = await getShadowTextCall("proxy-user", requestId);
        expect(saved?.result).toMatchObject({ status: "priced", receiptId: expect.any(String) });
        expect(await getShadowPriceExactTotal("proxy-user")).toBe(id === "gemini" ? "119/10000" : "7/625");
        await (await invoke()).arrayBuffer();
        expect((await getShadowTextCall("proxy-user", requestId))?.result?.receiptId).toBe(saved?.result?.receiptId);
        expect(await getShadowPriceExactTotal("proxy-user")).toBe(id === "gemini" ? "119/10000" : "7/625");
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it.each(["gemini", "dataeyes-gemini"] as const)("freezes audio shadow pricing through actual %s TCP responses", async (id) => {
        for (const model of ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"] as const) {
            const definition = registeredChannelProtocolDefinitions.find((item) => item.id === id)!;
            const channel = await configureProxyChannel(definition, "audio", model, protocolAdvancedConfig(definition.id, protocolOperation(definition, "audio", model), model));
            const publishedAt = "2026-10-01T00:00:00Z";
            const version: OfficialPriceVersion = {
                id: `audio-${model}`,
                candidateId: "fixture",
                logicalModelId: channel.logicalModelId,
                manufacturer: "Fixture",
                series: "TTS",
                officialVersion: model,
                sku: model,
                tier: "paid",
                conditions: "Synthetic global standard audio",
                sourceKind: "manual",
                sourceUrl: "https://example.com/fixture",
                evidence: "fixture",
                observedAt: publishedAt,
                publishedAt,
                reviewedBy: "fixture-admin",
                items: [
                    { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                    { key: "output", unit: "token", per: "1000000", price: "20", currency: "USD" },
                ],
            };
            const policy: SalesVersion = {
                id: `sales-${model}`,
                publishedAt,
                publishedBy: "fixture-admin",
                priceVersionIds: { [channel.logicalModelId]: version.id },
                userPriceRules: [],
                conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
                usdPerCurrency: { USD: "1" },
                pointsPerCurrency: { USD: "700", CNY: "100" },
                rateEvidence: { USD: "fixture" },
            };
            await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
            await saveAudioPriceContract(
                {
                    officialVersionId: version.id,
                    channelId: channel.channelId,
                    requestedModel: model,
                    reportedModel: model,
                    protocol: "gemini-tts",
                    declaredProtocol: id,
                    scope: "global-standard-gemini-tts",
                    modelIdentity: "reviewed-request",
                    inputTextItem: "input",
                    outputAudioItem: "output",
                    evidence: "Synthetic native channel proof",
                    reviewedAt: publishedAt,
                    reviewedBy: "fixture-admin",
                },
                null,
            );
            const invoke = () =>
                dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}/models/${model}:generateContent`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...systemAiBillingHeaders(channel.logicalModelId, `audio-shadow-${model}`, model) },
                    body: JSON.stringify(geminiAudioRequest("PRIVATE_AUDIO_PROMPT", "Kore")),
                });
            const response = await invoke();
            expect(response.status).toBe(200);
            expect(response.headers.get("x-vozeb-pro-points-cost")).toBe("1");
            const result = await response.json();
            expect(result.candidates[0].content.parts[0].inlineData.data).toBeTruthy();
            const requestId = mocks.consumeUserPoints.mock.calls.at(-1)![4] as string;
            const call = await getShadowAudioCall("proxy-user", requestId);
            expect(call).toMatchObject({ kind: "audio", declaredProtocol: id, frozen: { policy: { id: policy.id } }, result: { status: "priced", observation: { quantities: { inputTextTokens: "8", outputAudioTokens: "12" } } } });
            expect(JSON.stringify(call)).not.toMatch(/PRIVATE_AUDIO_PROMPT|inlineData|base64/);
            await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [{ ...policy, id: "changed", userPriceRules: [{ scope: "default", coefficient: "9" }] }] });
            await (await invoke()).arrayBuffer();
            expect((await getShadowAudioCall("proxy-user", requestId))?.result).toEqual(call?.result);
        }
        expect(await getShadowPriceExactTotal("proxy-user")).toBe("217/625");
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it.each(["openai"] as const)("freezes audio shadow pricing through actual %s TCP responses", async (id) => {
        for (const model of ["gpt-audio-1.5"] as const) {
            const definition = registeredChannelProtocolDefinitions.find((item) => item.id === id)!;
            const channel = await configureProxyChannel(definition, "audio", model, protocolAdvancedConfig(definition.id, protocolOperation(definition, "audio", model), model));
            const publishedAt = "2026-10-01T00:00:00Z";
            const version: OfficialPriceVersion = {
                id: `audio-${model}`,
                candidateId: "fixture",
                logicalModelId: channel.logicalModelId,
                manufacturer: "Fixture",
                series: "TTS",
                officialVersion: model,
                sku: model,
                tier: "paid",
                conditions: "Synthetic global standard audio",
                sourceKind: "manual",
                sourceUrl: "https://example.com/fixture",
                evidence: "fixture",
                observedAt: publishedAt,
                publishedAt,
                reviewedBy: "fixture-admin",
                items: ["inputText", "inputAudio", "outputText", "outputAudio"].map((key, index) => ({ key, unit: "token", per: "1000000", price: String(index + 1), currency: "USD" })),
            };
            const policy: SalesVersion = {
                id: `sales-${model}`,
                publishedAt,
                publishedBy: "fixture-admin",
                priceVersionIds: { [channel.logicalModelId]: version.id },
                userPriceRules: [],
                conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
                usdPerCurrency: { USD: "1" },
                pointsPerCurrency: { USD: "700", CNY: "100" },
                rateEvidence: { USD: "fixture" },
            };
            await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
            await saveAudioPriceContract(
                {
                    officialVersionId: version.id,
                    channelId: channel.channelId,
                    requestedModel: model,
                    reportedModel: model,
                    protocol: "openai-chat-audio",
                    declaredProtocol: id,
                    scope: "global-standard-openai-chat-audio-uncached",
                    itemKeys: { inputTextTokens: "inputText", inputAudioTokens: "inputAudio", outputTextTokens: "outputText", outputAudioTokens: "outputAudio" },
                    evidence: "Synthetic native channel proof",
                    reviewedAt: publishedAt,
                    reviewedBy: "fixture-admin",
                },
                null,
            );
            const invoke = () =>
                dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...systemAiBillingHeaders(channel.logicalModelId, `audio-shadow-${model}`, model) },
                    body: JSON.stringify({ model, messages: [{ role: "user", content: "PRIVATE_AUDIO_PROMPT" }], modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" } }),
                });
            const response = await invoke();
            expect(response.status).toBe(200);
            expect(response.headers.get("x-vozeb-pro-points-cost")).toBe("1");
            const result = await response.json();
            expect(result.choices[0].message.audio.data).toBeTruthy();
            const requestId = mocks.consumeUserPoints.mock.calls.at(-1)![4] as string;
            const call = await getShadowAudioCall("proxy-user", requestId);
            expect(call).toMatchObject({
                kind: "audio",
                declaredProtocol: id,
                frozen: { policy: { id: policy.id } },
                result: { status: "priced", observation: { quantities: { inputTextTokens: "8", inputAudioTokens: "0", outputTextTokens: "2", outputAudioTokens: "10" } } },
            });
            expect(JSON.stringify(call)).not.toMatch(/PRIVATE_AUDIO_PROMPT|inlineData|base64/);
            await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [{ ...policy, id: "changed", userPriceRules: [{ scope: "default", coefficient: "9" }] }] });
            await (await invoke()).arrayBuffer();
            expect((await getShadowAudioCall("proxy-user", requestId))?.result).toEqual(call?.result);
        }
        expect(await getShadowPriceExactTotal("proxy-user")).toBe("189/5000");
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it.each([
        ["mock-image-priced", "generations"],
        ["mock-image-priced", "edits"],
        ["flux-kontext-pro", "generations"],
        ["flux-kontext-pro", "edits"],
        ["flux-kontext-max", "generations"],
        ["flux-kontext-max", "edits"],
        ["flux-pro-1.1", "generations"],
    ] as const)("records %s %s shadow usage through real TCP and reuses the original snapshot", async (model, operation) => {
        const perImage = model !== "mock-image-priced";
        const expectedPoints = perImage ? "28" : "49/10000";
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === (perImage ? "dataeyes-flux" : "openai"))!;
        const channel = await configureProxyChannel(definition, "image", model, protocolAdvancedConfig(definition.id, protocolOperation(definition, "image", model), model));
        const publishedAt = "2026-10-01T00:00:00Z";
        const version: OfficialPriceVersion = {
            id: "image-shadow-official",
            candidateId: "fixture",
            logicalModelId: channel.logicalModelId,
            manufacturer: "Fixture",
            series: "Image",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "Synthetic direct image tokens",
            sourceKind: "manual",
            sourceUrl: "https://example.com/fixture",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "fixture-admin",
            items: perImage ? [{ key: "image", unit: "image", per: "1", price: "0.04", currency: "USD" }] : [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
        };
        const policy: SalesVersion = {
            id: "image-shadow-sales",
            publishedAt,
            publishedBy: "fixture-admin",
            priceVersionIds: { [channel.logicalModelId]: version.id },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        await saveImagePriceContract(
            {
                officialVersionId: version.id,
                channelId: channel.channelId,
                requestedModel: model,
                reportedModel: model,
                protocol: "openai-images",
                operation,
                modelIdentity: "reviewed-request",
                scope: perImage ? "global-standard-dataeyes-flux-image" : "global-standard-direct-image-tokens",
                region: "global",
                itemMeters: perImage ? {} : { tokens: ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"] },
                zeroMeters: [],
                ...(perImage ? { imageLimit: { maxImages: 1 as const, sourceUrl: "https://example.com/fixture", evidence: "documented one image fixture" } } : {}),
                evidence: "fixture",
                reviewedAt: publishedAt,
                reviewedBy: "fixture-admin",
            },
            null,
        );
        const invoke = (extra?: Record<string, string>) => {
            const multipart = operation === "edits";
            let body: FormData | string;
            if (multipart) {
                body = new FormData();
                body.set("model", model);
                body.set("prompt", "private image prompt");
                body.set("image", new Blob([Buffer.from(PNG_DATA_URL.split(",")[1], "base64")], { type: "image/png" }), "fixture.png");
                for (const [key, value] of Object.entries(extra || {})) body.set(key, value);
            } else body = JSON.stringify({ model, prompt: "private image prompt", ...extra });
            return dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}/images/${operation}`, {
                method: "POST",
                headers: { ...(multipart ? {} : { "content-type": "application/json" }), ...systemAiBillingHeaders(channel.logicalModelId, extra ? "image-extra-request" : "image-shadow-request", model) },
                body,
            });
        };
        const response = await invoke();
        expect(response.status).toBe(200);
        expect(response.headers.get("x-vozeb-pro-points-cost")).toBe("1");
        expect(await response.json()).toMatchObject(perImage ? { data: [{ url: expect.any(String) }] } : { data: [{ b64_json: expect.any(String) }], usage: { total_tokens: 7 } });
        const requestId = mocks.consumeUserPoints.mock.calls[0][4] as string;
        const saved = await getShadowImageCall("proxy-user", requestId);
        expect(saved?.result).toMatchObject({ status: "priced", observation: { quantities: perImage ? { images: "1" } : { inputTextTokens: "1", inputImageTokens: "2", outputImageTokens: "4" } } });
        expect(await getShadowPriceExactTotal("proxy-user")).toBe(expectedPoints);
        expect(JSON.stringify(saved)).not.toContain("private image prompt");
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        await (await invoke()).arrayBuffer();
        expect((await getShadowImageCall("proxy-user", requestId))?.result?.receiptId).toBe(saved?.result?.receiptId);
        expect(mocks.consumeUserPoints.mock.calls[1][4]).toBe(requestId);
        expect(await getShadowPriceExactTotal("proxy-user")).toBe(expectedPoints);
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        await (await invoke({ inference_geo: "us", service_tier: "priority" })).arrayBuffer();
        const extra = await getShadowImageCall("proxy-user", mocks.consumeUserPoints.mock.calls[2][4] as string);
        expect(extra?.requestContext).toMatchObject({ region: "us", billingMode: "unsupported" });
        expect(extra?.result?.status).toBe("unpriced");
        expect(await getShadowPriceExactTotal("proxy-user")).toBe(expectedPoints);
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it.each(TEXT_PROTOCOLS)("persists and routes $id structured text requests", async (definition) => {
        const model = protocolModel(definition, "text");
        const operation = protocolOperation(definition, "text", model);
        const advancedConfig = protocolAdvancedConfig(definition.id, operation, model);
        const channel = await configureProxyChannel(definition, "text", model, advancedConfig);

        const result = await requestStructuredText({
            origin: INTERNAL_ORIGIN,
            cookie: "",
            candidate: { channelId: channel.channelId, upstreamModel: model, channel: channel.savedChannel },
            messages: [{ role: "user", content: "return a protocol test plan" }],
            tool: { name: "make_plan", description: "protocol round-trip", parameters: { type: "object", properties: {} } },
            headers: {
                "idempotency-key": `text-${definition.id}`,
                "x-client-request-id": `text-${definition.id}`,
                "x-vozeb-pro-logical-model": channel.logicalModelId,
                "x-vozeb-pro-upstream-model": model,
            },
        });

        expect(result.arguments).toBe("{}");
        expectProxyRequests(channel, operation.createPath, model, false);
    });

    it.each(["text", "image", "audio"] as const)("applies one channel prefix to %s requests without changing the provider adapter", async (capability) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === "openai")!;
        const model = `mock-${capability}`;
        const operation = protocolOperation(definition, capability, model);
        const channel = await configureProxyChannel(definition, capability, model, { ...protocolAdvancedConfig("openai", operation, model), pathPrefix: "/relay" });
        if (capability === "text") {
            await requestStructuredText({
                origin: INTERNAL_ORIGIN,
                cookie: "",
                candidate: { channelId: channel.channelId, upstreamModel: model, channel: channel.savedChannel },
                messages: [{ role: "user", content: "check path prefix" }],
                tool: { name: "make_plan", description: "test", parameters: { type: "object", properties: {} } },
                headers: { "x-vozeb-pro-logical-model": channel.logicalModelId, "x-vozeb-pro-upstream-model": model },
            });
        } else if (capability === "image") {
            await expectImageResult(await runImage(imageTask(channel, false), "openai"));
        } else {
            const response = await dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}/audio/speech`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-logical-model": channel.logicalModelId },
                body: JSON.stringify({ model, input: "check path prefix", voice: "alloy", format: "wav" }),
            });
            expect(response.ok).toBe(true);
        }
        expect(fixture.requests.find((request) => request.method === "POST")?.path).toBe(`/relay/v1${operation.createPath}`);
    });

    it("reuses Kling video creation and polling through a DataEyes-style mount", async () => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === "kling")!;
        const model = "kling-v3";
        const operation = protocolOperation(definition, "video", model);
        const channel = await configureProxyChannel(definition, "video", model, { ...protocolAdvancedConfig("kling", operation, model), pathPrefix: "/kling", channelAuthMode: "bearer" });
        const upstream = await createUpstream("proxy-user", INTERNAL_ORIGIN, "", channel.config, "animate a blue logo", videoParameters(), [], MULTIPLIERS, "dataeyes-kling-mount");
        await expectVideoResult(channel, upstream);
        expect(fixture.requests.some((request) => request.method === "POST" && request.path === "/kling/v1/videos/text2video")).toBe(true);
        expect(fixture.requests.some((request) => request.method === "GET" && request.path === `/kling/v1/videos/text2video/${upstream.id}`)).toBe(true);
    });

    it.each([
        ["zai-glm", "glm-4.7"],
        ["minimax", "MiniMax-M2.5"],
        ["anthropic", "claude-sonnet-4-5"],
        ["xai", "grok-4"],
    ] as const)("persists and routes official %s text through the system proxy", async (protocol, model) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === protocol)!;
        const operation = protocolOperation(definition, "text", model);
        const channel = await configureProxyChannel(definition, "text", model, protocolAdvancedConfig(protocol, operation, model));
        const result = await requestStructuredText({
            origin: INTERNAL_ORIGIN,
            cookie: "",
            candidate: { channelId: channel.channelId, upstreamModel: model, channel: channel.savedChannel },
            messages: [{ role: "user", content: "return a protocol test plan" }],
            tool: { name: "make_plan", description: "protocol round-trip", parameters: { type: "object", properties: {} } },
            headers: { "idempotency-key": `text-${protocol}`, "x-client-request-id": `text-${protocol}`, "x-vozeb-pro-logical-model": channel.logicalModelId, "x-vozeb-pro-upstream-model": model },
        });
        expect(result.arguments).toBe("{}");
        expectProxyRequests(channel, operation.createPath, model, false);
        if (protocol === "anthropic") expect(fixture.requests.find((item) => item.method === "POST")?.headers["anthropic-version"]).toBe("2023-06-01");
    });

    it.each(IMAGE_PROTOCOLS)("routes $id text-to-image and image-to-image through its configured upstream contract", async (definition) => {
        const model = protocolModel(definition, "image");
        const operation = protocolOperation(definition, "image", model);
        const advancedConfig = protocolAdvancedConfig(definition.id, operation, model);
        const channel = await configureProxyChannel(definition, "image", model, advancedConfig);

        const generated = await runImage(imageTask(channel, false), definition.id);
        await expectImageResult(generated);
        expectProxyRequests(channel, operation.createPath, model, false);
        if (definition.id === "sub2api-grok") {
            const body = JSON.parse(fixture.requests.find((request) => request.method === "POST")?.body.toString("utf8") || "{}");
            expect(body).toMatchObject({ resolution: "2k" });
            expect(body).not.toHaveProperty("size");
            expect(body).not.toHaveProperty("quality", "high");
        }

        fixture.requests.splice(0);
        const edited = await runImage(imageTask(channel, true), definition.id);
        await expectImageResult(edited);
        expectProxyRequests(channel, operation.editPath || operation.createPath, model, true);
        if (definition.id === "sub2api-grok") {
            const body = JSON.parse(fixture.requests.find((request) => request.method === "POST")?.body.toString("utf8") || "{}");
            expect(body.image).toMatchObject({ url: expect.stringContaining("reference.png"), type: "image_url" });
            expect(body).not.toHaveProperty("image_urls");
        }
    });

    it("routes Seedream 5.0 Pro with an explicit 2K tier, URL references and all returned images", async () => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === "dataeyes-seedream")!;
        const model = "ByteDance-Seedream-5.0-pro";
        const operation = protocolOperation(definition, "image", model);
        const channel = await configureProxyChannel(definition, "image", model, protocolAdvancedConfig(definition.id, operation, model));
        const task = imageTask(channel, false);
        task.config = { ...task.config, size: "auto", quality: "auto" };
        await expect(runImage(task, definition.id)).rejects.toThrow("需要明确尺寸");
        expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);

        task.config = { ...task.config, size: "2K" };
        const generated = await runImage(task, definition.id);
        await expectImageResult(generated);
        expect(generated.results).toHaveLength(2);
        expectProxyRequests(channel, "/v1/images/generations", model, false);
        const generatedBody = JSON.parse(fixture.requests.find((request) => request.method === "POST")!.body.toString("utf8"));
        expect(generatedBody).toMatchObject({ model, size: "2K", response_format: "url" });
        expect(generatedBody).not.toHaveProperty("n");
        expect(generatedBody).not.toHaveProperty("quality");

        fixture.requests.splice(0);
        const edited = imageTask(channel, true);
        edited.config = { ...edited.config, size: "2K", quality: "auto" };
        edited.references.push({ ...edited.references[0], id: "second", dataUrl: "https://cdn.example.com/reference-2.png" });
        const editResult = await runImage(edited, definition.id);
        await expectImageResult(editResult);
        expect(editResult.results).toHaveLength(2);
        expectProxyRequests(channel, "/v1/images/generations", model, true);
        const editBody = JSON.parse(fixture.requests.find((request) => request.method === "POST")!.body.toString("utf8"));
        expect(editBody.image).toEqual(["https://cdn.example.com/reference.png", "https://cdn.example.com/reference-2.png"]);

        fixture.requests.splice(0);
        const exact = imageTask(channel, false);
        exact.config = { ...exact.config, size: "2048x2048", quality: "auto" };
        await expectImageResult(await runImage(exact, definition.id));
        expect(JSON.parse(fixture.requests.find((request) => request.method === "POST")!.body.toString("utf8")).size).toBe("2048x2048");

        fixture.requests.splice(0);
        const ratio = imageTask(channel, false);
        ratio.config = { ...ratio.config, size: "16:9", quality: "auto" };
        await expectImageResult(await runImage(ratio, definition.id));
        expect(JSON.parse(fixture.requests.find((request) => request.method === "POST")!.body.toString("utf8")).size).toBe("1824x1024");
    });

    it.each([
        ["alibaba-bailian", "qwen-image-3.0"],
        ["minimax", "image-01"],
        ["xai", "grok-imagine-image-2.0"],
        ["volcengine-image", "doubao-seedream-4-0-250828"],
    ] as const)("routes official %s images through the persisted system channel", async (protocol, model) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === protocol)!;
        const operation = protocolOperation(definition, "image", model);
        const channel = await configureProxyChannel(definition, "image", model, protocolAdvancedConfig(protocol, operation, model));
        await expectImageResult(await runImage(imageTask(channel, false), protocol));
        expectProxyRequests(channel, operation.createPath, model, false);
        if (protocol === "volcengine-image") {
            const body = JSON.parse(fixture.requests.find((request) => request.method === "POST")?.body.toString("utf8") || "{}");
            expect(body).toMatchObject({ model, response_format: "url" });
            expect(body).not.toHaveProperty("n");
            expect(body).not.toHaveProperty("quality");
        }
        if (!operation.supportsReferenceImage) return;
        fixture.requests.splice(0);
        await expectImageResult(await runImage(imageTask(channel, true), protocol));
        expectProxyRequests(channel, operation.editPath || operation.createPath, model, true);
        if (protocol === "volcengine-image") {
            const body = JSON.parse(fixture.requests.find((request) => request.method === "POST")?.body.toString("utf8") || "{}");
            expect(body).toMatchObject({ model, image: "https://cdn.example.com/reference.png", response_format: "url" });
            expect(body).not.toHaveProperty("n");
        }
    });

    it.each([
        ["alibaba-bailian", "wan3.0-video"],
        ["kling", "kling-v3"],
        ["vidu", "viduq3-pro"],
        ["minimax", "MiniMax-H3"],
        ["xai", "grok-imagine-video-1.5"],
    ] as const)("routes official %s video creation and polling through the persisted system channel", async (protocol, model) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === protocol)!;
        const operation = protocolOperation(definition, "video", model);
        const channel = await configureProxyChannel(definition, "video", model, protocolAdvancedConfig(protocol, operation, model));
        const upstream = await createUpstream("proxy-user", INTERNAL_ORIGIN, "", channel.config, "animate a blue logo", videoParameters(), [], MULTIPLIERS, `official-video-${protocol}`);
        await expectVideoResult(channel, upstream);
        expectProxyRequests(channel, operation.createPath, model, false, operation.queryPath || `${operation.createPath}/:task_id`, upstream.id);
        if (protocol === "alibaba-bailian") expect(fixture.requests.find((item) => item.method === "POST")?.headers["x-dashscope-async"]).toBe("enable");
        fixture.requests.splice(0);
        const referenced = await createUpstream(
            "proxy-user",
            INTERNAL_ORIGIN,
            "",
            channel.config,
            "animate the reference image",
            videoParameters(),
            [{ type: "image", url: `${fixtureOrigin}/media/fixture.png`, role: "first_frame" }],
            MULTIPLIERS,
            `official-i2v-${protocol}`,
        );
        await expectVideoResult(channel, referenced);
        const createPath = operation.imageToVideoPath || operation.createPath;
        expectProxyRequests(channel, createPath, model, true, operation.queryPath || `${createPath}/:task_id`, referenced.id);
    });

    it.each(["MiniMax-H3", "MiniMax-H3-Max"])("preserves %s terminal usage through the real system proxy without another fixed charge", async (model) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === "minimax")!;
        const operation = protocolModelConfig("minimax", "video", model)!;
        const channel = await configureProxyChannel(definition, "video", model, protocolAdvancedConfig("minimax", operation, model));
        const upstream = await createUpstream("proxy-user", INTERNAL_ORIGIN, "", channel.config, "private usage fixture prompt", videoParameters(), [], MULTIPLIERS, `usage-${model}`);
        Object.assign(fixture.tasks.get(upstream.id)!, { resolution: "768P", taskType: "generation", modality: "video", usage: { total_seconds: 6.25, input_seconds: 1.25, output_seconds: 5, input_image_count: 2, input_audio_seconds: 3.5 } });
        const task = await createVideoTask({ userId: "proxy-user", config: channel.config, upstream, requestedDurationSeconds: 5, prompt: "private usage fixture prompt", source: "video-workbench" });
        for (const current of [task, (await getVideoTask(task.id))!]) expect(await queryVideoTaskUpstream(current, INTERNAL_ORIGIN)).toMatchObject({ state: "result_ready", resultUrl: expect.stringContaining("/media/fixture.mp4") });
        const receipts = (await getVideoTask(task.id))!.usageObservations!;
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
            upstreamTaskId: upstream.id,
            requestedModel: model,
            pointsRecordId: "points-record",
            observation: { protocol: "minimax-video-v2", reportedModel: model, resolution: "768P", missing: [], invalid: [], quantities: { inputSeconds: "1.25", outputSeconds: "5", inputImageCount: "2", inputAudioSeconds: "3.5" } },
        });
        expect(JSON.stringify(receipts)).not.toMatch(/private usage fixture prompt|fixture.mp4|fixture-key/);
        expect(mocks.consumeUserPoints).toHaveBeenCalledTimes(1);
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
        expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(1);
    });

    it.each([
        ["MiniMax-Hailuo-2.3", false, 6, "1080"],
        ["MiniMax-Hailuo-2.3", true, 10, "768"],
        ["MiniMax-Hailuo-2.3-Fast", true, 6, "1080"],
    ] as const)("completes %s reference=%s through V1 query and original file retrieval", async (model, reference, seconds, quality) => {
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === "minimax")!;
        const operation = protocolModelConfig("minimax", "video", model)!;
        const channel = await configureProxyChannel(definition, "video", model, protocolAdvancedConfig("minimax", operation, model));
        const references = reference ? [{ type: "image" as const, role: "first_frame" as const, url: `${fixtureOrigin}/media/fixture.png` }] : [];
        const upstream = await createUpstream("proxy-user", INTERNAL_ORIGIN, "", channel.config, "animate a blue logo", { ...videoParameters(), videoSeconds: seconds, vquality: quality }, references, MULTIPLIERS, "hailuo-original");
        await expectVideoResult(channel, upstream);
        expect(fixture.requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/v1/video_generation"]);
        expect(fixture.requests.filter((r) => r.method === "GET").map((r) => r.path)).toContain("/v1/files/retrieve");
        expect(mocks.consumeUserPoints).toHaveBeenCalledTimes(1);
        const task = { config: channel.config, upstream, userId: "proxy-user" } as unknown as VideoTask;
        const fixtureTask = fixture.tasks.get(upstream.id)!;
        fixtureTask.fileUnavailable = true;
        await expect(queryVideoTaskUpstream(task, INTERNAL_ORIGIN)).rejects.toThrow();
        fixtureTask.fileUnavailable = false;
        await expect(queryVideoTaskUpstream(task, INTERNAL_ORIGIN)).resolves.toMatchObject({ state: "result_ready" });
        fixtureTask.status = "Fail";
        const filesBeforeFailure = fixture.requests.filter((r) => r.path === "/v1/files/retrieve").length;
        await expect(queryVideoTaskUpstream(task, INTERNAL_ORIGIN)).resolves.toMatchObject({ state: "failed", status: "fail" });
        expect(fixture.requests.filter((r) => r.path === "/v1/files/retrieve")).toHaveLength(filesBeforeFailure);
        expect(fixture.requests.filter((r) => r.method === "POST")).toHaveLength(1);
        expect(mocks.consumeUserPoints).toHaveBeenCalledTimes(1);
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });

    it("rejects Hailuo Fast text-only input before any upstream charge", async () => {
        const model = "MiniMax-Hailuo-2.3-Fast";
        const definition = registeredChannelProtocolDefinitions.find((item) => item.id === "minimax")!;
        const operation = protocolModelConfig("minimax", "video", model)!;
        const channel = await configureProxyChannel(definition, "video", model, protocolAdvancedConfig("minimax", operation, model));
        await expect(createUpstream("proxy-user", INTERNAL_ORIGIN, "", channel.config, "kite", { ...videoParameters(), videoSeconds: 6, vquality: "768" }, [], MULTIPLIERS, "hailuo-invalid")).rejects.toThrow("仅支持图生视频");
        expect(fixture.requests).toHaveLength(0);
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
    });

    it.each(VIDEO_PROTOCOLS)("routes $id text-to-video and image-to-video creation, polling, and media", async (definition) => {
        const model = protocolModel(definition, "video");
        const operation = protocolOperation(definition, "video", model);
        if (!operation.queryPath) throw new Error(`${definition.id} video operation is missing queryPath`);
        const advancedConfig = protocolAdvancedConfig(definition.id, operation, model);
        const channel = await configureProxyChannel(definition, "video", model, advancedConfig);

        const created = await createUpstream("proxy-user", INTERNAL_ORIGIN, "", channel.config, "animate a blue logo", videoParameters(), [], MULTIPLIERS, `text-video-${definition.id}`);
        await expectVideoResult(channel, created);
        expectProxyRequests(channel, operation.createPath, model, false, operation.queryPath, created.id);

        fixture.requests.splice(0);
        const createPath = operation.imageToVideoPath || operation.createPath;
        const referenced = await createUpstream(
            "proxy-user",
            INTERNAL_ORIGIN,
            "",
            channel.config,
            "animate the reference image",
            videoParameters(),
            [{ type: "image", url: `${fixtureOrigin}/media/fixture.png` }],
            MULTIPLIERS,
            `image-video-${definition.id}`,
        );
        await expectVideoResult(channel, referenced);
        expectProxyRequests(channel, createPath, model, true, operation.queryPath, referenced.id);
        if (definition.id === "sub2api-grok") {
            const body = JSON.parse(fixture.requests.find((request) => request.method === "POST")?.body.toString("utf8") || "{}");
            expect(body.reference_images).toEqual([{ url: `${fixtureOrigin}/media/fixture.png` }]);
            expect(body).not.toHaveProperty("image");
            fixture.requests.splice(0);
            const framed = await createUpstream(
                "proxy-user",
                INTERNAL_ORIGIN,
                "",
                channel.config,
                "transition between frames",
                videoParameters(),
                [
                    { type: "image", url: `${fixtureOrigin}/media/fixture.png`, role: "first_frame" },
                    { type: "image", url: `${fixtureOrigin}/media/fixture.png?last=1`, role: "last_frame" },
                ],
                MULTIPLIERS,
                "framed-video-sub2api-grok",
            );
            await expectVideoResult(channel, framed);
            const framedBody = JSON.parse(fixture.requests.find((request) => request.method === "POST")?.body.toString("utf8") || "{}");
            expect(framedBody.image).toEqual({ url: `${fixtureOrigin}/media/fixture.png` });
            expect(framedBody.last_frame).toEqual({ url: `${fixtureOrigin}/media/fixture.png?last=1` });
            expect(framedBody).not.toHaveProperty("reference_images");
            const contentUrl = `${INTERNAL_ORIGIN}${channel.config.baseUrl}/v1/videos/${framed.id}/content`;
            expect((await dispatchInternalRequest(contentUrl, {})).status).toBe(400);
            const media = await dispatchInternalRequest(contentUrl, { headers: { "x-vozeb-pro-logical-model": channel.logicalModelId, "x-vozeb-pro-upstream-model": model } });
            expect(media.status, media.ok ? "" : await media.text()).toBe(200);
            expect(media.headers.get("content-type")).toBe("video/mp4");
        }

        if (definition.id === "dataeyes-seedance") {
            const cancelled = await requestUpstreamGenerationCancellation(
                {
                    type: "video",
                    taskId: `cancel-${referenced.id}`,
                    userId: "proxy-user",
                    upstreamTaskId: referenced.id,
                    config: { ...channel.config, advancedConfig },
                },
                INTERNAL_ORIGIN,
            );
            expect(cancelled).toBe("accepted");
            expect(fixture.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/seedance/api/v3/contents/generations/tasks/${referenced.id}` });
        }
    });

    it.each(AUDIO_PROTOCOLS)("persists and routes $id audio requests and returned media", async (definition) => {
        const model = protocolModel(definition, "audio");
        const operation = protocolOperation(definition, "audio", model);
        const advancedConfig = protocolAdvancedConfig(definition.id, operation, model);
        const channel = await configureProxyChannel(definition, "audio", model, advancedConfig);
        const path = (operation.createPath || "/audio/speech").replace(":model", encodeURIComponent(model));
        const response = await dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": `audio-${definition.id}`,
                "x-client-request-id": `audio-${definition.id}`,
                "x-vozeb-pro-logical-model": channel.logicalModelId,
            },
            body: JSON.stringify(definition.apiFormat === "gemini" ? geminiAudioRequest("protocol audio test", "Kore") : { model, input: "protocol audio test", voice: "alloy", format: "wav" }),
        });

        expect(response.ok, response.ok ? "" : await response.clone().text()).toBe(true);
        if (definition.apiFormat === "gemini") {
            const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
            expect(
                Buffer.from(payload.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "", "base64")
                    .subarray(0, 4)
                    .toString(),
            ).toBe("RIFF");
        } else if (response.headers.get("content-type")?.includes("application/json")) {
            const payload = (await response.json()) as { data?: { audio_url?: string } };
            const mediaUrl = payload.data?.audio_url || "";
            expect(mediaUrl).toContain("/media/fixture.wav");
            const media = await dispatchInternalRequest(`${INTERNAL_ORIGIN}${channel.config.baseUrl}/_media?url=${encodeURIComponent(mediaUrl)}`, {});
            expect(media.headers.get("content-type")).toBe("audio/wav");
            expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(44);
        } else {
            expect(response.headers.get("content-type")).toBe("audio/wav");
            expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(44);
        }
        expectProxyRequests(channel, operation.createPath, model, false);
    });
});

function protocolCases(capability: LogicalModelCapability) {
    const officialDirect = new Set(["zai-glm", "alibaba-bailian", "bfl", "kling", "vidu", "minimax", "anthropic", "xai", "volcengine-image"]);
    const strict = registeredChannelProtocolDefinitions.filter((definition) => definition.strict && definition.operations[capability] && !officialDirect.has(definition.id));
    const advanced = channelProtocolDefinitions.filter((definition) => !definition.strict && definition.capabilities.includes(capability));
    return [...strict, ...advanced];
}

function protocolModel(definition: ChannelProtocolDefinition, capability: LogicalModelCapability) {
    return definition.builtInModels?.find((item) => item.capability === capability)?.id || `mock-${capability}`;
}

function protocolOperation(definition: ChannelProtocolDefinition, capability: LogicalModelCapability, model: string) {
    const registered = protocolModelConfig(definition.id, capability, model);
    if (registered) return registered;
    if (definition.id === "custom") {
        if (capability === "text") {
            return {
                capability,
                protocol: "custom",
                createPath: "/planner/run",
                requestTemplate: '{"deployment":"{{model}}","conversation":"{{messages}}"}',
                resultField: "data.plan",
            } satisfies SystemChannelModelConfig;
        }
        if (capability === "audio") {
            return {
                capability,
                protocol: "custom",
                createPath: "/custom/audio",
                requestTemplate: '{"model":"{{model}}","input":"{{input}}","voice":"{{voice}}"}',
                resultField: "data.audio_url",
            } satisfies SystemChannelModelConfig;
        }
        return {
            capability,
            protocol: "custom" as const,
            createPath: `/custom/${capability === "image" ? "images" : "videos"}`,
            ...(capability === "image" ? { editPath: "/custom/images" } : { imageToVideoPath: "/custom/videos", queryPath: "/custom/results/:task_id" }),
            requestTemplate: capability === "image" ? '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{images}}"}' : '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{images}}"}',
            resultField: capability === "image" ? "data.image_url" : "data.video_url",
            statusField: capability === "video" ? "data.status" : "",
            supportsReferenceImage: true,
        } satisfies SystemChannelModelConfig;
    }
    if (capability === "text") {
        return {
            capability,
            protocol: definition.id,
            createPath: definition.id === "compatible" ? "/responses" : "/chat/completions",
        } satisfies SystemChannelModelConfig;
    }
    if (capability === "audio") {
        return { capability, protocol: definition.id, createPath: "/audio/speech" } satisfies SystemChannelModelConfig;
    }
    return {
        capability,
        protocol: definition.id,
        createPath: capability === "image" ? "/images/generations" : "/videos",
        ...(capability === "image" ? { editPath: "/images/edits" } : { imageToVideoPath: "/videos", queryPath: "/videos/:task_id" }),
        requestTemplate: capability === "video" ? '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{images}}"}' : "",
        resultField: capability === "video" ? "video_url" : "",
        statusField: capability === "video" ? "status" : "",
        supportsReferenceImage: true,
    } satisfies SystemChannelModelConfig;
}

function protocolAdvancedConfig(protocol: SystemChannelProtocol, operation: SystemChannelModelConfig, model: string): SystemChannelAdvancedConfig {
    const base = emptyAdvancedConfig();
    return {
        ...base,
        ...operation,
        protocol,
        modelConfigs: { [normalizeModel(model)]: operation },
    };
}

async function configureProxyChannel(definition: ChannelProtocolDefinition, capability: LogicalModelCapability, model: string, advancedConfig: SystemChannelAdvancedConfig): Promise<ProxyChannel> {
    const channelId = `proxy-${definition.id}-${capability}`;
    const logicalModelId = `${definition.id}-${capability}`;
    const upstreamBaseUrl = advancedConfig.pathPrefix ? fixtureOrigin : fixtureBaseUrl(definition.id, advancedConfig.protocol === "gemini" ? "gemini" : definition.apiFormat);
    const savedChannel = { id: channelId, name: channelId, enabled: true, baseUrl: upstreamBaseUrl, apiKey: "fixture-key", apiFormat: definition.apiFormat, models: [model], advancedConfig } satisfies SystemModelChannel;
    const logicalModels = [{ id: logicalModelId, name: logicalModelId, capability, enabled: true, bindings: [{ id: `${logicalModelId}-binding`, channelId, upstreamModel: model, enabled: true, priority: 1 }] }];
    const defaultModels: SystemDefaultModels = { textModel: "", imageModel: "", videoModel: "", audioModel: "", [`${capability}Model`]: logicalModelId };
    const response = await saveAdminSettings(
        new Request(`${INTERNAL_ORIGIN}/api/admin/settings`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ systemChannels: [savedChannel], logicalModels, defaultModels }),
        }),
    );
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Admin channel save failed for ${definition.id}/${capability}: ${responseText}`);
    const payload = JSON.parse(responseText) as { settings: { systemChannels: Array<{ apiKey: string; hasApiKey: boolean }> } };
    expect(payload.settings.systemChannels[0]).toMatchObject({ apiKey: "", hasApiKey: true });
    const persisted = await readFile(join(dataDir, "auth.json"), "utf8");
    expect(persisted).not.toContain("fixture-key");
    expect(persisted).toContain("vozeb-pro-secret:v1:");
    return {
        channelId,
        logicalModelId,
        savedChannel,
        upstreamBaseUrl,
        expectedAuthHeaders: protocolAuthHeaders("fixture-key", advancedConfig, definition.apiFormat),
        config: {
            apiSource: "system" as const,
            baseUrl: `/api/ai/system/${encodeURIComponent(channelId)}`,
            apiKey: "system" as const,
            apiFormat: definition.apiFormat,
            model,
            logicalModel: logicalModelId,
            channelId,
            advancedConfig,
        } satisfies SystemGenerationChannelConfig,
    };
}

type ProxyChannel = {
    channelId: string;
    logicalModelId: string;
    savedChannel: SystemModelChannel;
    upstreamBaseUrl: string;
    expectedAuthHeaders: Record<string, string>;
    config: SystemGenerationChannelConfig;
};

function fixtureBaseUrl(protocol: SystemChannelProtocol, apiFormat: "openai" | "gemini") {
    if (["custom", "dataeyes-seedance", "stable-diffusion", "yumeng", "seedance-special", "zai-glm", "alibaba-bailian", "bfl", "kling", "vidu", "minimax", "anthropic", "xai", "volcengine-image"].includes(protocol)) return fixtureOrigin;
    return `${fixtureOrigin}/${apiFormat === "gemini" ? "v1beta" : "v1"}`;
}

function imageTask(channel: ProxyChannel, edit: boolean): ImageTask {
    const protocol = channel.config.advancedConfig?.protocol || "auto";
    return {
        id: `${edit ? "edit" : "image"}-${protocol}`,
        userId: "proxy-user",
        username: "proxy-user",
        displayName: "Proxy User",
        kind: edit ? "edit" : "generation",
        source: "image-workbench",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: { ...channel.config, quality: "high" },
        candidateConfigs: [],
        prompt: "create a blue protocol test image",
        references: edit
            ? [
                  {
                      id: "reference",
                      name: "reference.png",
                      type: "image/png",
                      dataUrl:
                          protocol === "yumeng"
                              ? `${fixtureOrigin}/media/fixture.png`
                              : ["sub2api", "sub2api-grok", "custom", "alibaba-bailian", "minimax", "xai", "volcengine-image", "dataeyes-seedream"].includes(protocol)
                                ? "https://cdn.example.com/reference.png"
                                : PNG_DATA_URL,
                  },
              ]
            : [],
    };
}

async function runImage(task: ImageTask, protocol: SystemChannelProtocol) {
    const declarative = protocol === "custom" || protocol === "stable-diffusion" || protocol === "yumeng";
    const submitted = declarative
        ? await runCustomImageTask(task, INTERNAL_ORIGIN, fixtureOrigin, "", true)
        : task.config.apiFormat === "gemini"
          ? await runGeminiImageTask(task, INTERNAL_ORIGIN, "")
          : await runOpenAiImageTask(task, INTERNAL_ORIGIN, fixtureOrigin, "", true);
    return submitted.pending ? pollCustomImageTask(task, submitted.pending.id, submitted.pending.mediaBaseUrl, submitted.pending.pollBaseUrl, "", true) : submitted;
}

function videoParameters() {
    return { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false };
}

async function expectImageResult(result: { dataUrl?: string; remoteUrl?: string }) {
    const source = result.dataUrl || result.remoteUrl || "";
    expect(source).toBeTruthy();
    if (source.startsWith("data:")) {
        expect(Buffer.from(source.slice(source.indexOf(",") + 1), "base64").byteLength).toBeGreaterThan(0);
        return;
    }
    const response = await dispatchInternalRequest(source.startsWith("/") ? `${INTERNAL_ORIGIN}${source}` : source, {});
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("image/");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
}

async function expectVideoResult(channel: ProxyChannel, upstream: VideoTask["upstream"]) {
    expect(upstream?.id).toBeTruthy();
    const result = await queryVideoTaskUpstream({ config: channel.config, upstream, userId: "proxy-user" } as unknown as VideoTask, INTERNAL_ORIGIN, "");
    expect(result).toMatchObject({ state: "result_ready" });
    if (result.state !== "result_ready") throw new Error(`video fixture did not return a result: ${result.state}`);
    const proxyUrl = `${INTERNAL_ORIGIN}${channel.config.baseUrl}/_media?url=${encodeURIComponent(result.resultUrl)}`;
    const response = await dispatchInternalRequest(proxyUrl, {});
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
}

function expectProxyRequests(channel: ProxyChannel, createPath: string | undefined, model: string, referenceRequired: boolean, queryPath?: string, taskId?: string) {
    if (!createPath) throw new Error("Protocol operation is missing createPath");
    const createRequests = fixture.requests.filter((request) => request.method === "POST");
    expect(createRequests).toHaveLength(1);
    const request = createRequests[0]!;
    const body = request.body.toString(request.contentType.includes("multipart/form-data") ? "latin1" : "utf8");
    expect(request.path).toBe(upstreamPath(channel.upstreamBaseUrl, createPath.replace(":model", model)));
    expect(request.body.byteLength).toBeGreaterThan(0);
    expect(decodeURIComponent(request.path).includes(model) || body.includes(model)).toBe(true);
    expect(request.headers["idempotency-key"]).toBeTruthy();
    expect(request.headers["x-client-request-id"]).toBeTruthy();
    Object.entries(channel.expectedAuthHeaders).forEach(([key, value]) => expect(request.headers[key.toLowerCase()]).toBe(value));
    expect(requestContainsReference(request)).toBe(referenceRequired);
    if (queryPath && taskId) expect(fixture.requests.some((request) => request.method === "GET" && request.path === upstreamPath(channel.upstreamBaseUrl, queryPath.replace(":model", model).replace(":task_id", taskId)))).toBe(true);
    expect(mocks.consumeUserPoints).toHaveBeenCalled();
}

function upstreamPath(baseUrl: string, path: string) {
    const base = new URL(baseUrl).pathname.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const baseVersion = base.match(/\/(v1|v1beta)$/i)?.[1];
    const normalizedSuffix = baseVersion ? suffix.replace(new RegExp(`^/${baseVersion}(?=/)`, "i"), "") : suffix;
    return `${base}${normalizedSuffix}` || "/";
}

function requestContainsReference(request: (typeof fixture.requests)[number] | undefined) {
    const body = request?.body.toString(request.contentType.includes("multipart/form-data") ? "latin1" : "utf8") || "";
    return /reference\.png|fixture\.png|iVBOR|input_reference|reference_images|image_urls|inlineData|image_url|"images"\s*:\s*\[\s*"http|"image"\s*:\s*\{/.test(body);
}

async function dispatchInternalRequest(input: string | URL | Request, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.slice(0, 3).join("/") !== "api/ai/system") return fetch(request);
    const channelId = decodeURIComponent(segments[3] || "");
    const path = segments.slice(4).map(decodeURIComponent);
    const context = { params: Promise.resolve({ channelId, path }) };
    if (request.method === "GET") return proxyGet(request, context);
    if (request.method === "HEAD") return proxyHead(request, context);
    if (request.method === "POST") return proxyPost(request, context);
    if (request.method === "DELETE") return proxyDelete(request, context);
    throw new Error(`Unsupported internal fixture method: ${request.method}`);
}

function normalizeModel(model: string) {
    return model
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}
