import Fraction from "fraction.js";
import { DEEPSEEK_TIME_PRICE_KEYS, deepSeekSalesTimeTier, officialItemsForTextPriceGroup, PricingInputError, quoteSalesPrice, selectStandardTextPriceVersion, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { validateFlatTextPriceContract, type FlatTextPriceContract } from "./model-pricing-token-contract";
import { inspectFlatTextRequestContext } from "./model-pricing-text-request";
import type { TokenUsageObservation } from "./model-pricing-token-usage";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export type FlatTextRequestBound =
    | {
          ready: true;
          inputTokens: string;
          outputTokens: string;
          candidates: number;
          activeItemKeys?: string[];
          maximumUsage: Record<string, string>;
          maximumQuoteUsage: Record<string, string>;
          maximumExactPoints: string;
          maximumGroupId?: string;
          sourceUrl: string;
          evidence: string;
      }
    | { ready: false; reasons: string[] };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function estimatedInputTokens(contract: FlatTextPriceContract, payload: unknown, bound: Extract<FlatTextRequestBound, { ready: true }>) {
    const body = record(payload);
    const content = contract.protocol === "gemini-generate" ? [body.contents, body.systemInstruction || body.system_instruction] : contract.protocol === "openai-responses" ? [body.input, body.instructions] : [body.messages, body.system];
    return BigInt(Math.min(new TextEncoder().encode(JSON.stringify(content)).length, Number(bound.inputTokens)));
}

/** A request-size estimate, not a billable usage counter or an audited hard limit. */
export function estimateFlatTextRequestUsage(input: {
    version: OfficialPriceVersion;
    policy: SalesVersion;
    contract: FlatTextPriceContract;
    payload: unknown;
    bound: Extract<FlatTextRequestBound, { ready: true }>;
    recentOutputTokens?: string;
    modelId?: string;
}) {
    const { version, policy, contract, bound } = input;
    const inputTokens = estimatedInputTokens(contract, input.payload, bound);
    if (version.textPriceSchedule) return estimateFlatTextRequestUsage({ ...input, version: selectStandardTextPriceVersion(version, Number(inputTokens)).version });
    const reportedOutput = input.recentOutputTokens && /^\d+$/.test(input.recentOutputTokens) ? BigInt(input.recentOutputTokens) : inputTokens * BigInt(bound.candidates);
    const outputTokens = reportedOutput < BigInt(bound.outputTokens) ? reportedOutput : BigInt(bound.outputTokens);
    const tier = bound.activeItemKeys || (contract.contextTiers && inputTokens > BigInt(contract.contextTiers.thresholdInputTokens) ? contract.contextTiers.longItemKeys : contract.contextTiers?.shortItemKeys || version.items.map((item) => item.key));
    const usage = Object.fromEntries(version.items.map((item) => [item.key, "0"]));
    let inputKey = "";
    let inputRate = new Fraction(-1);
    for (const key of tier) {
        const meters = contract.itemMeters[key];
        if (meters.includes("outputTokens")) usage[key] = outputTokens.toString();
        if (meters.some((meter) => meter !== "outputTokens")) {
            const rate = new Fraction(quoteSalesPrice({ version, policy, usage: { ...usage, [key]: "1" }, modelId: input.modelId }).exactPoints);
            if (rate.gt(inputRate)) {
                inputRate = rate;
                inputKey = key;
            }
        }
    }
    if (!inputKey) throw new PricingInputError("没有完整输入计费分项");
    usage[inputKey] = (BigInt(usage[inputKey]) + inputTokens).toString();
    return usage;
}

export function estimateFlatTextRequestQuote(input: Parameters<typeof estimateFlatTextRequestUsage>[0]) {
    const pricedVersion = input.version.textPriceSchedule ? selectStandardTextPriceVersion(input.version, Number(estimatedInputTokens(input.contract, input.payload, input.bound))).version : input.version;
    const usage = estimateFlatTextRequestUsage({ ...input, version: pricedVersion });
    return quoteSalesPrice({ version: pricedVersion, policy: input.policy, usage, modelId: input.modelId });
}

/** Uses audited hard limits. Does not add or lower a limit in the upstream request. */
export function prepareFlatTextRequestBound(input: {
    version: OfficialPriceVersion;
    policy: SalesVersion;
    contract: FlatTextPriceContract;
    payload: unknown;
    occurredAt: string;
    modelId?: string;
    priceSelection?: PublishedPriceSelection;
}): FlatTextRequestBound {
    try {
        const { version, policy, payload } = input;
        const contract = validateFlatTextPriceContract(input.contract, version, input.contract.reviewedBy, input.contract.reviewedAt);
        const limits = contract.requestLimits;
        if (!limits) throw new PricingInputError("当前渠道尚无已审核请求上界");
        if (
            !contract.reviewedBy ||
            !Number.isFinite(Date.parse(contract.reviewedAt)) ||
            !policy.publishedBy ||
            !publishedPriceMatches(input.modelId || version.logicalModelId, version, policy, input.priceSelection) ||
            input.contract.officialVersionId !== version.id
        )
            throw new PricingInputError("上界契约与已发布价目不一致");
        const occurredAt = Date.parse(input.occurredAt);
        if (!Number.isFinite(occurredAt) || (version.effectiveFrom && occurredAt < Date.parse(version.effectiveFrom)) || (version.effectiveTo && occurredAt >= Date.parse(version.effectiveTo))) throw new PricingInputError("请求不在价目有效期内");
        if ([version.publishedAt, policy.publishedAt, contract.reviewedAt].some((value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > occurredAt)) throw new PricingInputError("请求早于价目、售价或上界契约审核");
        const body = record(payload);
        const context = inspectFlatTextRequestContext(contract.protocol, payload);
        if (context.usesExternalTools || context.billingMode !== "standard" || context.inputModalities.join() !== "text" || context.outputModalities.join() !== "text" || body.prediction || body.moderation || body.best_of !== undefined)
            throw new PricingInputError("该请求包含尚无上界契约的额外计费能力");
        if ((body.model !== undefined && body.model !== contract.requestedModel) || (context.region && context.region !== contract.region) || (context.serviceTier && context.serviceTier !== contract.serviceTier))
            throw new PricingInputError("请求型号、地区或服务档与上界契约不符");
        const config = record(body.generationConfig);
        const integer = (value: unknown, fallback: number, minimum: number) => {
            if (value === undefined) return fallback;
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new PricingInputError("请求 Token 上限或候选数量无效");
            return value;
        };
        const candidates = integer(contract.protocol === "openai-chat" ? body.n : contract.protocol === "gemini-generate" ? config.candidateCount : undefined, 1, 1);
        if (candidates > limits.maxCandidates) throw new PricingInputError("候选数量超出已审核上界范围");
        const exactKimi = contract.protocol === "openai-chat" && version.manufacturer === "Moonshot" && contract.requestedModel === version.sku && (!contract.reportedModel || contract.reportedModel === version.sku);
        const kimiK2 = exactKimi && ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"].includes(version.sku);
        const kimiK3 = exactKimi && version.sku === "kimi-k3";
        const deepSeek = contract.scope === "global-standard-deepseek-utc";
        // Kimi K2 max_tokens covers reasoning and final content; K3 documents a different default.
        if (contract.protocol === "openai-chat" && body.max_tokens !== undefined && !kimiK2 && !deepSeek) throw new PricingInputError("旧 max_tokens 尚无推理计费上界契约");
        if (kimiK2 && body.max_completion_tokens !== undefined) throw new PricingInputError("Kimi K2 按量请求须使用已核实的 max_tokens 上界");
        if (deepSeek && body.max_completion_tokens !== undefined) throw new PricingInputError("DeepSeek Chat 按量请求须使用已核实的 max_tokens 上界");
        const field =
            contract.protocol === "gemini-generate"
                ? config.maxOutputTokens
                : contract.protocol === "anthropic-messages"
                  ? body.max_tokens
                  : contract.protocol === "openai-responses"
                    ? body.max_output_tokens
                    : kimiK2 || deepSeek
                      ? body.max_tokens
                      : body.max_completion_tokens;
        const requestedOutput = integer(field, kimiK2 ? 32768 : kimiK3 ? 131072 : limits.maxOutputTokens, contract.protocol === "anthropic-messages" ? 0 : 1);
        if (requestedOutput > limits.maxOutputTokens) throw new PricingInputError("请求输出 Token 上限超出已审核上界");
        const output = BigInt(requestedOutput) * BigInt(candidates);
        const inputTokens = BigInt(limits.maxInputTokens);
        if (version.textPriceSchedule) {
            const schedule = version.textPriceSchedule;
            if (schedule.declaredRange.minInclusive !== 0 || (schedule.declaredRange.maxInclusive !== undefined && schedule.declaredRange.maxInclusive < limits.maxInputTokens)) throw new PricingInputError("已审核文本价格组未覆盖请求上界的全部输入用量");
            const maximumUsage = Object.fromEntries(
                schedule.meters.map(({ meter }) => {
                    const fields = contract.itemMeters[meter];
                    return [meter, ((fields.some((field) => field !== "outputTokens") ? inputTokens : BigInt(0)) + (fields.includes("outputTokens") ? output : BigInt(0))).toString()];
                }),
            );
            let maximumExactPoints = new Fraction(-1);
            let maximumQuoteUsage: Record<string, string> | undefined;
            let maximumGroupId: string | undefined;
            for (const group of schedule.groups.filter((item) => item.selector.processingMode === "standard" && item.selector.inputTotalTokens.minInclusive <= limits.maxInputTokens)) {
                const groupInput = BigInt(Math.min(limits.maxInputTokens, group.selector.inputTotalTokens.maxInclusive ?? limits.maxInputTokens));
                const pricedVersion = { ...version, items: officialItemsForTextPriceGroup(group) };
                const zero = Object.fromEntries(pricedVersion.items.map((item) => [item.key, "0"]));
                const quoteUsage = { ...zero };
                let inputKey = "";
                let inputRate = new Fraction(-1);
                for (const item of pricedVersion.items) {
                    const fields = contract.itemMeters[item.key];
                    if (fields.includes("outputTokens")) quoteUsage[item.key] = output.toString();
                    if (fields.some((field) => field !== "outputTokens")) {
                        const rate = new Fraction(quoteSalesPrice({ version: pricedVersion, policy, usage: { ...zero, [item.key]: "1" }, modelId: input.modelId }).exactPoints);
                        if (rate.gt(inputRate)) {
                            inputRate = rate;
                            inputKey = item.key;
                        }
                    }
                }
                if (!inputKey) throw new PricingInputError("没有完整输入计费分项");
                quoteUsage[inputKey] = (BigInt(quoteUsage[inputKey]) + groupInput).toString();
                const exact = new Fraction(quoteSalesPrice({ version: pricedVersion, policy, usage: quoteUsage, modelId: input.modelId }).exactPoints);
                if (exact.gt(maximumExactPoints)) {
                    maximumExactPoints = exact;
                    maximumQuoteUsage = quoteUsage;
                    maximumGroupId = group.id;
                }
            }
            if (!maximumQuoteUsage) throw new PricingInputError("没有覆盖请求上界的 Standard 文本价格组");
            return {
                ready: true,
                inputTokens: inputTokens.toString(),
                outputTokens: output.toString(),
                candidates,
                maximumUsage,
                maximumQuoteUsage,
                maximumExactPoints: maximumExactPoints.toFraction(),
                maximumGroupId,
                sourceUrl: limits.sourceUrl,
                evidence: limits.evidence,
            };
        }
        const maximumUsage: Record<string, string> = {};
        const zero = Object.fromEntries(version.items.map((item) => [item.key, "0"]));
        const deepSeekKeys: string[] | undefined = contract.scope === "global-standard-deepseek-utc" ? [...DEEPSEEK_TIME_PRICE_KEYS[deepSeekSalesTimeTier(version, policy, input.occurredAt, input.modelId || version.logicalModelId)]] : undefined;
        const tiers = deepSeekKeys
            ? [{ keys: deepSeekKeys, inputLimit: inputTokens }]
            : contract.contextTiers
              ? [
                    { keys: contract.contextTiers.shortItemKeys, inputLimit: inputTokens < BigInt(contract.contextTiers.thresholdInputTokens) ? inputTokens : BigInt(contract.contextTiers.thresholdInputTokens) },
                    ...(inputTokens > BigInt(contract.contextTiers.thresholdInputTokens) ? [{ keys: contract.contextTiers.longItemKeys, inputLimit: inputTokens }] : []),
                ]
              : [{ keys: version.items.map((item) => item.key), inputLimit: inputTokens }];
        for (const item of version.items) {
            if (deepSeekKeys && !deepSeekKeys.includes(item.key)) {
                maximumUsage[item.key] = "0";
                continue;
            }
            const meters = contract.itemMeters[item.key];
            const hasInput = meters.some((meter) => meter !== "outputTokens");
            const hasOutput = meters.includes("outputTokens");
            maximumUsage[item.key] = ((hasInput ? inputTokens : BigInt(0)) + (hasOutput ? output : BigInt(0))).toString();
        }
        let maximumQuoteUsage: Record<string, string> | undefined;
        let maximumExactPoints = new Fraction(-1);
        for (const { keys, inputLimit } of tiers) {
            const quoteUsage = { ...zero };
            let inputKey = "";
            let inputRate = new Fraction(-1);
            for (const key of keys) {
                const meters = contract.itemMeters[key];
                if (meters.includes("outputTokens")) quoteUsage[key] = output.toString();
                if (meters.some((meter) => meter !== "outputTokens")) {
                    const rate = new Fraction(quoteSalesPrice({ version, policy, usage: { ...zero, [key]: "1" }, modelId: input.modelId }).exactPoints);
                    if (rate.gt(inputRate)) {
                        inputRate = rate;
                        inputKey = key;
                    }
                }
            }
            if (!inputKey) throw new PricingInputError("没有完整输入计费分项");
            quoteUsage[inputKey] = (BigInt(quoteUsage[inputKey]) + inputLimit).toString();
            const exact = new Fraction(quoteSalesPrice({ version, policy, usage: quoteUsage, modelId: input.modelId }).exactPoints);
            if (exact.gt(maximumExactPoints)) {
                maximumExactPoints = exact;
                maximumQuoteUsage = quoteUsage;
            }
        }
        return {
            ready: true,
            inputTokens: inputTokens.toString(),
            outputTokens: output.toString(),
            candidates,
            ...(deepSeekKeys ? { activeItemKeys: deepSeekKeys } : {}),
            maximumUsage,
            maximumQuoteUsage: maximumQuoteUsage!,
            maximumExactPoints: maximumExactPoints.toFraction(),
            sourceUrl: limits.sourceUrl,
            evidence: limits.evidence,
        };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false, reasons: [error.message] };
    }
}

/** Checked against the original request, never a newly edited contract. */
export function validateObservedRequestBound(bound: FlatTextRequestBound, contract: FlatTextPriceContract, observation: TokenUsageObservation): string[] {
    if (!bound.ready) return bound.reasons;
    if (observation.invalid || observation.protocol !== contract.protocol) return ["上游用量无效或协议与请求上界不一致"];
    let input = BigInt(0);
    let output = BigInt(0);
    for (const meter of new Set(Object.values(contract.itemMeters).flat())) {
        const value = observation.quantities[meter];
        if (!value || !/^\d+$/.test(value)) return [`缺少 ${meter} 的上界核对用量`];
        if (meter === "outputTokens") output += BigInt(value);
        else input += BigInt(value);
    }
    return input > BigInt(bound.inputTokens) || output > BigInt(bound.outputTokens) ? ["实际用量超过调用开始时核实的请求上界"] : [];
}
