import { getFreshAuthSettings } from "@/lib/auth/store";
import { PricingInputError } from "@/lib/model-pricing";
import { getCurrentSalesVersion } from "./model-pricing-store";
import { resolvePublishedModelPrice } from "./model-pricing-published-price";
import { listTextUsageRules, reviewTextUsageRule } from "./model-pricing-text-usage-rule-store";

export async function getTextUsageRuleOptions(modelId: string) {
    const settings = await getFreshAuthSettings();
    const model = settings.logicalModels.find((item) => item.id === modelId && item.capability === "text");
    const policy = await getCurrentSalesVersion();
    const version = model ? (await resolvePublishedModelPrice(modelId, "text", "generation", policy, settings))?.version : undefined;
    if (!version || version.tier !== "paid" || !version.reviewedBy) throw new PricingInputError("当前文本模型缺少已发布且已审核的官方价目");
    return { officialVersionId: version.id, rules: await listTextUsageRules(modelId, version.id) };
}

export async function reviewModelTextUsageRule(input: { modelId: string; officialVersionId: string; cacheReadMissingAsZero: boolean; cacheWriteMissingAsZero: boolean; evidence: string; expectedCurrentId: string | null; actorId: string }) {
    const options = await getTextUsageRuleOptions(input.modelId);
    if (options.officialVersionId !== input.officialVersionId) throw new PricingInputError("官方价版本已变化，请刷新后重新核对");
    return reviewTextUsageRule(input);
}
