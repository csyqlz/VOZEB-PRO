import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { PricingInputError } from "@/lib/model-pricing";
import { getOfficialVersionsByIds } from "./model-pricing-store";
import { IMAGE_TOKEN_METERS, supportsDirectImageTokenContract, supportsImageCountContract, validateImagePriceContract, type ImagePriceContract } from "./model-pricing-image-contract";
import { listImagePriceContracts, saveImagePriceContract } from "./model-pricing-image-contract-store";
import { resolvePricingContractModel } from "./model-pricing-contract-model";

async function getVersion(id: string) {
    if (!id) throw new PricingInputError("请选择已审核官方价目");
    const version = (await getOfficialVersionsByIds([id]))[0];
    if (!version) throw new PricingInputError("已审核官方价目不存在");
    return version;
}

export async function getImagePriceContractOptions(officialVersionId: string, logicalModelId?: string) {
    const version = await getVersion(officialVersionId);
    const settings = await getFreshAuthSettings();
    const { model, operations } = await resolvePricingContractModel(settings, version, logicalModelId, ["generations", "edits"]);
    const bindings =
        model?.enabled && model.capability === "image"
            ? model.bindings
                  .filter((binding) => binding.enabled)
                  .flatMap((binding) => {
                      const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled);
                      const protocol = channel && (resolveChannelModelConfig(channel.advancedConfig, binding.upstreamModel)?.protocol || channel.advancedConfig?.protocol);
                      const alias = !version.logicalModelId && binding.upstreamModel !== version.sku;
                      return channel && (!alias || (binding.id && version.items.every((item) => item.unit.trim().toLowerCase() === "token") && channel.apiFormat === "openai" && supportsDirectImageTokenContract(protocol)))
                          ? [
                                {
                                    channelBindingId: binding.id,
                                    channelId: channel.id,
                                    channelName: channel.name,
                                    requestedModel: binding.upstreamModel,
                                    selectedOperations: operations,
                                    imageCountOperations: ["generations", "edits"].filter((operation) => operations.includes(operation as "generations" | "edits") && supportsImageCountContract(protocol, binding.upstreamModel, operation)),
                                },
                            ]
                          : [];
                  })
            : [];
    return { version, bindings, meters: IMAGE_TOKEN_METERS };
}

export async function getImagePriceContractHistory(officialVersionId: string, channelId: string, requestedModel: string, operation: string) {
    if (!channelId || !requestedModel || (operation !== "generations" && operation !== "edits")) throw new PricingInputError("请选择渠道、上游型号和图片操作");
    const version = await getVersion(officialVersionId);
    return { version, contracts: await listImagePriceContracts(officialVersionId, channelId, requestedModel, operation) };
}

export async function reviewImagePriceContract(officialVersionId: string, raw: unknown, expectedCurrentId: string | null, actorId: string, logicalModelId?: string) {
    const version = await getVersion(officialVersionId);
    const contract: ImagePriceContract = validateImagePriceContract(raw, version, actorId, new Date().toISOString());
    if (contract.scope === "global-standard-direct-image-tokens" && !contract.holdEstimates?.length) throw new PricingInputError("请先审核图片渠道、操作及画质的请求尺寸估算基准");
    const settings = await getFreshAuthSettings();
    const { model } = await resolvePricingContractModel(settings, version, logicalModelId, [contract.operation]);
    if (!model?.enabled || model.capability !== "image") throw new PricingInputError("官方价目未绑定已启用的图片逻辑模型");
    const channel = settings.systemChannels.find((item) => item.id === contract.channelId);
    const binding = model.bindings.find((item) => item.enabled && item.channelId === channel?.id && item.upstreamModel === contract.requestedModel);
    if (!channel?.enabled || !binding) throw new PricingInputError("上游型号没有已启用的逻辑模型渠道绑定");
    const protocol = resolveChannelModelConfig(channel.advancedConfig, contract.requestedModel)?.protocol || channel.advancedConfig?.protocol;
    if (
        !version.logicalModelId &&
        contract.requestedModel !== version.sku &&
        (contract.scope !== "global-standard-direct-image-tokens" || contract.identity?.channelBindingId !== binding.id || channel.apiFormat !== "openai" || !supportsDirectImageTokenContract(protocol))
    )
        throw new PricingInputError("图片渠道别名须匹配当前绑定及直接 Images 协议");
    if (contract.scope === "global-standard-dataeyes-flux-image" && !supportsImageCountContract(protocol, contract.requestedModel, contract.operation)) throw new PricingInputError("渠道协议不支持已核实的按张契约");
    return saveImagePriceContract(contract, expectedCurrentId);
}
