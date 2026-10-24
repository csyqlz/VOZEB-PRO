import { assertRegularPaidPriceItems, officialItemsForTextPriceGroup, PricingConflictError, PricingInputError, type OfficialPriceVersion, type SalesVersion, type TextUsageRule } from "@/lib/model-pricing";
import { prepareFlatTextShadowPrice } from "./model-pricing-shadow-service";
import { getShadowTextCall, mutateShadowTextCall } from "./model-pricing-shadow-store";
import { getCurrentSalesVersion } from "./model-pricing-store";
import { resolvePublishedModelPrice, type PublishedPriceSelection } from "./model-pricing-published-price";
import { listFlatTextPriceContracts } from "./model-pricing-token-contract-store";
import type { FlatTextPriceContract } from "./model-pricing-token-contract";
import { inspectProviderTokenUsage, type TokenUsageObservation, type TokenUsageProtocol } from "./model-pricing-token-usage";

import { inspectFlatTextRequestContext as requestContext, onlyTextContent, type RequestContext } from "./model-pricing-text-request";
import { prepareFlatTextRequestBound, validateObservedRequestBound, type FlatTextRequestBound } from "./model-pricing-request-bound";
import { getModelPricingActivation } from "./model-pricing-activation-store";
import { getLatestTextUsageRule, getTextUsageRuleById } from "./model-pricing-text-usage-rule-store";
export type ShadowTextCall = {
    userId: string;
    requestId: string;
    taskId?: string;
    requestPath?: string;
    requestFingerprint: string;
    modelId: string;
    channelId: string;
    requestedModel: string;
    protocol: TokenUsageProtocol | null;
    startedAt: string;
    requestContext: RequestContext;
    requestBound?: FlatTextRequestBound;
    frozen?: { version: OfficialPriceVersion; policy: SalesVersion; contract: FlatTextPriceContract & { id: string }; rules?: TextUsageRule; priceSelection?: PublishedPriceSelection };
    reasons: string[];
    result?: { status: "priced" | "unpriced" | "failed"; reasons: string[]; completedAt: string; observation?: TokenUsageObservation; receiptId?: string; requestBoundCheck?: { valid: boolean; reasons: string[] }; responseMeta?: AnthropicResponseMeta };
};
export type AnthropicResponseMeta = { stopReason: string; contentBlockTypes: string[]; terminalSeen: boolean; blocksClosed: boolean };
type BeginInput = Pick<ShadowTextCall, "userId" | "requestId" | "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "taskId"> & { path: string[]; payload: unknown; adapted?: boolean; directedPricingRuleId?: string };

const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function protocolForPath(path: string[]): TokenUsageProtocol | null {
    const route = `/${path.join("/")}`;
    if (/\/chat\/completions$/i.test(route)) return "openai-chat";
    if (/\/responses$/i.test(route)) return "openai-responses";
    if (/\/messages$/i.test(route)) return "anthropic-messages";
    if (/\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/i.test(route)) return "gemini-generate";
    return null;
}

function assertSameRequest(call: ShadowTextCall, input: Pick<ShadowTextCall, "requestFingerprint" | "modelId" | "channelId" | "requestedModel">) {
    if ("operation" in call || "kind" in call || ["requestFingerprint", "modelId", "channelId", "requestedModel"].some((key) => call[key as keyof typeof input] !== input[key as keyof typeof input]))
        throw new PricingConflictError("影子调用身份对应不同请求");
}

