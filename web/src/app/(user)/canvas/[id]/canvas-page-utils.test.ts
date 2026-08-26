import { beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasNodeType, type CanvasAssistantSession, type CanvasNodeData } from "../types";
import { CANVAS_CONFIG_NODE_HEIGHT } from "../constants";

const mocks = vi.hoisted(() => ({
    readImageMeta: vi.fn(),
    resolveStoredImageDataUrl: vi.fn(),
    uploadImage: vi.fn(),
}));

vi.mock("@/lib/image-utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/image-utils")>()), readImageMeta: mocks.readImageMeta }));
vi.mock("@/services/image-storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/services/image-storage")>()),
    resolveStoredImageDataUrl: mocks.resolveStoredImageDataUrl,
    uploadImage: mocks.uploadImage,
}));

import {
    applyNodeConfigPatch,
    getGenerationCount,
    hydrateAssistantImages,
    hydrateCanvasImages,
    isHiddenBatchChild,
    normalizeCanvasConfigNodeLayout,
    prepareAssistantImages,
    prepareCanvasImages,
    replaceCanvasNodeMediaMetadata,
    resolveMetadataImageEditMask,
    resolveMetadataImageEditValidationMask,
    resolveMetadataReferences,
    uploadGeneratedCanvasImage,
} from "./canvas-page-utils";

describe("Canvas project hydration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readImageMeta.mockResolvedValue({ width: 1024, height: 1024, mimeType: "image/png" });
        mocks.resolveStoredImageDataUrl.mockImplementation(async (storageKey: string) => {
            if (storageKey === "broken-image") throw new Error("media unavailable");
            return `/api/reference-assets/${storageKey}`;
        });
        mocks.uploadImage.mockRejectedValue(new Error("upload unavailable"));
    });

    it("keeps the rest of the Canvas usable when one persisted node media fails to hydrate", async () => {
        const valid = imageNode("valid", "valid-image");
        const broken = imageNode("broken", "broken-image");

        const result = await hydrateCanvasImages([valid, broken, textNode()]);

        expect(result).toHaveLength(3);
        expect(result[0]?.metadata?.content).toBe("/api/reference-assets/valid-image");
        expect(result[1]).toBe(broken);
        expect(result[2]?.type).toBe(CanvasNodeType.Text);
    });

    it("preserves individual assistant references that cannot be restored", async () => {
        const sessions: CanvasAssistantSession[] = [
            {
                id: "session",
                title: "会话",
                createdAt: "2026-07-31T00:00:00.000Z",
                updatedAt: "2026-07-31T00:00:00.000Z",
                messages: [
                    {
                        id: "message",
                        role: "user",
                        text: "参考这些素材",
                        references: [
                            { id: "valid", type: CanvasNodeType.Image, title: "正常", storageKey: "valid-image" },
                            { id: "broken", type: CanvasNodeType.Image, title: "失效", storageKey: "broken-image", dataUrl: "legacy-fallback" },
                        ],
                    },
                ],
            },
        ];

        const result = await hydrateAssistantImages(sessions);
        const references = result[0]?.messages[0]?.references;

        expect(references?.[0]?.dataUrl).toBe("/api/reference-assets/valid-image");
        expect(references?.[1]).toEqual(sessions[0]?.messages[0]?.references?.[1]);
    });

    it("prepares stable project media synchronously without waiting for image metadata", () => {
        const node = imageNode("stable", "permanent/user/canvas/image.webp");
        const sessions: CanvasAssistantSession[] = [
            {
                id: "session",
                title: "会话",
                createdAt: "2026-07-31T00:00:00.000Z",
                updatedAt: "2026-07-31T00:00:00.000Z",
                messages: [{ id: "message", role: "user", text: "素材", references: [{ id: "reference", type: CanvasNodeType.Image, title: "参考", storageKey: "permanent/user/canvas/reference.webp" }] }],
            },
        ];

        expect(prepareCanvasImages([node])[0]?.metadata?.content).toBe("/api/reference-assets/permanent/user/canvas/image.webp");
        expect(prepareAssistantImages(sessions)[0]?.messages[0]?.references?.[0]?.dataUrl).toBe("/api/reference-assets/permanent/user/canvas/reference.webp");
        expect(mocks.readImageMeta).not.toHaveBeenCalled();
        expect(mocks.uploadImage).not.toHaveBeenCalled();
    });

    it("reuses complete permanent generation metadata without re-reading or uploading the image", async () => {
        await expect(
            uploadGeneratedCanvasImage({
                dataUrl: "/api/generation-log-assets/permanent/2026/08/20/images/result.png",
                serverUrl: "/api/generation-log-assets/permanent/2026/08/20/images/result.png",
                remoteUrl: "https://upstream.example.com/result.png",
                width: 1536,
                height: 1024,
                bytes: 234567,
                mimeType: "image/png",
            }),
        ).resolves.toEqual({
            url: "/api/generation-log-assets/permanent/2026/08/20/images/result.png",
            storageKey: "permanent/2026/08/20/images/result.png",
            remoteUrl: "https://upstream.example.com/result.png",
            serverUrl: "/api/generation-log-assets/permanent/2026/08/20/images/result.png",
            width: 1536,
            height: 1024,
            bytes: 234567,
            mimeType: "image/png",
        });
        expect(mocks.uploadImage).not.toHaveBeenCalled();
        expect(mocks.readImageMeta).not.toHaveBeenCalled();
    });

    it("keeps the existing validation path when generated metadata is incomplete", async () => {
        mocks.uploadImage.mockResolvedValueOnce({
            url: "/api/generation-log-assets/permanent/result.png",
            storageKey: "permanent/result.png",
            serverUrl: "/api/generation-log-assets/permanent/result.png",
            width: 1024,
            height: 1024,
            bytes: 123,
            mimeType: "image/png",
        });

        await uploadGeneratedCanvasImage({ dataUrl: "/api/generation-log-assets/permanent/result.png", serverUrl: "/api/generation-log-assets/permanent/result.png" });

        expect(mocks.uploadImage).toHaveBeenCalledWith("/api/generation-log-assets/permanent/result.png");
    });
});

