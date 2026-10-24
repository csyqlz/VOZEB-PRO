import { PricingInputError, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { prepareVideoRequestPriceBound, type VideoPriceCallContext, type VideoPriceContract } from "./model-pricing-video-contract";
import { prepareHailuoPriceBound, type HailuoPriceContract } from "./model-pricing-hailuo-contract";
import type { PublishedPriceSelection } from "./model-pricing-published-price";

export type VideoWalletRequest = { contract: (VideoPriceContract | HailuoPriceContract) & { id: string }; channelId: string; requestedModel: string; declaredProtocol: string; payload: unknown };

/** Derive wallet bounds from the actual request and reviewed contract, without supplier-free allowances. */
export function prepareVideoWalletBound(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; priceSelection?: PublishedPriceSelection; request: VideoWalletRequest; occurredAt: string }) {
    const { version, policy, request, occurredAt } = input;
    const call: VideoPriceCallContext = {
        officialVersionId: version.id,
        salesVersionId: policy.id,
        logicalModelId: input.modelId,
        channelId: request.channelId,
        requestedModel: request.requestedModel,
        declaredProtocol: request.declaredProtocol,
        operation: "generation",
        region: "global",
        billingMode: "standard",
        occurredAt,
    };
    const prepared =
        request.contract.protocol === "minimax-hailuo-v1"
            ? prepareHailuoPriceBound({ version, policy, contract: request.contract, call, priceSelection: input.priceSelection, payload: request.payload })
            : prepareVideoRequestPriceBound({ version, policy, contract: request.contract, call, priceSelection: input.priceSelection, payload: request.payload });
    if (!prepared.ready) throw new PricingInputError(prepared.reasons.join("；"));
    return { ...prepared, call, upperBoundEvidence: `${prepared.bound.sourceUrl}\n${request.contract.evidence}` };
}
