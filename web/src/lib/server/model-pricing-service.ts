import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";

import { getFreshAuthSettings, getPublicUsersByIds } from "@/lib/auth/store";
import {
    assertUsdOfficialPriceInput,
    DEEPSEEK_TIME_PRICE_KEYS,
    deepSeekSalesTimeTier,
    hasMatchingOfficialVariant,
    hasMatchingByteDanceSku,
    isMainlandByteDancePrice,
    officialItemsForTextPriceGroup,
    PricingConflictError,
    PricingInputError,
    quoteSalesPrice,
    resolveUserPriceCoefficient,
    selectStandardTextPriceGroup,
    TextPriceSelectionError,
    validateBusinessExchangeRate,
    validateOfficialPriceInput,
    validateSalesPolicy,
    type OfficialPriceVersion,
    type ModelPriceBinding,
    type SalesPolicy,
    type SalesVersion,
    type UnpricedModel,
    type UnpricedModelStatus,
    supportsDeepSeekTimePricing,
} from "@/lib/model-pricing";
import { resolvePublishedModelPrice } from "./model-pricing-published-price";
import {
    getBusinessExchangeRate,
    getCurrentSalesVersion,
    getModelPricingCoverage,
    getOfficialVersionsByIds,
    bindReviewedPriceVersion,
    deletePriceCandidate,
    insertPriceCandidate,
    insertSalesVersion,
    listOfficialPriceReferences,
    getLatestOfficialVersionsForModels,
    listApprovedPriceVersionsPage,
    listOfficialPriceReviewLinks,
    listOfficialPriceSources,
    listPriceLifecycleMarks,
    listPricingPage,
    PRICING_PAGE_SIZE,
    saveBusinessExchangeRate,
    saveOfficialPriceSource,
    revisePriceCandidate,
    updatePriceCandidate,
    type PriceCandidateFilter,
} from "./model-pricing-store";
import { getModelPricingBatchStates } from "./model-pricing-admission-batch";
import { resolveOfficialPriceCatalogLink } from "./model-pricing-catalog-service";
import { getCurrentModelPriceBinding } from "./model-price-binding-store";

export type UnpricedModelFilter = { manufacturer?: string; series?: string; capability?: string; name?: string; status?: UnpricedModelStatus };
export type ModelWorkbenchFilter = { enabled?: "active" | "disabled" | "all"; manufacturer?: string; capability?: string; name?: string; status?: "no-candidate" | "pending-review" | "sales-unpublished" | "published" | "channel-pending" };

export const getOfficialPriceSources = () => listOfficialPriceSources();

export async function getOfficialPriceReferences(manufacturer: string, series?: string, officialVersion?: string) {
    if ([manufacturer, series, officialVersion].some((value) => value && value.length > 120)) throw new PricingInputError("价目筛选条件过长");
    return listOfficialPriceReferences(manufacturer, series, officialVersion);
}

export async function getIndependentOfficialPriceOptions(modelId: string, page = 1, skuQuery = "") {
    const model = (await getFreshAuthSettings()).logicalModels.find((item) => item.id === modelId);
    if (!model?.manufacturer || !["text", "image", "video", "audio"].includes(model.capability) || skuQuery.length > 120) throw new PricingInputError("请选择已配置厂商与能力的逻辑模型，型号搜索不超过 120 字");
    const result = await listApprovedPriceVersionsPage(page, { ownerless: true, manufacturer: model.manufacturer, capability: model.capability, skuQuery: skuQuery.trim() });
    return {
        ...result,
        page,
        pageSize: PRICING_PAGE_SIZE,
        items: result.items.map((version) => {
            const issues: string[] = [];
            if (version.tier !== "paid") issues.push("免费档仅存证");
            if (!(version.textPriceSchedule ? version.textPriceSchedule.groups.flatMap((group) => group.lines) : version.items).some((item) => new Decimal(item.price).gt(0))) issues.push("缺少常规付费官方价");
            if ((version.processingTier || "standard") !== "standard") issues.push("非 Standard 处理档位仅存证");
            try {
                assertUsdOfficialPriceInput(version);
            } catch (error) {
                if (!(error instanceof PricingInputError)) throw error;
                issues.push(error.message);
            }
            return { version, selectable: issues.length === 0, issues };
        }),
    };
}

