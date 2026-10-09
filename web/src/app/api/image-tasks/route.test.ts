import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { buildSceneEditProtection } from "@/lib/server/ecommerce-product-regions";
import { EcommerceReferenceDispatchConflict } from "@/lib/server/ecommerce-reference-dispatch";

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    getAuthSettings: vi.fn(),
    getStoredGenerationTaskByRequest: vi.fn(),
    generationCapacityRetryAfterSeconds: vi.fn(),
    rate: vi.fn(),
    withGenerationConcurrencyLimit: vi.fn(),
    createImageTask: vi.fn(),
    linkStoredGenerationTask: vi.fn(),
    scheduleGenerationTask: vi.fn(),
    getAgentRun: vi.fn(),
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
    linkStoredGenerationTask: mocks.linkStoredGenerationTask,
    withGenerationConcurrencyLimit: mocks.withGenerationConcurrencyLimit,
}));
vi.mock("@/lib/server/security", () => ({
    checkGenerationRateLimit: mocks.rate,
    rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: vi.fn() }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/image-task-store", () => ({
    createImageTask: mocks.createImageTask,
    getImageTask: vi.fn(),
    touchImageTask: vi.fn(),
    transitionImageTask: vi.fn(),
    updateImageTask: vi.fn(),
}));
vi.mock("@/lib/server/agent-run-store", () => ({ getAgentRun: mocks.getAgentRun }));

import { maxDuration, POST } from "./route";
import { createCanvasImageLayerGrant } from "@/lib/server/canvas-image-layer-grant";

