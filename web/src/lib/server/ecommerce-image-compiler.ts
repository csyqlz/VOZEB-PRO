import { ecommerceCanvasSize, type EcommerceCanvasConstraint, type EcommerceEditPlan, type EcommerceEditProtection, type EcommercePhotographyPlan, type EcommerceReferenceUse } from "./ecommerce-edit-plan";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";

export type EcommerceImageProviderProfile = {
    profileId: "gpt-image-2.5-flare" | "gpt-image-2.5-sunburst" | "nano-banana-2";
    compilerFamily: "openai-image-2.5" | "nano-banana-2";
    supportsIndependentMask: boolean;
    modelSnapshot: EcommerceRoleRouteSnapshot;
};

export type EcommerceCompiledImageRequest = {
    state: "ready" | "needs_review";
    compilerVersion:
        | "ecommerce-openai-image-2.5.v1"
        | "ecommerce-nano-banana-2.v1"
        | "ecommerce-openai-image-2.5.v2"
        | "ecommerce-nano-banana-2.v2"
        | "ecommerce-openai-image-2.5.v3"
        | "ecommerce-nano-banana-2.v3"
        | "ecommerce-openai-image-2.5.v4"
        | "ecommerce-nano-banana-2.v4";
    providerProfileId: EcommerceImageProviderProfile["profileId"];
    prompt: string;
    referenceRoles: Array<{ assetId: string; role: "product" | "scene" }>;
    referenceMapping?: Array<{ assetId: string; userAlias: string | null; providerIndex: number; purposes: EcommerceReferenceUse["purposes"] }>;
    canvas?: EcommerceCanvasConstraint;
    protection?: EcommerceEditProtection;
    photography?: EcommercePhotographyPlan;
    mask?: { mode: "independent"; required: true };
    reason?: "independent_mask_unsupported";
    parameters: { variant: EcommerceImageProviderProfile["profileId"]; size?: string };
    modelSnapshot: EcommerceRoleRouteSnapshot;
};

export function resolveEcommerceImageProviderProfile(snapshot: EcommerceRoleRouteSnapshot): EcommerceImageProviderProfile | null {
    if (snapshot.logicalRole !== "image_generation" || snapshot.capability !== "image") return null;
    const model = normalizeModelName(snapshot.upstreamModel);
    if (model === "gpt-image-2.5-flare" || model === "gpt-image-2.5-sunburst") {
        return {
            profileId: model,
            compilerFamily: "openai-image-2.5",
            supportsIndependentMask: snapshot.apiFormat === "openai" && snapshot.imageEdit?.supportsIndependentMask === true,
            modelSnapshot: { ...snapshot },
        };
    }
    if (model === "nano-banana-2") {
        return {
            profileId: "nano-banana-2",
            compilerFamily: "nano-banana-2",
            supportsIndependentMask: false,
            modelSnapshot: { ...snapshot },
        };
    }
    return null;
}

export function compileEcommerceImageCandidates(plan: EcommerceEditPlan, candidates: EcommerceRoleCandidate[]) {
    let first: { candidate: EcommerceRoleCandidate; execution: EcommerceCompiledImageRequest } | null = null;
    for (const candidate of candidates) {
        const profile = resolveEcommerceImageProviderProfile(candidate.snapshot);
        if (!profile) continue;
        const execution = compileEcommerceImageRequest(plan, profile);
        first ||= { candidate, execution };
        if (execution.state === "ready") return { candidate, execution };
    }
    return first;
}