export async function getOfficialPriceStructureReferences(modelId: string, manufacturer?: string, capability?: string) {
    const models = (await getFreshAuthSettings()).logicalModels;
    const target = modelId ? models.find((item) => item.id === modelId) : undefined;
    if (modelId && (!target || !target.manufacturer)) throw new PricingInputError("请选择已配置厂商的逻辑模型");
    const selectedManufacturer = target?.manufacturer || manufacturer;
    const selectedCapability = target?.capability || capability;
    if (!selectedManufacturer || !["text", "image", "video", "audio"].includes(selectedCapability || "")) throw new PricingInputError("请选择官方厂商和模型能力");
    const sourceIds = models.filter((item) => item.id !== modelId && item.manufacturer === selectedManufacturer && item.capability === selectedCapability).map((item) => item.id);
    const versions = await getLatestOfficialVersionsForModels(sourceIds);
    return [...versions.values()]
        .filter((item) => item.manufacturer === selectedManufacturer && item.items.length > 0)
        .sort((a, b) => Number(b.series === target?.series) - Number(a.series === target?.series) || b.publishedAt.localeCompare(a.publishedAt));
}

export async function getOfficialPriceReviewLinks(manufacturer: string) {
    if (!manufacturer || manufacturer.length > 80) throw new PricingInputError("请选择模型厂商");
    return listOfficialPriceReviewLinks(manufacturer);
}

function previewToken(policy: SalesPolicy, currentId: string | null) {
    return createHash("sha256").update(JSON.stringify({ policy, currentId })).digest("hex");
}

