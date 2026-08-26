import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { buildCanvasSpatialIndex, canvasNodeBounds, canvasNodesBounds } from "./canvas-spatial-index";

function node(id: string, x: number, y: number, width = 100, height = 80): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title: id, position: { x, y }, width, height, metadata: {} };
}

describe("canvas spatial index", () => {
    it("returns only intersecting nodes without duplicate bucket hits", () => {
        const items = [node("left", 0, 0), node("right", 700, 0), node("wide", 400, 0, 700, 80)];
        const index = buildCanvasSpatialIndex(items, canvasNodeBounds);

        expect(
            index
                .query({ left: 450, top: -10, right: 520, bottom: 90 })
                .map((item) => item.id)
                .sort(),
        ).toEqual(["wide"]);
        expect(index.queryPoint({ x: 1200, y: 40 }, 10).map((item) => item.id)).toEqual([]);
    });

    it("computes stable padded bounds for empty and populated canvases", () => {
        expect(canvasNodesBounds([])).toEqual({ left: -500, top: -400, right: 500, bottom: 400 });
        expect(canvasNodesBounds([node("a", 100, 200, 300, 400)])).toEqual({ left: -220, top: -40, right: 720, bottom: 840 });
    });
});
