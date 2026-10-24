import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({
    checkMediaProxyRateLimit: vi.fn(),
    consumeUserPoints: vi.fn(),
    getAuthSettings: vi.fn(),
    refundUserPoints: vi.fn(),
    safeUrl: vi.fn(),
    acquire: vi.fn(),
    wrap: vi.fn(),
    release: vi.fn(),
    mediaAccess: vi.fn(),
    taskAccess: vi.fn(),
    beginAudioShadow: vi.fn(),
    finishAudioShadow: vi.fn(),
    beginImageShadow: vi.fn(),
    finishImageShadow: vi.fn(),
    beginShadow: vi.fn(),
    finishShadow: vi.fn(),
    bindTextBilling: vi.fn(),
    executePriced: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user-one", role: "user", pointsBalance: 5 })) }));
vi.mock("@/lib/auth/store", () => ({
    consumeUserPoints: mocks.consumeUserPoints,
    getAuthSettings: mocks.getAuthSettings,
    isAuthInputError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
    isQuotaExceededError: vi.fn(() => false),
    refundUserPoints: mocks.refundUserPoints,
}));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/media-concurrency", () => ({ acquireMediaConcurrency: mocks.acquire, withMediaConcurrency: mocks.wrap }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));
vi.mock("@/lib/server/generation-media-access", () => ({ authorizeGenerationMediaProxyRequest: mocks.mediaAccess }));
vi.mock("@/lib/server/generation-task-authorization", () => ({ userOwnsGenerationUpstreamTask: mocks.taskAccess }));
vi.mock("@/lib/server/text-task-store", () => ({ bindTextTaskBillingRequest: mocks.bindTextBilling }));
vi.mock("@/lib/server/model-pricing-text-task", () => ({ executePricedTextTask: mocks.executePriced }));
vi.mock("@/lib/server/model-pricing-shadow-call", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/server/model-pricing-shadow-call")>()),
    beginShadowTextCall: mocks.beginShadow,
    finishShadowTextCall: mocks.finishShadow,
}));
vi.mock("@/lib/server/model-pricing-shadow-audio-call", () => ({ beginShadowAudioCall: mocks.beginAudioShadow, finishShadowAudioCall: mocks.finishAudioShadow }));
vi.mock("@/lib/server/model-pricing-shadow-image-call", () => ({ beginShadowImageCall: mocks.beginImageShadow, finishShadowImageCall: mocks.finishImageShadow }));
vi.mock("@/lib/server/security", () => ({
    checkMediaProxyRateLimit: mocks.checkMediaProxyRateLimit,
    isSafeOutboundUrl: mocks.safeUrl,
    rateLimitHeaders: vi.fn(() => ({ "Retry-After": "60" })),
}));

import { GET, maxDuration, POST, PUT } from "./route";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { MEDIA_SNIFF_RANGE } from "@/lib/server/media-content-validation";
import { SYSTEM_PROXY_JSON_BODY_MAX_BYTES } from "@/lib/server/system-proxy-request-limits";
import { systemAiBillingHeaders, systemAiPointsIdempotencyKey, SYSTEM_AI_TEXT_TASK_HEADER } from "@/lib/server/system-ai-billing";
import { PricingConflictError } from "@/lib/model-pricing";

const context = { params: Promise.resolve({ channelId: "channel-one", path: ["_media"] }) };

beforeEach(() => {
    mocks.beginAudioShadow.mockReset().mockResolvedValue(undefined);
    mocks.finishAudioShadow.mockReset().mockResolvedValue(undefined);
    mocks.beginImageShadow.mockReset().mockResolvedValue(undefined);
    mocks.finishImageShadow.mockReset().mockResolvedValue(undefined);
    mocks.beginShadow.mockReset().mockResolvedValue(undefined);
    mocks.finishShadow.mockReset().mockResolvedValue(undefined);
    mocks.bindTextBilling.mockReset().mockResolvedValue(undefined);
    mocks.executePriced.mockReset();
});

describe("system generation proxy runtime", () => {
    it("keeps long image and video submissions alive beyond the framework default", () => {
        expect(maxDuration).toBeGreaterThanOrEqual(40 * 60);
    });

    it("accepts the JSON expansion of one maximum-size visual reference", () => {
        expect(SYSTEM_PROXY_JSON_BODY_MAX_BYTES).toBeGreaterThan(Math.ceil((CREATIVE_UPLOAD_MAX_BYTES * 4) / 3));
    });
});

