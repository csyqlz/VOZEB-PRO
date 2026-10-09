import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
    runCustom: vi.fn(),
    pollCustom: vi.fn(),
    runGemini: vi.fn(),
    runOpenAi: vi.fn(),
    pollOpenAi: vi.fn(),
    getTask: vi.fn(),
    getAgentRun: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    schedule: vi.fn(),
    writeLog: vi.fn(),
    inlineResult: vi.fn(),
    directResult: vi.fn(),
    resolveMedia: vi.fn(() => ({})),
    referenceDataUrl: vi.fn(),
    mediaHeaders: vi.fn(() => ({ "x-media-auth": "signed" })),
    normalizeAssets: vi.fn(),
    deleteAsset: vi.fn(),
    getSettings: vi.fn(),
    register: vi.fn(),
    refund: vi.fn(),
    QueryContractError: class extends Error {},
    UpstreamTerminalError: class extends Error {},
}));

vi.mock("@/app/api/image-tasks/image-task-custom", () => ({ runCustomImageTask: mocks.runCustom, pollCustomImageTask: mocks.pollCustom }));
vi.mock("@/app/api/image-tasks/image-task-gemini", () => ({ runGeminiImageTask: mocks.runGemini }));
vi.mock("@/app/api/image-tasks/image-task-openai", () => ({ runOpenAiImageTask: mocks.runOpenAi }));
vi.mock("@/app/api/image-tasks/image-task-support", () => ({
    directRemoteImageResult: mocks.directResult,
    imageReferenceToDataUrl: mocks.referenceDataUrl,
    imageUnits: vi.fn(() => 1),
    ImageQueryContractError: mocks.QueryContractError,
    ImageUpstreamTerminalError: mocks.UpstreamTerminalError,
    inlineRemoteImageResult: mocks.inlineResult,
    pollOpenAiImageTask: mocks.pollOpenAi,
    resolveProxiedMediaSource: mocks.resolveMedia,
    shouldUseJsonImageEdit: vi.fn(async () => false),
    openAiImageTaskPath: vi.fn(async () => "/images/edits"),
    resolveImageTaskEditProtocol: async (config: ImageTask["config"]) => (await import("./image-edit-protocol")).resolveImageEditProtocol(config),
}));
vi.mock("@/app/api/image-tasks/image-task-runner", () => ({ stableMediaUrl: vi.fn((value: string) => (value && !value.startsWith("data:") ? value : "")), writeImageGenerationLog: mocks.writeLog }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getSettings, refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/creative-runtime-service", () => ({ registerGenerationTaskAssetsForUser: mocks.register }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/generation-log-repository", () => ({ normalizeAssets: mocks.normalizeAssets, deleteLocalAsset: mocks.deleteAsset }));
vi.mock("@/lib/server/image-task-store", () => ({
    getImageTask: mocks.getTask,
    updateImageTask: mocks.updateTask,
    transitionImageTask: mocks.transitionTask,
}));
vi.mock("./agent-run-store", () => ({ getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/maintenance-auth", () => ({ maintenanceWorkerContext: vi.fn(() => "worker-context") }));
vi.mock("@/lib/server/generation-media-authorization", () => ({ generationMediaProxyHeaders: mocks.mediaHeaders }));

import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "./generation-submission-error";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { createImageTaskUpstreamStep, markImageTaskFailed, persistImageTaskResult, prepareImageTaskAutomaticRetry, queryImageTaskUpstreamStep } from "./image-task-runtime";
import type { ImageTask } from "./image-task-store";
import { referenceAssetVersion } from "./ecommerce-reference-recovery";

describe("image task runtime submission safety", () => {
    let state: ImageTask;

    beforeEach(() => {
        vi.clearAllMocks();
        state = imageTask();
        mocks.getTask.mockImplementation(async () => state);
        mocks.getAgentRun.mockReset().mockResolvedValue(null);
        mocks.updateTask.mockImplementation(async (_id: string, patch: Partial<ImageTask>) => {
            state = { ...state, ...patch };
            return state;
        });
        mocks.transitionTask.mockImplementation(async (_task: ImageTask, allowed: string[], patch: Partial<ImageTask>) => {
            if (!allowed.includes(state.status)) return null;
            state = { ...state, ...patch };
            return state;
        });
        mocks.getSettings.mockResolvedValue({ generationPointMultipliers: { imageQuality: {} } });
        mocks.inlineResult.mockImplementation(async (dataUrl: string) => ({ dataUrl }));
        mocks.referenceDataUrl.mockImplementation(async (reference: { dataUrl: string }) => reference.dataUrl);
        mocks.normalizeAssets.mockImplementation(async (assets: Array<{ url: string; remoteUrl?: string }>) => {
            const source = assets[0];
            const name = source.url.includes("first") ? "first" : source.url.includes("second") ? "second" : `asset-${mocks.normalizeAssets.mock.calls.length}`;
            const serverUrl = `/api/generation-log-assets/${name}.png`;
            return [{ type: "image", url: serverUrl, serverUrl, remoteUrl: source.remoteUrl, mimeType: "image/png", width: 4, height: 4, bytes: 128 }];
        });
        mocks.deleteAsset.mockResolvedValue(undefined);
        mocks.register.mockResolvedValue(undefined);
    });

    it.each([false, true])("checks frozen original bytes before image submission and keeps verified input temporary (replaced: %s)", async (replaced) => {
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const replacement = await sharp({ create: { width: 64, height: 48, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        state.runId = "frozen-run";
        state.conversationId = "frozen-conversation";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "openai" };
        state.references = [{ id: "product", dataUrl: "", url: "/api/reference-assets/product.png?width=120", ecommerceRole: "product" }];
        const persistedReferences = structuredClone(state.references);
        const asset = {
            id: "product",
            userId: state.userId,
            conversationId: state.conversationId,
            ordinal: 0,
            type: "image" as const,
            status: "ready" as const,
            serverUrl: "/api/reference-assets/product.png",
            title: "product",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const contentSha256 = createHash("sha256").update(source).digest("hex");
        state.referenceDispatch = { executionId: "original-worker", inputId: "frozen-input", decisionId: "frozen-decision", analysisRequestId: "frozen-analysis", copy: 1 };
        mocks.getAgentRun.mockResolvedValue({
            id: state.runId,
            userId: state.userId,
            conversationId: state.conversationId,
            ecommerceSnapshot: {
                referenceCheckpoint: {
                    version: "ecommerce-reference-checkpoint.v1",
                    inputId: "frozen-input",
                    decisionId: "frozen-decision",
                    state: "resolved",
                    analysisStage: { requestId: "frozen-analysis", state: "completed" },
                    assets: [{ asset, assetVersion: referenceAssetVersion(asset, contentSha256), contentSha256 }],
                    planningInput: { conversationId: state.conversationId, assetCandidates: [{ id: "product", type: "image", url: "/api/reference-assets/product.png?width=120" }] },
                },
            },
        });
        mocks.referenceDataUrl.mockResolvedValue(dataUrl(replaced ? replacement : source));
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const result = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        if (replaced) {
            expect(result).toMatchObject({ state: "needs_review", status: "reference_source_changed" });
            expect(mocks.runOpenAi).not.toHaveBeenCalled();
            expect(mocks.schedule.mock.calls.some(([, , patch]) => patch.executionPhase === "submitting")).toBe(false);
        } else {
            expect(result.state).toBe("pending");
            const temporary = mocks.runOpenAi.mock.calls[0][0];
            expect(temporary.references).toEqual([{ ...persistedReferences[0], dataUrl: dataUrl(source), url: undefined, remoteUrl: undefined, serverUrl: undefined }]);
            expect(state.upstream?.id).toBe("same-upstream");
        }
        expect(mocks.referenceDataUrl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "product", url: "/api/reference-assets/product.png", dataUrl: "" }), "reference-1.png", "http://fixture", "session=test");
        expect(state.references).toEqual(persistedReferences);
        expect(mocks.updateTask.mock.calls.every(([, patch]) => patch.references === undefined)).toBe(true);
        if (replaced) expect(mocks.updateTask).not.toHaveBeenCalled();
    });

    it.each(["source_read", "parent_database"] as const)("recovers the same unsubmitted image from %s without misclassifying the source or starting a provider attempt", async (failure) => {
        const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        state.runId = "frozen-run";
        state.conversationId = "frozen-conversation";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "openai" };
        state.references = [{ id: "product", dataUrl: "", url: "/api/reference-assets/product.png?width=120", ecommerceRole: "product" }];
        state.referenceDispatch = { executionId: "original-worker", inputId: "frozen-input", decisionId: "frozen-decision", analysisRequestId: "frozen-analysis", copy: 1 };
        const asset = {
            id: "product",
            userId: state.userId,
            conversationId: state.conversationId,
            ordinal: 0,
            type: "image" as const,
            status: "ready" as const,
            serverUrl: "/api/reference-assets/product.png",
            title: "product",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const contentSha256 = createHash("sha256").update(source).digest("hex");
        const parent = {
            id: state.runId,
            userId: state.userId,
            conversationId: state.conversationId,
            ecommerceSnapshot: {
                referenceCheckpoint: {
                    version: "ecommerce-reference-checkpoint.v1",
                    inputId: "frozen-input",
                    decisionId: "frozen-decision",
                    state: "resolved",
                    analysisStage: { requestId: "frozen-analysis", state: "completed" },
                    assets: [{ asset, assetVersion: referenceAssetVersion(asset, contentSha256), contentSha256 }],
                    planningInput: { conversationId: state.conversationId, assetCandidates: [{ id: "product", type: "image", url: "/api/reference-assets/product.png?width=120" }] },
                },
            },
        };
        const frozen = structuredClone(parent);
        const originalReferences = structuredClone(state.references);
        mocks.getAgentRun.mockResolvedValue(parent);
        mocks.referenceDataUrl.mockResolvedValue(dataUrl(source));
        if (failure === "parent_database") mocks.getAgentRun.mockRejectedValueOnce(new Error("database temporarily unavailable"));
        else mocks.referenceDataUrl.mockRejectedValueOnce(new Error("reference GET returned 503"));
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const first = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(first).toMatchObject({ state: "needs_review", status: failure === "source_read" ? "reference_source_unavailable" : "reference_validation_unavailable", reason: expect.stringContaining("检查状态") });
        expect(first).not.toMatchObject({ status: "reference_source_changed" });
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.updateTask).not.toHaveBeenCalled();
        expect(mocks.schedule).not.toHaveBeenCalled();
        expect(state.attempts).toBeUndefined();
        expect(state.billing).toBeUndefined();
        expect(state.upstream).toBeUndefined();
        expect(parent).toEqual(frozen);
        const second = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(second).toMatchObject({ state: "pending", upstream: { id: "same-upstream" } });
        expect(mocks.runOpenAi).toHaveBeenCalledOnce();
        expect(state.references).toEqual(originalReferences);
        expect(parent).toEqual(frozen);
        mocks.pollOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        mocks.referenceDataUrl.mockRejectedValue(new Error("source unavailable after submission must not be read again"));
        const reads = mocks.referenceDataUrl.mock.calls.length;
        const queries = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture", "session=test");
        expect(queries.state).toBe("pending");
        expect(mocks.referenceDataUrl).toHaveBeenCalledTimes(reads);
        expect(mocks.runOpenAi).toHaveBeenCalledOnce();
        expect(mocks.pollOpenAi).toHaveBeenCalledWith(expect.anything(), "same-upstream", "http://fixture", "http://fixture", "session=test", "", true);
    });

    it.each(["valid", "sub2api", "exchanged_order", "invalid_mapping", "system_changed", "product_changed", "product_json"])("keeps v4 auxiliary references and validates the frozen local baseline (%s)", async (condition) => {
        const { buildSceneEditProtection } = await import("./ecommerce-product-regions");
        const source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        state.kind = "edit";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: condition === "sub2api" ? "sub2api" : "openai" };
        state.references = [
            { id: "scene", dataUrl: dataUrl(source), ecommerceRole: "scene" },
            { id: "style", dataUrl: dataUrl(source), ecommerceRole: "scene" },
        ];
        state.sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        state.mask = state.sceneProtection.mask;
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v4",
            providerProfileId: "gpt-image-2.5-flare",
            prompt: "edit",
            referenceRoles: [
                { assetId: "scene", role: "scene" },
                { assetId: "style", role: "scene" },
            ],
            referenceMapping: [
                { assetId: "scene", userAlias: "图片2", providerIndex: 0, purposes: ["edit_target"] },
                { assetId: "style", userAlias: "图片1", providerIndex: condition === "invalid_mapping" ? 0 : 1, purposes: ["style"] },
            ],
            mask: { mode: "independent", required: true },
            protection: { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
            parameters: { variant: "gpt-image-2.5-flare" },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
        };
        if (condition === "product_json") {
            state.config.advancedConfig = { ...emptyAdvancedConfig(), referenceRule: "JSON images[].image_url" };
            state.sceneProtection = undefined;
            state.ecommerceExecution = undefined;
            state.productProtection = { sourceAssetId: "scene" } as ImageTask["productProtection"];
        }
        if (condition.endsWith("changed")) {
            state.config = { ...state.config, apiSource: "system", model: "gpt-image-2.5-flare", channelId: "fixture", logicalModel: "image", advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api" } };
            mocks.getSettings.mockResolvedValue({
                defaultModels: { imageModel: "image" },
                logicalModels: [{ id: "image", name: "image", capability: "image", enabled: true, bindings: [{ id: "binding", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", enabled: true, priority: 1 }] }],
                systemChannels: [
                    { id: "fixture", name: "image", enabled: true, baseUrl: "https://image.example.com", apiKey: "fixture-key", apiFormat: "openai", models: ["gpt-image-2.5-flare"], advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } },
                ],
            });
            if (condition === "product_changed") {
                state.sceneProtection = undefined;
                state.productProtection = { sourceAssetId: "scene" } as ImageTask["productProtection"];
            }
        }
        if (condition === "exchanged_order") state.references.reverse();
        mocks.runOpenAi.mockResolvedValue({ pending: { id: "same-upstream", pollBaseUrl: "http://fixture", mediaBaseUrl: "http://fixture" } });
        const step = await createImageTaskUpstreamStep(state, "http://fixture", "http://fixture");
        expect(step.state).toBe(condition === "valid" || condition === "sub2api" ? "pending" : "needs_review");
        if (condition === "valid" || condition === "sub2api") expect(mocks.runOpenAi).toHaveBeenCalledWith(expect.objectContaining({ references: state.references, mask: state.mask }), expect.anything(), expect.anything(), expect.anything(), true);
        else expect(mocks.runOpenAi).not.toHaveBeenCalled();
    });

    it("keeps native ecommerce evidence when a success log returns replacement assets", async () => {
        const canvas = { mode: "exact" as const, size: { width: 3840, height: 2160 }, source: "user_text" as const, allowReframe: false };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            canvas,
            parameters: { variant: "nano-banana-2", size: "3840x2160" },
            referenceRoles: [],
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" },
        };
        const media = {
            dataUrl: "/api/generation-log-assets/native.png",
            serverUrl: "/api/generation-log-assets/native.png",
            width: 2880,
            height: 2880,
            canvasEvidence: { constraint: canvas, requestedSize: canvas.size, nativeSize: { width: 2880, height: 2880 }, storedSize: { width: 2880, height: 2880 }, nativeUrl: "/api/generation-log-assets/native.png", normalization: "none" as const },
        };
        state.result = { ...media, results: [media] };
        mocks.writeLog.mockResolvedValueOnce({ assets: [{ url: "/api/generation-log-assets/cropped.png", serverUrl: "/api/generation-log-assets/cropped.png", width: 3840, height: 2160 }] });
        await persistImageTaskResult(state, "http://internal", media.serverUrl);
        expect(state.result?.results?.[0]).toEqual(media);
    });

    it.each(["unreadable", "save_failed", "wrong_native", "all_unreadable"] as const)("durably recovers the same upstream canvas batch after %s without recreating or refunding", async (condition) => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            referenceRoles: [],
            parameters: { variant: "nano-banana-2", size: "6x4" },
            canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "user_text", allowReframe: false },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "channel-one", upstreamModel: "image-one", apiFormat: "openai" },
        };
        const good = dataUrl(
            await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
                .png()
                .toBuffer(),
        );
        const second = dataUrl(
            await sharp({ create: { width: condition === "wrong_native" ? 8 : 6, height: 4, channels: 3, background: "red" } })
                .png()
                .toBuffer(),
        );
        const unavailable = "https://fixture.invalid/unreadable.png";
        const inputs = [{ dataUrl: condition === "all_unreadable" ? unavailable : good }, { dataUrl: condition === "unreadable" || condition === "all_unreadable" ? unavailable : second }];
        mocks.writeLog.mockResolvedValue(undefined);
        mocks.normalizeAssets.mockImplementation(async ([asset]: Array<{ url: string }>) => {
            if (asset.url === second && (condition === "save_failed" || condition === "wrong_native")) throw new Error("private-storage-rejection");
            const size = await sharp(Buffer.from(asset.url.split(",")[1], "base64")).metadata();
            const serverUrl = `/api/generation-log-assets/slot-${mocks.normalizeAssets.mock.calls.length}.png`;
            return [{ type: "image", url: serverUrl, serverUrl, width: size.width, height: size.height }];
        });
        const upstream = { id: "original-upstream", mediaBaseUrl: "https://fixture.example/media", pollBaseUrl: "http://internal/api/ai/system/channel-one" };
        mocks.runOpenAi.mockResolvedValueOnce({ pending: upstream, pointsCost: 2, pointsRecordId: "original-charge" });
        expect(await createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).toMatchObject({ state: "pending", upstream });
        mocks.pollOpenAi.mockResolvedValueOnce({ dataUrl: inputs[0].dataUrl, results: inputs });
        const step = await queryImageTaskUpstreamStep(state, "http://internal");
        expect(state.result).toMatchObject({ batchEvidence: [expect.objectContaining({ resultId: "image-one:1", resultIndex: 1 }), expect.objectContaining({ resultId: "image-one:2", resultIndex: 2, storageStatus: "unavailable" })] });
        if (condition === "all_unreadable") expect(step).toEqual({ state: "completed" });
        else {
            expect(step.state).toBe("result_ready");
            if (step.state !== "result_ready") throw new Error("canvas batch not ready");
            await persistImageTaskResult(state, "http://internal", step.resultUrl);
        }
        const saved = JSON.parse(JSON.stringify(state));
        state = saved;
        expect(state).toMatchObject({ status: "success", upstream, billing: { pointsRecordId: "original-charge", refunded: false }, retryable: false });
        expect(state.result?.results).toHaveLength(condition === "all_unreadable" ? 0 : 1);
        expect(state.result?.batchEvidence).toHaveLength(2);
        if (condition === "wrong_native") expect(state.result?.batchEvidence?.[1].nativeSize).toEqual({ width: 8, height: 4 });
        await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(state.result?.batchEvidence).toEqual(saved.result.batchEvidence);
        expect(mocks.runOpenAi).toHaveBeenCalledTimes(1);
        expect(mocks.pollOpenAi).toHaveBeenCalledTimes(1);
        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(mocks.refund).not.toHaveBeenCalled();
        expect(mocks.deleteAsset).not.toHaveBeenCalled();
        expect(JSON.stringify(state.result)).not.toContain("private-storage-rejection");
    });

    it("pauses a new canvas task when the actual adapter cannot express geometry", async () => {
        const canvas = { mode: "exact" as const, size: { width: 384, height: 216 }, source: "baseline" as const, allowReframe: false };
        state.config.apiFormat = "gemini";
        state.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "gemini" };
        state.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-nano-banana-2.v1",
            providerProfileId: "nano-banana-2",
            prompt: "preserve",
            canvas,
            parameters: { variant: "nano-banana-2" },
            referenceRoles: [],
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "nano-banana-2", apiFormat: "gemini" },
        };
        const snapshot = JSON.stringify(state.ecommerceExecution);
        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "needs_review", reason: expect.stringContaining("适配器尚不支持画布约束") });
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(JSON.stringify(state.ecommerceExecution)).toBe(snapshot);
    });

    it("does not resubmit after a safe request rejection", async () => {
        mocks.runCustom.mockRejectedValueOnce(new GenerationSubmissionSafeFailure("参数不受支持", 422));

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "failed", error: "参数不受支持" });
        expect(step).not.toHaveProperty("retryReason");
        expect(mocks.runCustom).toHaveBeenCalledTimes(1);
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed"]);
    });

    it("prepares exactly one new attempt after an explicit upstream generation failure", async () => {
        mocks.runCustom.mockRejectedValueOnce(new mocks.UpstreamTerminalError("上游生成失败"));

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "failed", error: "上游生成失败", retryReason: "upstream_failed" });

        await expect(prepareImageTaskAutomaticRetry(state, "上游生成失败")).resolves.toMatchObject({ config: { channelId: "channel-two" }, candidateConfigs: [], attemptNo: 1 });
        expect(state.attempts).toEqual([expect.objectContaining({ attemptNo: 1, status: "failed", error: "上游生成失败" })]);
        expect(state.upstream).toBeUndefined();

        mocks.runGemini.mockResolvedValueOnce({ dataUrl: "", pending: { id: "upstream-two", mediaBaseUrl: "https://two.example", pollBaseUrl: "https://two.example" } });
        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "pending", upstream: { id: "upstream-two" } });
        expect(mocks.runGemini.mock.calls[0]?.[0]).toMatchObject({ attemptNo: 2, config: { channelId: "channel-two" } });
        expect(state.attempts).toEqual([expect.objectContaining({ attemptNo: 1, status: "failed" }), expect.objectContaining({ attemptNo: 2, status: "running" })]);

        await expect(prepareImageTaskAutomaticRetry(state, "再次失败")).resolves.toBeNull();
    });

    it("keeps the submitting phase unavailable until the configured image deadline", async () => {
        vi.spyOn(Date, "now").mockReturnValue(10_000);
        state.config = { ...state.config, capabilityProfile: { timeoutMs: 150_000 } };
        state.candidateConfigs = [];
        mocks.runCustom.mockResolvedValueOnce({ dataUrl: "", pending: { id: "upstream-one", mediaBaseUrl: "https://one.example", pollBaseUrl: "https://one.example" } });

        await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");

        expect(mocks.schedule).toHaveBeenNthCalledWith(1, "image", "image-one", expect.objectContaining({ executionPhase: "submitting", submittedAt: 10_000, nextPollAt: 160_000 }));
    });

    it("routes Yumeng image tasks through the declarative async runtime", async () => {
        state.config = { ...state.config, advancedConfig: { ...state.config.advancedConfig!, protocol: "yumeng", createPath: "/kyyReactApiServer/v2/model-center/tasks", queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id" } };
        state.candidateConfigs = [];
        mocks.runCustom.mockResolvedValueOnce({ dataUrl: "", pending: { id: "yumeng-task", mediaBaseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer", pollBaseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer" } });

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "pending", upstream: { id: "yumeng-task" } });
        expect(mocks.runCustom).toHaveBeenCalledOnce();
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
    });

    it("routes a native Gemini custom image edit through the inlineData runtime", async () => {
        state.kind = "edit";
        state.references = [{ name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }];
        state.config = {
            ...state.config,
            apiFormat: "gemini",
            model: "gemini-3.1-flash-image",
            size: "16:9",
            quality: "high",
            advancedConfig: {
                ...emptyAdvancedConfig(),
                protocol: "custom",
                createPath: "/v1/models/gemini-3.1-flash-image:generateContent",
                editPath: "/v1/models/gemini-3.1-flash-image:generateContent",
                requestTemplate: '{"contents":[{"role":"user","parts":[{"text":"{{prompt}}"}]}],"size":"{{size}}"}',
                resultField: "candidates[0].content.parts[0].inlineData",
            },
        };
        state.candidateConfigs = [];
        mocks.runGemini.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,c2FmZQ==" });

        await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");

        expect(mocks.runGemini).toHaveBeenCalledOnce();
        expect(mocks.runCustom).not.toHaveBeenCalled();
    });

    it("keeps declarative media resolution separate from system-proxy polling", async () => {
        state.config = { ...state.config, baseUrl: "/api/ai/system/channel-one", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", queryPath: "/jobs/:task_id" } };
        state.upstream = {
            id: "upstream-one",
            mediaBaseUrl: "https://provider.example/v1/images",
            pollBaseUrl: "http://internal/api/ai/system/channel-one/images",
        };
        mocks.pollCustom.mockResolvedValueOnce({ dataUrl: "", pending: state.upstream });

        await expect(queryImageTaskUpstreamStep(state, "http://internal")).resolves.toMatchObject({ state: "pending" });
        expect(mocks.pollCustom).toHaveBeenCalledWith(state, "upstream-one", "https://provider.example/v1/images", "http://internal/api/ai/system/channel-one/images", "worker-context", true);
    });

    it("does not switch candidates when the submission outcome is unknown", async () => {
        mocks.runCustom.mockRejectedValueOnce(new Error("socket closed"));

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).rejects.toBeInstanceOf(GenerationSubmissionUncertainError);
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["running"]);
    });

    it("keeps an OpenAI id-only response for manual review without trying another channel", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        mocks.runOpenAi.mockResolvedValueOnce({
            dataUrl: "",
            needsReview: {
                upstream: { id: "upstream-one", mediaBaseUrl: "http://internal", pollBaseUrl: "http://internal" },
                reason: "OpenAI 图片接口未返回图片，且渠道没有声明异步查询路径",
            },
            pointsCost: 1,
            pointsRecordId: "record-one",
        });

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "needs_review", status: "query_contract_missing" });
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(state.upstream?.id).toBe("upstream-one");
        expect(state.billing).toMatchObject({ pointsRecordId: "record-one", refunded: false });
        expect(mocks.schedule).toHaveBeenLastCalledWith(
            "image",
            "image-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                upstreamTaskId: "upstream-one",
                channelId: "channel-one",
                nextPollAt: undefined,
                resultPayload: { reviewReason: "OpenAI 图片接口未返回图片，且渠道没有声明异步查询路径" },
            }),
        );
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("does not refund when success wins the failure transition race", async () => {
        state = { ...imageTask(), status: "running", billing: { pointsCost: 2, pointsRecordId: "image-race", refunded: false } };
        mocks.transitionTask.mockImplementationOnce(async () => {
            state = { ...state, status: "success" };
            return null;
        });

        await expect(markImageTaskFailed(state, "late failure")).resolves.toMatchObject({ status: "success" });
        expect(mocks.refund).not.toHaveBeenCalled();
        expect(mocks.writeLog).not.toHaveBeenCalled();
    });

    it("commits the image error state before refunding", async () => {
        state = { ...imageTask(), status: "running", billing: { pointsCost: 2, pointsRecordId: "image-failed", refunded: false } };
        mocks.refund.mockImplementationOnce(async () => {
            expect(state.status).toBe("error");
            return undefined;
        });
        mocks.writeLog.mockResolvedValueOnce(undefined);

        await expect(markImageTaskFailed(state, "provider failed")).resolves.toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.refund).toHaveBeenCalledOnce();
    });

    it("commits image success before writing the generation log", async () => {
        state = { ...imageTask(), status: "running", result: { dataUrl: "data:image/png;base64,c2FmZQ==" } };
        mocks.writeLog.mockImplementationOnce(async () => {
            expect(state.status).toBe("success");
            return undefined;
        });

        await expect(persistImageTaskResult(state, "http://internal", "inline://image-task-result")).resolves.toMatchObject({ status: "success" });
        expect(mocks.writeLog).toHaveBeenCalledOnce();
    });

    it("fails a corrupt synchronous image result before publishing it as ready", async () => {
        state = imageTask();
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,broken", pointsCost: 1, pointsRecordId: "record-one" });
        mocks.normalizeAssets.mockRejectedValueOnce(new Error("pngload_buffer: libspng read error"));

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        expect(step).toMatchObject({ state: "failed", error: expect.stringContaining("pngload_buffer") });
        expect(mocks.schedule).not.toHaveBeenCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "result_ready" }));
        expect(state.result).toBeUndefined();
    });

    it("stores only stable media references before scheduling a synchronous result", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,c2FmZQ==", pointsCost: 1, pointsRecordId: "record-one" });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");

        expect(step).toMatchObject({ state: "result_ready", resultUrl: expect.stringContaining("/api/generation-log-assets/") });
        expect(JSON.stringify(state.result)).not.toContain("data:image");
        expect(state.result?.dataUrl).toMatch(/^\/api\/generation-log-assets\//);
        expect(mocks.schedule).toHaveBeenLastCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "result_ready", resultPayload: { url: state.result?.dataUrl }, lastUpstreamStatus: "completed" }));
    });

    it("resumes a prepared result without creating the upstream task again", async () => {
        const serverUrl = "/api/generation-log-assets/prepared.png";
        state = { ...imageTask(), status: "running", result: { dataUrl: serverUrl, serverUrl, results: [{ dataUrl: serverUrl, serverUrl }] } };

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "result_ready", resultUrl: serverUrl });

        expect(mocks.runCustom).not.toHaveBeenCalled();
        expect(mocks.runOpenAi).not.toHaveBeenCalled();
        expect(mocks.runGemini).not.toHaveBeenCalled();
        expect(mocks.schedule).toHaveBeenLastCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "result_ready", resultPayload: { url: serverUrl } }));
    });

    it.each(["async result", "prepared result"])("preserves the real file schedule submission identity when recovering %s", async (path) => {
        const directory = await mkdtemp(join(tmpdir(), "vozeb-image-ready-schedule-"));
        const clock = vi.spyOn(Date, "now").mockReturnValue(20_000);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        try {
            const scheduler = await vi.importActual<typeof import("./generation-task-scheduler")>("./generation-task-scheduler");
            const store = await import("./generation-task-store");
            mocks.schedule.mockImplementation(scheduler.scheduleGenerationTask);
            const serverUrl = "/api/generation-log-assets/prepared.png";
            state = {
                ...imageTask(),
                status: "running",
                createdAt: 20_000,
                updatedAt: 20_000,
                upstream: { id: "upstream-one", mediaBaseUrl: "https://provider.example/images", pollBaseUrl: "http://internal/api/ai/system/channel-one/images" },
                ...(path === "prepared result" ? { result: { dataUrl: serverUrl, serverUrl, results: [{ dataUrl: serverUrl, serverUrl }] } } : {}),
            };
            await store.createStoredGenerationTask("image", state, 60_000);
            await scheduler.scheduleGenerationTask("image", state.id, { executionPhase: "polling", upstreamTaskId: state.upstream!.id, channelId: state.config.channelId, queryPath: "/images/upstream-one", submittedAt: 10_000, nextPollAt: 15_000 });
            if (path === "async result") mocks.pollCustom.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,c2FmZQ==" });
            const step = path === "async result" ? await queryImageTaskUpstreamStep(state, "http://internal") : await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
            expect(step.state).toBe("result_ready");
            if (step.state !== "result_ready") throw new Error("image result was not ready");
            expect(await store.getStoredGenerationTaskRecord("image", state.id)).toMatchObject({
                executionPhase: "result_ready",
                upstreamTaskId: "upstream-one",
                channelId: "channel-one",
                queryPath: "/images/upstream-one",
                submittedAt: 10_000,
                nextPollAt: 20_000,
                resultPayload: { url: step.resultUrl },
            });
            expect(mocks.pollCustom).toHaveBeenCalledTimes(path === "async result" ? 1 : 0);
            expect(mocks.runCustom).not.toHaveBeenCalled();
            expect(mocks.runOpenAi).not.toHaveBeenCalled();
            expect(mocks.runGemini).not.toHaveBeenCalled();
        } finally {
            mocks.schedule.mockReset();
            clock.mockRestore();
            vi.unstubAllEnvs();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("removes a newly prepared asset when cancellation wins the persistence race", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,c2FmZQ==", pointsCost: 1, pointsRecordId: "record-one" });
        mocks.normalizeAssets.mockImplementationOnce(async () => {
            state = { ...state, status: "cancelled" };
            const serverUrl = "/api/generation-log-assets/cancelled.png";
            return [{ type: "image", url: serverUrl, serverUrl }];
        });

        await expect(createImageTaskUpstreamStep(state, "http://internal", "https://public.example")).resolves.toMatchObject({ state: "failed", status: "cancelled" });

        expect(mocks.deleteAsset).toHaveBeenCalledWith("/api/generation-log-assets/cancelled.png");
        expect(state.result).toBeUndefined();
    });

    it("downloads system-proxied image results with task-bound media authorization", async () => {
        state.config = { ...state.config, baseUrl: "/api/ai/system/channel-one", advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        const remoteUrl = "https://provider.example/media/result.png";
        const proxyUrl = `/api/ai/system/channel-one/_media?url=${encodeURIComponent(remoteUrl)}`;
        mocks.resolveMedia.mockReturnValueOnce({ remoteUrl, proxyUrl });
        mocks.runOpenAi.mockResolvedValueOnce({ dataUrl: proxyUrl, remoteUrl });
        mocks.inlineResult.mockResolvedValueOnce({ dataUrl: "data:image/png;base64,c2FmZQ==", remoteUrl });
        mocks.writeLog.mockResolvedValueOnce({ asset: { url: "/api/generation-log-assets/asset-one", remoteUrl } });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        if (step.state !== "result_ready") throw new Error("image result was not ready");
        await expect(persistImageTaskResult(state, "http://internal", step.resultUrl)).resolves.toMatchObject({ status: "success" });

        expect(mocks.mediaHeaders).toHaveBeenCalledWith({ userId: "user-one", taskType: "image", taskId: "image-one", channelId: "channel-one", upstreamModel: "image-one", url: remoteUrl });
        expect(mocks.inlineResult).toHaveBeenCalledWith(proxyUrl, "http://internal", "worker-context", remoteUrl, { "x-media-auth": "signed" });
        expect(mocks.directResult).not.toHaveBeenCalled();
    });

    it("persists and registers every image returned by one upstream task", async () => {
        state.config = { ...state.config, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } };
        state.candidateConfigs = [];
        mocks.runOpenAi.mockResolvedValueOnce({
            dataUrl: "https://provider.example/first.png",
            remoteUrl: "https://provider.example/first.png",
            results: [
                { dataUrl: "https://provider.example/first.png", remoteUrl: "https://provider.example/first.png" },
                { dataUrl: "https://provider.example/second.png", remoteUrl: "https://provider.example/second.png" },
            ],
        });
        mocks.directResult.mockImplementation((url?: string) => (url ? { dataUrl: url, remoteUrl: url } : null));
        mocks.writeLog.mockResolvedValueOnce({
            assets: [
                { type: "image", url: "/api/generation-log-assets/first.png", serverUrl: "/api/generation-log-assets/first.png" },
                { type: "image", url: "/api/generation-log-assets/second.png", serverUrl: "/api/generation-log-assets/second.png" },
            ],
        });

        const step = await createImageTaskUpstreamStep(state, "http://internal", "https://public.example");
        if (step.state !== "result_ready") throw new Error("image result was not ready");
        await persistImageTaskResult(state, "http://internal", step.resultUrl);

        expect(state.result?.results?.map((item) => item.serverUrl)).toEqual(["/api/generation-log-assets/first.png", "/api/generation-log-assets/second.png"]);
        expect(mocks.register).toHaveBeenCalledWith(
            "user-one",
            expect.objectContaining({
                assets: [
                    { type: "image", url: "/api/generation-log-assets/first.png" },
                    { type: "image", url: "/api/generation-log-assets/second.png" },
                ],
            }),
        );
    });

    it("fails and refunds a charged transparent task when the provider returns an opaque image", async () => {
        const opaque = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ef4444" } })
            .png()
            .toBuffer();
        state = {
            ...imageTask(),
            status: "running",
            config: { ...imageTask().config, outputBackground: "transparent" },
            billing: { pointsCost: 3, pointsRecordId: "transparent-charge", refunded: false },
            result: { dataUrl: `data:image/png;base64,${opaque.toString("base64")}` },
        };
        mocks.writeLog.mockResolvedValue(undefined);

        await expect(persistImageTaskResult(state, "http://internal", "inline://image-task-result")).resolves.toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.refund).toHaveBeenCalledWith("user-one", "image-one", 3, "image", 1, expect.stringContaining("image-task:image-one"), "transparent-charge");
        expect(mocks.register).not.toHaveBeenCalled();
    });

    it("rejects a layer task when upstream returns only a composed image", async () => {
        const opaque = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ef4444" } })
            .png()
            .toBuffer();
        state = {
            ...imageTask(),
            status: "running",
            kind: "edit",
            config: { ...imageTask().config, outputMode: "layers" },
            billing: { pointsCost: 3, pointsRecordId: "layer-charge", refunded: false },
            references: [{ dataUrl: dataUrl(opaque) }],
            result: { dataUrl: dataUrl(opaque) },
        };

        await expect(persistImageTaskResult(state, "http://internal", "inline://image-task-result")).resolves.toMatchObject({
            status: "error",
            error: expect.stringContaining("上游未返回完整分层"),
            billing: { refunded: true },
        });
        expect(mocks.writeLog).toHaveBeenCalledWith(expect.any(Object), "failed", "", expect.any(Number), expect.stringContaining("上游未返回完整分层"));
        expect(mocks.register).not.toHaveBeenCalled();
    });

    it("accepts one upstream layer task containing transparent elements and a clean background", async () => {
        const { source, foreground, background } = await exactLayerFixture();
        state = {
            ...imageTask(),
            status: "running",
            kind: "edit",
            config: { ...imageTask().config, outputMode: "layers" },
            references: [{ dataUrl: source }],
            result: { dataUrl: foreground, results: [{ dataUrl: foreground }, { dataUrl: background }] },
        };
        mocks.writeLog.mockResolvedValueOnce({
            assets: [
                { type: "image", url: "/api/generation-log-assets/foreground.png", serverUrl: "/api/generation-log-assets/foreground.png" },
                { type: "image", url: "/api/generation-log-assets/background.png", serverUrl: "/api/generation-log-assets/background.png" },
            ],
        });

        await expect(persistImageTaskResult(state, "http://internal", "inline://image-task-result")).resolves.toMatchObject({ status: "success", result: { results: expect.any(Array) } });
        expect(state.result?.results).toHaveLength(2);
        expect(mocks.writeLog).toHaveBeenCalledOnce();
        expect(mocks.register).toHaveBeenCalledOnce();
    });

    it("rejects duplicate images in a layer task instead of dropping them", async () => {
        const { source, foreground, background } = await exactLayerFixture();
        state = {
            ...imageTask(),
            status: "running",
            kind: "edit",
            config: { ...imageTask().config, outputMode: "layers" },
            billing: { pointsCost: 3, pointsRecordId: "duplicate-layer-charge", refunded: false },
            references: [{ dataUrl: source }],
            result: { dataUrl: foreground, results: [{ dataUrl: foreground }, { dataUrl: foreground }, { dataUrl: background }] },
        };

        await expect(persistImageTaskResult(state, "http://internal", "inline://image-task-result")).resolves.toMatchObject({
            status: "error",
            error: expect.stringContaining("重复像素"),
            billing: { refunded: true },
        });
        expect(mocks.register).not.toHaveBeenCalled();
    });
});

function dataUrl(bytes: Buffer) {
    return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function exactLayerFixture() {
    const foregroundBytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
            {
                input: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                    .png()
                    .toBuffer(),
                left: 1,
                top: 1,
            },
        ])
        .png()
        .toBuffer();
    const backgroundBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#dbeafe" } })
        .png()
        .toBuffer();
    const sourceBytes = await sharp(backgroundBytes)
        .composite([
            {
                input: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                    .png()
                    .toBuffer(),
                left: 1,
                top: 1,
            },
        ])
        .png()
        .toBuffer();
    return { source: dataUrl(sourceBytes), foreground: dataUrl(foregroundBytes), background: dataUrl(backgroundBytes) };
}

function imageTask(): ImageTask {
    const second = { baseUrl: "https://two.example", apiKey: "two", apiFormat: "gemini" as const, model: "image-two", channelId: "channel-two" };
    return {
        id: "image-one",
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: "generation",
        source: "image-workbench",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        config: {
            baseUrl: "https://one.example",
            apiKey: "one",
            apiFormat: "openai",
            model: "image-one",
            channelId: "channel-one",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", createPath: "/images", requestTemplate: "{}", resultField: "url" },
        },
        candidateConfigs: [second],
        prompt: "test",
        references: [],
    };
}
