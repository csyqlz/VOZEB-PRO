import type { AuthSettings } from "@/lib/auth/store";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import type { SalesVersion } from "@/lib/model-pricing";
import { activationKey, getModelPricingActivations } from "./model-pricing-activation-store";
import { admissionKey, getModelPricingAdmission, type ModelPricingAdmissionReadContext } from "./model-pricing-admission";
import { listCurrentAudioPriceContracts } from "./model-pricing-audio-contract-store";
import { listCurrentImagePriceContracts } from "./model-pricing-image-contract-store";
import { getLatestOfficialVersionsForModels, getOfficialVersionsByIds } from "./model-pricing-store";
import { getCurrentTextUsageRules, getTextUsageRulesByIds } from "./model-pricing-text-usage-rule-store";
import { listCurrentFlatTextPriceContracts } from "./model-pricing-token-contract-store";
import { listCurrentVideoPriceContracts } from "./model-pricing-video-contract-store";
import { getCurrentModelPriceBindings } from "./model-price-binding-store";

export type ModelPricingBatchState = {
    billingMode: "disabled" | "fixed" | "metered" | "paused" | "review-needed";
    billingBindingSlots: number;
    qualifiedBindings: number;
    activeBindings: number;
    pendingBindings: number | null;
    blocker: string | null;
};