describe("Canvas config node layout", () => {
    it("keeps the persisted details state and node hit box in sync", () => {
        const collapsed = normalizeCanvasConfigNodeLayout(configNode(320));
        const expanded = applyNodeConfigPatch(collapsed, { configDetailsOpen: true });

        expect(collapsed).toMatchObject({ height: CANVAS_CONFIG_NODE_HEIGHT.collapsed, metadata: { configDetailsOpen: false } });
        expect(expanded).toMatchObject({ height: CANVAS_CONFIG_NODE_HEIGHT.expanded, metadata: { configDetailsOpen: true } });
    });

    it("records whether a canvas size is user-locked", () => {
        const node = configNode(320);

        expect(applyNodeConfigPatch(node, { size: "16:9" }).metadata).toMatchObject({ size: "16:9", sizeLocked: true });
        expect(applyNodeConfigPatch(node, { size: "auto" }).metadata).toMatchObject({ size: "auto", sizeLocked: false });
    });

    it("keeps administrator and upstream generation counts above the former platform ceiling", () => {
        expect(getGenerationCount("16")).toBe(16);
        expect(getGenerationCount("120")).toBe(120);
        expect(getGenerationCount("0")).toBe(1);
        expect(getGenerationCount("-2")).toBe(1);
    });

    it("hides persisted Agent task nodes without hiding manual task nodes", () => {
        const agentTask = { ...configNode(180), type: CanvasNodeType.Task, metadata: { agentRunId: "run-1" } };
        const manualTask = { ...configNode(180), id: "manual-task", type: CanvasNodeType.Task };

        expect(isHiddenBatchChild(agentTask, [agentTask, manualTask])).toBe(true);
        expect(isHiddenBatchChild(manualTask, [agentTask, manualTask])).toBe(false);
    });
});

describe("Canvas media replacement", () => {
    it("removes stale generation state while preserving the new panorama contract", () => {
        const metadata = replaceCanvasNodeMediaMetadata(
            {
                prompt: "旧提示词",
                size: "1:1",
                videoTask: { id: "video-task", provider: "generation", model: "video-model" },
                imageTask: { id: "image-task", kind: "generation", model: "image-model" },
                imageEditMask: { storageKey: "mask.png" },
                imageEditValidationMask: { storageKey: "validation-mask.png" },
                preserveUnmaskedPixels: true,
                isBatchRoot: true,
                batchChildIds: ["child"],
            },
            { content: "/api/reference-assets/panorama.webp", storageKey: "panorama.webp", naturalWidth: 2048, naturalHeight: 1024, status: "success" },
            { size: "2048x1024", panoramaProjection: "equirectangular" },
        );

        expect(metadata).toMatchObject({ content: "/api/reference-assets/panorama.webp", size: "2048x1024", panoramaProjection: "equirectangular", status: "success" });
        expect(metadata.prompt).toBeUndefined();
        expect(metadata.imageTask).toBeUndefined();
        expect(metadata.imageEditMask).toBeUndefined();
        expect(metadata.imageEditValidationMask).toBeUndefined();
        expect(metadata.preserveUnmaskedPixels).toBeUndefined();
        expect(metadata.videoTask).toBeUndefined();
        expect(metadata.isBatchRoot).toBeUndefined();
        expect(metadata.batchChildIds).toBeUndefined();
    });

    it("restores a persisted image edit mask for stable retries", async () => {
        await expect(resolveMetadataImageEditMask({ imageEditMask: { storageKey: "mask.png", serverUrl: "/api/reference-assets/mask.png", mimeType: "image/png", width: 512, height: 512 } })).resolves.toMatchObject({
            id: "mask-mask.png",
            dataUrl: "/api/reference-assets/mask.png",
            storageKey: "mask.png",
            width: 512,
            height: 512,
        });
    });

    it("restores the persisted foreground validation mask for background checks", async () => {
        await expect(
            resolveMetadataImageEditValidationMask({
                imageEditValidationMask: { storageKey: "validation-mask.png", serverUrl: "/api/reference-assets/validation-mask.png", mimeType: "image/png", width: 512, height: 512 },
            }),
        ).resolves.toMatchObject({
            id: "validation-mask-validation-mask.png",
            dataUrl: "/api/reference-assets/validation-mask.png",
            storageKey: "validation-mask.png",
            width: 512,
            height: 512,
        });
    });

    it("restores current server media storage keys for image retries", async () => {
        await expect(resolveMetadataReferences({ generationType: "edit", references: ["permanent/2026/08/16/images/source.png"] })).resolves.toEqual([
            expect.objectContaining({ dataUrl: "/api/reference-assets/permanent/2026/08/16/images/source.png", storageKey: "permanent/2026/08/16/images/source.png" }),
        ]);
    });
});

function imageNode(id: string, storageKey: string): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 320,
        metadata: { content: `/legacy/${id}.png`, storageKey, naturalWidth: 1024, naturalHeight: 1024 },
    };
}

function textNode(): CanvasNodeData {
    return { id: "text", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: "内容" } };
}

function configNode(height: number): CanvasNodeData {
    return { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 0, y: 0 }, width: 340, height, metadata: { generationMode: "image" } };
}
