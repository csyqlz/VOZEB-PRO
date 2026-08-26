import { describe, expect, it } from "vitest";

import { splitDramaScriptAtBoundary } from "./drama-analysis-segmentation";

describe("drama analysis script segmentation", () => {
    it("splits near the middle without cutting through quoted dialogue", () => {
        const script = "林照雪低声道：“忍着点，过程会有些痛苦。”\n云舒咬紧牙关：“无妨，你尽管施为。”";
        const result = splitDramaScriptAtBoundary(script);

        expect(result).toEqual(["林照雪低声道：“忍着点，过程会有些痛苦。”", "云舒咬紧牙关：“无妨，你尽管施为。”"]);
    });

    it("returns no split when the input has no safe paragraph or sentence boundary", () => {
        expect(splitDramaScriptAtBoundary("一段没有任何安全边界的连续文本")).toBeNull();
    });
});
