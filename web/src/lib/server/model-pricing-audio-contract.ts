import { assertRegularPaidPriceItems, PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { inspectGeminiTtsRequestBound, isGeminiTtsModel, validateAudioRequestBound, type AudioRequestBound, type GeminiTtsModel } from "./model-pricing-audio-request";
import type { AudioUsageObservation } from "./model-pricing-audio-usage";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export type AudioPriceContract = {
    officialVersionId: string;
    channelId: string;
    requestedModel: GeminiTtsModel;
    reportedModel: string;
    modelIdentity: "response-required" | "reviewed-request";
    declaredProtocol: "gemini" | "dataeyes-gemini";
    protocol: "gemini-tts";
    scope: "global-standard-gemini-tts";
    inputTextItem: string;
    outputAudioItem: string;
    evidence: string;
    reviewedBy: string;
    reviewedAt: string;
};
export type AudioPriceContractInput = Omit<AudioPriceContract, "officialVersionId" | "reviewedBy" | "reviewedAt">;
export type AudioPriceCallContext = {
    officialVersionId: string;
    salesVersionId: string;
    logicalModelId: string;
    channelId: string;
    requestedModel: string;
    declaredProtocol: string;
    operation: string;
    region: string;
    billingMode: string;
    occurredAt: string;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function validateAudioPriceContract(raw: unknown, version: OfficialPriceVersion, reviewedBy: string, reviewedAt: string): AudioPriceContract {
    const input = object(raw);
    const required = (key: string) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`音频计费契约 ${key} 不能为空`);
        return value.trim();
    };
    assertRegularPaidPriceItems(version.items);
    if (version.tier !== "paid" || !version.reviewedBy || !Number.isFinite(Date.parse(version.publishedAt)) || !reviewedBy.trim() || !Number.isFinite(Date.parse(reviewedAt))) throw new PricingInputError("音频契约需要已发布付费价目和真实审核身份");
    const model = required("requestedModel");
    if (!isGeminiTtsModel(model) || version.sku !== model || input.protocol !== "gemini-tts" || input.scope !== "global-standard-gemini-tts" || !["gemini", "dataeyes-gemini"].includes(String(input.declaredProtocol)))
        throw new PricingInputError("音频契约仅支持精确 Gemini TTS 型号的全球标准价目");
    if (!["response-required", "reviewed-request"].includes(String(input.modelIdentity))) throw new PricingInputError("请明确核对音频上游型号的依据");
    const inputTextItem = required("inputTextItem"),
        outputAudioItem = required("outputAudioItem");
    if (
        inputTextItem === outputAudioItem ||
        version.items.length !== 2 ||
        version.items.some((item) => ![inputTextItem, outputAudioItem].includes(item.key) || item.unit !== "token") ||
        !version.items.some((item) => item.key === inputTextItem) ||
        !version.items.some((item) => item.key === outputAudioItem)
    )
        throw new PricingInputError("音频契约须分别绑定完整的文本输入与音频输出 Token 常规单价");
    return {
        officialVersionId: version.id,
        channelId: required("channelId"),
        requestedModel: model,
        reportedModel: required("reportedModel"),
        modelIdentity: input.modelIdentity as AudioPriceContract["modelIdentity"],
        declaredProtocol: input.declaredProtocol as AudioPriceContract["declaredProtocol"],
        protocol: "gemini-tts",
        scope: "global-standard-gemini-tts",
        inputTextItem,
        outputAudioItem,
        evidence: required("evidence"),
        reviewedBy,
        reviewedAt,
    };
}

