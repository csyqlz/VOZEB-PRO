import { describe, expect, it } from "vitest";

import { imageEditRegionFromRgba, normalizeImageEditRegion } from "./image-edit-region";

describe("image edit regions", () => {
    it("calculates normalized inclusive pixel bounds and their center", () => {
        const rgba = new Uint8ClampedArray(4 * 4 * 3);
        for (const [x, y] of [
            [1, 1],
            [2, 1],
            [2, 2],
        ]) {
            rgba[(y * 4 + x) * 4 + 3] = 255;
        }

        expect(imageEditRegionFromRgba(rgba, 4, 3)).toEqual({
            left: 0.25,
            top: 1 / 3,
            right: 0.75,
            bottom: 1,
            centerX: 0.5,
            centerY: 2 / 3,
        });
    });

    it("rejects empty selections and normalizes untrusted coordinates", () => {
        expect(imageEditRegionFromRgba(new Uint8ClampedArray(16), 2, 2)).toBeUndefined();
        expect(normalizeImageEditRegion({ left: -1, top: 0.25, right: 2, bottom: 0.75, centerX: 9, centerY: -4 })).toEqual({
            left: 0,
            top: 0.25,
            right: 1,
            bottom: 0.75,
            centerX: 0.5,
            centerY: 0.5,
        });
    });
});
