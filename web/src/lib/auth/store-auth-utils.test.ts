import { describe, expect, it } from "vitest";

import { randomNumericCode, validateUsername } from "./store-auth-utils";

describe("authentication codes", () => {
    it("creates fixed-width six digit codes", () => {
        const codes = Array.from({ length: 100 }, () => randomNumericCode());
        expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
    });
});

describe("account validation", () => {
    it.each(["星启", "星启2026", "2026", "xingqi2026", "星启_2026"])('accepts consumer account "%s"', (account) => {
        expect(() => validateUsername(account)).not.toThrow();
    });

    it.each(["星", "a", "星 启", "星启!", ""])('rejects unsupported account "%s"', (account) => {
        expect(() => validateUsername(account)).toThrow("账号需为 2-32 位中文、字母、数字或 . _ -，且不能包含空格");
    });
});
