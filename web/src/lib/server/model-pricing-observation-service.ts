import { createHash } from "node:crypto";

import { getFreshAuthSettings } from "@/lib/auth/store";
import { hasMatchingOfficialVariant, PricingConflictError, PricingInputError, validateOfficialPriceItems, type OfficialPriceItem, type OfficialPriceObservation } from "@/lib/model-pricing";
import { listOfficialPriceReviewLinks, listPriceReviewCandidates, listPriceReviewVersions } from "./model-pricing-store";
import {
    appendOfficialPriceObservationAmendment,
    deletePendingOfficialPriceObservation,
    getOfficialPriceObservation,
    insertOfficialPriceObservation,
    invalidateOfficialPriceObservation,
    listActiveObservationModelIds,
    listOfficialPriceObservations,
    reviewOfficialPriceObservation,
    setOfficialPriceObservationLink,
} from "./model-pricing-observation-store";

export { listOfficialPriceObservations };

function text(value: unknown, label: string) {
    if (typeof value !== "string" || !value.trim()) throw new PricingInputError(`${label}不能为空`);
    return value.trim();
}

export async function saveOfficialPriceObservation(raw: unknown, actorId: string) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("官网发现格式无效");
    const input = raw as Record<string, unknown>;
    const manufacturer = text(input.manufacturer, "厂商");
    const officialModelId = text(input.officialModelId, "官网型号");
    const sourceUrl = text(input.sourceUrl, "官网链接");
    const sourceDigest = text(input.sourceDigest, "官网正文摘要");
    const evidence = text(input.evidence, "官网证据");
    const observedAt = text(input.observedAt, "核对时间");
    if (!/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/i.test(officialModelId)) throw new PricingInputError("官网型号格式无效");
    if (!evidence.toLowerCase().includes(officialModelId.toLowerCase())) throw new PricingInputError("官网证据未包含完整型号");
    if (!/^[a-f0-9]{64}$/i.test(sourceDigest)) throw new PricingInputError("官网正文摘要无效");
    if (!Number.isFinite(Date.parse(observedAt))) throw new PricingInputError("核对时间无效");
    if (input.sourceMode !== "website" && input.sourceMode !== "admin-excerpt") throw new PricingInputError("官网来源类型无效");
    if (!(await listOfficialPriceReviewLinks(manufacturer)).some((item) => item.url === sourceUrl)) throw new PricingInputError("官网链接不属于该厂商已保存的价目来源");
    if (input.newOnly === true) {
        const settings = await getFreshAuthSettings();
        const models = settings.logicalModels.filter((model) => model.manufacturer === manufacturer);
        const modelIds = models.map((model) => model.id);
        const [versions, candidates, observations] = await Promise.all([listPriceReviewVersions(modelIds), listPriceReviewCandidates(modelIds), listActiveObservationModelIds(manufacturer, [officialModelId])]);
        const known = [
            ...models.flatMap((model) => [model.id, ...model.bindings.map((binding) => binding.upstreamModel)]),
            ...versions.flatMap((version) => [version.sku, version.officialVersion]),
            ...candidates.flatMap((candidate) => [candidate.sku, candidate.officialVersion]),
            ...observations,
        ];
        if (known.some((id) => id.replace(/^models\//i, "").toLowerCase() === officialModelId.toLowerCase())) throw new PricingConflictError("该厂商型号已存在或已归档，请刷新发现结果");
    }
    const sourceRowIds = Array.isArray(input.sourceRowIds) && input.sourceRowIds.every((item) => typeof item === "string") ? (input.sourceRowIds as string[]) : [];
    const extractionIssue = typeof input.extractionIssue === "string" ? input.extractionIssue.trim() : "";
    const optional = (key: string) => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
    const suggestedSeries = optional("suggestedSeries");
    const suggestedVersion = optional("suggestedVersion");
    const suggestedTier = optional("suggestedTier");
    const suggestedProcessingTier = optional("suggestedProcessingTier");
    const suggestedEffectiveFrom = optional("suggestedEffectiveFrom");
    const suggestedEffectiveTo = optional("suggestedEffectiveTo");
    const headerEvidence = optional("headerEvidence");
    if (suggestedSeries.length > 120 || suggestedVersion.length > 120 || headerEvidence.length > 2000) throw new PricingInputError("官网建议字段过长");
    if (suggestedTier && !["free", "paid"].includes(suggestedTier)) throw new PricingInputError("官网免费/付费档建议无效");
    if (suggestedProcessingTier && (manufacturer !== "OpenAI" || !["standard", "batch", "flex", "fast", "ultrafast"].includes(suggestedProcessingTier))) throw new PricingInputError("官网处理档位建议无效");
    if ([suggestedEffectiveFrom, suggestedEffectiveTo].some((value) => value && !Number.isFinite(Date.parse(value)))) throw new PricingInputError("官网生效日期建议无效");
    let items: OfficialPriceItem[] = [];
    let conditions = "";
    if (Array.isArray(input.items) && input.items.length) {
        conditions = typeof input.conditions === "string" ? input.conditions.trim() : "";
        items = validateOfficialPriceItems(input.items);
        if (!items.every((item) => evidence.includes(item.price))) throw new PricingInputError("官网证据未包含全部价格");
    }
    const priceVariants: OfficialPriceObservation["priceVariants"] = Array.isArray(input.priceVariants)
        ? input.priceVariants.map((raw) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("价格档位格式无效");
              const variant = raw as Record<string, unknown>;
              const variantEvidence = text(variant.evidence, "价格档位证据");
              if (!variantEvidence.toLowerCase().includes(officialModelId.toLowerCase()) || !evidence.includes(variantEvidence)) throw new PricingInputError("价格档位证据未对应官网型号与原文");
              const variantItems = validateOfficialPriceItems(variant.items);
              if (!variantItems.every((item) => variantEvidence.includes(item.price))) throw new PricingInputError("价格档位证据未包含全部价格");
              return {
                  evidence: variantEvidence,
                  conditions: typeof variant.conditions === "string" ? variant.conditions.trim() : "",
                  items: variantItems,
                  ...(typeof variant.suggestedSeries === "string" && variant.suggestedSeries ? { suggestedSeries: variant.suggestedSeries } : {}),
                  ...(typeof variant.suggestedVersion === "string" && variant.suggestedVersion ? { suggestedVersion: variant.suggestedVersion } : {}),
                  ...(variant.suggestedTier === "paid" || variant.suggestedTier === "free" ? { suggestedTier: variant.suggestedTier } : {}),
                  ...(manufacturer === "OpenAI" && ["standard", "batch", "flex", "fast", "ultrafast"].includes(String(variant.suggestedProcessingTier))
                      ? { suggestedProcessingTier: variant.suggestedProcessingTier as "standard" | "batch" | "flex" | "fast" | "ultrafast" }
                      : {}),
                  ...(typeof variant.suggestedEffectiveFrom === "string" && Number.isFinite(Date.parse(variant.suggestedEffectiveFrom)) ? { suggestedEffectiveFrom: variant.suggestedEffectiveFrom } : {}),
                  ...(typeof variant.suggestedEffectiveTo === "string" && Number.isFinite(Date.parse(variant.suggestedEffectiveTo)) ? { suggestedEffectiveTo: variant.suggestedEffectiveTo } : {}),
                  ...(typeof variant.headerEvidence === "string" && variant.headerEvidence ? { headerEvidence: variant.headerEvidence } : {}),
              };
          })
        : undefined;
    const id = createHash("sha256")
        .update(
            JSON.stringify({
                manufacturer,
                officialModelId,
                sourceUrl,
                sourceDigest,
                evidence,
                sourceRowIds,
                conditions,
                items,
                extractionIssue,
                suggestedSeries,
                suggestedVersion,
                suggestedTier,
                suggestedProcessingTier,
                suggestedEffectiveFrom,
                suggestedEffectiveTo,
                headerEvidence,
                priceVariants,
            }),
        )
        .digest("hex");
    return insertOfficialPriceObservation(
        {
            id,
            manufacturer,
            officialModelId,
            sourceUrl,
            sourceDigest,
            sourceMode: input.sourceMode,
            observedAt,
            evidence,
            sourceRowIds,
            conditions,
            items,
            ...(suggestedSeries ? { suggestedSeries } : {}),
            ...(suggestedVersion ? { suggestedVersion } : {}),
            ...(suggestedTier ? { suggestedTier: suggestedTier as "free" | "paid" } : {}),
            ...(suggestedProcessingTier ? { suggestedProcessingTier: suggestedProcessingTier as "standard" | "batch" | "flex" | "fast" | "ultrafast" } : {}),
            ...(suggestedEffectiveFrom ? { suggestedEffectiveFrom } : {}),
            ...(suggestedEffectiveTo ? { suggestedEffectiveTo } : {}),
            ...(headerEvidence ? { headerEvidence } : {}),
            ...(priceVariants?.length ? { priceVariants } : {}),
            ...(extractionIssue ? { extractionIssue } : {}),
            createdAt: new Date().toISOString(),
            createdBy: actorId,
            reviewStatus: "pending",
        },
        input.newOnly === true,
    );
}

export async function amendOfficialPriceObservationEvidence(id: string, raw: unknown, actorId: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PricingInputError("官网发现 ID 无效");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PricingInputError("官网发现修订格式无效");
    const input = raw as Record<string, unknown>;
    const observation = await getOfficialPriceObservation(id);
    if (!observation || observation.reviewStatus !== "pending") throw new PricingConflictError("仅可修订待确认的官网发现");
    const originals = observation.priceVariants?.length ? observation.priceVariants : [{ evidence: observation.evidence }];
    const variantIndex = input.variantIndex;
    if (!Number.isSafeInteger(variantIndex) || (variantIndex as number) < 0 || (variantIndex as number) >= originals.length) throw new PricingInputError("官网价格组无效");
    const expectedRevision = input.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new PricingInputError("官网发现修订版本无效");
    const reason = text(input.reason, "修订原因");
    if (!Array.isArray(input.items)) throw new PricingInputError("官网分项必须是数组");
    const items = input.items.length ? validateOfficialPriceItems(input.items) : [];
    if (!Array.isArray(input.itemEvidence) || input.itemEvidence.length !== items.length || input.itemEvidence.some((value) => typeof value !== "string" || !value.trim())) throw new PricingInputError("每个价格分项须有对应官网原文摘录");
    const source = originals[variantIndex as number].evidence;
    const itemEvidence = (input.itemEvidence as string[]).map((value) => value.trim());
    for (const [index, item] of items.entries()) {
        const excerpt = itemEvidence[index];
        const pricePattern = new RegExp(`(^|[^\\d.])${item.price.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d.])`);
        const hasPrice = item.price === "0" ? new RegExp(`\\bfree\\b|免费|\\b${item.currency}\\s*0(?:\\.0+)?\\b|\\b0(?:\\.0+)?\\s*${item.currency}\\b`, "i").test(excerpt) : pricePattern.test(excerpt);
        if (!source.includes(excerpt) || !hasPrice) throw new PricingInputError(`第 ${index + 1} 个分项的价格缺少对应官网原文；请重新采集来源`);
    }
    const conditions = typeof input.conditions === "string" ? input.conditions.trim() : "";
    return appendOfficialPriceObservationAmendment(id, { variantIndex: variantIndex as number, items, itemEvidence, conditions, reason, editedAt: new Date().toISOString(), editedBy: actorId }, expectedRevision as number);
}

export async function reviewOfficialPriceObservationEvidence(id: string, status: "confirmed" | "rejected", note: string, actorId: string, expectedRevision = 0) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PricingInputError("官网发现 ID 无效");
    if (status !== "confirmed" && status !== "rejected") throw new PricingInputError("审核结果无效");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new PricingInputError("官网发现修订版本无效");
    return reviewOfficialPriceObservation(id, status, note.trim(), actorId, expectedRevision);
}

export async function deleteOfficialPriceObservationEvidence(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PricingInputError("官网发现 ID 无效");
    return deletePendingOfficialPriceObservation(id);
}

export async function invalidateOfficialPriceObservationEvidence(id: string, reason: string, actorId: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PricingInputError("官网发现 ID 无效");
    return invalidateOfficialPriceObservation(id, reason, actorId);
}

export async function bindOfficialPriceObservation(id: string, logicalModelId: string | null, actorId: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PricingInputError("官网发现 ID 无效");
    if (logicalModelId) {
        const settings = await getFreshAuthSettings();
        const model = settings.logicalModels.find((item) => item.id === logicalModelId);
        if (!model) throw new PricingInputError("逻辑模型不存在");
        const target = await getOfficialPriceObservation(id);
        if (!target) throw new PricingInputError("官网发现不存在");
        if (model.manufacturer !== target.manufacturer) throw new PricingInputError("逻辑模型厂商与官网发现不一致");
        if (!hasMatchingOfficialVariant(target.officialModelId, model.id)) throw new PricingInputError("官网型号与逻辑模型的版本或 Fast、Mini、Lite、Pro 档位不一致");
    }
    return setOfficialPriceObservationLink(id, logicalModelId, actorId);
}
