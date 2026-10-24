import { scheduleGenerationTask } from "./generation-task-scheduler";
import { resolveModelRequestTimeoutMs } from "./model-request-policy";
import { createVideoAttemptUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import { getAuthSettings } from "@/lib/auth/store";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";
import { finishGenerationAttempt } from "./generation-attempt";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "./generation-submission-error";
import { recoverPricedVideoTask, refundPricedVideoTask, videoPricingPendingMessage } from "./model-pricing-video-task";
import { advancePricedVideoTask, getVideoTask, saveVideoTaskCreation, updateVideoTask, videoTaskAttemptNo, type VideoTask } from "./video-task-store";

/** Resume saved candidates, never rediscover routes or repeat an uncertain submission. */
export async function createPricedVideoUpstream(id: string, userId: string, origin: string, cookie: string, creation?: NonNullable<VideoTask["creation"]>): Promise<VideoTask["upstream"]> {
    if (creation) await saveVideoTaskCreation(id, userId, creation);
    for (;;) {
        const task = await getVideoTask(id);
        if (!task || task.userId !== userId || task.billingMode !== "official-usage") throw new PricingInputError("视频计费任务不存在或无权访问");
        if (task.status !== "running") {
            if (task.status !== "success") await refundPricedVideoTask(task);
            throw new GenerationSubmissionUncertainError("原视频任务已结束，不能再次提交");
        }
        if (!task.creation || !videoTaskAttemptNo(task)) throw new GenerationSubmissionUncertainError(videoPricingPendingMessage);
        const reference = task.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(task));
        let failure: GenerationSubmissionSafeFailure | undefined;
        if (reference) {
            const recovered = await recoverPricedVideoTask(task);
            if (recovered?.state === "failed") failure = new GenerationSubmissionSafeFailure(recovered.error);
            else if (!creation && (recovered?.state === "pending" || recovered?.state === "result_ready")) return (await getVideoTask(id))!.upstream;
            else throw new GenerationSubmissionUncertainError(videoPricingPendingMessage);
        } else if (task.attempts?.at(-1)?.status === "failed") failure = new GenerationSubmissionSafeFailure(task.attempts.at(-1)!.error || "原视频尝试已结束");
        if (!failure) {
            try {
                const request = task.creation;
                const submittedAt = Date.now();
                await scheduleGenerationTask("video", id, {
                    executionPhase: "submitting",
                    channelId: task.config.channelId,
                    provider: task.config.advancedConfig?.protocol,
                    submittedAt,
                    nextPollAt: submittedAt + resolveModelRequestTimeoutMs(task.config, "video"),
                    lastUpstreamStatus: "submitting",
                });
                const upstream = await createVideoAttemptUpstream(
                    userId,
                    origin,
                    cookie,
                    task.config,
                    request.prompt,
                    request.parameters,
                    request.references,
                    (await getAuthSettings()).generationPointMultipliers,
                    `video-task:${task.id}:attempt:${videoTaskAttemptNo(task)}`,
                    task,
                );
                await updateVideoTask(id, { upstream }, videoTaskAttemptNo(task));
                await scheduleGenerationTask("video", id, {
                    executionPhase: "submitted",
                    upstreamTaskId: upstream.id,
                    channelId: task.config.channelId,
                    queryPath: upstream.queryPath || task.config.advancedConfig?.queryPath || upstream.pollPath,
                    submittedAt,
                    nextPollAt: Date.now(),
                    lastUpstreamStatus: "submitted",
                });
                return upstream;
            } catch (error) {
                if (!(error instanceof GenerationSubmissionSafeFailure)) throw error;
                failure = error;
            }
        }
        // The wallet fence must finish before a durable failure can advance to another candidate.
        const failed = await getVideoTask(id);
        if (!failed || failed.status !== "running" || videoTaskAttemptNo(failed) !== videoTaskAttemptNo(task)) throw new GenerationSubmissionUncertainError("原视频尝试已变化，计费待核对");
        const failedReference = failed.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(failed));
        if (failedReference?.preparation?.phase === "preparing" || !(await refundPricedVideoTask({ ...failed, status: "error" }))) throw new GenerationSubmissionUncertainError(videoPricingPendingMessage);
        if (task.attempts?.at(-1)?.status !== "failed") await updateVideoTask(id, { attempts: finishGenerationAttempt(task.attempts || [], videoTaskAttemptNo(task)!, { status: "failed", error: failure.message }) }, videoTaskAttemptNo(task));
        const latest = await getVideoTask(id);
        const latestReference = latest?.billingRequests?.find((item) => item.attemptNo === videoTaskAttemptNo(latest));
        if (!latest?.candidateConfigs?.length || latestReference?.review || latestReference?.preparationStop) throw failure;
        try {
            await advancePricedVideoTask(id, videoTaskAttemptNo(task)!);
        } catch (error) {
            if (error instanceof PricingConflictError) throw new GenerationSubmissionUncertainError(error.message);
            throw error;
        }
    }
}
