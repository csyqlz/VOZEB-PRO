import type { ImageTask, ImageTaskConfig, ImageTaskReference } from "./image-task-store";
import { resolveEcommerceImageProviderProfile, type EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import { routeEcommerceRole } from "./ecommerce-model-routing";
import { compileStrictProductEdit, type ProductProtectionRegions } from "./ecommerce-product-regions";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import type { SceneEditProtection } from "./ecommerce-product-regions";
import { normalizeEcommerceEditProtection, normalizeEcommercePhotographyPlan } from "./ecommerce-edit-plan";
import { ECOMMERCE_REFERENCE_PURPOSES } from "./ecommerce-reference-purpose";
import { resolveImageEditProtocol, sameImageEditProtocol } from "./image-edit-protocol";

type EcommerceSettings = Parameters<typeof routeEcommerceRole>[0];

export class EcommerceImageTaskPreparationError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 409 = 400,
    ) {
        super(message);
        this.name = "EcommerceImageTaskPreparationError";
    }
}

export function assertEcommerceImageExecutionSnapshot(settings: EcommerceSettings, execution?: EcommerceCompiledImageRequest, frozenConfig?: ImageTaskConfig) {
    if (!execution) return;
    if (!validExecutionShape(execution)) throw new EcommerceImageTaskPreparationError("电商生图执行快照无效");
    const exactRoute = routeEcommerceRole(settings, "image_generation", execution.modelSnapshot);
    const exactProfile = exactRoute && resolveEcommerceImageProviderProfile(exactRoute.snapshot);
    const frozenEdit = frozenConfig && resolveImageEditProtocol(frozenConfig, exactRoute?.channel.baseUrl);
    if (
        !exactRoute ||
        !exactProfile ||
        (frozenEdit && (!exactRoute.snapshot.imageEdit || !sameImageEditProtocol(frozenEdit, exactRoute.snapshot.imageEdit))) ||
        exactProfile.profileId !== execution.providerProfileId ||
        exactProfile.modelSnapshot.apiFormat !== execution.modelSnapshot.apiFormat ||
        compilerVersionForProfile(exactProfile.compilerFamily, Boolean(execution.protection), Boolean(execution.photography), Boolean(execution.referenceMapping)) !== execution.compilerVersion
    ) {
        throw new EcommerceImageTaskPreparationError("电商生图执行快照已失效，请重新发起任务", 409);
    }
}

export function prepareEcommerceImageTask(input: {
    ecommerceExecution?: EcommerceCompiledImageRequest;
    kind: ImageTask["kind"];
    prompt: string;
    references: ImageTaskReference[];
    mask?: ImageTaskReference;
    productProtectionRegions?: ProductProtectionRegions;
    sceneProtection?: SceneEditProtection;
    compatibleConfigs: ImageTaskConfig[];
}) {
    const baseConfig = input.compatibleConfigs[0];
    if (!baseConfig) throw new EcommerceImageTaskPreparationError("当前模型能力不满足参考素材、比例或分辨率参数");
    if (input.ecommerceExecution && (input.prompt !== input.ecommerceExecution.prompt || !sameReferences(input.references, input.ecommerceExecution.referenceRoles))) {
        throw new EcommerceImageTaskPreparationError("电商生图执行内容与快照不一致");
    }
    let config = baseConfig;
    let prompt = input.prompt;
    let mask = input.mask;
    let productProtection: ImageTask["productProtection"];
    let sceneProtection: SceneEditProtection | undefined;
    let reviewReason = "";
    if (input.ecommerceExecution?.protection?.scope === "local" && !input.productProtectionRegions) {
        if (
            !normalizeEcommerceEditProtection(input.ecommerceExecution.protection) ||
            input.kind !== "edit" ||
            !ecommerceSceneProtectionReferencesMatch(input.ecommerceExecution.referenceRoles[0]?.assetId, input.references, input.ecommerceExecution) ||
            !input.ecommerceExecution.mask?.required
        )
            throw new EcommerceImageTaskPreparationError("局部场景执行快照无效");
        if (!resolveImageEditProtocol(baseConfig).supportsIndependentMask || input.ecommerceExecution.modelSnapshot.imageEdit?.supportsIndependentMask === false) reviewReason = "当前渠道尚未配置可用的独立蒙版编辑方式，请联系管理员。";
        else if (!input.sceneProtection) reviewReason = "请在原图上确认允许编辑的区域，包含新增物体及其接触阴影。";
        if (input.sceneProtection) {
            sceneProtection = structuredClone(input.sceneProtection);
            if (sceneProtection.sourceAssetId !== input.references[0].id || sceneProtection.selectionSource !== "user_selection") throw new EcommerceImageTaskPreparationError("场景选区与原图基线不匹配");
            mask = structuredClone(sceneProtection.mask);
        }
    } else if (input.sceneProtection) throw new EcommerceImageTaskPreparationError("当前执行范围不接受局部场景保护");
    if (input.productProtectionRegions) {
        if (input.kind !== "edit") throw new EcommerceImageTaskPreparationError("严格商品保护只支持图片编辑任务");
        try {
            const selected = input.compatibleConfigs.map((candidate) => ({
                config: candidate,
                result: compileStrictProductEdit({ kind: "edit", prompt: input.prompt, config: candidate, references: input.references }, input.productProtectionRegions!),
            }));
            const compilation = selected.find((candidate) => candidate.result.state === "ready") || selected[0];
            if (!compilation) throw new Error("当前模型能力不满足严格商品保护");
            config = compilation.config;
            prompt = compilation.result.task.prompt;
            mask = compilation.result.task.mask;
            productProtection = compilation.result.task.productProtection;
            if (compilation.result.state === "needs_review") reviewReason = compilation.result.reason;
        } catch (error) {
            throw new EcommerceImageTaskPreparationError(error instanceof Error ? error.message : "商品保护区域无效");
        }
    }
    return {
        config,
        candidateConfigs: productProtection || input.ecommerceExecution ? [] : input.compatibleConfigs.slice(1),
        prompt,
        mask,
        productProtection,
        sceneProtection,
        reviewReason,
    };
}