describe("system text shadow observation", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "vendor-text")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-text"] }],
        });
    });

    it("rejects a retained DataEyes model absent from the current key catalog before charging or forwarding", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "ByteDance-Seed-1.6")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://studio.dataeyes.ai",
                    apiKey: "fixture-key",
                    apiFormat: "openai",
                    models: ["ByteDance-Seed-1.6", "doubao-seed-2-1-pro-260915"],
                    advancedConfig: { protocol: "openai", providerModels: ["doubao-seed-2-1-pro-260915"] },
                },
            ],
        });
        const upstream = vi.spyOn(globalThis, "fetch");

        const response = await POST(chatRequest({ model: "ByteDance-Seed-1.6", messages: [{ role: "user", content: "hello" }] }), textContext());

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "该模型未在当前渠道密钥的供应商目录中" });
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });

    it("forwards a dedicated DataEyes Claude Messages binding with Bearer and Anthropic version", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("claude-fable-5", "text", "claude-fable-5")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://platform.dataeyes.ai", apiKey: "fixture-key", apiFormat: "openai", models: ["claude-fable-5"], advancedConfig: { protocol: "anthropic", channelAuthMode: "bearer" } }],
        });
        const upstream = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(Response.json({ model: "claude-fable-5", content: [{ type: "text", text: "2" }], stop_reason: "end_turn", usage: { input_tokens: 18, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
        const payload = { model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "1+1=?" }] };
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...systemModelHeaders("claude-fable-5", "claude-fable-5") }, body: JSON.stringify(payload) }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "messages"] }) },
        );
        expect(response.status).toBe(200);
        expect(upstream).toHaveBeenCalledOnce();
        expect(upstream.mock.calls[0][0]).toBe("https://platform.dataeyes.ai/v1/messages");
        const headers = new Headers(upstream.mock.calls[0][1]?.headers);
        expect(headers.get("authorization")).toBe("Bearer fixture-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(headers.get("x-api-key")).toBeNull();
        expect(JSON.parse(new TextDecoder().decode(upstream.mock.calls[0][1]?.body as ArrayBuffer))).toEqual(payload);
        expect(await response.json()).toMatchObject({ model: "claude-fable-5", usage: { input_tokens: 18 } });
    });

    it("routes a server-owned priced task through its wallet coordinator before any legacy charge or send", async () => {
        const task = { taskId: "text-task-one", attemptNo: 1 };
        mocks.bindTextBilling.mockResolvedValue({ id: task.taskId, billingMode: "official-usage" });
        mocks.executePriced.mockResolvedValue(Response.json({ error: "pending" }, { status: 409 }));
        const upstream = vi.spyOn(globalThis, "fetch");
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemAiBillingHeaders("writer", "business-one", "vendor-text", task) },
                body: JSON.stringify({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }),
            }),
            textContext(),
        );
        expect(response.status).toBe(409);
        expect(mocks.executePriced).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", modelId: "writer", send: expect.any(Function) }));
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(mocks.beginShadow).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });

    it.each([
        { path: ["v1", "chat", "completions"], apiFormat: "openai", protocol: "openai" },
        { path: ["v1", "responses"], apiFormat: "openai", protocol: "compatible" },
        { path: ["v1", "messages"], apiFormat: "openai", protocol: "anthropic" },
        { path: ["v1beta", "models", "vendor-text:streamGenerateContent"], apiFormat: "gemini", protocol: "auto" },
        { path: ["vendor", "text-stream"], apiFormat: "openai", protocol: "compatible" },
    ])("keeps the native $path stream inside signed task accounting", async ({ path, apiFormat, protocol }) => {
        const configuredPath = `/${path.join("/")}`;
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "vendor-text")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com", apiKey: "secret", apiFormat, models: ["vendor-text"], advancedConfig: { protocol, streaming: { enabled: true, path: configuredPath } } }],
        });
        mocks.bindTextBilling.mockResolvedValue({ id: "text-task-one", billingMode: "official-usage" });
        const raw = 'data: {"public":"reply"}\n\n';
        mocks.executePriced.mockResolvedValue(new Response(raw, { headers: { "content-type": "text/event-stream", "x-vozeb-pro-pricing-state": "streaming" } }));
        const upstream = vi.spyOn(globalThis, "fetch");
        const response = await POST(
            new Request(`http://localhost/api/ai/system/channel-one${configuredPath}`, {
                method: "POST",
                headers: { "content-type": "application/json", ...systemAiBillingHeaders("writer", "business-one", "vendor-text", { taskId: "text-task-one", attemptNo: 1 }) },
                body: JSON.stringify({ model: "vendor-text", messages: [{ role: "user", content: "hello" }], stream: true }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path }) },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-vozeb-pro-pricing-state")).toBe("streaming");
        expect(await response.text()).toBe(raw);
        expect(mocks.executePriced).toHaveBeenCalledWith(expect.objectContaining({ path, adapted: false }));
        expect(mocks.bindTextBilling).toHaveBeenCalledOnce();
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(mocks.beginShadow).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });

    it("binds a signed text attempt before charging or sending, and stops on association failure", async () => {
        const task = { taskId: "text-task-one", attemptNo: 1 };
        const makeRequest = () =>
            new Request("http://localhost/api/ai/system/channel-one/v1/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemAiBillingHeaders("writer", "business-one", "vendor-text", task) },
                body: JSON.stringify({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }),
            });
        mocks.consumeUserPoints.mockImplementation(async () => {
            expect(mocks.bindTextBilling).toHaveBeenCalledOnce();
            return undefined;
        });
        const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "reply" } }] }));
        expect((await POST(makeRequest(), textContext())).status).toBe(200);
        expect(mocks.bindTextBilling).toHaveBeenCalledWith(
            expect.objectContaining({
                ...task,
                userId: "user-one",
                businessRequestId: "business-one",
                channelId: "channel-one",
                logicalModel: "writer",
                upstreamModel: "vendor-text",
                requestId: expect.stringMatching(/^system-ai:/),
                requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        );
        upstream.mockClear();
        mocks.consumeUserPoints.mockClear();
        mocks.bindTextBilling.mockRejectedValue(new PricingConflictError("任务已变化"));
        expect((await POST(makeRequest(), textContext())).status).toBe(409);
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
        mocks.bindTextBilling.mockRejectedValue(new Error("fixture persistence failure"));
        await expect(POST(makeRequest(), textContext())).rejects.toThrow("fixture persistence failure");
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
        const forged = makeRequest();
        forged.headers.set(SYSTEM_AI_TEXT_TASK_HEADER, "forged");
        expect((await POST(forged, textContext())).status).toBe(403);
        expect(upstream).not.toHaveBeenCalled();
    });

    it("freezes the server-owned identity before forwarding and observes the unchanged JSON response", async () => {
        const frozen = { userId: "user-one", requestId: "frozen-request" };
        mocks.beginShadow.mockResolvedValue(frozen);
        const payload = { choices: [{ finish_reason: "stop", message: { content: "reply" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } };
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            expect(mocks.beginShadow).toHaveBeenCalledOnce();
            return Response.json(payload, { headers: { "Msh-Usage-Cache-Write-Tokens-5m": "60" } });
        });
        const response = await POST(chatRequest({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }), textContext());
        expect(await response.json()).toEqual(payload);
        expect(response.headers.get("Msh-Usage-Cache-Write-Tokens-5m")).toBeNull();
        expect(mocks.beginShadow).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", modelId: "writer", channelId: "channel-one", requestId: expect.stringMatching(/^system-ai:/), requestFingerprint: expect.any(String) }));
        expect(mocks.finishShadow).toHaveBeenCalledWith(frozen, { payload, responseHeaders: expect.any(Headers) });
        expect(mocks.finishShadow.mock.calls[0][1].responseHeaders.get("Msh-Usage-Cache-Write-Tokens-5m")).toBe("60");
        expect(mocks.consumeUserPoints).toHaveBeenCalledOnce();
    });

    it.each([
        { protocol: undefined, contentType: "text/event-stream" },
        { protocol: "openai-chat", contentType: "application/x-ndjson" },
    ])("passes through unsupported $contentType/$protocol streams without failing generation", async ({ protocol, contentType }) => {
        const frozen = { requestId: "stream-request", protocol };
        mocks.beginShadow.mockResolvedValue(frozen);
        const stream = 'data: {"text":"reply"}\n\ndata: [DONE]\n\n';
        const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { headers: { "content-type": contentType } }));
        const response = await POST(chatRequest({ model: "vendor-text", messages: [{ role: "user", content: "hello" }], stream: true }), textContext());
        expect(await response.text()).toBe(stream);
        expect(mocks.finishShadow).toHaveBeenCalledWith(frozen, { unavailable: "该流式或非 JSON 响应格式的用量观察尚未接入" });
        mocks.beginShadow.mockRejectedValue(new Error("internal storage failure"));
        const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
        fetcher.mockResolvedValue(Response.json({ result: "unchanged" }));
        expect((await POST(chatRequest({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }), textContext())).status).toBe(200);
        expect(logger).toHaveBeenCalledWith("Model pricing shadow observation failed", expect.objectContaining({ errorType: "Error" }));
        expect(JSON.stringify(logger.mock.calls)).not.toContain("internal storage failure");
    });

    it.each(["application/json", "text/event-stream"])("preserves the existing settlement boundary while observing %s", async (contentType) => {
        const controller = new AbortController();
        mocks.consumeUserPoints.mockResolvedValue({ model: "writer", cost: 1, units: 1, usageKind: "text", recordId: "fixed-record", remaining: 4 });
        mocks.refundUserPoints.mockReset();
        mocks.beginShadow.mockResolvedValue({ requestId: "frozen-request", protocol: "openai-chat" });
        mocks.finishShadow.mockImplementation(async () => {
            controller.abort();
        });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(contentType === "application/json" ? "{}" : "data: [DONE]\n\n", { headers: { "content-type": contentType } }));
        const request = new Request(chatRequest({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }), { signal: controller.signal });
        const response = await POST(request, textContext());
        expect(response.status).toBe(200);
        await response.text();
        expect(mocks.finishShadow).toHaveBeenCalledOnce();
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
        expect(response.headers.get("x-vozeb-pro-points-cost")).toBe("1");
    });
});

