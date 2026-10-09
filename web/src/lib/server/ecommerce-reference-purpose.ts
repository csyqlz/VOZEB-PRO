import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceVisualAnalysisV4Contract, EcommerceVisualReferenceV4 } from "./ecommerce-visual-analysis";
import { ECOMMERCE_REFERENCE_PURPOSES } from "@/lib/creative-runtime-contract";
export { ECOMMERCE_REFERENCE_PURPOSES } from "@/lib/creative-runtime-contract";
export type { EcommerceReferencePurpose } from "@/lib/creative-runtime-contract";
import type { EcommerceReferencePurpose } from "@/lib/creative-runtime-contract";

export const ECOMMERCE_REFERENCE_DECISION_VERSION = "ecommerce-reference-decision.v1" as const;
export const ECOMMERCE_IMAGE_QUALIFIER_PATTERN = "(?:(?:中|里面|里)?的|中|里面|里)?";
export const ECOMMERCE_PRODUCT_ATTRIBUTE_ACTION_PATTERN = "(?:修改|更改|改变|变更|更换|调整|替换|改为|改成|换为|换成|变为|变成|改|换|change\\b|adjust\\b|replace\\b|turn\\b|make\\b)";
export const ECOMMERCE_EDIT_PROHIBITION_PATTERN = "(?:不要|不得|禁止|严禁|别|不|勿|do\\s+not|don't|never)";
export const ECOMMERCE_EDIT_PROHIBITION_MODIFIER_PATTERN = "(?:(?:再|重新|去|让|使|把|将|对|进行|做任何|做|任何|同时|一起|都|均|please)\\s*)*";
export type EcommerceReferenceAlias = { assetId: string; alias: string };
export type EcommerceReferenceBinding = EcommerceReferenceAlias & {
    purposes: EcommerceReferencePurpose[];
    source: "explicit" | "inferred" | "confirmed";
};
export type EcommerceReferencePurposeSuggestion = {
    assetId: string;
    purposes: EcommerceReferencePurpose[];
    confidence: "high" | "medium" | "low";
};
export type EcommerceReferenceIssue = { code: string; assetId?: string; path?: string; message: string };
export type EcommerceReferenceDecision = {
    version: typeof ECOMMERCE_REFERENCE_DECISION_VERSION;
    state: "resolved" | "needs_confirmation";
    bindings: EcommerceReferenceBinding[];
    editTargetId: string | null;
    productAnchorId: string | null;
    currentSceneBaselineId: string | null;
    appliedCues: Array<{ assetId: string; purpose: EcommerceReferencePurpose; cueIds: string[] }>;
    issues: EcommerceReferenceIssue[];
};

export function ecommerceReferenceReviewMessage(decision: EcommerceReferenceDecision): string {
    const issueCodes = new Set(decision.issues.map((issue) => issue.code));
    if (issueCodes.has("product_identity_unreliable") || issueCodes.has("continuity_anchor_unreliable")) {
        return "已识别本次要编辑的图片，但无法可靠确认完整商品外观或保护区域。请上传完整、清晰的白底商品图。";
    }
    if (issueCodes.has("edit_target_facts_unreliable")) return "已识别本次要编辑的场景图片，但无法可靠确认场景中的保护对象或编辑区域。请补充清晰的完整场景图。";
    if (issueCodes.has("reference_cue_unreliable")) {
        const purposes = [...new Set(decision.issues.filter((issue) => issue.code === "reference_cue_unreliable").map((issue) => referencePurposeLabel(issue.path?.split(".").at(-1))))];
        return `已识别参考图用途，但无法可靠提取所要求的${purposes.join("、")}线索。请重试分析或更换清晰的参考图；确认用途不会补足视觉证据。`;
    }
    return "请确认参考图用途和本次要修改的图片。";
}

// Prefer exact clauses, then accept the natural-language forms users commonly
// type around an image mention. The loose pass still refuses unknown aliases or
// a competing target, so it removes parser brittleness without guessing images.
export function parseExplicitEcommerceReferenceBindings(userRequest: string, aliases: readonly EcommerceReferenceAlias[]): EcommerceReferenceBinding[] {
    return parseExplicitReferenceRequest(userRequest, aliases).bindings;
}