export function compileEcommerceImageRequest(plan: EcommerceEditPlan, profile: EcommerceImageProviderProfile): EcommerceCompiledImageRequest {
    const referenceRoles = plan.operation === "local_edit" ? localEditReferences(plan) : plan.operation === "scene_edit" ? sceneEditReferences(plan) : productSceneReferences(plan);
    const referenceMapping = plan.planVersion === "ecommerce-edit.v6" ? mapReferenceUses(referenceRoles, plan.referenceUses || []) : undefined;
    const compilerVersion: EcommerceCompiledImageRequest["compilerVersion"] =
        plan.planVersion === "ecommerce-edit.v6"
            ? profile.compilerFamily === "openai-image-2.5"
                ? "ecommerce-openai-image-2.5.v4"
                : "ecommerce-nano-banana-2.v4"
            : profile.compilerFamily === "openai-image-2.5"
              ? plan.photography
                  ? "ecommerce-openai-image-2.5.v3"
                  : plan.protection
                    ? "ecommerce-openai-image-2.5.v2"
                    : "ecommerce-openai-image-2.5.v1"
              : plan.photography
                ? "ecommerce-nano-banana-2.v3"
                : plan.protection
                  ? "ecommerce-nano-banana-2.v2"
                  : "ecommerce-nano-banana-2.v1";
    const canvas = plan.canvas ? { ...plan.canvas, size: { ...plan.canvas.size } } : undefined;
    const prompt = [
        profile.compilerFamily === "openai-image-2.5" ? compileOpenAiPrompt(plan, referenceRoles) : compileNanoBananaPrompt(plan, referenceRoles),
        ...compilePhotography(plan),
        ...(canvas ? [`画布硬约束：${ecommerceCanvasSize(canvas)}（${canvas.mode}）；${canvas.allowReframe ? "只按此尺寸或比例执行" : "保持原机位和构图，不得裁切、补边或改变画幅"}。尺寸以此约束为准。`] : []),
    ].join("\n");
    const common = {
        compilerVersion,
        providerProfileId: profile.profileId,
        prompt,
        referenceRoles,
        ...(referenceMapping ? { referenceMapping } : {}),
        ...(canvas ? { canvas } : {}),
        ...(plan.protection ? { protection: structuredClone(plan.protection) } : {}),
        ...(plan.photography ? { photography: structuredClone(plan.photography) } : {}),
        parameters: { variant: profile.profileId, ...(canvas ? { size: ecommerceCanvasSize(canvas) } : {}) },
        modelSnapshot: { ...profile.modelSnapshot },
    };
    const requiresMask = plan.strategy === "strict_product" || (plan.operation === "scene_edit" && plan.protection?.scope === "local");
    if (requiresMask && !profile.supportsIndependentMask) {
        return { ...common, state: "needs_review", reason: "independent_mask_unsupported" };
    }
    return {
        ...common,
        state: "ready",
        ...(requiresMask ? { mask: { mode: "independent" as const, required: true as const } } : {}),
    };
}

function productSceneReferences(plan: EcommerceEditPlan) {
    if (!plan.source.productAnchorId) throw new Error("商品场景生成缺少商品锚点");
    return uniqueReferences([{ assetId: plan.source.productAnchorId, role: "product" as const }, ...plan.source.sceneReferenceIds.map((assetId) => ({ assetId, role: "scene" as const }))]);
}

function compilePhotography(plan: EcommerceEditPlan): string[] {
    const photography = plan.photography;
    if (!photography) return [];
    return [
        "摄影目标服从商品身份、受保护结构/材质和合法编辑范围；不得用审美目标覆盖硬约束。",
        ...photography.materials.map((material) => `材质保留 ${material.objectId}：纹理方向=${material.textureDirection}；纹理尺度=${material.textureScale}；粗糙度=${material.roughness}；光泽=${material.gloss}。`),
        `主光方向与面积=${photography.lighting.keyLight}；补光=${photography.lighting.fillLight}；白平衡=${photography.lighting.whiteBalance}；接触阴影=${photography.lighting.contactShadow}。`,
        `主体明度层次=${photography.composition.focalSubject}；空间纵深=${photography.composition.depth}；留白=${photography.composition.negativeSpace}。`,
        ...(plan.protection && !plan.protection.allowLightingChange ? ["不得改变全图光照、白平衡或商品纹理；新物体的光影融合仅在允许区域匹配现有光线。"] : []),
        "不套用统一暖黄滤镜，不增加油亮高光、过锐化或未请求的豪华装饰。",
    ];
}

function localEditReferences(plan: EcommerceEditPlan) {
    if (!plan.source.productAnchorId) throw new Error("商品局部编辑缺少商品锚点");
    return uniqueReferences([
        ...(plan.source.currentSceneBaselineId ? [{ assetId: plan.source.currentSceneBaselineId, role: "scene" as const }] : []),
        { assetId: plan.source.productAnchorId, role: "product" as const },
        ...plan.source.sceneReferenceIds.map((assetId) => ({ assetId, role: "scene" as const })),
    ]);
}

function sceneEditReferences(plan: EcommerceEditPlan) {
    return uniqueReferences([...(plan.source.currentSceneBaselineId ? [{ assetId: plan.source.currentSceneBaselineId, role: "scene" as const }] : []), ...plan.source.sceneReferenceIds.map((assetId) => ({ assetId, role: "scene" as const }))]);
}

function mapReferenceUses(referenceRoles: Array<{ assetId: string; role: "product" | "scene" }>, uses: EcommerceReferenceUse[]) {
    const byId = new Map(uses.map((use) => [use.assetId, use]));
    const mapped = referenceRoles.map((reference, providerIndex) => {
        const use = byId.get(reference.assetId);
        if (!use) throw new Error(`参考来源缺少用途绑定：${reference.assetId}`);
        if (use.purposes.some((purpose) => ["style", "lighting", "composition"].includes(purpose)) && !use.usedCueIds.length) throw new Error(`参考用途缺少已校验的视觉线索：${reference.assetId}`);
        return { assetId: reference.assetId, userAlias: use.alias, providerIndex, purposes: [...use.purposes] };
    });
    if (uses.some((use) => !referenceRoles.some((reference) => reference.assetId === use.assetId))) throw new Error("参考用途绑定更换了执行来源");
    return mapped;
}

