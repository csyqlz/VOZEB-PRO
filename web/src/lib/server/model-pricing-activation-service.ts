import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LogicalModelCapability, LogicalModelCapabilityProfile } from "@/lib/auth/store";
import { getFreshAuthSettings, updateAuthSettingsWith } from "@/lib/auth/store";
import { PricingConflictError, PricingInputError, type ModelPricingActivation, type ModelPricingApproval } from "@/lib/model-pricing";
import { toSystemGenerationChannel, type SystemGenerationChannelConfig } from "./generation-channel";
import { getModelPricingAdmission } from "./model-pricing-admission";
import { getModelPricingActivation, saveModelPricingActivation } from "./model-pricing-activation-store";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { getModelPricingShadowEvidence } from "./model-pricing-shadow-evidence";

type ImageOperation = "generations" | "edits";
type AudioOperation = "generateContent" | "chat/completions";
const imageScope = (operation: ImageOperation) => `image:${operation}:standard`;
const audioScope = (operation: AudioOperation) => `audio:${operation}:standard`;

export async function getModelPricingActivationStatus(modelId: string, imageOperation?: ImageOperation, audioOperation?: AudioOperation) {
    const scope = imageOperation ? imageScope(imageOperation) : audioOperation ? audioScope(audioOperation) : undefined;
    const admission = await getModelPricingAdmission(modelId, undefined, undefined, imageOperation, audioOperation);
    const stored = await getModelPricingActivation(modelId, scope);
    const activeAdmission = stored?.enabled ? await getModelPricingAdmission(modelId, stored.textUsageRuleId || null, undefined, imageOperation, audioOperation, Boolean(stored.bindings)) : admission;
    const activation = scope ? stored : await getCompatibleActivation(modelId, activeAdmission, stored);
    const bindings = await Promise.all(
        admission.bindings.map(async (binding) => {
            const shadow =
                binding.contractIds.length && admission.officialVersionId
                    ? await getModelPricingShadowEvidence(
                          modelId,
                          admission.officialVersionId,
                          binding.contractIds,
                          binding.key.slice(0, binding.key.indexOf("/")),
                          ...(admission.capability === "text" && admission.textUsageRuleId !== undefined ? [admission.textUsageRuleId] : []),
                      )
                    : null;
            const approved = activation?.bindings?.[binding.key];
            const activeBinding = activeAdmission.bindings.find((item) => item.key === binding.key);
            const active = Boolean(
                activation?.enabled && activation.fingerprint === activeAdmission.fingerprint && activation.officialVersionId === activeAdmission.officialVersionId && activeBinding?.fingerprint && approved?.fingerprint === activeBinding.fingerprint,
            );
            return {
                ...binding,
                shadow,
                active,
                approvalBlocker:
                    !activation?.enabled || !approved || active
                        ? null
                        : activation.fingerprint !== activeAdmission.fingerprint || activation.officialVersionId !== activeAdmission.officialVersionId
                          ? "旧批准的模型计价条件已变更"
                          : !activeBinding?.fingerprint
                            ? "旧批准渠道当前不具备有效计费契约"
                            : "旧批准的渠道指纹与当前配置不一致",
            };
        }),
    );
    const shadow = bindings.find((binding) => binding.shadow?.ready)?.shadow || bindings.find((binding) => binding.shadow)?.shadow || null;
    return {
        admission,
        activation: activation || null,
        shadow,
        bindings,
        active: bindings.some((binding) => binding.active),
    };
}

