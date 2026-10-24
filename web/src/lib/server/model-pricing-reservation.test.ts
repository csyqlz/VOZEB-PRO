import Fraction from "fraction.js";
import { describe, expect, it } from "vitest";

import { preparePointReservation, releasePointReservation, settlePointReservation, refundPointSettlement, pricingWalletNumber, type DailyReleaseTarget } from "./model-pricing-reservation";

const totals = (value = "0") => ({ daily: value, permanent: value });
const source = { date: "2026-10-02", planId: "pro", assignmentId: "assignment-one" };
const prepare = (maximumExactPoints: string, daily = "0", permanent = "100") => preparePointReservation({ maximumExactPoints, availableDailyPoints: daily, availablePermanentPoints: permanent, dailySource: source });
const target = (remainingPoints = "0", grantedPoints = "10"): DailyReleaseTarget => ({ ...source, remainingPoints, grantedPoints });

describe("point reservation allocation", () => {
    it("rejects amounts the existing decimal wallet cannot preserve", () => {
        expect(pricingWalletNumber("3.25")).toBe(3.25);
        expect(pricingWalletNumber("-0.01")).toBe(-0.01);
        expect(pricingWalletNumber("0.00")).toBe(0);
        for (const value of ["0.001", "90071992547409.92", "90071992547409.91", "Infinity"]) expect(() => pricingWalletNumber(value)).toThrow();
    });
    it("reserves the wallet-precision ceiling but only charges the actual cumulative delta", () => {
        const reservation = prepare("0.004");
        expect(reservation).toEqual({ maximumExactPoints: "1/250", heldPoints: "0.01", dailyHeld: "0.00", permanentHeld: "0.01" });
        const first = settlePointReservation({ reservation, previousExactPoints: totals("0"), actualExactPoints: "0.004" });
        expect(first).toMatchObject({ chargedPoints: "0.00", release: { permanentRestored: "0.01" }, sourceAccruals: { permanent: { exactPoints: "1/250", remainder: "1/250" } } });
        const next = settlePointReservation({ reservation, previousExactPoints: totals(first.sourceAccruals.permanent.exactPoints), actualExactPoints: "0.004" });
        expect(next).toMatchObject({ chargedPoints: "0.01", release: { permanentRestored: "0.00" }, sourceAccruals: { permanent: { exactPoints: "1/125", remainder: "-1/500" } } });
    });

    it("allocates daily points first and releases unused permanent points first", () => {
        const reservation = prepare("15.001", "10", "20");
        expect(reservation).toMatchObject({ heldPoints: "15.01", dailyHeld: "10.00", permanentHeld: "5.01", dailySource: source });
        const smaller = settlePointReservation({ reservation, previousExactPoints: totals("0"), actualExactPoints: "7.25", dailyReleaseTarget: target() });
        expect(smaller).toMatchObject({ chargedPoints: "7.25", dailyCharged: "7.25", permanentCharged: "0.00", release: { releasedPoints: "7.76", dailyRestored: "2.75", permanentRestored: "5.01", dailyExpired: "0.00" } });
        const larger = settlePointReservation({ reservation, previousExactPoints: totals("0"), actualExactPoints: "12.50", dailyReleaseTarget: target() });
        expect(larger).toMatchObject({ dailyCharged: "10.00", permanentCharged: "2.50", release: { dailyRestored: "0.00", permanentRestored: "2.51" } });
    });

    it.each([undefined, { ...target(), date: "2026-10-03" }, { ...target(), assignmentId: "assignment-two" }, { ...target(), planId: "other-plan" }])(
        "never converts unavailable or different daily grants into permanent points (%j)",
        (dailyReleaseTarget) => {
            const reservation = prepare("15", "10", "20");
            expect(releasePointReservation(reservation, dailyReleaseTarget)).toEqual({ releasedPoints: "15.00", permanentRestored: "5.00", dailyRestored: "0.00", dailyExpired: "10.00" });
            const settled = settlePointReservation({ reservation, previousExactPoints: totals("0"), actualExactPoints: "4", dailyReleaseTarget });
            expect(settled).toMatchObject({ dailyCharged: "4.00", release: { permanentRestored: "5.00", dailyRestored: "0.00", dailyExpired: "6.00" } });
        },
    );

    it("caps daily restoration at the current matching grant's remaining capacity", () => {
        const reservation = prepare("15", "10", "20");
        expect(releasePointReservation(reservation, target("3", "6"))).toEqual({ releasedPoints: "15.00", permanentRestored: "5.00", dailyRestored: "3.00", dailyExpired: "7.00" });
        expect(releasePointReservation(reservation, target("10"))).toMatchObject({ dailyRestored: "0.00", dailyExpired: "10.00" });
    });

    it("handles free grants with no paid assignment and snapshots their identity", () => {
        const freeSource = { ...source, planId: "free", assignmentId: "" };
        const reservation = preparePointReservation({ maximumExactPoints: "0.1", availableDailyPoints: "1", availablePermanentPoints: "0", dailySource: freeSource });
        freeSource.planId = "changed";
        expect(reservation.dailySource?.planId).toBe("free");
        expect(releasePointReservation(reservation, { ...target(), planId: "free", assignmentId: "" })).toMatchObject({ dailyRestored: "0.10" });
    });

    it("rejects insufficient reserves and an unverified overrun instead of silently charging more", () => {
        expect(() => prepare("0.004", "0", "0")).toThrow("积分不足");
        expect(() => prepare("15.001", "10", "5")).toThrow("积分不足");
        const reservation = prepare("0.004");
        // It still fits the rounded hold, but exceeds the verified exact bound.
        expect(() => settlePointReservation({ reservation, previousExactPoints: totals("0"), actualExactPoints: "0.005" })).toThrow("预留上界");
    });

    it("rejects missing amounts, fractional wallet balances and corrupt stored snapshots", () => {
        for (const value of ["", "NaN", "Infinity", "1/0", "-0.01"]) expect(() => prepare(value)).toThrow();
        expect(() => prepare("1", "0.001")).toThrow("两位小数");
        expect(() => prepare("1", "0", "-1")).toThrow();
        expect(() => preparePointReservation({ maximumExactPoints: "1", availableDailyPoints: "1", availablePermanentPoints: "0" })).toThrow("发放身份");
        const reservation = prepare("1", "1");
        for (const patch of [{ heldPoints: "0.99" }, { dailyHeld: "0.99" }, { dailySource: undefined }]) expect(() => releasePointReservation({ ...reservation, ...patch }, target())).toThrow();
        expect(() => releasePointReservation(reservation, target("11"))).toThrow("超过发放积分");
        expect(() => settlePointReservation({ reservation, previousExactPoints: totals("-1"), actualExactPoints: "0" })).toThrow();
    });

    it("supports a genuinely zero upper bound without locking or charging any funds", () => {
        const reservation = prepare("0", "0", "0");
        expect(reservation.heldPoints).toBe("0.00");
        const settled = settlePointReservation({ reservation, previousExactPoints: totals("0.004"), actualExactPoints: "0" });
        expect(settled).toMatchObject({ chargedPoints: "0.00", sourceAccruals: { permanent: { exactPoints: "1/250" } }, release: { releasedPoints: "0.00" } });
    });

    it("keeps exact large and recurring bounds without Number rounding", () => {
        expect(prepare("1/3").heldPoints).toBe("0.34");
        const huge = "1000000000000000000000.00499999999999999999999999999";
        const reservation = prepare(huge, "0", "1000000000000000000001");
        expect(reservation.heldPoints).toBe("1000000000000000000000.01");
        expect(settlePointReservation({ reservation, previousExactPoints: totals("0"), actualExactPoints: huge }).chargedPoints).toBe("1000000000000000000000.00");
    });

    it("covers rounding remainders and conserves charged, restored and expired funds", () => {
        const bounds = ["0.0001", "0.004", "0.005", "0.0099", "0.01", "0.0101", "1/3"];
        for (let remainder = 0; remainder < 100; remainder++) {
            for (const maximum of bounds) {
                const reservation = prepare(maximum, "0.01", "1");
                for (const actual of ["0", new Fraction(maximum).div(2).toFraction(), maximum]) {
                    const settled = settlePointReservation({ reservation, previousExactPoints: totals(new Fraction(remainder, 10000).toFraction()), actualExactPoints: actual, dailyReleaseTarget: target("0", "0.01") });
                    expect(new Fraction(settled.chargedPoints).lte(reservation.heldPoints)).toBe(true);
                    const conserved = new Fraction(settled.chargedPoints).add(settled.release.permanentRestored).add(settled.release.dailyRestored).add(settled.release.dailyExpired);
                    expect(conserved.equals(reservation.heldPoints)).toBe(true);
                    expect(new Fraction(settled.dailyCharged).add(settled.release.dailyRestored).add(settled.release.dailyExpired).equals(reservation.dailyHeld)).toBe(true);
                }
            }
        }
    });

    it("keeps permanent and daily rounding independent", () => {
        const daily = settlePointReservation({ reservation: prepare("0.004", "1"), previousExactPoints: { daily: "0", permanent: "0.004" }, actualExactPoints: "0.004", dailyReleaseTarget: target() });
        expect(daily.chargedPoints).toBe("0.00");
        expect(daily.sourceExactPoints).toEqual({ daily: "1/250", permanent: "0" });
        const refund = refundPointSettlement({
            reservation: prepare("0.004", "1"),
            settlement: daily,
            previousExactPoints: { daily: "0.004", permanent: "0.004" },
            alreadyRefundedExactPoints: "0",
            refundExactPoints: "0.004",
            dailyReleaseTarget: target(),
        });
        expect(refund.sourceAccruals.permanent.exactPoints).toBe("1/250");
        expect(refund.release.permanentRestored).toBe("0.00");
        expect(refund.release.dailyRestored).toBe("0.00");
    });

    it("conserves every pool across refund orders and fragmented refunds", () => {
        for (const dailyFunds of ["0", "0.01", "1"])
            for (const costs of [
                ["0.004", "0.004"],
                ["0.006", "0.007"],
                ["0.333", "1.25"],
            ])
                for (const order of [
                    [0, 1],
                    [1, 0],
                ]) {
                    let exact = totals();
                    let charged = new Fraction(0);
                    let restored = new Fraction(0);
                    const calls = costs.map((actual) => {
                        const reservation = prepare(actual, dailyFunds);
                        const settlement = settlePointReservation({ reservation, previousExactPoints: exact, actualExactPoints: actual });
                        exact = { daily: settlement.sourceAccruals.daily.exactPoints, permanent: settlement.sourceAccruals.permanent.exactPoints };
                        charged = charged.add(settlement.chargedPoints);
                        return { reservation, settlement };
                    });
                    for (const index of order) {
                        const call = calls[index];
                        let alreadyRefundedExactPoints = "0";
                        for (const refundExactPoints of [new Fraction(costs[index]).div(3), new Fraction(costs[index]).mul(2).div(3)]) {
                            const result = refundPointSettlement({ ...call, previousExactPoints: exact, alreadyRefundedExactPoints, refundExactPoints: refundExactPoints.toFraction(), dailyReleaseTarget: target("0", "100") });
                            alreadyRefundedExactPoints = result.refundedExactPoints;
                            exact = { daily: result.sourceAccruals.daily.exactPoints, permanent: result.sourceAccruals.permanent.exactPoints };
                            restored = restored.add(result.release.releasedPoints);
                            expect(restored.lte(charged)).toBe(true);
                        }
                        expect(alreadyRefundedExactPoints).toBe(new Fraction(costs[index]).toFraction());
                    }
                    expect(exact).toEqual(totals());
                    expect(restored.equals(charged)).toBe(true);
                }
    });
});
