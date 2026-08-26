import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    getAuthSettings: vi.fn(),
    getStoredGenerationTaskByRequest: vi.fn(),
    generationCapacityRetryAfterSeconds: vi.fn(),
    rate: vi.fn(),
    withGenerationConcurrencyLimit: vi.fn(),
    createImageTask: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: mocks.after };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user-one", role: "user" })) }));
vi.mock("@/lib/auth/store", () => ({
    getAuthSettings: mocks.getAuthSettings,
    isAuthInputError: vi.fn(() => false),
    refundUserPoints: vi.fn(),
}));
vi.mock("@/lib/server/generation-task-store", () => ({
    generationCapacityRetryAfterSeconds: mocks.generationCapacityRetryAfterSeconds,
    getStoredGenerationTaskByRequest: mocks.getStoredGenerationTaskByRequest,
    linkStoredGenerationTask: vi.fn(),
    withGenerationConcurrencyLimit: mocks.withGenerationConcurrencyLimit,
}));
vi.mock("@/lib/server/security", () => ({
    checkGenerationRateLimit: mocks.rate,
    rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: vi.fn() }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: vi.fn() }));
vi.mock("@/lib/server/image-task-store", () => ({
    createImageTask: mocks.createImageTask,
    getImageTask: vi.fn(),
    touchImageTask: vi.fn(),
    transitionImageTask: vi.fn(),
    updateImageTask: vi.fn(),
}));

import { maxDuration, POST } from "./route";
import { createCanvasImageLayerGrant } from "@/lib/server/canvas-image-layer-grant";