describe("image task route", () => {
    it.each(["valid", "invalid_mapping"])("checks v4 product execution through the actual Route (%s)", async (condition) => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "v4-product", status: "pending" }));
        const execution = {
            ...ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"),
            compilerVersion: "ecommerce-openai-image-2.5.v4",
            referenceMapping: [{ assetId: "product-asset", userAlias: "图片1", providerIndex: condition === "valid" ? 0 : 1, purposes: ["edit_target", "product_identity"] }],
        };
        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "product-image" },
                prompt: execution.prompt,
                references: [{ id: "product-asset", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800, ecommerceRole: "product" }],
                productProtectionRegions: trustedProductProtectionRegions(),
                ecommerceExecution: execution,
            }),
        );
        expect(response.status).toBe(condition === "valid" ? 200 : 400);
        if (condition === "valid") expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ ecommerceExecution: execution, candidateConfigs: [] }));
        else expect(mocks.createImageTask).not.toHaveBeenCalled();
    });
    it.each(["valid", "invalid"])("validates %s photography through the actual image creation route", async (state) => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "photography-ready", status: "pending" }));
        const photography = {
            materials: [{ objectId: "cabinet", textureDirection: "沿原图木纹方向", textureScale: "细木纹", roughness: "哑光", gloss: "低光泽" }],
            lighting: { keyLight: state === "valid" ? "左侧柔光" : "", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "接触阴影" },
            composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
        };
        const execution = { ...ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"), compilerVersion: "ecommerce-openai-image-2.5.v3", photography };
        const response = await POST(
            imageRequest({ kind: "edit", config: { model: "product-image" }, prompt: execution.prompt, references: [{ id: "product-asset", dataUrl: "data:image/png;base64,AA==", ecommerceRole: "product" }], ecommerceExecution: execution }),
        );
        expect(response.status).toBe(state === "valid" ? 200 : 400);
        if (state === "valid") expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ ecommerceExecution: execution, candidateConfigs: [] }));
        else expect(mocks.createImageTask).not.toHaveBeenCalled();
    });
    it("pauses a local scene request without trusted selection instead of silently submitting it", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "scene-review", status: "pending" }));
        const execution = {
            ...ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"),
            compilerVersion: "ecommerce-openai-image-2.5.v2",
            referenceRoles: [{ assetId: "scene", role: "scene" }],
            protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
            mask: { mode: "independent", required: true },
        };
        const response = await POST(
            imageRequest({ kind: "edit", prompt: "compiled ecommerce prompt", config: { model: "product-image" }, references: [{ id: "scene", dataUrl: "data:image/png;base64,AA==", ecommerceRole: "scene" }], ecommerceExecution: execution }),
        );
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ task: { needsReview: true, executionPhase: "needs_review" }, warning: expect.stringContaining("确认") });
        expect(mocks.after).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getStoredGenerationTaskByRequest.mockResolvedValue(null);
        mocks.rate.mockResolvedValue({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 });
        mocks.getAuthSettings.mockResolvedValue({ generationConcurrency: { image: 1 } });
    });

    it("rejects client-forged local protection that is not bound to the immutable run task", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        const response = await POST(imageRequest({ kind: "edit", prompt: "compiled ecommerce prompt", config: { model: "product-image" }, sceneProtection: { selectionSource: "user_selection", sourceAssetId: "scene" } }));
        expect(response.status).toBe(409);
        expect(mocks.createImageTask).not.toHaveBeenCalled();
    });
    it.each([false, true])("creates a local scene only from its confirmed Run, attempt and copy snapshot (v4 auxiliary=%s)", async (withStyle) => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "scene-ready", status: "pending" }));
        const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const sceneProtection = await buildSceneEditProtection(bytes, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase and shadow"], "user_selection");
        const execution = {
            ...ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"),
            compilerVersion: withStyle ? "ecommerce-openai-image-2.5.v4" : "ecommerce-openai-image-2.5.v2",
            referenceRoles: [{ assetId: "scene", role: "scene" }, ...(withStyle ? [{ assetId: "style", role: "scene" }] : [])],
            ...(withStyle
                ? {
                      referenceMapping: [
                          { assetId: "scene", userAlias: "图片2", providerIndex: 0, purposes: ["edit_target"] },
                          { assetId: "style", userAlias: "图片1", providerIndex: 1, purposes: ["style"] },
                      ],
                  }
                : {}),
            canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
            protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
            mask: { mode: "independent", required: true },
        };
        mocks.getAgentRun.mockResolvedValue({
            id: "run",
            userId: "user-one",
            conversationId: "conversation",
            status: "running",
            clientRequestId: "request",
            tasks: [{ id: "scene-task", status: "running", attempts: 1, count: 1, sceneProtection, ecommerceExecution: execution }],
        });
        const body = {
            kind: "edit",
            prompt: "compiled ecommerce prompt",
            config: { model: "product-image" },
            references: [
                { id: "scene", dataUrl: "data:image/png;base64," + bytes.toString("base64"), width: 6, height: 4, ecommerceRole: "scene" },
                ...(withStyle ? [{ id: "style", dataUrl: "data:image/png;base64," + bytes.toString("base64"), ecommerceRole: "scene" }] : []),
            ],
            sceneProtection,
            ecommerceExecution: execution,
            context: { runId: "run", parentTaskId: "scene-task", conversationId: "conversation", attemptNo: 1, clientRequestId: "request:scene-task:1:1" },
        };
        expect((await POST(imageRequest(body))).status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ mask: sceneProtection.mask, sceneProtection, ecommerceExecution: execution, candidateConfigs: [] }));
        mocks.createImageTask.mockClear();
        expect((await POST(imageRequest({ ...body, context: { ...body.context, clientRequestId: "request:scene-task:1:2" } }))).status).toBe(409);
        expect(mocks.createImageTask).not.toHaveBeenCalled();
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

    it("returns 409 for a stale reference dispatch without linking or scheduling a child", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(imageSettings());
        mocks.createImageTask.mockRejectedValue(new EcommerceReferenceDispatchConflict());
        const response = await POST(imageRequest({ config: { model: "image" }, prompt: "参考恢复" }));
        expect(response.status).toBe(409);
        expect(mocks.linkStoredGenerationTask).not.toHaveBeenCalled();
        expect(mocks.scheduleGenerationTask).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
    });

    it("returns durable insertion replay with its original execution phase without scheduling it again", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(imageSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "original-child", status: "pending", executionPhase: "needs_review", reviewReason: "original review" }));
        const response = await POST(imageRequest({ config: { model: "image" }, prompt: "参考恢复" }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ task: { id: "original-child", executionPhase: "needs_review", needsReview: true, reviewReason: "original review" } });
        expect(mocks.linkStoredGenerationTask).not.toHaveBeenCalled();
        expect(mocks.scheduleGenerationTask).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
    });

    it("accepts reference images for a native Gemini custom route", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue({
            generationConcurrency: { image: 1 },
            generationDefaults: { imageSize: "1:1", imageQuality: "high" },
            systemChannels: [
                {
                    id: "gcli-channel",
                    name: "gcli2api",
                    enabled: true,
                    baseUrl: "https://gcli.example/antigravity",
                    apiKey: "secret",
                    apiFormat: "openai",
                    models: ["gemini-3.1-flash-image"],
                    advancedConfig: {
                        protocol: "custom",
                        supportsReferenceImage: true,
                        modelConfigs: {
                            "gemini-3.1-flash-image": {
                                capability: "image",
                                protocol: "custom",
                                apiFormat: "gemini",
                                createPath: "/v1/models/gemini-3.1-flash-image:generateContent",
                                editPath: "/v1/models/gemini-3.1-flash-image:generateContent",
                                requestTemplate: '{"contents":[{"role":"user","parts":[{"text":"{{prompt}}"}]}],"size":"{{size}}"}',
                                resultField: "candidates[0].content.parts[0].inlineData",
                                supportsReferenceImage: false,
                            },
                        },
                    },
                },
            ],
            logicalModels: [
                {
                    id: "gemini-image",
                    name: "Gemini image",
                    capability: "image",
                    enabled: true,
                    bindings: [{ id: "binding", channelId: "gcli-channel", upstreamModel: "gemini-3.1-flash-image", enabled: true, priority: 1 }],
                },
            ],
            defaultModels: { imageModel: "gemini-image" },
        });
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "gemini-edit", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "gemini-image", size: "16:9", quality: "high" },
                prompt: "改成黑白色",
                references: [{ name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }],
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledOnce();
    });

    it("keeps strict-product edits in review when the provider lacks a trustworthy independent mask", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(geminiImageSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "strict-review", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "gemini-image" },
                prompt: "把白底商品放进现代客厅",
                references: [
                    {
                        id: "product-asset",
                        name: "product.png",
                        type: "image/png",
                        dataUrl: "data:image/png;base64,AA==",
                        width: 1000,
                        height: 800,
                    },
                ],
                productProtectionRegions: trustedProductProtectionRegions(),
            }),
        );

        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
            task: { id: "strict-review", needsReview: true, executionPhase: "needs_review" },
            warning: expect.stringMatching(/不支持可信独立蒙版/),
        });
        expect(mocks.createImageTask).toHaveBeenCalledWith(
            expect.objectContaining({
                mask: undefined,
                productProtection: expect.objectContaining({ state: "needs_review", productAnchorId: "product-asset" }),
            }),
        );
        expect(mocks.after).not.toHaveBeenCalled();
    });

    it("selects an independent-mask provider and disables candidate fallback for strict-product edits", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(strictProviderFallbackSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "strict-ready", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "strict-image" },
                prompt: "把白底商品放进现代客厅",
                references: [
                    {
                        id: "product-asset",
                        name: "product.png",
                        type: "image/png",
                        dataUrl: "data:image/png;base64,AA==",
                        width: 1000,
                        height: 800,
                    },
                ],
                productProtectionRegions: trustedProductProtectionRegions(),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(
            expect.objectContaining({
                config: expect.objectContaining({ apiFormat: "openai", model: "openai-image-upstream" }),
                candidateConfigs: [],
                mask: expect.objectContaining({ id: "background-mask" }),
                productProtection: expect.objectContaining({ state: "ready", productAnchorId: "product-asset" }),
            }),
        );
        expect(mocks.after).toHaveBeenCalledOnce();
    });

    it("replays the exact ecommerce generation snapshot instead of a newly preferred image binding", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "snapshot-ready", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "product-image" },
                prompt: "compiled ecommerce prompt",
                references: [{ id: "product-asset", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800, ecommerceRole: "product" }],
                productProtectionRegions: trustedProductProtectionRegions(),
                ecommerceExecution: ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(
            expect.objectContaining({
                config: expect.objectContaining({ channelId: "flare-channel", model: "gpt-image-2.5-flare" }),
                candidateConfigs: [],
                ecommerceExecution: ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"),
            }),
        );
    });

    it("keeps the deterministic ecommerce canvas ahead of masked source ratio inheritance", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "canvas-ready", status: "pending" }));
        const execution = {
            ...ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"),
            canvas: { mode: "exact", size: { width: 3840, height: 2160 }, source: "user_text", allowReframe: false },
            parameters: { variant: "gpt-image-2.5-flare", size: "3840x2160" },
        };
        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "product-image", size: "3840x2160" },
                prompt: execution.prompt,
                references: [{ id: "product-asset", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800, ecommerceRole: "product" }],
                productProtectionRegions: trustedProductProtectionRegions(),
                ecommerceExecution: execution,
            }),
        );
        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ size: "3840x2160" }), ecommerceExecution: execution }));
    });

    it.each([
        { width: 3840, height: 2160, ratio: "16:9" },
        { width: 1000, height: 1000, ratio: "1:1" },
    ])("creates baseline $width x $height against the real $ratio capability profile", async ({ width, height, ratio }) => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        const settings = ecommerceSnapshotSettings();
        const logical = { ...settings.logicalModels[0], bindings: settings.logicalModels[0].bindings.map((binding) => ({ ...binding, capabilityProfile: { aspectRatios: [ratio] } })) };
        mocks.getAuthSettings.mockResolvedValue({ ...settings, logicalModels: [logical] });
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "ratio-image", status: "pending" }));
        const execution = { ...ecommerceExecutionSnapshot("flare-channel", "gpt-image-2.5-flare"), canvas: { mode: "ratio", size: { width, height }, source: "baseline", allowReframe: true } };
        const response = await POST(
            imageRequest({ kind: "edit", prompt: "compiled ecommerce prompt", config: { model: "product-image" }, references: [{ id: "product-asset", dataUrl: "data:image/png;base64,AA==", ecommerceRole: "product" }], ecommerceExecution: execution }),
        );
        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ size: ratio }) }));
    });

    it("fails closed when an ecommerce generation snapshot can no longer be resolved", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(ecommerceSnapshotSettings());

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "product-image" },
                prompt: "compiled ecommerce prompt",
                references: [{ id: "product-asset", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800, ecommerceRole: "product" }],
                productProtectionRegions: trustedProductProtectionRegions(),
                ecommerceExecution: ecommerceExecutionSnapshot("removed-channel", "gpt-image-2.5-flare"),
            }),
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "电商生图执行快照已失效，请重新发起任务" });
        expect(mocks.createImageTask).not.toHaveBeenCalled();
    });

    it("applies a local-edit mask to the current scene source instead of the original product anchor", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(strictProviderFallbackSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "local-edit-ready", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "strict-image" },
                prompt: "把背景换成厨房",
                references: [
                    { id: "scene-result", name: "scene.png", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1000, height: 800 },
                    { id: "product-asset", name: "product.png", type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 400, height: 400 },
                ],
                productProtectionRegions: trustedProductProtectionRegions("scene-result"),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(
            expect.objectContaining({
                mask: expect.objectContaining({ id: "background-mask" }),
                productProtection: expect.objectContaining({ state: "ready", productAnchorId: "product-asset", sourceAssetId: "scene-result" }),
            }),
        );
    });

    it("uses the source image ratio for masked edits while keeping the requested quality", async () => {
        mocks.withGenerationConcurrencyLimit.mockImplementation(async (_userId, _type, _staleMs, _limit, handler) => handler());
        mocks.getAuthSettings.mockResolvedValue(imageSettings());
        mocks.createImageTask.mockImplementation(async (input) => ({ ...input, id: "masked-edit", status: "pending" }));

        const response = await POST(
            imageRequest({
                kind: "edit",
                config: { model: "image", size: "16:9", quality: "high" },
                prompt: "在选中区域放置一盆绿植",
                references: [{ type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1692, height: 3008 }],
                mask: { type: "image/png", dataUrl: "data:image/png;base64,AA==", width: 1600, height: 2844 },
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ size: "9:16", quality: "high" }) }));
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