function parseExplicitReferenceRequest(userRequest: string, aliases: readonly EcommerceReferenceAlias[]) {
    const strict = parseStrictReferenceRequest(userRequest, aliases);
    return strict.recognized ? strict : parseLooseReferenceRequest(userRequest, aliases);
}

function parseStrictReferenceRequest(userRequest: string, aliases: readonly EcommerceReferenceAlias[]) {
    const byAlias = new Map(aliases.map((item) => [item.alias, item.assetId]));
    const bindings = new Map<string, EcommerceReferenceBinding>();
    const excludedTargetIds: string[] = [];
    const unresolved = { bindings: [] as EcommerceReferenceBinding[], excludedTargetIds: [] as string[], recognized: false };
    const clauses = userRequest
        .trim()
        .replace(/[。！.!]$/, "")
        .split(/[，,；;]/)
        .map((clause) => clause.trim().replace(/^请\s*/, ""));
    for (const clause of clauses) {
        const target = clause.match(/^修改\s*@?(图片[1-9]\d*)$/);
        const reference = clause.match(/^参考\s*@?(图片[1-9]\d*)(?:\s*的?\s*(.+))?$/);
        const prefixedReference = clause.match(/^@?(图片[1-9]\d*)\s+参考这张图(?:的)?[^，,；;]*风格$/);
        const prefixedTarget = clause.match(/^把\s*@?(图片[1-9]\d*)\s+这张图修改成.+$/);
        const excluded = clause.match(/^不要修改\s*@?(图片[1-9]\d*)$/);
        const protectedProduct = clause.match(/^不要改变\s*@?(图片[1-9]\d*)(?:的)?商品$/);
        const alias = target?.[1] || reference?.[1] || prefixedReference?.[1] || prefixedTarget?.[1] || excluded?.[1] || protectedProduct?.[1];
        if (!alias || !byAlias.has(alias)) return unresolved;
        if (excluded) {
            excludedTargetIds.push(byAlias.get(alias)!);
            continue;
        }
        let purposes: EcommerceReferencePurpose[] = prefixedReference ? ["style"] : protectedProduct ? ["product_identity"] : ["edit_target"];
        if (reference) {
            const facets = reference[2]?.split(/[和、与及]/).map((item) => item.trim()) || ["风格"];
            const facetPurposes: Record<string, EcommerceReferencePurpose> = { 风格: "style", 光线: "lighting", 灯光: "lighting", 构图: "composition", 商品身份: "product_identity" };
            if (facets.some((facet) => !facetPurposes[facet])) return unresolved;
            purposes = facets.map((facet) => facetPurposes[facet]);
        }
        const assetId = byAlias.get(alias)!;
        const previous = bindings.get(assetId)?.purposes || [];
        bindings.set(assetId, { assetId, alias, purposes: ECOMMERCE_REFERENCE_PURPOSES.filter((purpose) => previous.includes(purpose) || purposes.includes(purpose)), source: "explicit" });
    }
    return { bindings: aliases.flatMap(({ assetId }) => (bindings.has(assetId) ? [bindings.get(assetId)!] : [])), excludedTargetIds, recognized: true };
}

