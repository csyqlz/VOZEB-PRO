import { refundUserPoints } from "@/lib/auth/store";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

import { parseValidatedAgentFunctionCall } from "./agent-function-call";
import {
    ECOMMERCE_EDIT_PLAN_V6_VERSION,
    ECOMMERCE_EDIT_PLAN_VERSION,
    ecommercePhotographySchema,
    ecommerceVisibleStructureSchema,
    normalizeEcommerceEditPlan,
    resolveEcommerceCanvasConstraint,
    validateEcommerceEditPlan,
    type EcommerceCanvasInput,
    type EcommerceEditPlan,
} from "./ecommerce-edit-plan";
import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import {
    ecommerceReferenceCueIssues,
    referenceUsesFromEcommerceDecision,
    ECOMMERCE_REFERENCE_PURPOSES,
    ECOMMERCE_IMAGE_QUALIFIER_PATTERN,
    ECOMMERCE_PRODUCT_ATTRIBUTE_ACTION_PATTERN,
    ECOMMERCE_EDIT_PROHIBITION_PATTERN,
    ECOMMERCE_EDIT_PROHIBITION_MODIFIER_PATTERN,
    type EcommerceReferenceDecision,
} from "./ecommerce-reference-purpose";
import type { EcommerceRoleCandidate, EcommerceRoleRouteSnapshot } from "./ecommerce-model-routing";
import type { EcommerceSources } from "./ecommerce-reference-roles";
import type { EcommerceEditableTarget, EcommerceNormalizedRegion, EcommerceVisualAnalysis, EcommerceVisualAnalysisV4 } from "./ecommerce-visual-analysis";
import { rankTextPlanningCandidates, requestStructuredText, type TextPlanningValidationIssue } from "./text-planning-runtime";

export type EcommerceEditPlanningRequest = {
    origin: string;
    cookie: string;
    userId: string;
    requestId: string;
    planningInput: EcommercePlanningInput;
    sources: EcommerceSources;
    branchId: string;
    generationModelRole: string;
    qualityCheckModelRole: string | null;
    canvasInput?: Omit<EcommerceCanvasInput, "operation">;
    referenceDecision?: EcommerceReferenceDecision;
};

export type EcommerceEditPlanningResult = {
    plan: EcommerceEditPlan;
    modelRole: Pick<EcommerceRoleRouteSnapshot, "logicalModelId" | "channelId" | "upstreamModel"> & Partial<Pick<EcommerceRoleRouteSnapshot, "capability" | "apiFormat">> & { logicalRole: "edit_planning" };
};

export class EcommerceEditPlanningError extends Error {
    constructor(
        message: string,
        readonly status = 422,
        readonly issues: TextPlanningValidationIssue[] = [],
    ) {
        super(message);
        this.name = "EcommerceEditPlanningError";
    }
}

export type EcommerceResolvedLocalEditTarget = EcommerceEditableTarget & { source: "analysis" | "manual" };
export type EcommerceLocalEditTargetResolution =
    | { state: "resolved"; target: EcommerceResolvedLocalEditTarget }
    | { state: "needs_review"; reason: "missing_target" | "multiple_matching_targets"; clarificationQuestion: string }
    | { state: "rejected"; reason: "invalid_local_edit_source" | "product_edit_not_supported"; clarificationQuestion: string };

type EcommercePlannerVisualAnalysis = EcommerceVisualAnalysis | EcommerceVisualAnalysisV4;

export function unsupportedEcommerceProductEditMessage(userRequest: string, productAnchorId: string | null): string | null {
    if (!productAnchorId) return null;
    // Check the original request: a planner delta must not silently discard a
    // product change that the current protection strategy cannot execute.
    const action = new RegExp(`(?:${ECOMMERCE_PRODUCT_ATTRIBUTE_ACTION_PATTERN}|新增|增加|添加|减少|删除|移除|去掉|add\\b|remove\\b|delete\\b|increase\\b|decrease\\b)`, "i");
    const imageReference = `(?:@?图片\\s*\\d+\\s*${ECOMMERCE_IMAGE_QUALIFIER_PATTERN}\\s*)?`;
    const actionBeforeProperty = new RegExp(`${action.source}\\s*(?:一下)?\\s*${imageReference}$`, "i");
    const structureAttribute =
        "(?:结构|形状|外形|轮廓|尺寸|比例|(?:抽屉|柜门|把手|(?:支|柜|桌|椅)?腿)(?:的)?(?:数量|个数|形状|尺寸)?|\\b(?:structure|shape|outline|size|proportions?)\\b|\\b(?:drawers?|doors?|handles?|legs?)(?:\\s+(?:count|number|shape|size))?\\b)";
    const attribute = `(?:颜色|色彩|配色|材质|材料|\\bcolou?r\\b|\\bmaterial\\b|${structureAttribute})`;
    const productObject = "(?:商品|产品|主体|\\b(?:product|item|subject)(?:'s)?)";
    const environmentObject = "(?:背景(?:地板|墙(?:面)?)?|场景|环境|地板|墙(?:面)?|\\b(?:background(?:\\s+(?:floor|wall))?|floor|wall)(?:'s)?)";
    const object = `(?:${productObject}|${environmentObject})\\s*(?:的)?\\s*`;
    const propertyGroup = new RegExp(`${imageReference}${object}${attribute}(?:\\s*(?:和|与|以及|及|、|and\\b)\\s*${imageReference}(?:${object})?${attribute})*`, "gi");
    const productProperty = new RegExp(`${productObject}\\s*(?:的)?\\s*${attribute}`, "i");
    const prohibition = ECOMMERCE_EDIT_PROHIBITION_PATTERN;
    const modifiers = ECOMMERCE_EDIT_PROHIBITION_MODIFIER_PATTERN;
    const collective = "(?:都|一起|同时|均)";
    const predicateBoundary = "(?:保持|保留|维持|继承|并(?:且)?|但(?:是)?|而(?:且)?|然后|\\b(?:keep|preserve|maintain|inherit)\\b)";
    const transition = `(?:(?:从|由)(?:(?!${predicateBoundary})[^，,。.;；!！?？\\n])*?)?`;
    const actionAfterProperty = new RegExp(`^((?:\\s*${collective})?\\s*(?:${prohibition}\\s*${modifiers})?\\s*(?:${collective}\\s*)?(?:进行|做任何|做)?\\s*${transition})${action.source}`, "i");
    const negation = new RegExp(`${prohibition}\\s*${modifiers}$`, "i");
    const propertyNegation = new RegExp(`${prohibition}\\s*${modifiers}${imageReference}$`, "i");
    const hasProhibition = new RegExp(prohibition, "i");
    for (const clause of userRequest.split(/[，,。.;；!！?？\n]/)) {
        // Bind a shared action to its continuous object/attribute group; a
        // preservation clause or another predicate ends that relationship.
        for (const property of clause.matchAll(propertyGroup)) {
            if (!productProperty.test(property[0])) continue;
            const before = clause.slice(0, property.index);
            const after = clause.slice(property.index + property[0].length);
            const beforeAction = before.match(actionBeforeProperty);
            const afterAction = after.match(actionAfterProperty);
            const prohibitedBeforeAction = beforeAction && negation.test(before.slice(0, beforeAction.index));
            if ((beforeAction && !prohibitedBeforeAction) || (afterAction && !prohibitedBeforeAction && !propertyNegation.test(before) && !hasProhibition.test(afterAction[1]))) {
                return "当前商品保护模式暂不支持修改商品颜色或材质，也不支持修改商品结构或关键可见特征，已保留原始要求。请改为只修改背景、场景或光线。";
            }
        }
    }
    return null;
}