export async function beginShadowTextCall(input: BeginInput): Promise<ShadowTextCall> {
    if ([input.userId, input.requestId, input.requestFingerprint, input.modelId, input.channelId, input.requestedModel].some((value) => !value?.trim())) throw new PricingInputError("影子调用缺少稳定身份");
    const existing = await getShadowTextCall(input.userId, input.requestId);
    if (existing) {
        assertSameRequest(existing, input);
        return existing;
    }
    const protocol = input.adapted ? null : protocolForPath(input.path);
    const reasons: string[] = [];
    if (!protocol) reasons.push("该协议或响应转换尚无已验证的用量解析");
    const policy = await getCurrentSalesVersion();
    const published = await resolvePublishedModelPrice(input.modelId, "text", "generation", policy);
    const version = published?.version;
    if (!policy || !version) reasons.push("该逻辑模型尚无已发布的官方价与用户售价");
    if (version) {
        try {
            assertRegularPaidPriceItems(version.textPriceSchedule ? version.textPriceSchedule.groups.filter((group) => group.selector.processingMode === "standard").flatMap(officialItemsForTextPriceGroup) : version.items);
        } catch (error) {
            if (!(error instanceof PricingInputError)) throw error;
            reasons.push(error.message);
        }
    }
    const contract = version ? (await listFlatTextPriceContracts(version.id, input.channelId, input.requestedModel)).find((item) => item.current) : undefined;
    const activation = await getModelPricingActivation(input.modelId);
    const rules =
        version && input.directedPricingRuleId
            ? await getTextUsageRuleById(input.directedPricingRuleId)
            : version && activation?.enabled && activation.officialVersionId === version.id
              ? activation.textUsageRuleId
                  ? await getTextUsageRuleById(activation.textUsageRuleId)
                  : undefined
              : version
                ? await getLatestTextUsageRule(input.modelId, version.id)
                : undefined;
    if (input.directedPricingRuleId && (!rules || rules.modelId !== input.modelId || rules.officialVersionId !== version?.id)) reasons.push("定向验收规则与当前官方价版本不一致");
    if (version && !contract) reasons.push("当前渠道和上游型号尚无已审核的用量契约");
    const call: ShadowTextCall = {
        userId: input.userId,
        requestId: input.requestId,
        taskId: input.taskId,
        requestPath: `/${input.path.join("/")}`,
        requestFingerprint: input.requestFingerprint,
        modelId: input.modelId,
        channelId: input.channelId,
        requestedModel: input.requestedModel,
        protocol,
        startedAt: new Date().toISOString(),
        requestContext: requestContext(protocol, input.payload),
        reasons,
        ...(policy && version && contract ? { frozen: { policy, version, contract, ...(rules ? { rules } : {}), ...(published.selection ? { priceSelection: published.selection } : {}) } } : {}),
    };
    if (call.frozen)
        call.requestBound = protocol === contract!.protocol ? prepareFlatTextRequestBound({ ...call.frozen, modelId: input.modelId, payload: input.payload, occurredAt: call.startedAt }) : { ready: false, reasons: ["请求协议或响应转换与上界契约不一致"] };
    return mutateShadowTextCall(input.userId, input.requestId, (saved) => {
        if (saved) {
            assertSameRequest(saved, input);
            return { call: saved };
        }
        return { call };
    });
}

export type ShadowTextOutcome = { payload?: unknown; responseHeaders?: Headers; failure?: string; unavailable?: string; stream?: { observation: TokenUsageObservation; complete: boolean; responseMeta?: AnthropicResponseMeta } };

const ANTHROPIC_STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"]);
const ANTHROPIC_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);
export const safeAnthropicStopReason = (value: unknown) => (typeof value === "string" ? (ANTHROPIC_STOP_REASONS.has(value) ? value : "unknown") : "missing");
export const safeAnthropicBlockType = (value: unknown) => (typeof value === "string" ? (ANTHROPIC_BLOCK_TYPES.has(value) ? value : "unknown") : "missing");

function anthropicResponseMeta(payload: unknown): AnthropicResponseMeta {
    const body = object(payload);
    return {
        stopReason: safeAnthropicStopReason(body.stop_reason),
        contentBlockTypes: Array.isArray(body.content) ? body.content.map((part: unknown) => safeAnthropicBlockType(object(part).type)) : [],
        terminalSeen: true,
        blocksClosed: Array.isArray(body.content),
    };
}