function parseLooseReferenceRequest(userRequest: string, aliases: readonly EcommerceReferenceAlias[]) {
    const byAlias = new Map(aliases.map((item) => [item.alias, item.assetId]));
    const aliasPattern = /@?图片\s*([1-9]\d*)/g;
    const mentions = [...userRequest.matchAll(aliasPattern)];
    if (!mentions.length) return { bindings: [] as EcommerceReferenceBinding[], excludedTargetIds: [] as string[], recognized: false };

    const bindings = new Map<string, EcommerceReferenceBinding>();
    const excludedTargetIds: string[] = [];
    const unknownMention = mentions.some((mention) => !byAlias.has(`图片${mention[1]}`));
    if (unknownMention) return { bindings: [] as EcommerceReferenceBinding[], excludedTargetIds: [] as string[], recognized: false };

    for (const [index, mention] of mentions.entries()) {
        const alias = `图片${mention[1]}`;
        const assetId = byAlias.get(alias)!;
        const separator = /[，,。；;！!？?\n]/;
        const prefix = userRequest.slice(0, mention.index!);
        const suffix = userRequest.slice(mention.index! + mention[0].length);
        const clauseStart = prefix.search(/[^，,。；;！!？?\n]*$/);
        const clauseEnd = suffix.search(separator);
        const previousEnd = index ? mentions[index - 1].index! + mentions[index - 1][0].length : 0;
        const nextStart = mentions[index + 1]?.index ?? userRequest.length;
        const before = userRequest.slice(Math.max(clauseStart, previousEnd), mention.index!);
        const after = userRequest.slice(mention.index! + mention[0].length, Math.min(clauseEnd < 0 ? userRequest.length : mention.index! + mention[0].length + clauseEnd, nextStart));
        const context = before + mention[0] + after;
        // A later protection clause for the already explicit target adds no new
        // reference purpose and must not erase that target's binding.
        if (bindings.get(assetId)?.purposes.includes("edit_target") && isProductAttributeProtection(before, after)) continue;
        const excluded = /(?:不要|别|禁止|不得)\s*(?:修改|改变|变更|编辑)\s*$/.test(before) && !/^\s*(?:的)?(?:商品|产品|主体|颜色|材质|结构|比例|轮廓|细节)/.test(after);
        if (excluded) {
            excludedTargetIds.push(assetId);
            const nextClause = suffix.split(separator)[1]?.trim() || "";
            if (/^(?:只|仅)?(?:参考|参照|借鉴)(?:它|这张图|该图)(?:的)?/.test(nextClause)) {
                bindings.set(assetId, { assetId, alias, purposes: referencePurposes(nextClause), source: "explicit" });
            }
            continue;
        }

        const purposes: EcommerceReferencePurpose[] = [];
        const targetCue =
            /(?:修改|生成|编辑|改成|换成|放置|置于|摆放|合成|重绘|指定|需要保留|把|将)\s*(?:这张图|该图)?\s*$/.test(before) || /^(?:这张图|该图)?\s*(?:进行)?(?:修改|生成|编辑|改成|换成|放置|置于|摆放|合成|重绘)|^为主体(?:生成|编辑)|^作为主体/.test(after);
        const referenceCue = /(?:参考|参照|借鉴|示例|样图)\s*$/.test(before) || (!targetCue && /^(?:的|为|作为|用作)?[^，,。；;\n]*(?:参考|参考图|参考样式|风格|光线|灯光|构图|氛围|样图)/.test(after));
        // Image aliases name the source; they do not authorize a visual facet.
        // A target's desired lighting/style is an edit, not a reference use.
        if (referenceCue) purposes.push(...referencePurposes(before + after));
        if (targetCue) purposes.push("edit_target");

        // A single uploaded image plus a generation/edit request is the normal
        // white-background product flow. Treat it as both target and identity;
        // an explicit style-only sentence remains style-only.
        if (mentions.length === 1 && !purposes.includes("edit_target") && !/参考.{0,12}(?:风格|光线|灯光|构图|氛围)/.test(context) && /生成|修改|编辑|放置|置于|场景/.test(userRequest)) {
            purposes.push("edit_target");
        }
        const uniquePurposes = ECOMMERCE_REFERENCE_PURPOSES.filter((purpose) => purposes.includes(purpose));
        if (!uniquePurposes.length) return { bindings: [] as EcommerceReferenceBinding[], excludedTargetIds: [] as string[], recognized: false };
        const previous = bindings.get(assetId)?.purposes || [];
        bindings.set(assetId, { assetId, alias, purposes: ECOMMERCE_REFERENCE_PURPOSES.filter((purpose) => previous.includes(purpose) || uniquePurposes.includes(purpose)), source: "explicit" });
    }

    return { bindings: aliases.flatMap(({ assetId }) => (bindings.has(assetId) ? [bindings.get(assetId)!] : [])), excludedTargetIds, recognized: true };
}

