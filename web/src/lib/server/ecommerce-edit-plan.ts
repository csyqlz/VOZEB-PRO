export const ECOMMERCE_EDIT_PLAN_VERSION = "ecommerce-edit.v5" as const;
export const ECOMMERCE_EDIT_PLAN_V6_VERSION = "ecommerce-edit.v6" as const;
export const ECOMMERCE_REFERENCE_PURPOSE_VALUES = ["edit_target", "product_identity", "style", "lighting", "composition"] as const;
export type EcommerceReferencePurposeValue = (typeof ECOMMERCE_REFERENCE_PURPOSE_VALUES)[number];

export type EcommerceReferenceUse = {
    assetId: string;
    alias: string | null;
    purposes: EcommerceReferencePurposeValue[];
    usedCueIds: string[];
};

export type EcommercePhotographyPlan = {
    materials: Array<{ objectId: string; textureDirection: string; textureScale: string; roughness: string; gloss: string }>;
    lighting: { keyLight: string; fillLight: string; whiteBalance: string; contactShadow: string };
    composition: { focalSubject: string; depth: string; negativeSpace: string };
};

export function normalizeEcommercePhotographyPlan(value: unknown): EcommercePhotographyPlan | null {
    if (!isRecord(value) || !Array.isArray(value.materials) || !isRecord(value.lighting) || !isRecord(value.composition)) return null;
    const normalizeFields = (record: Record<string, unknown>, keys: string[]) =>
        keys.every((key) => typeof record[key] === "string" && Boolean((record[key] as string).trim())) ? Object.fromEntries(keys.map((key) => [key, (record[key] as string).trim()])) : null;
    const materials = value.materials.map((item) => (isRecord(item) ? normalizeFields(item, ["objectId", "textureDirection", "textureScale", "roughness", "gloss"]) : null));
    const lighting = normalizeFields(value.lighting, ["keyLight", "fillLight", "whiteBalance", "contactShadow"]);
    const composition = normalizeFields(value.composition, ["focalSubject", "depth", "negativeSpace"]);
    if (materials.some((item) => !item) || new Set(materials.map((item) => item?.objectId)).size !== materials.length || !lighting || !composition) return null;
    return { materials, lighting, composition } as EcommercePhotographyPlan;
}

const photographyStringFields = (keys: string[]) => ({ type: "object", properties: Object.fromEntries(keys.map((key) => [key, { type: "string", minLength: 1 }])), required: keys, additionalProperties: false });
export const ecommercePhotographySchema = {
    type: "object",
    properties: {
        materials: { type: "array", items: photographyStringFields(["objectId", "textureDirection", "textureScale", "roughness", "gloss"]) },
        lighting: photographyStringFields(["keyLight", "fillLight", "whiteBalance", "contactShadow"]),
        composition: photographyStringFields(["focalSubject", "depth", "negativeSpace"]),
    },
    required: ["materials", "lighting", "composition"],
    additionalProperties: false,
};

export type EcommerceVisibleStructure = {
    objectId: string;
    feature: "drawers" | "doors" | "handles" | "legs";
    count: number | null;
    certainty: "confirmed" | "uncertain";
    evidenceRegion: EcommerceManualRegion;
};

export function normalizeEcommerceVisibleStructure(value: unknown): EcommerceVisibleStructure[] | null {
    if (!Array.isArray(value)) return null;
    const facts: EcommerceVisibleStructure[] = [];
    for (const item of value) {
        if (!isRecord(item) || typeof item.objectId !== "string" || !item.objectId.trim() || !["drawers", "doors", "handles", "legs"].includes(String(item.feature))) return null;
        if (item.certainty === "confirmed" ? !Number.isSafeInteger(item.count) || (item.count as number) < 0 : item.certainty !== "uncertain" || item.count !== null) return null;
        const region = normalizeManualRegion(item.evidenceRegion);
        if (!region || !Object.values(region).every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) return null;
        if (facts.some((fact) => fact.objectId === (item.objectId as string).trim() && fact.feature === item.feature)) return null;
        facts.push({ objectId: item.objectId.trim(), feature: item.feature as EcommerceVisibleStructure["feature"], count: item.count as number | null, certainty: item.certainty as EcommerceVisibleStructure["certainty"], evidenceRegion: region });
    }
    return facts;
}

