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

import { appendConnectionWithDirectorRules, applyNodeConfigPatch, getGenerationCount, hydrateAssistantImages, hydrateCanvasImages, normalizeCanvasConfigNodeLayout, normalizeConnection, replaceCanvasNodeMediaMetadata } from "./canvas-page-utils";

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
});

describe("Canvas config node layout", () => {
    it("keeps the persisted details state and node hit box in sync", () => {
        const collapsed = normalizeCanvasConfigNodeLayout(configNode(320));
        const expanded = applyNodeConfigPatch(collapsed, { configDetailsOpen: true });

        expect(collapsed).toMatchObject({ height: CANVAS_CONFIG_NODE_HEIGHT.collapsed, metadata: { configDetailsOpen: false } });
        expect(expanded).toMatchObject({ height: CANVAS_CONFIG_NODE_HEIGHT.expanded, metadata: { configDetailsOpen: true } });
    });

    it("keeps administrator and upstream generation counts above the former platform ceiling", () => {
        expect(getGenerationCount("16")).toBe(16);
        expect(getGenerationCount("120")).toBe(120);
        expect(getGenerationCount("0")).toBe(1);
        expect(getGenerationCount("-2")).toBe(1);
    });
});

describe("3D director desk connections", () => {
    const image = imageNode("image", "image.webp");
    const panorama = { ...imageNode("panorama", "panorama.webp"), type: CanvasNodeType.Panorama };
    const director: CanvasNodeData = { id: "director", type: CanvasNodeType.Director, title: "3D导演台", position: { x: 0, y: 0 }, width: 420, height: 260 };
    const text = textNode();

    it("only accepts image inputs and image outputs", () => {
        expect(normalizeConnection(image.id, director.id, [image, director], "source")).toEqual({ fromNodeId: image.id, toNodeId: director.id });
        expect(normalizeConnection(panorama.id, director.id, [panorama, director], "source")).toEqual({ fromNodeId: panorama.id, toNodeId: director.id });
        expect(normalizeConnection(director.id, image.id, [director, image], "source")).toEqual({ fromNodeId: director.id, toNodeId: image.id });
        expect(normalizeConnection(text.id, director.id, [text, director], "source")).toBeNull();
    });

    it("keeps only the latest panorama input", () => {
        const existing = { id: "old", fromNodeId: image.id, toNodeId: director.id };
        const replacement = { id: "new", fromNodeId: panorama.id, toNodeId: director.id };
        expect(appendConnectionWithDirectorRules([existing], replacement, [image, panorama, director])).toEqual([replacement]);
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
                isBatchRoot: true,
                batchChildIds: ["child"],
            },
            { content: "/api/reference-assets/panorama.webp", storageKey: "panorama.webp", naturalWidth: 2048, naturalHeight: 1024, status: "success" },
            { size: "2048x1024", panoramaProjection: "equirectangular" },
        );

        expect(metadata).toMatchObject({ content: "/api/reference-assets/panorama.webp", size: "2048x1024", panoramaProjection: "equirectangular", status: "success" });
        expect(metadata.prompt).toBeUndefined();
        expect(metadata.imageTask).toBeUndefined();
        expect(metadata.videoTask).toBeUndefined();
        expect(metadata.isBatchRoot).toBeUndefined();
        expect(metadata.batchChildIds).toBeUndefined();
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
