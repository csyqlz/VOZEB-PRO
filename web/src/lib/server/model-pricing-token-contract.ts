import Decimal from "decimal.js";

import {
    assertRegularPaidPriceItems,
    DEEPSEEK_TIME_PRICE_KEYS,
    deepSeekSalesTimeTier,
    officialItemsForTextPriceGroup,
    PricingInputError,
    quoteSalesPrice,
    selectStandardTextPriceVersion,
    supportsDeepSeekTimePricing,
    validateTextPriceSchedule,
    type OfficialPriceVersion,
    type SalesVersion,
    type TextUsageRule,
} from "@/lib/model-pricing";
import type { TokenUsageObservation, TokenUsageProtocol } from "./model-pricing-token-usage";
import { publishedPriceMatches, type PublishedPriceSelection } from "./model-pricing-published-price";

export type FlatTextMeter = "inputTokens" | "uncachedInputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens" | "outputTokens";
export type FlatTextRequestLimits = { maxInputTokens: number; maxOutputTokens: number; maxCandidates: number; sourceUrl: string; evidence: string; includesReasoning: true };
export type FlatTextReservationEstimate = { method: "request-size-recent-output"; sourceUrl: string; evidence: string };
export type FlatTextContextTiers = { thresholdInputTokens: number; shortItemKeys: string[]; longItemKeys: string[]; sourceUrl: string; evidence: string };
export type FlatTextChannelIdentity = { channelBindingId: string; officialSku: string; operation: "generation"; modelIdentity: "response-required" | "reviewed-request"; sourceUrl: string; evidence: string };
export type FlatTextPriceContract = {
    officialVersionId: string;
    channelId: string;
    protocol: TokenUsageProtocol;
    requestedModel: string;
    reportedModel: string;
    scope: "global-standard-text-flat" | "global-standard-text-tiered" | "global-standard-deepseek-utc";
    region: "global";
    serviceTier: string;
    itemMeters: Record<string, FlatTextMeter[]>;
    evidence: string;
    identity?: FlatTextChannelIdentity;
    reviewedAt: string;
    reviewedBy: string;
    requestLimits?: FlatTextRequestLimits;
    reservationEstimate?: FlatTextReservationEstimate;
    contextTiers?: FlatTextContextTiers;
};
export type FlatTextPriceContractInput = Pick<
    FlatTextPriceContract,
    "channelId" | "protocol" | "requestedModel" | "reportedModel" | "scope" | "region" | "serviceTier" | "itemMeters" | "evidence" | "identity" | "requestLimits" | "reservationEstimate" | "contextTiers"
>;
export type FlatTextCallContext = {
    modelId?: string;
    priceSelection?: PublishedPriceSelection;
    channelId: string;
    salesVersionId: string;
    officialVersionId: string;
    requestedModel: string;
    region: string;
    serviceTier: string;
    billingMode: string;
    inputModalities: string[];
    outputModalities: string[];
    usesExternalTools: boolean;
    responseComplete: boolean;
    occurredAt: string;
};

export const FLAT_TEXT_REQUIRED_METERS: Record<TokenUsageProtocol, FlatTextMeter[]> = {
    "openai-chat": ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"],
    "openai-responses": ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"],
    "anthropic-messages": ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"],
    "gemini-generate": ["inputTokens", "cachedInputTokens", "outputTokens"],
};

/** Explicitly reviewed mapping for models whose writes use the ordinary input price. */
export const OPENAI_INCLUSIVE_INPUT_METERS: FlatTextMeter[] = ["uncachedInputTokens", "cachedInputTokens", "outputTokens"];

function requiredMeters(protocol: TokenUsageProtocol, itemMeters: Record<string, unknown>, version: OfficialPriceVersion): FlatTextMeter[] | undefined {
    if (protocol === "openai-chat" && version.manufacturer === "Moonshot" && version.sku === "kimi-k3") return ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"];
    const inclusive = Object.values(itemMeters).some((meters) => Array.isArray(meters) && meters.includes("uncachedInputTokens"));
    return inclusive && (protocol === "openai-chat" || protocol === "openai-responses") ? OPENAI_INCLUSIVE_INPUT_METERS : FLAT_TEXT_REQUIRED_METERS[protocol];
}

