import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { edgePath, expandCanvasDragNodeIds, findConnectionTarget, isBlockedConnectionDrop, isCanvasVideoControlPoint, nodeAnchor, previewPath, samePosition, selectNodesInBounds, worldFromScreen } from "./canvas-surface-geometry";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Text, title: "来源", position: { x: 100, y: 120 }, width: 240, height: 160, metadata: {} };
const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Image, title: "目标", position: { x: 500, y: 220 }, width: 300, height: 200, metadata: {} };

describe("canvas surface geometry", () => {
    it("converts screen coordinates through the viewport transform", () => {
        expect(worldFromScreen(330, 250, { x: 80, y: 40, k: 2 }, { left: 10, top: 10 })).toEqual({ x: 120, y: 100 });
    });

    it("keeps the video picture draggable while reserving the native control strip", () => {
        const rect = { bottom: 300, height: 200 };
        expect(isCanvasVideoControlPoint(rect, 200)).toBe(false);
        expect(isCanvasVideoControlPoint(rect, 270)).toBe(true);
    });

    it("uses node-side centers as connection anchors", () => {
        expect(nodeAnchor(source, "source")).toEqual({ x: 340, y: 200 });
        expect(nodeAnchor(target, "target")).toEqual({ x: 500, y: 320 });
        expect(edgePath(source, target)).toBe("M 340 200 C 420 200, 420 320, 500 320");
    });

    it("routes backward connections through a clear vertical gap", () => {
        const lowerTarget = { ...target, position: { x: 320, y: 280 }, width: 340, height: 240 };
        const shorterSource = { ...source, position: { x: 0, y: 0 }, width: 340, height: 210 };
        const path = edgePath(shorterSource, lowerTarget);

        expect(path).toContain(" Q ");
        expect(path).toContain("245");
        expect(path).not.toContain(" C ");
    });

    it("routes backward connections outside overlapping node bounds", () => {
        const from = { ...source, position: { x: 0, y: 0 }, width: 340, height: 240 };
        const to = { ...target, position: { x: 280, y: 80 }, width: 340, height: 240 };
        const path = edgePath(from, to);

        expect(path).toContain("-32");
        expect(path).toContain(" Q ");
    });

    it("routes around a node blocking the default connection path", () => {
        const blocker = { ...source, id: "blocker", position: { x: 390, y: 170 }, width: 60, height: 210 };
        const path = edgePath(source, target, [source, blocker, target]);

        expect(path).toContain("88");
        expect(path).not.toContain(" C ");
    });

    it("falls back to the stable route when every detour is blocked", () => {
        const blocker = { ...source, id: "blocker", position: { x: -1000, y: -1000 }, width: 3000, height: 3000 };

        expect(edgePath(source, target, [blocker])).toBe(edgePath(source, target));
    });

    it("builds previews in the direction of the active handle", () => {
        expect(previewPath({ x: 0, y: 20 }, { x: 100, y: 60 }, "source")).toBe("M 0 20 C 50 20, 50 60, 100 60");
        expect(previewPath({ x: 100, y: 60 }, { x: 0, y: 20 }, "target")).toBe("M 100 60 C 50 60, 50 20, 0 20");
        expect(previewPath({ x: 100, y: 60 }, { x: 160, y: 20 }, "target")).toContain(" Q ");
    });

    it("targets node bodies and nearby handles without selecting the origin", () => {
        expect(findConnectionTarget({ x: 510, y: 300 }, { nodeId: source.id, handleType: "source" }, [source, target], 1)).toBe(target.id);
        expect(findConnectionTarget({ x: 100, y: 200 }, { nodeId: source.id, handleType: "source" }, [source, target], 1)).toBeNull();
        expect(findConnectionTarget({ x: 449, y: 320 }, { nodeId: source.id, handleType: "source" }, [source, target], 1)).toBe(target.id);
    });

    it("blocks connection creation menus on the origin and invalid config sources", () => {
        const config = { ...target, id: "config", type: CanvasNodeType.Config };

        expect(isBlockedConnectionDrop({ x: 110, y: 180 }, { nodeId: source.id, handleType: "source" }, [source, config], 1)).toBe(true);
        expect(findConnectionTarget({ x: 510, y: 300 }, { nodeId: source.id, handleType: "target" }, [source, config], 1)).toBeNull();
        expect(isBlockedConnectionDrop({ x: 510, y: 300 }, { nodeId: source.id, handleType: "target" }, [source, config], 1)).toBe(true);
        expect(isBlockedConnectionDrop({ x: 900, y: 700 }, { nodeId: source.id, handleType: "source" }, [source, config], 1)).toBe(false);
    });

    it("tolerates subpixel position differences only", () => {
        expect(samePosition({ x: 10, y: 20 }, { x: 10.005, y: 20.005 })).toBe(true);
        expect(samePosition({ x: 10, y: 20 }, { x: 10.02, y: 20 })).toBe(false);
    });

    it("adds box hits to an existing multi-selection", () => {
        expect(selectNodesInBounds([source, target], { x: 450, y: 180 }, { x: 820, y: 440 }, [source.id])).toEqual(new Set([source.id, target.id]));
    });

    it("moves hidden image-batch children with the selected root", () => {
        const root = { ...source, metadata: { batchChildIds: ["child-a", "child-b"] } };
        expect(expandCanvasDragNodeIds([root, target], [root.id, target.id])).toEqual([root.id, target.id, "child-a", "child-b"]);
    });
});