function isProductAttributeProtection(before: string, after: string): boolean {
    const property = after.match(new RegExp(`^\\s*${ECOMMERCE_IMAGE_QUALIFIER_PATTERN}\\s*(?:商品|产品|主体)\\s*(?:的)?\\s*(?:颜色|色彩|配色|材质|材料)(?:\\s*(?:和|与|及|、)\\s*(?:颜色|色彩|配色|材质|材料))*\\s*`));
    if (!property) return false;
    const tail = after.slice(property[0].length);
    const action = ECOMMERCE_PRODUCT_ATTRIBUTE_ACTION_PATTERN;
    const prohibition = `${ECOMMERCE_EDIT_PROHIBITION_PATTERN}\\s*${ECOMMERCE_EDIT_PROHIBITION_MODIFIER_PATTERN}`;
    const propertyAction = `(?:进行|做任何|做)?\\s*(?:(?:从|由)[^，,。.;；!！?？\\n]*?)?${action}`;
    return (
        new RegExp(`${prohibition}${action}\\s*(?:一下)?\\s*$`, "i").test(before) || (new RegExp(`${prohibition}$`, "i").test(before) && new RegExp(`^${propertyAction}`, "i").test(tail)) || new RegExp(`^${prohibition}${propertyAction}`, "i").test(tail)
    );
}

function referencePurposes(context: string): EcommerceReferencePurpose[] {
    const purposes: EcommerceReferencePurpose[] = [];
    if (/光线|光照|灯光|日光|阳光|照明|白平衡/.test(context)) purposes.push("lighting");
    if (/构图|机位|视角|布局|镜头|留白|纵深/.test(context)) purposes.push("composition");
    if (/商品身份|商品外观|产品身份|主体外观/.test(context)) purposes.push("product_identity");
    if (!purposes.length || /风格|材质|氛围|质感/.test(context)) purposes.push("style");
    return [...new Set(purposes)];
}

