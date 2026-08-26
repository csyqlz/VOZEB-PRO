import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { applyCanvasImageLayerTaskResults, applyCanvasImageTaskResults } from "./canvas-image-task-results";

describe("canvas image task results", () => {
    it("keeps every upstream image and replays the same task idempotently", () => {
        const target: CanvasNodeData = {
            id: "target",
            type: CanvasNodeType.Image,
            title: "生成图片",
            position: { x: 0, y: 0 },
            width: 320,
            height: 320,
            metadata: { status: "loading", imageTask: { id: "task-one", kind: "edit", model: "image-model" } },
        };
        const input = {
            nodeId: target.id,
            taskId: "task-one",
            model: "image-model",
            size: "16:9",
            images: [
                { width: 1600, height: 900, metadata: { content: "/api/generation-log-assets/first.png", status: "success" as const } },
                { width: 900, height: 1600, metadata: { content: "/api/generation-log-assets/second.png", status: "success" as const } },
            ],
        };

        const first = applyCanvasImageTaskResults([target], input);
        const replay = applyCanvasImageTaskResults(first, input);

        expect(first).toHaveLength(2);
        expect(first[0]?.metadata).toMatchObject({ content: "/api/generation-log-assets/first.png", imageTask: undefined });
        expect(first[1]).toMatchObject({ id: "image-result-task-one-2", metadata: { content: "/api/generation-log-assets/second.png" } });
        expect(first[1]?.position.x).toBeGreaterThanOrEqual((first[0]?.position.x || 0) + (first[0]?.width || 0));
        expect(replay).toHaveLength(2);
    });

    it("creates one independent node per upstream layer and replays idempotently", () => {
        const target: CanvasNodeData = {
            id: "layers",
            type: CanvasNodeType.Image,
            title: "商品图 · 分层中",
            position: { x: 0, y: 0 },
            width: 420,
            height: 320,
            metadata: { status: "loading", imageOutputMode: "layers", imageTask: { id: "task-layers", kind: "edit", model: "layer-model" } },
        };
        const input = {
            nodeId: target.id,
            taskId: "task-layers",
            model: "layer-model",
            images: [
                { width: 800, height: 800, metadata: { content: "/api/generation-log-assets/layer-a.png", storageKey: "layer-a.png", status: "success" as const } },
                { width: 800, height: 800, metadata: { content: "/api/generation-log-assets/layer-b.png", storageKey: "layer-b.png", status: "success" as const } },
            ],
        };

        const first = applyCanvasImageLayerTaskResults([target], input);
        const replay = applyCanvasImageLayerTaskResults(first, input);

        expect(first).toHaveLength(2);
        expect(first[0]).toMatchObject({ id: "layers", title: "图层 1", metadata: { storageKey: "layer-a.png", imageOutputMode: "layers", imageLayerTaskId: "task-layers", imageLayerResultIndex: 0, imageTask: undefined } });
        expect(first[1]).toMatchObject({ id: "image-layer-task-layers-2", title: "图层 2", metadata: { storageKey: "layer-b.png", imageLayerTaskId: "task-layers", imageLayerResultIndex: 1 } });
        expect(first[1]?.position.x).toBeGreaterThanOrEqual((first[0]?.position.x || 0) + (first[0]?.width || 0));
        expect(replay).toEqual(first);
    });
});