export async function planEcommerceEdit(input: EcommerceEditPlanningRequest, visualAnalysis: EcommercePlannerVisualAnalysis, candidates: EcommerceRoleCandidate[]): Promise<EcommerceEditPlanningResult> {
    assertRoleCandidates(candidates, "edit_planning");
    if (!candidates.length) throw new EcommerceEditPlanningError("编辑规划角色没有可用模型", 503);
    const hasSceneBaseline = Boolean(input.sources.currentSceneBaselineId);
    if (input.sources.status !== "resolved" || (!input.sources.productAnchorId && !hasSceneBaseline)) throw new EcommerceEditPlanningError("图片参考角色尚未解析完成", 409);
    assertReferenceCueEvidence(input, visualAnalysis);
    const unsupportedProductEdit = unsupportedEcommerceProductEditMessage(input.planningInput.userRequest, input.sources.productAnchorId);
    if (unsupportedProductEdit) throw new EcommerceEditPlanningError(unsupportedProductEdit, 409);
    let latestError: unknown;
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        const messages = editPlanningMessages(input, visualAnalysis, candidate.logicalModelId);
        const idempotencyKey = systemAiIdempotencyKey("ecommerce-edit-planning", input.userId, input.requestId, candidate.logicalModelId, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestStructuredText({
                origin: input.origin,
                cookie: input.cookie,
                candidate,
                messages,
                tool: input.referenceDecision ? executableEditPlanningTool(input.sources) : ecommerceEditPlanningTool,
                headers: systemAiBillingHeaders(candidate.logicalModelId, idempotencyKey, candidate.upstreamModel),
                preferNativeTools: true,
                validateArguments: (argumentsText) => validPlanArguments(argumentsText, input, visualAnalysis, candidate.logicalModelId),
                onInvalidResponse: (headers) => refundInvalidResponse(input.userId, candidate.logicalModelId, headers),
            });
            const plan = await parseValidatedAgentFunctionCall(
                call,
                (value) => normalizePlannedEdit(value, input, visualAnalysis, candidate.logicalModelId),
                () => refundInvalidResponse(input.userId, candidate.logicalModelId, call.headers),
                "编辑规划模型返回的字段不完整",
            );
            return {
                plan,
                modelRole: candidate.snapshot as EcommerceEditPlanningResult["modelRole"],
            };
        } catch (error) {
            latestError = error;
        }
    }
    if (latestError instanceof EcommerceEditPlanningError) throw latestError;
    throw new EcommerceEditPlanningError(latestError instanceof Error ? latestError.message : "编辑规划失败，请检查模型角色配置");
}

export function resolveLocalEditTarget(plan: EcommerceEditPlan, analysis: EcommercePlannerVisualAnalysis): EcommerceLocalEditTargetResolution {
    if (plan.operation !== "local_edit" || !plan.source.currentSceneBaselineId) {
        return { state: "rejected", reason: "invalid_local_edit_source", clarificationQuestion: "局部编辑需要明确引用一张已有场景结果。" };
    }
    const semanticTargets = [...plan.delta.requestedChanges, ...plan.delta.targetObjects, ...plan.delta.targetRegions];
    if (semanticTargets.some(isProtectedProductEdit)) {
        return { state: "rejected", reason: "product_edit_not_supported", clarificationQuestion: "第一期仅支持修改非商品区域，暂不支持商品颜色、材质、结构或包装文字修改。" };
    }
    if (plan.delta.manualRegion) {
        return {
            state: "resolved",
            target: { id: "manual-region", kind: "environment", label: "manual region", region: copyRegion(plan.delta.manualRegion), source: "manual" },
        };
    }
    const baseline = analysis.references.find((reference) => reference.assetId === plan.source.currentSceneBaselineId && referenceRole(reference) === "scene");
    if (!baseline) return { state: "needs_review", reason: "missing_target", clarificationQuestion: "无法确认当前场景中的可编辑区域，请重新选择一张清晰的历史结果。" };
    const requestedIds = new Set([...plan.delta.targetObjects, ...plan.delta.targetRegions]);
    const matches = baseline.editableTargets.filter((target) => requestedIds.has(target.id));
    if (matches.length > 1) {
        return { state: "needs_review", reason: "multiple_matching_targets", clarificationQuestion: "检测到多个可编辑目标，请明确要修改哪一个位置或物品。" };
    }
    if (matches.length !== 1 || [...requestedIds].some((id) => !baseline.editableTargets.some((target) => target.id === id))) {
        return { state: "needs_review", reason: "missing_target", clarificationQuestion: "无法唯一定位要修改的非商品区域，请补充具体位置或物品。" };
    }
    return { state: "resolved", target: { ...matches[0], region: copyRegion(matches[0].region), source: "analysis" } };
}