function uniqueReferences(references: Array<{ assetId: string; role: "product" | "scene" }>) {
    const seen = new Set<string>();
    return references.filter((reference) => Boolean(reference.assetId) && !seen.has(reference.assetId) && Boolean(seen.add(reference.assetId)));
}

function compileOpenAiPrompt(plan: EcommerceEditPlan, references: Array<{ assetId: string; role: "product" | "scene" }>) {
    const usage = plan.planVersion === "ecommerce-edit.v6" && plan.referenceUses ? new Map(plan.referenceUses.map((use) => [use.assetId, use])) : undefined;
    return [
        `执行 ${plan.operation}，策略 ${plan.strategy}。`,
        `参考图角色：${references.map((reference, index) => `${reference.assetId}=${reference.role}${usage?.get(reference.assetId)?.alias ? `（${usage.get(reference.assetId)!.alias}，providerIndex=${index}）` : `（providerIndex=${index}）`}`).join("；")}。`,
        ...(usage
            ? [
                  `参考用途与线索：${references.map((reference) => `${reference.assetId}=${usage.get(reference.assetId)?.purposes.join("/") || ""}${usage.get(reference.assetId)?.usedCueIds.length ? ` cues=${usage.get(reference.assetId)!.usedCueIds.join(",")}` : ""}`).join("；")}。`,
              ]
            : []),
        ...(plan.baseline.productFacts ? [`商品基线：${productFacts(plan)}。`] : []),
        `场景基线：${sceneFacts(plan)}。`,
        `本轮增量：${changes(plan)}。`,
        `必须保持：${[...plan.preserve.productCore, ...plan.preserve.sceneElements].join("、")}。`,
        plan.operation === "local_edit"
            ? "只重绘独立蒙版允许的目标区域；商品核心、融合边缘和其他场景像素保持不变。"
            : plan.operation === "scene_edit"
              ? plan.planVersion === "ecommerce-edit.v6"
                  ? plan.protection?.scope === "local"
                      ? "以场景基线为编辑目标，并按绑定用途使用辅助参考；只执行独立蒙版允许的变化，选区外像素按原坐标从基线恢复。"
                      : "以场景基线为编辑目标，并按绑定用途使用辅助参考；不承诺选区外像素保持不变。"
                  : plan.protection?.scope === "local"
                    ? "以完整场景基线为唯一视觉参考，只执行独立蒙版允许的变化；选区外像素将按原坐标从基线恢复。"
                    : "以场景基线为唯一视觉参考执行全局变化；不承诺选区外像素保持不变。"
              : usage
                ? "商品锚点决定商品身份；辅助参考只能提供上述绑定用途下的已选线索，其他视觉属性不得导入。"
                : "商品锚点决定商品身份；场景参考仅决定空间、构图、光线和氛围。",
    ].join("\n");
}

function compileNanoBananaPrompt(plan: EcommerceEditPlan, references: Array<{ assetId: string; role: "product" | "scene" }>) {
    const usage = plan.planVersion === "ecommerce-edit.v6" && plan.referenceUses ? new Map(plan.referenceUses.map((use) => [use.assetId, use])) : undefined;
    return [
        `任务：${plan.operation}；策略：${plan.strategy}。`,
        ...references.map(
            (reference, index) =>
                `参考图${index + 1}（${reference.role === "product" ? "商品锚点" : "场景参考"}，providerIndex=${index}${usage?.get(reference.assetId)?.alias ? `，${usage.get(reference.assetId)!.alias}` : ""}）：${reference.assetId}${usage?.get(reference.assetId)?.purposes.length ? `；用途=${usage.get(reference.assetId)!.purposes.join("/")}` : ""}。`,
        ),
        ...(plan.baseline.productFacts ? [`商品事实：${productFacts(plan)}。`] : []),
        `场景事实：${sceneFacts(plan)}。`,
        `只执行本轮变化：${changes(plan)}。`,
        `禁止改变：${[...plan.preserve.productCore, ...plan.preserve.sceneElements].join("、")}。`,
    ].join("\n");
}

function productFacts(plan: EcommerceEditPlan) {
    const facts = plan.baseline.productFacts;
    if (!facts) return "";
    return [facts.identity, facts.outline, facts.color, facts.material, facts.brandText.join("、"), facts.view].filter(Boolean).join("；");
}

function sceneFacts(plan: EcommerceEditPlan) {
    const facts = plan.baseline.sceneFacts;
    if (!facts) return "未知（由本轮目标与参考用途决定）";
    return [facts.space, facts.composition, facts.lighting].filter(Boolean).join("；");
}

function changes(plan: EcommerceEditPlan) {
    return [...plan.delta.requestedChanges, ...plan.delta.targetObjects, ...plan.delta.targetRegions].filter(Boolean).join("；");
}

function normalizeModelName(value: string) {
    return value
        .trim()
        .toLowerCase()
        .replace(/^models\//, "")
        .replace(/[\s_]+/g, "-");
}