export const ecommerceVisibleStructureSchema = {
    type: "array",
    items: {
        type: "object",
        properties: {
            objectId: { type: "string" },
            feature: { type: "string", enum: ["drawers", "doors", "handles", "legs"] },
            count: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
            certainty: { type: "string", enum: ["confirmed", "uncertain"] },
            evidenceRegion: {
                type: "object",
                properties: { x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } },
                required: ["x", "y", "width", "height"],
                additionalProperties: false,
            },
        },
        required: ["objectId", "feature", "count", "certainty", "evidenceRegion"],
        additionalProperties: false,
    },
};

export type EcommerceOperation = "product_to_scene" | "local_edit" | "scene_edit";
export type EcommerceStrategy = "strict_product" | "integrated_scene" | "creative_variation";
export type EcommerceDimensions = { width: number; height: number };
export type EcommerceEditProtection = {
    scope: "local" | "global";
    protectedObjectIds: string[];
    preserveOutsideMask: boolean;
    allowLightingChange: boolean;
};

export function normalizeEcommerceEditProtection(value: unknown): EcommerceEditProtection | null {
    if (
        !isRecord(value) ||
        !["local", "global"].includes(String(value.scope)) ||
        typeof value.preserveOutsideMask !== "boolean" ||
        typeof value.allowLightingChange !== "boolean" ||
        !Array.isArray(value.protectedObjectIds) ||
        value.protectedObjectIds.some((id) => typeof id !== "string" || !id.trim())
    )
        return null;
    if (value.scope === "global" && value.preserveOutsideMask) return null;
    return { scope: value.scope as EcommerceEditProtection["scope"], protectedObjectIds: [...value.protectedObjectIds] as string[], preserveOutsideMask: value.preserveOutsideMask, allowLightingChange: value.allowLightingChange };
}
export type EcommerceCanvasConstraint = {
    mode: "exact" | "ratio";
    size: EcommerceDimensions;
    source: "user_text" | "explicit_size" | "baseline" | "planning" | "default";
    allowReframe: boolean;
};
export type EcommerceCanvasInput = {
    operation: EcommerceOperation;
    userRequest?: { mode: "preserve" } | { mode: "exact" | "ratio"; size: EcommerceDimensions };
    explicitSize?: EcommerceDimensions;
    baselineSize?: EcommerceDimensions;
    planningSize?: EcommerceDimensions;
    defaultSize?: EcommerceDimensions;
};
export type EcommerceCanvasMediaEvidence = {
    constraint: EcommerceCanvasConstraint;
    requestedSize?: EcommerceDimensions;
    providerRequest?: EcommerceCanvasProviderRequest;
    nativeSize: EcommerceDimensions;
    storedSize: EcommerceDimensions;
    nativeUrl: string;
    normalization: "none" | "uniform_scale" | "pixel_grid_scale";
};
export type EcommerceCanvasProviderRequest = { size?: string; aspectRatio?: string; width?: number; height?: number };

