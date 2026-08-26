import { describe, expect, it, vi } from "vitest";

import { buildImageToolbarTools, defaultImageQuickToolIds, readImageQuickToolsConfig } from "./canvas-image-toolbar-tools";
import { CanvasNodeType, type CanvasNodeData } from "../types";

const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/image.png" } };

describe("Canvas 图片快捷工具", () => {
    it("默认展示分层、消除背景和表情参考入口", () => {
        expect(defaultImageQuickToolIds).toEqual(expect.arrayContaining(["splitLayers", "removeBackground", "emotion"]));
        const handlers = Object.fromEntries(
            ["onUpload", "onToggleFreeResize", "onMaskEdit", "onCrop", "onSplit", "onSplitLayers", "onRemoveBackground", "onEmotion", "onUpscale", "onSuperResolve", "onAngle", "onViewImage", "onCopyPrompt", "onReversePrompt"].map((key) => [key, vi.fn()]),
        ) as unknown as Parameters<typeof buildImageToolbarTools>[1];
        const tools = buildImageToolbarTools(node, handlers);
        expect(tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(["splitLayers", "removeBackground", "emotion"]));
        expect(tools.find((tool) => tool.id === "splitLayers")?.title).toBe("智能分层");
        expect(tools.find((tool) => tool.id === "removeBackground")?.title).toBe("消除背景");
        tools.find((tool) => tool.id === "splitLayers")?.onClick();
        tools.find((tool) => tool.id === "removeBackground")?.onClick();
        tools.find((tool) => tool.id === "emotion")?.onClick();
        expect(handlers.onSplitLayers).toHaveBeenCalledWith(node);
        expect(handlers.onRemoveBackground).toHaveBeenCalledWith(node);
        expect(handlers.onEmotion).toHaveBeenCalledWith(node);
    });

    it("旧配置仍只接受已知工具 ID", () => {
        const result = readImageQuickToolsConfig({ ids: ["splitLayers", "unknown", "emotion"] });
        expect(result.ids).toEqual(["splitLayers", "emotion"]);
    });
});
