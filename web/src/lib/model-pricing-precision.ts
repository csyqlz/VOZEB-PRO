import Decimal from "decimal.js";
import Fraction from "fraction.js";

/** Decimal display only. Persist the rational value for subsequent calculations. */
export function pricingDecimal(value: Fraction): string {
    // Finite decimals need at most the denominator's bit length in decimal
    // places. Derive display precision from the value instead of truncating
    // small amounts or large integer parts to Decimal's default precision.
    const DisplayDecimal = Decimal.clone({ precision: Math.max(Decimal.precision, value.n.toString().length + value.d.toString(2).length) });
    return new DisplayDecimal((value.s * value.n).toString()).div(value.d.toString()).toFixed();
}

function roundedPoints(value: Fraction): string {
    // Round the exact, nonnegative total before converting to a display decimal.
    return new Decimal(value.round(2).toString(2)).toFixed(2);
}

/**
 * Accumulate already converted points across price versions for one account.
 * A reversal supplies the negative original exact amount, never today's price.
 * The caller must persist the result and its idempotent receipt atomically.
 */
export function accumulateExactPoints(previousExactPoints: string, changeExactPoints: string) {
    const previous = new Fraction(previousExactPoints);
    const total = previous.add(changeExactPoints);
    if (previous.lt(0) || total.lt(0)) throw new RangeError("累计应收积分不能为负数");
    const before = previous.round(2);
    const after = total.round(2);
    return {
        exactPoints: total.toFraction(),
        roundedPoints: roundedPoints(total),
        remainder: total.sub(after).toFraction(),
        delta: new Decimal(after.sub(before).toString(2)).toFixed(2),
    };
}
