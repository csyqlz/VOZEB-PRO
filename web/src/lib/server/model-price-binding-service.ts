import { getFreshAuthSettings } from "@/lib/auth/store";
import { assertUsdOfficialPriceInput, modelPriceBindingScope, officialItemsForTextPriceGroup, PricingInputError, quoteSalesPrice, selectStandardTextPriceGroup, TextPriceSelectionError, type ModelPriceBinding } from "@/lib/model-pricing";

import { getCurrentModelPriceBinding, listModelPriceBindingHistory, saveModelPriceBinding } from "./model-price-binding-store";
import { getCurrentSalesVersion, getOfficialVersionsByIds } from "./model-pricing-store";

export { getCurrentModelPriceBinding, listModelPriceBindingHistory };

export async function getCurrentModelPriceSelection(logicalModelId: string, scope: string) {
    const binding = await getCurrentModelPriceBinding(logicalModelId, scope);
    const version = binding?.officialVersionId ? (await getOfficialVersionsByIds([binding.officialVersionId]))[0] : undefined;
    return binding ? { ...binding, version: version || null } : null;
}

export async function previewSelectedOfficialPrice(logicalModelId: string, scope: string, usage: Record<string, string | number>, facts?: { inputTotalTokens?: number }) {
    if (!logicalModelId || !scope) throw new PricingInputError("请选择逻辑模型与选价范围");
    const binding = await getCurrentModelPriceBinding(logicalModelId, scope);
    if (!binding || binding.status !== "active" || !binding.officialVersionId) throw new PricingInputError("该范围没有当前有效选价");
    const [version, sales] = await Promise.all([getOfficialVersionsByIds([binding.officialVersionId]), getCurrentSalesVersion()]);
    const price = version[0];
    if (!price || price.logicalModelId || price.capability !== binding.capability || (price.processingTier || "standard") !== binding.processingMode || modelPriceBindingScope(binding.capability, binding.operation, binding.processingMode) !== scope)
        throw new PricingInputError("选价版本与当前范围不一致");
    let selectedGroupId: string | null = null;
    let pricedVersion = price;
    if (price.textPriceSchedule) {
        const schedule = price.textPriceSchedule;
        const selection = selectStandardTextPriceGroup(schedule.groups, schedule.declaredRange, schedule.meters, facts?.inputTotalTokens, binding.processingMode);
        if (!selection.ok) throw new TextPriceSelectionError(selection.code, selection.issues);
        selectedGroupId = selection.group.id;
        pricedVersion = { ...price, items: officialItemsForTextPriceGroup(selection.group) };
    }
    if (!pricedVersion.items.length) throw new PricingInputError("该选价尚无可执行价格分项");
    assertUsdOfficialPriceInput(price);
    if (!sales) throw new PricingInputError("请先发布用户售价规则");
    return { bindingId: binding.id, bindingRevision: binding.revision, salesVersionId: sales.id, selectedGroupId, previewOnly: true, quote: quoteSalesPrice({ version: pricedVersion, policy: sales, usage, modelId: logicalModelId }) };
}

export async function bindSelectedOfficialPrice(versionId: string, logicalModelId: string, operation: string, evidence: string, expectedRevision: string | null, actorId: string): Promise<ModelPriceBinding> {
    if (!versionId || !logicalModelId || !evidence.trim()) throw new PricingInputError("请选择官网价、逻辑模型并填写选价依据");
    const [version] = await getOfficialVersionsByIds([versionId]);
    if (!version || version.logicalModelId) throw new PricingInputError("请选择独立审核的官网价版本");
    assertUsdOfficialPriceInput(version);
    const model = (await getFreshAuthSettings()).logicalModels.find((item) => item.id === logicalModelId);
    if (!model) throw new PricingInputError("逻辑模型不存在");
    if (model.manufacturer !== version.manufacturer || model.capability !== version.capability) throw new PricingInputError("逻辑模型的厂商或能力与官网价目不一致");
    const capability = version.capability!;
    const processingMode = version.processingTier || "standard";
    const scope = modelPriceBindingScope(capability, operation, processingMode);
    return saveModelPriceBinding(
        { logicalModelId, capability, operation: operation as ModelPriceBinding["operation"], processingMode, scope, officialVersionId: version.id, status: "active", evidence: evidence.trim(), reviewedBy: actorId },
        expectedRevision,
    );
}

export async function revokeSelectedOfficialPrice(logicalModelId: string, scope: string, evidence: string, expectedRevision: string | null, actorId: string): Promise<ModelPriceBinding> {
    if (!logicalModelId || !scope || !evidence.trim()) throw new PricingInputError("请选择选价范围并填写解除依据");
    const current = await getCurrentModelPriceBinding(logicalModelId, scope);
    if (!current || current.status !== "active") throw new PricingInputError("该范围没有当前有效选价");
    return saveModelPriceBinding(
        { logicalModelId, capability: current.capability, operation: current.operation, processingMode: current.processingMode, scope, officialVersionId: null, status: "revoked", evidence: evidence.trim(), reviewedBy: actorId },
        expectedRevision,
    );
}
