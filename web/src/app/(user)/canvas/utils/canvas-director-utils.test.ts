import { describe, expect, it } from "vitest";

import { aspectRatioOf, clamp, equirectCropRect, frameToPixelRect, DIRECTOR_ASPECT_RATIOS } from "./canvas-director-utils";

describe("canvas director utils", () => {
    it("提供常用机位画幅并换算比例", () => {
        expect(DIRECTOR_ASPECT_RATIOS.map((item) => item.value)).toEqual(["16:9", "9:16", "1:1", "4:3", "3:2"]);
        expect(aspectRatioOf("16:9")).toBeCloseTo(16 / 9, 6);
        expect(aspectRatioOf("9:16")).toBeCloseTo(9 / 16, 6);
        expect(aspectRatioOf("1:1")).toBe(1);
    });

    it("全景正视时裁剪框居中且按视场缩放", () => {
        const rect = equirectCropRect(0, 0, 90, 16 / 9, 4096, 2048);
        expect(rect.wraps).toBe(false);
        expect(rect.height).toBe(1024);
        expect(rect.width).toBe(Math.round(1024 * (16 / 9)));
        expect(rect.left).toBe(Math.round((4096 - rect.width) / 2));
        expect(rect.top).toBe(Math.round((2048 - 1024) / 2));
    });

    it("俯仰与偏航会移动裁剪中心且不越界", () => {
        const up = equirectCropRect(0, Math.PI / 4, 60, 1, 2000, 1000);
        const down = equirectCropRect(0, -Math.PI / 4, 60, 1, 2000, 1000);
        expect(up.top).toBeLessThan(down.top);

        const right = equirectCropRect(Math.PI / 3, 0, 60, 1, 2000, 1000);
        const left = equirectCropRect(-Math.PI / 3, 0, 60, 1, 2000, 1000);
        expect(right.left).toBeGreaterThan(left.left);
        expect(left.left).toBeGreaterThanOrEqual(0);
        expect(right.left + right.width).toBeLessThanOrEqual(2000);
    });

    it("偏航跨越全景边缘时标记 wraps", () => {
        const rect = equirectCropRect(Math.PI - 0.02, 0, 100, 3 / 2, 2000, 1000);
        expect(rect.wraps).toBe(true);
    });

    it("机位框换算为像素并约束在舞台内", () => {
        const rect = frameToPixelRect({ x: 0.5, y: 0.5, width: 0.5, aspect: "16:9" }, 1000, 600);
        expect(rect.width).toBe(500);
        expect(rect.height).toBeCloseTo(500 / (16 / 9), 4);
        expect(rect.x).toBeCloseTo(250, 4);
        expect(rect.y).toBeLessThanOrEqual(600);
        expect(clamp(rect.y, 0, 600 - rect.height)).toBe(rect.y);
    });
});
