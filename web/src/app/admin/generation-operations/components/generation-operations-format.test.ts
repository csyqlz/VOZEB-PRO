import { describe, expect, it } from "vitest";

import { formatGenerationDuration } from "./generation-operations-format";

describe("formatGenerationDuration", () => {
    it("normalizes rounded seconds into the next minute", () => {
        expect(formatGenerationDuration(119_600)).toBe("2 分 0 秒");
        expect(formatGenerationDuration(60_000)).toBe("1 分 0 秒");
    });

    it("keeps zero and sub-minute values readable", () => {
        expect(formatGenerationDuration(0)).toBe("0 秒");
        expect(formatGenerationDuration(400)).toBe("1 秒");
        expect(formatGenerationDuration(59_400)).toBe("59 秒");
    });
});