describe("image task route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getStoredGenerationTaskByRequest.mockResolvedValue(null);
        mocks.rate.mockResolvedValue({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 });
        mocks.getAuthSettings.mockResolvedValue({ generationConcurrency: { image: 1 } });
    });

    it("keeps background image submission alive past the five minute route default", () => {
        expect(maxDuration).toBeGreaterThanOrEqual(40 * 60);
    });

    it("returns the existing task before settings, rate, and concurrency checks", async () => {
        mocks.getStoredGenerationTaskByRequest.mockResolvedValue({
            id: "existing-image-task",
            kind: "generation",
            status: "running",
            config: { model: "image-upstream", logicalModel: "image-logical" },
        });

        const response = await POST(
            new Request("http://localhost/api/image-tasks", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-VOZEB-PRO-Client-Request-Id": "image-workbench:conversation:slot",
                    "X-VOZEB-PRO-Attempt-No": "3",
                },
                body: JSON.stringify({ prompt: "same request", context: { clientRequestId: "image-workbench:conversation:slot", attemptNo: 3 } }),
            }),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ task: { id: "existing-image-task", status: "running", model: "image-logical" } });
        expect(mocks.getStoredGenerationTaskByRequest).toHaveBeenCalledWith("image", "user-one", "image-workbench:conversation:slot", 3);
        expect(mocks.getAuthSettings).not.toHaveBeenCalled();
        expect(mocks.rate).not.toHaveBeenCalled();
        expect(mocks.withGenerationConcurrencyLimit).not.toHaveBeenCalled();
    });

    it("returns the active task scheduler retry time when image capacity is full", async () => {
        mocks.withGenerationConcurrencyLimit.mockResolvedValue(null);
        mocks.generationCapacityRetryAfterSeconds.mockResolvedValue(8);

        const response = await POST(
            new Request("http://localhost/api/image-tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: "new image" }),
            }),
        );

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("8");
        expect(mocks.generationCapacityRetryAfterSeconds).toHaveBeenCalledWith("user-one", "image", 10 * 60 * 1000);
    });

    it("keeps ordinary image creation behind the configured concurrency limit", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(imageSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "ordinary-image", status: "pending" }));

        const response = await POST(imageRequest({ config: { model: "image" }, prompt: "普通图片" }));

        expect(response.status).toBe(200);
        expect(mocks.withGenerationConcurrencyLimit).toHaveBeenCalledOnce();
    });

    it("lets a verified Canvas layer task bypass ordinary image capacity and persists its class", async () => {
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "22".repeat(32));
        const source = "/api/reference-assets/source.png";
        const grant = createCanvasImageLayerGrant({
            userId: "user-one",
            requestId: "decomposition-one",
            source,
            decomposition: {
                strategy: "ecommerce",
                width: 1200,
                height: 800,
                backgroundDescription: "白色背景",
                backgroundPreservedVisuals: [],
                layers: [{ id: "product", name: "商品", kind: "product", bbox: { x: 100, y: 80, width: 700, height: 620 }, zIndex: 1 }],
            },
        });
        mocks.getAuthSettings.mockResolvedValue(imageSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "layer-image", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "image", outputBackground: "transparent" },
                prompt: "提取商品",
                references: [{ serverUrl: source }],
                source: "canvas",
                context: { surface: "canvas" },
                layerBatch: { grant, slotId: "layer:product" },
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.withGenerationConcurrencyLimit).not.toHaveBeenCalled();
        expect(mocks.createImageTask).toHaveBeenCalledWith(
            expect.objectContaining({
                concurrencyClass: "canvas-layer",
                clientRequestId: expect.stringMatching(/^canvas-layer:/),
                references: [expect.objectContaining({ serverUrl: source })],
            }),
        );
    });

    it("does not let a forged Canvas layer batch bypass image capacity", async () => {
        mocks.getAuthSettings.mockResolvedValue(imageSettings());

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "image", outputBackground: "transparent" },
                prompt: "提取商品",
                references: [{ serverUrl: "/api/reference-assets/source.png" }],
                source: "canvas",
                context: { surface: "canvas" },
                layerBatch: { grant: "invalid.grant", slotId: "layer:product" },
            }),
        );

        expect(response.status).toBe(400);
        expect(mocks.withGenerationConcurrencyLimit).not.toHaveBeenCalled();
        expect(mocks.createImageTask).not.toHaveBeenCalled();
    });

    it("rejects unsupported ratio and resolution before creating an image task", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue({
            generationConcurrency: { image: 1 },
            generationDefaults: { imageSize: "1:1", imageQuality: "low" },
            systemChannels: [{ id: "image-channel", name: "图片", enabled: true, baseUrl: "https://image.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["upstream-image"] }],
            logicalModels: [
                {
                    id: "image",
                    name: "图片",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "binding", channelId: "image-channel", upstreamModel: "upstream-image", enabled: true, priority: 1, capabilityProfile: { aspectRatios: ["9:16"], resolutions: ["2K"] } }],
                },
            ],
            defaultModels: { imageModel: "image" },
        });

        const response = await POST(
            new Request("http://localhost/api/image-tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config: { model: "image", size: "1:1", quality: "low" }, prompt: "竖版海报" }),
            }),
        );

        expect(response.status).toBe(400);
        expect(mocks.createImageTask).not.toHaveBeenCalled();
    });

    it("accepts intelligent ratio and quality without replacing them with fixed model options", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue({
            generationConcurrency: { image: 1 },
            generationDefaults: { imageSize: "1:1", imageQuality: "low" },
            systemChannels: [{ id: "image-channel", name: "图片", enabled: true, baseUrl: "https://image.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["upstream-image"] }],
            logicalModels: [
                {
                    id: "image",
                    name: "图片",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "binding", channelId: "image-channel", upstreamModel: "upstream-image", enabled: true, priority: 1, capabilityProfile: { aspectRatios: ["9:16"], resolutions: ["2K"] } }],
                },
            ],
            defaultModels: { imageModel: "image" },
        });
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "image-task", status: "pending" }));

        const response = await POST(
            new Request("http://localhost/api/image-tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ config: { model: "image", size: "auto", quality: "auto" }, prompt: "智能构图" }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ size: "auto", quality: "auto" }) }));
    });

    it("rejects a layer task before upstream submission when it has no unique edit source", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue({
            generationConcurrency: { image: 1 },
            generationDefaults: { imageSize: "auto", imageQuality: "auto" },
            systemChannels: [{ id: "image-channel", name: "图片", enabled: true, baseUrl: "https://image.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["upstream-image"] }],
            logicalModels: [
                {
                    id: "image",
                    name: "图片",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "binding", channelId: "image-channel", upstreamModel: "upstream-image", enabled: true, priority: 1 }],
                },
            ],
            defaultModels: { imageModel: "image" },
        });

        const response = await POST(
            new Request("http://localhost/api/image-tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "generation", config: { model: "image", outputMode: "layers" }, prompt: "电商分层" }),
            }),
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "电商分层需要且只能使用一张源图" });
        expect(mocks.createImageTask).not.toHaveBeenCalled();
    });
});

function imageRequest(body: unknown) {
    return new Request("http://localhost/api/image-tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function imageSettings() {
    return {
        generationConcurrency: { image: 1 },
        generationDefaults: { imageSize: "auto", imageQuality: "auto" },
        systemChannels: [{ id: "image-channel", name: "图片", enabled: true, baseUrl: "https://image.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["upstream-image"] }],
        logicalModels: [
            {
                id: "image",
                name: "图片",
                capability: "image",
                enabled: true,
                bindings: [{ id: "binding", channelId: "image-channel", upstreamModel: "upstream-image", enabled: true, priority: 1 }],
            },
        ],
        defaultModels: { imageModel: "image" },
    };
}