export async function getModelPricingOverview(
    modelId?: string,
    candidatePage = 1,
    officialPage = 1,
    candidateFilter: PriceCandidateFilter = {},
    unpricedPage = 1,
    unpricedFilter: UnpricedModelFilter = {},
    workbenchPage = 1,
    workbenchFilter: ModelWorkbenchFilter = {},
) {
    if (!Number.isSafeInteger(candidatePage) || candidatePage < 1 || !Number.isSafeInteger(officialPage) || officialPage < 1 || !Number.isSafeInteger(unpricedPage) || unpricedPage < 1 || !Number.isSafeInteger(workbenchPage) || workbenchPage < 1)
        throw new PricingInputError("页码无效");
    if (unpricedFilter.status && !["no-candidate", "pending-review", "sales-unpublished"].includes(unpricedFilter.status)) throw new PricingInputError("未录价状态无效");
    if (workbenchFilter.enabled && !["active", "disabled", "all"].includes(workbenchFilter.enabled)) throw new PricingInputError("模型状态筛选无效");
    if (workbenchFilter.status && !["no-candidate", "pending-review", "sales-unpublished", "published", "channel-pending"].includes(workbenchFilter.status)) throw new PricingInputError("工作状态筛选无效");
    const settings = await getFreshAuthSettings();
    const selectedModelId = modelId || "";
    if (selectedModelId && !settings.logicalModels.some((item) => item.id === selectedModelId)) throw new PricingInputError("逻辑模型不存在");
    if (candidateFilter.modelId && !settings.logicalModels.some((item) => item.id === candidateFilter.modelId)) throw new PricingInputError("筛选的逻辑模型不存在");
    if (candidateFilter.status && !["pending", "approved", "rejected"].includes(candidateFilter.status)) throw new PricingInputError("价目状态无效");
    const state = await listPricingPage(selectedModelId, candidatePage, officialPage, candidateFilter);
    const approvedPage = await listApprovedPriceVersionsPage(officialPage, candidateFilter);
    const sales = state.salesVersions[0];
    const selectedVersions = sales?.selectedPriceBindings || [];
    const boundVersions = await getOfficialVersionsByIds([...new Set([...Object.values(sales?.priceVersionIds || {}), ...selectedVersions.map((item) => item.officialVersionId)])]);
    const filteredModels = settings.logicalModels.filter(
        (model) =>
            model.enabled !== false &&
            (!unpricedFilter.manufacturer || (model.manufacturer || "") === unpricedFilter.manufacturer) &&
            (!unpricedFilter.series || (model.series || "") === unpricedFilter.series) &&
            (!unpricedFilter.capability || model.capability === unpricedFilter.capability) &&
            (!unpricedFilter.name || `${model.name} ${model.id}`.toLocaleLowerCase().includes(unpricedFilter.name.trim().toLocaleLowerCase())),
    );
    const publishedModelIds = new Set([...Object.keys(sales?.priceVersionIds || {}), ...selectedVersions.map((item) => item.logicalModelId)]);
    const publishedScopesByModel = new Map<string, Set<string>>();
    for (const selection of selectedVersions) publishedScopesByModel.set(selection.logicalModelId, (publishedScopesByModel.get(selection.logicalModelId) || new Set()).add(selection.scope));
    const channelNames = new Map((settings.systemChannels || []).map((channel) => [channel.id, channel.name]));
    const workbenchTerm = workbenchFilter.name?.trim().toLocaleLowerCase();
    const workbenchCandidates = settings.logicalModels.filter(
        (model) =>
            (workbenchFilter.enabled === "all" || (workbenchFilter.enabled === "disabled" ? model.enabled === false : model.enabled !== false)) &&
            (!workbenchFilter.manufacturer || model.manufacturer === workbenchFilter.manufacturer) &&
            (!workbenchFilter.capability || model.capability === workbenchFilter.capability) &&
            (!workbenchTerm ||
                `${model.name} ${model.id}`.toLocaleLowerCase().includes(workbenchTerm) ||
                model.bindings.some((binding) => `${binding.upstreamModel} ${binding.channelId} ${channelNames.get(binding.channelId) || ""}`.toLocaleLowerCase().includes(workbenchTerm))),
    );
    const activeModels = settings.logicalModels.filter((model) => model.enabled !== false);
    const coverage = await getModelPricingCoverage([...new Set([...activeModels, ...workbenchCandidates].map((model) => model.id))]);
    const batchStates = await getModelPricingBatchStates([...new Set([...activeModels, ...workbenchCandidates].map((model) => model.id))], settings, state.salesVersions[0]);
    const workbenchTodo = {
        pendingOfficialModels: activeModels.filter((model) => coverage.get(model.id)?.pending).length,
        unpublishedSalesModels: activeModels.filter((model) => coverage.get(model.id)?.approved && !publishedModelIds.has(model.id)).length,
        pendingBindings: activeModels.reduce((sum, model) => sum + (batchStates.get(model.id)?.pendingBindings || 0), 0),
        reviewNeededBindings: activeModels.reduce((sum, model) => sum + (batchStates.get(model.id)?.pendingBindings === null ? model.bindings.filter((binding) => binding.enabled).length : 0), 0),
    };
    const workbenchRows = workbenchCandidates
        .map((model) => {
            const price = coverage.get(model.id);
            const admission = batchStates.get(model.id);
            const publishedPrice = publishedModelIds.has(model.id);
            const status = publishedPrice ? "published" : price?.approved ? "sales-unpublished" : price?.pending ? "pending-review" : "no-candidate";
            return {
                id: model.id,
                name: model.name,
                manufacturer: model.manufacturer || "",
                series: model.series || "",
                capability: model.capability,
                enabled: model.enabled !== false,
                status,
                approvedPrice: Boolean(price?.approved || publishedPrice),
                publishedPrice,
                publishedScopes: [...(publishedScopesByModel.get(model.id) || [])],
                bindingCount: model.bindings.filter((binding) => binding.enabled).length,
                billingMode: admission?.billingMode || "review-needed",
                billingBindingSlots: admission?.billingBindingSlots || model.bindings.filter((binding) => binding.enabled).length,
                qualifiedBindings: admission?.qualifiedBindings || 0,
                activeBindings: admission?.activeBindings || 0,
                pendingBindings: admission?.pendingBindings ?? null,
                blocker: admission?.blocker || null,
            };
        })
        .filter((model) => !workbenchFilter.status || (workbenchFilter.status === "channel-pending" ? (model.pendingBindings || 0) > 0 || model.billingMode === "review-needed" : model.status === workbenchFilter.status))
        .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.name.localeCompare(b.name));
    const unpricedModels: UnpricedModel[] = filteredModels
        .filter((model) => !publishedModelIds.has(model.id))
        .map((model) => ({
            id: model.id,
            name: model.name,
            capability: model.capability,
            manufacturer: model.manufacturer,
            series: model.series,
            status: coverage.get(model.id)?.approved ? "sales-unpublished" : coverage.get(model.id)?.pending ? "pending-review" : "no-candidate",
        }));
    const filteredUnpriced = unpricedFilter.status ? unpricedModels.filter((model) => model.status === unpricedFilter.status) : unpricedModels;
    return {
        ...state,
        approvedVersions: approvedPage.items,
        approvedTotal: approvedPage.total,
        exchangeRate: await getBusinessExchangeRate(),
        officialSources: await listOfficialPriceSources(),
        lifecycleMarks: await listPriceLifecycleMarks(settings.logicalModels.map((model) => model.id)),
        boundVersions,
        unpricedModels: filteredUnpriced.slice((unpricedPage - 1) * PRICING_PAGE_SIZE, unpricedPage * PRICING_PAGE_SIZE),
        unpricedTotal: filteredUnpriced.length,
        unpricedPage,
        workbenchModels: workbenchRows.slice((workbenchPage - 1) * PRICING_PAGE_SIZE, workbenchPage * PRICING_PAGE_SIZE),
        workbenchTodo,
        workbenchTotal: workbenchRows.length,
        workbenchPage,
        workbenchManufacturers: [...new Set(settings.logicalModels.map((model) => model.manufacturer).filter((value): value is string => Boolean(value)))].sort(),
        selectedModelId,
        candidatePage,
        officialPage,
        pageSize: PRICING_PAGE_SIZE,
        currentSalesVersionId: state.salesVersions[0]?.id || null,
        models: settings.logicalModels.map(({ id, name, capability, manufacturer, series, enabled }) => ({ id, name, capability, manufacturer, series, enabled: enabled !== false })),
        plans: settings.entitlements.plans.map(({ id, name }) => ({ id, name })),
    };
}

