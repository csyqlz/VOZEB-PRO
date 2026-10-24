import { inspectImageRequestContext } from "./model-pricing-image-request";
import { assertRegularPaidPriceItems, PricingConflictError, PricingInputError, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { inspectOpenAiImageCount, inspectOpenAiImageUsage, recordImageRequestMismatches, reinterpretDirectImageZeroMetadata, type ImageUsageObservation } from "./model-pricing-image-usage";
import type { ImagePriceContract } from "./model-pricing-image-contract";
import { listImagePriceContracts } from "./model-pricing-image-contract-store";
import { prepareImageShadowPrice } from "./model-pricing-shadow-service";
import { getShadowImageCall, mutateShadowImageCall } from "./model-pricing-shadow-store";
import { getCurrentSalesVersion } from "./model-pricing-store";
import { observeMediaShadowRefund } from "./model-pricing-shadow-refund";
import { resolvePublishedModelPrice, type PublishedPriceSelection } from "./model-pricing-published-price";

export type ShadowImageCall = {
    userId: string;
    requestId: string;
    taskId?: string;
    requestPath?: string;
    requestFingerprint: string;
    modelId: string;
    channelId: string;
    requestedModel: string;
    protocol: "openai-images" | null;
    declaredProtocol?: string;
    operation: ImagePriceContract["operation"] | null;
    startedAt: string;
    requestContext: { region?: string; billingMode: "standard" | "unsupported"; usesExternalTools: boolean };
    requestParameters?: { quality?: string; size?: string };
    /** Dimensions of reference files forwarded by this proxy, before any upstream transformation. */
    referenceImages?: Array<{ width: number; height: number } | null>;
    frozen?: { version: OfficialPriceVersion; policy: SalesVersion; contract: ImagePriceContract & { id: string }; priceSelection?: PublishedPriceSelection };
    reasons: string[];
    result?: { status: "priced" | "unpriced" | "failed"; reasons: string[]; completedAt: string; observation?: ImageUsageObservation; receiptId?: string };
    revaluation?: { receiptId: string; reviewedAt: string; rule: "direct-images-zero-metadata-v1" };
};
type BeginInput = Pick<ShadowImageCall, "userId" | "requestId" | "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "taskId"> & {
    path: string[];
    payload: unknown;
    adapted?: boolean;
    declaredProtocol?: string;
    referenceImages?: ShadowImageCall["referenceImages"];
};

function operationForPath(path: string[]): ShadowImageCall["operation"] {
    const match = `/${path.join("/")}`.match(/\/images\/(generations|edits)$/i);
    return match ? (match[1].toLowerCase() as ImagePriceContract["operation"]) : null;
}

function assertSameRequest(call: ShadowImageCall, input: Pick<ShadowImageCall, "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "operation" | "declaredProtocol">) {
    if (!("operation" in call) || (["requestFingerprint", "modelId", "channelId", "requestedModel", "operation", "declaredProtocol"] as const).some((key) => call[key] !== input[key])) throw new PricingConflictError("图片影子调用身份对应不同请求");
}

/** Freeze before sending. An unpriced attempt remains unpriced even if a price is approved later. */
export async function beginShadowImageCall(input: BeginInput): Promise<ShadowImageCall> {
    if ([input.userId, input.requestId, input.requestFingerprint, input.modelId, input.channelId, input.requestedModel].some((value) => !value?.trim())) throw new PricingInputError("图片影子调用缺少稳定身份");
    const operation = input.adapted ? null : operationForPath(input.path);
    const identity = { ...input, operation };
    const existing = await getShadowImageCall(input.userId, input.requestId);
    if (existing) {
        assertSameRequest(existing, identity);
        return existing;
    }
    const reasons: string[] = [];
    if (!operation) reasons.push("该图片协议尚无已验证的计价契约");
    const policy = await getCurrentSalesVersion();
    const published = policy && operation ? await resolvePublishedModelPrice(input.modelId, "image", operation, policy) : undefined;
    const version = published?.version;
    if (!policy || !version) reasons.push("该图片逻辑模型尚无已发布的官方价与用户售价");
    if (version) {
        try {
            assertRegularPaidPriceItems(version.items);
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
            reasons.push(error.message);
        }
    }
    const contract = version && operation ? (await listImagePriceContracts(version.id, input.channelId, input.requestedModel, operation)).find((item) => item.current) : undefined;
    if (version && operation && !contract) reasons.push("当前渠道、型号和图片操作尚无已审核契约");
    const call: ShadowImageCall = {
        userId: input.userId,
        requestId: input.requestId,
        taskId: input.taskId,
        requestPath: `/${input.path.join("/")}`,
        requestFingerprint: input.requestFingerprint,
        modelId: input.modelId,
        channelId: input.channelId,
        requestedModel: input.requestedModel,
        protocol: operation ? "openai-images" : null,
        declaredProtocol: input.declaredProtocol,
        operation,
        startedAt: new Date().toISOString(),
        requestContext: inspectImageRequestContext(input.payload),
        requestParameters: Object.fromEntries(
            ["quality", "size"].flatMap((key) => {
                const value = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? (input.payload as Record<string, unknown>)[key] : undefined;
                return typeof value === "string" ? [[key, value]] : [];
            }),
        ),
        reasons,
        ...(input.referenceImages ? { referenceImages: input.referenceImages } : {}),
        ...(policy && version && contract ? { frozen: { policy, version, contract, ...(published?.selection ? { priceSelection: published.selection } : {}) } } : {}),
    };
    return mutateShadowImageCall(input.userId, input.requestId, (saved) => {
        if (saved) {
            assertSameRequest(saved, identity);
            return { call: saved };
        }
        return { call };
    });
}

