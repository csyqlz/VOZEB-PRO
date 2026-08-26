import { describe, expect, it } from "vitest";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { buildNodeGenerationContext } from "./canvas-node-generation";

describe("buildNodeGenerationContext", () => {
    it("uses every connected input when the composer has no explicit node mention", () => {
        const context = buildNodeGenerationContext("config", nodes(), connections(), "生成一个新版本");

        expect(context.prompt).toContain("生成一个新版本");
        expect(context.prompt).toContain("【文本1】\n保持红色包装");
        expect(context.referenceImages.map((item) => item.id)).toEqual(["image"]);
        expect(context.referenceVideos.map((item) => item.id)).toEqual(["video"]);
        expect(context).toMatchObject({ textCount: 1, imageCount: 1, videoCount: 1, audioCount: 0 });
    });

    it("keeps explicit node mentions exclusive", () => {
        const context = buildNodeGenerationContext("config", nodes(), connections(), "基于 @[node:image] 生成一个新版本");

        expect(context.prompt).toContain("基于 图片1 生成一个新版本");
        expect(context.prompt).not.toContain("保持红色包装");
        expect(context.referenceImages.map((item) => item.id)).toEqual(["image"]);
        expect(context.referenceVideos).toEqual([]);
        expect(context).toMatchObject({ textCount: 0, imageCount: 1, videoCount: 0, audioCount: 0 });
    });
});

function nodes(): CanvasNodeData[] {
    return [
        node("image", CanvasNodeType.Image, { content: "data:image/png;base64,image" }),
        node("video", CanvasNodeType.Video, { content: "/api/generation-log-assets/video" }),
        node("text", CanvasNodeType.Text, { content: "保持红色包装" }),
        node("config", CanvasNodeType.Config, { composerContent: "生成一个新版本" }),
    ];
}

function connections(): CanvasConnection[] {
    return [
        { id: "image-config", fromNodeId: "image", toNodeId: "config" },
        { id: "video-config", fromNodeId: "video", toNodeId: "config" },
        { id: "text-config", fromNodeId: "text", toNodeId: "config" },
    ];
}

function node(id: string, type: CanvasNodeType, metadata: NonNullable<CanvasNodeData["metadata"]>): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 320, height: 240, metadata };
}
