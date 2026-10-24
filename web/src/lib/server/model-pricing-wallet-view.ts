import Fraction from "fraction.js";
import { PricingInputError, quoteSalesPrice } from "@/lib/model-pricing";
import { pricingDecimal } from "@/lib/model-pricing-precision";
import { normalizePage, normalizePageSize } from "./database/repository-utils";
import { readPricingWalletPage } from "./points-wallet-service";

export type PricingWalletFilter = "reserved" | "settled" | "released";

/** Only public calculation fields leave the wallet. No raw snapshots, evidence or provider bodies. */
export async function getPricingWalletView(userId: string, input: { page?: number; pageSize?: number; status?: string; now?: Date } = {}) {
    if (input.status && !["reserved", "settled", "released"].includes(input.status)) throw new PricingInputError("无效的计费状态");
    const page = Math.max(1, normalizePage(input.page));
    const pageSize = Math.max(1, normalizePageSize(input.pageSize));
    if (!Number.isSafeInteger(page * pageSize)) throw new PricingInputError("分页范围无效");
    const saved = await readPricingWalletPage(userId, { page, pageSize, status: input.status as PricingWalletFilter | undefined, now: input.now });
    return {
        page,
        pageSize,
        total: saved.total,
        summary: { availablePoints: String(saved.snapshot.totalPoints), dailyPoints: String(saved.snapshot.dailyPoints), permanentPoints: String(saved.snapshot.permanentPoints), debtPoints: String(saved.snapshot.debtPoints), ...saved.summary },
        items: saved.items.map(({ data: item, refundedPoints, expiredRefundPoints }) => {
            const quote =
                item.settledQuote ||
                item.settledImageQuote ||
                item.settledAudioQuote ||
                item.settledVideoQuote ||
                (item.settledUsage ? quoteSalesPrice({ version: item.frozen.version, policy: item.frozen.policy, usage: item.settledUsage, modelId: item.modelId }) : undefined);
            const release = item.release || item.settlement?.release;
            return {
                id: item.requestId,
                modelId: item.modelId,
                status: item.status,
                createdAt: item.createdAt,
                completedAt: item.completedAt,
                stage: item.status === "reserved" ? item.submission?.phase || "reserved" : item.status,
                heldPoints: (item.estimatedHold || item.allocation).heldPoints,
                chargedPoints: item.settlement?.chargedPoints,
                unpaidAtSettlement: item.unpaidAtSettlement,
                refundedPoints,
                expiredRefundPoints,
                restoredPoints: release ? new Fraction(release.permanentRestored).add(release.dailyRestored).toString(2) : undefined,
                expiredPoints: release?.dailyExpired,
                calculation: quote
                    ? {
                          manufacturer: item.frozen.version.manufacturer,
                          officialModel: item.frozen.version.sku,
                          officialVersionId: item.frozen.version.id,
                          salesVersionId: item.frozen.policy.id,
                          sourceUrl: item.frozen.version.sourceUrl,
                          conditions: item.frozen.version.conditions,
                          cnyPerUsd: item.frozen.policy.conversion!.cnyPerUsd,
                          pointsPerCny: item.frozen.policy.conversion!.pointsPerCny,
                          coefficient: quote.userCoefficient.value,
                          lines: quote.lines.map((line) => ({
                              key: line.key,
                              unit: line.unit,
                              per: line.per,
                              price: line.price,
                              currency: line.currency,
                              ...("condition" in line ? { condition: line.condition } : {}),
                              quantity: line.quantity,
                              officialAmount: line.officialAmount,
                          })),
                          currencies: quote.currencies,
                          exactPoints: quote.exactPoints,
                          calculatedPoints: pricingDecimal(new Fraction(quote.exactPoints)),
                      }
                    : undefined,
            };
        }),
    };
}

export type PricingWalletView = Awaited<ReturnType<typeof getPricingWalletView>>;