export function normalizePlannedEdit(value: unknown, input: EcommerceEditPlanningRequest, visualAnalysis: EcommercePlannerVisualAnalysis, planningLogicalModelId: string): EcommerceEditPlan | null {
    const unsupportedProductEdit = unsupportedEcommerceProductEditMessage(input.planningInput.userRequest, input.sources.productAnchorId);
    if (unsupportedProductEdit) throw new EcommerceEditPlanningError(unsupportedProductEdit, 409);
    if (!isRecord(value)) return null;
    const compatible = normalizePlannerOutput(value, input, visualAnalysis, planningLogicalModelId);
    if (!compatible) return null;
    assertReferenceCueEvidence(input, visualAnalysis);
    if (input.referenceDecision?.state === "resolved" && isRecord(compatible)) {
        const source = plannerRecord(compatible.source);
        if (source.productAnchorId !== input.sources.productAnchorId || source.currentSceneBaselineId !== input.sources.currentSceneBaselineId || !sameStrings(plannerStrings(source.sceneReferenceIds), input.sources.sceneReferenceIds))
            throw planBoundaryError("source", "编辑计划不得更换已解析的商品或场景来源");
        const sourceOrder = [...new Set([input.sources.currentSceneBaselineId, input.sources.productAnchorId, ...input.sources.sceneReferenceIds].filter((id): id is string => Boolean(id)))];
        const expected = referenceUsesFromEcommerceDecision({ decision: input.referenceDecision, sourceOrder });
        if (compatible.referenceUses !== undefined) {
            const supplied = compatible.referenceUses;
            if (!Array.isArray(supplied) || supplied.length !== expected.length || new Set(supplied.map((use) => plannerRecord(use).assetId)).size !== expected.length) throw planBoundaryError("referenceUses", "参考用途必须覆盖准确的执行来源");
            for (const [index, item] of supplied.entries()) {
                const use = plannerRecord(item);
                const binding = expected.find((candidate) => candidate.assetId === use.assetId);
                if (!binding || use.alias !== binding.alias || !Array.isArray(use.purposes) || !sameStrings([...use.purposes].sort(), [...binding.purposes].sort()))
                    throw planBoundaryError(`referenceUses[${index}].purposes`, "编辑计划不得更换服务端已确定的参考用途");
                if (!Array.isArray(use.usedCueIds) || new Set(use.usedCueIds).size !== use.usedCueIds.length || use.usedCueIds.some((cueId) => !binding.usedCueIds.includes(cueId)))
                    throw planBoundaryError(`referenceUses[${index}].usedCueIds`, "编辑计划只能使用对应用途下的可靠视觉线索");
                if (input.referenceDecision.appliedCues.some((cue) => cue.assetId === binding.assetId && binding.purposes.includes(cue.purpose) && !cue.cueIds.some((id) => (use.usedCueIds as unknown[]).includes(id))))
                    throw planBoundaryError(`referenceUses[${index}].usedCueIds`, "编辑计划必须为每个参考用途保留可靠视觉线索");
                binding.usedCueIds = [...use.usedCueIds];
            }
        }
        compatible.planVersion = ECOMMERCE_EDIT_PLAN_V6_VERSION;
        compatible.referenceUses = expected;
    }
    if (isRecord(compatible) && compatible.operation === "product_to_scene") {
        // Product-to-scene replaces the background and therefore has global scope.
        // The model must not be allowed to turn the global operation into an invalid
        // outside-mask promise by returning preserveOutsideMask=true.
        const plannerProtection = plannerRecord(compatible.protection);
        compatible.protection = {
            scope: "global",
            protectedObjectIds: [...new Set(plannerStrings(plannerProtection.protectedObjectIds))],
            preserveOutsideMask: false,
            allowLightingChange: true,
        };
    }
    if (isRecord(compatible) && ["scene_edit", "local_edit"].includes(String(compatible.operation))) {
        const requestedChange = sceneEditChangeInstructions(input.planningInput.userRequest).join("\n");
        const lightingChange =
            /(?:改(?:为|成)?|换成|调整|改变|变成|切换|change|adjust|make|relight)[^，,。.;；\n]*(?:光线|光照|灯光|阳光|日光|照明|主光|补光|白平衡|lighting)|(?:光线|光照|灯光|阳光|日光|照明|主光|补光|白平衡|lighting)[^，,。.;；\n]*(?:改(?:为|成)?|换成|调整|改变|变成|切换|change|adjust|make|relight)|(?:光线|光照|灯光|照明|主光|补光)[^，,。.;；\n]*(?:再|更|调|变(?:得)?)[^，,。.;；\n]*(?:亮|暗)/i.test(
                requestedChange,
            );
        const global =
            (lightingChange ||
                (compatible.operation === "scene_edit" &&
                    /(?:改(?:为|成)?|换成|调整|改变|变成|切换|change|adjust|make|relight)[^，,。.;；\n]*(?:视角|机位|构图|camera|perspective|viewpoint)|(?:视角|机位|构图|camera|perspective|viewpoint)[^，,。.;；\n]*(?:改(?:为|成)?|换成|调整|改变|变成|切换|change|adjust|make|relight)/i.test(
                        requestedChange,
                    ))) &&
            !/(?:只|仅|only|local).*(?:区域|局部|选区|area|region)/i.test(requestedChange);
        // Scope is bound to this user request. Planner rectangles remain unconfirmed hints.
        compatible.protection = {
            scope: global ? "global" : "local",
            protectedObjectIds: [...new Set([...(compatible.operation === "local_edit" && input.sources.productAnchorId ? [input.sources.productAnchorId] : []), ...plannerStrings(plannerRecord(compatible.protection).protectedObjectIds)])],
            preserveOutsideMask: compatible.operation === "scene_edit" && !global,
            allowLightingChange: global && lightingChange,
        };
    }
    try {
        validateEcommerceEditPlan(compatible as EcommerceEditPlan);
    } catch (error) {
        const message = error instanceof Error ? error.message : "计划字段无效";
        if (message.includes("商品核心保护项")) throw new EcommerceEditPlanningError(message);
        throw new EcommerceEditPlanningError(`编辑规划模型返回的字段不完整：${message}`);
    }
    const plan = normalizeEcommerceEditPlan(compatible);
    if (!plan) return null;
    const canonicalPlan = canonicalizeVisualBaseline(plan, input, visualAnalysis);
    if (input.referenceDecision?.state === "resolved") {
        canonicalPlan.planVersion = ECOMMERCE_EDIT_PLAN_V6_VERSION;
        if (!input.referenceDecision.currentSceneBaselineId) canonicalPlan.baseline.sceneFacts = null;
    } else {
        canonicalPlan.planVersion = ECOMMERCE_EDIT_PLAN_VERSION;
    }
    const canvas = resolveEcommerceCanvasConstraint({ ...input.canvasInput, operation: canonicalPlan.operation });
    delete canonicalPlan.canvas;
    if (canvas) canonicalPlan.canvas = canvas;
    boundPhotographyTargets(canonicalPlan, visualAnalysis, input.planningInput.userRequest);
    validatePlanBoundary(canonicalPlan, input, visualAnalysis, planningLogicalModelId);
    return canonicalPlan;
}

function assertReferenceCueEvidence(input: EcommerceEditPlanningRequest, analysis: EcommercePlannerVisualAnalysis) {
    if (!input.referenceDecision) return;
    if (input.referenceDecision.state !== "resolved" || analysis.analysisVersion !== "ecommerce-visual-analysis.v4") throw planBoundaryError("referenceDecision.state", "参考用途与视觉证据尚未可靠解析完成");
    const issues = ecommerceReferenceCueIssues(input.referenceDecision, analysis);
    if (issues.length) throw new EcommerceEditPlanningError("参考用途缺少可靠视觉线索，不能进入编辑规划", 409, issues);
}

