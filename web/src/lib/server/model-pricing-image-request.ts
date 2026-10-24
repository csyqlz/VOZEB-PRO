import { PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { previewObservedImageQuote, supportsDirectImageTokenContract, validateImagePriceContract, type ImagePriceContract, type ImagePriceCallContext } from "./model-pricing-image-contract";
import type { PublishedPriceSelection } from "./model-pricing-published-price";

export type ImageWalletRequest = {
    contract: ImagePriceContract & { id: string };
    channelId: string;
    requestedModel: string;
    declaredProtocol?: string;
    operation: ImagePriceContract["operation"];
    payload: unknown;
    referenceImages?: Array<{ width: number; height: number } | null>;
    hasMask?: boolean;
    requestFieldNames?: string[];
};

export function findImageHoldTier(contract: ImagePriceContract, body: Record<string, unknown>, referenceImages?: ImageWalletRequest["referenceImages"], hasMask?: boolean, requestFieldNames?: string[]) {
    const permittedFields = new Set(["model", "prompt", "n", "quality", "size", "response_format", "output_format", ...(contract.operation === "edits" ? ["image"] : [])]);
    if ([...Object.keys(body), ...(requestFieldNames || [])].some((field) => !permittedFields.has(field))) return undefined;
    if ((body.response_format !== undefined && !["url", "b64_json"].includes(String(body.response_format))) || (body.output_format !== undefined && body.output_format !== "png")) return undefined;
    const dimensions = (value: unknown) => typeof value === "string" && /^[1-9]\d*x[1-9]\d*$/.test(value) && value.split("x").every((part) => Number.isSafeInteger(Number(part)));
    const requestedSize = body.size === undefined || body.size === "auto" ? "auto" : body.size;
    if ((requestedSize !== "auto" && !dimensions(requestedSize)) || body.n !== 1 || hasMask || ["image", "images", "image_urls", "image_url", "input_image", "mask", "ref_assets"].some((key) => body[key] !== undefined)) return undefined;
    if (contract.operation === "generations" ? Boolean(referenceImages?.length) : referenceImages?.length !== 1 || !referenceImages[0] || !dimensions(`${referenceImages[0].width}x${referenceImages[0].height}`)) return undefined;
    const candidates = contract.holdEstimates?.filter((item) => body.quality === item.quality && (requestedSize === "auto" ? item.size === "auto" : item.size !== "auto")) || [];
    return candidates.find((item) => item.size === requestedSize && (contract.operation === "generations" || item.referenceSize === `${referenceImages![0]!.width}x${referenceImages![0]!.height}`)) || candidates[0];
}

function scaledQuantity(quantity: string, requestedSize: string, sampleSize: string) {
    const [width, height] = requestedSize.split("x").map(BigInt);
    const [sampleWidth, sampleHeight] = sampleSize.split("x").map(BigInt);
    const numerator = BigInt(quantity) * width * height;
    const denominator = sampleWidth * sampleHeight;
    return ((numerator + denominator - BigInt(1)) / denominator).toString();
}

export function inspectImageRequestContext(payload: unknown): { region?: string; billingMode: "standard" | "unsupported"; usesExternalTools: boolean } {
    const valid = payload !== null && typeof payload === "object" && !Array.isArray(payload);
    const body = valid ? (payload as Record<string, unknown>) : {};
    const disabled = (value: unknown) => value === undefined || value === false || value === "false";
    const tools = (value: unknown) => value !== undefined && !(Array.isArray(value) && value.length === 0);
    return {
        ...(body.inference_geo !== undefined ? { region: typeof body.inference_geo === "string" ? body.inference_geo : "unknown" } : {}),
        billingMode: valid && [body.batch, body.background, body.async, body.stream].every(disabled) && body.service_tier === undefined && body.cachedContent === undefined && body.prompt_cache_key === undefined ? "standard" : "unsupported",
        usesExternalTools: tools(body.tools) || tools(body.functions) || body.tool_choice !== undefined || body.function_call !== undefined,
    };
}

/** Prospective bound from the audited single-image contract; this is not observed usage. */
export function prepareImageRequestBound(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; priceSelection?: PublishedPriceSelection; request: ImageWalletRequest; occurredAt: string; preserveLegacyReservation?: boolean }) {
    const { version, policy, request, occurredAt } = input;
    const { contract, channelId, requestedModel, declaredProtocol, operation, payload, referenceImages, hasMask, requestFieldNames } = request;
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    const tokenBilling = contract.scope === "global-standard-direct-image-tokens";
    if (tokenBilling) validateImagePriceContract(contract, version, contract.reviewedBy, contract.reviewedAt);
    if (tokenBilling && (contract.officialVersionId !== version.id || contract.channelId !== channelId || contract.requestedModel !== requestedModel)) throw new PricingInputError("图片 Token 计费契约与当前价目或渠道不一致");
    if (body.model !== requestedModel || (!tokenBilling && (contract.scope !== "global-standard-dataeyes-flux-image" || (body.response_format !== undefined && body.response_format !== "url"))))
        throw new PricingInputError("图片请求与已审核计费契约不一致");
    const context = inspectImageRequestContext(payload);
    const call: Omit<ImagePriceCallContext, "responseComplete"> = {
        ...context,
        officialVersionId: version.id,
        salesVersionId: policy.id,
        logicalModelId: input.modelId,
        ...(input.priceSelection ? { priceSelection: input.priceSelection } : {}),
        channelId,
        requestedModel,
        declaredProtocol,
        operation,
        region: context.region ?? contract.region,
        occurredAt,
    };
    if (tokenBilling) {
        if (context.billingMode !== "standard" || context.usesExternalTools || operation !== contract.operation || !supportsDirectImageTokenContract(declaredProtocol)) throw new PricingInputError("图片 Token 预扣只支持已审核的直接 Images 标准调用");
        const tier = findImageHoldTier(contract, { ...body, n: body.n === "1" ? 1 : body.n }, referenceImages, hasMask, requestFieldNames);
        if (contract.holdEstimates && !tier) throw new PricingInputError("该图片画质或请求尺寸尚无可用的已审核估算基准，按量准入暂停");
        const estimate = tier || contract.holdEstimate;
        if (!estimate) {
            if (input.preserveLegacyReservation && !input.priceSelection) return { call, maximumUsage: {}, upperBoundEvidence: contract.evidence, estimatedTokenBilling: true };
            throw new PricingInputError("图片 Token 契约缺少已审核的独立预留估算");
        }
        if (tier && (typeof body.prompt !== "string" || !body.prompt.trim())) throw new PricingInputError("图片分档预留须有明确文本提示词");
        const promptBytes = tier ? BigInt(Buffer.byteLength(body.prompt as string, "utf8")) : BigInt(0);
        const estimatedMeters = tier
            ? {
                  ...tier.meterQuantities,
                  outputImageTokens: tier.size === "auto" ? tier.meterQuantities.outputImageTokens : scaledQuantity(tier.meterQuantities.outputImageTokens, body.size as string, tier.size),
                  ...(operation === "edits" ? { inputImageTokens: scaledQuantity(tier.meterQuantities.inputImageTokens, `${referenceImages![0]!.width}x${referenceImages![0]!.height}`, tier.referenceSize!) } : {}),
              }
            : estimate.meterQuantities;
        const estimatedUsage = Object.fromEntries(
            version.items.map((item) => [
                item.key,
                contract.itemMeters[item.key]
                    .reduce((sum, meter) => {
                        const reviewed = BigInt(estimatedMeters[meter]);
                        return sum + (meter === "inputTextTokens" ? reviewed + promptBytes : reviewed);
                    }, BigInt(0))
                    .toString(),
            ]),
        );
        const estimatedHoldPoints = quoteSalesPrice({ version, policy, usage: estimatedUsage, modelId: input.modelId }).exactPoints;
        return {
            call,
            maximumUsage: {},
            upperBoundEvidence: `${tier ? `quality=${tier.quality}; requestedSize=${tier.size === "auto" ? "auto" : body.size}; ${tier.size === "auto" ? `observedSampleSize=${tier.observedSize}; imageTokens=reviewedAutoSample; ` : `sampleSize=${tier.size}; imageTokens=ceil(sampleTokens*requestedPixels/samplePixels); `}${tier.referenceSize ? `referenceSize=${referenceImages![0]!.width}x${referenceImages![0]!.height}; sampleReferenceSize=${tier.referenceSize}; ` : ""}inputText=reviewed+promptUtf8Bytes\n` : ""}${estimate.sourceUrl}\n${estimate.evidence}`,
            estimatedTokenBilling: true,
            estimatedHoldPoints,
        };
    }
    const preview = previewObservedImageQuote({
        version,
        policy,
        contract,
        call: { ...call, responseComplete: true },
        observation: { protocol: "openai-images", quantities: { images: "1" }, hasResults: true, reportedModel: contract.reportedModel, missing: [], invalid: [] },
    });
    if (!preview.ready) throw new PricingInputError(preview.reasons.join("；"));
    return { call, maximumUsage: preview.usage, upperBoundEvidence: `${contract.imageLimit!.sourceUrl}\n${contract.imageLimit!.evidence}` };
}
