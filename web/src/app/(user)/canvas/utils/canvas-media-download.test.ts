import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { selectedCanvasMediaNodes } from "./canvas-media-download";

const node = (id: string, type: CanvasNodeType, content?: string): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 240, height: 160, metadata: { content } });

describe("Canvas 选中媒体下载", () => {
    it("只保留已选且有内容的图片、全景图和视频", () => {
        const nodes = [
            node("image", CanvasNodeType.Image, "data:image/png;base64,AA=="),
            node("panorama", CanvasNodeType.Panorama, "data:image/png;base64,AA=="),
            node("video", CanvasNodeType.Video, "data:video/mp4;base64,AA=="),
            node("audio", CanvasNodeType.Audio, "data:audio/mpeg;base64,AA=="),
            node("text", CanvasNodeType.Text, "说明"),
            node("empty-image", CanvasNodeType.Image),
        ];

        expect(selectedCanvasMediaNodes(nodes, new Set(nodes.map((item) => item.id))).map((item) => item.id)).toEqual(["image", "panorama", "video"]);
        expect(selectedCanvasMediaNodes(nodes, new Set(["video", "text"])).map((item) => item.id)).toEqual(["video"]);
    });
});