export async function updateOfficialPriceSource(manufacturer: string, rawUrl: string, expectedUpdatedAt: string | null, actorId: string, create = false) {
    const name = manufacturer.trim();
    const url = rawUrl.trim();
    if (!name || !url || name.length > 80) throw new PricingInputError("请填写不超过 80 字的厂商名称和官网价格链接");
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new PricingInputError("官网价格链接无效");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new PricingInputError("官网价格链接必须是无账号信息的 HTTPS 地址");
    const sources = await listOfficialPriceSources();
    const duplicate = sources.find((item) => item.manufacturer.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate && create) throw new PricingConflictError("厂商官网链接已存在，请刷新后修改");
    if (duplicate && duplicate.manufacturer !== name) throw new PricingInputError(`厂商已存在，请使用 ${duplicate.manufacturer}`);
    if (["bytedance", "volcengine", "字节跳动", "火山方舟"].includes(name.toLocaleLowerCase())) throw new PricingInputError("请使用已有厂商 ByteDance / Volcengine，避免重复建档");
    if (duplicate && expectedUpdatedAt !== duplicate.updatedAt) throw new PricingConflictError("官网链接已变化，请刷新后重试");
    if (!duplicate && expectedUpdatedAt) throw new PricingConflictError("官网链接已变化，请刷新后重试");
    return saveOfficialPriceSource(name, parsed.toString(), actorId, expectedUpdatedAt);
}

export async function updateBusinessExchangeRate(raw: unknown, expectedObservedAt: string | null) {
    return saveBusinessExchangeRate(validateBusinessExchangeRate(raw), expectedObservedAt);
}

export async function createOfficialPriceCandidate(raw: unknown, actorId: string) {
    const draft = validateOfficialPriceInput(raw);
    assertUsdOfficialPriceInput(draft);
    if (!(await listOfficialPriceSources()).some((source) => source.manufacturer === draft.manufacturer)) throw new PricingInputError("请先登记官方厂商的价目来源");
    const settings = await getFreshAuthSettings();
    const model = draft.logicalModelId ? settings.logicalModels.find((item) => item.id === draft.logicalModelId) : undefined;
    if (draft.logicalModelId && !model) throw new PricingInputError("逻辑模型不存在，请先同步并确认模型");
    const capability = model?.capability || draft.capability;
    if (model && draft.capability && model.capability !== draft.capability) throw new PricingInputError("价目能力与逻辑模型能力不一致");
    const input = await resolveOfficialPriceCatalogLink({ ...draft, capability: capability as OfficialPriceVersion["capability"] }, capability);
    if (model?.manufacturer && model.manufacturer !== input.manufacturer) throw new PricingInputError("官方厂商与逻辑模型厂商不一致");
    if (input.manufacturer === "OpenAI" && capability === "image" && input.processingTier && !["standard", "batch"].includes(input.processingTier)) throw new PricingInputError("OpenAI 图片价目仅支持官网列出的 Standard 或 Batch 档位");
    if (model && (!hasMatchingOfficialVariant(input.sku, model.id) || (input.manufacturer === "ByteDance / Volcengine" && !hasMatchingByteDanceSku(input.sku, model.id))))
        throw new PricingInputError("官方型号与逻辑模型的版本或 Fast、Mini、Lite、Pro 档位不一致");
    const candidate = { ...input, id: randomUUID(), status: "pending" as const, createdAt: new Date().toISOString(), createdBy: actorId, revision: randomUUID() };
    await insertPriceCandidate(candidate);
    return candidate;
}