function validateChannelIdentity(raw: unknown, version: OfficialPriceVersion, requestedModel: string, reportedModel: string): FlatTextChannelIdentity | undefined {
    if (version.logicalModelId && raw === undefined) return undefined;
    if (!version.sku || requestedModel === version.sku) {
        if (raw !== undefined) throw new PricingInputError("相同官网 SKU 的渠道绑定不需要别名身份映射");
        return undefined;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("渠道别名缺少独立审核的型号身份");
    const identity = raw as Record<string, unknown>;
    if (identity.officialSku !== version.sku || identity.operation !== "generation" || typeof identity.channelBindingId !== "string" || !identity.channelBindingId.trim()) throw new PricingInputError("渠道别名的绑定、官网 SKU 或操作身份不一致");
    if (identity.modelIdentity !== "response-required" && identity.modelIdentity !== "reviewed-request") throw new PricingInputError("渠道别名的响应型号核对方式无效");
    if (identity.modelIdentity === "response-required" && !reportedModel) throw new PricingInputError("渠道别名要求响应报告已审核型号");
    let source: URL;
    try {
        source = new URL(String(identity.sourceUrl));
    } catch {
        throw new PricingInputError("渠道别名身份须附 HTTPS 来源");
    }
    if (source.protocol !== "https:" || source.username || source.password || typeof identity.evidence !== "string" || !identity.evidence.trim()) throw new PricingInputError("渠道别名身份须附 HTTPS 来源与核对依据");
    return { channelBindingId: identity.channelBindingId.trim(), officialSku: version.sku, operation: "generation", modelIdentity: identity.modelIdentity, sourceUrl: source.href, evidence: identity.evidence.trim() };
}

export function validateFlatTextPriceContract(raw: unknown, version: OfficialPriceVersion, reviewedBy: string, reviewedAt: string): FlatTextPriceContract {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("纯文本计费契约格式无效");
    const input = raw as Record<string, unknown>;
    const schedule = version.textPriceSchedule ? validateTextPriceSchedule(version.textPriceSchedule) : undefined;
    if (schedule) {
        for (const group of schedule.groups.filter((item) => item.selector.processingMode === "standard")) assertRegularPaidPriceItems(officialItemsForTextPriceGroup(group));
    } else assertRegularPaidPriceItems(version.items);
    const value = (key: keyof FlatTextPriceContractInput) => {
        const item = input[key];
        if (typeof item !== "string" || !item.trim()) throw new PricingInputError(`计费契约 ${key} 不能为空`);
        return item.trim();
    };
    if (version.tier !== "paid" || !version.reviewedBy || !Number.isFinite(Date.parse(version.publishedAt))) throw new PricingInputError("只能审核已发布的付费官方价目");
    const protocol = value("protocol") as TokenUsageProtocol;
    const requestedModel = value("requestedModel");
    const reportedModel = typeof input.reportedModel === "string" ? input.reportedModel.trim() : "";
    const identity = validateChannelIdentity(input.identity, version, requestedModel, reportedModel);
    const serviceTier = value("serviceTier");
    if (!["default", "standard"].includes(serviceTier.toLowerCase())) throw new PricingInputError("纯文本契约仅支持已审核的 Standard 服务档");
    if (!FLAT_TEXT_REQUIRED_METERS[protocol]) throw new PricingInputError("不支持的纯文本用量协议");
    if (!["global-standard-text-flat", "global-standard-text-tiered", "global-standard-deepseek-utc"].includes(String(input.scope)) || input.region !== "global") throw new PricingInputError("仅支持已核对的全球标准纯文本价目");
    if (schedule && (input.scope !== "global-standard-text-tiered" || input.contextTiers !== undefined)) throw new PricingInputError("结构化文本价格组须使用自身已审核条件，不能另填价档");
    const contextTiers = !schedule && input.scope === "global-standard-text-tiered" ? validateFlatTextContextTiers(input.contextTiers, version, protocol) : undefined;
    if (input.scope !== "global-standard-text-tiered" && input.contextTiers !== undefined) throw new PricingInputError("该价档不能包含长上下文分档");
    if (input.scope === "global-standard-deepseek-utc" && (protocol !== "openai-chat" || !supportsDeepSeekTimePricing(version))) throw new PricingInputError("仅完整的 DeepSeek 官方峰谷价目可使用 UTC 时段契约");
    const meters = input.itemMeters;
    if (!meters || typeof meters !== "object" || Array.isArray(meters)) throw new PricingInputError("请填写官方分项与用量字段的映射");
    const itemMeters = meters as Record<string, unknown>;
    const required = requiredMeters(protocol, itemMeters, version)!;
    const priceItems = schedule ? officialItemsForTextPriceGroup(schedule.groups.find((group) => group.selector.processingMode === "standard")!) : version.items;
    if (Object.keys(itemMeters).length !== priceItems.length || Object.keys(itemMeters).some((key) => !priceItems.some((item) => item.key === key))) throw new PricingInputError("计费契约必须与官方价目分项完全一致");
    const groups = contextTiers ? [contextTiers.shortItemKeys, contextTiers.longItemKeys] : input.scope === "global-standard-deepseek-utc" ? [DEEPSEEK_TIME_PRICE_KEYS.peak, DEEPSEEK_TIME_PRICE_KEYS.offPeak] : [priceItems.map((item) => item.key)];
    for (const group of groups) {
        const seen = new Set<string>();
        for (const key of group) {
            const item = priceItems.find((candidate) => candidate.key === key)!;
            const mapped = itemMeters[key];
            if (item.unit.trim().toLowerCase() !== "token" || !Array.isArray(mapped) || !mapped.length) throw new PricingInputError(`分项 ${key} 必须绑定 token 用量`);
            if (input.scope === "global-standard-deepseek-utc") {
                const expected = key.startsWith("cacheHit") ? "cachedInputTokens" : key.startsWith("cacheMiss") ? "uncachedInputTokens" : "outputTokens";
                if (mapped.length !== 1 || mapped[0] !== expected) throw new PricingInputError(`DeepSeek 分项 ${key} 必须绑定 ${expected}`);
            }
            for (const meter of mapped) {
                if (typeof meter !== "string" || !required.includes(meter as FlatTextMeter) || seen.has(meter)) throw new PricingInputError(`分项 ${key} 的计量字段无效或重复`);
                seen.add(meter);
            }
        }
        if (seen.size !== required.length) throw new PricingInputError("计费契约未覆盖协议的全部计量字段");
    }
    return {
        officialVersionId: version.id,
        channelId: value("channelId"),
        protocol,
        requestedModel,
        reportedModel,
        scope: input.scope as FlatTextPriceContract["scope"],
        region: "global",
        serviceTier,
        itemMeters: itemMeters as Record<string, FlatTextMeter[]>,
        evidence: value("evidence"),
        ...(identity ? { identity } : {}),
        reviewedAt,
        reviewedBy,
        ...(input.requestLimits === undefined ? {} : { requestLimits: validateFlatTextRequestLimits(input.requestLimits) }),
        ...(input.reservationEstimate === undefined ? {} : { reservationEstimate: validateFlatTextReservationEstimate(input.reservationEstimate) }),
        ...(contextTiers ? { contextTiers } : {}),
    };
}

export function validateFlatTextReservationEstimate(raw: unknown): FlatTextReservationEstimate {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("文本预留估算依据无效");
    const value = raw as Record<string, unknown>;
    let url: URL;
    try {
        url = new URL(String(value.sourceUrl));
    } catch {
        throw new PricingInputError("文本预留估算须附 HTTPS 来源");
    }
    if (value.method !== "request-size-recent-output" || url.protocol !== "https:" || url.username || url.password || typeof value.evidence !== "string" || !value.evidence.trim())
        throw new PricingInputError("请核实文本预留估算方法、HTTPS 来源和差额处理依据");
    return { method: "request-size-recent-output", sourceUrl: url.href, evidence: value.evidence.trim() };
}

function validateFlatTextContextTiers(raw: unknown, version: OfficialPriceVersion, protocol: TokenUsageProtocol): FlatTextContextTiers {
    if (protocol !== "openai-chat" && protocol !== "openai-responses") throw new PricingInputError("该协议尚无长上下文计费契约");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("长上下文价档配置无效");
    const value = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(value.thresholdInputTokens) || Number(value.thresholdInputTokens) <= 0) throw new PricingInputError("长上下文输入阈值必须是官方核实的正整数");
    const shortItemKeys = value.shortItemKeys;
    const longItemKeys = value.longItemKeys;
    const keys = [...(Array.isArray(shortItemKeys) ? shortItemKeys : []), ...(Array.isArray(longItemKeys) ? longItemKeys : [])];
    if (
        !Array.isArray(shortItemKeys) ||
        !shortItemKeys.length ||
        !Array.isArray(longItemKeys) ||
        !longItemKeys.length ||
        keys.length !== version.items.length ||
        new Set(keys).size !== keys.length ||
        keys.some((key) => !version.items.some((item) => item.key === key))
    )
        throw new PricingInputError("长上下文两档必须完整且互斥地覆盖官方分项");
    let url: URL;
    try {
        url = new URL(String(value.sourceUrl));
    } catch {
        throw new PricingInputError("长上下文阈值必须附 HTTPS 来源");
    }
    if (url.protocol !== "https:" || url.username || url.password || typeof value.evidence !== "string" || !value.evidence.trim()) throw new PricingInputError("请核实长上下文阈值和整次请求适用依据");
    return { thresholdInputTokens: Number(value.thresholdInputTokens), shortItemKeys: shortItemKeys as string[], longItemKeys: longItemKeys as string[], sourceUrl: url.href, evidence: value.evidence.trim() };
}