describe("system media proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.checkMediaProxyRateLimit.mockResolvedValue({ allowed: true, remaining: 119, resetAt: Date.now() + 60_000 });
        mocks.safeUrl.mockResolvedValue(true);
        mocks.release.mockReset();
        mocks.acquire.mockReturnValue({ release: mocks.release });
        mocks.wrap.mockImplementation((response: Response) => response);
        mocks.mediaAccess.mockReset().mockResolvedValue(true);
        mocks.taskAccess.mockReset().mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: [] }],
        });
    });

    it("blocks authenticated media requests when the rate limit is exhausted", async () => {
        mocks.checkMediaProxyRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

        const response = await GET(request(), context);

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects media urls that were not authorized by a server-owned generation task", async () => {
        mocks.mediaAccess.mockResolvedValue(false);
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const response = await GET(request(), context);
        expect(response.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects oversized upstream media", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { headers: { "content-length": String(300 * 1024 * 1024 + 1) } }));

        const response = await GET(request(), context);

        expect(response.status).toBe(413);
    });

    it("forces private caching for channel media", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(pngBytes(), { headers: { "cache-control": "public, max-age=86400", "content-type": "text/html" } }));

        const response = await GET(request(), context);

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, max-age=600");
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("accepts octet-stream media and rejects executable bodies", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(pngBytes(), { headers: { "content-type": "application/octet-stream" } }))
            .mockResolvedValueOnce(new Response(unsafeBody("<!doctype html><script>alert(1)</script>"), { headers: { "content-type": "image/png" } }));

        const accepted = await GET(request(), context);
        const rejected = await GET(request(), context);

        expect(accepted.status).toBe(200);
        expect(accepted.headers.get("content-type")).toBe("image/png");
        expect(rejected.status).toBe(415);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("probes the file signature before serving a non-zero range", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(mp4Bytes(), { status: 206, headers: { "content-type": "application/octet-stream" } }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-type": "text/html" } }));

        const response = await GET(request("https://cdn.example.com/video.mp4", { range: "bytes=100-" }), context);

        expect(response.status).toBe(206);
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("range")).toBe(MEDIA_SNIFF_RANGE);
        expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("range")).toBe(`bytes=100-${100 + 32 * 1024 * 1024 - 1}`);
        expect(response.headers.get("content-type")).toBe("video/mp4");
    });

    it("checks every media redirect before fetching the next hop", async () => {
        mocks.safeUrl.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } }));

        const response = await GET(request(), context);

        expect(response.status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses Bearer authentication for GlobalAiOpc media even when its API format is Gemini", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer",
                    apiKey: "secret",
                    apiFormat: "gemini",
                    models: [],
                    advancedConfig: { protocol: "globalaiopc", globalAiOpcPreset: "video-seedance-x1" },
                },
            ],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(mp4Bytes(), { headers: { "content-type": "application/octet-stream" } }));

        const response = await GET(request("/v1/result/task-one"), context);

        expect(response.status).toBe(200);
        const [, init] = fetchMock.mock.calls[0];
        expect(fetchMock.mock.calls[0][0]).toBe("https://zcbservice.aizfw.cn/v1/result/task-one");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBeNull();
    });
});

describe("OpenAI Responses proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "gpt-5")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "secret", apiFormat: "openai", models: ["gpt-5"], advancedConfig: { protocol: "compatible", createPath: "/v1/responses" } }],
        });
    });

    it("forwards /v1/responses without duplicating the /v1 base path", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }), { headers: { "content-type": "application/json" } }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/responses", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: "gpt-5", input: [{ role: "user", content: "hello" }], stream: false }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "responses"] }) },
        );

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
        const upstreamBody = fetchMock.mock.calls[0]?.[1]?.body;
        expect(JSON.parse(new TextDecoder().decode(upstreamBody as ArrayBuffer))).toMatchObject({ model: "gpt-5", input: [{ role: "user", content: "hello" }] });
    });

    it("authorizes GPT-4o Audio Chat output as audio and charges the audio logical model", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("voice-model", "audio", "gpt-4o-audio-preview")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://sub2api.example",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["gpt-4o-audio-preview"],
                    advancedConfig: { protocol: "openai", modelCapabilities: { "gpt-4o-audio-preview": "audio" }, modelConfigs: { "gpt-4o-audio-preview": { capability: "audio", protocol: "openai", apiFormat: "openai", createPath: "/audio/speech" } } },
                },
            ],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { audio: { data: "UklGRg==" } } }] }));
        const response = await POST(chatRequest({ model: "gpt-4o-audio-preview", modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" }, messages: [{ role: "user", content: "hello" }] }), textContext());

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://sub2api.example/v1/chat/completions");
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "voice-model", 1, "audio", expect.any(String), expect.any(String));
    });
});

