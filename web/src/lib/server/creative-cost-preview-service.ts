import { getAuthSettings } from "@/lib/auth/store";
import { requestCreditCost } from "@/constant/credits";
import { allocateDirectCreativeModels } from "@/lib/creative-direct-model-allocation";
import { CreativeRuntimeInputError, type CreativeCostPreview, type CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { resolveConfiguredModelPointCost } from "@/lib/model-point-cost";
import { getModelPricingActivation } from "./model-pricing-activation-store";
import { resolveLogicalModelCandidates } from "./logical-model-router";

export async function previewCreativeDirectCosts(modelIds: string[], preferences?: CreativeGenerationPreferences, hasImageReferences = false): Promise<CreativeCostPreview> {
    const settings = await getAuthSettings();
    const selected = modelIds.map((id) => {
        const model = settings.logicalModels.find((item) => item.id === id && item.enabled && item.capability !== "text");
        if (!model) throw new CreativeRuntimeInputError("所选模型已不可用，请刷新后重选");
        const candidates = resolveLogicalModelCandidates(settings, model.capability, model.id);
        if (!candidates.length) throw new CreativeRuntimeInputError("所选模型当前没有可用渠道，请刷新后重选");
        return { id: model.id, name: model.name, capability: model.capability as "image" | "video" | "audio", capabilityProfile: candidates[0].capabilityProfile, candidates };
    });
    const allocations = allocateDirectCreativeModels(selected, preferences);
    const lines = await Promise.all(
        allocations.map(async ({ model, count }) => {
            const scopes = model.capability === "image" ? ["image:generations:standard"] : model.capability === "video" ? ["video:generation:standard"] : ["audio:generateContent:standard", "audio:chat/completions:standard"];
            let activated = false;
            try {
                activated = (await Promise.all([getModelPricingActivation(model.id), ...scopes.map((scope) => getModelPricingActivation(model.id, scope))])).some((item) => item?.enabled);
            } catch {
                return { modelId: model.id, modelName: model.name, capability: model.capability, count, note: "计费状态暂不可核对" };
            }
            if (activated) return { modelId: model.id, modelName: model.name, capability: model.capability, count, note: "按量计费已启用或待核对，暂无可靠费用预览" };
            const quality = model.capability === "image" ? preferences?.image?.quality : preferences?.video?.quality;
            if (model.capability === "image" && hasImageReferences) return { modelId: model.id, modelName: model.name, capability: model.capability, count, note: "参考图操作待确定，暂无可靠费用预览" };
            if ((model.capability === "image" || model.capability === "video") && (!quality || quality === "auto")) return { modelId: model.id, modelName: model.name, capability: model.capability, count, note: "智能参数待确定，暂无可靠费用预览" };
            if (model.capability === "video" && !preferences?.video?.seconds) return { modelId: model.id, modelName: model.name, capability: model.capability, count, note: "视频时长待确定，暂无可靠费用预览" };
            const pointCost = resolveConfiguredModelPointCost(settings.modelPointCosts, model.id, settings.logicalModels);
            const costs = model.candidates.map((candidate) =>
                candidate.channel.advancedConfig?.protocol === "dataeyes-flux" && model.capability === "image"
                    ? pointCost
                    : requestCreditCost({
                          apiSource: "system",
                          model: model.id,
                          modelPointCosts: { [model.id]: pointCost },
                          generationPointMultipliers: settings.generationPointMultipliers,
                          kind: model.capability,
                          quality,
                          videoQuality: quality,
                          videoSeconds: preferences?.video?.seconds,
                      }),
            );
            if (costs.some((cost) => cost !== costs[0])) return { modelId: model.id, modelName: model.name, capability: model.capability, count, note: "可用渠道计费参数不同，暂无可靠费用预览" };
            return { modelId: model.id, modelName: model.name, capability: model.capability, count, estimatedPoints: Number((costs[0] * count).toFixed(2)) };
        }),
    );
    return { totalCount: allocations.reduce((total, item) => total + item.count, 0), fixedEstimatedPoints: Number(lines.reduce((total, item) => total + (item.estimatedPoints || 0), 0).toFixed(2)), lines };
}
