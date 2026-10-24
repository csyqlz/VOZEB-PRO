import { isDeepStrictEqual } from "node:util";
import { assertRegularPaidPriceItems, PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { VideoPriceCallContext } from "./model-pricing-video-contract";
import { inspectUsageFields } from "./model-pricing-usage-fields";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export const HAILUO_PRICE_MODELS = ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"] as const;
export const HAILUO_PRICE_TIERS = ["768P-6", "768P-10", "1080P-6"] as const;
export const HAILUO_REQUEST_SOURCES = {
    text: "https://platform.minimax.io/docs/api-reference/video-generation-t2v",
    image: "https://platform.minimax.io/docs/api-reference/video-generation-i2v",
} as const;
type Model = (typeof HAILUO_PRICE_MODELS)[number];
type Tier = (typeof HAILUO_PRICE_TIERS)[number];
export type HailuoPriceContract = {
    officialVersionId: string;
    channelId: string;
    requestedModel: Model;
    protocol: "minimax-hailuo-v1";
    scope: "global-standard-minimax-hailuo-generation";
    tierItems: Record<Tier, string>;
    evidence: string;
    reviewedBy: string;
    reviewedAt: string;
};
export type HailuoRequestBound = {
    protocol: "minimax-hailuo-v1";
    requestedModel: Model;
    mode: "text" | "image";
    tier: Tier;
    maximumVideos: "1";
    sourceUrl: string;
};
export type HailuoObservation = {
    protocol: "minimax-hailuo-v1";
    upstreamTaskId?: string;
    status?: string;
    fileId?: string;
    width?: number;
    height?: number;
    businessStatusCode?: number;
    missing: string[];
    invalid: string[];
    usageFields?: Record<string, string>;
    unmappedUsageFields?: string[];
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const models: readonly string[] = HAILUO_PRICE_MODELS;
const tiers: readonly string[] = HAILUO_PRICE_TIERS;

/** Independent V1 per-video tariffs. No H3 seconds, free tiers, or inferred model aliases. */
export function validateHailuoPriceContract(raw: unknown, version: OfficialPriceVersion, reviewedBy: string, reviewedAt: string): HailuoPriceContract {
    const input = object(raw);
    const required = (key: string) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`Hailuo 契约 ${key} 不能为空`);
        return value.trim();
    };
    const requestedModel = required("requestedModel");
    if (!models.includes(requestedModel) || version.sku !== requestedModel || input.protocol !== "minimax-hailuo-v1" || input.scope !== "global-standard-minimax-hailuo-generation")
        throw new PricingInputError("Hailuo 契约需要精确 V1 型号及全球标准整段价");
    if (version.tier !== "paid" || !version.reviewedBy?.trim() || !Number.isFinite(Date.parse(version.publishedAt)) || !reviewedBy.trim() || !Number.isFinite(Date.parse(reviewedAt)))
        throw new PricingInputError("Hailuo 契约需要已发布常规付费价和真实审核身份");
    const mapping = object(input.tierItems);
    if (!isDeepStrictEqual(Object.keys(mapping).sort(), [...tiers].sort()) || version.items.length !== tiers.length) throw new PricingInputError("Hailuo 价目必须完整覆盖三个独立档位");
    const seen = new Set<string>();
    const tierItems = {} as Record<Tier, string>;
    for (const tier of HAILUO_PRICE_TIERS) {
        const key = mapping[tier];
        const item = version.items.find((row) => row.key === key);
        if (typeof key !== "string" || seen.has(key) || !item || item.unit !== "video" || item.per !== "1") throw new PricingInputError("Hailuo 每档必须绑定独立非零常规单价，单位为一份视频");
        assertRegularPaidPriceItems([item]);
        seen.add(key);
        tierItems[tier] = key;
    }
    return {
        officialVersionId: version.id,
        channelId: required("channelId"),
        requestedModel: requestedModel as Model,
        protocol: "minimax-hailuo-v1",
        scope: "global-standard-minimax-hailuo-generation",
        tierItems,
        evidence: required("evidence"),
        reviewedBy,
        reviewedAt,
    };
}