describe("GlobalAiOpc native text proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.taskAccess.mockReset().mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("gemini-text", "text", "gemini-3.1-pro-preview")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "http://apillm.globalaiopc.com/gw_llm_power",
                    apiKey: "secret",
                    apiFormat: "gemini",
                    models: ["gemini-3.1-pro-preview"],
                    advancedConfig: { protocol: "globalaiopc", globalAiOpcPreset: "text-gemini-native" },
                },
            ],
        });
    });

    it("maps internal Chat calls to Gemini native paths, payloads, and Bearer authentication", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }), { headers: { "content-type": "application/json" } }));

        const response = await POST(chatRequest({ model: "gemini-3.1-pro-preview", messages: [{ role: "user", content: "hello" }] }), textContext());

        expect(response.status).toBe(200);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("http://apillm.globalaiopc.com/gw_llm_power/v1/models/gemini-3.1-pro-preview:generateContent");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBeNull();
        expect(JSON.parse(String(init?.body))).toMatchObject({ contents: [{ role: "user", parts: [{ text: "hello" }] }] });
        expect(await response.json()).toMatchObject({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    });

    it("refunds a charged GlobalAiOpc call when a 2xx response is not JSON", async () => {
        mocks.consumeUserPoints.mockResolvedValue({ model: "gemini-text", cost: 1, units: 1, usageKind: "text", recordId: "points-invalid-json", remaining: 4, permanentRemaining: 4, dailyRemaining: 0, dailyExpiresAt: "" });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }));

        const response = await POST(chatRequest({ model: "gemini-3.1-pro-preview", messages: [{ role: "user", content: "hello" }] }), textContext());

        expect(response.status).toBe(502);
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "gemini-text", 1, "text", 1, undefined, "points-invalid-json");
    });

    it("charges text calls with the logical model id instead of the upstream alias", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [
                {
                    id: "writer",
                    name: "写作模型",
                    capability: "text",
                    enabled: true,
                    bindings: [{ id: "writer-binding", channelId: "channel-one", upstreamModel: "vendor-text", enabled: true, priority: 1 }],
                },
            ],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-text"] }],
        });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "OK" } }] }));

        const response = await POST(chatRequest({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }), textContext());

        expect(response.status).toBe(200);
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "writer", 1, "text", expect.stringMatching(/^system-ai:[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/));
    });

    it("uses the validated preferred logical model and stable idempotency key when aliases are shared", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [
                { id: "writer-basic", name: "基础写作", capability: "text", enabled: true, bindings: [{ id: "basic", channelId: "channel-one", upstreamModel: "vendor-shared", enabled: true, priority: 1 }] },
                { id: "writer-pro", name: "专业写作", capability: "text", enabled: true, bindings: [{ id: "pro", channelId: "channel-one", upstreamModel: "vendor-shared", enabled: true, priority: 2 }] },
            ],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-shared"] }],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "OK" } }] }));
        const request = new Request("http://localhost/api/ai/system/channel-one/chat/completions", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "upstream-request-one",
                "x-client-request-id": "client-request-one",
                ...systemAiBillingHeaders("writer-pro", "text-task:one:attempt:1", "vendor-shared"),
            },
            body: JSON.stringify({ model: "vendor-shared", messages: [{ role: "user", content: "hello" }] }),
        });

        const response = await POST(request, textContext());
        const expectedKey = systemAiPointsIdempotencyKey({
            userId: "user-one",
            businessRequestId: "text-task:one:attempt:1",
            logicalModel: "writer-pro",
            channelId: "channel-one",
            upstreamModel: "vendor-shared",
            callType: "text:create:/chat/completions",
        });

        expect(response.status).toBe(200);
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "writer-pro", 1, "text", expectedKey, expect.stringMatching(/^[a-f0-9]{64}$/));
        const upstreamHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
        expect(upstreamHeaders.get("idempotency-key")).toBe("upstream-request-one");
        expect(upstreamHeaders.get("x-client-request-id")).toBe("client-request-one");
    });

    it("ignores an unsigned client billing key and creates a new local identity for each request", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "vendor-text")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-text"] }],
        });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "OK" } }] }));
        const createRequest = () =>
            new Request("http://localhost/api/ai/system/channel-one/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-logical-model": "writer", "x-vozeb-pro-points-idempotency-key": "forged-client-key" },
                body: JSON.stringify({ model: "vendor-text", messages: [{ role: "user", content: "hello" }] }),
            });

        await POST(createRequest(), textContext());
        await POST(createRequest(), textContext());

        expect(mocks.consumeUserPoints.mock.calls[0][4]).not.toBe(mocks.consumeUserPoints.mock.calls[1][4]);
        expect(mocks.consumeUserPoints.mock.calls[0][5]).toBe(mocks.consumeUserPoints.mock.calls[1][5]);
    });

    it("returns 409 when one signed business request is replayed with a different payload", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "vendor-text")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-text"] }],
        });
        let firstIdentity: { key: string; fingerprint: string } | undefined;
        mocks.consumeUserPoints.mockImplementation(async (_userId, _model, _amount, _usageKind, key: string, fingerprint: string) => {
            if (!firstIdentity) firstIdentity = { key, fingerprint };
            else if (firstIdentity.key === key && firstIdentity.fingerprint !== fingerprint) throw Object.assign(new Error("积分幂等键对应的消费参数不一致"), { status: 409 });
            return undefined;
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "OK" } }] }));
        const billingHeaders = systemAiBillingHeaders("writer", "task-one", "vendor-text");
        const createRequest = (content: string) =>
            new Request("http://localhost/api/ai/system/channel-one/chat/completions", {
                method: "POST",
                headers: { "content-type": "application/json", ...billingHeaders },
                body: JSON.stringify({ model: "vendor-text", messages: [{ role: "user", content }] }),
            });

        const first = await POST(createRequest("first"), textContext());
        const second = await POST(createRequest("changed"), textContext());

        expect(first.status).toBe(200);
        expect(second.status).toBe(409);
        expect(await second.json()).toEqual({ error: "积分幂等键对应的消费参数不一致" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("routes GlobalAiOpc media models from one catalog channel to the matching service endpoint", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("videos-model", "video", "videos_stable")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer/v1",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["happyhorse-1.0-i2v", "videos_stable"],
                    advancedConfig: { protocol: "globalaiopc", globalAiOpcPresets: ["video-happyhorse-i2v", "video-videos"] },
                },
            ],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "task" }), { headers: { "content-type": "application/json" } }));

        const response = await POST(chatRequest({ model: "videos_stable", prompt: "hello" }), { params: Promise.resolve({ channelId: "channel-one", path: ["videos", "videos"] }) });

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://zcbservice.aizfw.cn/kyyReactApiServer/v1/videos/videos");
    });

    it("keeps the GlobalAiOpc service prefix and v1 version when polling a video task", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("videos-model", "video", "videos_stable")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer/v1",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["videos_stable"],
                    advancedConfig: { protocol: "globalaiopc", globalAiOpcPreset: "video-videos" },
                },
            ],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "video-one", status: "processing" }), { headers: { "content-type": "application/json" } }));

        const response = await GET(new Request("http://localhost/api/ai/system/channel-one/result/video-one", { headers: systemModelHeaders("videos-model", "videos_stable") }), {
            params: Promise.resolve({ channelId: "channel-one", path: ["result", "video-one"] }),
        });

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://zcbservice.aizfw.cn/kyyReactApiServer/v1/result/video-one");
    });

    it("maps internal Chat calls to Claude Messages and leaves Responses for Chat fallback", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("claude-text", "text", "claude-opus-4-6")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "http://apillm.globalaiopc.com/gw_llm_power",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["claude-opus-4-6"],
                    advancedConfig: { protocol: "globalaiopc", globalAiOpcPreset: "text-claude-native" },
                },
            ],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }), { headers: { "content-type": "application/json" } }));

        const response = await POST(chatRequest({ model: "claude-opus-4-6", messages: [{ role: "user", content: "hello" }] }), textContext());

        expect(fetchMock.mock.calls[0][0]).toBe("http://apillm.globalaiopc.com/gw_llm_power/v1/messages");
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: "claude-opus-4-6", messages: [{ role: "user", content: "hello" }] });
        expect(await response.json()).toMatchObject({ choices: [{ message: { role: "assistant", content: "OK" } }] });

        fetchMock.mockClear();
        const fallback = await POST(new Request("http://localhost/api/ai/system/channel-one/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-4-6", input: "hello" }) }), {
            params: Promise.resolve({ channelId: "channel-one", path: ["responses"] }),
        });
        expect(fallback.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("Agnes video polling proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.taskAccess.mockReset().mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("agnes-video", "video", "agnes-video-v2.0")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://apihub.agnes-ai.com/v1", apiKey: "secret", apiFormat: "openai", models: ["agnes-video-v2.0"] }],
        });
    });

    it("queries the documented root agnesapi endpoint instead of nesting it under v1", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "video-one", status: "processing" }));

        const response = await GET(new Request("http://localhost/api/ai/system/channel-one/agnesapi?video_id=video-one", { headers: systemModelHeaders("agnes-video", "agnes-video-v2.0") }), {
            params: Promise.resolve({ channelId: "channel-one", path: ["agnesapi"] }),
        });

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://apihub.agnes-ai.com/agnesapi?video_id=video-one");
        expect(mocks.taskAccess).toHaveBeenCalledWith({ userId: "user-one", capability: "video", channelId: "channel-one", upstreamModel: "agnes-video-v2.0", upstreamTaskId: "video-one" });
    });

    it("does not forward another user's upstream task", async () => {
        mocks.taskAccess.mockResolvedValue(false);
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const response = await GET(new Request("http://localhost/api/ai/system/channel-one/agnesapi?video_id=other", { headers: systemModelHeaders("agnes-video", "agnes-video-v2.0") }), {
            params: Promise.resolve({ channelId: "channel-one", path: ["agnesapi"] }),
        });
        expect(response.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("Stable Diffusion proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [
                {
                    id: "image-local",
                    name: "本地图片",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "sd-binding", channelId: "channel-one", upstreamModel: "sdxl", enabled: true, priority: 1 }],
                },
            ],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://sd.example.com",
                    apiKey: "",
                    apiFormat: "openai",
                    models: ["sdxl"],
                    advancedConfig: { protocol: "stable-diffusion", authMode: "none", createPath: "/sdapi/v1/txt2img" },
                },
            ],
        });
    });

    it("keeps the sdapi path literal and omits authentication", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ images: ["image-base64"] }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/sdapi/v1/txt2img", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-vozeb-pro-logical-model": "image-local",
                    "x-vozeb-pro-upstream-model": "sdxl",
                },
                body: JSON.stringify({ prompt: "test", width: 1024, height: 1024 }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["sdapi", "v1", "txt2img"] }) },
        );

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://sd.example.com/sdapi/v1/txt2img");
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
    });

    it("fully receives a non-streaming image JSON response before returning it internally", async () => {
        const upstream = Response.json({ images: ["image-base64"] });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);

        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/sdapi/v1/txt2img", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-vozeb-pro-logical-model": "image-local",
                    "x-vozeb-pro-upstream-model": "sdxl",
                },
                body: JSON.stringify({ prompt: "slow image" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["sdapi", "v1", "txt2img"] }) },
        );

        expect(upstream.bodyUsed).toBe(true);
        await expect(response.json()).resolves.toEqual({ images: ["image-base64"] });
    });

    it("turns a broken image JSON body into an uncertain proxy failure and refunds local points", async () => {
        mocks.consumeUserPoints.mockResolvedValue({ model: "image-local", cost: 1, units: 1, usageKind: "image", recordId: "points-broken-body", remaining: 4, permanentRemaining: 4, dailyRemaining: 0, dailyExpiresAt: "" });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(new Error("socket closed"));
                    },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            ),
        );

        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/sdapi/v1/txt2img", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-vozeb-pro-logical-model": "image-local",
                    "x-vozeb-pro-upstream-model": "sdxl",
                },
                body: JSON.stringify({ prompt: "slow image" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["sdapi", "v1", "txt2img"] }) },
        );

        expect(response.status).toBe(502);
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "image-local", 1, "image", 1, undefined, "points-broken-body");
    });

    it("forwards a visual JSON body larger than the former four-megabyte ceiling", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ images: ["image-base64"] }));
        const body = JSON.stringify({ prompt: "layer this image", init_images: ["A".repeat(5 * 1024 * 1024)] });
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/sdapi/v1/txt2img", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-vozeb-pro-logical-model": "image-local",
                    "x-vozeb-pro-upstream-model": "sdxl",
                },
                body,
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["sdapi", "v1", "txt2img"] }) },
        );

        expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4 * 1024 * 1024);
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe("VOZEB recommended video proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.taskAccess.mockReset().mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("vozeb-video", "video", "Seedance 2.0-fast-720p")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://new.aiym.ink/v1",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["Seedance 2.0-fast-720p"],
                    advancedConfig: {
                        protocol: "vozeb-recommended",
                        createPath: "/v1/videos/generations",
                        imageToVideoPath: "/v1/videos/generations",
                        queryPath: "/v1/videos/generations/:task_id",
                        modelConfigs: {
                            "seedance 2.0-fast-720p": {
                                capability: "video",
                                protocol: "vozeb-recommended",
                                createPath: "/v1/videos/generations",
                                queryPath: "/v1/videos/generations/:task_id",
                            },
                        },
                    },
                },
            ],
        });
    });

    it("keeps one v1 prefix for JSON creation and polling", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ id: "video-one", task_id: "video-one", status: "queued" }))
            .mockResolvedValueOnce(Response.json({ id: "video-one", status: "completed", metadata: { url: "https://new.aiym.ink/v1/video-media/video-one.mp4" } }));
        const headers = { "content-type": "application/json", ...systemModelHeaders("vozeb-video", "Seedance 2.0-fast-720p") };
        const createResponse = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/videos/generations", {
                method: "POST",
                headers,
                body: JSON.stringify({ model: "Seedance 2.0-fast-720p", prompt: "test", duration: 5, generate_audio: false }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "videos", "generations"] }) },
        );
        const queryResponse = await GET(new Request("http://localhost/api/ai/system/channel-one/v1/videos/generations/video-one", { headers }), {
            params: Promise.resolve({ channelId: "channel-one", path: ["v1", "videos", "generations", "video-one"] }),
        });

        expect(createResponse.status).toBe(200);
        expect(queryResponse.status).toBe(200);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://new.aiym.ink/v1/videos/generations", "https://new.aiym.ink/v1/videos/generations/video-one"]);
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("content-type")).toBe("application/json");
    });
});

