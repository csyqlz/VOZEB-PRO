import { PricingInputError, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { prepareAudioRequestPriceBound, type AudioPriceCallContext, type AudioPriceContract } from "./model-pricing-audio-contract";

import { prepareOpenAiAudioPriceBound, type OpenAiAudioPriceContract } from "./model-pricing-openai-audio-contract";
import type { PublishedPriceSelection } from "./model-pricing-published-price";

export const OPENAI_WALLET_AUDIO_MIME = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", opus: "audio/ogg" } as const;
export type OpenAiWalletAudioFormat = keyof typeof OPENAI_WALLET_AUDIO_MIME;
export type AudioWalletRequest = { contract: (AudioPriceContract | OpenAiAudioPriceContract) & { id: string }; channelId: string; requestedModel: string; declaredProtocol: string; payload: unknown };

/** Freeze the real TTS request's documented bounds and regular customer prices before submission. */
export function prepareAudioWalletBound(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; priceSelection?: PublishedPriceSelection; request: AudioWalletRequest; occurredAt: string }) {
    const { version, policy, request, occurredAt } = input;
    const call: AudioPriceCallContext = {
        officialVersionId: version.id,
        salesVersionId: policy.id,
        logicalModelId: input.modelId,
        channelId: request.channelId,
        requestedModel: request.requestedModel,
        declaredProtocol: request.declaredProtocol,
        operation: request.contract.protocol === "openai-chat-audio" ? "chat/completions" : "generateContent",
        region: "global",
        billingMode: "standard",
        occurredAt,
    };
    if (request.contract.protocol === "openai-chat-audio") {
        const prepared = prepareOpenAiAudioPriceBound({ version, policy, contract: request.contract, call, priceSelection: input.priceSelection, payload: request.payload });
        if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
        const format = (request.payload as { audio: { format: string } }).audio.format;
        // Match the existing native generation workflow; no inferred PCM decoding parameters.
        if (!Object.hasOwn(OPENAI_WALLET_AUDIO_MIME, format)) throw new PricingInputError("该音频格式尚未接入原媒体钱包恢复");
        return { ...prepared, call, responseFormat: format as OpenAiWalletAudioFormat, upperBoundEvidence: `${prepared.bound.sourceUrl}\n${request.contract.evidence}` };
    }
    const prepared = prepareAudioRequestPriceBound({ version, policy, contract: request.contract, call, priceSelection: input.priceSelection, payload: request.payload });
    if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
    return { ...prepared, call, upperBoundEvidence: `${prepared.bound.sourceUrl}\n${request.contract.evidence}` };
}