export async function finishShadowTextCall(call: ShadowTextCall, input: ShadowTextOutcome) {
    const observation = input.stream?.observation || (call.protocol && input.payload !== undefined ? inspectProviderTokenUsage(call.protocol, input.payload, input.responseHeaders) : undefined);
    return mutateShadowTextCall(call.userId, call.requestId, (saved, state) => {
        if (!saved) throw new PricingInputError("影子调用快照不存在");
        assertSameRequest(saved, call);
        if (saved.result) return { call: saved };
        const reasons = [...saved.reasons, ...(input.failure ? [input.failure] : []), ...(input.unavailable ? [input.unavailable] : [])];
        const responseMeta = saved.protocol === "anthropic-messages" ? input.stream?.responseMeta || (input.payload !== undefined ? anthropicResponseMeta(input.payload) : undefined) : undefined;
        const result: NonNullable<ShadowTextCall["result"]> = { status: input.failure ? "failed" : "unpriced", reasons, completedAt: new Date().toISOString(), ...(observation ? { observation } : {}), ...(responseMeta ? { responseMeta } : {}) };
        if (saved.requestBound) result.requestBoundCheck = { valid: false, reasons: saved.requestBound.ready ? ["尚未取得完整且有效的实际用量"] : saved.requestBound.reasons };
        if (!observation) reasons.push("未取得可解析的上游用量");
        if (saved.frozen && observation && !reasons.length) {
            const { version, policy, contract, rules } = saved.frozen;
            const prepared = prepareFlatTextShadowPrice({
                userId: saved.userId,
                requestId: saved.requestId,
                requestFingerprint: saved.requestFingerprint,
                contractId: contract.id,
                version,
                policy,
                contract,
                rules,
                observation,
                call: {
                    ...saved.requestContext,
                    region: saved.requestContext.region || contract.region,
                    serviceTier: saved.requestContext.serviceTier || contract.serviceTier,
                    channelId: saved.channelId,
                    modelId: saved.modelId,
                    ...(saved.frozen.priceSelection ? { priceSelection: saved.frozen.priceSelection } : {}),
                    salesVersionId: policy.id,
                    officialVersionId: version.id,
                    requestedModel: saved.requestedModel,
                    responseComplete: input.stream ? input.stream.complete : completeTextResponse(saved.protocol, input.payload),
                    occurredAt: saved.startedAt,
                },
            });
            if (prepared.ready && !prepared.warnings.length) {
                if (saved.requestBound) {
                    const boundReasons = validateObservedRequestBound(saved.requestBound, contract, prepared.normalizedObservation);
                    result.requestBoundCheck = { valid: !boundReasons.length, reasons: boundReasons };
                    if (boundReasons.length) {
                        reasons.push(...boundReasons);
                        return { call: { ...saved, result } };
                    }
                }
                const receipt = prepared.build(state);
                return { call: { ...saved, result: { ...result, status: "priced", receiptId: receipt.id } }, receipt };
            }
            reasons.push(...(prepared.ready ? prepared.warnings : prepared.reasons));
        }
        return { call: { ...saved, result } };
    });
}

export function completeTextResponse(protocol: TokenUsageProtocol | null, payload: unknown) {
    const body = object(payload);
    if (body.error) return false;
    if (protocol === "openai-responses")
        return body.status === "completed" && Array.isArray(body.output) && body.output.length > 0 && body.output.every((item) => object(item).type === "reasoning" || (object(item).type === "message" && onlyTextContent(object(item).content)));
    if (protocol === "anthropic-messages") {
        const blocks = Array.isArray(body.content) ? body.content.map(object) : [];
        return (
            ["end_turn", "max_tokens", "stop_sequence"].includes(String(body.stop_reason)) &&
            blocks.some((part) => part.type === "text" && typeof part.text === "string") &&
            blocks.every((part) => (part.type === "text" && typeof part.text === "string") || (part.type === "thinking" && typeof part.thinking === "string"))
        );
    }
    if (protocol === "openai-chat")
        return (
            Array.isArray(body.choices) &&
            body.choices.length > 0 &&
            body.choices.every((item) => ["stop", "length"].includes(String(object(item).finish_reason)) && onlyTextContent(object(object(item).message).content) && !object(object(item).message).audio)
        );
    if (protocol === "gemini-generate")
        return (
            Array.isArray(body.candidates) &&
            body.candidates.length > 0 &&
            body.candidates.every((item) => {
                const candidate = object(item);
                const parts = object(candidate.content).parts;
                return ["STOP", "MAX_TOKENS"].includes(String(candidate.finishReason)) && Array.isArray(parts) && parts.length > 0 && parts.every((part) => typeof object(part).text === "string" && !object(part).inlineData && !object(part).functionCall);
            })
        );
    return false;
}

/** Observation failures are internal diagnostics and must not turn a successful generation into a retry. */
export async function safelyObserveShadowPrice<T>(context: { userId: string; requestId: string }, action: () => Promise<T>): Promise<T | undefined> {
    try {
        return await action();
    } catch (error) {
        console.error("Model pricing shadow observation failed", { ...context, errorType: error instanceof Error ? error.name : "unknown" });
        return undefined;
    }
}
