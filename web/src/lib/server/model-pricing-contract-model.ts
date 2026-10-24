import type { AuthSettings } from "@/lib/auth/store";
import { modelPriceBindingScope, PricingInputError, type ModelPriceBinding, type OfficialPriceVersion } from "@/lib/model-pricing";
import { getCurrentModelPriceBinding } from "./model-price-binding-store";

/** An ownerless official version needs an explicit, current model/scope selection before channel review. */
export async function resolvePricingContractModel(settings: AuthSettings, version: OfficialPriceVersion, logicalModelId: string | undefined, operations: ModelPriceBinding["operation"][]) {
    const modelId = version.logicalModelId || logicalModelId;
    if (!modelId || (version.logicalModelId && logicalModelId && logicalModelId !== version.logicalModelId)) throw new PricingInputError("请选择与官网价版本匹配的逻辑模型");
    const model = settings.logicalModels.find((item) => item.id === modelId);
    if (!model) throw new PricingInputError("逻辑模型不存在");
    if (version.logicalModelId) return { model, operations };
    if (model.manufacturer !== version.manufacturer || model.capability !== version.capability || version.tier !== "paid" || (version.processingTier || "standard") !== "standard")
        throw new PricingInputError("独立官网价与逻辑模型的厂商、能力或 Standard 付费档不匹配");
    const selected = await Promise.all(
        operations.map(async (operation) => {
            const binding = await getCurrentModelPriceBinding(model.id, modelPriceBindingScope(version.capability!, operation, "standard"));
            return binding?.current && binding.status === "active" && binding.officialVersionId === version.id ? operation : null;
        }),
    );
    const selectedOperations = selected.filter((operation): operation is ModelPriceBinding["operation"] => operation !== null);
    if (!selectedOperations.length) throw new PricingInputError("该逻辑模型与操作没有当前有效的独立选价绑定");
    return { model, operations: selectedOperations };
}