export function validateFlatTextRequestLimits(raw: unknown): FlatTextRequestLimits {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("请求上界格式无效");
    const value = raw as Record<string, unknown>;
    for (const key of ["maxInputTokens", "maxOutputTokens", "maxCandidates"] as const) {
        if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] <= 0) throw new PricingInputError("请求上界必须是已核实的正整数");
    }
    let url: URL;
    try {
        url = new URL(String(value.sourceUrl));
    } catch {
        throw new PricingInputError("请求上界必须附 HTTPS 来源");
    }
    if (url.protocol !== "https:" || url.username || url.password || typeof value.evidence !== "string" || !value.evidence.trim() || value.includesReasoning !== true) throw new PricingInputError("请核实请求上界来源、渠道执行依据及推理 Token 范围");
    return { maxInputTokens: value.maxInputTokens as number, maxOutputTokens: value.maxOutputTokens as number, maxCandidates: value.maxCandidates as number, sourceUrl: url.href, evidence: value.evidence.trim(), includesReasoning: true };
}

export function previewObservedFlatTextQuote(input: { version: OfficialPriceVersion; policy: SalesVersion; contract: FlatTextPriceContract; observation: TokenUsageObservation; call: FlatTextCallContext; rules?: TextUsageRule }) {
    const { version, policy, contract, call } = input;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const observation: TokenUsageObservation = {
        ...input.observation,
        quantities: { ...input.observation.quantities },
        meterSources: Object.fromEntries(Object.entries(input.observation.meterSources || {}).map(([meter, source]) => [meter, { ...source, paths: [...source.paths], ...(source.inputMeters ? { inputMeters: [...source.inputMeters] } : {}) }])),
    };
    const derive = (meter: string, inputMeters: string[], formula: string) => {
        const sources = inputMeters.map((item) => observation.meterSources?.[item]);
        if (sources.some((source) => !source?.paths.length)) return;
        observation.meterSources![meter] = { paths: sources.flatMap((source) => source!.paths), kind: "approved-derivation", formula, inputMeters };
    };
    const sources: Record<string, "reported" | "reported-zero" | "defaulted-zero"> = {};
    const zero = (meter: string, permitted: boolean) => {
        if (observation.quantities[meter] !== undefined) {
            sources[meter] = observation.quantities[meter] === "0" ? "reported-zero" : "reported";
            return;
        }
        if (permitted && !observation.invalid) {
            observation.quantities[meter] = "0";
            sources[meter] = "defaulted-zero";
            const parent = meter === "cacheWrite5mTokens" || meter === "cacheWrite1hTokens" ? (contract.protocol === "anthropic-messages" ? "cacheWriteTotalTokens" : "cacheWriteTokens") : undefined;
            if (parent && observation.meterSources?.[parent]?.paths.length)
                observation.meterSources![meter] = { paths: [...observation.meterSources[parent].paths], kind: "approved-derivation", formula: "zero total implies zero TTL bucket", inputMeters: [parent] };
            else if (input.rules) observation.meterSources![meter] = { paths: [`rule:textUsageRule:${input.rules.id}`], kind: "approved-derivation", formula: "reviewed missing field defaults to zero", inputMeters: [] };
        }
    };
    if (input.rules && (input.rules.modelId !== (call.modelId || version.logicalModelId) || input.rules.officialVersionId !== version.id)) reasons.push("缓存缺失规则与官方价版本不一致");
    else {
        zero("cachedInputTokens", input.rules?.cacheReadMissingAsZero === true);
        if (contract.protocol === "anthropic-messages") {
            if (observation.quantities.cacheWriteTotalTokens === undefined && input.rules?.cacheWriteMissingAsZero) {
                zero("cacheWriteTotalTokens", true);
                zero("cacheWrite5mTokens", true);
                zero("cacheWrite1hTokens", true);
            }
        } else if (contract.protocol !== "gemini-generate") {
            zero("cacheWriteTokens", input.rules?.cacheWriteMissingAsZero === true);
            if (observation.quantities.cacheWriteTokens === "0" && contract.requestedModel === "kimi-k3") {
                zero("cacheWrite5mTokens", true);
                zero("cacheWrite1hTokens", true);
            }
        }
        const total = observation.quantities.inputTotalTokens;
        const cached = observation.quantities.cachedInputTokens;
        const written = observation.quantities.cacheWriteTokens;
        if (total !== undefined && cached !== undefined && /^\d+$/.test(total) && /^\d+$/.test(cached)) {
            if (BigInt(cached) > BigInt(total)) reasons.push("缓存读取用量超过输入总量");
            else {
                observation.quantities.uncachedInputTokens = (BigInt(total) - BigInt(cached)).toString();
                derive("uncachedInputTokens", ["inputTotalTokens", "cachedInputTokens"], "inputTotalTokens - cachedInputTokens");
                if (contract.protocol === "gemini-generate") {
                    observation.quantities.inputTokens = observation.quantities.uncachedInputTokens;
                    derive("inputTokens", ["inputTotalTokens", "cachedInputTokens"], "inputTotalTokens - cachedInputTokens");
                }
                if (written !== undefined && /^\d+$/.test(written)) {
                    if (BigInt(cached) + BigInt(written) > BigInt(total)) reasons.push("缓存读写用量超过输入总量");
                    else {
                        observation.quantities.inputTokens = (BigInt(total) - BigInt(cached) - BigInt(written)).toString();
                        derive("inputTokens", ["inputTotalTokens", "cachedInputTokens", "cacheWriteTokens"], "inputTotalTokens - cachedInputTokens - cacheWriteTokens");
                    }
                }
            }
        }
    }
    const totalInput = observation.quantities.inputTotalTokens;
    let pricedVersion = version;
    let selectedGroupId: string | undefined;
    if (version.textPriceSchedule) {
        try {
            const selected = selectStandardTextPriceVersion(version, totalInput && /^\d+$/.test(totalInput) ? Number(totalInput) : NaN);
            pricedVersion = selected.version;
            selectedGroupId = selected.groupId;
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
            reasons.push(error.message);
        }
    }
    try {
        assertRegularPaidPriceItems(pricedVersion.items);
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
    if (policy.id !== call.salesVersionId || call.officialVersionId !== version.id || !publishedPriceMatches(call.modelId || version.logicalModelId, version, policy, call.priceSelection) || contract.officialVersionId !== version.id)
        reasons.push("官方价版本与已发布售价不一致");
    if (version.tier !== "paid") reasons.push("仅支持已审核付费档的纯文本价目");
    if (!contract.reviewedBy.trim() || !contract.evidence.trim() || !Number.isFinite(Date.parse(contract.reviewedAt))) reasons.push("计费契约尚未审核");
    if (!FLAT_TEXT_REQUIRED_METERS[contract.protocol] || contract.protocol !== observation.protocol) reasons.push("上游协议与计费契约不一致");
    if (contract.scope !== "global-standard-text-flat" && contract.scope !== "global-standard-text-tiered" && contract.scope !== "global-standard-deepseek-utc") reasons.push("价目不是已核对的全球标准纯文本契约");
    if (!contract.channelId || call.channelId !== contract.channelId) reasons.push("承接渠道未经逐渠道核对");
    if (call.requestedModel !== contract.requestedModel) reasons.push("上游请求型号未确认");
    let identity: FlatTextChannelIdentity | undefined;
    try {
        identity = validateChannelIdentity(contract.identity, version, contract.requestedModel, contract.reportedModel);
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        reasons.push(error.message);
    }
    if (identity) {
        if (!observation.reportedModel && identity.modelIdentity === "response-required") reasons.push("渠道别名缺少要求的响应型号");
        if (observation.reportedModel && observation.reportedModel !== contract.reportedModel) reasons.push(`渠道别名响应型号与已审核身份不一致：${observation.reportedModel}`);
    } else if (observation.reportedModel && observation.reportedModel !== (contract.reportedModel || contract.requestedModel)) warnings.push(`响应型号与已审核请求型号不一致：${observation.reportedModel}`);
    if (contract.region !== "global" || call.region !== contract.region || (observation.inferenceGeo && observation.inferenceGeo !== contract.region)) reasons.push("国际区域无法确认");
    if (!contract.serviceTier || !["default", "standard"].includes(contract.serviceTier.toLowerCase()) || (call.serviceTier && !["default", "standard"].includes(call.serviceTier.toLowerCase()))) reasons.push("请求服务档位不是已审核 Standard");
    if (observation.serviceTier && !["default", "standard"].includes(observation.serviceTier.toLowerCase())) warnings.push(`响应报告了非 Standard 服务档位：${observation.serviceTier}`);
    if (call.billingMode !== "standard") reasons.push("调用不是标准实时计费模式");
    if (call.inputModalities.length !== 1 || call.inputModalities[0] !== "text" || call.outputModalities.length !== 1 || call.outputModalities[0] !== "text" || call.usesExternalTools) reasons.push("调用包含未计价的模态或工具");
    if (!call.responseComplete) reasons.push("上游响应尚未完整结束");
    const occurredAt = Date.parse(call.occurredAt);
    if (!Number.isFinite(occurredAt) || (version.effectiveFrom && occurredAt < Date.parse(version.effectiveFrom)) || (version.effectiveTo && occurredAt >= Date.parse(version.effectiveTo))) reasons.push("调用不在价目有效期内");
    if (Number.isFinite(occurredAt) && [version.publishedAt, policy.publishedAt, contract.reviewedAt].some((value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) > occurredAt)) reasons.push("调用早于价目、售价或计费契约审核");
    if (observation.invalid) reasons.push(`上游用量无效：${observation.invalid}`);
    if (version.manufacturer === "Moonshot" && version.sku === "kimi-k2.6" && observation.quantities.cacheWriteTokens && observation.quantities.cacheWriteTokens !== "0") reasons.push("Kimi K2.6 不支持缓存写入，回执计量需核对");
    if (version.manufacturer === "Moonshot" && ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"].includes(version.sku) && observation.quantities.cacheWriteTokens && observation.quantities.cacheWriteTokens !== "0")
        reasons.push("Kimi K2.7 Code 缓存写入分项未核实，回执计量需核对");

    if (contract.contextTiers && contract.scope !== "global-standard-text-tiered") reasons.push("单档契约不能包含长上下文分档");
    if (contract.scope === "global-standard-text-tiered" || contract.scope === "global-standard-deepseek-utc") {
        try {
            validateFlatTextPriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
            reasons.push(error.message);
        }
    }
    if ((contract.contextTiers || version.textPriceSchedule) && (!totalInput || !/^\d+$/.test(totalInput))) reasons.push("缺少判定长上下文价档的输入总量");
    if ((contract.contextTiers || version.textPriceSchedule) && totalInput && /^\d+$/.test(totalInput)) {
        const inputMeters = new Set((requiredMeters(contract.protocol, contract.itemMeters, version) || []).filter((meter) => meter !== "outputTokens"));
        if ([...inputMeters].every((meter) => /^\d+$/.test(observation.quantities[meter] || "")) && [...inputMeters].reduce((sum, meter) => sum + BigInt(observation.quantities[meter]), BigInt(0)) !== BigInt(totalInput))
            reasons.push("长上下文输入总量与分项用量不一致");
    }
    let activeKeys = contract.contextTiers && totalInput && /^\d+$/.test(totalInput) ? new Set(BigInt(totalInput) > BigInt(contract.contextTiers.thresholdInputTokens) ? contract.contextTiers.longItemKeys : contract.contextTiers.shortItemKeys) : undefined;
    if (contract.scope === "global-standard-deepseek-utc") {
        try {
            activeKeys = new Set(DEEPSEEK_TIME_PRICE_KEYS[deepSeekSalesTimeTier(version, policy, call.occurredAt, call.modelId || version.logicalModelId)]);
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
            reasons.push(error.message);
        }
    }
    const required = new Set(requiredMeters(contract.protocol, contract.itemMeters, version) || []);
    for (const meter of required) {
        if (observation.quantities[meter] !== undefined && sources[meter] === undefined) sources[meter] = observation.quantities[meter] === "0" ? "reported-zero" : "reported";
    }
    const seen = new Set<FlatTextMeter>();
    const usage: Record<string, string> = {};
    if (Object.keys(contract.itemMeters).some((key) => !pricedVersion.items.some((item) => item.key === key))) reasons.push("计费契约包含官方价目以外的分项");
    for (const item of pricedVersion.items) {
        if (activeKeys && !activeKeys.has(item.key)) {
            usage[item.key] = "0";
            continue;
        }
        const meters = contract.itemMeters[item.key];
        if (item.unit.trim().toLowerCase() !== "token" || !Array.isArray(meters) || meters.length === 0) {
            reasons.push(`分项 ${item.key} 没有可验证的 token 计量绑定`);
            continue;
        }
        let quantity = new Decimal(0);
        for (const meter of meters) {
            if (!required.has(meter) || seen.has(meter)) {
                reasons.push(`计量字段 ${meter} 不适用或重复`);
                continue;
            }
            seen.add(meter);
            const value = observation.quantities[meter];
            if (!value || !/^\d+$/.test(value)) reasons.push(`缺少 ${meter} 的真实用量`);
            else quantity = quantity.add(value);
        }
        usage[item.key] = quantity.toFixed();
    }
    for (const meter of required) if (!seen.has(meter)) reasons.push(`未覆盖 ${meter} 计量字段`);
    if (reasons.length) return { ready: false as const, reasons };
    try {
        return { ready: true as const, usage, quote: { ...quoteSalesPrice({ version: pricedVersion, policy, usage, modelId: call.modelId }), ...(selectedGroupId ? { selectedGroupId } : {}) }, warnings, sources, normalizedObservation: observation };
    } catch (error) {
        if (!(error instanceof PricingInputError)) throw error;
        return { ready: false as const, reasons: [error.message] };
    }
}