export function resolveEcommerceReferenceDecision(input: { planningInput: EcommercePlanningInput; analysis: EcommerceVisualAnalysisV4Contract; confirmedBindings?: Array<Omit<EcommerceReferenceBinding, "source">> }): EcommerceReferenceDecision {
    const { planningInput, analysis, confirmedBindings } = input;
    const issues: EcommerceReferenceIssue[] = [];
    const assets = new Map(planningInput.assetCandidates.map((asset) => [asset.id, asset]));
    const aliases = (planningInput.referenceAliases || []).filter((item) => assets.get(item.assetId)?.type === "image");
    const aliasById = new Map(aliases.map((item) => [item.assetId, item.alias]));
    const inherited = planningInput.inheritedReferences;
    if ((!aliases.length && !inherited) || aliasById.size !== aliases.length || new Set(aliases.map((item) => item.alias)).size !== aliases.length) {
        issues.push({ code: "alias_binding_invalid", path: "referenceAliases", message: "请确认本次图片引用及其别名" });
    }
    const facts = new Map(analysis.references.map((reference) => [reference.assetId, reference]));
    const explicitRequest = parseExplicitReferenceRequest(planningInput.userRequest, aliases);
    const explicit = explicitRequest.bindings;
    const unresolvedExpression = confirmedBindings === undefined && /图片\s*\d+/.test(planningInput.userRequest) && !explicitRequest.recognized;
    if (unresolvedExpression) issues.push({ code: "reference_expression_unresolved", path: "userRequest", message: "请确认本次图片别名、参考用途与唯一修改目标" });
    const chosen = new Map<string, EcommerceReferenceBinding>();
    const authoritative = confirmedBindings === undefined ? explicit : confirmedBindings.map((binding) => ({ ...binding, source: "confirmed" as const }));
    for (const binding of authoritative) {
        if (
            aliasById.get(binding.assetId) !== binding.alias ||
            chosen.has(binding.assetId) ||
            !binding.purposes.length ||
            new Set(binding.purposes).size !== binding.purposes.length ||
            binding.purposes.some((purpose) => !ECOMMERCE_REFERENCE_PURPOSES.includes(purpose))
        ) {
            issues.push({ code: "binding_invalid", assetId: binding.assetId, path: "bindings", message: "图片用途必须对应本次引用的准确图片与别名" });
            continue;
        }
        chosen.set(binding.assetId, structuredClone(binding));
    }
    const explicitTargets = [...chosen.values()].filter((binding) => binding.purposes.includes("edit_target"));
    let inferredAuxiliaries: EcommerceReferenceAlias[] = [];
    if (!explicitTargets.length && confirmedBindings === undefined && !unresolvedExpression) {
        const eligible = aliases.filter(({ assetId }) => !explicitRequest.excludedTargetIds.includes(assetId) && (!chosen.has(assetId) || chosen.get(assetId)!.purposes.includes("product_identity")));
        const products = eligible.filter(({ assetId }) => targetCandidate(facts.get(assetId)));
        const scenes = eligible.filter(({ assetId }) => facts.get(assetId)?.contentType === "interior_scene" && facts.get(assetId)?.confidence === "high");
        const inferredTarget = inherited?.editTargetId ? eligible.find(({ assetId }) => assetId === inherited.editTargetId) : products.length === 1 ? products[0] : !products.length && scenes.length === 1 ? scenes[0] : undefined;
        if (inferredTarget) {
            const previous = chosen.get(inferredTarget.assetId);
            chosen.set(inferredTarget.assetId, { ...inferredTarget, purposes: ECOMMERCE_REFERENCE_PURPOSES.filter((purpose) => purpose === "edit_target" || previous?.purposes.includes(purpose)), source: previous?.source || "inferred" });
        }
        if (inferredTarget || inherited?.editTargetId) {
            inferredAuxiliaries = eligible.filter(({ assetId }) => assetId !== inferredTarget?.assetId && assetId !== inherited?.editTargetId && assetId !== inherited?.productAnchorId && !chosen.has(assetId));
        }
    }
    for (const suggestion of analysis.purposeSuggestions) {
        if (!aliasById.has(suggestion.assetId) || chosen.has(suggestion.assetId) || confirmedBindings !== undefined) continue;
        const purposes = suggestion.purposes.filter((purpose) => purpose !== "edit_target" && purpose !== "product_identity");
        if (suggestion.confidence === "high" && purposes.length) chosen.set(suggestion.assetId, { assetId: suggestion.assetId, alias: aliasById.get(suggestion.assetId)!, purposes, source: "inferred" });
    }
    const inferredStyle = inferredAuxiliaries.filter(({ assetId }) => {
        const reference = facts.get(assetId);
        return !chosen.has(assetId) && (reference?.contentType === "interior_scene" || !reliableProduct(reference));
    });
    if (inferredStyle.length === 1) {
        const style = inferredStyle[0];
        chosen.set(style.assetId, { ...style, purposes: ["style"], source: "inferred" });
    }
    const bindings = aliases.map((alias) => chosen.get(alias.assetId) || { ...alias, purposes: [] as EcommerceReferencePurpose[], source: "inferred" as const });
    const targets = bindings.filter((binding) => binding.purposes.includes("edit_target"));
    const editTargetId = targets.length === 1 ? targets[0].assetId : !targets.length && !unresolvedExpression ? inherited?.editTargetId || null : null;
    if (!editTargetId) issues.push({ code: targets.length > 1 ? "edit_target_ambiguous" : "edit_target_required", path: "bindings", message: "请选择本次要修改的唯一图片" });
    const target = editTargetId ? facts.get(editTargetId) : undefined;
    if (editTargetId && (!target || assets.get(editTargetId)?.type !== "image")) issues.push({ code: "continuity_target_missing", assetId: editTargetId, path: "references", message: "连续编辑目标的视觉事实不可用" });
    if (target && targets[0] && editTargetId !== inherited?.editTargetId && ["isolated_product", "product_detail"].includes(target.contentType) && !targets[0].purposes.includes("product_identity")) targets[0].purposes.push("product_identity");
    for (const binding of bindings) {
        const reference = facts.get(binding.assetId);
        if (!reference) issues.push({ code: "reference_analysis_missing", assetId: binding.assetId, path: "references", message: "这张图片尚无有效视觉事实" });
        if (!binding.purposes.length) issues.push({ code: "reference_purpose_required", assetId: binding.assetId, path: "bindings", message: "请确认这张图片在本次修改中的用途" });
        if (binding.purposes.includes("product_identity") && !reliableProduct(reference)) issues.push({ code: "product_identity_unreliable", assetId: binding.assetId, path: "productFacts", message: "无法可靠确认这张图片的完整商品身份与保护区域" });
    }
    if (target && !reliableProduct(target) && !(target.contentType === "interior_scene" && target.confidence === "high" && (target.sceneFacts || target.productCore || target.visibleStructure.length))) {
        issues.push({ code: "edit_target_facts_unreliable", assetId: target.assetId, path: "references", message: "修改目标的可见事实不足，请确认或提供清晰图片" });
    }
    const identities = bindings.filter((binding) => binding.purposes.includes("product_identity"));
    if (identities.length > 1) issues.push({ code: "product_identity_ambiguous", path: "bindings", message: "请选择唯一商品身份来源" });
    const inheritedAnchor = editTargetId === inherited?.editTargetId ? inherited.productAnchorId : null;
    if (!identities.length && inheritedAnchor && (!reliableProduct(facts.get(inheritedAnchor)) || assets.get(inheritedAnchor)?.type !== "image"))
        issues.push({ code: "continuity_anchor_unreliable", assetId: inheritedAnchor, path: "productFacts", message: "连续编辑原始商品锚点不可可靠确认" });
    const productAnchorId = identities.length === 1 && reliableProduct(facts.get(identities[0].assetId)) ? identities[0].assetId : !identities.length && inheritedAnchor && reliableProduct(facts.get(inheritedAnchor)) ? inheritedAnchor : null;
    const appliedCues: EcommerceReferenceDecision["appliedCues"] = [];
    for (const binding of bindings) {
        for (const purpose of binding.purposes.filter((purpose) => ["style", "lighting", "composition"].includes(purpose))) {
            const cueIds = (facts.get(binding.assetId)?.cues || []).filter((cue) => cue.confidence === "high" && (cue.facet === purpose || (purpose === "style" && cue.facet === "material_appearance"))).map((cue) => cue.id);
            if (cueIds.length) appliedCues.push({ assetId: binding.assetId, purpose, cueIds });
        }
    }
    issues.push(...ecommerceReferenceCueIssues({ bindings, appliedCues }, analysis));
    return {
        version: ECOMMERCE_REFERENCE_DECISION_VERSION,
        state: issues.length ? "needs_confirmation" : "resolved",
        bindings,
        editTargetId,
        productAnchorId,
        currentSceneBaselineId: target?.contentType === "interior_scene" ? target.assetId : null,
        appliedCues,
        issues,
    };
}

