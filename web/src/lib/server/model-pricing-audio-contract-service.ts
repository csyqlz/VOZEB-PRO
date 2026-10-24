import { getFreshAuthSettings } from "@/lib/auth/store";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { PricingInputError } from "@/lib/model-pricing";
import { getOfficialVersionsByIds } from "./model-pricing-store";
import { validateAudioPriceContract } from "./model-pricing-audio-contract";
import { listAudioPriceContracts, saveAudioPriceContract } from "./model-pricing-audio-contract-store";
import { validateOpenAiAudioPriceContract } from "./model-pricing-openai-audio-contract";
import { OPENAI_PRICED_AUDIO_MODEL, OPENAI_AUDIO_LIMIT_SOURCE } from "./model-pricing-openai-audio-request";
import { isGeminiTtsModel, type GeminiTtsModel } from "./model-pricing-audio-request";
import { resolvePricingContractModel } from "./model-pricing-contract-model";

type AudioContractBinding = { channelId: string; channelName: string } & ({ requestedModel: GeminiTtsModel; declaredProtocol: "gemini" | "dataeyes-gemini" } | { requestedModel: typeof OPENAI_PRICED_AUDIO_MODEL; declaredProtocol: "openai" });

async function getVersion(id: string) {
    if (!id) throw new PricingInputError("请选择已审核官方价目");
    const version = (await getOfficialVersionsByIds([id]))[0];
    if (!version) throw new PricingInputError("已审核官方价目不存在");
    return version;
}

export async function getAudioPriceContractOptions(officialVersionId: string, logicalModelId?: string) {
    const version = await getVersion(officialVersionId);
    const settings = await getFreshAuthSettings();
    const sku = version.sku;
    const { model } = await resolvePricingContractModel(settings, version, logicalModelId, [sku === OPENAI_PRICED_AUDIO_MODEL ? "chat/completions" : "generateContent"]);
    const bindings =
        (isGeminiTtsModel(sku) || sku === OPENAI_PRICED_AUDIO_MODEL) && version.tier === "paid" && model?.enabled && model.capability === "audio"
            ? model.bindings
                  .filter((binding) => binding.enabled && binding.upstreamModel === sku)
                  .flatMap<AudioContractBinding>((binding) => {
                      const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled);
                      const protocol = channel && (resolveChannelModelConfig(channel.advancedConfig, binding.upstreamModel)?.protocol || channel.advancedConfig?.protocol);
                      if (!channel) return [];
                      const publicBinding = { channelId: channel.id, channelName: channel.name };
                      if (isGeminiTtsModel(sku) && (protocol === "gemini" || protocol === "dataeyes-gemini")) return [{ ...publicBinding, requestedModel: sku, declaredProtocol: protocol }];
                      if (sku === OPENAI_PRICED_AUDIO_MODEL && protocol === "openai") return [{ ...publicBinding, requestedModel: sku, declaredProtocol: protocol }];
                      return [];
                  })
            : [];
    return { version, bindings, requestSourceUrl: sku === OPENAI_PRICED_AUDIO_MODEL ? OPENAI_AUDIO_LIMIT_SOURCE : isGeminiTtsModel(sku) ? `https://ai.google.dev/gemini-api/docs/models/${sku}` : undefined };
}

export async function getAudioPriceContractHistory(officialVersionId: string, channelId: string, requestedModel: string) {
    if (!channelId || !requestedModel) throw new PricingInputError("请选择渠道和上游型号");
    const version = await getVersion(officialVersionId);
    return { version, contracts: await listAudioPriceContracts(officialVersionId, channelId, requestedModel) };
}

export async function reviewAudioPriceContract(officialVersionId: string, raw: unknown, expectedCurrentId: string | null, actorId: string, logicalModelId?: string) {
    const options = await getAudioPriceContractOptions(officialVersionId, logicalModelId);
    const validate = options.version.sku === OPENAI_PRICED_AUDIO_MODEL ? validateOpenAiAudioPriceContract : validateAudioPriceContract;
    const contract = validate(raw, options.version, actorId, new Date().toISOString());
    if (!options.bindings.some((binding) => binding.channelId === contract.channelId && binding.requestedModel === contract.requestedModel && binding.declaredProtocol === contract.declaredProtocol))
        throw new PricingInputError("没有匹配已启用的音频逻辑模型、渠道、型号和协议绑定");
    return saveAudioPriceContract(contract, expectedCurrentId);
}
