import { describe, expect, it } from "vitest";

import { ANNOTATION_COLORS, annotationStrokeScale, arrowHeadPoints, type CanvasAnnotation } from "./canvas-annotation-utils";

describe("canvas 标注工具", () => {
    it("箭头头部两个底角位于箭头方向两侧且在箭头尖端后方", () => {
        const points = arrowHeadPoints({ x: 100, y: 100 }, { x: 200, y: 100 }, 1);
        expect(points).toHaveLength(2);
        for (const point of points) {
            expect(point.x).toBeLessThan(200);
            expect(point.x).toBeGreaterThan(150);
        }
        expect(points[0].y === 100 || points[1].y === 100).toBe(false);
        // 画布坐标 y 向下，两个底角应分居箭杆两侧（乘积为负）
        expect((points[0].y - 100) * (points[1].y - 100)).toBeLessThan(0);
    });

    it("水平箭头的两个底角关于箭杆对称", () => {
        const points = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
        expect(points[0].y).toBeCloseTo(-points[1].y, 8);
        expect(points[0].x).toBeCloseTo(points[1].x, 8);
    });

    it("斜向箭头的头部仍指向行进方向", () => {
        const points = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 100 }, 2);
        const tip = { x: 100, y: 100 };
        for (const point of points) {
            const distance = Math.hypot(point.x - tip.x, point.y - tip.y);
            expect(distance).toBeCloseTo(22 * 2, 5);
        }
    });

    it("描边比例随图片尺寸增大而增大且不小于 1", () => {
        expect(annotationStrokeScale(800, 600)).toBe(1);
        expect(annotationStrokeScale(2048, 1152)).toBeGreaterThan(1);
        expect(annotationStrokeScale(4096, 2160)).toBeGreaterThan(annotationStrokeScale(2048, 1152));
    });

    it("标注调色板始终提供可用颜色", () => {
        expect(ANNOTATION_COLORS.length).toBeGreaterThanOrEqual(2);
        for (const color of ANNOTATION_COLORS) expect(color.value).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it("标注类型覆盖箭头与文字两种形态", () => {
        const annotations: CanvasAnnotation[] = [
            { kind: "arrow", id: "a1", from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, color: "#ff4d4f" },
            { kind: "text", id: "t1", at: { x: 5, y: 5 }, text: "改这里", color: "#fadb14" },
        ];
        expect(annotations.map((annotation) => annotation.kind)).toEqual(["arrow", "text"]);
    });
});
