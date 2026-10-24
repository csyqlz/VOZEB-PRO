import Fraction from "fraction.js";

import { pricingDecimal } from "../model-pricing-precision";
import { validateOfficialPriceItems } from "./official-price-items";
import { modelPriceBindingScope } from "./price-bindings";
import { nonnegativeDecimal, POINTS_PER_CNY, PricingInputError, requiredText } from "./primitives";
import { validateTextPriceSchedule } from "./text-price-groups";
import type { BusinessExchangeRate, ModelPriceBinding, OfficialPriceDraft, OfficialPriceInput, OfficialPriceItem, OfficialPriceObservation, OfficialPriceVersion, OpenAiProcessingTier, PricingState, SalesPolicy, UserPriceRule } from "./types";

export { validateOfficialPriceItems } from "./official-price-items";

export function officialPriceStructureItems(items: OfficialPriceItem[]): OfficialPriceItem[] {
    return items.map(({ key, unit, per }) => ({ key, unit, per, price: "", currency: "" }));
}
export function officialPriceReferenceItems(items: OfficialPriceItem[]): OfficialPriceItem[] {
    return items.map(({ key, unit, per, price, currency }) => ({ key, unit, per, price, currency }));
}
export function officialPriceObservationVariants(observation: OfficialPriceObservation) {
    const originals: NonNullable<OfficialPriceObservation["priceVariants"]> = observation.priceVariants?.length
        ? observation.priceVariants
        : [
              {
                  evidence: observation.evidence,
                  conditions: observation.conditions,
                  items: observation.items,
                  suggestedSeries: observation.suggestedSeries,
                  suggestedVersion: observation.suggestedVersion,
                  suggestedTier: observation.suggestedTier,
                  suggestedProcessingTier: observation.suggestedProcessingTier,
                  suggestedEffectiveFrom: observation.suggestedEffectiveFrom,
                  suggestedEffectiveTo: observation.suggestedEffectiveTo,
                  headerEvidence: observation.headerEvidence,
              },
          ];
    return originals.map((variant, variantIndex) => {
        const amendment = observation.amendments?.findLast((value) => value.variantIndex === variantIndex);
        return { ...variant, conditions: amendment?.conditions ?? variant.conditions, items: amendment?.items ?? variant.items, amendment };
    });
}
export function officialPriceConditionChoices(manufacturer: string, capability: string, sku: string): string[] {
    if (manufacturer !== "ByteDance / Volcengine") return [];
    if (capability === "text") return ["Standard · 线上推理"];
    if (capability === "video" && sku === "dreamina-seedance-2-5-260628") return ["在线推理 · 视频生成"];
    if (capability === "image" && sku === "dola-seedream-5-0-pro-260628") return ["图片生成 · 按张"];
    return [];
}

export function officialPriceItemConditionChoices(manufacturer: string, capability: string, sku: string): string[] {
    if (manufacturer !== "ByteDance / Volcengine") return [];
    if (capability === "video" && sku === "dreamina-seedance-2-5-260628") return ["输出 480p/720p · 无输入视频", "输出 480p/720p · 含输入视频", "输出 1080p · 无输入视频", "输出 1080p · 含输入视频"];
    if (capability === "image" && sku === "dola-seedream-5-0-pro-260628") return ["单图生成 · ≤ 2.61M 像素", "单图生成 · > 2.61M 像素", "分层输出 · ≤ 2.61M 像素", "分层输出 · > 2.61M 像素", "参考图 · 第 2 张起"];
    if (capability === "text" && sku === "seed-2-0-pro-260328") return ["输入总量 ≤ 128000 token", "输入总量 > 128000 且 ≤ 256000 token"];
    return [];
}
export function officialPriceDraftIssues(draft: OfficialPriceDraft): string[] {
    const missing: string[] = (
        [
            ["manufacturer", "官方厂商"],
            ["officialVersion", "官方模型版本"],
            ["sku", "官方 SKU"],
            ["tier", "免费/付费档"],
            ["conditions", "适用条件"],
            ["sourceUrl", "官方来源"],
            ["evidence", "官网证据"],
            ["observedAt", "查看时间"],
        ] as const
    )
        .filter(([key]) => !draft[key])
        .map(([, label]) => label);
    if (!draft.logicalModelId && !draft.capability) missing.push("模型能力");
    if (!draft.textPriceSchedule) {
        if (!draft.items?.length) missing.push("价格分项");
        else if (draft.items.some((item) => !item.key || !item.unit || !item.per || !item.price || !item.currency)) missing.push("价格分项字段");
        else if (draft.items.some((item) => item.currency.trim().toUpperCase() !== "USD")) missing.push("仅支持国际站 USD 官方价");
    }
    if (draft.manufacturer === "OpenAI" && !draft.processingTier) missing.push("OpenAI 处理档位");
    if (!missing.length) {
        try {
            validateOfficialPriceInput(draft);
        } catch (error) {
            missing.push(error instanceof Error ? error.message : "价目格式无效");
        }
    }
    return missing;
}