describe("Hailuo model-specific proxy paths", () => {
    it("rejects a stored H3 V2 path for a Hailuo model before charging or forwarding", async () => {
        vi.restoreAllMocks();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("hailuo", "video", "MiniMax-Hailuo-2.3")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://api.example.com",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["MiniMax-Hailuo-2.3"],
                    advancedConfig: {
                        protocol: "minimax",
                        createPath: "/v2/video_generation",
                        queryPath: "/v2/query/video_generation/:task_id",
                        modelConfigs: { "minimax-hailuo-2.3": { capability: "video", protocol: "minimax", createPath: "/v2/video_generation", queryPath: "/v2/query/video_generation/:task_id" } },
                    },
                },
            ],
        });
        const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ task_id: "task-one" }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v2/video_generation", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("hailuo", "MiniMax-Hailuo-2.3") },
                body: JSON.stringify({ model: "MiniMax-Hailuo-2.3", prompt: "test", duration: 6, resolution: "768P" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v2", "video_generation"] }) },
        );

        expect(response.status).toBe(404);
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();

        const v1 = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/video_generation", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("hailuo", "MiniMax-Hailuo-2.3") },
                body: JSON.stringify({ model: "MiniMax-Hailuo-2.3", prompt: "test", duration: 6, resolution: "768P" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "video_generation"] }) },
        );
        expect(v1.status).toBe(200);
        expect(mocks.consumeUserPoints).toHaveBeenCalledOnce();
        expect(upstream).toHaveBeenCalledOnce();
    });
});

