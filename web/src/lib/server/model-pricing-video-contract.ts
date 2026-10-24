import Decimal from "decimal.js";
import { PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { inspectMinimaxVideoRequestBound, MINIMAX_VIDEO_PROFILES, validateObservedVideoRequestBound, type MinimaxVideoModel, type VideoRequestBound } from "./model-pricing-video-request";
import type { VideoUsageObservation } from "./model-pricing-video-usage";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export type VideoPriceContract = {
    officialVersionId: string;
    channelId: string;
    requestedModel: MinimaxVideoModel;
    protocol: "minimax-video-v2";
    scope: "global-standard-minimax-h3-generation";
    resolutionItems: Record<string, { inputSeconds: string; outputSeconds: string }>;
    inputImageItem: string;
    inputImagePricing: "all-at-standard-rate";
    inputAudioItem: string;
    evidence: string;
    reviewedBy: string;
    reviewedAt: string;
};
export type VideoPriceContractInput = Omit<VideoPriceContract, "officialVersionId" | "reviewedBy" | "reviewedAt">;
export type VideoPriceCallContext = {
    officialVersionId: string;
    salesVersionId: string;
    logicalModelId: string;
    channelId: string;
    requestedModel: string;
    declaredProtocol: string;
    operation: "generation";
    region: "global";
    billingMode: "standard";
    occurredAt: string;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Review paid video/image rates and the standing-free audio row; promotions never reduce customer charges. */
export function validateVideoPriceContract(raw: unknown, version: OfficialPriceVersion, reviewedBy: string, reviewedAt: string): VideoPriceContract {
    const input = object(raw);
    const required = (key: string) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`视频计费契约 ${key} 不能为空`);
        return value.trim();
    };
    if (version.tier !== "paid" || !version.reviewedBy || !Number.isFinite(Date.parse(version.publishedAt)) || !reviewedBy.trim() || !Number.isFinite(Date.parse(reviewedAt))) throw new PricingInputError("视频契约需要已发布付费价目和真实审核身份");
    const model = required("requestedModel");
    if (!Object.hasOwn(MINIMAX_VIDEO_PROFILES, model) || version.sku !== model || input.protocol !== "minimax-video-v2" || input.scope !== "global-standard-minimax-h3-generation")
        throw new PricingInputError("视频契约只支持精确 H3 型号的全球标准生成价目");
    if (input.inputImagePricing !== "all-at-standard-rate") throw new PricingInputError("活动免费额度仍按常规价收费");
    const requestedModel = model as MinimaxVideoModel;
    const mappings = object(input.resolutionItems);
    const resolutions = MINIMAX_VIDEO_PROFILES[requestedModel].resolutions;
    if (Object.keys(mappings).length !== resolutions.length || Object.keys(mappings).some((key) => !(resolutions as readonly string[]).includes(key))) throw new PricingInputError("必须覆盖该型号的全部公开分辨率");
    const seen = new Set<string>();
    const bind = (key: unknown, unit: string) => {
        const item = version.items.find((row) => row.key === key);
        if (typeof key !== "string" || seen.has(key) || !item || item.unit !== unit || !Number.isFinite(Number(item.price)) || Number(item.price) <= 0) throw new PricingInputError("输入、输出及图片必须分别绑定非零常规单价和正确单位");
        seen.add(key);
        return key;
    };
    const resolutionItems: VideoPriceContract["resolutionItems"] = {};
    for (const resolution of resolutions) {
        const row = object(mappings[resolution]);
        if (Object.keys(row).length !== 2) throw new PricingInputError("分辨率必须分别绑定输入与输出秒数");
        resolutionItems[resolution] = { inputSeconds: bind(row.inputSeconds, "second"), outputSeconds: bind(row.outputSeconds, "second") };
    }
    const inputImageItem = bind(input.inputImageItem, "image");
    const inputAudioItem = input.inputAudioItem;
    const audio = version.items.find((row) => row.key === inputAudioItem);
    if (inputAudioItem !== "inputAudioSeconds" || seen.has(inputAudioItem) || !audio || audio.unit !== "second" || audio.per !== "1" || !audio.price.trim() || Number(audio.price) !== 0)
        throw new PricingInputError("输入音频须独立绑定官方长期免费的零价秒数分项");
    seen.add(inputAudioItem);
    if (seen.size !== version.items.length) throw new PricingInputError("视频契约不得遗漏或混入其他计费项目");
    return {
        officialVersionId: version.id,
        channelId: required("channelId"),
        requestedModel,
        protocol: "minimax-video-v2",
        scope: "global-standard-minimax-h3-generation",
        resolutionItems,
        inputImageItem,
        inputImagePricing: "all-at-standard-rate",
        inputAudioItem,
        evidence: required("evidence"),
        reviewedBy,
        reviewedAt,
    };
}