export function assertUsdOfficialPriceInput(input: OfficialPriceInput): void {
    if (input.items.some((item) => item.currency !== "USD") || input.textPriceSchedule?.groups.some((group) => group.lines.some((line) => line.currency !== "USD"))) throw new PricingInputError("仅支持国际站 USD 官方价");
}
export const EMPTY_PRICING_STATE: PricingState = { candidates: [], officialVersions: [], salesVersions: [] };

export const DEEPSEEK_TIME_PRICE_KEYS = {
    peak: ["cacheHitInputTokensPeak", "cacheMissInputTokensPeak", "outputTokensPeak"],
    offPeak: ["cacheHitInputTokensOffPeak", "cacheMissInputTokensOffPeak", "outputTokensOffPeak"],
} as const;
export function supportsDeepSeekTimePricing(version: OfficialPriceVersion) {
    const keys = version.items.map((item) => item.key);
    return (
        version.manufacturer === "DeepSeek" &&
        (version.logicalModelId ? version.logicalModelId === version.sku : version.capability === "text") &&
        keys.length === 6 &&
        [...DEEPSEEK_TIME_PRICE_KEYS.peak, ...DEEPSEEK_TIME_PRICE_KEYS.offPeak].every((key) => keys.includes(key)) &&
        version.items.every((item) => item.unit.toLowerCase() === "token" && item.currency === "USD" && item.per === "1000000")
    );
}

/** Platform sales rule: holidays are intentionally excluded, so this is not an upstream-cost claim. */
export function deepSeekSalesTimeTier(version: OfficialPriceVersion, policy: SalesPolicy, occurredAt: string, modelId = version.logicalModelId): "peak" | "offPeak" {
    if (!supportsDeepSeekTimePricing(version)) throw new PricingInputError("该模型没有完整且已核实的 DeepSeek 峰谷价目");
    if (!policy.deepSeekUtcWindowModels?.includes(modelId)) return "peak";
    const at = new Date(occurredAt);
    if (!Number.isFinite(at.getTime())) throw new PricingInputError("峰谷计价时间无效");
    const day = at.getUTCDay();
    const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
    return day >= 1 && day <= 5 && ((minute >= 60 && minute < 240) || (minute >= 360 && minute < 600)) ? "peak" : "offPeak";
}

export function hasMatchingOfficialVariant(officialModelId: string, logicalModelId: string) {
    if (/(?:^|[-_.])seedance[-_.]/i.test(officialModelId)) {
        const version = (value: string) =>
            value
                .match(/(?:^|[-_.])seedance[-_.](\d+)[-_.](\d+)(?=[-_.]|$)/i)
                ?.slice(1, 3)
                .join(".");
        const officialVersion = version(officialModelId);
        if (!officialVersion || officialVersion !== version(logicalModelId)) return false;
    }
    return ["fast", "mini", "lite", "pro"].every((variant) => {
        const pattern = new RegExp(`(?:^|[-_.])${variant}(?:[-_.]|$)`, "i");
        return pattern.test(officialModelId) === pattern.test(logicalModelId);
    });
}

