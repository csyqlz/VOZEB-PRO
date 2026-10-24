import { PricingConflictError, PricingInputError, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { generationModelId } from "./generation-channel";
import type { AudioTask } from "./audio-task-store";
import { prepareAudioRequestPriceBound, type AudioPriceCallContext } from "./model-pricing-audio-contract";
import { isGeminiTtsModel, type AudioRequestBound } from "./model-pricing-audio-request";
import { inspectAudioUsage, type AudioUsageObservation } from "./model-pricing-audio-usage";
import { prepareOpenAiAudioPriceBound } from "./model-pricing-openai-audio-contract";
import { OPENAI_PRICED_AUDIO_MODEL, type OpenAiAudioRequestBound } from "./model-pricing-openai-audio-request";
import { listAudioPriceContracts, type StoredAudioPriceContract } from "./model-pricing-audio-contract-store";
import { getCurrentSalesVersion } from "./model-pricing-store";
import { resolvePublishedModelPrice, type PublishedPriceSelection } from "./model-pricing-published-price";
import { getShadowAudioCall, mutateShadowAudioCall } from "./model-pricing-shadow-store";
import { prepareAudioShadowPrice, prepareOpenAiAudioShadowPrice } from "./model-pricing-shadow-service";
import { getShadowBillingSource, observeMediaShadowRefund } from "./model-pricing-shadow-refund";

export type ShadowAudioCall = {
    kind: "audio";
    userId: string;
    requestId: string;
    taskId?: string;
    requestPath?: string;
    requestFingerprint: string;
    modelId: string;
    channelId: string;
    requestedModel: string;
    protocol: "gemini-tts" | "openai-chat-audio" | null;
    declaredProtocol?: string;
    startedAt: string;
    frozen?: { version: OfficialPriceVersion; policy: SalesVersion; contract: StoredAudioPriceContract; priceSelection?: PublishedPriceSelection; bound?: AudioRequestBound | OpenAiAudioRequestBound };
    reasons: string[];
    result?: { status: "priced" | "unpriced" | "failed"; reasons: string[]; completedAt: string; observation?: AudioUsageObservation; receiptId?: string };
};
type BeginInput = Pick<ShadowAudioCall, "userId" | "requestId" | "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "declaredProtocol" | "taskId"> & { path: string[]; payload: unknown; adapted?: boolean };
function sameRequest(saved: ShadowAudioCall, input: Pick<ShadowAudioCall, "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "protocol" | "declaredProtocol">) {
    if (saved.kind !== "audio" || (["requestFingerprint", "modelId", "channelId", "requestedModel", "protocol", "declaredProtocol"] as const).some((key) => saved[key] !== input[key])) throw new PricingConflictError("音频影子调用身份对应不同请求");
}
function context(call: ShadowAudioCall): AudioPriceCallContext {
    return {
        officialVersionId: call.frozen!.version.id,
        salesVersionId: call.frozen!.policy.id,
        logicalModelId: call.modelId,
        channelId: call.channelId,
        requestedModel: call.requestedModel,
        declaredProtocol: call.declaredProtocol || "",
        operation: call.protocol === "openai-chat-audio" ? "chat/completions" : "generateContent",
        region: "global",
        billingMode: "standard",
        occurredAt: call.startedAt,
    };
}

/** Freeze before submission; later price or contract approvals cannot change this attempt. */
export async function beginShadowAudioCall(input: BeginInput): Promise<ShadowAudioCall> {
    if ([input.userId, input.requestId, input.requestFingerprint, input.modelId, input.channelId, input.requestedModel].some((value) => !value?.trim())) throw new PricingInputError("音频影子调用缺少稳定身份");
    const protocol =
        !input.adapted && input.declaredProtocol === "openai" && input.requestedModel === OPENAI_PRICED_AUDIO_MODEL && input.path.slice(-2).join("/") === "chat/completions"
            ? ("openai-chat-audio" as const)
            : !input.adapted && ["gemini", "dataeyes-gemini"].includes(input.declaredProtocol || "") && isGeminiTtsModel(input.requestedModel) && input.path.slice(-2).join("/") === `models/${encodeURIComponent(input.requestedModel)}:generateContent`
              ? ("gemini-tts" as const)
              : null;
    const identity = { ...input, protocol };
    const existing = await getShadowAudioCall(input.userId, input.requestId);
    if (existing) {
        sameRequest(existing, identity);
        return existing;
    }
    const reasons: string[] = [];
    if (!protocol) reasons.push("音频协议尚无已验证的计价契约");
    const policy = await getCurrentSalesVersion();
    const published = await resolvePublishedModelPrice(input.modelId, "audio", protocol === "openai-chat-audio" ? "chat/completions" : "generateContent", policy);
    const version = published?.version;
    if (!policy || !version) reasons.push("音频逻辑模型尚无已发布的官方价与用户售价");
    const contract = protocol && version ? (await listAudioPriceContracts(version.id, input.channelId, input.requestedModel)).find((item) => item.current && item.protocol === protocol) : undefined;
    if (protocol && version && !contract) reasons.push("当前音频渠道与型号尚无已审核契约");
    const call: ShadowAudioCall = {
        kind: "audio",
        userId: input.userId,
        requestId: input.requestId,
        taskId: input.taskId,
        requestPath: `/${input.path.join("/")}`,
        requestFingerprint: input.requestFingerprint,
        modelId: input.modelId,
        channelId: input.channelId,
        requestedModel: input.requestedModel,
        declaredProtocol: input.declaredProtocol,
        protocol,
        startedAt: new Date().toISOString(),
        reasons,
        ...(policy && version && contract ? { frozen: { policy, version, contract, ...(published?.selection ? { priceSelection: published.selection } : {}) } } : {}),
    };
    if (call.frozen && !reasons.length) {
        const { version, policy, contract } = call.frozen;
        const common = { version, policy, priceSelection: call.frozen.priceSelection, call: context(call), payload: input.payload };
        const prepared = contract.protocol === "openai-chat-audio" ? prepareOpenAiAudioPriceBound({ ...common, contract }) : prepareAudioRequestPriceBound({ ...common, contract });
        if (prepared.ready) call.frozen.bound = prepared.bound;
        else reasons.push(...prepared.reasons);
    }
    return mutateShadowAudioCall(input.userId, input.requestId, (saved) => {
        if (saved) {
            sameRequest(saved, identity);
            return { call: saved };
        }
        return { call };
    });
}

export async function finishShadowAudioCall(call: ShadowAudioCall, input: { payload?: unknown; failure?: string; unavailable?: string }) {
    return finishObservation(call, { ...input, observation: call.protocol && input.payload !== undefined ? inspectAudioUsage(call.protocol, input.payload) : undefined });
}

/** The synchronous response is immutable; result, exact accrual and receipt commit together. */
async function finishObservation(call: ShadowAudioCall, input: { observation?: AudioUsageObservation; failure?: string; unavailable?: string }) {
    const completed = await mutateShadowAudioCall(call.userId, call.requestId, (saved, state) => {
        if (!saved) throw new PricingInputError("音频影子调用快照不存在");
        sameRequest(saved, call);
        if (saved.result) return { call: saved };
        const observation = saved.protocol ? input.observation : undefined;
        const reasons = [...saved.reasons, ...(input.failure ? [input.failure] : []), ...(input.unavailable ? [input.unavailable] : [])];
        const result: NonNullable<ShadowAudioCall["result"]> = { status: input.failure ? "failed" : "unpriced", reasons, completedAt: new Date().toISOString(), ...(observation ? { observation } : {}) };
        if (!observation) reasons.push("未取得完整的音频 JSON 用量");
        if (saved.frozen?.bound && observation && !reasons.length) {
            const { version, policy, contract, bound } = saved.frozen;
            const common = {
                version,
                policy,
                priceSelection: saved.frozen.priceSelection,
                observation,
                call: context(saved),
                responseComplete: true,
                userId: saved.userId,
                requestId: saved.requestId,
                requestFingerprint: saved.requestFingerprint,
                contractId: contract.id,
            };
            const prepared =
                contract.protocol === "openai-chat-audio" && bound.protocol === "openai-chat-audio"
                    ? prepareOpenAiAudioShadowPrice({ ...common, contract, bound })
                    : contract.protocol === "gemini-tts" && bound.protocol === "gemini-tts"
                      ? prepareAudioShadowPrice({ ...common, contract, bound })
                      : { ready: false as const, reasons: ["原音频契约与请求上界协议不一致"] };
            if (prepared.ready) {
                const receipt = prepared.build(state);
                return { call: { ...saved, result: { ...result, status: "priced", receiptId: receipt.id } }, receipt };
            }
            reasons.push(...prepared.reasons);
        }
        return { call: { ...saved, result } };
    });
    if (completed.result?.status === "priced") await observeMediaShadowRefund(completed.userId, completed.requestId);
    return completed;
}

/** Replay only the original private receipt after diagnostic persistence failure; never call upstream. */
export async function recoverAudioShadowResult(task: AudioTask | null | undefined) {
    if (!task?.billing?.pointsRecordId) return;
    const declaredProtocol = task.config.advancedConfig?.protocol;
    const protocol = declaredProtocol === "openai" && task.config.model === OPENAI_PRICED_AUDIO_MODEL ? "openai-chat-audio" : ["gemini", "dataeyes-gemini"].includes(declaredProtocol || "") && isGeminiTtsModel(task.config.model) ? "gemini-tts" : null;
    if (!protocol) return;
    const receipt = task.usageObservations?.find(
        (item) =>
            item.attemptNo === (task.attemptNo || 1) &&
            item.pointsRecordId === task.billing!.pointsRecordId &&
            item.channelId === task.config.channelId &&
            item.requestedModel === task.config.model &&
            item.logicalModel === generationModelId(task.config) &&
            item.observation.protocol === protocol,
    );
    if (!receipt) return;
    try {
        const source = await getShadowBillingSource({ recordId: receipt.pointsRecordId! });
        if (!source || source.userId !== task.userId || source.type !== "consume" || !source.idempotencyKey?.startsWith("system-ai:") || source.model !== receipt.logicalModel) return;
        const call = await getShadowAudioCall(task.userId, source.idempotencyKey);
        if (
            !call ||
            call.kind !== "audio" ||
            call.protocol !== protocol ||
            call.channelId !== receipt.channelId ||
            call.requestedModel !== receipt.requestedModel ||
            call.declaredProtocol !== task.config.advancedConfig?.protocol ||
            call.requestFingerprint !== source.requestFingerprint ||
            call.modelId !== source.model
        )
            return;
        if (!call.result) await finishObservation(call, { observation: receipt.observation });
        else if (call.result.status === "priced") await observeMediaShadowRefund(task.userId, source.idempotencyKey);
    } catch (error) {
        console.error("Audio shadow receipt recovery unavailable", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
}