export function ecommerceReferenceCueIssues(decision: Pick<EcommerceReferenceDecision, "bindings" | "appliedCues">, analysis: EcommerceVisualAnalysisV4Contract): EcommerceReferenceIssue[] {
    const issues: EcommerceReferenceIssue[] = [];
    for (const binding of decision.bindings) {
        const cues = analysis.references.find((reference) => reference.assetId === binding.assetId)?.cues || [];
        for (const purpose of binding.purposes.filter((purpose) => ["style", "lighting", "composition"].includes(purpose))) {
            const applied = decision.appliedCues.filter((cue) => cue.assetId === binding.assetId && cue.purpose === purpose).flatMap((cue) => cue.cueIds);
            if (!applied.length || applied.some((id) => !cues.some((cue) => cue.id === id && cue.confidence === "high" && (cue.facet === purpose || (purpose === "style" && cue.facet === "material_appearance")))))
                issues.push({ code: "reference_cue_unreliable", assetId: binding.assetId, path: `cues.${purpose}`, message: `${binding.alias}缺少可靠的${referencePurposeLabel(purpose)}线索，请重试分析或更换清晰参考图` });
        }
    }
    return issues;
}

function referencePurposeLabel(purpose: string | undefined): string {
    return purpose === "lighting" ? "光线" : purpose === "composition" ? "构图" : "风格";
}

