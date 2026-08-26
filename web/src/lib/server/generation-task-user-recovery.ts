import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import type { GenerationTaskType } from "@/lib/server/generation-task-types";

type RecoverableGenerationTaskType = Exclude<GenerationTaskType, "agent">;

export async function recoverGenerationTaskFromUpstream(input: {
    type: RecoverableGenerationTaskType;
    id: string;
    upstreamTaskId: string;
    channelId?: string;
    provider?: string;
    queryPath?: string;
    submittedAt: number;
    origin: string;
    publicOrigin?: string;
    cookie?: string;
}) {
    const rearmed = await scheduleGenerationTask(input.type, input.id, {
        executionPhase: "polling",
        upstreamTaskId: input.upstreamTaskId,
        channelId: input.channelId,
        provider: input.provider,
        queryPath: input.queryPath,
        submittedAt: input.submittedAt,
        nextPollAt: Date.now(),
        lastUpstreamStatus: "user_recovery_requested",
    });
    if (!rearmed) return false;

    const recoveryInput = {
        origin: input.origin,
        publicOrigin: input.publicOrigin || input.origin,
        cookie: input.cookie || "",
        limit: 1,
        taskIds: [input.id],
        userRequested: true,
    };
    await runGenerationTaskRecoveryBatch(recoveryInput);
    if ((await getStoredGenerationTaskRecord(input.type, input.id))?.executionPhase === "result_ready") {
        await runGenerationTaskRecoveryBatch(recoveryInput);
    }

    const latest = await getStoredGenerationTaskRecord(input.type, input.id);
    const latestPhase = latest?.executionPhase;
    if (latest && latestPhase && (latest.status === "pending" || latest.status === "running") && ["submitted", "polling", "result_ready", "persisting"].includes(latestPhase)) {
        const resultReady = latestPhase === "result_ready" || latestPhase === "persisting";
        await scheduleGenerationTask(input.type, input.id, {
            executionPhase: "needs_review",
            nextPollAt: undefined,
            lastUpstreamStatus: latest.lastUpstreamStatus || "user_check_pending",
            resultPayload: {
                ...(latest.resultPayload || {}),
                reviewReason: resultReady ? "上游结果已返回，本次未能完成本地保存，请再次点击“检查状态”继续保存" : "上游任务仍在处理中，请稍后点击“检查状态”继续查询原任务",
            },
        });
    }
    return true;
}
