import Decimal from "decimal.js";
import Fraction from "fraction.js";

import { PricingInputError } from "@/lib/model-pricing";
import { accumulateExactPoints } from "@/lib/model-pricing-precision";

/** Identifies the original daily grant, not merely the current calendar date. */
export type DailyPointSource = { date: string; planId: string; assignmentId: string };
export type PointReservation = {
    maximumExactPoints: string;
    heldPoints: string;
    dailyHeld: string;
    permanentHeld: string;
    dailySource?: DailyPointSource;
};
export type DailyReleaseTarget = DailyPointSource & { grantedPoints: string; remainingPoints: string };
export type SourceExactPoints = { daily: string; permanent: string };

function amount(value: string, label: string, walletAmount = false) {
    let parsed: Fraction;
    try {
        if (typeof value !== "string" || !value.trim()) throw new Error();
        parsed = new Fraction(value);
    } catch {
        throw new PricingInputError(`${label}无效`);
    }
    if (parsed.lt(0) || (walletAmount && parsed.mul(100).d !== BigInt(1))) throw new PricingInputError(`${label}必须是非负${walletAmount ? "且最多两位小数的" : ""}积分`);
    return parsed;
}

const money = (value: Fraction) => new Decimal(value.toString(2)).toFixed(2);
const min = (left: Fraction, right: Fraction) => (left.lt(right) ? left : right);

function requireSource(source: DailyPointSource | undefined): asserts source is DailyPointSource {
    if (!source || !source.date?.trim() || !source.planId?.trim() || typeof source.assignmentId !== "string") throw new PricingInputError("日赠预留缺少原始发放身份");
}

/**
 * The maximum must come from a verified request/price contract, never a guessed
 * token limit. Reserve ceil(maximum, wallet precision): concurrent calls can
 * change the account's rounding remainder before this call settles.
 * This function only computes an allocation; it does not debit a wallet.
 */
export function preparePointReservation(input: { maximumExactPoints: string; availableDailyPoints: string; availablePermanentPoints: string; dailySource?: DailyPointSource }): PointReservation {
    const maximum = amount(input.maximumExactPoints, "最高应收");
    const daily = amount(input.availableDailyPoints, "可用日赠积分", true);
    const permanent = amount(input.availablePermanentPoints, "可用永久积分", true);
    const held = maximum.ceil(2);
    if (held.gt(daily.add(permanent))) throw new PricingInputError("积分不足以预留本次最高应收");
    const dailyHeld = min(daily, held);
    if (dailyHeld.gt(0)) requireSource(input.dailySource);
    return {
        maximumExactPoints: maximum.toFraction(),
        heldPoints: money(held),
        dailyHeld: money(dailyHeld),
        permanentHeld: money(held.sub(dailyHeld)),
        ...(dailyHeld.gt(0) ? { dailySource: { ...input.dailySource! } } : {}),
    };
}

function validateReservation(reservation: PointReservation) {
    const maximum = amount(reservation.maximumExactPoints, "最高应收");
    const held = amount(reservation.heldPoints, "预留总额", true);
    const daily = amount(reservation.dailyHeld, "日赠预留", true);
    const permanent = amount(reservation.permanentHeld, "永久预留", true);
    if (!held.equals(maximum.ceil(2)) || !daily.add(permanent).equals(held)) throw new PricingInputError("预留快照金额不一致");
    if (daily.gt(0)) requireSource(reservation.dailySource);
    return { maximum, held, daily, permanent };
}

function releaseAllocation(reservation: PointReservation, daily: Fraction, permanent: Fraction, target?: DailyReleaseTarget) {
    let restored = new Fraction(0);
    if (target) {
        requireSource(target);
        const granted = amount(target.grantedPoints, "日赠发放积分", true);
        const remaining = amount(target.remainingPoints, "日赠剩余积分", true);
        if (remaining.gt(granted)) throw new PricingInputError("日赠剩余积分超过发放积分");
        const source = reservation.dailySource;
        if (source && source.date === target.date && source.planId === target.planId && source.assignmentId === target.assignmentId) restored = min(daily, granted.sub(remaining));
    }
    return {
        releasedPoints: money(daily.add(permanent)),
        permanentRestored: money(permanent),
        dailyRestored: money(restored),
        dailyExpired: money(daily.sub(restored)),
    };
}

/**
 * Must be calculated again under the user's wallet transaction/lock using the
 * then-current exact total. Persist accrual, allocation, receipt and terminal
 * reservation state atomically; this pure result is not an idempotent receipt.
 */
