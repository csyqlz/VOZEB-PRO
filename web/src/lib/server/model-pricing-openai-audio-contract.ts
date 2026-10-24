import { assertRegularPaidPriceItems, PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { AudioPriceCallContext } from "./model-pricing-audio-contract";
import type { AudioUsageObservation } from "./model-pricing-audio-usage";
import { inspectOpenAiAudioRequestBound, OPENAI_PRICED_AUDIO_MODEL, validateOpenAiAudioRequestBound, type OpenAiAudioRequestBound } from "./model-pricing-openai-audio-request";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export const OPENAI_AUDIO_PRICE_METERS = ["inputTextTokens", "inputAudioTokens", "outputTextTokens", "outputAudioTokens"] as const;
export type OpenAiAudioPriceContract = {
    officialVersionId: string;
    channelId: string;
    requestedModel: typeof OPENAI_PRICED_AUDIO_MODEL;
    reportedModel: typeof OPENAI_PRICED_AUDIO_MODEL;
    protocol: "openai-chat-audio";
    declaredProtocol: "openai";
    scope: "global-standard-openai-chat-audio-uncached";
    itemKeys: Record<(typeof OPENAI_AUDIO_PRICE_METERS)[number], string>;
    evidence: string;
    reviewedBy: string;
    reviewedAt: string;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Each modality keeps its own approved ordinary price, even when its actual quantity is zero. */
export function validateOpenAiAudioPriceContract(raw: unknown, version: OfficialPriceVersion, reviewedBy: string, reviewedAt: string): OpenAiAudioPriceContract {
    const input = object(raw);
    assertRegularPaidPriceItems(version.items);
    const required = (key: string) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`音频计费契约 ${key} 不能为空`);
        return value.trim();
    };
    if (version.tier !== "paid" || !version.reviewedBy || !Number.isFinite(Date.parse(version.publishedAt)) || !reviewedBy.trim() || !Number.isFinite(Date.parse(reviewedAt))) throw new PricingInputError("音频契约需要已发布付费价目和真实审核身份");
    if (
        input.requestedModel !== OPENAI_PRICED_AUDIO_MODEL ||
        input.reportedModel !== OPENAI_PRICED_AUDIO_MODEL ||
        version.sku !== OPENAI_PRICED_AUDIO_MODEL ||
        input.protocol !== "openai-chat-audio" ||
        input.declaredProtocol !== "openai" ||
        input.scope !== "global-standard-openai-chat-audio-uncached"
    )
        throw new PricingInputError("音频契约仅支持精确 gpt-audio-1.5 原生标准档，不得借用其他型号价格");
    const itemKeys = object(input.itemKeys);
    const keys = OPENAI_AUDIO_PRICE_METERS.map((meter) => itemKeys[meter]);
    if (
        Object.keys(itemKeys).sort().join() !== [...OPENAI_AUDIO_PRICE_METERS].sort().join() ||
        new Set(keys).size !== 4 ||
        version.items.length !== 4 ||
        keys.some((key) => typeof key !== "string" || !version.items.some((item) => item.key === key && item.unit === "token"))
    )
        throw new PricingInputError("必须分别完整绑定文本输入、音频输入、文本输出和音频输出的四个 Token 价目");
    return {
        officialVersionId: version.id,
        channelId: required("channelId"),
        requestedModel: OPENAI_PRICED_AUDIO_MODEL,
        reportedModel: OPENAI_PRICED_AUDIO_MODEL,
        protocol: "openai-chat-audio",
        declaredProtocol: "openai",
        scope: "global-standard-openai-chat-audio-uncached",
        itemKeys: { ...itemKeys } as OpenAiAudioPriceContract["itemKeys"],
        evidence: required("evidence"),
        reviewedBy,
        reviewedAt,
    };
}
type QuoteInput = { version: OfficialPriceVersion; policy: SalesVersion; contract: OpenAiAudioPriceContract; call: AudioPriceCallContext; priceSelection?: PublishedPriceSelection };
function validateContext(input: QuoteInput) {
    const { version, policy, contract: original, call } = input;
    const contract = validateOpenAiAudioPriceContract(original, version, original.reviewedBy, original.reviewedAt);
    if (original.officialVersionId !== version.id || call.officialVersionId !== version.id || call.salesVersionId !== policy.id || !publishedPriceMatches(call.logicalModelId, version, policy, input.priceSelection) || !policy.publishedBy)
        throw new PricingInputError("音频调用与冻结价目、逻辑模型或售价不一致");
    if (call.channelId !== contract.channelId || call.requestedModel !== contract.requestedModel || call.declaredProtocol !== "openai" || call.operation !== "chat/completions" || call.region !== "global" || call.billingMode !== "standard")
        throw new PricingInputError("音频调用不属于已审核原生渠道与全球标准操作");
    const time = Date.parse(call.occurredAt);
    if (
        !Number.isFinite(time) ||
        [version.publishedAt, policy.publishedAt, contract.reviewedAt].some((value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > time) ||
        (version.effectiveFrom && (!Number.isFinite(Date.parse(version.effectiveFrom)) || time < Date.parse(version.effectiveFrom))) ||
        (version.effectiveTo && (!Number.isFinite(Date.parse(version.effectiveTo)) || time >= Date.parse(version.effectiveTo)))
    )
        throw new PricingInputError("音频调用不在已审核价格的有效期内");
    return contract;
}
const usageFor = (contract: OpenAiAudioPriceContract, quantities: Record<string, string>) => Object.fromEntries(OPENAI_AUDIO_PRICE_METERS.map((meter) => [contract.itemKeys[meter], quantities[meter]]));

export function prepareOpenAiAudioPriceBound(input: QuoteInput & { payload: unknown }) {
    try {
        const contract = validateContext(input);
        const bound = inspectOpenAiAudioRequestBound(input.payload, input.call.requestedModel, input.call.declaredProtocol);
        const maximumUsage = usageFor(contract, bound.maximumQuantities);
        // Independent modality maxima are conservative; actual output must also fit their shared total.
        return { ready: true as const, bound, maximumUsage, maximumExactPoints: quoteSalesPrice({ version: input.version, policy: input.policy, usage: maximumUsage, modelId: input.call.logicalModelId }).exactPoints };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}

export function previewOpenAiAudioQuote(input: QuoteInput & { bound: OpenAiAudioRequestBound; observation: AudioUsageObservation; responseComplete: boolean }) {
    try {
        const contract = validateContext(input);
        const { bound, observation } = input;
        validateOpenAiAudioRequestBound(bound);
        if (observation.protocol !== contract.protocol || !input.responseComplete || !observation.hasAudio) throw new PricingInputError("原音频响应尚未完整成功或协议不匹配");
        if (observation.reportedModel !== contract.reportedModel || observation.serviceTier !== "default") throw new PricingInputError("音频响应的精确型号与实际标准服务档位未确认");
        const reasons = [...observation.invalid];
        const q = observation.quantities;
        const required = [...OPENAI_AUDIO_PRICE_METERS, "inputTotalTokens", "outputTotalTokens", "totalTokens", "inputCachedTokens", "inputCacheWriteTokens"];
        for (const meter of required) if (!/^\d+$/.test(q[meter] ?? "")) reasons.push(`缺少 ${meter} 的真实用量`);
        for (const [meter, value] of Object.entries(q)) {
            if (!/^\d+$/.test(value)) reasons.push(`${meter} 的用量无效`);
            else if (![...OPENAI_AUDIO_PRICE_METERS, "inputTotalTokens", "outputTotalTokens", "totalTokens"].includes(meter) && BigInt(value) !== BigInt(0)) reasons.push(`${meter} 不属于已审核的无缓存音频范围`);
        }
        if (reasons.length) return { ready: false as const, reasons };
        if (
            BigInt(q.inputTextTokens) + BigInt(q.inputAudioTokens) !== BigInt(q.inputTotalTokens) ||
            BigInt(q.outputTextTokens) + BigInt(q.outputAudioTokens) !== BigInt(q.outputTotalTokens) ||
            BigInt(q.inputTotalTokens) + BigInt(q.outputTotalTokens) !== BigInt(q.totalTokens)
        )
            throw new PricingInputError("音频总量没有被四个真实模态完整覆盖");
        for (const [meter, maximum] of Object.entries(bound.maximumQuantities)) if (BigInt(q[meter]) > BigInt(maximum)) throw new PricingInputError(`${meter} 超出原请求公开上界`);
        if (BigInt(q.outputTotalTokens) > BigInt(bound.candidateCount) * BigInt(bound.maxOutputTokens)) throw new PricingInputError("文本与音频共享输出总上界，不能重复占用");
        if (BigInt(q.inputTotalTokens) * BigInt(bound.candidateCount) + BigInt(q.outputTotalTokens) > BigInt(bound.maximumQuantities.inputTextTokens) * BigInt(bound.candidateCount)) throw new PricingInputError("输入和候选输出合计超出原型号上下文窗口");
        const usage = usageFor(contract, q);
        return { ready: true as const, usage, quote: quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.call.logicalModelId }) };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