export async function setModelPricingActivation(input: { modelId: string; enabled: boolean; expectedRevision: string | null; actorId: string; bindingKey?: string; evidence?: unknown; imageOperation?: ImageOperation; audioOperation?: AudioOperation }) {
    if (typeof input.enabled !== "boolean" || (typeof input.expectedRevision !== "string" && input.expectedRevision !== null)) throw new PricingInputError("计费启用参数无效");
    if (input.imageOperation && input.imageOperation !== "generations" && input.imageOperation !== "edits") throw new PricingInputError("图片计价操作无效");
    if (input.audioOperation && input.audioOperation !== "generateContent" && input.audioOperation !== "chat/completions") throw new PricingInputError("音频计价操作无效");
    if (input.imageOperation && input.audioOperation) throw new PricingInputError("计价操作范围不能重复");
    const scope = input.imageOperation ? imageScope(input.imageOperation) : input.audioOperation ? audioScope(input.audioOperation) : undefined;
    const admission = await getModelPricingAdmission(input.modelId, undefined, undefined, input.imageOperation, input.audioOperation);
    const stored = await getModelPricingActivation(input.modelId, scope);
    if ((stored?.revision || null) !== input.expectedRevision) throw new PricingConflictError("计费启用状态已变化，请刷新后重新核对");
    if (input.enabled && stored?.enabled && stored.textUsageRuleId !== admission.textUsageRuleId && admission.capability === "text" && input.bindingKey) throw new PricingInputError("切换模型缓存规则须核对全部已启用绑定，不能只切换单一渠道");
    const current = scope ? stored : await getCompatibleActivation(input.modelId, admission, stored);
    if (input.enabled && (!admission.structuralComplete || !admission.fingerprint || !admission.salesVersionId || !admission.officialVersionId)) throw new PricingInputError(`模型尚不能启用按量计费：${admission.blockers.join("；")}`);
    const switchingTextRule = Boolean(input.enabled && stored?.enabled && stored.textUsageRuleId !== admission.textUsageRuleId && admission.capability === "text");
    const selected = input.enabled ? admission.bindings.filter((binding) => (!input.bindingKey || binding.key === input.bindingKey) && (!switchingTextRule || Boolean(stored?.bindings?.[binding.key])) && binding.fingerprint) : [];
    if (switchingTextRule && selected.length !== Object.keys(stored?.bindings || {}).length) throw new PricingInputError("已有按量渠道的契约或绑定已变化，旧规则继续生效，请先逐项核对");
    if (input.enabled && !selected.length) throw new PricingInputError(input.bindingKey ? `渠道绑定 ${input.bindingKey} 尚未具备计费契约` : "没有具备计费契约的渠道绑定");
    const validCurrent = current?.enabled && current.fingerprint === admission.fingerprint && current.officialVersionId === admission.officialVersionId;
    const approved: NonNullable<ModelPricingActivation["bindings"]> = input.enabled && validCurrent ? { ...current.bindings } : {};
    let missingCount = 0;
    for (const binding of selected) {
        if (approved[binding.key]?.fingerprint === binding.fingerprint) continue;
        const shadow = await getModelPricingShadowEvidence(
            input.modelId,
            admission.officialVersionId!,
            binding.contractIds,
            binding.key.slice(0, binding.key.indexOf("/")),
            ...(admission.capability === "text" && admission.textUsageRuleId !== undefined ? [admission.textUsageRuleId] : []),
        );
        if (!shadow.ready) {
            missingCount += shadow.missingCount;
            continue;
        }
        approved[binding.key] = { fingerprint: binding.fingerprint!, contractIds: binding.contractIds, shadowReceiptIds: shadow.receiptIds };
    }
    if (input.enabled && stored?.enabled && stored.textUsageRuleId !== admission.textUsageRuleId && admission.capability === "text" && missingCount) throw new PricingInputError(`新规则尚有 ${missingCount} 份影子报价待核对，旧规则继续生效`);
    if (input.enabled && ((input.bindingKey && missingCount) || !Object.keys(approved).length)) throw new PricingInputError(`等待真实调用产生当前售价与契约的可计价影子报价（缺少 ${missingCount || selected[0]?.contractIds.length || 1} 份）`);
    const shadowReceiptIds = Object.assign({}, ...Object.values(approved).map((binding) => binding.shadowReceiptIds));
    const next: ModelPricingActivation = {
        modelId: input.modelId,
        ...(scope ? { scope } : {}),
        enabled: input.enabled,
        revision: randomUUID(),
        fingerprint: input.enabled ? admission.fingerprint! : current?.fingerprint || "",
        salesVersionId: input.enabled ? admission.salesVersionId! : current?.salesVersionId || "",
        officialVersionId: input.enabled ? admission.officialVersionId! : current?.officialVersionId || "",
        ...(input.enabled && admission.capability === "text" && admission.textUsageRuleId ? { textUsageRuleId: admission.textUsageRuleId } : current?.textUsageRuleId ? { textUsageRuleId: current.textUsageRuleId } : {}),
        evidence: { shadowReceiptIds: input.enabled ? shadowReceiptIds : current?.evidence.shadowReceiptIds || {} },
        bindings: input.enabled ? approved : current?.bindings || {},
        changedAt: new Date().toISOString(),
        changedBy: input.actorId,
    };
    await saveModelPricingActivation(next, current?.revision || null);
    if (input.enabled) {
        const settings = await getFreshAuthSettings();
        const accepted = new Set(Object.keys(approved));
        if (settings.logicalModels?.some((model) => model.id === input.modelId && model.bindings.some((binding) => binding.acceptanceOnly && accepted.has(`${binding.channelId}/${binding.upstreamModel}`)))) {
            await updateAuthSettingsWith((latest) => ({
                logicalModels: latest.logicalModels.map((model) =>
                    model.id !== input.modelId
                        ? model
                        : {
                              ...model,
                              bindings: model.bindings.map((binding) => (accepted.has(`${binding.channelId}/${binding.upstreamModel}`) ? { ...binding, acceptanceOnly: false } : binding)),
                          },
                ),
            }));
        }
    }
    return getModelPricingActivationStatus(input.modelId, input.imageOperation, input.audioOperation);
}