/** Freeze documented defaults for quoting only; do not add defaults to the upstream request. */
export function inspectHailuoRequestBound(payload: unknown, requestedModel: string, declaredProtocol: string): HailuoRequestBound {
    const body = object(payload);
    if (declaredProtocol !== "minimax" || !models.includes(requestedModel) || body.model !== requestedModel) throw new PricingInputError("请求不是已核实的精确 Hailuo V1 型号");
    if (Object.keys(body).some((key) => !["model", "prompt", "duration", "resolution", "first_frame_image", "prompt_optimizer", "fast_pretreatment", "callback_url"].includes(key))) throw new PricingInputError("Hailuo 请求包含未审核的附加能力");
    const image = body.first_frame_image;
    if (image !== undefined && (typeof image !== "string" || !image.trim())) throw new PricingInputError("Hailuo 首帧必须是非空图片引用");
    const mode = image === undefined ? "text" : "image";
    if (requestedModel === "MiniMax-Hailuo-2.3-Fast" && mode !== "image") throw new PricingInputError("Hailuo Fast 必须使用单张首帧");
    if ((body.prompt !== undefined && typeof body.prompt !== "string") || (mode === "text" && (typeof body.prompt !== "string" || !body.prompt.trim()))) throw new PricingInputError("Hailuo 文生视频需要文本需求");
    for (const key of ["prompt_optimizer", "fast_pretreatment"]) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new PricingInputError("Hailuo 提示词选项必须为布尔值");
    if (body.callback_url !== undefined && typeof body.callback_url !== "string") throw new PricingInputError("Hailuo 回调地址必须为字符串");
    const duration = body.duration === undefined ? 6 : body.duration;
    const resolution = body.resolution === undefined ? "768P" : body.resolution;
    const tier = `${resolution}-${duration}`;
    if (typeof duration !== "number" || typeof resolution !== "string" || !tiers.includes(tier)) throw new PricingInputError("Hailuo 请求没有已核实的分辨率与时长档位");
    return { protocol: "minimax-hailuo-v1", requestedModel: requestedModel as Model, mode, tier: tier as Tier, maximumVideos: "1", sourceUrl: HAILUO_REQUEST_SOURCES[mode] };
}

/** The V1 response proves one original file, not billed seconds or a reported model. */
export function inspectHailuoObservation(payload: unknown, upstreamTaskId: string): HailuoObservation {
    const body = object(payload);
    const inventory = inspectUsageFields(object(body.usage), ["output_seconds"]);
    const result: HailuoObservation = {
        protocol: "minimax-hailuo-v1",
        missing: [],
        invalid: inventory.unmapped.length ? [`未解释的视频用量字段：${inventory.unmapped.join("、")}`] : [],
        usageFields: inventory.fields,
        unmappedUsageFields: inventory.unmapped,
    };
    for (const [field, target] of [
        ["task_id", "upstreamTaskId"],
        ["status", "status"],
        ["file_id", "fileId"],
    ] as const) {
        if (typeof body[field] === "string" && body[field].trim()) result[target] = body[field];
        else result.missing.push(field);
    }
    if (!upstreamTaskId || result.upstreamTaskId !== upstreamTaskId) result.invalid.push("Hailuo 响应不属于原上游任务");
    const code = object(body.base_resp).status_code;
    if (code === undefined) result.missing.push("base_resp.status_code");
    else if (code !== 0) result.invalid.push("Hailuo 原响应业务状态不成功");
    else result.businessStatusCode = 0;
    if (body.error) result.invalid.push("Hailuo 原响应包含错误");
    for (const [field, target] of [
        ["video_width", "width"],
        ["video_height", "height"],
    ] as const) {
        const value = body[field];
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) result[target] = value;
        else result.missing.push(field);
    }
    return result;
}