export async function editOfficialPriceCandidate(id: string, raw: unknown, expectedRevision: string | null, actorId: string) {
    const draft = validateOfficialPriceInput(raw);
    assertUsdOfficialPriceInput(draft);
    if (!(await listOfficialPriceSources()).some((source) => source.manufacturer === draft.manufacturer)) throw new PricingInputError("请先登记官方厂商的价目来源");
    const settings = await getFreshAuthSettings();
    const model = draft.logicalModelId ? settings.logicalModels.find((item) => item.id === draft.logicalModelId) : undefined;
    if (draft.logicalModelId && !model) throw new PricingInputError("逻辑模型不存在，请先同步并确认模型");
    const capability = model?.capability || draft.capability;
    if (model && draft.capability && model.capability !== draft.capability) throw new PricingInputError("价目能力与逻辑模型能力不一致");
    const input = await resolveOfficialPriceCatalogLink({ ...draft, capability: capability as OfficialPriceVersion["capability"] }, capability);
    if (model?.manufacturer && model.manufacturer !== input.manufacturer) throw new PricingInputError("官方厂商与逻辑模型厂商不一致");
    if (input.manufacturer === "OpenAI" && capability === "image" && input.processingTier && !["standard", "batch"].includes(input.processingTier)) throw new PricingInputError("OpenAI 图片价目仅支持官网列出的 Standard 或 Batch 档位");
    if (model && (!hasMatchingOfficialVariant(input.sku, model.id) || (input.manufacturer === "ByteDance / Volcengine" && !hasMatchingByteDanceSku(input.sku, model.id))))
        throw new PricingInputError("官方型号与逻辑模型的版本或 Fast、Mini、Lite、Pro 档位不一致");
    return revisePriceCandidate(id, expectedRevision, (existing) => ({
        ...existing,
        ...input,
        status: "pending",
        revision: randomUUID(),
        revisedAt: new Date().toISOString(),
        revisedBy: actorId,
        reviewedAt: undefined,
        reviewedBy: undefined,
        reviewNote: undefined,
        approvedVersionId: undefined,
    }));
}

export async function removeOfficialPriceCandidate(id: string, expectedRevision: string | null) {
    await deletePriceCandidate(id, expectedRevision);
    return { candidateId: id, deleted: true };
}

export async function reviewOfficialPriceCandidate(id: string, approved: boolean, note: string, actorId: string) {
    return updatePriceCandidate(id, (candidate) => {
        if (approved && isMainlandByteDancePrice(candidate)) throw new PricingInputError("该候选引用火山方舟国内报价，不能作为 BytePlus 海外官方价审核；请按海外官网另录美元价目");
        const now = new Date().toISOString();
        const input = approved ? validateOfficialPriceInput(candidate) : undefined;
        if (input) assertUsdOfficialPriceInput(input);
        const version: OfficialPriceVersion | undefined = input ? { ...input, id: randomUUID(), candidateId: id, publishedAt: now, reviewedBy: actorId } : undefined;
        const reviewed = { ...candidate, status: approved ? ("approved" as const) : ("rejected" as const), revision: randomUUID(), reviewedAt: now, reviewedBy: actorId, reviewNote: note.trim(), ...(version ? { approvedVersionId: version.id } : {}) };
        return { candidate: reviewed, version, result: { candidateId: id, approved, versionId: version?.id || null } };
    });
}

export async function linkReviewedOfficialPrice(versionId: string, logicalModelId: string, actorId: string) {
    if (!versionId || !logicalModelId) throw new PricingInputError("请选择已审核价目和逻辑模型");
    const [source] = await getOfficialVersionsByIds([versionId]);
    if (!source || source.logicalModelId) throw new PricingInputError("只能关联尚未绑定的已审核官网价目");
    if (source.textPriceSchedule) throw new PricingInputError("文本分档价必须使用独立选价绑定，不能复制为旧式平价");
    const model = (await getFreshAuthSettings()).logicalModels.find((item) => item.id === logicalModelId);
    if (!model) throw new PricingInputError("逻辑模型不存在");
    if (model.manufacturer !== source.manufacturer || model.capability !== source.capability) throw new PricingInputError("逻辑模型的厂商或能力与官网价目不一致");
    if (!hasMatchingOfficialVariant(source.sku, model.id) || (source.manufacturer === "ByteDance / Volcengine" && !hasMatchingByteDanceSku(source.sku, model.id))) throw new PricingInputError("官网型号与逻辑模型的版本或 Fast、Mini、Lite、Pro 档位不一致");
    return bindReviewedPriceVersion(source, logicalModelId, actorId);
}

