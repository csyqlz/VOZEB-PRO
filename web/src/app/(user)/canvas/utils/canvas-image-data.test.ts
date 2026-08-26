import { describe, expect, it } from "vitest";

import {
    applySubjectMaskToCropImageData,
    applySubjectMaskToImageData,
    assertCanvasImageEditChanged,
    compositeImageDataWithinMask,
    expandLayerBox,
    expandLayerRemovalBox,
    findCanvasAlphaBounds,
    measureCanvasImageEditChange,
    resolveCanvasImageDecompositionSource,
    scaleLayerBox,
} from "./canvas-image-data";

describe("Canvas 智能分层", () => {
    it("优先向识别接口发送稳定媒体地址而不是大体积内联图片", () => {
        expect(resolveCanvasImageDecompositionSource({ content: "data:image/png;base64,very-large", serverUrl: "/api/reference-assets/permanent/source.png" })).toBe("/api/reference-assets/permanent/source.png");
    });

    it("按语义蒙版保留浅色主体，不再根据主体与背景色差判断", () => {
        const data = new Uint8ClampedArray(3 * 3 * 4);
        for (let index = 0; index < 9; index += 1) data.set(index === 4 ? [242, 230, 222, 255] : [248, 239, 231, 255], index * 4);
        const result = applySubjectMaskToImageData({ data, width: 3, height: 3 }, { width: 3, height: 3, data: new Float32Array([0, 0, 0, 0.85, 1, 0.85, 0, 0.8, 0]) });

        expect(result.foregroundPixels).toBe(4);
        expect(result.backgroundPixels).toBe(5);
        expect(result.foreground[3]).toBe(0);
        expect(result.foreground[4 * 4 + 3]).toBe(255);
        expect(result.foreground[3 * 4 + 3]).toBeGreaterThan(200);
        expect(result.editMask[3]).toBe(255);
        expect(result.editMask[4 * 4 + 3]).toBe(0);
        expect(result.editMask[3 * 4 + 3]).toBeLessThan(50);
    });

    it("将低分辨率语义蒙版平滑重采样到原图尺寸", () => {
        const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
        const result = applySubjectMaskToImageData({ data, width: 4, height: 4 }, { width: 2, height: 2, data: new Float32Array([0, 1, 0, 1]) });

        expect(result.foreground[3]).toBe(0);
        expect(result.foreground[(4 - 1) * 4 + 3]).toBe(255);
        expect(result.foreground[1 * 4 + 3]).toBeGreaterThan(0);
        expect(result.foreground[1 * 4 + 3]).toBeLessThan(255);
    });

    it("按服务端原图坐标缩放电商元素边界且不裁掉边缘", () => {
        expect(scaleLayerBox({ x: 101, y: 51, width: 199, height: 99 }, 1000, 500, 500, 250)).toEqual({ x: 50, y: 25, width: 100, height: 50 });
        expect(scaleLayerBox({ x: 900, y: 450, width: 100, height: 50 }, 1000, 500, 333, 167)).toEqual({ x: 299, y: 150, width: 34, height: 17 });
    });

    it("为透明资产编辑保留上下文且不越出原图", () => {
        expect(expandLayerBox({ x: 100, y: 80, width: 160, height: 80 }, 400, 300)).toEqual({ x: 84, y: 64, width: 192, height: 112 });
        expect(expandLayerBox({ x: 0, y: 0, width: 80, height: 80 }, 400, 300)).toEqual({ x: 0, y: 0, width: 96, height: 96 });
    });

    it("背景补全范围覆盖完整语义元素并保留小幅上下文", () => {
        expect(expandLayerRemovalBox({ x: 100, y: 80, width: 160, height: 80 }, 400, 300)).toEqual({ x: 96, y: 76, width: 168, height: 88 });
        expect(expandLayerRemovalBox({ x: 0, y: 0, width: 40, height: 20 }, 400, 300)).toEqual({ x: 0, y: 0, width: 43, height: 23 });
    });

    it("裁掉透明轮廓四周的空白像素", () => {
        const data = new Uint8ClampedArray(5 * 4 * 4);
        data[(1 * 5 + 2) * 4 + 3] = 255;
        data[(2 * 5 + 3) * 4 + 3] = 32;
        expect(findCanvasAlphaBounds({ data, width: 5, height: 4 })).toEqual({ x: 2, y: 1, width: 2, height: 2 });
        expect(findCanvasAlphaBounds({ data: new Uint8ClampedArray(5 * 4 * 4), width: 5, height: 4 })).toBeNull();
    });

    it("按目标主体蒙版将电商商品裁片背景变为透明而不是保留矩形底图", () => {
        const source = pixels([20, 30, 40, 255], [80, 90, 100, 255], [140, 150, 160, 255]);
        const result = applySubjectMaskToCropImageData(source, { x: 1, y: 0, width: 3, height: 1 }, 5, 1, { width: 5, height: 1, data: new Float32Array([0, 0, 1, 0.5, 0]) });

        expect([...result.data]).toEqual([20, 30, 40, 0, 80, 90, 100, 255, 140, 150, 160, 128]);
    });

    it("背景补全只替换透明蒙版区域并保留其余原始像素", () => {
        const source = pixels([10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255]);
        const generated = pixels([110, 120, 130, 255], [140, 150, 160, 255], [170, 180, 190, 255]);
        const mask = pixels([255, 255, 255, 255], [255, 255, 255, 0], [255, 255, 255, 128]);

        const result = compositeImageDataWithinMask(source, generated, mask);

        expect([...result.data]).toEqual([10, 20, 30, 255, 140, 150, 160, 255, 120, 130, 140, 255]);
    });

    it("拒绝编辑区域仍与原图基本一致的伪背景", () => {
        const source = pixels([10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255]);
        const generated = pixels([220, 210, 200, 255], [41, 50, 61, 255], [70, 80, 90, 255]);
        const mask = pixels([255, 255, 255, 255], [255, 255, 255, 0], [255, 255, 255, 0]);

        expect(() => assertCanvasImageEditChanged(source, generated, mask)).toThrow("背景补全未清除原有元素");
    });

    it("接受编辑区域明显变化的干净背景", () => {
        const source = pixels([10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255]);
        const generated = pixels([10, 20, 30, 255], [140, 150, 160, 255], [170, 180, 190, 255]);
        const mask = pixels([255, 255, 255, 255], [255, 255, 255, 0], [255, 255, 255, 0]);

        expect(assertCanvasImageEditChanged(source, generated, mask)).toMatchObject({ editedPixels: 2, changedPixels: 2, changedRatio: 1 });
    });

    it("用真实元素 Alpha 单独验收，拒绝只改大区域却保留元素的背景", () => {
        const source = pixels([10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255]);
        const generated = pixels([210, 220, 230, 255], [140, 150, 160, 255], [70, 80, 90, 255]);
        const elementAlpha = pixels([255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 0]);

        expect(() => assertCanvasImageEditChanged(source, generated, elementAlpha)).toThrow("背景补全未清除原有元素");
    });

    it("背景蒙版外的变化不参与清理成功判断", () => {
        const source = pixels([10, 20, 30, 255], [40, 50, 60, 255]);
        const generated = pixels([240, 230, 220, 255], [40, 50, 60, 255]);
        const mask = pixels([255, 255, 255, 255], [255, 255, 255, 0]);

        expect(measureCanvasImageEditChange(source, generated, mask)).toMatchObject({ editedPixels: 1, changedPixels: 0, changedRatio: 0, meanAbsoluteDifference: 0 });
    });
});

function pixels(...values: number[][]) {
    return { data: new Uint8ClampedArray(values.flat()), width: values.length, height: 1 };
}