/** A public request cannot choose its own mode; a saved activation must still match every current prerequisite. */
export async function publicModelPricingMode(
    modelId: string,
    capability: LogicalModelCapability,
    configs: Array<{
        logicalModel?: string;
        channelId?: string;
        model: string;
        apiSource?: string;
        baseUrl?: string;
        apiKey?: string;
        apiFormat?: string;
        advancedConfig?: SystemGenerationChannelConfig["advancedConfig"];
        capabilityProfile?: LogicalModelCapabilityProfile;
    }>,
    imageOperation?: ImageOperation,
    audioOperation?: AudioOperation,
): Promise<ModelPricingApproval | { billingMode: "blocked"; reason: string } | undefined> {
    const result = await publicModelPricingRouting(modelId, capability, configs, imageOperation, audioOperation);
    return result.state === "metered" ? result.approval : result.state === "blocked" ? { billingMode: "blocked", reason: result.reason } : undefined;
}

export async function publicModelPricingRouting<T extends Parameters<typeof publicModelPricingMode>[2][number]>(
    modelId: string,
    capability: LogicalModelCapability,
    configs: T[],
    imageOperation?: ImageOperation,
    audioOperation?: AudioOperation,
): Promise<{ state: "fixed"; configs: T[] } | { state: "blocked"; configs: []; reason: string } | { state: "metered"; configs: T[]; approval: ModelPricingApproval }> {
    if (imageOperation && capability !== "image") return { state: "blocked", configs: [], reason: "图片计价操作与模型能力不一致" };
    if (audioOperation && capability !== "audio") return { state: "blocked", configs: [], reason: "音频计价操作与模型能力不一致" };
    const requestedScope = imageOperation ? imageScope(imageOperation) : audioOperation ? audioScope(audioOperation) : undefined;
    let scoped: ModelPricingActivation | undefined;
    try {
        scoped = requestedScope ? await getModelPricingActivation(modelId, requestedScope) : undefined;
    } catch {
        return { state: "blocked", configs: [], reason: "计费渠道状态暂时无法核对，未向上游提交请求" };
    }
    const scope = scoped ? requestedScope : undefined;
    if (!configs.length || configs.some((config) => config.logicalModel !== modelId || !config.channelId)) {
        try {
            if ((scoped || (await getModelPricingActivation(modelId)))?.enabled) return { state: "blocked", configs: [], reason: "渠道绑定无法核对，未向上游提交请求" };
        } catch {
            return { state: "blocked", configs: [], reason: "计费渠道状态暂时无法核对，未向上游提交请求" };
        }
        return { state: "fixed", configs };
    }
    try {
        const stored = scoped || (await getModelPricingActivation(modelId));
        const admission = stored?.enabled ? await getModelPricingAdmission(modelId, stored.textUsageRuleId || null, undefined, scope ? imageOperation : undefined, scope ? audioOperation : undefined, Boolean(stored.bindings)) : null;
        const activation = admission && !scope ? await getCompatibleActivation(modelId, admission, stored) : stored;
        if (!activation?.enabled) return { state: "fixed", configs };
        if (!admission?.structuralComplete || admission.capability !== capability || activation.fingerprint !== admission.fingerprint || activation.officialVersionId !== admission.officialVersionId)
            return { state: "blocked", configs: [], reason: "已启用按量计费的模型价目或渠道契约需要重新核对，未向上游提交请求" };
        const currentConfigs = resolveLogicalModelCandidates(await getFreshAuthSettings(), capability, modelId, "", true).map(toSystemGenerationChannel);
        const eligible = configs.filter((config) => {
            const key = `${config.channelId}/${config.model}`;
            const binding = admission.bindings.find((item) => item.key === key);
            return binding?.fingerprint && activation.bindings?.[key]?.fingerprint === binding.fingerprint && currentConfigs.some((current) => samePricingChannelConfig(config, current, capability));
        });
        if (!eligible.length) return { state: "blocked", configs: [], reason: "当前模型没有已验收的按量渠道，未向上游提交请求" };
        return {
            state: "metered",
            configs: eligible,
            approval: {
                billingMode: "official-usage",
                fingerprint: admission.fingerprint!,
                salesVersionId: admission.salesVersionId!,
                officialVersionId: admission.officialVersionId!,
                ...(scope ? { scope } : {}),
                bindingKeys: eligible.map((config) => `${config.channelId}/${config.model}`),
            },
        };
    } catch {
        return { state: "blocked", configs: [], reason: "计费渠道状态暂时无法核对，未向上游提交请求" };
    }
}