export function inheritEcommerceContinuityDecision(input: { analysis: EcommerceVisualAnalysisV4Contract; targetAssetId: string; productAnchorId: string | null }): EcommerceReferenceDecision {
    const target = input.analysis.references.find((reference) => reference.assetId === input.targetAssetId);
    const productAnchor = input.productAnchorId ? input.analysis.references.find((reference) => reference.assetId === input.productAnchorId) : undefined;
    const issues: EcommerceReferenceIssue[] = [];
    if (!target) issues.push({ code: "continuity_target_missing", assetId: input.targetAssetId, path: "references", message: "连续编辑目标的视觉事实不可用" });
    if (input.productAnchorId && !reliableProduct(productAnchor)) issues.push({ code: "continuity_anchor_unreliable", assetId: input.productAnchorId, path: "productFacts", message: "连续编辑原始商品锚点不可可靠确认" });
    return {
        version: ECOMMERCE_REFERENCE_DECISION_VERSION,
        state: issues.length ? "needs_confirmation" : "resolved",
        bindings: [],
        editTargetId: input.targetAssetId,
        productAnchorId: input.productAnchorId,
        currentSceneBaselineId: target?.contentType === "interior_scene" ? target.assetId : null,
        appliedCues: [],
        issues,
    };
}

export function referenceUsesFromEcommerceDecision(input: { decision: EcommerceReferenceDecision; sourceOrder: string[] }): Array<{ assetId: string; alias: string | null; purposes: EcommerceReferencePurpose[]; usedCueIds: string[] }> {
    const byId = new Map(input.decision.bindings.map((binding) => [binding.assetId, binding]));
    const cueIdsByAsset = new Map<string, string[]>();
    for (const cue of input.decision.appliedCues) {
        const previous = cueIdsByAsset.get(cue.assetId) || [];
        cueIdsByAsset.set(cue.assetId, [...new Set([...previous, ...cue.cueIds])]);
    }
    return input.sourceOrder.map((assetId) => {
        const binding = byId.get(assetId);
        const fallbackPurposes = assetId === input.decision.editTargetId ? ["edit_target" as const] : [];
        const identity = assetId === input.decision.productAnchorId ? (["product_identity"] as const) : [];
        return {
            assetId,
            alias: binding?.alias || null,
            purposes: [...new Set([...(binding?.purposes || []), ...fallbackPurposes, ...identity])],
            usedCueIds: [...(cueIdsByAsset.get(assetId) || [])],
        };
    });
}

function reliableProduct(reference: EcommerceVisualReferenceV4 | undefined): boolean {
    if (!reference || !["isolated_product", "product_detail"].includes(reference.contentType) || !reference.productFacts || !reference.productCore || !reference.fusionHalo) return false;
    if (reference.confidence === "high") return true;
    // A close-up/detail image may be medium confidence while still being a
    // safe white-background anchor; pixel segmentation remains the final gate.
    return reference.confidence === "medium" && reference.visualEvidence.isolatedSubject && (reference.visualEvidence.whiteBackground || reference.visualEvidence.transparentBackground);
}

export function allowedEcommerceReferencePurposes(reference: EcommerceVisualReferenceV4 | undefined): EcommerceReferencePurpose[] {
    if (!reference) return [];
    const product = reliableProduct(reference);
    const target = product || (reference.contentType === "interior_scene" && reference.confidence === "high" && Boolean(reference.sceneFacts || reference.productCore || reference.visibleStructure.length));
    return ECOMMERCE_REFERENCE_PURPOSES.filter((purpose) => {
        if (purpose === "edit_target") return target;
        if (purpose === "product_identity") return product;
        return reference.cues.some((cue) => cue.confidence === "high" && (cue.facet === purpose || (purpose === "style" && cue.facet === "material_appearance")));
    });
}

function targetCandidate(reference: EcommerceVisualReferenceV4 | undefined): boolean {
    if (!reference) return false;
    if (reliableProduct(reference)) return true;
    if (!(["isolated_product", "product_detail"].includes(reference.contentType) && reference.visualEvidence.isolatedSubject && (reference.visualEvidence.whiteBackground || reference.visualEvidence.transparentBackground))) return false;
    return Boolean(reference.productCore && reference.fusionHalo);
}