describe("Gemini Veo native video proxy", () => {
    const model = "veo-3.1-generate-preview";

    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue({ model: "gemini-video", cost: 6, units: 6, recordId: "points-gemini", remaining: 94, permanentRemaining: 94, dailyRemaining: 0, dailyExpiresAt: "" });
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.taskAccess.mockReset().mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: { videoQuality: { "720": 2 }, videoSeconds: { "6": 3 } },
            logicalModels: [logicalModel("gemini-video", "video", model)],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://generativelanguage.googleapis.com", apiKey: "gemini-secret", apiFormat: "gemini", models: [model], advancedConfig: { protocol: "gemini" } }],
        });
    });

    it("forwards Gemini creation and operation polling with x-goog-api-key and video billing", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(Response.json({ name: `models/${model}/operations/operation-one`, done: false }))
            .mockResolvedValueOnce(Response.json({ done: false }));
        const headers = { "content-type": "application/json", ...systemModelHeaders("gemini-video", model) };
        const createResponse = await POST(
            new Request(`http://localhost/api/ai/system/channel-one/models/${model}:predictLongRunning`, {
                method: "POST",
                headers,
                body: JSON.stringify({ instances: [{ prompt: "A test video" }], parameters: { durationSeconds: 6, resolution: "720p" } }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["models", `${model}:predictLongRunning`] }) },
        );
        const queryResponse = await GET(new Request(`http://localhost/api/ai/system/channel-one/models/${model}/operations/operation-one`, { headers }), {
            params: Promise.resolve({ channelId: "channel-one", path: ["models", model, "operations", "operation-one"] }),
        });

        expect(createResponse.status).toBe(200);
        expect(queryResponse.status).toBe(200);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning`, `https://generativelanguage.googleapis.com/v1beta/models/${model}/operations/operation-one`]);
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("x-goog-api-key")).toBe("gemini-secret");
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBeNull();
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "gemini-video", 6, "video", expect.any(String), expect.any(String));
        expect(mocks.consumeUserPoints).toHaveBeenCalledOnce();
    });
});

describe("DataEyes Seedream image proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
    });

    it.each(["https://platform.dataeyes.ai", "https://platform.dataeyes.ai/v1"])("keeps one v1 segment with Base URL %s", async (baseUrl) => {
        const model = "ByteDance-Seedream-5.0-pro";
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("seedream-image", "image", model)],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl,
                    apiKey: "fixture-secret",
                    apiFormat: "openai",
                    models: [model],
                    advancedConfig: { protocol: "dataeyes-seedream", modelConfigs: { [model.toLowerCase()]: { capability: "image", protocol: "dataeyes-seedream", createPath: "/v1/images/generations" } } },
                },
            ],
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ url: "https://cdn.example.com/image.png" }] }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/images/generations", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("seedream-image", model) },
                body: JSON.stringify({ model, prompt: "test", size: "2K", response_format: "url" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "images", "generations"] }) },
        );
        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://platform.dataeyes.ai/v1/images/generations");
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer fixture-secret");
    });
});

describe("DataEyes FLUX fixed image billing", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue({ cost: 49, units: 1, recordId: "flux-points", remaining: 100 });
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: { imageQuality: { high: 2 } },
            logicalModels: [logicalModel("flux-2-max", "image", "flux-2-max")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://platform.dataeyes.ai/v1",
                    apiKey: "fixture-secret",
                    apiFormat: "openai",
                    models: ["flux-2-max"],
                    advancedConfig: { protocol: "dataeyes-flux" },
                },
            ],
        });
    });

    it.each(["generations", "edits"])("charges one image for %s even when n and quality are supplied", async (operation) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ url: "https://cdn.example.com/flux.png" }] }));
        const body = operation === "edits" ? new FormData() : JSON.stringify({ model: "flux-2-max", prompt: "test", n: 3, quality: "high" });
        if (body instanceof FormData) {
            body.set("model", "flux-2-max");
            body.set("prompt", "test");
            body.set("n", "3");
            body.set("quality", "high");
            body.set("image", new Blob([pngBytes()], { type: "image/png" }), "reference.png");
        }
        const response = await POST(
            new Request(`http://localhost/api/ai/system/channel-one/v1/images/${operation}`, {
                method: "POST",
                headers: { ...(body instanceof FormData ? {} : { "content-type": "application/json" }), ...systemModelHeaders("flux-2-max", "flux-2-max") },
                body,
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "images", operation] }) },
        );
        expect(response.status).toBe(200);
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "flux-2-max", 1, "image", expect.any(String), expect.any(String));
    });

    it("preserves generic image count and quality billing for other providers", async () => {
        const settings = await mocks.getAuthSettings();
        settings.systemChannels[0].advancedConfig = { protocol: "openai" };
        mocks.getAuthSettings.mockResolvedValue(settings);
        vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ url: "https://cdn.example.com/image.png" }] }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/images/generations", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("flux-2-max", "flux-2-max") },
                body: JSON.stringify({ model: "flux-2-max", prompt: "test", n: 3, quality: "high" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "images", "generations"] }) },
        );
        expect(response.status).toBe(200);
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "flux-2-max", 6, "image", expect.any(String), expect.any(String));
    });
});

describe("Yumeng v2 model-center proxy", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("yumeng-image", "image", "seedream_5.0Pro")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "http://token.myairealm.com/",
                    apiKey: "yumeng-secret",
                    apiFormat: "openai",
                    models: ["seedream_5.0Pro"],
                    advancedConfig: {
                        protocol: "yumeng",
                        modelConfigs: { "seedream_5.0pro": { capability: "image", protocol: "yumeng", createPath: "/kyyReactApiServer/v2/model-center/tasks", queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id" } },
                    },
                },
            ],
        });
    });

    it("keeps the v2 path literal instead of inserting v1", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "yumeng-task", status: "queued" }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/kyyReactApiServer/v2/model-center/tasks", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("yumeng-image", "seedream_5.0Pro") },
                body: JSON.stringify({ model: "seedream_5.0Pro", prompt: "test" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["kyyReactApiServer", "v2", "model-center", "tasks"] }) },
        );

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks");
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer yumeng-secret");
    });

    it("does not duplicate a path prefix already present in the channel Base URL", async () => {
        const settings = await mocks.getAuthSettings();
        mocks.getAuthSettings.mockResolvedValue({
            ...settings,
            systemChannels: settings.systemChannels.map((channel: { baseUrl: string }) => ({ ...channel, baseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer" })),
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "yumeng-task", status: "queued" }));

        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/kyyReactApiServer/v2/model-center/tasks", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("yumeng-image", "seedream_5.0Pro") },
                body: JSON.stringify({ model: "seedream_5.0Pro", prompt: "test" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["kyyReactApiServer", "v2", "model-center", "tasks"] }) },
        );

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks");
    });
});

describe("configured versioned protocol billing", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("seedance-special-video", "video", "sd_2.0_fast_special_720p")],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://provider.example/kyyReactApiServer",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["sd_2.0_fast_special_720p"],
                    advancedConfig: {
                        protocol: "seedance-special",
                        modelConfigs: {
                            "sd_2.0_fast_special_720p": {
                                capability: "video",
                                protocol: "seedance-special",
                                createPath: "/v1/seedance-special/videos",
                                queryPath: "/v1/result/:task_id",
                            },
                        },
                    },
                },
            ],
        });
    });

    it("classifies a configured v1 create path from the trusted model header", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ task_id: "seedance-task", status: "queued" }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/v1/seedance-special/videos", {
                method: "POST",
                headers: { "content-type": "application/json", ...systemModelHeaders("seedance-special-video", "sd_2.0_fast_special_720p") },
                body: JSON.stringify({ content: [{ type: "text", text: "test" }], duration: 5, ratio: "16:9" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["v1", "seedance-special", "videos"] }) },
        );

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://provider.example/kyyReactApiServer/v1/seedance-special/videos");
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "seedance-special-video", 1, "video", expect.any(String), expect.any(String));
    });
});