async function salesDraftReferences(raw: unknown, extraVersionIds: string[] = []) {
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const legacy = input.priceVersionIds;
    const selections = Array.isArray(input.selectedPriceBindings) ? input.selectedPriceBindings : [];
    const ids = [
        ...(legacy && typeof legacy === "object" && !Array.isArray(legacy) ? Object.values(legacy) : []),
        ...selections.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).officialVersionId : undefined)),
        ...extraVersionIds,
    ].filter((id): id is string => typeof id === "string");
    const [versions, currentSelections] = await Promise.all([
        getOfficialVersionsByIds(ids),
        Promise.all(
            selections.map((item) =>
                item && typeof item === "object" && typeof (item as Record<string, unknown>).logicalModelId === "string" && typeof (item as Record<string, unknown>).scope === "string"
                    ? getCurrentModelPriceBinding(String((item as Record<string, unknown>).logicalModelId), String((item as Record<string, unknown>).scope))
                    : undefined,
            ),
        ),
    ]);
    return { versions, currentSelections: currentSelections.filter((item) => item !== undefined) };
}

function validateSelectedSalesModels(policy: SalesPolicy, versions: OfficialPriceVersion[], models: Awaited<ReturnType<typeof getFreshAuthSettings>>["logicalModels"]) {
    for (const ref of policy.selectedPriceBindings || []) {
        const model = models.find((item) => item.id === ref.logicalModelId);
        const price = versions.find((item) => item.id === ref.officialVersionId);
        if (!model || !price?.sku || model.manufacturer !== price.manufacturer || model.capability !== price.capability) throw new PricingInputError("逻辑模型与当前选价的厂商、能力或官方 SKU 不一致");
    }
}