/** Uses only the saved snapshot. The result, receipt and exact accrual commit together. */
export async function finishShadowImageCall(call: ShadowImageCall, input: { payload?: unknown; failure?: string; unavailable?: string }) {
    const completed = await mutateShadowImageCall(call.userId, call.requestId, (saved, state) => {
        if (!saved) throw new PricingInputError("图片影子调用快照不存在");
        assertSameRequest(saved, call);
        if (saved.result) return { call: saved };
        const observation =
            saved.protocol && input.payload !== undefined
                ? saved.frozen?.contract.scope === "global-standard-dataeyes-flux-image"
                    ? inspectOpenAiImageCount(input.payload)
                    : recordImageRequestMismatches(inspectOpenAiImageUsage(input.payload), input.payload, saved.requestParameters)
                : undefined;
        const reasons = [...saved.reasons, ...(input.failure ? [input.failure] : []), ...(input.unavailable ? [input.unavailable] : [])];
        const result: NonNullable<ShadowImageCall["result"]> = { status: input.failure ? "failed" : "unpriced", reasons, completedAt: new Date().toISOString(), ...(observation ? { observation } : {}) };
        if (!observation) reasons.push("未取得完整的直接图片 JSON 用量");
        if (saved.frozen && observation && !reasons.length) {
            const { version, policy, contract } = saved.frozen;
            const prepared = prepareImageShadowPrice({
                userId: saved.userId,
                requestId: saved.requestId,
                requestFingerprint: saved.requestFingerprint,
                contractId: contract.id,
                version,
                policy,
                contract,
                observation,
                call: {
                    ...saved.requestContext,
                    declaredProtocol: saved.declaredProtocol,
                    region: saved.requestContext.region ?? contract.region,
                    logicalModelId: saved.modelId,
                    ...(saved.frozen.priceSelection ? { priceSelection: saved.frozen.priceSelection } : {}),
                    channelId: saved.channelId,
                    requestedModel: saved.requestedModel,
                    operation: saved.operation || "",
                    salesVersionId: policy.id,
                    officialVersionId: version.id,
                    responseComplete: true,
                    occurredAt: saved.startedAt,
                },
            });
            if (prepared.ready) {
                const receipt = prepared.build(state);
                return { call: { ...saved, result: { ...result, status: "priced", receiptId: receipt.id } }, receipt };
            }
            reasons.push(...prepared.reasons);
        }
        return { call: { ...saved, result } };
    });
    if (completed.result?.status === "priced") await observeMediaShadowRefund(completed.userId, completed.requestId);
    if (completed.result?.observation?.requestMismatches?.length)
        console.warn("Shadow image response parameters differ from request", { requestId: completed.requestId, channelId: completed.channelId, mismatches: completed.result.observation.requestMismatches });
    return completed;
}

/** Append a shadow receipt for a saved real response while retaining its original unpriced result. */
export async function revalueShadowImageCall(call: ShadowImageCall) {
    const savedCall = await mutateShadowImageCall(call.userId, call.requestId, (saved, state) => {
        if (!saved || saved.requestFingerprint !== call.requestFingerprint || saved.frozen?.contract.id !== call.frozen?.contract.id) throw new PricingConflictError("历史图片影子调用已变化");
        if (
            saved.revaluation ||
            saved.result?.status !== "unpriced" ||
            !saved.result.observation ||
            !saved.frozen ||
            !saved.operation ||
            saved.protocol !== "openai-images" ||
            saved.frozen.contract.scope !== "global-standard-direct-image-tokens" ||
            saved.reasons.length
        )
            return { call: saved };
        if (state.charge) throw new PricingConflictError("历史调用已有影子报价，不可重复复核");
        const { version, policy, contract } = saved.frozen;
        const prepared = prepareImageShadowPrice({
            userId: saved.userId,
            requestId: saved.requestId,
            requestFingerprint: saved.requestFingerprint,
            contractId: contract.id,
            version,
            policy,
            contract,
            observation: reinterpretDirectImageZeroMetadata(saved.result.observation),
            call: {
                ...saved.requestContext,
                declaredProtocol: saved.declaredProtocol,
                region: saved.requestContext.region ?? contract.region,
                logicalModelId: saved.modelId,
                ...(saved.frozen.priceSelection ? { priceSelection: saved.frozen.priceSelection } : {}),
                channelId: saved.channelId,
                requestedModel: saved.requestedModel,
                operation: saved.operation,
                salesVersionId: policy.id,
                officialVersionId: version.id,
                responseComplete: true,
                occurredAt: saved.startedAt,
            },
        });
        if (!prepared.ready) return { call: saved };
        const receipt = prepared.build(state);
        return { call: { ...saved, revaluation: { receiptId: receipt.id, reviewedAt: new Date().toISOString(), rule: "direct-images-zero-metadata-v1" } }, receipt };
    });
    if (savedCall.revaluation) await observeMediaShadowRefund(savedCall.userId, savedCall.requestId);
    return savedCall;
}
