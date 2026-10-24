import Fraction from "fraction.js";
import { describe, expect, it } from "vitest";

import { accumulateExactPoints, pricingDecimal } from "./model-pricing-precision";

describe("exact point accrual", () => {
    it("preserves all digits of finite decimal displays", () => {
        const amount = "1000000000000000000000.004999999999999999999999999999999999";
        expect(pricingDecimal(new Fraction(amount))).toBe(amount);
        const tiny = "0.00000000000000000000000000000000001";
        expect(pricingDecimal(new Fraction(tiny))).toBe(tiny);
        expect(Number(pricingDecimal(new Fraction("1/7")))).toBeCloseTo(1 / 7);
    });
    it("carries sub-cent calls and retains over-rounding credit", () => {
        const first = accumulateExactPoints("0", "0.004");
        expect(first).toEqual({ exactPoints: "1/250", roundedPoints: "0.00", remainder: "1/250", delta: "0.00" });
        const second = accumulateExactPoints(first.exactPoints, "0.004");
        expect(second).toEqual({ exactPoints: "1/125", roundedPoints: "0.01", remainder: "-1/500", delta: "0.01" });
        const third = accumulateExactPoints(second.exactPoints, "0.004");
        expect(third.delta).toBe("0.00");
        expect(third.remainder).toBe("1/500");
    });

    it("preserves recurring unit prices across repeated serialization", () => {
        let exactPoints = "0";
        let charged = new Fraction(0);
        for (let call = 0; call < 300; call++) {
            const next = JSON.parse(JSON.stringify(accumulateExactPoints(exactPoints, "1/300")));
            exactPoints = next.exactPoints;
            charged = charged.add(next.delta);
        }
        expect(exactPoints).toBe("1");
        expect(charged.toFraction()).toBe("1");
        expect(accumulateExactPoints(exactPoints, "0").remainder).toBe("0");
    });

    it("carries converted amounts across rule changes and reverses frozen amounts", () => {
        const firstVersion = accumulateExactPoints("0", "0.004");
        const nextVersion = accumulateExactPoints(firstVersion.exactPoints, "0.007");
        expect(nextVersion.roundedPoints).toBe("0.01");
        const reverseFirst = accumulateExactPoints(nextVersion.exactPoints, "-0.004");
        expect(reverseFirst.roundedPoints).toBe("0.01");
        expect(reverseFirst.delta).toBe("0.00");
        const reverseSecond = accumulateExactPoints(reverseFirst.exactPoints, "-0.007");
        expect(reverseSecond).toEqual({ exactPoints: "0", roundedPoints: "0.00", remainder: "0", delta: "-0.01" });
    });

    it("does not equate a reversal delta with the original rounded call", () => {
        const first = accumulateExactPoints("0", "0.004");
        const second = accumulateExactPoints(first.exactPoints, "0.004");
        const reversed = accumulateExactPoints(second.exactPoints, "-0.004");
        expect(first.delta).toBe("0.00");
        expect(reversed.delta).toBe("-0.01");
        expect(reversed.exactPoints).toBe(first.exactPoints);
    });

    it("does not lose tiny amounts beside a large balance or round twice near a tie", () => {
        expect(accumulateExactPoints("1000000000000000000000", "0.005").delta).toBe("0.01");
        expect(accumulateExactPoints("0", "0.004999999999999999999999999999999999").roundedPoints).toBe("0.00");
        expect(accumulateExactPoints("0", "0.005").roundedPoints).toBe("0.01");
        expect(accumulateExactPoints("0", "0.005000000000000000000000000000000001").roundedPoints).toBe("0.01");
    });

    it("rejects corrupt or over-reversed totals instead of clamping them", () => {
        expect(() => accumulateExactPoints("-1", "2")).toThrow("不能为负数");
        expect(() => accumulateExactPoints("0.004", "-0.005")).toThrow("不能为负数");
        expect(() => accumulateExactPoints("0", "1/0")).toThrow();
    });
});
