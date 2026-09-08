import { describe, expect, it } from "vitest";

import { formatElapsed } from "./use-elapsed-timer";

describe("formatElapsed", () => {
    it("秒级耗时直接显示秒", () => {
        expect(formatElapsed(0)).toBe("0 秒");
        expect(formatElapsed(45_000)).toBe("45 秒");
        expect(formatElapsed(59_000)).toBe("59 秒");
    });

    it("分钟级耗时显示分与两位秒", () => {
        expect(formatElapsed(60_000)).toBe("1 分 00 秒");
        expect(formatElapsed(125_000)).toBe("2 分 05 秒");
        expect(formatElapsed(600_000)).toBe("10 分 00 秒");
    });
});