function sceneEditChangeInstructions(userRequest: string): string[] {
    const changeAction = /(?:改(?:变|为|成)?|换成|调整|变成|切换|change|adjust|make|relight|(?:让|使|再|更|调|变(?:得)?)[^，,。.;；\n]*(?:亮|暗))/i;
    const preservation = /(?:保持|保留|维持|keep|preserve|maintain)/i;
    const prohibition = /(?:不要|不得|禁止|严禁|不|别|do not|don't|never).*(?:改(?:变|为|成)?|换成|调整|变成|切换|change|adjust|make|relight|(?:让|使|再|更|调|变(?:得)?)[^，,。.;；\n]*(?:亮|暗))/i;
    return userRequest
        .split(/[，,。.;；\n]/)
        .flatMap((clause) => {
            const instructions: string[] = [];
            let start = 0;
            // 和/与 enumerate attributes. Connectives only split an existing action from another instruction.
            for (const connector of clause.matchAll(/同时|并且|但(?:是)?|而(?:且)?/g)) {
                const left = clause.slice(start, connector.index);
                const rightStart = connector.index + connector[0].length;
                if (!changeAction.test(left) && !preservation.test(left)) continue;
                // Parallel actions inherit a prohibition; disposal markers do not grant permission.
                const parallel = /^(?:同时|并且|而且)$/.test(connector[0]);
                if (parallel && prohibition.test(left)) continue;
                instructions.push(left);
                start = rightStart;
            }
            return [...instructions, clause.slice(start)];
        })
        .filter((instruction) => !preservation.test(instruction) && !prohibition.test(instruction));
}

function normalizePlannerOutput(value: unknown, input: EcommerceEditPlanningRequest, visualAnalysis: EcommercePlannerVisualAnalysis, planningLogicalModelId: string) {
    if (!isRecord(value)) return null;
    const planner = unwrapPlannerEnvelope(value);
    if (input.referenceDecision) {
        if (planner.planVersion !== ECOMMERCE_EDIT_PLAN_V6_VERSION) throw planBoundaryError("planVersion", "当前编辑计划必须返回已声明的 v6 版本契约，不能使用旧格式适配器");
        if (!Array.isArray(planner.referenceUses)) throw planBoundaryError("referenceUses", "v6 编辑计划必须返回完整的 referenceUses 参考用途");
        const capability = executableEditCapability(input.sources);
        if (planner.operation !== capability.operation) throw planBoundaryError("operation", `当前来源仅支持 ${capability.operation}，不得改写为其他编辑操作`);
        if (planner.strategy !== capability.strategy) throw planBoundaryError("strategy", `当前来源仅支持 ${capability.strategy}，不得改变商品保护策略`);
        return { ...planner };
    }
    if ([ECOMMERCE_EDIT_PLAN_V6_VERSION, ECOMMERCE_EDIT_PLAN_VERSION, "ecommerce-edit.v4", "ecommerce-edit.v3", "ecommerce-edit.v2", "ecommerce-edit.v1"].includes(String(planner.planVersion)))
        return normalizeVersionedPlannerOutput(planner, input, visualAnalysis);

    const source = plannerRecord(planner.source);
    const operation = plannerText(planner.operation);
    const deltaCandidate = plannerRecord(planner.delta);
    const hasSceneMarker = Boolean(
        plannerText(source.productAssetId) || plannerText(source.product_asset_id) || plannerText(source.sceneReferenceAssetId) || plannerText(source.scene_reference_asset_id) || plannerText(source.inputType) || plannerText(source.input_type),
    );
    const isSceneGenerationContract = /scene|composit|product[_ -]?to[_ -]?scene/i.test(operation) || hasSceneMarker || Array.isArray(deltaCandidate.environmentElements);
    if (!isSceneGenerationContract) return planner;

    const productReference = visualAnalysis.references.find((reference) => referenceRole(reference) === "product" && reference.assetId === input.sources.productAnchorId);
    const sceneReference = visualAnalysis.references.find((reference) => {
        if (referenceRole(reference) !== "scene") return false;
        const ids = [input.sources.currentSceneBaselineId, ...input.sources.sceneReferenceIds].filter((id): id is string => Boolean(id));
        return ids.includes(reference.assetId);
    });
    const baseline = plannerRecord(planner.baseline);
    const rawProductFacts = plannerRecord(baseline.productFacts);
    const rawSceneFacts = plannerRecord(baseline.sceneFacts);
    const delta = plannerRecord(planner.delta);
    const preserve = plannerRecord(planner.preserve);
    const roles = plannerRecord(planner.modelRoles || planner.model_roles);
    const continuity = plannerRecord(planner.continuity);
    const validation = plannerRecord(planner.validation);
    const productFacts = plannerProductFacts(rawProductFacts, productReference?.productFacts);
    const sceneFacts = {
        space: plannerText(rawSceneFacts.space) || plannerText(rawSceneFacts.environment) || sceneReference?.sceneFacts?.space || "bright modern minimalist home interior",
        composition: plannerText(rawSceneFacts.composition) || plannerText(delta.composition) || sceneReference?.sceneFacts?.composition || "product-centered eye-level view with clear depth and generous negative space",
        lighting: plannerText(rawSceneFacts.lighting) || plannerText(delta.lighting) || sceneReference?.sceneFacts?.lighting || "soft natural window daylight with gentle shadows",
    };
    const requestedChanges = plannerStrings(delta.requestedChanges);
    for (const item of [delta.background, delta.lighting, delta.composition, delta.style, delta.mood]) {
        if (typeof item === "string" && item.trim()) requestedChanges.push(item.trim());
    }
    requestedChanges.push(...plannerStrings(delta.environmentElements));
    const productCore = plannerStrings(preserve.productCore);
    for (const [name, aliases] of [
        ["outline", ["outline", "geometry", "surfaceDetails"]],
        ["brand_text", ["brandText", "productIdentity"]],
        ["color", ["color"]],
        ["material", ["material", "woodMaterial", "woodGrain"]],
        ["scale", ["scale", "proportions"]],
        ["view", ["view", "frontView"]],
    ] as const) {
        if (aliases.some((alias) => preserve[alias] === true) || !productCore.includes(name)) productCore.push(name);
    }
    const checks = plannerStrings(validation.requiredChecks);
    if (!checks.length && Array.isArray(validation.checks)) {
        checks.push(
            ...validation.checks.flatMap((check) => {
                const record = plannerRecord(check);
                const name = plannerText(record.name);
                const criterion = plannerText(record.criterion);
                return name && criterion ? [`${name}: ${criterion}`] : name ? [name] : [];
            }),
        );
    }
    if (!checks.length) checks.push("product_identity", "product_outline", "product_material", "scene_composite");
    const sourceProductId = input.sources.productAnchorId;
    const sourceSceneId =
        plannerText(source.currentSceneBaselineId) || plannerText(source.current_scene_baseline_id) || plannerText(source.sceneReferenceAssetId) || plannerText(source.scene_reference_asset_id) || input.sources.currentSceneBaselineId || null;
    const sceneReferenceIds = plannerStrings(source.sceneReferenceIds || source.scene_reference_ids).filter((id) => id !== sourceProductId);
    if (!sceneReferenceIds.length) {
        sceneReferenceIds.push(...input.sources.sceneReferenceIds.filter((id) => id !== sourceProductId));
    }
    if (!sceneReferenceIds.length && sourceSceneId && sourceSceneId !== sourceProductId) sceneReferenceIds.push(sourceSceneId);
    const parentResultId = continuity.parentResultId === null ? null : plannerText(continuity.parentResultId) || input.sources.parentResultId || null;
    const branchId = plannerText(continuity.branchId) || input.branchId;
    return {
        planVersion: ECOMMERCE_EDIT_PLAN_VERSION,
        ...(planner.photography !== undefined ? { photography: planner.photography } : {}),
        operation: operation === "local_edit" ? "local_edit" : "product_to_scene",
        source: { productAnchorId: sourceProductId, currentSceneBaselineId: sourceSceneId, sceneReferenceIds },
        baseline: { productFacts, sceneFacts },
        delta: {
            requestedChanges: [...new Set(requestedChanges)],
            targetObjects: plannerStrings(delta.targetObjects).length ? plannerStrings(delta.targetObjects) : ["scene"],
            targetRegions: plannerStrings(delta.targetRegions).length ? plannerStrings(delta.targetRegions) : ["background", "environment"],
            ...(plannerRecord(delta.manualRegion).width !== undefined ? { manualRegion: delta.manualRegion } : {}),
        },
        preserve: { productCore: [...new Set(productCore)], sceneElements: plannerStrings(preserve.sceneElements) },
        strategy: "strict_product",
        modelRoles: {
            visionAnalysis: plannerText(roles.visionAnalysis) || visualAnalysis.modelRole.logicalModelId,
            editPlanning: plannerText(roles.editPlanning) || planningLogicalModelId,
            generation: plannerText(roles.generation) || input.generationModelRole,
            qualityCheck: input.qualityCheckModelRole === null ? null : plannerText(roles.qualityCheck) || input.qualityCheckModelRole,
        },
        continuity: { parentResultId, branchId },
        validation: { requiredChecks: checks },
    };
}

function normalizeVersionedPlannerOutput(planner: Record<string, unknown>, input: EcommerceEditPlanningRequest, visualAnalysis: EcommercePlannerVisualAnalysis) {
    const currentSceneBaselineId = input.sources.currentSceneBaselineId;
    const hasSceneBaseline = Boolean(currentSceneBaselineId && visualAnalysis.references.some((reference) => referenceRole(reference) === "scene" && reference.assetId === currentSceneBaselineId));
    if (plannerText(planner.operation) !== "local_edit" || input.sources.productAnchorId !== null || !hasSceneBaseline) {
        return planner;
    }
    return {
        ...planner,
        operation: "scene_edit",
        baseline: { ...plannerRecord(planner.baseline), productFacts: null },
        preserve: { ...plannerRecord(planner.preserve), productCore: [] },
        strategy: "integrated_scene",
    };
}

function unwrapPlannerEnvelope(value: Record<string, unknown>) {
    for (const key of ["plan", "editPlan", "ecommerceEditPlan", "data", "result"]) {
        const nested = value[key];
        if (!isRecord(nested)) continue;
        const source = plannerRecord(nested.source);
        if (nested.planVersion !== undefined || nested.operation !== undefined || Object.keys(source).length > 0) {
            return nested;
        }
    }
    return value;
}

function plannerProductFacts(value: Record<string, unknown>, fallback: unknown) {
    const source = plannerRecord(fallback);
    return {
        identity: plannerText(value.identity) || plannerText(source.identity) || "product",
        outline: plannerText(value.outline) || plannerText(source.outline) || "product outline",
        color: plannerText(value.color) || plannerText(source.color) || "original color",
        material: plannerText(value.material) || plannerText(source.material) || "original material",
        brandText: plannerStrings(value.brandText).length ? plannerStrings(value.brandText) : plannerStrings(source.brandText),
        view: plannerText(value.view) || plannerText(source.view) || "front view",
    };
}

function plannerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function referenceRole(reference: EcommercePlannerVisualAnalysis["references"][number]): "product" | "scene" | "unknown" {
    if ("role" in reference) return reference.role;
    if (reference.contentType === "isolated_product" || reference.contentType === "product_detail") return "product";
    if (reference.contentType === "interior_scene") return "scene";
    return "unknown";
}

function plannerText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function plannerStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function canonicalizeVisualBaseline(plan: EcommerceEditPlan, input: EcommerceEditPlanningRequest, analysis: EcommercePlannerVisualAnalysis): EcommerceEditPlan {
    const productFacts = analysis.references.find((reference) => reference.assetId === (input.referenceDecision?.productAnchorId || input.sources.productAnchorId))?.productFacts;
    const sceneIds = (input.referenceDecision ? [input.referenceDecision.currentSceneBaselineId] : [input.sources.currentSceneBaselineId, ...input.sources.sceneReferenceIds]).filter((id): id is string => Boolean(id));
    const sceneFacts = analysis.references.find((reference) => sceneIds.includes(reference.assetId))?.sceneFacts;
    if (input.sources.productAnchorId && !productFacts) throw new EcommerceEditPlanningError("视觉分析没有确认商品主参考图", 409);
    if (!input.sources.productAnchorId && !sceneFacts && !input.referenceDecision) throw new EcommerceEditPlanningError("视觉分析没有确认当前场景图", 409);
    if (input.referenceDecision) {
        const baseline = analysis.references.find((reference) => reference.assetId === (input.sources.currentSceneBaselineId || input.sources.productAnchorId));
        for (const [index, structure] of (plan.visibleStructure || []).entries()) {
            if (!baseline?.visibleStructure?.some((fact) => fact.objectId === structure.objectId && fact.feature === structure.feature && JSON.stringify(fact.evidenceRegion) === JSON.stringify(structure.evidenceRegion)))
                throw planBoundaryError(`visibleStructure[${index}]`, "结构对象与证据必须来自真实主基线");
        }
        const protectedIds = new Set(
            [
                baseline?.assetId,
                input.sources.productAnchorId,
                ...(baseline?.visibleStructure || []).map((fact) => fact.objectId),
                ...(baseline?.photographyFacts?.materials || []).map((fact) => fact.objectId),
                ...(baseline?.editableTargets || []).map((fact) => fact.id),
            ].filter(Boolean),
        );
        if (plan.protection?.protectedObjectIds.some((id) => !protectedIds.has(id))) throw planBoundaryError("protection.protectedObjectIds", "保护对象必须来自真实主基线");
    }
    return {
        ...plan,
        visibleStructure: structuredClone(plan.visibleStructure || analysis.references.find((reference) => reference.assetId === (input.sources.currentSceneBaselineId || input.sources.productAnchorId))?.visibleStructure || []),
        baseline: {
            productFacts: productFacts ? { ...productFacts, brandText: [...productFacts.brandText] } : null,
            sceneFacts: sceneFacts ? { ...sceneFacts } : input.referenceDecision ? null : plan.baseline.sceneFacts,
        },
    };
}

function boundPhotographyTargets(plan: EcommerceEditPlan, analysis: EcommercePlannerVisualAnalysis, userRequest: string) {
    if (!plan.photography) return;
    const baseline = analysis.references.find((reference) => reference.assetId === (plan.source.currentSceneBaselineId || plan.source.productAnchorId));
    const anchor = plan.source.productAnchorId ? analysis.references.find((reference) => reference.assetId === plan.source.productAnchorId) : undefined;
    const materialFacts = (anchor || baseline)?.photographyFacts;
    if (!materialFacts || (plan.protection?.scope === "local" && !baseline?.photographyFacts)) throw new EcommerceEditPlanningError("缺少可信的原图摄影事实，不能规划材质与摄影变化");
    if (plan.photography.materials.some((target) => !materialFacts.materials.some((fact) => fact.objectId === target.objectId))) throw new EcommerceEditPlanningError("摄影材质对象必须来自商品锚点或主基线的可见事实");
    // Material goals are preservation constraints. Scene style never supplies product material.
    plan.photography.materials = materialFacts.materials.map((fact) => ({
        objectId: fact.objectId,
        textureDirection: /木纹/.test(fact.textureDirection) ? "沿原图木纹方向" : `保留原有${fact.textureDirection}`,
        textureScale: `保留原有${fact.textureScale}`,
        roughness: `保留原有${fact.roughness}`,
        gloss: `保留原有${fact.gloss}`,
    }));
    if (plan.protection && !plan.protection.allowLightingChange) {
        const facts = baseline?.photographyFacts;
        if (!facts) throw new EcommerceEditPlanningError("缺少可信的主基线摄影事实，不能确认原有光线");
        plan.photography.lighting = {
            keyLight: `保留原有${facts.lighting.keyLight}`,
            fillLight: `保留原有${facts.lighting.fillLight}`,
            whiteBalance: `保留原有${facts.lighting.whiteBalance}`,
            contactShadow: plan.protection.scope === "local" ? `仅在允许区域匹配原有光线并融合本轮目标的接触阴影；保留区域外${facts.lighting.contactShadow}` : `保留原有${facts.lighting.contactShadow}`,
        };
    }
    const compositionChange =
        /(?:改(?:为|成)?|换成|调整|改变|变成|切换|change|adjust|make)[^，,。.;；\n]*(?:视角|机位|构图|camera|perspective|viewpoint)|(?:视角|机位|构图|camera|perspective|viewpoint)[^，,。.;；\n]*(?:改(?:为|成)?|换成|调整|改变|变成|切换|change|adjust|make)/i.test(
            sceneEditChangeInstructions(userRequest).join("\n"),
        );
    if (plan.protection && (plan.protection.scope === "local" || !compositionChange || plan.canvas?.allowReframe === false)) {
        if (!baseline?.photographyFacts) throw new EcommerceEditPlanningError("缺少可信的主基线摄影事实，不能确认原有构图");
        plan.photography.composition = structuredClone(baseline.photographyFacts.composition);
    }
    plan.validation.requiredChecks = [...new Set([...plan.validation.requiredChecks, "protected_material", "composition_lighting", "scene_intent"])];
}

function validatePlanBoundary(plan: EcommerceEditPlan, input: EcommerceEditPlanningRequest, analysis: EcommercePlannerVisualAnalysis, planningLogicalModelId: string) {
    const product = analysis.references.find((reference) => reference.assetId === (input.referenceDecision?.productAnchorId || input.sources.productAnchorId));
    const sceneSourceId = input.sources.currentSceneBaselineId || input.sources.sceneReferenceIds[0];
    const scene = sceneSourceId ? analysis.references.find((reference) => reference.assetId === sceneSourceId) : undefined;
    if (input.sources.productAnchorId && !product?.productFacts) throw new EcommerceEditPlanningError("视觉分析没有确认商品主参考图", 409);
    if (sceneSourceId && !scene?.sceneFacts && !input.referenceDecision) throw new EcommerceEditPlanningError("视觉分析没有确认当前场景图", 409);
    if (plan.source.productAnchorId !== input.sources.productAnchorId || plan.source.currentSceneBaselineId !== input.sources.currentSceneBaselineId || !sameStrings(plan.source.sceneReferenceIds, input.sources.sceneReferenceIds)) {
        throw new EcommerceEditPlanningError("编辑计划不得更换已解析的商品或场景来源");
    }
    if (input.sources.productAnchorId) {
        if (!product?.productFacts || !plan.baseline.productFacts || !sameProductFacts(plan.baseline.productFacts, product.productFacts)) {
            throw new EcommerceEditPlanningError("编辑计划中的商品基线与视觉分析不一致");
        }
    } else if (plan.baseline.productFacts !== null) throw new EcommerceEditPlanningError("场景编辑不能伪造商品基线");
    if (scene?.sceneFacts && plan.baseline.sceneFacts && !sameSceneFacts(plan.baseline.sceneFacts, scene.sceneFacts)) throw new EcommerceEditPlanningError("编辑计划中的场景基线与视觉分析不一致");
    const expectedRoles = {
        visionAnalysis: analysis.modelRole.logicalModelId,
        editPlanning: planningLogicalModelId,
        generation: input.generationModelRole,
        qualityCheck: input.qualityCheckModelRole,
    };
    if (Object.entries(expectedRoles).some(([key, expected]) => plan.modelRoles[key as keyof typeof expectedRoles] !== expected)) {
        throw new EcommerceEditPlanningError("编辑计划不得改写已配置的模型角色");
    }
    if (plan.continuity.parentResultId !== input.sources.parentResultId || plan.continuity.branchId !== input.branchId) {
        throw new EcommerceEditPlanningError("编辑计划不得改写连续编辑关系");
    }
    if (isAdjacentPropAddition(input.planningInput.userRequest) && targetsProductCore(plan)) {
        throw new EcommerceEditPlanningError("新增到商品旁边的道具必须规划为场景编辑，不能修改商品本体");
    }
}

function editPlanningMessages(input: EcommerceEditPlanningRequest, analysis: EcommercePlannerVisualAnalysis, planningLogicalModelId: string) {
    const systemPrompt =
        "你是电商图片编辑规划模型。把用户一句话转换为基线加增量的 EcommerceEditPlan。商品主参考、场景参考和连续编辑来源由服务端确定，不得交换。当 sources.productAnchorId 为空且 currentSceneBaselineId 有效时，必须使用 scene_edit、strategy=integrated_scene、baseline.productFacts=null、preserve.productCore=[]；不得输出 local_edit 或 strict_product。local_edit 的 targetObjects 必须只填写视觉分析 editableTargets 中的精确 ID；没有唯一候选时不得猜测坐标或目标。新增到商品旁边或周围的道具属于场景增量，不得写入 product_core 或商品本体。默认 strict_product；此策略下 preserve.productCore 必须是字符串数组，并逐项包含且只能依赖以下六个商品保护项：outline、brand_text、color、material、scale、view。即使某项看似未变化，也必须保留该项。photography 为可选摄影目标，必须依据 photographyFacts 逐项规划；事实不可确认时省略，不填空壳。材质目标只保持受保护商品的纹理方向/尺度、粗糙度/光泽；场景参考只借鉴空间、光线和风格。用户只加摆件时保留现有主光/补光/白平衡/构图，接触阴影与光影融合仅作用于允许区域；不得新增台灯照明、改变柜体颜色或重画木纹。白底商品到场景允许规划环境主光方向与面积、补光、白平衡、接触阴影、商品明度层次、留白与纵深。已有场景全局优化必须有本轮明确意图及对应 scope。禁止统一暖黄滤镜、油亮高光、过锐化和夸张豪华装饰。摄影目标不能改变商品身份或受保护材质。";
    const capability = input.referenceDecision ? executableEditCapability(input.sources) : null;
    const executablePrompt = capability
        ? `${systemPrompt} 当前已解析来源仅支持 operation=${capability.operation}、strategy=${capability.strategy}。操作名称只表示可执行的保护路径，不授权额外变更；用户未要求新场景时不得新增房间或陈设，delta 只保留本轮请求和获准线索，baseline.sceneFacts 只来自实际场景基线，没有场景基线时必须为 null。不能执行的要求必须保留并报告限制，不得改写为其他需求。`
        : systemPrompt;
    return [
        {
            role: "system" as const,
            content:
                input.referenceDecision?.state === "resolved"
                    ? executablePrompt.replace(
                          "场景参考只借鉴空间、光线和风格。",
                          "referenceDecision 是参考授权的唯一依据。商品事实只来自 productAnchorId，场景基线只来自 currentSceneBaselineId；目标与锚点的其他事实用于保持原有内容和定位编辑区域。辅助参考只能提供绑定用途下 appliedCues 明确选中的已选线索；未绑定用途、未选线索和辅助商品或场景属性不得进入 delta、photography 或基线。用户本轮明确描述的环境目标仍可规划，但不得从参考图推导额外变更。",
                      )
                    : executablePrompt,
        },
        {
            role: "user" as const,
            content: JSON.stringify({
                userRequest: input.planningInput.userRequest,
                conversationContext: input.planningInput.conversationContext,
                sources: input.sources,
                visualAnalysis: plannerVisualAnalysis(analysis, input.referenceDecision),
                ...(input.referenceDecision ? { referenceDecision: input.referenceDecision } : {}),
                requiredModelRoles: {
                    visionAnalysis: analysis.modelRole.logicalModelId,
                    editPlanning: planningLogicalModelId,
                    generation: input.generationModelRole,
                    qualityCheck: input.qualityCheckModelRole,
                },
                continuity: { parentResultId: input.sources.parentResultId, branchId: input.branchId },
            }),
        },
    ];
}

function executableEditCapability(sources: EcommerceSources): Pick<EcommerceEditPlan, "operation" | "strategy"> {
    if (!sources.productAnchorId) return { operation: "scene_edit", strategy: "integrated_scene" };
    return { operation: sources.currentSceneBaselineId ? "local_edit" : "product_to_scene", strategy: "strict_product" };
}

function executableEditPlanningTool(sources: EcommerceSources) {
    const capability = executableEditCapability(sources);
    return {
        ...ecommerceEditPlanningV6Tool,
        parameters: {
            ...ecommerceEditPlanningV6Tool.parameters,
            properties: {
                ...ecommerceEditPlanningV6Tool.parameters.properties,
                operation: { type: "string", enum: [capability.operation] },
                strategy: { type: "string", enum: [capability.strategy] },
            },
        },
    };
}

function plannerVisualAnalysis(analysis: EcommercePlannerVisualAnalysis, decision: EcommerceReferenceDecision | undefined) {
    if (decision?.state !== "resolved") return analysis;
    const uses = referenceUsesFromEcommerceDecision({ decision, sourceOrder: analysis.references.map((reference) => reference.assetId) });
    const useById = new Map(uses.filter((use) => use.purposes.length).map((use) => [use.assetId, use]));
    return structuredClone({
        analysisVersion: analysis.analysisVersion,
        modelRole: analysis.modelRole,
        references: analysis.references.flatMap((reference) => {
            const use = useById.get(reference.assetId);
            if (!use) return [];
            const baseline = [decision.editTargetId, decision.productAnchorId, decision.currentSceneBaselineId].includes(reference.assetId);
            const selectedCueIds = new Set(decision.appliedCues.filter((item) => item.assetId === reference.assetId && use.purposes.includes(item.purpose)).flatMap((item) => item.cueIds));
            return [
                {
                    assetId: reference.assetId,
                    alias: use.alias,
                    purposes: use.purposes,
                    cues: "cues" in reference ? reference.cues.filter((cue) => selectedCueIds.has(cue.id)) : [],
                    ...(baseline
                        ? {
                              ...("contentType" in reference ? { contentType: reference.contentType } : { role: reference.role }),
                              confidence: reference.confidence,
                              visualEvidence: reference.visualEvidence,
                              productFacts: reference.assetId === decision.productAnchorId ? reference.productFacts : null,
                              sceneFacts: reference.assetId === decision.currentSceneBaselineId ? reference.sceneFacts : null,
                              productCore: reference.productCore,
                              fusionHalo: reference.fusionHalo,
                              editableTargets: reference.editableTargets,
                              visibleStructure: reference.visibleStructure,
                              photographyFacts: reference.photographyFacts,
                              sourceSize: reference.sourceSize,
                          }
                        : {}),
                },
            ];
        }),
    });
}

function validPlanArguments(value: string, input: EcommerceEditPlanningRequest, analysis: EcommercePlannerVisualAnalysis, planningLogicalModelId: string) {
    try {
        const parsed = JSON.parse(value);
        const plan = normalizePlannedEdit(parsed, input, analysis, planningLogicalModelId);
        if (!plan) {
            console.warn("[ecommerce-edit-planner] planner contract not recognized", JSON.stringify(plannerDebugSummary(parsed)));
        }
        return input.referenceDecision ? { valid: Boolean(plan), issues: plan ? [] : [{ code: "edit_plan_invalid", path: "$", message: "编辑规划字段不完整" }] } : Boolean(plan);
    } catch (error) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(value);
        } catch {
            // The structured runtime already reports invalid JSON separately.
        }
        console.warn("[ecommerce-edit-planner] planner contract rejected", JSON.stringify({ error: error instanceof Error ? error.message : "unknown", ...plannerDebugSummary(parsed) }));
        return input.referenceDecision
            ? { valid: false, issues: error instanceof EcommerceEditPlanningError && error.issues.length ? error.issues : [{ code: "edit_plan_invalid", path: "$", message: error instanceof Error ? error.message : "编辑规划字段无效" }] }
            : false;
    }
}