export function hasMatchingByteDanceSku(officialModelId: string, logicalModelId: string) {
    const identity = (value: string) =>
        value
            .match(/(?:^|[-_.])(seedance|seedream|seed)[-_.](\d+)[-_.](\d+)(?=[-_.]|$)/i)
            ?.slice(1, 4)
            .map((part) => part.toLowerCase())
            .join(":");
    if (!identity(officialModelId) || identity(officialModelId) !== identity(logicalModelId)) return false;
    return ["fast", "mini", "lite", "pro", "flash", "turbo"].every((variant) => {
        const pattern = new RegExp(`(?:^|[-_.])${variant}(?=[-_.]|$)`, "i");
        return pattern.test(officialModelId) === pattern.test(logicalModelId);
    });
}

export function isMainlandByteDancePrice(candidate: Pick<OfficialPriceInput, "manufacturer" | "sourceUrl">): boolean {
    if (candidate.manufacturer !== "ByteDance / Volcengine") return false;
    try {
        return new URL(candidate.sourceUrl).hostname === "docs.volcengine.com";
    } catch {
        return false;
    }
}

export function validateBusinessExchangeRate(value: unknown): BusinessExchangeRate {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PricingInputError("汇率格式无效");
    const input = value as Record<string, unknown>;
    const observedAt = requiredText(input.observedAt, "汇率确认时间");
    if (!Number.isFinite(Date.parse(observedAt))) throw new PricingInputError("汇率确认时间无效");
    return { cnyPerUsd: nonnegativeDecimal(input.cnyPerUsd, "美元兑人民币汇率", true), observedAt, evidence: requiredText(input.evidence, "汇率依据") };
}

export function validateOfficialPriceInput(value: unknown): OfficialPriceInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PricingInputError("官方价目格式无效");
    const input = value as Record<string, unknown>;
    const sourceUrl = requiredText(input.sourceUrl, "官方来源链接");
    try {
        if (new URL(sourceUrl).protocol !== "https:") throw new Error();
    } catch {
        throw new PricingInputError("官方来源必须是 HTTPS 链接");
    }
    if (input.tier !== "free" && input.tier !== "paid") throw new PricingInputError("请选择免费或付费档");
    const processingTier = input.processingTier;
    if (processingTier !== undefined && (input.manufacturer !== "OpenAI" || typeof processingTier !== "string" || !["standard", "batch", "flex", "fast", "ultrafast"].includes(processingTier))) throw new PricingInputError("OpenAI 处理档位无效");
    if (input.sourceKind !== "manual" && input.sourceKind !== "machine") throw new PricingInputError("请选择来源类型");
    const observedAt = requiredText(input.observedAt, "证据查看时间");
    if (!Number.isFinite(Date.parse(observedAt))) throw new PricingInputError("证据查看时间无效");
    const effectiveFrom = typeof input.effectiveFrom === "string" && input.effectiveFrom.trim() ? input.effectiveFrom.trim() : undefined;
    const effectiveTo = typeof input.effectiveTo === "string" && input.effectiveTo.trim() ? input.effectiveTo.trim() : undefined;
    if (effectiveFrom && !Number.isFinite(Date.parse(effectiveFrom))) throw new PricingInputError("生效开始时间无效");
    if (effectiveTo && !Number.isFinite(Date.parse(effectiveTo))) throw new PricingInputError("生效结束时间无效");
    if (effectiveFrom && effectiveTo && Date.parse(effectiveFrom) >= Date.parse(effectiveTo)) throw new PricingInputError("生效结束必须晚于开始");
    const textPriceSchedule = input.textPriceSchedule === undefined ? undefined : validateTextPriceSchedule(input.textPriceSchedule);
    if (textPriceSchedule && input.capability !== "text") throw new PricingInputError("文本分档价必须明确选择文本模型能力");
    if (textPriceSchedule && processingTier && processingTier !== "standard") throw new PricingInputError("可执行文本分档价仅支持 Standard 处理档位");
    if (textPriceSchedule && Array.isArray(input.items) && input.items.length) throw new PricingInputError("文本分档价不能同时填写平价分项");
    const items = textPriceSchedule ? [] : validateOfficialPriceItems(input.items);
    const logicalModelId = typeof input.logicalModelId === "string" ? input.logicalModelId.trim() : "";
    const capability = input.capability;
    if (capability !== undefined && !["text", "image", "video", "audio"].includes(String(capability))) throw new PricingInputError("模型能力无效");
    if (!logicalModelId && !capability) throw new PricingInputError("请选择模型能力");
    return {
        logicalModelId,
        ...(capability ? { capability: capability as OfficialPriceInput["capability"] } : {}),
        manufacturer: requiredText(input.manufacturer, "官方厂商"),
        ...(input.catalogVersionId ? { catalogVersionId: requiredText(input.catalogVersionId, "官方目录型号") } : {}),
        series: typeof input.series === "string" ? input.series.trim() : "",
        officialVersion: requiredText(input.officialVersion, "官方模型版本"),
        sku: requiredText(input.sku, "官方 SKU"),
        tier: input.tier,
        ...(processingTier ? { processingTier: processingTier as OpenAiProcessingTier } : {}),
        conditions: requiredText(input.conditions, "适用条件"),
        ...(effectiveFrom ? { effectiveFrom } : {}),
        ...(effectiveTo ? { effectiveTo } : {}),
        sourceKind: input.sourceKind,
        sourceUrl,
        evidence: requiredText(input.evidence, "页面或接口证据"),
        observedAt,
        items,
        ...(textPriceSchedule ? { textPriceSchedule } : {}),
    };
}

