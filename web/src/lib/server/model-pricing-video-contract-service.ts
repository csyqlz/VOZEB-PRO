import { getFreshAuthSettings } from "@/lib/auth/store";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { PricingInputError } from "@/lib/model-pricing";
import { getOfficialVersionsByIds } from "./model-pricing-store";
import { HAILUO_PRICE_MODELS, HAILUO_PRICE_TIERS, HAILUO_REQUEST_SOURCES, validateHailuoPriceContract, type HailuoPriceContract } from "./model-pricing-hailuo-contract";
import { validateVideoPriceContract } from "./model-pricing-video-contract";
import { listVideoPriceContracts, saveVideoPriceContract } from "./model-pricing-video-contract-store";
import { MINIMAX_VIDEO_PROFILES, MINIMAX_VIDEO_REQUEST_SOURCE, type MinimaxVideoModel } from "./model-pricing-video-request";
import { resolvePricingContractModel } from "./model-pricing-contract-model";

async function getVersion(id: string) {
    if (!id) throw new PricingInputError("请选择已审核官方价目");
    const version = (await getOfficialVersionsByIds([id]))[0];
    if (!version) throw new PricingInputError("已审核官方价目不存在");
    return version;
}

export async function getVideoPriceContractOptions(officialVersionId: string, logicalModelId?: string) {
    const version = await getVersion(officialVersionId);
    const settings = await getFreshAuthSettings();
    const { model } = await resolvePricingContractModel(settings, version, logicalModelId, ["generation"]);
    const profile = Object.hasOwn(MINIMAX_VIDEO_PROFILES, version.sku) ? MINIMAX_VIDEO_PROFILES[version.sku as MinimaxVideoModel] : undefined;
    const hailuo = (HAILUO_PRICE_MODELS as readonly string[]).includes(version.sku);
    const protocol = hailuo ? ("minimax-hailuo-v1" as const) : profile ? ("minimax-video-v2" as const) : null;
    const bindings =
        (profile || hailuo) && version.tier === "paid" && model?.enabled && model.capability === "video"
            ? model.bindings
                  .filter((binding) => binding.enabled && binding.upstreamModel === version.sku)
                  .flatMap((binding) => {
                      const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled);
                      const protocol = channel && (resolveChannelModelConfig(channel.advancedConfig, binding.upstreamModel)?.protocol || channel.advancedConfig?.protocol);
                      return channel && protocol === "minimax" ? [{ channelId: channel.id, channelName: channel.name, requestedModel: binding.upstreamModel as MinimaxVideoModel | HailuoPriceContract["requestedModel"] }] : [];
                  })
            : [];
    return { version, bindings, protocol, resolutions: profile?.resolutions || [], tiers: hailuo ? HAILUO_PRICE_TIERS : [], requestSourceUrl: hailuo ? HAILUO_REQUEST_SOURCES.image : MINIMAX_VIDEO_REQUEST_SOURCE };
}

export async function getVideoPriceContractHistory(officialVersionId: string, channelId: string, requestedModel: string) {
    if (!channelId || !requestedModel) throw new PricingInputError("请选择渠道和上游型号");
    const version = await getVersion(officialVersionId);
    return { version, contracts: await listVideoPriceContracts(officialVersionId, channelId, requestedModel) };
}

export async function reviewVideoPriceContract(officialVersionId: string, raw: unknown, expectedCurrentId: string | null, actorId: string, logicalModelId?: string) {
    const options = await getVideoPriceContractOptions(officialVersionId, logicalModelId);
    const contract = (options.protocol === "minimax-hailuo-v1" ? validateHailuoPriceContract : validateVideoPriceContract)(raw, options.version, actorId, new Date().toISOString());
    if (!options.bindings.some((binding) => binding.channelId === contract.channelId && binding.requestedModel === contract.requestedModel)) throw new PricingInputError("没有匹配已启用的视频逻辑模型、渠道、型号和协议绑定");
    return saveVideoPriceContract(contract, expectedCurrentId);
}