/** Uses only batched reads; never upgrades a legacy activation while rendering a list. */
export async function getModelPricingBatchStates(modelIds: string[], settings: AuthSettings, policy: SalesVersion | undefined): Promise<Map<string, ModelPricingBatchState>> {
    const result = new Map<string, ModelPricingBatchState>();
    if (!modelIds.length) return result;
    const uniqueIds = [...new Set(modelIds)];
    const modelsById = new Map(settings.logicalModels.map((model) => [model.id, model]));
    const selectedText = (policy?.selectedPriceBindings || []).filter((item) => uniqueIds.includes(item.logicalModelId) && item.scope === "text:generation:standard");
    const selectedVideo = (policy?.selectedPriceBindings || []).filter((item) => uniqueIds.includes(item.logicalModelId) && item.scope === "video:generation:standard");
    const imageIds = uniqueIds.filter((id) => modelsById.get(id)?.capability === "image");
    const audioIds = uniqueIds.filter((id) => modelsById.get(id)?.capability === "audio");
    const imageOperations = ["generations", "edits"] as const;
    const audioOperations = ["generateContent", "chat/completions"] as const;
    const selectedImage = (policy?.selectedPriceBindings || []).filter((item) => imageIds.includes(item.logicalModelId) && imageOperations.some((operation) => item.scope === `image:${operation}:standard`));
    const selectedAudio = (policy?.selectedPriceBindings || []).filter((item) => audioIds.includes(item.logicalModelId) && audioOperations.some((operation) => item.scope === `audio:${operation}:standard`));
    const versionIds = [
        ...new Set(
            [
                ...uniqueIds.map((id) => policy?.priceVersionIds[id]),
                ...selectedText.map((item) => item.officialVersionId),
                ...selectedVideo.map((item) => item.officialVersionId),
                ...selectedImage.map((item) => item.officialVersionId),
                ...selectedAudio.map((item) => item.officialVersionId),
            ].filter((id): id is string => Boolean(id)),
        ),
    ];
    const activationKeys = [
        ...uniqueIds,
        ...imageIds.flatMap((id) => imageOperations.map((operation) => activationKey(id, `image:${operation}:standard`))),
        ...audioIds.flatMap((id) => audioOperations.map((operation) => activationKey(id, `audio:${operation}:standard`))),
    ];
    const [versions, latestVersions, activations, currentRules, textContracts, imageContracts, videoContracts, audioContracts, textPriceBindings, videoPriceBindings, imageGenerationBindings, imageEditBindings, audioGeminiBindings, audioOpenAiBindings] =
        await Promise.all([
            getOfficialVersionsByIds(versionIds),
            getLatestOfficialVersionsForModels(uniqueIds),
            getModelPricingActivations(activationKeys),
            getCurrentTextUsageRules(versionIds),
            listCurrentFlatTextPriceContracts(versionIds),
            listCurrentImagePriceContracts(versionIds),
            listCurrentVideoPriceContracts(versionIds),
            listCurrentAudioPriceContracts(versionIds),
            getCurrentModelPriceBindings(
                selectedText.map((item) => item.logicalModelId),
                "text:generation:standard",
            ),
            getCurrentModelPriceBindings(
                selectedVideo.map((item) => item.logicalModelId),
                "video:generation:standard",
            ),
            getCurrentModelPriceBindings(
                selectedImage.filter((item) => item.scope === "image:generations:standard").map((item) => item.logicalModelId),
                "image:generations:standard",
            ),
            getCurrentModelPriceBindings(
                selectedImage.filter((item) => item.scope === "image:edits:standard").map((item) => item.logicalModelId),
                "image:edits:standard",
            ),
            getCurrentModelPriceBindings(
                selectedAudio.filter((item) => item.scope === "audio:generateContent:standard").map((item) => item.logicalModelId),
                "audio:generateContent:standard",
            ),
            getCurrentModelPriceBindings(
                selectedAudio.filter((item) => item.scope === "audio:chat/completions:standard").map((item) => item.logicalModelId),
                "audio:chat/completions:standard",
            ),
        ]);
    const frozenRuleIds = [...new Set([...activations.values()].map((activation) => (activation.enabled ? activation.textUsageRuleId : undefined)).filter((id): id is string => Boolean(id)))];
    const rulesById = await getTextUsageRulesByIds(frozenRuleIds);
    const byKey = <T extends { officialVersionId: string; channelId: string; requestedModel: string }>(contracts: T[], includeOperation = false) =>
        new Map(contracts.map((contract) => [admissionKey(contract.officialVersionId, contract.channelId, contract.requestedModel, ...(includeOperation && "operation" in contract ? [String(contract.operation)] : [])), contract]));
    const read: ModelPricingAdmissionReadContext = {
        settings,
        policy,
        versionsById: new Map(versions.map((version) => [version.id, version])),
        latestVersions,
        priceBindings: new Map([
            ...[...textPriceBindings, ...videoPriceBindings].map((binding) => [binding.logicalModelId, binding] as const),
            ...[...imageGenerationBindings, ...imageEditBindings, ...audioGeminiBindings, ...audioOpenAiBindings].map((binding) => [admissionKey(binding.logicalModelId, binding.scope), binding] as const),
        ]),
        currentTextRules: new Map([...currentRules.values()].map((rule) => [admissionKey(rule.modelId, rule.officialVersionId), rule])),
        rulesById,
        contracts: { text: byKey(textContracts), image: byKey(imageContracts, true), video: byKey(videoContracts), audio: byKey(audioContracts) },
    };
    for (const modelId of uniqueIds) {
        const model = modelsById.get(modelId);
        if (!model) continue;
        const enabledBindings = model.bindings.filter((binding) => binding.enabled).length;
        const scopedImage = model.capability === "image" && (selectedImage.some((item) => item.logicalModelId === modelId) || imageOperations.some((operation) => activations.has(activationKey(modelId, `image:${operation}:standard`))));
        if (scopedImage) {
            const modelActivation = policy?.priceVersionIds[modelId] ? activations.get(modelId) : undefined;
            const scopes = imageOperations.filter(
                (operation) => modelActivation?.enabled || selectedImage.some((item) => item.logicalModelId === modelId && item.scope === `image:${operation}:standard`) || activations.has(activationKey(modelId, `image:${operation}:standard`)),
            );
            const operations = await Promise.all(
                scopes.map(async (operation) => {
                    const scopedActivation = activations.get(activationKey(modelId, `image:${operation}:standard`));
                    const activation = scopedActivation || modelActivation;
                    const fallback = !scopedActivation && Boolean(modelActivation?.enabled);
                    const admission = await getModelPricingAdmission(modelId, undefined, read, fallback ? undefined : operation);
                    const activeAdmission = fallback && activation?.bindings ? await getModelPricingAdmission(modelId, activation.textUsageRuleId || null, read, undefined, undefined, true) : admission;
                    const activeKeys =
                        activation?.enabled && activation.fingerprint === activeAdmission.fingerprint && activation.officialVersionId === activeAdmission.officialVersionId
                            ? activeAdmission.bindings.filter((binding) => binding.fingerprint && activation.bindings?.[binding.key]?.fingerprint === binding.fingerprint).map((binding) => binding.key)
                            : [];
                    const qualified = new Set([...admission.bindings.filter((binding) => binding.fingerprint).map((binding) => binding.key), ...activeKeys]).size;
                    return { operation, admission, activation, active: activeKeys.length, qualified };
                }),
            );
            const activeBindings = operations.reduce((count, item) => count + item.active, 0);
            const qualifiedBindings = operations.reduce((count, item) => count + item.qualified, 0);
            const enabled = operations.some((item) => item.activation?.enabled) || Boolean(activations.get(modelId)?.enabled);
            const firstBlocker = operations.flatMap((item) => item.admission.blockers.map((reason) => `${item.operation === "generations" ? "图片生成" : "图片编辑"}：${reason}`))[0];
            const slots = enabledBindings * scopes.length;
            result.set(modelId, {
                billingMode: model.enabled === false ? "disabled" : activeBindings ? "metered" : enabled ? "paused" : "fixed",
                billingBindingSlots: slots,
                qualifiedBindings,
                activeBindings,
                pendingBindings: model.enabled === false ? null : slots - activeBindings,
                blocker: activeBindings
                    ? activeBindings < slots
                        ? firstBlocker || "仅部分图片操作或渠道已启用按量"
                        : null
                    : activations.get(modelId)?.enabled
                      ? "旧模型级图片激活需在详情中复核或关闭"
                      : firstBlocker || (enabled ? "已启用的图片操作与当前价目或契约不一致" : "图片操作尚无已发布且可用的独立选价"),
            });
            continue;
        }
        const scopedAudio =
            model.capability === "audio" &&
            !policy?.priceVersionIds[modelId] &&
            (selectedAudio.some((item) => item.logicalModelId === modelId) || audioOperations.some((operation) => activations.has(activationKey(modelId, `audio:${operation}:standard`))));
        if (scopedAudio) {
            const scopes = audioOperations.filter((operation) => selectedAudio.some((item) => item.logicalModelId === modelId && item.scope === `audio:${operation}:standard`) || activations.has(activationKey(modelId, `audio:${operation}:standard`)));
            const operations = await Promise.all(
                scopes.map(async (operation) => {
                    const admission = await getModelPricingAdmission(modelId, undefined, read, undefined, operation);
                    const activation = activations.get(activationKey(modelId, `audio:${operation}:standard`));
                    const active =
                        activation?.enabled && activation.fingerprint === admission.fingerprint && activation.officialVersionId === admission.officialVersionId
                            ? admission.bindings.filter((binding) => binding.fingerprint && activation.bindings?.[binding.key]?.fingerprint === binding.fingerprint).length
                            : 0;
                    return { operation, admission, activation, active };
                }),
            );
            const activeBindings = operations.reduce((count, item) => count + item.active, 0);
            const qualifiedBindings = operations.reduce((count, item) => count + item.admission.bindings.filter((binding) => Boolean(binding.fingerprint)).length, 0);
            const enabled = operations.some((item) => item.activation?.enabled) || Boolean(activations.get(modelId)?.enabled);
            const firstBlocker = operations.flatMap((item) => item.admission.blockers.map((reason) => `${item.operation === "generateContent" ? "Gemini 音频生成" : "OpenAI 原生音频"}：${reason}`))[0];
            const slots = scopes.reduce(
                (count, operation) =>
                    count +
                    model.bindings.filter((binding) => {
                        if (!binding.enabled) return false;
                        const channel = settings.systemChannels.find((item) => item.id === binding.channelId);
                        const protocol = channel && (resolveChannelModelConfig(channel.advancedConfig, binding.upstreamModel)?.protocol || channel.advancedConfig?.protocol);
                        return operation === "chat/completions" ? protocol === "openai" : protocol === "gemini" || protocol === "dataeyes-gemini";
                    }).length,
                0,
            );
            result.set(modelId, {
                billingMode: model.enabled === false ? "disabled" : activeBindings ? "metered" : enabled ? "paused" : "fixed",
                billingBindingSlots: slots,
                qualifiedBindings,
                activeBindings,
                pendingBindings: model.enabled === false ? null : slots - activeBindings,
                blocker: activeBindings
                    ? activeBindings < slots
                        ? firstBlocker || "仅部分音频操作或渠道已启用按量"
                        : null
                    : activations.get(modelId)?.enabled
                      ? "旧模型级音频激活需在详情中复核或关闭"
                      : firstBlocker || (enabled ? "已启用的音频操作与当前价目或契约不一致" : "音频操作尚无已发布且可用的独立选价"),
            });
            continue;
        }
        const admission = await getModelPricingAdmission(modelId, undefined, read);
        const activation = activations.get(modelId);
        const legacy = Boolean(activation?.enabled && activation.bindings === undefined);
        const activeAdmission =
            activation?.enabled && (activation.textUsageRuleId !== admission.textUsageRuleId || Boolean(activation.bindings))
                ? await getModelPricingAdmission(modelId, activation.textUsageRuleId || null, read, undefined, undefined, Boolean(activation.bindings))
                : admission;
        const activeKeys =
            !legacy && activation?.enabled && activation.fingerprint === activeAdmission.fingerprint && activation.officialVersionId === activeAdmission.officialVersionId
                ? activeAdmission.bindings.filter((binding) => binding.fingerprint && activation.bindings?.[binding.key]?.fingerprint === binding.fingerprint).map((binding) => binding.key)
                : [];
        const activeBindings = activeKeys.length;
        const qualifiedBindings = new Set([...admission.bindings.filter((binding) => binding.fingerprint).map((binding) => binding.key), ...activeKeys]).size;
        result.set(modelId, {
            billingMode: model.enabled === false ? "disabled" : legacy ? "review-needed" : activeBindings ? "metered" : activation?.enabled ? "paused" : "fixed",
            billingBindingSlots: enabledBindings,
            qualifiedBindings,
            activeBindings,
            pendingBindings: model.enabled === false || legacy ? null : enabledBindings - activeBindings,
            blocker: legacy
                ? "旧激活记录需在单模型详情核对"
                : !admission.reviewedOfficialVersionId
                  ? "缺少该模型已审核的官方价版本"
                  : !admission.officialVersionId
                    ? "缺少已发布且绑定该模型官方价的用户售价"
                    : activeBindings === enabledBindings && activeBindings > 0
                      ? null
                      : activation?.enabled && activeAdmission.fingerprint && activation.fingerprint === activeAdmission.fingerprint && !activeBindings
                        ? "已启用的渠道与当前价目或契约不一致"
                        : admission.blockers[0] || (activation?.enabled && !activeBindings ? "已启用的渠道与当前价目或契约不一致" : null),
        });
    }
    return result;
}
