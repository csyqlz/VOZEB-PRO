import { describe, expect, it } from "vitest";

import type { CanvasProject } from "@/lib/canvas-project-contract";

import { cleanCanvasProjectMediaReferences, cleanUserMediaReferences } from "./user-media-reference-cleanup";

const storageKey = "permanent/2026/08/21/images/a b.png";
const mediaUrl = "/api/reference-assets/permanent/2026/08/21/images/a%20b.png";

describe("user media reference cleanup", () => {
    it("removes media descriptors while preserving unrelated values", () => {
        const result = cleanUserMediaReferences(
            {
                coverUrl: mediaUrl,
                candidates: [
                    { id: "deleted", dataUrl: mediaUrl, storageKey },
                    { id: "kept", dataUrl: "/api/reference-assets/permanent/kept.png", storageKey: "permanent/kept.png" },
                ],
                title: "保留标题",
            },
            [storageKey],
        );

        expect(result.changed).toBe(true);
        expect(result.value).toEqual({ candidates: [{ id: "kept", dataUrl: "/api/reference-assets/permanent/kept.png", storageKey: "permanent/kept.png" }], title: "保留标题" });
    });

    it("removes matching Canvas media nodes and their connections", () => {
        const project = {
            id: "canvas-one",
            title: "画布",
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:00:00.000Z",
            nodes: [
                { id: "image-one", type: "image", title: "失效图片", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: mediaUrl, storageKey } },
                { id: "text-one", type: "text", title: "保留文本", position: { x: 400, y: 0 }, width: 320, height: 160, metadata: { content: "正文" } },
            ],
            connections: [{ id: "connection-one", fromNodeId: "image-one", toNodeId: "text-one" }],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: true,
            viewport: { x: 0, y: 0, k: 1 },
        } as CanvasProject;

        const result = cleanCanvasProjectMediaReferences(project, [storageKey]);

        expect(result.removedNodeIds).toEqual(["image-one"]);
        expect(result.value.nodes.map((node) => node.id)).toEqual(["text-one"]);
        expect(result.value.connections).toEqual([]);
        expect(result.value.backgroundMode).toBe("lines");
    });
});