export async function previewSalesPricing(raw: unknown, modelId: string, usage: Record<string, string | number>, scope?: string) {
    const [settings, previous] = await Promise.all([getFreshAuthSettings(), getCurrentSalesVersion()]);
    const { versions, currentSelections } = await salesDraftReferences(raw, Object.values(previous?.priceVersionIds || {}));
    const policy = validateSalesPolicy(
        raw,
        versions,
        settings.logicalModels.map((item) => item.id),
        currentSelections,
    );
    validateSelectedSalesModels(policy, versions, settings.logicalModels);
    const exchangeRate = await getBusinessExchangeRate();
    if (policy.conversion && (!exchangeRate || policy.conversion.cnyPerUsd !== exchangeRate.cnyPerUsd || policy.conversion.observedAt !== exchangeRate.observedAt || policy.conversion.evidence !== exchangeRate.evidence))
        throw new PricingConflictError("汇率已变化，请重新设置汇率并预览");
    const selected = policy.selectedPriceBindings?.filter((item) => item.logicalModelId === modelId && (!scope || item.scope === scope)) || [];
    if (selected.length > 1) throw new PricingInputError("该模型有多个选价范围，请指定预览范围");
    if (scope && !selected.length) throw new PricingInputError("该模型与范围没有待发布的独立选价");
    if (selected.length && policy.priceVersionIds[modelId]) throw new PricingInputError("同一模型不能同时使用旧式价目映射和独立选价");
    const original = versions.find((item) => item.id === (selected[0]?.officialVersionId || policy.priceVersionIds[modelId]));
    if (selected.length && original) {
        let pricedVersion = original;
        let selectedGroupId: string | null = null;
        if (original.textPriceSchedule) {
            const schedule = original.textPriceSchedule;
            const rawTotal = usage.inputTotalTokens;
            const total = rawTotal === undefined ? undefined : typeof rawTotal === "number" || (typeof rawTotal === "string" && /^\d+$/.test(rawTotal)) ? Number(rawTotal) : NaN;
            const selection = selectStandardTextPriceGroup(schedule.groups, schedule.declaredRange, schedule.meters, total, "standard");
            if (!selection.ok) throw new TextPriceSelectionError(selection.code, selection.issues);
            selectedGroupId = selection.group.id;
            pricedVersion = { ...original, items: officialItemsForTextPriceGroup(selection.group) };
        }
        const pricingAt = new Date().toISOString();
        const deepSeekTier = supportsDeepSeekTimePricing(original) ? deepSeekSalesTimeTier(original, policy, pricingAt, modelId) : undefined;
        const activeKeys = deepSeekTier ? new Set<string>(DEEPSEEK_TIME_PRICE_KEYS[deepSeekTier]) : undefined;
        const sampleUsage = Object.fromEntries(
            pricedVersion.items.map((item) => {
                if (activeKeys && !activeKeys.has(item.key)) return [item.key, "0"];
                const value = usage[item.key] ?? (deepSeekTier === "offPeak" ? usage[item.key.replace("OffPeak", "Peak")] : undefined);
                if (value === undefined) throw new PricingInputError(`缺少 ${item.key} 的预览用量`);
                return [item.key, value];
            }),
        );
        const quote = quoteSalesPrice({ version: pricedVersion, policy, usage: sampleUsage, modelId });
        return {
            policy,
            officialPrice: original,
            selectedBinding: selected[0],
            selectedGroupId,
            quote,
            ...(deepSeekTier ? { deepSeekTier, pricingAt } : {}),
            oldQuote: null,
            pointsDifference: null,
            currentSalesVersionId: previous?.id || null,
            previewToken: previewToken(policy, previous?.id || null),
        };
    }
    const version = original;
    if (!version) throw new PricingInputError("请选择该逻辑模型的已审核官方价目");
    const pricingAt = new Date().toISOString();
    const deepSeekTier = supportsDeepSeekTimePricing(version) ? deepSeekSalesTimeTier(version, policy, pricingAt) : undefined;
    const activeKeys: Set<string> | undefined = deepSeekTier ? new Set(DEEPSEEK_TIME_PRICE_KEYS[deepSeekTier]) : undefined;
    const sampleUsage = Object.fromEntries(
        version.items.map((item) => {
            if (activeKeys && !activeKeys.has(item.key)) return [item.key, "0"];
            if (["MiniMax-H3", "MiniMax-H3-Max"].includes(version.sku) && item.key === "inputAudioSeconds" && new Decimal(item.price).isZero()) return [item.key, "0"];
            const value = usage[item.key] ?? (deepSeekTier === "offPeak" ? usage[item.key.replace("OffPeak", "Peak")] : undefined);
            return [item.key, value === undefined || (typeof value === "string" && !value.trim()) ? "0" : value];
        }),
    );
    const quote = quoteSalesPrice({ version, policy, usage: sampleUsage });
    const oldVersion = versions.find((item) => item.id === previous?.priceVersionIds[modelId]);
    const sameItems = oldVersion && version.items.length === oldVersion.items.length && version.items.every((item) => oldVersion.items.some((oldItem) => oldItem.key === item.key));
    let oldQuote: ReturnType<typeof quoteSalesPrice> | null = null;
    if (previous && Array.isArray(previous.userPriceRules) && oldVersion && sameItems) {
        try {
            const oldTier = supportsDeepSeekTimePricing(oldVersion) ? deepSeekSalesTimeTier(oldVersion, previous, pricingAt) : undefined;
            const oldKeys: Set<string> | undefined = oldTier ? new Set(DEEPSEEK_TIME_PRICE_KEYS[oldTier]) : undefined;
            oldQuote = quoteSalesPrice({
                version: oldVersion,
                policy: previous,
                usage: Object.fromEntries(
                    oldVersion.items.map((item) => [item.key, oldKeys && !oldKeys.has(item.key) ? "0" : (usage[item.key] ?? usage[item.key.replace("OffPeak", "Peak")] ?? usage[item.key.replace("Peak", "OffPeak")] ?? sampleUsage[item.key] ?? "0")]),
                ),
            });
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
        }
    }
    const previewPolicy = raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "selectedPriceBindings") ? { ...policy, selectedPriceBindings: policy.selectedPriceBindings || [] } : policy;
    return {
        policy: previewPolicy,
        officialPrice: version,
        quote,
        ...(deepSeekTier ? { deepSeekTier, pricingAt } : {}),
        oldQuote,
        pointsDifference: oldQuote ? new Decimal(quote.points).sub(oldQuote.points).toFixed(2) : null,
        currentSalesVersionId: previous?.id || null,
        previewToken: previewToken(policy, previous?.id || null),
    };
}