function geminiImageSettings() {
    return {
        generationConcurrency: { image: 1 },
        generationDefaults: { imageSize: "auto", imageQuality: "auto" },
        systemChannels: [
            {
                id: "gemini-channel",
                name: "Gemini image",
                enabled: true,
                baseUrl: "https://gemini.example/v1beta",
                apiKey: "secret",
                apiFormat: "gemini",
                models: ["gemini-image-upstream"],
                advancedConfig: { supportsReferenceImage: true },
            },
        ],
        logicalModels: [
            {
                id: "gemini-image",
                name: "Gemini image",
                capability: "image",
                enabled: true,
                bindings: [{ id: "binding", channelId: "gemini-channel", upstreamModel: "gemini-image-upstream", enabled: true, priority: 1 }],
            },
        ],
        defaultModels: { imageModel: "gemini-image" },
    };
}

function trustedProductProtectionRegions(sourceAssetId = "product-asset") {
    return {
        productAnchorId: "product-asset",
        sourceAssetId,
        sourceSize: { width: 1000, height: 800 },
        productCore: {
            width: 1000,
            height: 800,
            rectangles: [{ x: 300, y: 160, width: 400, height: 480 }],
        },
        fusionHalo: {
            width: 1000,
            height: 800,
            rectangles: [
                { x: 250, y: 120, width: 500, height: 40 },
                { x: 250, y: 160, width: 50, height: 480 },
                { x: 700, y: 160, width: 50, height: 480 },
                { x: 250, y: 640, width: 500, height: 40 },
            ],
        },
        editableBackground: {
            width: 1000,
            height: 800,
            rectangles: [
                { x: 0, y: 0, width: 1000, height: 120 },
                { x: 0, y: 120, width: 250, height: 560 },
                { x: 750, y: 120, width: 250, height: 560 },
                { x: 0, y: 680, width: 1000, height: 120 },
            ],
            mask: {
                trust: "trusted",
                provider: "subject-segmentation",
                reference: {
                    id: "background-mask",
                    name: "editable-background.png",
                    type: "image/png",
                    dataUrl: "data:image/png;base64,AA==",
                    width: 1000,
                    height: 800,
                },
            },
        },
    };
}