export async function schedulePreparedImageTask(task: ImageTask, reviewReason: string) {
    if (reviewReason) {
        await scheduleGenerationTask("image", task.id, {
            executionPhase: "needs_review",
            channelId: task.config.channelId,
            provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
            nextPollAt: undefined,
            lastUpstreamStatus: "strict_product_mask_review_required",
            resultPayload: { reviewReason },
        });
        return { needsReview: true as const, reviewReason };
    }
    await scheduleGenerationTask("image", task.id, {
        executionPhase: "created",
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        nextPollAt: Date.now(),
        lastUpstreamStatus: "created",
    });
    return { needsReview: false as const };
}

function validExecutionShape(value: EcommerceCompiledImageRequest) {
    return (
        value.state === "ready" &&
        Boolean(value.prompt?.trim()) &&
        Boolean(value.compilerVersion) &&
        Boolean(value.providerProfileId) &&
        Boolean(value.modelSnapshot) &&
        value.modelSnapshot.logicalRole === "image_generation" &&
        value.modelSnapshot.capability === "image" &&
        (value.protection === undefined || Boolean(normalizeEcommerceEditProtection(value.protection))) &&
        (value.photography === undefined || Boolean(normalizeEcommercePhotographyPlan(value.photography))) &&
        Array.isArray(value.referenceRoles) &&
        validReferenceMapping(value)
    );
}

function compilerVersionForProfile(family: "openai-image-2.5" | "nano-banana-2", protection: boolean, photography: boolean, referencePurposes: boolean) {
    if (referencePurposes) return family === "openai-image-2.5" ? "ecommerce-openai-image-2.5.v4" : "ecommerce-nano-banana-2.v4";
    return family === "openai-image-2.5"
        ? photography
            ? "ecommerce-openai-image-2.5.v3"
            : protection
              ? "ecommerce-openai-image-2.5.v2"
              : "ecommerce-openai-image-2.5.v1"
        : photography
          ? "ecommerce-nano-banana-2.v3"
          : protection
            ? "ecommerce-nano-banana-2.v2"
            : "ecommerce-nano-banana-2.v1";
}

function validReferenceMapping(execution: EcommerceCompiledImageRequest) {
    if (!execution.compilerVersion?.endsWith(".v4")) return execution.referenceMapping === undefined;
    const mapping = execution.referenceMapping;
    if (!Array.isArray(mapping) || !mapping.length || mapping.length !== execution.referenceRoles.length || new Set(mapping.map((item) => item.assetId)).size !== mapping.length) return false;
    const aliases = mapping.flatMap((item) => (item.userAlias === null ? [] : [item.userAlias]));
    return (
        new Set(aliases).size === aliases.length &&
        mapping.every(
            (item, index) =>
                item.assetId === execution.referenceRoles[index]?.assetId &&
                item.providerIndex === index &&
                (item.userAlias === null || /^图片[1-9]\d*$/.test(item.userAlias)) &&
                Array.isArray(item.purposes) &&
                item.purposes.length > 0 &&
                new Set(item.purposes).size === item.purposes.length &&
                item.purposes.every((purpose) => ECOMMERCE_REFERENCE_PURPOSES.includes(purpose)) &&
                item.purposes.includes("edit_target") === (index === 0) &&
                (execution.referenceRoles[index].role !== "product" || item.purposes.includes("product_identity")),
        )
    );
}

export function ecommerceSceneProtectionReferencesMatch(sourceAssetId: string | undefined, references: ImageTaskReference[], execution?: EcommerceCompiledImageRequest) {
    if (!sourceAssetId || references[0]?.id !== sourceAssetId) return false;
    return execution?.compilerVersion?.endsWith(".v4") ? validReferenceMapping(execution) && sameReferences(references, execution.referenceRoles) : references.length === 1;
}

function sameReferences(references: ImageTaskReference[], roles: EcommerceCompiledImageRequest["referenceRoles"]) {
    return references.length === roles.length && references.every((reference, index) => reference.id === roles[index]?.assetId && reference.ecommerceRole === roles[index]?.role);
}