export function validateSalesPolicy(value: unknown, officialVersions: OfficialPriceVersion[], modelIds: string[], currentSelections: ModelPriceBinding[] = []): SalesPolicy {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PricingInputError("销售策略格式无效");
    const input = value as Record<string, unknown>;
    if ("planRules" in input || "modelMultipliers" in input) throw new PricingInputError("旧版套餐或模型倍率规则已停用，请使用用户售价系数");
    if (input.userPriceRules !== undefined && !Array.isArray(input.userPriceRules)) throw new PricingInputError("用户售价规则格式无效");
    const rawBindings = input.priceVersionIds === undefined ? {} : input.priceVersionIds;
    if (!rawBindings || typeof rawBindings !== "object" || Array.isArray(rawBindings)) throw new PricingInputError("官方价版本映射格式无效");
    const rawSelections = input.selectedPriceBindings;
    if (rawSelections !== undefined && !Array.isArray(rawSelections)) throw new PricingInputError("独立选价引用格式无效");
    if (!Object.keys(rawBindings).length && !(rawSelections as unknown[] | undefined)?.length) throw new PricingInputError("至少选择一个已审核官方价版本");
    const priceVersionIds: Record<string, string> = {};
    for (const [modelId, versionId] of Object.entries(rawBindings)) {
        if (!modelIds.includes(modelId)) throw new PricingInputError(`逻辑模型不存在：${modelId}`);
        const version = officialVersions.find((item) => item.id === versionId && item.logicalModelId === modelId);
        if (!version) throw new PricingInputError(`模型 ${modelId} 没有对应的已审核价目版本`);
        if (version.textPriceSchedule) throw new PricingInputError(`模型 ${modelId} 的分档价尚未接入在线销售，请使用独立选价预览`);
        priceVersionIds[modelId] = version.id;
    }
    const selectedPriceBindings: NonNullable<SalesPolicy["selectedPriceBindings"]> = [];
    for (const raw of (rawSelections || []) as unknown[]) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("独立选价引用无效");
        const selection = raw as Record<string, unknown>;
        const logicalModelId = requiredText(selection.logicalModelId, "选价逻辑模型");
        const scope = requiredText(selection.scope, "选价范围");
        const bindingId = requiredText(selection.bindingId, "选价绑定 ID");
        const bindingRevision = requiredText(selection.bindingRevision, "选价绑定 revision");
        const officialVersionId = requiredText(selection.officialVersionId, "选价官方版本");
        if (!modelIds.includes(logicalModelId) || priceVersionIds[logicalModelId]) throw new PricingInputError("选价逻辑模型不存在或与旧映射重复");
        if (selectedPriceBindings.some((item) => item.logicalModelId === logicalModelId && item.scope === scope)) throw new PricingInputError("同一模型与范围不能重复选价");
        const binding = currentSelections.find((item) => item.logicalModelId === logicalModelId && item.scope === scope);
        const price = officialVersions.find((item) => item.id === officialVersionId);
        if (
            !binding ||
            !binding.current ||
            binding.status !== "active" ||
            binding.id !== bindingId ||
            binding.revision !== bindingRevision ||
            binding.officialVersionId !== officialVersionId ||
            binding.processingMode !== "standard" ||
            modelPriceBindingScope(binding.capability, binding.operation, binding.processingMode) !== scope ||
            !price ||
            price.logicalModelId ||
            price.capability !== binding.capability ||
            (price.processingTier || "standard") !== binding.processingMode
        )
            throw new PricingInputError("选价绑定或官方价版本已变化，请重新预览");
        assertUsdOfficialPriceInput(price);
        if (price.tier !== "paid" || !(price.textPriceSchedule ? price.textPriceSchedule.groups.flatMap((group) => group.lines) : price.items).some((item) => new Fraction(item.price).compare(0) > 0))
            throw new PricingInputError("独立选价缺少常规付费官方价，不能发布用户售价");
        selectedPriceBindings.push({ logicalModelId, scope, bindingId, bindingRevision, officialVersionId });
    }
    const rawTimeModels = input.deepSeekUtcWindowModels;
    if (rawTimeModels !== undefined && (!Array.isArray(rawTimeModels) || rawTimeModels.some((id) => typeof id !== "string") || new Set(rawTimeModels).size !== rawTimeModels.length)) throw new PricingInputError("DeepSeek UTC 峰谷开关格式无效");
    const deepSeekUtcWindowModels = (rawTimeModels || []) as string[];
    for (const modelId of deepSeekUtcWindowModels) {
        const versionId = priceVersionIds[modelId] || selectedPriceBindings.find((item) => item.logicalModelId === modelId && item.scope === "text:generation:standard")?.officialVersionId;
        const version = officialVersions.find((item) => item.id === versionId);
        if (!version || !supportsDeepSeekTimePricing(version)) throw new PricingInputError(`模型 ${modelId} 不能启用 DeepSeek UTC 峰谷计价`);
    }
    const userPriceRules = Array.isArray(input.userPriceRules)
        ? input.userPriceRules.map((raw): UserPriceRule => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("用户售价规则无效");
              const item = raw as Record<string, unknown>;
              if (!["default", "manufacturer", "series", "model"].includes(String(item.scope))) throw new PricingInputError("用户售价规则层级无效");
              const scope = item.scope as UserPriceRule["scope"];
              const manufacturer = scope === "manufacturer" || scope === "series" ? requiredText(item.manufacturer, "厂商") : undefined;
              const series = scope === "series" ? requiredText(item.series, "系列") : undefined;
              const modelId = scope === "model" ? requiredText(item.modelId, "逻辑模型") : undefined;
              if (modelId && !modelIds.includes(modelId)) throw new PricingInputError(`用户售价规则模型不存在：${modelId}`);
              return { scope, ...(manufacturer ? { manufacturer } : {}), ...(series ? { series } : {}), ...(modelId ? { modelId } : {}), coefficient: nonnegativeDecimal(item.coefficient, "用户售价系数", true) };
          })
        : [];
    const ruleKeys = userPriceRules.map((item) => [item.scope, item.manufacturer || "", item.series || "", item.modelId || ""].join("\u0000"));
    if (new Set(ruleKeys).size !== ruleKeys.length) throw new PricingInputError("同一范围的用户售价规则不能重复");
    const pointsPerCurrency: Record<string, string> = {};
    const usdPerCurrency: Record<string, string> = { USD: "1" };
    const rateEvidence: Record<string, string> = {};
    const rawConversion = input.conversion && typeof input.conversion === "object" && !Array.isArray(input.conversion) ? (input.conversion as Record<string, unknown>) : null;
    const conversion = rawConversion
        ? {
              cnyPerUsd: nonnegativeDecimal(rawConversion.cnyPerUsd, "美元兑人民币汇率", true),
              pointsPerCny: POINTS_PER_CNY,
              observedAt: requiredText(rawConversion.observedAt, "汇率确认时间"),
              evidence: requiredText(rawConversion.evidence, "换算依据"),
          }
        : undefined;
    if (conversion && !Number.isFinite(Date.parse(conversion.observedAt))) throw new PricingInputError("汇率确认时间无效");
    if (rawConversion?.pointsPerCny !== undefined && String(rawConversion.pointsPerCny) !== POINTS_PER_CNY) throw new PricingInputError("每人民币元固定换算 100 积分");
    for (const [rawCurrency, value] of Object.entries(input.pointsPerCurrency && typeof input.pointsPerCurrency === "object" && !Array.isArray(input.pointsPerCurrency) ? input.pointsPerCurrency : {})) {
        const currency = rawCurrency.toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new PricingInputError("换算币种须为三位 ISO 代码");
        pointsPerCurrency[currency] = nonnegativeDecimal(value, `${currency} 积分换算率`, true);
    }
    for (const [rawCurrency, value] of Object.entries(input.usdPerCurrency && typeof input.usdPerCurrency === "object" && !Array.isArray(input.usdPerCurrency) ? input.usdPerCurrency : {})) {
        const currency = rawCurrency.toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new PricingInputError("换算币种须为三位 ISO 代码");
        if (currency === "USD" || currency === "CNY") continue;
        usdPerCurrency[currency] = nonnegativeDecimal(value, `${currency} 兑美元汇率`, true);
    }
    if (conversion) {
        const derived = { CNY: conversion.pointsPerCny, USD: pricingDecimal(new Fraction(conversion.cnyPerUsd).mul(conversion.pointsPerCny)) };
        for (const [currency, rate] of Object.entries(derived)) {
            if (pointsPerCurrency[currency] && pointsPerCurrency[currency] !== rate) throw new PricingInputError(`${currency} 积分换算率与汇率窗口不一致`);
            pointsPerCurrency[currency] = rate;
            rateEvidence[currency] = conversion.evidence;
        }
        usdPerCurrency.CNY = pricingDecimal(new Fraction(1).div(conversion.cnyPerUsd));
    }
    for (const versionId of [...Object.values(priceVersionIds), ...selectedPriceBindings.map((item) => item.officialVersionId)]) {
        const price = officialVersions.find((item) => item.id === versionId)!;
        for (const item of price.textPriceSchedule ? price.textPriceSchedule.groups.flatMap((group) => group.lines) : price.items) {
            if (!conversion) throw new PricingInputError("请先设置美元兑人民币业务汇率");
            if (!usdPerCurrency[item.currency]) throw new PricingInputError(`缺少 ${item.currency} 兑美元汇率`);
            const evidence = input.rateEvidence && typeof input.rateEvidence === "object" && !Array.isArray(input.rateEvidence) ? (input.rateEvidence as Record<string, unknown>)[item.currency] : undefined;
            if (!rateEvidence[item.currency]) rateEvidence[item.currency] = requiredText(evidence, `${item.currency} 换算依据`);
            if (item.currency !== "USD" && item.currency !== "CNY") pointsPerCurrency[item.currency] = pricingDecimal(new Fraction(usdPerCurrency[item.currency]).mul(pointsPerCurrency.USD));
        }
    }
    return {
        priceVersionIds,
        ...(selectedPriceBindings.length ? { selectedPriceBindings } : {}),
        userPriceRules,
        ...(conversion ? { conversion } : {}),
        usdPerCurrency,
        pointsPerCurrency,
        rateEvidence,
        ...(deepSeekUtcWindowModels.length ? { deepSeekUtcWindowModels } : {}),
    };
}