export async function publishSalesPricing(raw: unknown, expectedCurrentId: string | null, token: string, actorId: string) {
    const settings = await getFreshAuthSettings();
    const current = await getCurrentSalesVersion();
    const currentId = current?.id || null;
    if (currentId !== expectedCurrentId) throw new PricingConflictError("销售版本已变化，请重新预览");
    if (current?.selectedPriceBindings?.length && !(raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "selectedPriceBindings"))) throw new PricingInputError("当前销售版本含独立选价，请显式保留或解除后再发布");
    const { versions, currentSelections } = await salesDraftReferences(raw);
    const policy = validateSalesPolicy(
        raw,
        versions,
        settings.logicalModels.map((item) => item.id),
        currentSelections,
    );
    validateSelectedSalesModels(policy, versions, settings.logicalModels);
    const exchangeRate = await getBusinessExchangeRate();
    if (policy.conversion && (!exchangeRate || policy.conversion.cnyPerUsd !== exchangeRate.cnyPerUsd || policy.conversion.observedAt !== exchangeRate.observedAt || policy.conversion.evidence !== exchangeRate.evidence))
        throw new PricingConflictError("汇率已变化，请重新设置汇率并预览");
    if (previewToken(policy, currentId) !== token) throw new PricingConflictError("销售策略与预览不一致，请重新预览");
    const version: SalesVersion = { ...policy, id: randomUUID(), publishedAt: new Date().toISOString(), publishedBy: actorId };
    return insertSalesVersion(version, currentId, true);
}

export async function unbindModelSalesPrice(modelId: string, expectedCurrentId: string | null, actorId: string, scope?: string) {
    const settings = await getFreshAuthSettings();
    if (!settings.logicalModels.some((item) => item.id === modelId)) throw new PricingInputError("逻辑模型不存在");
    const current = await getCurrentSalesVersion();
    if (!current || current.id !== expectedCurrentId) throw new PricingConflictError("销售版本已变化，请刷新后重试");
    if (scope) {
        if (!current.selectedPriceBindings?.some((item) => item.logicalModelId === modelId && item.scope === scope)) throw new PricingConflictError("该模型与范围当前没有独立售价引用");
        return insertSalesVersion(
            { ...current, id: randomUUID(), publishedAt: new Date().toISOString(), publishedBy: actorId, selectedPriceBindings: current.selectedPriceBindings.filter((item) => item.logicalModelId !== modelId || item.scope !== scope) },
            current.id,
        );
    }
    if (!current.priceVersionIds[modelId]) throw new PricingConflictError("该模型当前没有官方价绑定");
    const priceVersionIds = { ...current.priceVersionIds };
    delete priceVersionIds[modelId];
    return insertSalesVersion({ ...current, id: randomUUID(), publishedAt: new Date().toISOString(), publishedBy: actorId, priceVersionIds, deepSeekUtcWindowModels: current.deepSeekUtcWindowModels?.filter((id) => id !== modelId) }, current.id);
}

export async function capturePublishedPricingIdentity(userId: string, modelId: string | undefined, scope?: Pick<ModelPriceBinding, "capability" | "operation">) {
    const sales = await getCurrentSalesVersion();
    if (!sales) return null;
    const user = (await getPublicUsersByIds([userId]))[0];
    if (!user) throw new PricingInputError("任务用户不存在，无法冻结套餐售价身份");
    const planId = user.planId;
    const published = modelId && scope ? await resolvePublishedModelPrice(modelId, scope.capability, scope.operation, sales) : undefined;
    const price = scope ? published?.version : modelId && !sales.selectedPriceBindings?.some((item) => item.logicalModelId === modelId) ? (await getOfficialVersionsByIds([sales.priceVersionIds[modelId]].filter(Boolean)))[0] : undefined;
    const resolved = price && Array.isArray(sales.userPriceRules) ? resolveUserPriceCoefficient(price, sales, modelId) : null;
    return {
        planId,
        modelId: modelId || null,
        salesVersionId: sales.id,
        officialVersionId: price?.id || null,
        ...(published?.selection ? { priceSelection: published.selection } : {}),
        userCoefficient: resolved?.value || "1",
        userCoefficientScope: resolved?.scope || "default",
        publishedAt: sales.publishedAt,
    };
}