function strictProviderFallbackSettings() {
    const gemini = geminiImageSettings();
    return {
        ...gemini,
        systemChannels: [
            ...gemini.systemChannels,
            {
                id: "openai-channel",
                name: "OpenAI image",
                enabled: true,
                baseUrl: "https://openai.example/v1",
                apiKey: "secret",
                apiFormat: "openai",
                models: ["openai-image-upstream"],
                advancedConfig: { supportsReferenceImage: true },
            },
        ],
        logicalModels: [
            {
                id: "strict-image",
                name: "Strict image",
                capability: "image",
                enabled: true,
                bindings: [
                    {
                        id: "gemini-binding",
                        channelId: "gemini-channel",
                        upstreamModel: "gemini-image-upstream",
                        enabled: true,
                        priority: 1,
                    },
                    {
                        id: "openai-binding",
                        channelId: "openai-channel",
                        upstreamModel: "openai-image-upstream",
                        enabled: true,
                        priority: 2,
                    },
                ],
            },
        ],
        defaultModels: { imageModel: "strict-image" },
    };
}

function ecommerceSnapshotSettings() {
    return {
        generationConcurrency: { image: 1 },
        generationDefaults: { imageSize: "auto", imageQuality: "auto" },
        systemChannels: [
            { id: "sunburst-channel", name: "Sunburst", enabled: true, baseUrl: "https://sunburst.example/v1", apiKey: "secret", apiFormat: "openai", models: ["gpt-image-2.5-sunburst"], advancedConfig: { supportsReferenceImage: true } },
            { id: "flare-channel", name: "Flare", enabled: true, baseUrl: "https://flare.example/v1", apiKey: "secret", apiFormat: "openai", models: ["gpt-image-2.5-flare"], advancedConfig: { supportsReferenceImage: true } },
        ],
        logicalModels: [
            {
                id: "product-image",
                name: "Product image",
                capability: "image",
                enabled: true,
                bindings: [
                    { id: "sunburst-binding", channelId: "sunburst-channel", upstreamModel: "gpt-image-2.5-sunburst", enabled: true, priority: 1 },
                    { id: "flare-binding", channelId: "flare-channel", upstreamModel: "gpt-image-2.5-flare", enabled: true, priority: 2 },
                ],
            },
        ],
        defaultModels: { imageModel: "product-image" },
    };
}

function ecommerceExecutionSnapshot(channelId: string, upstreamModel: string) {
    return {
        state: "ready",
        compilerVersion: "ecommerce-openai-image-2.5.v1",
        providerProfileId: "gpt-image-2.5-flare",
        prompt: "compiled ecommerce prompt",
        referenceRoles: [{ assetId: "product-asset", role: "product" }],
        mask: { mode: "independent", required: true },
        parameters: { variant: "gpt-image-2.5-flare" },
        modelSnapshot: {
            logicalRole: "image_generation",
            capability: "image",
            logicalModelId: "product-image",
            channelId,
            upstreamModel,
            apiFormat: "openai",
        },
    };
}
