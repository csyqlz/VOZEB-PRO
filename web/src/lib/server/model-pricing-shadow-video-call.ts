import { isDeepStrictEqual } from "node:util";
import { PricingConflictError, PricingInputError, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { generationModelId } from "./generation-channel";
import { prepareVideoRequestPriceBound, type VideoPriceContract, type VideoPriceCallContext } from "./model-pricing-video-contract";
import { HAILUO_PRICE_MODELS, inspectHailuoObservation, prepareHailuoPriceBound, type HailuoPriceContract, type HailuoRequestBound, type HailuoObservation } from "./model-pricing-hailuo-contract";
import type { VideoRequestBound } from "./model-pricing-video-request";
import { inspectMinimaxVideoUsage, videoObservationProtocol, isTerminalVideoObservation, type VideoUsageObservation } from "./model-pricing-video-usage";
import { listVideoPriceContracts } from "./model-pricing-video-contract-store";
import { getCurrentSalesVersion } from "./model-pricing-store";
import { resolvePublishedModelPrice, type PublishedPriceSelection } from "./model-pricing-published-price";
import { getShadowVideoCall, mutateShadowVideoCall } from "./model-pricing-shadow-store";
import { prepareVideoShadowPrice, prepareHailuoShadowPrice } from "./model-pricing-shadow-service";
import { getShadowBillingSource, observeMediaShadowRefund } from "./model-pricing-shadow-refund";
import type { VideoTask } from "./video-task-store";

export type ShadowVideoCall = {
    kind: "video";
    userId: string;
    requestId: string;
    taskId?: string;
    requestPath?: string;
    requestFingerprint: string;
    modelId: string;
    channelId: string;
    requestedModel: string;
    protocol: "minimax-video-v2" | "minimax-hailuo-v1" | null;
    declaredProtocol?: string;
    startedAt: string;
    upstreamTaskId?: string;
    frozen?: { version: OfficialPriceVersion; policy: SalesVersion; priceSelection?: PublishedPriceSelection } & (
        { protocol: "minimax-video-v2"; contract: VideoPriceContract & { id: string }; bound?: VideoRequestBound } | { protocol: "minimax-hailuo-v1"; contract: HailuoPriceContract & { id: string }; bound?: HailuoRequestBound }
    );
    reasons: string[];
    observations: (VideoUsageObservation | HailuoObservation)[];
    result?: { status: "priced" | "unpriced" | "failed"; reasons: string[]; completedAt: string; receiptId?: string };
};
type BeginInput = Pick<ShadowVideoCall, "userId" | "requestId" | "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "declaredProtocol" | "taskId"> & { path: string[]; payload: unknown; adapted?: boolean };
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
function sameRequest(saved: ShadowVideoCall, input: Pick<ShadowVideoCall, "requestFingerprint" | "modelId" | "channelId" | "requestedModel" | "protocol" | "declaredProtocol">) {
    if (saved.kind !== "video" || (["requestFingerprint", "modelId", "channelId", "requestedModel", "protocol", "declaredProtocol"] as const).some((key) => saved[key] !== input[key])) throw new PricingConflictError("视频影子调用身份对应不同请求");
}
function context(call: ShadowVideoCall): VideoPriceCallContext {
    return {
        officialVersionId: call.frozen!.version.id,
        salesVersionId: call.frozen!.policy.id,
        logicalModelId: call.modelId,
        channelId: call.channelId,
        requestedModel: call.requestedModel,
        declaredProtocol: call.declaredProtocol || "",
        operation: "generation",
        region: "global",
        billingMode: "standard",
        occurredAt: call.startedAt,
    };
}

/** Pre-submit snapshot only. Missing prices stay missing even after an administrator publishes later. */
export async function beginShadowVideoCall(input: BeginInput): Promise<ShadowVideoCall> {
    if ([input.userId, input.requestId, input.requestFingerprint, input.modelId, input.channelId, input.requestedModel].some((value) => !value?.trim())) throw new PricingInputError("视频影子调用缺少稳定身份");
    const path = input.path.slice(-2).join("/");
    const protocol =
        !input.adapted && input.declaredProtocol === "minimax"
            ? path === "v2/video_generation" && ["MiniMax-H3", "MiniMax-H3-Max"].includes(input.requestedModel)
                ? ("minimax-video-v2" as const)
                : path === "v1/video_generation" && (HAILUO_PRICE_MODELS as readonly string[]).includes(input.requestedModel)
                  ? ("minimax-hailuo-v1" as const)
                  : null
            : null;
    const identity = { ...input, protocol };
    const existing = await getShadowVideoCall(input.userId, input.requestId);
    if (existing) {
        sameRequest(existing, identity);
        return existing;
    }
    const reasons: string[] = [];
    if (!protocol) reasons.push("视频协议尚无已验证的计价契约");
    const policy = await getCurrentSalesVersion();
    const published = await resolvePublishedModelPrice(input.modelId, "video", "generation", policy);
    const version = published?.version;
    if (!policy || !version) reasons.push("视频逻辑模型尚无已发布的官方价与用户售价");
    const contract = protocol && version ? (await listVideoPriceContracts(version.id, input.channelId, input.requestedModel)).find((item) => item.protocol === protocol && item.current) : undefined;
    if (protocol && version && !contract) reasons.push("该视频渠道与型号尚无已审核契约");
    const call: ShadowVideoCall = {
        kind: "video",
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
        observations: [],
    };
    if (policy && version && contract) {
        if (contract.protocol === "minimax-hailuo-v1") {
            call.frozen = { protocol: contract.protocol, policy, version, contract, ...(published?.selection ? { priceSelection: published.selection } : {}) };
            const prepared = prepareHailuoPriceBound({ ...call.frozen, call: context(call), payload: input.payload });
            if (prepared.ready) call.frozen.bound = prepared.bound;
            else reasons.push(...prepared.reasons);
        } else {
            call.frozen = { protocol: contract.protocol, policy, version, contract, ...(published?.selection ? { priceSelection: published.selection } : {}) };
            const prepared = prepareVideoRequestPriceBound({ ...call.frozen, call: context(call), payload: input.payload });
            if (prepared.ready) call.frozen.bound = prepared.bound;
            else reasons.push(...prepared.reasons);
        }
    }
    return mutateShadowVideoCall(input.userId, input.requestId, (saved) => {
        if (saved) {
            sameRequest(saved, identity);
            return { call: saved };
        }
        return { call };
    });
}

/** The task ID comes from the original create response, not an unrelated later query. */
export async function acknowledgeShadowVideoCall(call: ShadowVideoCall, input: { payload?: unknown; failure?: string; unavailable?: string }) {
    return mutateShadowVideoCall(call.userId, call.requestId, (saved) => {
        if (!saved) throw new PricingInputError("视频影子调用快照不存在");
        sameRequest(saved, call);
        const body = object(input.payload);
        const businessAccepted = saved.protocol !== "minimax-hailuo-v1" || object(body.base_resp).status_code === 0;
        const id = businessAccepted && !body.error && typeof body.task_id === "string" && body.task_id.trim() ? body.task_id : undefined;
        if (saved.upstreamTaskId && id && saved.upstreamTaskId !== id) throw new PricingConflictError("同一视频影子请求返回了不同上游任务");
        if (saved.upstreamTaskId || saved.result) return { call: saved };
        if (id && !input.failure && !input.unavailable) return { call: { ...saved, upstreamTaskId: id } };
        return { call: { ...saved, result: { status: input.failure ? "failed" : "unpriced", reasons: [...saved.reasons, input.failure || input.unavailable || "创建响应缺少已确认的原上游任务 ID"], completedAt: new Date().toISOString() } } };
    });
}

export async function finishShadowVideoCall(call: ShadowVideoCall, upstreamTaskId: string, payload: unknown) {
    return finishObservation(call, upstreamTaskId, call.protocol === "minimax-hailuo-v1" ? inspectHailuoObservation(payload, upstreamTaskId) : inspectMinimaxVideoUsage(payload, upstreamTaskId, call.requestedModel));
}

async function finishObservation(call: ShadowVideoCall, upstreamTaskId: string, observation: VideoUsageObservation | HailuoObservation) {
    if (!isTerminalVideoObservation(observation)) return call;
    const completed = await mutateShadowVideoCall(call.userId, call.requestId, (saved, state) => {
        if (!saved) throw new PricingInputError("视频影子调用快照不存在");
        sameRequest(saved, call);
        if (saved.protocol && saved.protocol !== observation.protocol) throw new PricingConflictError("视频回执协议与原调用不一致");
        if (!saved.upstreamTaskId || saved.upstreamTaskId !== upstreamTaskId || observation.upstreamTaskId !== upstreamTaskId) throw new PricingConflictError("视频终态不属于原创建任务");
        const observations = saved.observations.some((item) => isDeepStrictEqual(item, observation)) ? saved.observations : [...saved.observations, observation];
        if (saved.result?.status === "priced" || saved.result?.status === "failed") return { call: { ...saved, observations } };
        const reasons = [...saved.reasons];
        const failed = observation.status !== (observation.protocol === "minimax-hailuo-v1" ? "Success" : "succeeded");
        const verifiedFailure = observation.protocol === "minimax-hailuo-v1" ? !observation.invalid.length && !observation.missing.includes("base_resp.status_code") : observation.reportedModel === saved.requestedModel;
        const result: NonNullable<ShadowVideoCall["result"]> = { status: failed && verifiedFailure ? "failed" : "unpriced", reasons, completedAt: new Date().toISOString() };
        if (failed) reasons.push("原视频任务返回失败或取消终态");
        if (!failed && saved.frozen?.bound && !reasons.length) {
            const frozen = saved.frozen;
            const identity = { call: context(saved), upstreamTaskId, responseComplete: true, userId: saved.userId, requestId: saved.requestId, requestFingerprint: saved.requestFingerprint, contractId: frozen.contract.id };
            const prepared =
                frozen.protocol === "minimax-hailuo-v1" && frozen.bound && observation.protocol === frozen.protocol
                    ? prepareHailuoShadowPrice({ ...frozen, bound: frozen.bound, observation, ...identity })
                    : frozen.protocol === "minimax-video-v2" && frozen.bound && observation.protocol === frozen.protocol
                      ? prepareVideoShadowPrice({ ...frozen, bound: frozen.bound, observation, ...identity })
                      : { ready: false as const, reasons: ["视频回执不符合原冻结协议"] };
            if (prepared.ready) {
                const receipt = prepared.build(state);
                return { call: { ...saved, observations, result: { ...result, status: "priced", receiptId: receipt.id } }, receipt };
            }
            reasons.push(...prepared.reasons);
        }
        return { call: { ...saved, observations, result } };
    });
    if (completed.result?.status === "priced") await observeMediaShadowRefund(completed.userId, completed.requestId);
    return completed;
}

/** Private task queries rejoin the original server-owned fixed charge. Diagnostics never affect delivery. */
export async function observeVideoShadowResult(task: VideoTask, payload: unknown, queryPath: string) {
    if (!videoObservationProtocol(task, queryPath)) return;
    await observeTask(task, (call) => finishShadowVideoCall(call, task.upstream.id, payload));
}

/** Replay only private receipts for this exact attempt when media persistence resumes; never resubmit upstream. */
export async function recoverVideoShadowResult(task: VideoTask) {
    const receipts = (task.usageObservations || []).filter(
        (item) =>
            item.attemptNo === (task.attempts?.at(-1)?.attemptNo || 1) &&
            item.channelId === task.config.channelId &&
            item.upstreamTaskId === task.upstream.id &&
            item.pointsRecordId === task.upstream.pointsRecordId &&
            item.requestedModel === task.config.model &&
            item.logicalModel === generationModelId(task.config),
    );
    if (!receipts.length) return;
    await observeTask(task, async (call) => {
        for (const receipt of receipts) await finishObservation(call, task.upstream.id, receipt.observation);
    });
}

async function observeTask(task: VideoTask, finish: (call: ShadowVideoCall) => Promise<unknown>) {
    if (!task.upstream.pointsRecordId || task.config.advancedConfig?.protocol !== "minimax") return;
    try {
        const source = await getShadowBillingSource({ recordId: task.upstream.pointsRecordId });
        if (!source || source.userId !== task.userId || source.type !== "consume" || !source.idempotencyKey?.startsWith("system-ai:") || source.model !== generationModelId(task.config)) return;
        const call = await getShadowVideoCall(task.userId, source.idempotencyKey);
        if (!call || call.kind !== "video" || !call.protocol || call.channelId !== task.config.channelId || call.requestedModel !== task.config.model || call.requestFingerprint !== source.requestFingerprint || call.modelId !== source.model) return;
        await finish(call);
    } catch (error) {
        console.error("Video shadow query observation unavailable", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
}