export function validateEcommerceDimensions(size: EcommerceDimensions): void {
    if (!size || ![size.width, size.height].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("图片尺寸必须是正整数");
}

export function resolveEcommerceCanvasConstraint(input: EcommerceCanvasInput): EcommerceCanvasConstraint | null {
    for (const size of [input.explicitSize, input.baselineSize, input.planningSize, input.defaultSize, input.userRequest && input.userRequest.mode !== "preserve" ? input.userRequest.size : undefined]) {
        if (size !== undefined) validateEcommerceDimensions(size);
    }
    const constraint = (mode: EcommerceCanvasConstraint["mode"], size: EcommerceDimensions, source: EcommerceCanvasConstraint["source"], allowReframe: boolean): EcommerceCanvasConstraint => ({ mode, size: { ...size }, source, allowReframe });
    if (input.userRequest?.mode === "preserve") return input.baselineSize ? constraint("exact", input.baselineSize, "user_text", false) : null;
    if (input.userRequest) return constraint(input.userRequest.mode, input.userRequest.size, "user_text", true);
    if (input.explicitSize) return constraint("exact", input.explicitSize, "explicit_size", true);
    if (input.baselineSize) return constraint(input.operation === "product_to_scene" ? "ratio" : "exact", input.baselineSize, "baseline", input.operation === "product_to_scene");
    if (input.planningSize) return constraint("ratio", input.planningSize, "planning", true);
    if (input.defaultSize) return constraint("ratio", input.defaultSize, "default", true);
    return null;
}

export function normalizeEcommerceCanvasConstraint(value: unknown): EcommerceCanvasConstraint | null {
    if (!isRecord(value) || !["exact", "ratio"].includes(String(value.mode)) || !["user_text", "explicit_size", "baseline", "planning", "default"].includes(String(value.source)) || typeof value.allowReframe !== "boolean" || !isRecord(value.size))
        return null;
    const size = { width: value.size.width as number, height: value.size.height as number };
    try {
        validateEcommerceDimensions(size);
    } catch {
        return null;
    }
    return { mode: value.mode as EcommerceCanvasConstraint["mode"], source: value.source as EcommerceCanvasConstraint["source"], allowReframe: value.allowReframe, size };
}

export function ecommerceCanvasSize(canvas: EcommerceCanvasConstraint): string {
    const { width, height } = canvas.size;
    if (canvas.mode === "exact") return `${width}x${height}`;
    let a = width;
    let b = height;
    while (b) [a, b] = [b, a % b];
    return `${width / a}:${height / a}`;
}
export type EcommerceModelRoles = {
    visionAnalysis: string;
    editPlanning: string;
    generation: string;
    qualityCheck: string | null;
};

export type EcommerceProductFacts = {
    identity: string;
    outline: string;
    color: string;
    material: string;
    brandText: string[];
    view: string;
};

export type EcommerceSceneFacts = {
    space: string;
    composition: string;
    lighting: string;
};

export type EcommerceManualRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type EcommerceEditPlan = {
    planVersion: typeof ECOMMERCE_EDIT_PLAN_V6_VERSION | typeof ECOMMERCE_EDIT_PLAN_VERSION | "ecommerce-edit.v4" | "ecommerce-edit.v3" | "ecommerce-edit.v2" | "ecommerce-edit.v1";
    photography?: EcommercePhotographyPlan;
    visibleStructure?: EcommerceVisibleStructure[];
    canvas?: EcommerceCanvasConstraint;
    protection?: EcommerceEditProtection;
    referenceUses?: EcommerceReferenceUse[];
    operation: EcommerceOperation;
    source: {
        productAnchorId: string | null;
        currentSceneBaselineId: string | null;
        sceneReferenceIds: string[];
    };
    baseline: {
        productFacts: EcommerceProductFacts | null;
        sceneFacts: EcommerceSceneFacts | null;
    };
    delta: {
        requestedChanges: string[];
        targetObjects: string[];
        targetRegions: string[];
        manualRegion?: EcommerceManualRegion;
    };
    preserve: {
        productCore: string[];
        sceneElements: string[];
    };
    strategy: EcommerceStrategy;
    modelRoles: EcommerceModelRoles;
    continuity: {
        parentResultId: string | null;
        branchId: string;
    };
    validation: {
        requiredChecks: string[];
    };
};

export type EcommerceEditPlanPublicSummary = {
    operation: EcommerceOperation;
    strategy: EcommerceStrategy;
    requestedChanges: string[];
    targetObjects: string[];
};

const OPERATIONS = new Set<EcommerceOperation>(["product_to_scene", "local_edit", "scene_edit"]);
const STRATEGIES = new Set<EcommerceStrategy>(["strict_product", "integrated_scene", "creative_variation"]);
const STRICT_PRODUCT_CORE = ["outline", "brand_text", "color", "material", "scale", "view"];

export function normalizeEcommerceEditPlan(value: unknown): EcommerceEditPlan | null {
    if (!isRecord(value) || ![ECOMMERCE_EDIT_PLAN_V6_VERSION, ECOMMERCE_EDIT_PLAN_VERSION, "ecommerce-edit.v4", "ecommerce-edit.v3", "ecommerce-edit.v2", "ecommerce-edit.v1"].includes(String(value.planVersion))) return null;
    const photography = value.photography === undefined ? undefined : normalizeEcommercePhotographyPlan(value.photography);
    if (photography === null || (photography !== undefined && ![ECOMMERCE_EDIT_PLAN_VERSION, ECOMMERCE_EDIT_PLAN_V6_VERSION].includes(String(value.planVersion) as typeof ECOMMERCE_EDIT_PLAN_VERSION | typeof ECOMMERCE_EDIT_PLAN_V6_VERSION))) return null;
    const visibleStructure = value.visibleStructure === undefined ? undefined : normalizeEcommerceVisibleStructure(value.visibleStructure);
    if (visibleStructure === null || (visibleStructure !== undefined && ![ECOMMERCE_EDIT_PLAN_VERSION, ECOMMERCE_EDIT_PLAN_V6_VERSION, "ecommerce-edit.v4"].includes(String(value.planVersion)))) return null;
    const canvas = value.canvas === undefined ? undefined : normalizeEcommerceCanvasConstraint(value.canvas);
    if (canvas === null) return null;
    const protection = value.protection === undefined ? undefined : normalizeEcommerceEditProtection(value.protection);
    if (protection === null) return null;

    const source = asRecord(value.source);
    const baseline = asRecord(value.baseline);
    const delta = asRecord(value.delta);
    const preserve = asRecord(value.preserve);
    const modelRoles = asRecord(value.modelRoles);
    const continuity = asRecord(value.continuity);
    const validation = asRecord(value.validation);
    const productFacts = asRecord(baseline?.productFacts);
    const sceneFacts = asRecord(baseline?.sceneFacts);
    const referenceUses = normalizeReferenceUses(value.referenceUses, String(value.planVersion) === ECOMMERCE_EDIT_PLAN_V6_VERSION);
    if (referenceUses === null) return null;

    const normalized: EcommerceEditPlan = {
        planVersion: value.planVersion as EcommerceEditPlan["planVersion"],
        ...(photography ? { photography } : {}),
        ...(visibleStructure ? { visibleStructure } : {}),
        ...(canvas ? { canvas } : {}),
        ...(protection ? { protection } : {}),
        ...(referenceUses ? { referenceUses } : {}),
        operation: value.operation as EcommerceOperation,
        source: {
            productAnchorId: normalizeNullableId(source?.productAnchorId),
            currentSceneBaselineId: normalizeNullableId(source?.currentSceneBaselineId),
            sceneReferenceIds: normalizeStringArray(source?.sceneReferenceIds),
        },
        baseline: {
            productFacts:
                baseline?.productFacts === null
                    ? null
                    : {
                          identity: normalizeText(productFacts?.identity),
                          outline: normalizeText(productFacts?.outline),
                          color: normalizeText(productFacts?.color),
                          material: normalizeText(productFacts?.material),
                          brandText: normalizeStringArray(productFacts?.brandText),
                          view: normalizeText(productFacts?.view),
                      },
            sceneFacts:
                baseline?.sceneFacts === null && value.planVersion === ECOMMERCE_EDIT_PLAN_V6_VERSION
                    ? null
                    : {
                          space: normalizeText(sceneFacts?.space),
                          composition: normalizeText(sceneFacts?.composition),
                          lighting: normalizeText(sceneFacts?.lighting),
                      },
        },
        delta: {
            requestedChanges: normalizeStringArray(delta?.requestedChanges),
            targetObjects: normalizeStringArray(delta?.targetObjects),
            targetRegions: normalizeStringArray(delta?.targetRegions),
            ...(normalizeManualRegion(delta?.manualRegion) ? { manualRegion: normalizeManualRegion(delta?.manualRegion) } : {}),
        },
        preserve: {
            productCore: normalizeStringArray(preserve?.productCore),
            sceneElements: normalizeStringArray(preserve?.sceneElements),
        },
        strategy: value.strategy as EcommerceStrategy,
        modelRoles: {
            visionAnalysis: normalizeText(modelRoles?.visionAnalysis),
            editPlanning: normalizeText(modelRoles?.editPlanning),
            generation: normalizeText(modelRoles?.generation),
            qualityCheck: modelRoles?.qualityCheck === null ? null : normalizeText(modelRoles?.qualityCheck),
        },
        continuity: {
            parentResultId: normalizeNullableId(continuity?.parentResultId),
            branchId: normalizeId(continuity?.branchId) || "",
        },
        validation: {
            requiredChecks: normalizeStringArray(validation?.requiredChecks),
        },
    };

    try {
        validateEcommerceEditPlan(normalized);
    } catch {
        return null;
    }
    return normalized;
}

export function validateEcommerceEditPlan(plan: EcommerceEditPlan): void {
    if (!isRecord(plan) || ![ECOMMERCE_EDIT_PLAN_V6_VERSION, ECOMMERCE_EDIT_PLAN_VERSION, "ecommerce-edit.v4", "ecommerce-edit.v3", "ecommerce-edit.v2", "ecommerce-edit.v1"].includes(plan.planVersion)) throw new Error("商品编辑计划版本无效");
    if (
        plan.photography !== undefined &&
        (![ECOMMERCE_EDIT_PLAN_VERSION, ECOMMERCE_EDIT_PLAN_V6_VERSION].includes(plan.planVersion as typeof ECOMMERCE_EDIT_PLAN_VERSION | typeof ECOMMERCE_EDIT_PLAN_V6_VERSION) || !normalizeEcommercePhotographyPlan(plan.photography))
    )
        throw new Error("摄影规划无效或不属于原任务版本");
    if (
        plan.visibleStructure !== undefined &&
        (![ECOMMERCE_EDIT_PLAN_VERSION, ECOMMERCE_EDIT_PLAN_V6_VERSION, "ecommerce-edit.v4"].includes(plan.planVersion as typeof ECOMMERCE_EDIT_PLAN_VERSION | typeof ECOMMERCE_EDIT_PLAN_V6_VERSION | "ecommerce-edit.v4") ||
            !normalizeEcommerceVisibleStructure(plan.visibleStructure))
    )
        throw new Error("可见结构事实无效或不属于原任务版本");
    if (plan.planVersion === ECOMMERCE_EDIT_PLAN_V6_VERSION && plan.referenceUses !== undefined && !normalizeReferenceUses(plan.referenceUses, true)) throw new Error("参考用途快照无效");
    if (plan.canvas !== undefined && !normalizeEcommerceCanvasConstraint(plan.canvas)) throw new Error("商品编辑画布尺寸约束无效");
    if (plan.protection !== undefined && !normalizeEcommerceEditProtection(plan.protection)) throw new Error("编辑保护约束无效");
    if ([ECOMMERCE_EDIT_PLAN_V6_VERSION, ECOMMERCE_EDIT_PLAN_VERSION, "ecommerce-edit.v4", "ecommerce-edit.v3"].includes(plan.planVersion as string) && ["local_edit", "scene_edit"].includes(plan.operation) && !plan.protection)
        throw new Error("局部或场景编辑缺少保护范围");
    if (!OPERATIONS.has(plan.operation)) throw new Error("商品编辑操作无效");
    if (!STRATEGIES.has(plan.strategy)) throw new Error("商品编辑策略无效");
    if (!isRecord(plan.source)) throw new Error("商品编辑来源无效");

    const sceneEdit = plan.operation === "scene_edit";
    if (sceneEdit) {
        if (plan.protection?.scope === "local" && !plan.protection.preserveOutsideMask) throw new Error("局部场景编辑必须保护选区外像素");
        if (plan.source.productAnchorId !== null) throw new Error("场景编辑不能包含商品锚点");
        if (plan.source.currentSceneBaselineId === null) throw new Error("场景编辑缺少当前场景基线");
        if (plan.baseline?.productFacts !== null) throw new Error("场景编辑不能包含商品事实");
        if (plan.strategy !== "integrated_scene") throw new Error("场景编辑策略必须是 integrated_scene");
    } else {
        requireId(plan.source.productAnchorId, "商品主参考图");
    }
    if (!Array.isArray(plan.source.sceneReferenceIds) || plan.source.sceneReferenceIds.length > 1) throw new Error("场景参考图数量无效");
    plan.source.sceneReferenceIds.forEach((id) => {
        requireId(id, "场景参考图");
        if (plan.source.productAnchorId && id === plan.source.productAnchorId) throw new Error("场景参考图不能作为商品主参考图");
    });
    if (plan.source.currentSceneBaselineId !== null) {
        requireId(plan.source.currentSceneBaselineId, "当前场景基线");
        if (plan.source.productAnchorId && plan.source.currentSceneBaselineId === plan.source.productAnchorId) throw new Error("当前场景基线不能替代商品主参考图");
    }

    if (!sceneEdit) validateProductFacts(plan.baseline?.productFacts);
    if (plan.baseline?.sceneFacts !== null || plan.planVersion !== ECOMMERCE_EDIT_PLAN_V6_VERSION) validateSceneFacts(plan.baseline?.sceneFacts);
    if (!isRecord(plan.delta)) throw new Error("场景增量无效");
    requireStringArray(plan.delta.requestedChanges, "创作请求");
    requireStringArray(plan.delta.targetObjects, "编辑目标");
    requireStringArray(plan.delta.targetRegions, "编辑区域");
    if (plan.delta.manualRegion !== undefined) validateManualRegion(plan.delta.manualRegion);
    if (plan.operation === "local_edit" && !plan.delta.targetObjects.length && !plan.delta.manualRegion) throw new Error("局部编辑目标无效");

    if (!isRecord(plan.preserve)) throw new Error("商品保护项无效");
    requireStringArray(plan.preserve.productCore, "商品核心保护项");
    requireStringArray(plan.preserve.sceneElements, "场景保护项");
    if (sceneEdit && plan.preserve.productCore.length) throw new Error("场景编辑不能包含商品核心保护项");
    if (plan.strategy === "strict_product" && STRICT_PRODUCT_CORE.some((key) => !plan.preserve.productCore.includes(key))) throw new Error("商品核心保护项不完整");

    if (!isRecord(plan.modelRoles)) throw new Error("模型角色无效");
    [plan.modelRoles.visionAnalysis, plan.modelRoles.editPlanning, plan.modelRoles.generation].forEach((role) => requireId(role, "模型角色"));
    if (plan.modelRoles.qualityCheck !== null) requireId(plan.modelRoles.qualityCheck, "视觉质检模型角色");

    if (!isRecord(plan.continuity)) throw new Error("连续编辑关系无效");
    if (plan.continuity.parentResultId !== null) requireId(plan.continuity.parentResultId, "父结果");
    requireId(plan.continuity.branchId, "编辑分支");

    if (!isRecord(plan.validation)) throw new Error("验收规则无效");
    requireStringArray(plan.validation.requiredChecks, "验收规则");
}

export function planPublicSummary(plan: EcommerceEditPlan): EcommerceEditPlanPublicSummary {
    validateEcommerceEditPlan(plan);
    return {
        operation: plan.operation,
        strategy: plan.strategy,
        requestedChanges: [...plan.delta.requestedChanges],
        targetObjects: [...plan.delta.targetObjects],
    };
}

function validateProductFacts(value: EcommerceProductFacts | null | undefined): asserts value is EcommerceProductFacts {
    if (!isRecord(value)) throw new Error("商品事实无效");
    [value.identity, value.outline, value.color, value.material, value.view].forEach((item) => requireText(item, "商品事实"));
    requireStringArray(value.brandText, "品牌文字");
}

function validateSceneFacts(value: EcommerceSceneFacts | null | undefined): asserts value is EcommerceSceneFacts {
    if (!isRecord(value)) throw new Error("场景事实无效");
    [value.space, value.composition, value.lighting].forEach((item) => requireText(item, "场景事实"));
}

function validateManualRegion(value: EcommerceManualRegion): void {
    if (!isRecord(value) || ![value.x, value.y, value.width, value.height].every((item) => typeof item === "number" && Number.isFinite(item))) throw new Error("手动编辑区域无效");
    if (value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0) throw new Error("手动编辑区域无效");
}

function requireText(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}无效`);
}

function requireId(value: unknown, label: string): asserts value is string {
    requireText(value, label);
}

function requireStringArray(value: unknown, label: string): asserts value is string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label}无效`);
}

