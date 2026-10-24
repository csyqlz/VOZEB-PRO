import { getFreshAuthSettings } from "@/lib/auth/store";
import { PricingInputError } from "@/lib/model-pricing";
import { resolveTextProtocol } from "./text-protocol-resolver";
import { resolvePricingContractModel } from "./model-pricing-contract-model";
import { getOfficialVersionsByIds } from "./model-pricing-store";
import { listFlatTextPriceContracts, saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import { FLAT_TEXT_REQUIRED_METERS, OPENAI_INCLUSIVE_INPUT_METERS, validateFlatTextPriceContract } from "./model-pricing-token-contract";

export async function getFlatTextPriceContractOptions(officialVersionId: string, logicalModelId?: string) {
    if (!officialVersionId) throw new PricingInputError("请选择已审核官方价目");
    const version = (await getOfficialVersionsByIds([officialVersionId]))[0];
    if (!version) throw new PricingInputError("已审核官方价目不存在");
    const settings = await getFreshAuthSettings();
    const { model } = await resolvePricingContractModel(settings, version, logicalModelId, ["generation"]);
    const bindings =
        model?.enabled && model.capability === "text"
            ? model.bindings
                  .filter((binding) => binding.enabled)
                  .flatMap((binding) => {
                      const channel = settings.systemChannels.find((item) => item.id === binding.channelId && item.enabled);
                      if (!channel) return [];
                      let suggestedProtocol: "openai-chat" | "openai-responses" | "gemini-generate" | "anthropic-messages" | undefined;
                      try {
                          const kind = resolveTextProtocol({ model: binding.upstreamModel, apiFormat: channel.apiFormat, advancedConfig: channel.advancedConfig, throughSystemProxy: true }).kind;
                          suggestedProtocol = kind === "responses" ? "openai-responses" : kind === "gemini" ? "gemini-generate" : kind === "chat" ? "openai-chat" : kind === "claude" ? "anthropic-messages" : undefined;
                      } catch {
                          /* A custom protocol needs manual verification. */
                      }
                      return [{ channelId: channel.id, channelName: channel.name, channelBindingId: binding.id, requestedModel: binding.upstreamModel, suggestedProtocol }];
                  })
            : [];
    return { version, bindings, protocolMeters: FLAT_TEXT_REQUIRED_METERS, inclusiveInputMeters: OPENAI_INCLUSIVE_INPUT_METERS };
}

export async function getFlatTextPriceContractHistory(officialVersionId: string, channelId: string, requestedModel: string) {
    if (!officialVersionId || !channelId || !requestedModel) throw new PricingInputError("请选择官方价目、渠道和上游型号");
    const version = (await getOfficialVersionsByIds([officialVersionId]))[0];
    if (!version) throw new PricingInputError("已审核官方价目不存在");
    return { version, contracts: await listFlatTextPriceContracts(officialVersionId, channelId, requestedModel) };
}

export async function reviewFlatTextPriceContract(officialVersionId: string, raw: unknown, expectedCurrentId: string | null, actorId: string, logicalModelId?: string) {
    if (!officialVersionId) throw new PricingInputError("请选择已审核官方价目");
    const version = (await getOfficialVersionsByIds([officialVersionId]))[0];
    if (!version) throw new PricingInputError("已审核官方价目不存在");
    const contract = validateFlatTextPriceContract(raw, version, actorId, new Date().toISOString());
    if (!contract.reservationEstimate) throw new PricingInputError("请先审核文本预留估算方法与依据");
    const settings = await getFreshAuthSettings();
    const { model } = await resolvePricingContractModel(settings, version, logicalModelId, ["generation"]);
    if (!model || !model.enabled || model.capability !== "text") throw new PricingInputError("官方价目未绑定已启用的文本逻辑模型");
    const channel = settings.systemChannels.find((item) => item.id === contract.channelId);
    const channelBinding = model.bindings.find((item) => item.enabled && item.channelId === channel?.id && item.upstreamModel === contract.requestedModel);
    if (!channel?.enabled || !channelBinding || (contract.requestedModel !== version.sku && contract.identity?.channelBindingId !== channelBinding.id)) throw new PricingInputError("上游型号没有已启用的逻辑模型渠道绑定");
    return saveFlatTextPriceContract(contract, expectedCurrentId);
}