function planBoundaryError(path: string, message: string) {
    return new EcommerceEditPlanningError(message, 422, [{ code: "edit_plan_boundary", path, message }]);
}

function plannerDebugSummary(value: unknown) {
    if (!isRecord(value)) return { type: typeof value };
    const planner = unwrapPlannerEnvelope(value);
    const source = plannerRecord(planner.source);
    const delta = plannerRecord(planner.delta);
    return {
        keys: Object.keys(value).slice(0, 24),
        unwrappedKeys: Object.keys(planner).slice(0, 24),
        operation: plannerText(planner.operation),
        sourceKeys: Object.keys(source).slice(0, 24),
        deltaKeys: Object.keys(delta).slice(0, 24),
    };
}

function isAdjacentPropAddition(value: string) {
    const text = value.toLowerCase();
    return /(?:add|place|put|新增|增加|添加|放置)/i.test(text) && /(?:next\s+to|beside|near|旁边|旁侧|附近|周围)/i.test(text);
}

function targetsProductCore(plan: EcommerceEditPlan) {
    return [...plan.delta.targetObjects, ...plan.delta.targetRegions].some((value) => /product[\s_-]*(?:body|core)|商品(?:本体|主体|核心)/i.test(value));
}

function isProtectedProductEdit(value: string) {
    return /product[\s_-]*(?:body|core|color|material|structure|packaging|text)|商品(?:本体|主体|核心|颜色|材质|结构|包装|文字)|产品(?:本体|主体|核心|颜色|材质|结构|包装|文字)/i.test(value);
}