type QuoteInput = { version: OfficialPriceVersion; policy: SalesVersion; contract: VideoPriceContract; call: VideoPriceCallContext; priceSelection?: PublishedPriceSelection };
function validateContext({ version, policy, contract: original, call, priceSelection }: QuoteInput) {
    const contract = validateVideoPriceContract(original, version, original.reviewedBy, original.reviewedAt);
    if (original.officialVersionId !== version.id || call.officialVersionId !== version.id || call.salesVersionId !== policy.id || !publishedPriceMatches(call.logicalModelId, version, policy, priceSelection) || !policy.publishedBy)
        throw new PricingInputError("视频调用与冻结的价目、逻辑模型和售价不一致");
    if (call.channelId !== contract.channelId || call.requestedModel !== contract.requestedModel || call.declaredProtocol !== "minimax" || call.operation !== "generation" || call.region !== "global" || call.billingMode !== "standard")
        throw new PricingInputError("视频调用不属于已审核渠道和标准生成操作");
    const time = Date.parse(call.occurredAt);
    if (
        !Number.isFinite(time) ||
        [version.publishedAt, policy.publishedAt, contract.reviewedAt].some((date) => !Number.isFinite(Date.parse(date)) || Date.parse(date) > time) ||
        (version.effectiveFrom && (!Number.isFinite(Date.parse(version.effectiveFrom)) || time < Date.parse(version.effectiveFrom))) ||
        (version.effectiveTo && (!Number.isFinite(Date.parse(version.effectiveTo)) || time >= Date.parse(version.effectiveTo)))
    )
        throw new PricingInputError("视频调用不在已审核价格的有效期内");
    return contract;
}
function priceUsage(version: OfficialPriceVersion, contract: VideoPriceContract, resolution: string, quantities: Record<string, string>) {
    const keys = contract.resolutionItems[resolution];
    if (!keys) throw new PricingInputError("视频分辨率没有对应完整价目");
    // Actual free audio remains in the original observation; billed usage deliberately records zero.
    const decimal = (meter: string) => new Decimal(quantities[meter]).toFixed();
    return { ...Object.fromEntries(version.items.map((item) => [item.key, "0"])), [keys.inputSeconds]: decimal("inputSeconds"), [keys.outputSeconds]: decimal("outputSeconds"), [contract.inputImageItem]: decimal("inputImageCount") };
}

export function prepareVideoRequestPriceBound(input: QuoteInput & { payload: unknown }) {
    try {
        const contract = validateContext(input);
        const bound = inspectMinimaxVideoRequestBound(input.payload, input.call.requestedModel, input.call.declaredProtocol);
        const maximumUsage = priceUsage(input.version, contract, bound.resolution, bound.maximumQuantities);
        return { ready: true as const, bound, maximumUsage, maximumExactPoints: quoteSalesPrice({ version: input.version, policy: input.policy, usage: maximumUsage, modelId: input.call.logicalModelId }).exactPoints };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}

/** Internal preview only. Incomplete evidence never settles, releases, or switches an existing charge. */
export function previewObservedVideoQuote(input: QuoteInput & { bound: VideoRequestBound; observation: VideoUsageObservation; upstreamTaskId: string; responseComplete: boolean }) {
    try {
        const contract = validateContext(input);
        const { bound, observation } = input;
        if (bound.requestedModel !== contract.requestedModel || bound.protocol !== contract.protocol) throw new PricingInputError("视频上界与原计费契约不一致");
        if (!input.responseComplete || !observation.hasResult || observation.status !== "succeeded" || !input.upstreamTaskId || observation.upstreamTaskId !== input.upstreamTaskId) throw new PricingInputError("视频原任务尚无完整成功响应");
        const reasons = [...observation.missing, ...validateObservedVideoRequestBound(bound, observation)];
        if (reasons.length) return { ready: false as const, reasons };
        const usage = priceUsage(input.version, contract, bound.resolution, observation.quantities);
        return { ready: true as const, usage, quote: quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.call.logicalModelId }) };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
