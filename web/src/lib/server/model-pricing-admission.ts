import { createHash } from "node:crypto";
import { getFreshAuthSettings, type AuthSettings } from "@/lib/auth/store";
import { channelConnectionReady, resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { currentChannelModels } from "@/lib/channel-model-availability";
import { assertRegularPaidPriceItems, officialItemsForTextPriceGroup, PricingInputError, type ModelPriceBinding, type OfficialPriceVersion, type SalesVersion, type TextUsageRule } from "@/lib/model-pricing";
import { channelSupportsModel } from "./generation-channel";
import { validateAudioPriceContract } from "./model-pricing-audio-contract";
import { listAudioPriceContracts } from "./model-pricing-audio-contract-store";
import { validateHailuoPriceContract } from "./model-pricing-hailuo-contract";
import { validateImagePriceContract, supportsDirectImageTokenContract, supportsImageCountContract } from "./model-pricing-image-contract";
import { listImagePriceContracts } from "./model-pricing-image-contract-store";
import { validateOpenAiAudioPriceContract } from "./model-pricing-openai-audio-contract";
import { getCurrentSalesVersion, getLatestOfficialVersionForModel, getOfficialVersionsByIds } from "./model-pricing-store";
import { validateFlatTextPriceContract } from "./model-pricing-token-contract";
import { listFlatTextPriceContracts } from "./model-pricing-token-contract-store";
import { validateVideoPriceContract } from "./model-pricing-video-contract";
import { listVideoPriceContracts } from "./model-pricing-video-contract-store";
import { resolveTextProtocol } from "./text-protocol-resolver";
import { modelPricingEffectiveTerms } from "./model-pricing-effective-terms";
import { getLatestTextUsageRule, getTextUsageRuleById } from "./model-pricing-text-usage-rule-store";
import { publishedSelectionMatchesModel, resolvePublishedModelPrice } from "./model-pricing-published-price";

/** Static prerequisites. Real responses are checked through priced shadow calls before activation. */
export const admissionKey = (...parts: string[]) => JSON.stringify(parts);

export type ModelPricingAdmissionReadContext = {
    settings: AuthSettings;
    policy: SalesVersion | undefined;
    versionsById: Map<string, OfficialPriceVersion>;
    latestVersions: Map<string, OfficialPriceVersion>;
    priceBindings?: Map<string, ModelPriceBinding>;
    currentTextRules: Map<string, TextUsageRule>;
    rulesById: Map<string, TextUsageRule>;
    contracts: {
        text: Map<string, Awaited<ReturnType<typeof listFlatTextPriceContracts>>[number]>;
        image: Map<string, Awaited<ReturnType<typeof listImagePriceContracts>>[number]>;
        video: Map<string, Awaited<ReturnType<typeof listVideoPriceContracts>>[number]>;
        audio: Map<string, Awaited<ReturnType<typeof listAudioPriceContracts>>[number]>;
    };
};

export async function getModelPricingAdmission(
    modelId: string,
    ruleId?: string | null,
    read?: ModelPricingAdmissionReadContext,
    imageOperation?: "generations" | "edits",
    audioOperation?: "generateContent" | "chat/completions",
    preserveLegacyReservation = false,
) {
    if (!modelId.trim()) throw new PricingInputError("请选择逻辑模型");
    const settings = read?.settings || (await getFreshAuthSettings());
    const model = settings.logicalModels.find((item) => item.id === modelId);
    if (!model) throw new PricingInputError("逻辑模型不存在");
    if (imageOperation && model.capability !== "image") throw new PricingInputError("图片计价操作与逻辑模型能力不一致");
    if (audioOperation && model.capability !== "audio") throw new PricingInputError("音频计价操作与逻辑模型能力不一致");
    const globalBlockers: string[] = [];
    const bindingResults: Array<{ key: string; channelName: string; fingerprint: string | null; contractIds: string[]; operationContracts: Array<{ operation: "generations" | "edits"; id?: string }>; blockers: string[] }> = [];
    const now = Date.now();
    const reviewedNow = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;
    if (!model.enabled) globalBlockers.push("逻辑模型未启用");
    const bindings = model.bindings.filter((item) => item.enabled);
    if (!bindings.length) globalBlockers.push("逻辑模型没有启用的渠道绑定");
    const policy = read ? read.policy : await getCurrentSalesVersion();
    const selectedCapability = imageOperation ? "image" : audioOperation ? "audio" : model.capability === "video" ? "video" : "text";
    const selectedOperation = imageOperation || audioOperation || "generation";
    const selection =
        model.capability === "text" || model.capability === "video" || imageOperation || audioOperation
            ? policy?.selectedPriceBindings?.find((item) => item.logicalModelId === model.id && item.scope === `${selectedCapability}:${selectedOperation}:standard`)
            : undefined;
    const conflictingPublishedPrice = Boolean(policy?.priceVersionIds[model.id] && policy.selectedPriceBindings?.some((item) => item.logicalModelId === model.id));
    if (conflictingPublishedPrice) globalBlockers.push("同一模型的销售版本同时含旧式映射和独立选价，请重新发布");
    const versionId = conflictingPublishedPrice ? undefined : policy?.priceVersionIds[model.id] || selection?.officialVersionId;
    const candidateVersion = versionId ? (read ? read.versionsById.get(versionId) : (await getOfficialVersionsByIds([versionId])).find((item) => item.id === versionId)) : undefined;
    const version =
        selection && !policy?.priceVersionIds[model.id]
            ? read
                ? candidateVersion &&
                  publishedSelectionMatchesModel(
                      model.id,
                      selectedCapability,
                      selectedOperation,
                      candidateVersion,
                      selection,
                      read.priceBindings?.get(admissionKey(model.id, selection.scope)) || (!imageOperation && !audioOperation ? read.priceBindings?.get(model.id) : undefined),
                      settings,
                  )
                    ? candidateVersion
                    : undefined
                : (await resolvePublishedModelPrice(model.id, selectedCapability, selectedOperation, policy, settings))?.version
            : candidateVersion;
    const legacyReservation = preserveLegacyReservation && Boolean(policy?.priceVersionIds[model.id] && !selection && version?.logicalModelId === model.id);
    const currentVersion = version;
    const reviewedVersion = currentVersion || (read ? read.latestVersions.get(model.id) : await getLatestOfficialVersionForModel(model.id));
    const textUsageRule =
        model.capability === "text" && currentVersion
            ? ruleId === undefined
                ? read
                    ? read.currentTextRules.get(admissionKey(model.id, currentVersion.id))
                    : await getLatestTextUsageRule(model.id, currentVersion.id)
                : ruleId
                  ? read
                      ? read.rulesById.get(ruleId)
                      : await getTextUsageRuleById(ruleId)
                  : undefined
            : undefined;
    if (ruleId && (!textUsageRule || textUsageRule.modelId !== model.id || textUsageRule.officialVersionId !== currentVersion?.id)) globalBlockers.push("文本缓存缺失规则与当前模型价目不一致");
    if (!reviewedVersion) globalBlockers.push("缺少该模型已审核的官方价版本");
    if (!policy?.publishedBy?.trim() || !reviewedNow(policy.publishedAt) || !currentVersion) globalBlockers.push("缺少已发布且绑定该模型官方价的用户售价");
    if (currentVersion) {
        const version = currentVersion;
        const priceItems = version.textPriceSchedule ? version.textPriceSchedule.groups.filter((group) => group.selector.processingMode === "standard").flatMap(officialItemsForTextPriceGroup) : version.items;
        if (version.tier !== "paid" || !version.reviewedBy?.trim() || !reviewedNow(version.publishedAt) || !priceItems.length) globalBlockers.push("官方价尚无有效的已审核常规付费分项");
        else
            try {
                assertRegularPaidPriceItems(model.capability === "video" && ["MiniMax-H3", "MiniMax-H3-Max"].includes(version.sku) ? priceItems.filter((item) => item.key !== "inputAudioSeconds") : priceItems);
            } catch (error) {
                if (!(error instanceof PricingInputError)) throw error;
                globalBlockers.push(error.message);
            }
        if (
            (version.effectiveFrom && (!Number.isFinite(Date.parse(version.effectiveFrom)) || Date.parse(version.effectiveFrom) > now)) ||
            (version.effectiveTo && (!Number.isFinite(Date.parse(version.effectiveTo)) || Date.parse(version.effectiveTo) <= now))
        )
            globalBlockers.push("官方价不在当前有效期内");
    }
    if (currentVersion)
        for (const binding of bindings) {
            const version = currentVersion;
            const label = `${binding.channelId}/${binding.upstreamModel}`;
            const bindingBlockers: string[] = [];
            const contractIds: string[] = [];
            const channel = settings.systemChannels.find((item) => item.id === binding.channelId);
            const channelName = channel?.name || binding.channelId;
            const operationContracts: Array<{ operation: "generations" | "edits"; id?: string }> = [];
            if (!channel?.enabled || !channelConnectionReady(channel) || !channelSupportsModel(currentChannelModels(channel), binding.upstreamModel)) {
                bindingResults.push({ key: label, channelName, fingerprint: null, contractIds, operationContracts, blockers: ["渠道未就绪或未配置该上游型号"] });
                continue;
            }
            if (binding.upstreamModel !== version.sku && (!["text", "image"].includes(model.capability) || Boolean(version.logicalModelId))) {
                bindingResults.push({ key: label, channelName, fingerprint: null, contractIds, operationContracts, blockers: ["与已审核官方 SKU 不完全相同，需核对独立价目"] });
                continue;
            }
            const declaredProtocol = resolveChannelModelConfig(channel.advancedConfig, binding.upstreamModel)?.protocol || channel.advancedConfig?.protocol;
            try {
                if (model.capability === "text") {
                    const resolved = resolveTextProtocol({ model: binding.upstreamModel, apiFormat: channel.apiFormat, advancedConfig: channel.advancedConfig, throughSystemProxy: true });
                    if (resolved.kind === "custom" || resolved.providerKind !== resolved.kind) throw new PricingInputError("文本协议有转换或自定义映射，尚无按量准入证据");
                    const expected = { chat: "openai-chat", responses: "openai-responses", gemini: "gemini-generate", claude: "anthropic-messages" }[resolved.kind];
                    const contract = read
                        ? read.contracts.text.get(admissionKey(version.id, binding.channelId, binding.upstreamModel))
                        : (await listFlatTextPriceContracts(version.id, binding.channelId, binding.upstreamModel)).find((item) => item.current);
                    if (!contract || contract.officialVersionId !== version.id || contract.protocol !== expected || !contract.requestLimits || !contract.reviewedBy?.trim() || !reviewedNow(contract.reviewedAt))
                        throw new PricingInputError("缺少当前协议、请求上界及渠道的文本计费契约");
                    if (binding.upstreamModel !== version.sku && contract.identity && contract.identity.channelBindingId !== binding.id) throw new PricingInputError("渠道别名与当前绑定的已审核型号身份不一致");
                    validateFlatTextPriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
                    if (!contract.reservationEstimate && !legacyReservation) throw new PricingInputError("文本契约缺少已审核的独立预留估算");
                    contractIds.push(contract.id);
                } else if (model.capability === "image") {
                    if (channel.apiFormat !== "openai") throw new PricingInputError("图片渠道不是已核实的直接 Images 协议");
                    const operations = imageOperation
                        ? ([imageOperation] as const)
                        : supportsImageCountContract(declaredProtocol, binding.upstreamModel, "generations") && !supportsImageCountContract(declaredProtocol, binding.upstreamModel, "edits")
                          ? (["generations"] as const)
                          : (["generations", "edits"] as const);
                    for (const operation of operations) {
                        const contract = read
                            ? read.contracts.image.get(admissionKey(version.id, binding.channelId, binding.upstreamModel, operation))
                            : (await listImagePriceContracts(version.id, binding.channelId, binding.upstreamModel, operation)).find((item) => item.current);
                        try {
                            if (!contract || contract.officialVersionId !== version.id || !contract.reviewedBy?.trim() || !reviewedNow(contract.reviewedAt)) throw new PricingInputError(`${operation} 缺少当前图片计费契约`);
                            validateImagePriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
                            if (binding.upstreamModel !== version.sku && contract.identity?.channelBindingId !== binding.id) throw new PricingInputError("图片渠道别名与当前绑定的已审核型号身份不一致");
                            if (contract.scope === "global-standard-direct-image-tokens" && !contract.holdEstimates?.length && !contract.holdEstimate && !legacyReservation) throw new PricingInputError("图片 Token 契约缺少已审核的独立预留估算");
                            if (contract.scope === "global-standard-dataeyes-flux-image" && !supportsImageCountContract(declaredProtocol, binding.upstreamModel, operation)) throw new PricingInputError("按张契约与当前渠道协议不匹配");
                            if (contract.scope === "global-standard-direct-image-tokens" && !supportsDirectImageTokenContract(declaredProtocol)) throw new PricingInputError("图片 Token 契约与当前渠道协议不匹配");
                            contractIds.push(contract.id);
                            operationContracts.push({ operation, id: contract.id });
                        } catch (error) {
                            if (!(error instanceof PricingInputError)) throw error;
                            operationContracts.push({ operation });
                            bindingBlockers.push(error.message);
                        }
                    }
                } else if (model.capability === "video") {
                    if (declaredProtocol !== "minimax") throw new PricingInputError("视频渠道协议尚无按量契约");
                    const contract = read ? read.contracts.video.get(admissionKey(version.id, binding.channelId, binding.upstreamModel)) : (await listVideoPriceContracts(version.id, binding.channelId, binding.upstreamModel)).find((item) => item.current);
                    if (!contract || contract.officialVersionId !== version.id || !contract.reviewedBy?.trim() || !reviewedNow(contract.reviewedAt)) throw new PricingInputError("缺少当前视频计费契约");
                    if (contract.protocol === "minimax-hailuo-v1") validateHailuoPriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
                    else validateVideoPriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
                    contractIds.push(contract.id);
                } else {
                    const contract = read ? read.contracts.audio.get(admissionKey(version.id, binding.channelId, binding.upstreamModel)) : (await listAudioPriceContracts(version.id, binding.channelId, binding.upstreamModel)).find((item) => item.current);
                    if (!contract || contract.officialVersionId !== version.id || contract.declaredProtocol !== declaredProtocol || !contract.reviewedBy?.trim() || !reviewedNow(contract.reviewedAt))
                        throw new PricingInputError("缺少当前协议与渠道的音频计费契约");
                    if (audioOperation && contract.protocol !== (audioOperation === "chat/completions" ? "openai-chat-audio" : "gemini-tts")) throw new PricingInputError("音频操作与当前协议契约不一致");
                    if (contract.protocol === "openai-chat-audio") validateOpenAiAudioPriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
                    else validateAudioPriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
                    contractIds.push(contract.id);
                }
            } catch (error) {
                if (!(error instanceof PricingInputError)) throw error;
                bindingBlockers.push(error.message);
            }
            const fingerprint =
                bindingBlockers.length || globalBlockers.length || !policy
                    ? null
                    : createHash("sha256")
                          .update(
                              JSON.stringify({
                                  capability: model.capability,
                                  ...(imageOperation ? { imageOperation } : {}),
                                  ...(audioOperation ? { audioOperation } : {}),
                                  salesTerms: modelPricingEffectiveTerms(version, policy, model.id),
                                  officialVersionId: version.id,
                                  ...(selection ? { priceSelection: selection } : {}),
                                  ...(textUsageRule ? { textUsageRuleId: textUsageRule.id } : {}),
                                  contracts: contractIds.sort(),
                                  binding: { ...binding, acceptanceOnly: undefined },
                                  baseUrl: channel.baseUrl,
                                  apiKey: channel.apiKey,
                                  apiFormat: channel.apiFormat,
                                  advancedConfig: channel.advancedConfig,
                              }),
                          )
                          .digest("hex");
            bindingResults.push({ key: label, channelName, fingerprint, contractIds: contractIds.sort(), operationContracts, blockers: bindingBlockers });
        }
    const fingerprint =
        globalBlockers.length || !currentVersion || !policy
            ? null
            : createHash("sha256")
                  .update(
                      JSON.stringify({
                          capability: model.capability,
                          ...(imageOperation ? { imageOperation } : {}),
                          ...(audioOperation ? { audioOperation } : {}),
                          salesTerms: modelPricingEffectiveTerms(currentVersion, policy, model.id),
                          officialVersionId: currentVersion.id,
                          ...(selection ? { priceSelection: selection } : {}),
                          ...(textUsageRule ? { textUsageRuleId: textUsageRule.id } : {}),
                      }),
                  )
                  .digest("hex");
    const legacyFingerprint =
        globalBlockers.length || bindingResults.some((result) => result.blockers.length) || !currentVersion || !policy
            ? null
            : createHash("sha256")
                  .update(
                      JSON.stringify({
                          capability: model.capability,
                          ...(imageOperation ? { imageOperation } : {}),
                          ...(audioOperation ? { audioOperation } : {}),
                          salesTerms: modelPricingEffectiveTerms(currentVersion, policy, model.id),
                          officialVersionId: currentVersion.id,
                          ...(selection ? { priceSelection: selection } : {}),
                          contracts: bindingResults.flatMap((result) => result.contractIds).sort(),
                          bindings: bindings.map((binding) => {
                              const channel = settings.systemChannels.find((item) => item.id === binding.channelId)!;
                              return { binding: { ...binding, acceptanceOnly: undefined }, baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat, advancedConfig: channel.advancedConfig };
                          }),
                      }),
                  )
                  .digest("hex");
    const blockers = [...globalBlockers, ...bindingResults.flatMap((result) => result.blockers.map((reason) => `${result.key}：${reason}`))];
    const readyBindings = bindingResults.filter((result) => result.fingerprint);
    return {
        modelId,
        capability: model.capability,
        ...(imageOperation ? { imageOperation } : {}),
        ...(audioOperation ? { audioOperation } : {}),
        bindingKeys: bindings.map((item) => `${item.channelId}/${item.upstreamModel}`).sort(),
        salesVersionId: policy?.id || null,
        contractIds: readyBindings.flatMap((result) => result.contractIds).sort(),
        officialVersionId: currentVersion?.id || null,
        textUsageRuleId: textUsageRule?.id || null,
        reviewedOfficialVersionId: reviewedVersion?.id || null,
        structuralComplete: globalBlockers.length === 0 && readyBindings.length > 0,
        fingerprint,
        legacyFingerprint,
        blockers,
        bindings: bindingResults,
        requiresShadowQuote: true,
        billingMode: "fixed-points" as const,
    };
}