describe("custom protocol model routing", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [
                {
                    id: "image-tool",
                    name: "图片工具",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "image-binding", channelId: "channel-one", upstreamModel: "engine-one", enabled: true, priority: 1 }],
                },
            ],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://api.example.com/v1",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["engine-one"],
                    advancedConfig: {
                        protocol: "custom",
                        modelConfigs: { "engine-one": { capability: "image", protocol: "custom", createPath: "/jobs/image" } },
                    },
                },
            ],
        });
    });

    it("uses the trusted upstream model header when a custom body has no model field", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ url: "https://cdn.example.com/result.png" }));
        const response = await POST(
            new Request("http://localhost/api/ai/system/channel-one/jobs/image", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-vozeb-pro-logical-model": "image-tool",
                    "x-vozeb-pro-upstream-model": "engine-one",
                },
                body: JSON.stringify({ engine: "engine-one", prompt: "test" }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["jobs", "image"] }) },
        );

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/v1/jobs/image");
        expect(mocks.consumeUserPoints).toHaveBeenCalledWith("user-one", "image-tool", 1, "image", expect.stringMatching(/^system-ai:[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/));
    });
});

describe("system proxy authorization", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.consumeUserPoints.mockReset().mockResolvedValue(undefined);
        mocks.refundUserPoints.mockReset();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("writer", "text", "vendor-text")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "shared-secret", apiFormat: "openai", models: ["vendor-text", "unbound-model"] }],
        });
    });

    it("rejects unknown paths before forwarding or charging", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const response = await POST(chatRequest({ model: "vendor-text" }), { params: Promise.resolve({ channelId: "channel-one", path: ["account", "balance"] }) });

        expect(response.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
    });

    it("rejects models that exist in the channel catalog but have no logical binding", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const response = await POST(chatRequest({ model: "unbound-model", messages: [] }), textContext());

        expect(response.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
    });

    it("rejects unsupported HTTP methods without forwarding or charging", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const response = await PUT(
            new Request("http://localhost/api/ai/system/channel-one/chat/completions", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: "vendor-text" }),
            }),
            textContext(),
        );

        expect(response.status).toBe(405);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
    });
});

function request(url = "https://cdn.example.com/media.png", headers?: HeadersInit) {
    return new Request(`http://localhost/api/ai/system/channel-one/_media?url=${encodeURIComponent(url)}`, { headers });
}

function textContext() {
    return { params: Promise.resolve({ channelId: "channel-one", path: ["chat", "completions"] }) };
}

function chatRequest(body: unknown) {
    return new Request("http://localhost/api/ai/system/channel-one/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function logicalModel(id: string, capability: "text" | "image" | "video" | "audio", upstreamModel: string) {
    return { id, name: id, capability, enabled: true, bindings: [{ id: `${id}-binding`, channelId: "channel-one", upstreamModel, enabled: true, priority: 1 }] };
}

function systemModelHeaders(logicalModelId: string, upstreamModel: string) {
    return { "x-vozeb-pro-logical-model": logicalModelId, "x-vozeb-pro-upstream-model": upstreamModel };
}

function pngBytes() {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
}

function mp4Bytes() {
    return new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
}

function unsafeBody(source: string) {
    const bytes = new TextEncoder().encode(source);
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const repeated = new Uint8Array(8 * 1024);
            for (let offset = 0; offset < repeated.length; offset += bytes.length) repeated.set(bytes.subarray(0, Math.min(bytes.length, repeated.length - offset)), offset);
            controller.enqueue(repeated);
        },
    });
}

describe("system image shadow observation", () => {
    const frozen = { userId: "user-one", requestId: "image-shadow" };
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.consumeUserPoints.mockReset().mockResolvedValue({ cost: 1, remaining: 4, recordId: "fixed-record" });
        mocks.refundUserPoints.mockReset();
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("picture", "image", "vendor-image")],
            systemChannels: [{ id: "channel-one", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-image"] }],
        });
        mocks.beginImageShadow.mockResolvedValue(frozen);
    });
    const invoke = (body: BodyInit, multipart = false, operation = "generations") =>
        POST(
            new Request(`http://local/api/ai/system/channel-one/images/${operation}`, {
                method: "POST",
                headers: { ...(multipart ? {} : { "content-type": "application/json" }), ...systemAiBillingHeaders("picture", "image-business", "vendor-image") },
                body,
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["images", operation] }) },
        );
    it.each(["generations", "edits"])("freezes before sending %s and leaves bytes and fixed billing intact", async (operation) => {
        const raw = JSON.stringify({ data: [{ b64_json: "fixture-image" }], usage: { input_tokens: 1 } });
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            expect(mocks.beginImageShadow).toHaveBeenCalledOnce();
            return new Response(raw, { headers: { "content-type": "application/json" } });
        });
        const body = operation === "edits" ? new FormData() : JSON.stringify({ model: "vendor-image", prompt: "private prompt" });
        if (body instanceof FormData) {
            body.set("model", "vendor-image");
            body.append("image", new Blob(["private image"]), "ref.png");
            body.append("image", new Blob(["second image"]), "ref-2.png");
            body.set("inference_geo", "us");
            body.set("service_tier", "priority");
            body.set("stream", "false");
            body.set("size", "1024x1024");
            body.set("response_format", "url");
        }
        const response = await invoke(body, operation === "edits", operation);
        expect(await response.text()).toBe(raw);
        expect(response.headers.get("x-vozeb-pro-points-record-id")).toBe("fixed-record");
        expect(mocks.beginImageShadow).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", requestId: expect.stringMatching(/^system-ai:/), path: ["v1", "images", operation], modelId: "picture" }));
        if (operation === "edits") expect(mocks.beginImageShadow.mock.calls[0][0].payload).toMatchObject({ inference_geo: "us", service_tier: "priority", stream: "false", size: "1024x1024", response_format: "url" });
        expect(mocks.finishImageShadow).toHaveBeenCalledWith(frozen, { payload: JSON.parse(raw) });
        expect(mocks.beginShadow).not.toHaveBeenCalled();
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
    });
    it.each(["model", "prompt", "n", "response_format"])("rejects ambiguous multipart %s before charging or forwarding", async (key) => {
        const body = new FormData();
        body.set("model", "vendor-image");
        body.append("image", new Blob(["first reference"]), "first.png");
        body.append("image", new Blob(["second reference"]), "second.png");
        body.append(key, key === "model" ? "vendor-image" : "1");
        body.append(key, key === "model" ? "different-model" : "2");
        const fetchMock = vi.spyOn(globalThis, "fetch");

        expect((await invoke(body, true, "edits")).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.consumeUserPoints).not.toHaveBeenCalled();
        expect(mocks.beginImageShadow).not.toHaveBeenCalled();
    });
    it("records each forwarded reference dimension privately without blocking an unreadable image", async () => {
        const first = await sharp({ create: { width: 3, height: 5, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        const second = await sharp({ create: { width: 7, height: 2, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const body = new FormData();
        body.set("model", "vendor-image");
        body.append("image", new Blob([new Uint8Array(first)], { type: "image/png" }), "private-first.png");
        body.append("image", new Blob(["unreadable"], { type: "image/png" }), "private-broken.png");
        body.append("image", new Blob([new Uint8Array(second)], { type: "image/png" }), "private-second.png");
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
            const forwarded = init?.body as FormData;
            expect(forwarded.getAll("image")).toHaveLength(3);
            return new Response(JSON.stringify({ data: [{ url: "https://example.com/result.png" }] }), { headers: { "content-type": "application/json" } });
        });

        expect((await invoke(body, true, "edits")).status).toBe(200);
        const snapshot = mocks.beginImageShadow.mock.calls[0][0];
        expect(snapshot.referenceImages).toEqual([{ width: 3, height: 5 }, null, { width: 7, height: 2 }]);
        expect(JSON.stringify(snapshot)).not.toContain("private-");
        expect(mocks.consumeUserPoints).toHaveBeenCalledOnce();
    });
    it("does not classify a custom channel as native Images just because its path matches", async () => {
        const settings = await mocks.getAuthSettings();
        settings.systemChannels[0].advancedConfig = { protocol: "custom", createPath: "/images/generations" };
        mocks.getAuthSettings.mockResolvedValue(settings);
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
        await invoke(JSON.stringify({ model: "vendor-image" }));
        expect(mocks.beginImageShadow).toHaveBeenCalledWith(expect.objectContaining({ adapted: true, path: ["v1", "images", "generations"] }));
    });
    it("keeps unsupported responses unpriced and records transport failures without changing existing refunds", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("data: image-event\n\n", { headers: { "content-type": "text/event-stream" } }));
        expect(await (await invoke(JSON.stringify({ model: "vendor-image", stream: true }))).text()).toContain("image-event");
        expect(mocks.finishImageShadow).toHaveBeenLastCalledWith(frozen, { unavailable: "该流式或非 JSON 响应格式的用量观察尚未接入" });
        vi.mocked(fetch).mockResolvedValueOnce(new Response("broken-json", { headers: { "content-type": "application/json" } }));
        expect(await (await invoke(JSON.stringify({ model: "vendor-image" }))).text()).toBe("broken-json");
        expect(mocks.finishImageShadow).toHaveBeenLastCalledWith(frozen, { unavailable: "上游响应不是有效 JSON" });
        vi.mocked(fetch).mockRejectedValueOnce(new Error("fixture connection failure"));
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect((await invoke(JSON.stringify({ model: "vendor-image" }))).status).toBe(502);
        expect(mocks.finishImageShadow).toHaveBeenLastCalledWith(frozen, { failure: "上游连接失败，未取得完整响应" });
        expect(mocks.refundUserPoints).toHaveBeenCalledOnce();
    });
    it("does not turn observation storage failures into paid generation retries", async () => {
        const raw = JSON.stringify({ data: [{ b64_json: "image" }] });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(raw, { headers: { "content-type": "application/json" } }));
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.finishImageShadow.mockRejectedValue(new Error("private storage detail"));
        expect(await (await invoke(JSON.stringify({ model: "vendor-image" }))).text()).toBe(raw);
        expect(fetch).toHaveBeenCalledOnce();
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
        expect(JSON.stringify(errors.mock.calls)).not.toContain("private storage detail");
    });
});