async function getCompatibleActivation(modelId: string, admission: Awaited<ReturnType<typeof getModelPricingAdmission>>, stored?: ModelPricingActivation) {
    const current = stored || (await getModelPricingActivation(modelId));
    if (
        !current?.enabled ||
        current.bindings !== undefined ||
        !admission.legacyFingerprint ||
        current.fingerprint !== admission.legacyFingerprint ||
        current.officialVersionId !== admission.officialVersionId ||
        !admission.fingerprint ||
        !admission.salesVersionId
    )
        return current;
    const approved: NonNullable<ModelPricingActivation["bindings"]> = {};
    for (const binding of admission.bindings) {
        if (!binding.fingerprint || !binding.contractIds.length) return current;
        const shadow = await getModelPricingShadowEvidence(modelId, admission.officialVersionId!, binding.contractIds, binding.key.slice(0, binding.key.indexOf("/")));
        if (!shadow.ready || binding.contractIds.some((id) => shadow.receiptIds[id] !== current.evidence.shadowReceiptIds[id])) return current;
        approved[binding.key] = { fingerprint: binding.fingerprint, contractIds: binding.contractIds, shadowReceiptIds: shadow.receiptIds };
    }
    const next: ModelPricingActivation = {
        ...current,
        revision: randomUUID(),
        fingerprint: admission.fingerprint,
        salesVersionId: admission.salesVersionId,
        bindings: approved,
        changedAt: new Date().toISOString(),
        changedBy: "system:legacy-channel-upgrade",
    };
    try {
        await saveModelPricingActivation(next, current.revision);
        return next;
    } catch (error) {
        if (error instanceof PricingConflictError) return getModelPricingActivation(modelId);
        throw error;
    }
}

function samePricingChannelConfig(config: Parameters<typeof publicModelPricingMode>[2][number], current: SystemGenerationChannelConfig, capability: LogicalModelCapability) {
    if (
        config.apiSource !== current.apiSource ||
        config.baseUrl !== current.baseUrl ||
        config.apiKey !== current.apiKey ||
        config.apiFormat !== current.apiFormat ||
        config.channelId !== current.channelId ||
        config.logicalModel !== current.logicalModel ||
        config.model !== current.model ||
        !isDeepStrictEqual(config.capabilityProfile, current.capabilityProfile)
    )
        return false;
    if (capability !== "image") return isDeepStrictEqual(config.advancedConfig, current.advancedConfig);
    if (!config.advancedConfig || !current.advancedConfig) return config.advancedConfig === current.advancedConfig;
    return Object.entries(config.advancedConfig).every(([key, value]) => {
        const currentValue = current.advancedConfig?.[key as keyof typeof current.advancedConfig];
        const normalized = key === "protocol" && !currentValue ? "auto" : typeof value === "string" ? (typeof currentValue === "string" ? currentValue.trim() : "") : typeof value === "boolean" ? Boolean(currentValue) : currentValue;
        return isDeepStrictEqual(value, normalized);
    });
}
