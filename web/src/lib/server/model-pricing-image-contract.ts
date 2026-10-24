import Fraction from "fraction.js";

import { assertRegularPaidPriceItems, modelPriceBindingScope, PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { ImageUsageObservation } from "./model-pricing-image-usage";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export const IMAGE_TOKEN_METERS = ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"] as const;
export type ImageTokenMeter = (typeof IMAGE_TOKEN_METERS)[number];
export type ImageTokenHoldEstimate = { meterQuantities: Record<ImageTokenMeter, string>; sourceUrl: string; evidence: string };
export type ImageTokenHoldTier = ImageTokenHoldEstimate & { quality: string; size: string; observedSize?: string; referenceSize?: string };
export type ImageChannelIdentity = { channelBindingId: string; officialSku: string; operation: "generations" | "edits"; sourceUrl: string; evidence: string };
export type ImagePriceContract = {
    officialVersionId: string;
    channelId: string;
    requestedModel: string;
    reportedModel: string;
    modelIdentity: "response-required" | "reviewed-request";
    identity?: ImageChannelIdentity;
    protocol: "openai-images";
    operation: "generations" | "edits";
    scope: "global-standard-direct-image-tokens" | "global-standard-dataeyes-flux-image";
    imageLimit?: { maxImages: 1; sourceUrl: string; evidence: string };
    region: "global";
    itemMeters: Record<string, ImageTokenMeter[]>;
    zeroMeters: ImageTokenMeter[];
    holdEstimate?: ImageTokenHoldEstimate;
    holdEstimates?: ImageTokenHoldTier[];
    evidence: string;
    reviewedBy: string;
    reviewedAt: string;
};
export type ImagePriceContractInput = Omit<ImagePriceContract, "officialVersionId" | "reviewedBy" | "reviewedAt">;
export type ImagePriceCallContext = {
    officialVersionId: string;
    salesVersionId: string;
    logicalModelId: string;
    priceSelection?: PublishedPriceSelection;
    channelId: string;
    requestedModel: string;
    operation: string;
    region: string;
    billingMode: string;
    usesExternalTools: boolean;
    responseComplete: boolean;
    occurredAt: string;
    declaredProtocol?: string;
};

export function supportsImageCountContract(protocol: string | undefined, model: string, operation: string) {
    return protocol === "dataeyes-flux" && ((["flux-kontext-pro", "flux-kontext-max"].includes(model) && ["generations", "edits"].includes(operation)) || (model === "flux-pro-1.1" && operation === "generations"));
}

export function supportsDirectImageTokenContract(protocol: string | undefined) {
    return !protocol || ["auto", "openai", "openai-images"].includes(protocol);
}

function validateImageChannelIdentity(raw: unknown, version: OfficialPriceVersion, requestedModel: string, operation: ImagePriceContract["operation"]): ImageChannelIdentity | undefined {
    if (version.logicalModelId && raw === undefined) return undefined;
    if (!version.sku || requestedModel === version.sku) {
        if (raw !== undefined) throw new PricingInputError("相同官网 SKU 的图片渠道绑定不需要别名身份映射");
        return undefined;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("图片渠道别名缺少独立审核的型号身份");
    const identity = raw as Record<string, unknown>;
    if (identity.officialSku !== version.sku || identity.operation !== operation || typeof identity.channelBindingId !== "string" || !identity.channelBindingId.trim()) throw new PricingInputError("图片渠道别名的绑定、官网 SKU 或操作身份不一致");
    let source: URL;
    try {
        source = new URL(String(identity.sourceUrl));
    } catch {
        throw new PricingInputError("图片渠道别名身份须附 HTTPS 来源");
    }
    if (source.protocol !== "https:" || source.username || source.password || typeof identity.evidence !== "string" || !identity.evidence.trim()) throw new PricingInputError("图片渠道别名身份须附 HTTPS 来源与核对依据");
    return { channelBindingId: identity.channelBindingId.trim(), officialSku: version.sku, operation, sourceUrl: source.href, evidence: identity.evidence.trim() };
}

/** Direct Images only. Alternative/cache/per-image price rows need their own applicable price version. */
export function validateImagePriceContract(raw: unknown, version: OfficialPriceVersion, reviewedBy: string, reviewedAt: string): ImagePriceContract {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("图片计费契约格式无效");
    const input = raw as Record<string, unknown>;
    assertRegularPaidPriceItems(version.items);
    const requiredString = (key: string) => {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`图片计费契约 ${key} 不能为空`);
        return value.trim();
    };
    if (version.tier !== "paid" || !version.reviewedBy || !Number.isFinite(Date.parse(version.publishedAt)) || !version.items.length) throw new PricingInputError("只能审核已发布的付费官方价目");
    if (!reviewedBy.trim() || !Number.isFinite(Date.parse(reviewedAt))) throw new PricingInputError("图片计费契约尚未审核");
    if (input.protocol !== "openai-images" || !["generations", "edits"].includes(String(input.operation))) throw new PricingInputError("仅支持直接 Images 创建或编辑协议");
    if (!["global-standard-direct-image-tokens", "global-standard-dataeyes-flux-image"].includes(String(input.scope)) || input.region !== "global") throw new PricingInputError("仅支持已核对的全球标准直接图片 Token 单档");
    if (input.modelIdentity !== "response-required" && input.modelIdentity !== "reviewed-request") throw new PricingInputError("请明确核对上游型号的依据");
    const identity = validateImageChannelIdentity(input.identity, version, requiredString("requestedModel"), input.operation as ImagePriceContract["operation"]);
    if (!input.itemMeters || typeof input.itemMeters !== "object" || Array.isArray(input.itemMeters) || !Array.isArray(input.zeroMeters)) throw new PricingInputError("请逐项绑定图片用量字段和必须为零的字段");
    if (input.scope === "global-standard-dataeyes-flux-image") {
        const limit = input.imageLimit as Record<string, unknown> | undefined;
        let source: URL;
        try {
            source = new URL(String(limit?.sourceUrl));
        } catch {
            throw new PricingInputError("按张契约必须附上界 HTTPS 来源");
        }
        if (source.protocol !== "https:" || source.username || source.password || limit?.maxImages !== 1 || typeof limit.evidence !== "string" || !limit.evidence.trim()) throw new PricingInputError("请核实 DataEyes FLUX 每请求一张的上界及依据");
        if (!supportsImageCountContract("dataeyes-flux", requiredString("requestedModel"), String(input.operation)) || version.sku !== input.requestedModel) throw new PricingInputError("按张契约的官方 SKU、上游型号或操作不在已核实范围");
        if (version.items.length !== 1 || version.items[0].unit.trim().toLowerCase() !== "image" || Object.keys(input.itemMeters).length || input.zeroMeters.length) throw new PricingInputError("按张单档必须只有一个 image 价目分项，不能混入 Token 映射");
        return {
            officialVersionId: version.id,
            channelId: requiredString("channelId"),
            requestedModel: requiredString("requestedModel"),
            reportedModel: requiredString("reportedModel"),
            modelIdentity: input.modelIdentity,
            ...(identity ? { identity } : {}),
            protocol: "openai-images",
            operation: input.operation as ImagePriceContract["operation"],
            scope: input.scope,
            region: "global",
            itemMeters: {},
            zeroMeters: [],
            imageLimit: { maxImages: 1, sourceUrl: source.href, evidence: limit.evidence.trim() },
            evidence: requiredString("evidence"),
            reviewedBy,
            reviewedAt,
        };
    }
    const mappings = input.itemMeters as Record<string, unknown>;
    if (Object.keys(mappings).length !== version.items.length || Object.keys(mappings).some((key) => !version.items.some((item) => item.key === key))) throw new PricingInputError("图片契约必须与官方价目分项完全一致");
    const seen = new Set<string>();
    const accept = (meters: unknown[]): ImageTokenMeter[] =>
        meters.map((meter) => {
            if (typeof meter !== "string" || !IMAGE_TOKEN_METERS.includes(meter as ImageTokenMeter) || seen.has(meter)) throw new PricingInputError("图片计量字段无效或重复；不能用总量代替模态分项");
            seen.add(meter);
            return meter as ImageTokenMeter;
        });
    const itemMeters: ImagePriceContract["itemMeters"] = {};
    for (const item of version.items) {
        const meters = mappings[item.key];
        if (item.unit.trim().toLowerCase() !== "token" || !Array.isArray(meters) || !meters.length) throw new PricingInputError(`分项 ${item.key} 必须绑定真实 Token 分项；不支持忽略缓存或按张价目`);
        itemMeters[item.key] = accept(meters);
    }
    const zeroMeters = accept(input.zeroMeters);
    if (seen.size !== IMAGE_TOKEN_METERS.length) throw new PricingInputError("必须覆盖图片输入输出的全部文本和图片分项");
    const validateEstimate = (value: unknown): ImageTokenHoldEstimate => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new PricingInputError("图片 Token 预留估算格式无效");
        const raw = value as Record<string, unknown>;
        const values = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.meterQuantities : undefined;
        if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length !== IMAGE_TOKEN_METERS.length) throw new PricingInputError("图片 Token 预留估算必须逐项填写四个模态用量");
        const meterQuantities = Object.fromEntries(
            IMAGE_TOKEN_METERS.map((meter) => {
                const value = (values as Record<string, unknown>)[meter];
                if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new PricingInputError(`${meter} 的预留估算用量必须是非负整数`);
                return [meter, value];
            }),
        ) as Record<ImageTokenMeter, string>;
        if (zeroMeters.some((meter) => meterQuantities[meter] !== "0") || !IMAGE_TOKEN_METERS.some((meter) => !zeroMeters.includes(meter) && meterQuantities[meter] !== "0")) throw new PricingInputError("预留估算的免费分项必须为零，且计费分项须有正用量");
        let sourceUrl: URL;
        try {
            sourceUrl = new URL(String(raw.sourceUrl));
        } catch {
            throw new PricingInputError("图片 Token 预留估算须附 HTTPS 来源");
        }
        if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password || typeof raw.evidence !== "string" || !raw.evidence.trim()) throw new PricingInputError("图片 Token 预留估算须附 HTTPS 来源和核对依据");
        return { meterQuantities, sourceUrl: sourceUrl.href, evidence: raw.evidence.trim() };
    };
    const holdEstimate = input.holdEstimate === undefined ? undefined : validateEstimate(input.holdEstimate);
    let holdEstimates: ImageTokenHoldTier[] | undefined;
    if (input.holdEstimates !== undefined) {
        if (!Array.isArray(input.holdEstimates) || !input.holdEstimates.length) throw new PricingInputError("图片 Token 分档预留估算不能为空");
        const seenTiers = new Set<string>();
        holdEstimates = input.holdEstimates.map((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new PricingInputError("图片 Token 分档预留估算格式无效");
            const tier = value as Record<string, unknown>;
            const qualities = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(version.sku) ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"];
            const dimensions = (value: unknown) => typeof value === "string" && /^[1-9]\d*x[1-9]\d*$/.test(value) && value.split("x").every((part) => Number.isSafeInteger(Number(part)));
            if (!qualities.includes(String(tier.quality)) || (tier.size !== "auto" && !dimensions(tier.size))) throw new PricingInputError("图片 Token 预留档位须明确画质及正整数尺寸，或提供已核对的 auto 样本");
            if (tier.size === "auto" ? !dimensions(tier.observedSize) : tier.observedSize !== undefined) throw new PricingInputError("auto 预留档位须记录样本实际输出尺寸，固定尺寸档位不得填写样本输出尺寸");
            if (input.operation === "edits" ? !dimensions(tier.referenceSize) : tier.referenceSize !== undefined) throw new PricingInputError("编辑预留档位须明确单张参考图尺寸，生成档位不得填写参考图尺寸");
            const key = `${tier.quality}/${tier.size}/${tier.referenceSize || ""}`;
            if (seenTiers.has(key)) throw new PricingInputError("图片 Token 预留档位不能重复");
            seenTiers.add(key);
            const estimate = validateEstimate(value);
            if (input.operation === "edits" && estimate.meterQuantities.inputImageTokens === "0") throw new PricingInputError("编辑预留档位须计入参考图输入 Token");
            return { ...estimate, quality: tier.quality as string, size: tier.size as string, ...(tier.size === "auto" ? { observedSize: tier.observedSize as string } : {}), ...(tier.referenceSize ? { referenceSize: tier.referenceSize as string } : {}) };
        });
    }
    if (holdEstimate && holdEstimates) throw new PricingInputError("图片 Token 预留估算不能同时使用固定值和分档值");
    return {
        officialVersionId: version.id,
        channelId: requiredString("channelId"),
        requestedModel: requiredString("requestedModel"),
        reportedModel: requiredString("reportedModel"),
        modelIdentity: input.modelIdentity,
        ...(identity ? { identity } : {}),
        protocol: "openai-images",
        operation: input.operation as ImagePriceContract["operation"],
        scope: "global-standard-direct-image-tokens",
        region: "global",
        itemMeters,
        zeroMeters,
        ...(holdEstimate ? { holdEstimate } : {}),
        ...(holdEstimates ? { holdEstimates } : {}),
        evidence: requiredString("evidence"),
        reviewedBy,
        reviewedAt,
    };
}