type QuoteInput = { version: OfficialPriceVersion; policy: SalesVersion; contract: AudioPriceContract; call: AudioPriceCallContext; priceSelection?: PublishedPriceSelection };
function validateContext({ version, policy, contract: original, call, priceSelection }: QuoteInput) {
    const contract = validateAudioPriceContract(original, version, original.reviewedBy, original.reviewedAt);
    if (original.officialVersionId !== version.id || call.officialVersionId !== version.id || call.salesVersionId !== policy.id || !publishedPriceMatches(call.logicalModelId, version, policy, priceSelection) || !policy.publishedBy)
        throw new PricingInputError("音频调用与冻结价目、逻辑模型和售价不一致");
    if (call.channelId !== contract.channelId || call.requestedModel !== contract.requestedModel || call.declaredProtocol !== contract.declaredProtocol || call.operation !== "generateContent" || call.region !== "global" || call.billingMode !== "standard")
        throw new PricingInputError("音频调用不属于已审核渠道和全球标准同步操作");
    const time = Date.parse(call.occurredAt);
    if (
        !Number.isFinite(time) ||
        [version.publishedAt, policy.publishedAt, contract.reviewedAt].some((date) => !Number.isFinite(Date.parse(date)) || Date.parse(date) > time) ||
        (version.effectiveFrom && (!Number.isFinite(Date.parse(version.effectiveFrom)) || time < Date.parse(version.effectiveFrom))) ||
        (version.effectiveTo && (!Number.isFinite(Date.parse(version.effectiveTo)) || time >= Date.parse(version.effectiveTo)))
    )
        throw new PricingInputError("音频调用不在已审核价格的有效期内");
    return contract;
}
const priceUsage = (contract: AudioPriceContract, quantities: Record<string, string>) => ({ [contract.inputTextItem]: quantities.inputTextTokens, [contract.outputAudioItem]: quantities.outputAudioTokens });

export function prepareAudioRequestPriceBound(input: QuoteInput & { payload: unknown }) {
    try {
        const contract = validateContext(input);
        const bound = inspectGeminiTtsRequestBound(input.payload, input.call.requestedModel, input.call.declaredProtocol);
        const maximumUsage = priceUsage(contract, bound.maximumQuantities);
        return { ready: true as const, bound, maximumUsage, maximumExactPoints: quoteSalesPrice({ version: input.version, policy: input.policy, usage: maximumUsage, modelId: input.call.logicalModelId }).exactPoints };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}

/** Complete declared modality totals are required; this never infers a missing priced meter. */
export function previewObservedAudioQuote(input: QuoteInput & { bound: AudioRequestBound; observation: AudioUsageObservation; responseComplete: boolean }) {
    try {
        const contract = validateContext(input);
        const { bound, observation } = input;
        validateAudioRequestBound(bound);
        if (bound.requestedModel !== contract.requestedModel || observation.protocol !== contract.protocol) throw new PricingInputError("音频观察与原型号契约或请求上界不一致");
        if (!input.responseComplete || !observation.hasAudio) throw new PricingInputError("音频响应尚未完整成功");
        if (observation.reportedModel !== undefined ? observation.reportedModel !== contract.reportedModel : contract.modelIdentity === "response-required") throw new PricingInputError("音频响应型号未确认");
        if (observation.serviceTier !== undefined && !["standard", "unspecified"].includes(observation.serviceTier)) throw new PricingInputError("音频实际服务档位不是标准档位");
        const reasons = [...observation.invalid];
        const quantities = observation.quantities;
        for (const meter of ["inputTextTokens", "outputAudioTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens"]) if (!/^\d+$/.test(quantities[meter] ?? "")) reasons.push(`缺少 ${meter} 的真实用量`);
        // These exact models do not support caching, thinking, tools or other modalities.
        // An absent non-applicable meter is not inserted as a zero usage or price row.
        for (const [meter, quantity] of Object.entries(quantities)) {
            if (!/^\d+$/.test(quantity)) reasons.push(`${meter} 的用量无效`);
            else if (!["inputTextTokens", "outputAudioTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens"].includes(meter) && BigInt(quantity) !== BigInt(0)) reasons.push(`${meter} 不属于已审核音频计费范围`);
        }
        if (reasons.length) return { ready: false as const, reasons };
        if (
            BigInt(quantities.inputTextTokens) !== BigInt(quantities.inputTotalTokens) ||
            BigInt(quantities.outputAudioTokens) !== BigInt(quantities.outputTotalTokens) ||
            BigInt(quantities.inputTotalTokens) + BigInt(quantities.outputTotalTokens) !== BigInt(quantities.totalTokens)
        )
            throw new PricingInputError("音频总量不能由已定价的真实模态完整覆盖");
        for (const [meter, maximum] of Object.entries(bound.maximumQuantities)) if (BigInt(quantities[meter]) > BigInt(maximum)) throw new PricingInputError(`${meter} 超出原请求公开上界`);
        const usage = priceUsage(contract, quantities);
        return { ready: true as const, usage, quote: quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.call.logicalModelId }) };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