function copyRegion(region: EcommerceNormalizedRegion): EcommerceNormalizedRegion {
    return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function sameProductFacts(left: NonNullable<EcommerceEditPlan["baseline"]["productFacts"]>, right: NonNullable<EcommerceEditPlan["baseline"]["productFacts"]>) {
    return left.identity === right.identity && left.outline === right.outline && left.color === right.color && left.material === right.material && left.view === right.view && sameStrings(left.brandText, right.brandText);
}

function sameSceneFacts(left: EcommerceEditPlan["baseline"]["sceneFacts"], right: EcommerceEditPlan["baseline"]["sceneFacts"]) {
    if (!left || !right) return left === right;
    return left.space === right.space && left.composition === right.composition && left.lighting === right.lighting;
}

function sameStrings(left: string[], right: string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRoleCandidates(candidates: EcommerceRoleCandidate[], expected: "edit_planning"): void {
    if (candidates.some((candidate) => candidate.logicalRole !== expected || candidate.capability !== "text")) {
        throw new EcommerceEditPlanningError(`模型候选角色必须是 ${expected}`, 400);
    }
}

async function refundInvalidResponse(userId: string, logicalModelId: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, logicalModelId, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const stringArray = { type: "array", items: { type: "string" } };
const productFacts = {
    type: "object",
    properties: {
        identity: { type: "string" },
        outline: { type: "string" },
        color: { type: "string" },
        material: { type: "string" },
        brandText: stringArray,
        view: { type: "string" },
    },
    required: ["identity", "outline", "color", "material", "brandText", "view"],
    additionalProperties: false,
};
const sceneFacts = {
    type: "object",
    properties: { space: { type: "string" }, composition: { type: "string" }, lighting: { type: "string" } },
    required: ["space", "composition", "lighting"],
    additionalProperties: false,
};

export const ecommerceEditPlanningTool = {
    name: "plan_ecommerce_edit",
    description: "根据已验证的商品与场景视觉事实生成 EcommerceEditPlan",
    parameters: {
        type: "object",
        properties: {
            planVersion: { type: "string", enum: [ECOMMERCE_EDIT_PLAN_VERSION] },
            visibleStructure: ecommerceVisibleStructureSchema,
            photography: ecommercePhotographySchema,
            protection: {
                type: "object",
                properties: { scope: { type: "string", enum: ["local", "global"] }, protectedObjectIds: stringArray, preserveOutsideMask: { type: "boolean" }, allowLightingChange: { type: "boolean" } },
                required: ["scope", "protectedObjectIds", "preserveOutsideMask", "allowLightingChange"],
                additionalProperties: false,
            },
            canvas: {
                type: "object",
                properties: {
                    mode: { type: "string", enum: ["exact", "ratio"] },
                    size: { type: "object", properties: { width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }, required: ["width", "height"], additionalProperties: false },
                    source: { type: "string", enum: ["user_text", "explicit_size", "baseline", "planning", "default"] },
                    allowReframe: { type: "boolean" },
                },
                required: ["mode", "size", "source", "allowReframe"],
                additionalProperties: false,
            },
            operation: { type: "string", enum: ["product_to_scene", "local_edit", "scene_edit"] },
            source: {
                type: "object",
                properties: {
                    productAnchorId: { anyOf: [{ type: "string" }, { type: "null" }] },
                    currentSceneBaselineId: { anyOf: [{ type: "string" }, { type: "null" }] },
                    sceneReferenceIds: { type: "array", maxItems: 1, items: { type: "string" } },
                },
                required: ["productAnchorId", "currentSceneBaselineId", "sceneReferenceIds"],
                additionalProperties: false,
            },
            baseline: {
                type: "object",
                properties: { productFacts: { anyOf: [productFacts, { type: "null" }] }, sceneFacts },
                required: ["productFacts", "sceneFacts"],
                additionalProperties: false,
            },
            delta: {
                type: "object",
                properties: {
                    requestedChanges: stringArray,
                    targetObjects: stringArray,
                    targetRegions: stringArray,
                    manualRegion: {
                        type: "object",
                        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                        required: ["x", "y", "width", "height"],
                        additionalProperties: false,
                    },
                },
                required: ["requestedChanges", "targetObjects", "targetRegions"],
                additionalProperties: false,
            },
            preserve: {
                type: "object",
                properties: { productCore: stringArray, sceneElements: stringArray },
                required: ["productCore", "sceneElements"],
                additionalProperties: false,
            },
            strategy: { type: "string", enum: ["strict_product", "integrated_scene", "creative_variation"] },
            modelRoles: {
                type: "object",
                properties: {
                    visionAnalysis: { type: "string" },
                    editPlanning: { type: "string" },
                    generation: { type: "string" },
                    qualityCheck: { type: ["string", "null"] },
                },
                required: ["visionAnalysis", "editPlanning", "generation", "qualityCheck"],
                additionalProperties: false,
            },
            continuity: {
                type: "object",
                properties: { parentResultId: { anyOf: [{ type: "string" }, { type: "null" }] }, branchId: { type: "string" } },
                required: ["parentResultId", "branchId"],
                additionalProperties: false,
            },
            validation: {
                type: "object",
                properties: { requiredChecks: stringArray },
                required: ["requiredChecks"],
                additionalProperties: false,
            },
        },
        required: ["planVersion", "operation", "source", "baseline", "delta", "preserve", "strategy", "modelRoles", "continuity", "validation"],
        additionalProperties: false,
    },
};

export const ecommerceEditPlanningV6Tool = {
    ...ecommerceEditPlanningTool,
    description: "依据 referenceDecision 的绑定用途、已选线索和目标/商品锚点事实生成 EcommerceEditPlan，不扩展辅助参考授权",
    parameters: {
        ...ecommerceEditPlanningTool.parameters,
        properties: {
            ...ecommerceEditPlanningTool.parameters.properties,
            planVersion: { type: "string", enum: [ECOMMERCE_EDIT_PLAN_V6_VERSION] },
            baseline: { ...ecommerceEditPlanningTool.parameters.properties.baseline, properties: { ...ecommerceEditPlanningTool.parameters.properties.baseline.properties, sceneFacts: { anyOf: [sceneFacts, { type: "null" }] } } },
            referenceUses: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        assetId: { type: "string" },
                        alias: { anyOf: [{ type: "string" }, { type: "null" }] },
                        purposes: { type: "array", uniqueItems: true, minItems: 1, items: { type: "string", enum: [...ECOMMERCE_REFERENCE_PURPOSES] } },
                        usedCueIds: stringArray,
                    },
                    required: ["assetId", "alias", "purposes", "usedCueIds"],
                    additionalProperties: false,
                },
            },
        },
        required: [...ecommerceEditPlanningTool.parameters.required, "referenceUses"],
    },
};