export function previewObservedImageQuote(input: { version: OfficialPriceVersion; policy: SalesVersion; contract: ImagePriceContract; observation: ImageUsageObservation; call: ImagePriceCallContext }) {
    const { version, policy, observation, call } = input;
    let contract: ImagePriceContract;
    try {
        contract = validateImagePriceContract(input.contract, version, input.contract.reviewedBy, input.contract.reviewedAt);
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
    const reasons: string[] = [];
    if (
        input.contract.officialVersionId !== version.id ||
        call.officialVersionId !== version.id ||
        policy.id !== call.salesVersionId ||
        !publishedPriceMatches(call.logicalModelId, version, policy, call.priceSelection) ||
        (call.priceSelection && call.priceSelection.scope !== modelPriceBindingScope("image", contract.operation, "standard"))
    )
        reasons.push("官方价版本、逻辑模型与已发布售价不一致");
    if (call.channelId !== contract.channelId || call.requestedModel !== contract.requestedModel) reasons.push("承接渠道或请求型号未经核对");
    if (observation.protocol !== contract.protocol || call.operation !== contract.operation || call.usesExternalTools) reasons.push("调用不属于已审核的直接 Images 操作");
    if (observation.reportedModel ? observation.reportedModel !== contract.reportedModel : contract.modelIdentity === "response-required") reasons.push("上游响应型号未确认");
    if (call.region !== contract.region || call.billingMode !== "standard") reasons.push("调用不是全球标准实时计费模式");
    if (!call.responseComplete || !observation.hasResults) reasons.push("上游图片响应尚未完整成功");
    const occurredAt = Date.parse(call.occurredAt);
    if (!Number.isFinite(occurredAt) || (version.effectiveFrom && occurredAt < Date.parse(version.effectiveFrom)) || (version.effectiveTo && occurredAt >= Date.parse(version.effectiveTo))) reasons.push("调用不在价目有效期内");
    if ([version.publishedAt, policy.publishedAt, contract.reviewedAt].some((value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > occurredAt)) reasons.push("调用早于价目、售价或计费契约审核");
    reasons.push(...observation.invalid.map((reason) => `上游用量无效：${reason}`));
    if (contract.scope === "global-standard-dataeyes-flux-image") {
        if (!supportsImageCountContract(call.declaredProtocol, call.requestedModel, call.operation)) reasons.push("当前协议与已审核的 DataEyes FLUX 按张契约不一致");
        if (observation.quantities.images !== String(contract.imageLimit!.maxImages)) reasons.push("实际图片数量与已审核单请求上界不一致");
        if (reasons.length) return { ready: false as const, reasons };
        const usage = { [version.items[0].key]: observation.quantities.images };
        try {
            return { ready: true as const, usage, quote: quoteSalesPrice({ version, policy, usage, modelId: call.logicalModelId }) };
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
            return { ready: false as const, reasons: [error.message] };
        }
    }
    const meters = [...IMAGE_TOKEN_METERS, "inputTotalTokens", "outputTotalTokens", "totalTokens"];
    for (const meter of meters) if (!/^\d+$/.test(observation.quantities[meter] ?? "")) reasons.push(`缺少 ${meter} 的真实用量`);
    if (!reasons.length) {
        const q = (meter: string) => new Fraction(observation.quantities[meter]);
        if (!q("inputTextTokens").add(q("inputImageTokens")).equals(q("inputTotalTokens")) || !q("outputTextTokens").add(q("outputImageTokens")).equals(q("outputTotalTokens")) || !q("inputTotalTokens").add(q("outputTotalTokens")).equals(q("totalTokens")))
            reasons.push("上游总量与模态分项不一致");
        for (const meter of contract.zeroMeters) if (!q(meter).equals(0)) reasons.push(`${meter} 必须由上游明确报告为零`);
    }
    if (reasons.length) return { ready: false as const, reasons };
    const usage = Object.fromEntries(version.items.map((item) => [item.key, contract.itemMeters[item.key].reduce((sum, meter) => sum.add(observation.quantities[meter]), new Fraction(0)).toFraction()]));
    try {
        return { ready: true as const, usage, quote: quoteSalesPrice({ version, policy, usage, modelId: call.logicalModelId }) };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
