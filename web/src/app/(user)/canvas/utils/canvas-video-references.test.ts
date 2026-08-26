import { describe, expect, it } from "vitest";

import type { ReferenceImage } from "@/types/image";

import type { CanvasNodeMetadata, CanvasVideoFrameSelection } from "../types";
import { canvasVideoFrameSelectionPatch, canvasVideoReferenceMetadata, canvasVideoReferenceModePatch, resolveCanvasVideoGenerationReferences, restoreCanvasVideoGenerationReferences } from "./canvas-video-references";

describe("Canvas video references", () => {
    it("clears frame roles when switching to a less specific reference mode", () => {
        expect(canvasVideoReferenceModePatch("reference")).toEqual({ videoReferenceMode: "reference", videoFirstFrame: undefined, videoLastFrame: undefined });
        expect(canvasVideoReferenceModePatch("first_frame")).toEqual({ videoReferenceMode: "first_frame", videoLastFrame: undefined });
        expect(canvasVideoReferenceModePatch("first_last")).toEqual({ videoReferenceMode: "first_last" });
    });

    it("moves the same image between first and last frame instead of duplicating the role", () => {
        const selection = frameSelection("frame-one", "https://cdn.example.com/frame-one.webp");
        expect(canvasVideoFrameSelectionPatch({ videoLastFrame: selection }, "first_frame", selection)).toEqual({ videoFirstFrame: selection, videoLastFrame: undefined });
        expect(canvasVideoFrameSelectionPatch({ videoFirstFrame: selection }, "last_frame", selection)).toEqual({ videoLastFrame: selection, videoFirstFrame: undefined });
    });

    it("includes an explicitly selected first frame even when it is absent from composer tokens", () => {
        const first = image("frame-one", "https://cdn.example.com/frame-one.webp");
        const resolved = resolveCanvasVideoGenerationReferences({
            metadata: { videoReferenceMode: "first_frame", videoFirstFrame: frameSelection(first.id, first.url!) },
            context: emptyContext(),
            availableInputs: [{ image: first }],
        });

        expect(resolved.mode).toBe("first_frame");
        expect(resolved.images).toMatchObject([{ id: "frame-one", videoRole: "first_frame" }]);
        expect(canvasVideoReferenceMetadata(resolved)).toMatchObject({
            videoReferenceMode: "first_frame",
            videoReferences: [{ id: "frame-one", role: "first_frame", source: "https://cdn.example.com/frame-one.webp" }],
            references: ["https://cdn.example.com/frame-one.webp"],
        });
    });

    it("uses the current image node as the sole primary reference for ordinary image-to-video", () => {
        const source = image("current-image", "https://cdn.example.com/current.webp");
        const upstream = image("upstream-image", "https://cdn.example.com/upstream.webp");
        const resolved = resolveCanvasVideoGenerationReferences({
            metadata: { videoReferenceMode: "reference" },
            context: { ...emptyContext(), referenceImages: [upstream] },
            availableInputs: [{ image: upstream }],
            sourceImage: source,
        });

        expect(resolved.images).toMatchObject([{ id: "current-image", videoRole: "reference" }]);
        expect(resolved.snapshots).toMatchObject([{ id: "current-image", role: "reference", source: "https://cdn.example.com/current.webp" }]);
    });

    it("keeps first frame, last frame and ordinary references as distinct request roles", () => {
        const first = image("frame-one", "https://cdn.example.com/frame-one.webp");
        const last = image("frame-two", "https://cdn.example.com/frame-two.webp");
        const regular = image("style-reference", "https://cdn.example.com/style.webp");
        const resolved = resolveCanvasVideoGenerationReferences({
            metadata: {
                videoReferenceMode: "first_last",
                videoFirstFrame: frameSelection(first.id, first.url!),
                videoLastFrame: frameSelection(last.id, last.url!),
            },
            context: { ...emptyContext(), referenceImages: [regular] },
            availableInputs: [{ image: first }, { image: last }, { image: regular }],
        });

        expect(resolved.images.map((item) => [item.id, item.videoRole])).toEqual([
            ["frame-one", "first_frame"],
            ["frame-two", "last_frame"],
            ["style-reference", "reference"],
        ]);
        expect(resolved.snapshots.map((item) => item.role)).toEqual(["first_frame", "last_frame", "reference"]);
    });

    it("restores persisted frame snapshots after source nodes and connections are gone", () => {
        const metadata: CanvasNodeMetadata = {
            videoReferenceMode: "first_last",
            videoFirstFrame: frameSelection("frame-one", "permanent/frames/first.webp"),
            videoLastFrame: frameSelection("frame-two", "permanent/frames/last.webp"),
            videoReferences: [snapshot("frame-one", "first_frame", "permanent/frames/first.webp"), snapshot("frame-two", "last_frame", "permanent/frames/last.webp")],
        };

        const restored = restoreCanvasVideoGenerationReferences(metadata);

        expect(restored?.images).toMatchObject([
            { id: "frame-one", storageKey: "permanent/frames/first.webp", videoRole: "first_frame" },
            { id: "frame-two", storageKey: "permanent/frames/last.webp", videoRole: "last_frame" },
        ]);
        expect(restored?.snapshots).toEqual(metadata.videoReferences);
    });

    it("rejects an incomplete persisted first-last-frame snapshot", () => {
        expect(() =>
            restoreCanvasVideoGenerationReferences({
                videoReferenceMode: "first_last",
                videoReferences: [snapshot("frame-one", "first_frame", "permanent/frames/first.webp")],
            }),
        ).toThrow("请先选择视频尾帧图片");
    });
});

function image(id: string, url: string): ReferenceImage {
    return { id, name: `${id}.webp`, type: "image/webp", dataUrl: url, url, width: 1280, height: 720 };
}

function frameSelection(nodeId: string, source: string): CanvasVideoFrameSelection {
    return { nodeId, title: nodeId, source, previewUrl: source, width: 1280, height: 720, mimeType: "image/webp" };
}

function snapshot(id: string, role: "first_frame" | "last_frame", source: string) {
    return { type: "image" as const, role, id, name: `${id}.webp`, mimeType: "image/webp", source, previewUrl: `/api/reference-assets/${source}`, storageKey: source, width: 1280, height: 720 };
}

function emptyContext() {
    return { referenceImages: [], referenceVideos: [], referenceAudios: [] };
}