function normalizeText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value: unknown): string | null {
    const text = normalizeText(value);
    return text || null;
}

function normalizeNullableId(value: unknown): string | null {
    return value === null || value === undefined ? null : typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function normalizeReferenceUses(value: unknown, required: boolean): EcommerceReferenceUse[] | undefined | null {
    if (value === undefined) return required ? null : undefined;
    if (!Array.isArray(value)) return null;
    const output: EcommerceReferenceUse[] = [];
    const ids = new Set<string>();
    const aliases = new Set<string>();
    for (const item of value) {
        if (!isRecord(item) || typeof item.assetId !== "string" || !item.assetId.trim() || (item.alias !== null && typeof item.alias !== "string") || !Array.isArray(item.purposes) || !Array.isArray(item.usedCueIds)) return null;
        const assetId = item.assetId.trim();
        const alias = item.alias === null ? null : item.alias.trim();
        const purposes = item.purposes.filter((purpose): purpose is EcommerceReferencePurposeValue => typeof purpose === "string" && ECOMMERCE_REFERENCE_PURPOSE_VALUES.includes(purpose as EcommerceReferencePurposeValue));
        const usedCueIds = item.usedCueIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim());
        if (ids.has(assetId) || purposes.length !== item.purposes.length || new Set(purposes).size !== purposes.length || new Set(usedCueIds).size !== usedCueIds.length || (alias && aliases.has(alias))) return null;
        ids.add(assetId);
        if (alias) aliases.add(alias);
        output.push({ assetId, alias, purposes, usedCueIds });
    }
    return output;
}

function normalizeManualRegion(value: unknown): EcommerceManualRegion | undefined {
    if (!isRecord(value)) return undefined;
    const values = [value.x, value.y, value.width, value.height];
    if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    const [x, y, width, height] = values as number[];
    return { x, y, width, height };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