export function settlePointReservation(input: { reservation: PointReservation; previousExactPoints: SourceExactPoints; actualExactPoints: string; dailyReleaseTarget?: DailyReleaseTarget }) {
    const { maximum, held, daily, permanent } = validateReservation(input.reservation);
    const actual = amount(input.actualExactPoints, "实际应收");
    if (actual.gt(maximum)) throw new PricingInputError("实际应收超过已核实的预留上界，需核对计费依据");
    const dailyExact = min(daily, actual);
    const sourceExactPoints = { daily: dailyExact.toFraction(), permanent: actual.sub(dailyExact).toFraction() };
    const sourceAccruals = accrueSources(input.previousExactPoints, sourceExactPoints);
    const dailyCharged = amount(sourceAccruals.daily.delta, "日赠结算", true);
    const permanentCharged = amount(sourceAccruals.permanent.delta, "永久结算", true);
    const charged = dailyCharged.add(permanentCharged);
    if (charged.gt(held)) throw new PricingInputError("累计结算超过预留金额");
    if (dailyCharged.gt(daily) || permanentCharged.gt(permanent)) throw new PricingInputError("结算超过原来源预留");
    return {
        actualExactPoints: actual.toFraction(),
        sourceExactPoints,
        sourceAccruals,
        chargedPoints: money(charged),
        dailyCharged: money(dailyCharged),
        permanentCharged: money(permanentCharged),
        release: releaseAllocation(input.reservation, daily.sub(dailyCharged), permanent.sub(permanentCharged), input.dailyReleaseTarget),
    };
}

function accrueSources(previous: SourceExactPoints, change: SourceExactPoints) {
    return {
        daily: accumulateExactPoints(amount(previous.daily, "日赠累计应收").toFraction(), change.daily),
        permanent: accumulateExactPoints(amount(previous.permanent, "永久累计应收").toFraction(), change.permanent),
    };
}

/** Reverse exact usage within its original funding pools; never refund another pool's rounding. */
export function refundPointSettlement(input: {
    reservation: PointReservation;
    settlement: ReturnType<typeof settlePointReservation>;
    previousExactPoints: SourceExactPoints;
    alreadyRefundedExactPoints: string;
    refundExactPoints: string;
    dailyReleaseTarget?: DailyReleaseTarget;
}) {
    const allocation = validateReservation(input.reservation);
    const original = amount(input.settlement.actualExactPoints, "原应收");
    const prior = amount(input.alreadyRefundedExactPoints, "已退应收");
    const refund = amount(input.refundExactPoints, "退款应收");
    const total = prior.add(refund);
    if (total.gt(original)) throw new PricingInputError("退款超过原精确应收");
    const dailyOriginal = amount(input.settlement.sourceExactPoints.daily, "原日赠应收");
    const permanentOriginal = amount(input.settlement.sourceExactPoints.permanent, "原永久应收");
    if (!dailyOriginal.add(permanentOriginal).equals(original) || dailyOriginal.gt(allocation.daily) || permanentOriginal.gt(allocation.permanent)) throw new PricingInputError("原结算来源金额不一致");
    const dailyBefore = min(dailyOriginal, original.sub(prior));
    const dailyAfter = min(dailyOriginal, original.sub(total));
    const dailyRefund = dailyBefore.sub(dailyAfter);
    const sourceAccruals = accrueSources(input.previousExactPoints, { daily: dailyRefund.neg().toFraction(), permanent: refund.sub(dailyRefund).neg().toFraction() });
    const daily = new Fraction(sourceAccruals.daily.delta).neg();
    const permanent = new Fraction(sourceAccruals.permanent.delta).neg();
    const quotaRefundedPoints = original.equals(0) ? new Fraction(0) : new Fraction(input.settlement.chargedPoints).mul(total).div(original).round(2);
    return { refundedExactPoints: total.toFraction(), sourceAccruals, quotaRefundedPoints: money(quotaRefundedPoints), release: releaseAllocation(input.reservation, daily, permanent, input.dailyReleaseTarget) };
}

/** Release an unsettled reservation; never use this to refund a settled call. */
export function releasePointReservation(reservation: PointReservation, dailyReleaseTarget?: DailyReleaseTarget) {
    const { daily, permanent } = validateReservation(reservation);
    return releaseAllocation(reservation, daily, permanent, dailyReleaseTarget);
}

/** Exact decimal-to-existing-wallet boundary; refuse an amount JS cannot preserve. */
export function pricingWalletNumber(value: string) {
    const exact = new Fraction(value);
    const number = Number(value);
    if (!Number.isFinite(number) || exact.mul(100).d !== BigInt(1) || exact.mul(100).abs().gt(Number.MAX_SAFE_INTEGER) || !new Fraction(String(number)).equals(exact)) throw new PricingInputError("金额超出现有钱包可精确保存的范围");
    return number;
}