type QuoteInput = { version: OfficialPriceVersion; policy: SalesVersion; contract: HailuoPriceContract; call: VideoPriceCallContext; priceSelection?: PublishedPriceSelection };
function validateContext(input: QuoteInput) {
    const { version, policy, call } = input;
    const contract = validateHailuoPriceContract(input.contract, version, input.contract.reviewedBy, input.contract.reviewedAt);
    if (input.contract.officialVersionId !== version.id || call.officialVersionId !== version.id || call.salesVersionId !== policy.id || !publishedPriceMatches(call.logicalModelId, version, policy, input.priceSelection) || !policy.publishedBy?.trim())
        throw new PricingInputError("Hailuo 调用未匹配原价目与售价版本");
    if (call.channelId !== contract.channelId || call.requestedModel !== contract.requestedModel || call.declaredProtocol !== "minimax" || call.operation !== "generation" || call.region !== "global" || call.billingMode !== "standard")
        throw new PricingInputError("Hailuo 调用不属于已审核渠道与标准生成操作");
    const time = Date.parse(call.occurredAt);
    if (
        !Number.isFinite(time) ||
        [version.publishedAt, policy.publishedAt, contract.reviewedAt].some((date) => !Number.isFinite(Date.parse(date)) || Date.parse(date) > time) ||
        (version.effectiveFrom && (!Number.isFinite(Date.parse(version.effectiveFrom)) || time < Date.parse(version.effectiveFrom))) ||
        (version.effectiveTo && (!Number.isFinite(Date.parse(version.effectiveTo)) || time >= Date.parse(version.effectiveTo)))
    )
        throw new PricingInputError("Hailuo 调用不在冻结价目的有效期内");
    return contract;
}
function priceUsage(contract: HailuoPriceContract, tier: Tier) {
    return Object.fromEntries(HAILUO_PRICE_TIERS.map((key) => [contract.tierItems[key], key === tier ? "1" : "0"]));
}
export function prepareHailuoPriceBound(input: QuoteInput & { payload: unknown }) {
    try {
        const contract = validateContext(input);
        const bound = inspectHailuoRequestBound(input.payload, input.call.requestedModel, input.call.declaredProtocol);
        const maximumUsage = priceUsage(contract, bound.tier);
        return { ready: true as const, bound, maximumUsage, maximumExactPoints: quoteSalesPrice({ version: input.version, policy: input.policy, usage: maximumUsage, modelId: input.call.logicalModelId }).exactPoints };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
export function previewHailuoQuote(input: QuoteInput & { bound: HailuoRequestBound; observation: HailuoObservation; upstreamTaskId: string; responseComplete: boolean }) {
    try {
        const contract = validateContext(input);
        const { bound, observation } = input;
        if (
            bound.protocol !== contract.protocol ||
            bound.requestedModel !== contract.requestedModel ||
            !tiers.includes(bound.tier) ||
            bound.maximumVideos !== "1" ||
            !["text", "image"].includes(bound.mode) ||
            bound.sourceUrl !== HAILUO_REQUEST_SOURCES[bound.mode] ||
            (bound.requestedModel === "MiniMax-Hailuo-2.3-Fast" && bound.mode !== "image")
        )
            throw new PricingInputError("Hailuo 冻结上界不符合原型号整段契约");
        if (
            observation.protocol !== bound.protocol ||
            !input.responseComplete ||
            !input.upstreamTaskId ||
            observation.upstreamTaskId !== input.upstreamTaskId ||
            observation.status !== "Success" ||
            !observation.fileId?.trim() ||
            !Number.isSafeInteger(observation.width) ||
            !Number.isSafeInteger(observation.height) ||
            !(observation.width! > 0) ||
            !(observation.height! > 0)
        )
            throw new PricingInputError("Hailuo 原任务尚无完整成功文件凭据");
        const reasons = [...observation.missing, ...observation.invalid];
        if (reasons.length) return { ready: false as const, reasons };
        const usage = priceUsage(contract, bound.tier);
        return { ready: true as const, usage, quote: quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.call.logicalModelId }) };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