describe("system audio shadow observation", () => {
    const model = "gemini-3.1-flash-tts-preview";
    const frozen = { kind: "audio", userId: "user-one", requestId: "audio-shadow" };
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.safeUrl.mockResolvedValue(true);
        mocks.consumeUserPoints.mockReset().mockResolvedValue({ cost: 0.25, remaining: 4.75, recordId: "fixed-audio-record" });
        mocks.refundUserPoints.mockReset();
        mocks.getAuthSettings.mockResolvedValue({
            generationPointMultipliers: {},
            logicalModels: [logicalModel("voice", "audio", model)],
            systemChannels: [
                {
                    id: "channel-one",
                    enabled: true,
                    baseUrl: "https://fixture.example.com/v1beta",
                    apiKey: "secret",
                    apiFormat: "gemini",
                    models: [model],
                    advancedConfig: { protocol: "gemini", modelConfigs: { [model]: { capability: "audio", protocol: "gemini", apiFormat: "gemini", createPath: "/models/:model:generateContent" } } },
                },
            ],
        });
        mocks.beginAudioShadow.mockResolvedValue(frozen);
    });
    const invoke = () =>
        POST(
            new Request(`http://local/api/ai/system/channel-one/models/${model}:generateContent`, {
                method: "POST",
                headers: { "content-type": "application/json", ...systemAiBillingHeaders("voice", "audio-business", model) },
                body: JSON.stringify({ contents: [{ parts: [{ text: "private prompt" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
            }),
            { params: Promise.resolve({ channelId: "channel-one", path: ["models", `${model}:generateContent`] }) },
        );
    it("freezes before submission and preserves response bytes and normal fixed charge", async () => {
        const raw = '{ "candidates": [], "usageMetadata": { "promptTokenCount": 8 } }';
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            expect(mocks.beginAudioShadow).toHaveBeenCalledOnce();
            return new Response(raw, { headers: { "content-type": "application/json" } });
        });
        const response = await invoke();
        expect(await response.text()).toBe(raw);
        expect(response.headers.get("x-vozeb-pro-points-record-id")).toBe("fixed-audio-record");
        expect(mocks.beginAudioShadow).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "user-one", requestId: expect.stringMatching(/^system-ai:/), requestFingerprint: expect.any(String), path: ["v1beta", "models", `${model}:generateContent`], modelId: "voice", declaredProtocol: "gemini" }),
        );
        expect(mocks.finishAudioShadow).toHaveBeenCalledWith(frozen, { payload: JSON.parse(raw) });
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
        expect(mocks.beginShadow).not.toHaveBeenCalled();
    });
    it("isolates diagnostic persistence failures without retries or refunds", async () => {
        const raw = '{"candidates": []}';
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(raw, { headers: { "content-type": "application/json" } }));
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        mocks.finishAudioShadow.mockRejectedValue(new Error("PRIVATE_FAILURE"));
        expect(await (await invoke()).text()).toBe(raw);
        expect(fetch).toHaveBeenCalledOnce();
        expect(mocks.refundUserPoints).not.toHaveBeenCalled();
        expect(JSON.stringify(errors.mock.calls)).not.toContain("PRIVATE_FAILURE");
    });
    it("records invalid JSON, unsupported streams and transport failures without changing their outcomes", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("broken", { headers: { "content-type": "application/json" } }));
        expect(await (await invoke()).text()).toBe("broken");
        expect(mocks.finishAudioShadow).toHaveBeenLastCalledWith(frozen, { unavailable: "上游响应不是有效 JSON" });
        vi.mocked(fetch).mockResolvedValueOnce(new Response("data: audio\n\n", { headers: { "content-type": "text/event-stream" } }));
        expect(await (await invoke()).text()).toContain("audio");
        expect(mocks.finishAudioShadow).toHaveBeenLastCalledWith(frozen, { unavailable: "该流式或非 JSON 响应格式的用量观察尚未接入" });
        vi.mocked(fetch).mockRejectedValueOnce(new Error("PRIVATE_NETWORK"));
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect((await invoke()).status).toBe(502);
        expect(mocks.refundUserPoints).toHaveBeenCalledOnce();
        expect(mocks.finishAudioShadow).toHaveBeenLastCalledWith(frozen, { failure: "上游连接失败，未取得完整响应" });
    });
});
