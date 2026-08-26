import type { AdminGenerationChannel, AdminGenerationOperationsPayload, AdminGenerationTask } from "@/lib/admin-generation-operations";
import { findPublicUserIdsByKeyword, getAuthSettings, getPublicUsersByIds } from "@/lib/auth/store";
import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import { getChannelRuntimeHealth, isChannelRuntimeCooling } from "@/lib/server/channel-runtime-health";
import {
    generationTaskPointsCost,
    listStoredGenerationTaskRecords,
    listStoredGenerationTaskRecordsByRunIds,
    summarizeStoredAgentPerformance,
    type GenerationTaskRecordListOptions,
    type StoredGenerationTaskRecord,
} from "@/lib/server/generation-task-store";
import { getTextPlanningRuntime } from "@/lib/server/text-planning-runtime";
import { resolveGenerationReviewReason } from "@/lib/server/generation-task-review-reason";
import { getDatabaseProvider } from "@/lib/server/database";

export async function listAdminGenerationOperations(options: GenerationTaskRecordListOptions): Promise<AdminGenerationOperationsPayload> {
    const settingsPromise = getAuthSettings();
    const searchUserIds = options.search?.trim() && getDatabaseProvider() === "file" ? await findPublicUserIdsByKeyword(options.search) : [];
    const [result, agentPerformance] = await Promise.all([listStoredGenerationTaskRecords({ ...options, searchUserIds, includeAll: false }), summarizeStoredAgentPerformance({ ...options, searchUserIds })]);
    const agentRunIds = result.items.filter((record) => record.type === "agent").map((record) => record.id);
    const pageUserIds = Array.from(new Set(result.items.map((record) => record.userId)));
    const [settings, users, childRecords] = await Promise.all([settingsPromise, getPublicUsersByIds(pageUserIds), listStoredGenerationTaskRecordsByRunIds(agentRunIds, pageUserIds)]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const childrenByRunId = new Map<string, StoredGenerationTaskRecord[]>();
    for (const child of childRecords) {
        if (!child.runId) continue;
        childrenByRunId.set(child.runId, [...(childrenByRunId.get(child.runId) || []), child]);
    }
    const items = result.items.map((record) => taskSummary(record, usersById.get(record.userId), childrenByRunId.get(record.id) || []));
    return {
        items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        summary: result.summary,
        channels: channelSummaries(settings),
        agentPerformance,
    };
}

function taskSummary(record: StoredGenerationTaskRecord, user?: { accountId: string; username: string; displayName: string }, childRecords: StoredGenerationTaskRecord[] = []): AdminGenerationTask {
    const payload = record.payload;
    const config = object(payload.config);
    const upstream = object(payload.upstream);
    const plannerAudit = agentPlannerAudit(payload.plannerAudit);
    const plannerRuntime = record.type === "agent" ? agentPlannerRuntime(payload) : undefined;
    const agentFailure = record.type === "agent" ? agentFailureSummary(payload) : undefined;
    const tasks = Array.isArray(payload.tasks) ? payload.tasks.map(object) : [];
    const failedTask = tasks.find((task) => task.status === "failed" && text(task.id));
    const model = firstText(plannerAudit?.logicalModelId, payload.logicalModelId, payload.model, config.model, config.imageModel, config.videoModel, config.audioModel, upstream.model, tasks.find((task) => text(task.model))?.model);
    const ownPointsCost = generationTaskPointsCost(payload);
    const childPointsCost = childRecords.reduce((total, child) => total + generationTaskPointsCost(child.payload), 0);
    const pointsBreakdown =
        record.type === "agent"
            ? {
                  planner: roundedPoints(plannerAudit?.pointsCost ?? ownPointsCost),
                  childTasks: roundedPoints(childPointsCost),
                  total: roundedPoints((plannerAudit?.pointsCost ?? ownPointsCost) + childPointsCost),
              }
            : undefined;
    const pointsCost = pointsBreakdown?.total ?? roundedPoints(ownPointsCost);
    return {
        id: record.id,
        userId: record.userId,
        accountId: user?.accountId,
        username: user?.username || "",
        displayName: user?.displayName || user?.username || "用户信息不可用",
        type: record.type,
        status: record.status,
        surface: record.surface,
        conversationId: record.conversationId,
        runId: record.runId,
        projectId: record.projectId,
        parentTaskId: record.parentTaskId,
        attemptNo: record.attemptNo,
        model,
        channelId: firstText(plannerAudit?.channelId, payload.channelId, config.channelId, upstream.channelId),
        provider: record.provider,
        queryPath: record.queryPath,
        executionPhase: record.executionPhase,
        workerId: record.workerId,
        leaseUntil: record.leaseUntil,
        lastHeartbeatAt: record.lastHeartbeatAt,
        nextPollAt: record.nextPollAt,
        lastPollAt: record.lastPollAt,
        leaseExpired: isGenerationLeaseExpired(record),
        upstreamTaskId: record.upstreamTaskId || firstText(upstream.id) || undefined,
        lastUpstreamStatus: record.lastUpstreamStatus,
        attempts: generationAttempts(payload.attempts),
        prompt: firstText(payload.prompt, config.prompt, tasks.find((task) => text(task.prompt))?.prompt).slice(0, 500),
        error: firstText(agentFailure?.message, payload.error, tasks.find((task) => text(task.error))?.error, resolveGenerationReviewReason(record)).slice(0, 1000) || undefined,
        durationMs: Math.max(0, record.updatedAt - record.createdAt),
        pointsCost,
        pointsBreakdown,
        plannerAudit,
        plannerRuntime,
        agentFailure,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        canCancel: record.status === "pending" || record.status === "running" || record.status === "paused",
        retryTaskId: record.type === "agent" ? text(failedTask?.id) || undefined : undefined,
        canReview: record.executionPhase === "needs_review" && (record.type === "text" || record.type === "image" || record.type === "video" || record.type === "audio"),
    };
}

function agentPlannerRuntime(payload: Record<string, unknown>): AdminGenerationTask["plannerRuntime"] {
    const timings = object(payload.timings);
    const context = object(payload.plannerContext);
    const planningStartedAt = finiteNumber(timings.planningStartedAt);
    const plannerFirstByteAt = finiteNumber(timings.plannerFirstByteAt);
    const planningCompletedAt = finiteNumber(timings.planningCompletedAt);
    const firstByteMs = stageDuration(planningStartedAt, plannerFirstByteAt);
    const planningMs = stageDuration(planningStartedAt, planningCompletedAt);
    const serializedChars = nonNegativeInteger(context.serializedChars);
    const transport = payload.plannerStreamMode === "stream" || payload.plannerStreamMode === "complete" ? payload.plannerStreamMode : undefined;
    const fallbackReason = text(payload.plannerStreamFallbackReason).slice(0, 500) || undefined;
    if (!transport && firstByteMs === undefined && planningMs === undefined && serializedChars === undefined && !fallbackReason) return undefined;
    return {
        ...(transport ? { transport } : {}),
        ...(firstByteMs !== undefined ? { firstByteMs } : {}),
        ...(planningMs !== undefined ? { planningMs } : {}),
        ...(serializedChars !== undefined ? { serializedChars } : {}),
        ...(fallbackReason ? { fallbackReason } : {}),
    };
}

function agentFailureSummary(payload: Record<string, unknown>): AdminGenerationTask["agentFailure"] {
    const message = text(payload.failure).slice(0, 1000);
    const stage = payload.failureStage === "planning" || payload.failureStage === "task_execution" || payload.failureStage === "refund" ? payload.failureStage : undefined;
    if (!message || !stage) return undefined;
    const candidates = Array.isArray(payload.candidateFailures)
        ? payload.candidateFailures.slice(0, 12).flatMap((value) => {
              const candidate = object(value);
              const channelId = text(candidate.channelId);
              const upstreamModel = text(candidate.upstreamModel);
              const error = text(candidate.error).slice(0, 500);
              return channelId && upstreamModel && error ? [{ channelId, upstreamModel, error }] : [];
          })
        : [];
    return { stage, message, candidates };
}

export function isGenerationLeaseExpired(record: Pick<StoredGenerationTaskRecord, "status" | "leaseUntil">, now = Date.now()) {
    return (record.status === "pending" || record.status === "running") && typeof record.leaseUntil === "number" && Number.isFinite(record.leaseUntil) && record.leaseUntil <= now;
}

function channelSummaries(settings: Awaited<ReturnType<typeof getAuthSettings>>): AdminGenerationChannel[] {
    const channels = new Map(settings.systemChannels.map((channel) => [channel.id, channel]));
    return settings.logicalModels.flatMap((model) =>
        model.bindings.map((binding) => {
            const channel = channels.get(binding.channelId);
            const planning = model.capability === "text" && channel ? getTextPlanningRuntime({ channelId: channel.id, upstreamModel: binding.upstreamModel, channel }) : undefined;
            return {
                id: channel?.id || binding.channelId,
                name: channel?.name || binding.channelId,
                capability: model.capability,
                logicalModelId: model.id,
                logicalModelName: model.name,
                upstreamModel: binding.upstreamModel,
                enabled: Boolean(model.enabled && binding.enabled && channel?.enabled),
                runtimeHealth: (() => {
                    const health = getChannelRuntimeHealth(channel?.id || binding.channelId, model.capability);
                    return {
                        status: isChannelRuntimeCooling(channel?.id || binding.channelId, model.capability) ? ("cooling" as const) : ("healthy" as const),
                        consecutiveFailures: health.consecutiveFailures,
                        cooldownUntil: health.cooldownUntil,
                        lastError: health.lastError,
                    };
                })(),
                ...(planning
                    ? {
                          planningRuntime: {
                              protocol: planning.preferred,
                              successCount: planning.successCount,
                              failureCount: planning.failureCount,
                              averageLatencyMs: planning.averageLatencyMs,
                          },
                      }
                    : {}),
            };
        }),
    );
}

function firstText(...values: unknown[]) {
    return values.map(text).find(Boolean) || "";
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function generationAttempts(value: unknown): GenerationAttempt[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
            attemptNo: Number(item.attemptNo) || 0,
            channelId: text(item.channelId) || undefined,
            model: text(item.model),
            status: (item.status === "succeeded" || item.status === "failed" ? item.status : "running") as GenerationAttempt["status"],
            startedAt: Number(item.startedAt) || 0,
            completedAt: Number(item.completedAt) || undefined,
            pointsCost: Number(item.pointsCost) > 0 ? Number(item.pointsCost) : undefined,
            error: text(item.error) || undefined,
        }));
}

function agentPlannerAudit(value: unknown): AdminGenerationTask["plannerAudit"] {
    const source = object(value);
    const mode = source.mode === "direct" || source.mode === "model" ? source.mode : undefined;
    const schemaVersion = Number(source.schemaVersion);
    if (!mode || !Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) return undefined;
    const protocol = source.protocol === "responses" || source.protocol === "chat" || source.protocol === "gemini" || source.protocol === "custom" ? source.protocol : undefined;
    const skills = Array.isArray(source.skills)
        ? source.skills.flatMap((value) => {
              const skill = object(value);
              const id = text(skill.id);
              const name = text(skill.name);
              return id && name
                  ? [
                        {
                            id,
                            name,
                            ...(text(skill.sourceVersion) ? { sourceVersion: text(skill.sourceVersion) } : {}),
                            ...(text(skill.sourceCommit) ? { sourceCommit: text(skill.sourceCommit) } : {}),
                            ...(text(skill.sourceContentHash) ? { sourceContentHash: text(skill.sourceContentHash) } : {}),
                        },
                    ]
                  : [];
          })
        : [];
    return {
        schemaVersion,
        mode,
        ...(text(source.logicalModelId) ? { logicalModelId: text(source.logicalModelId) } : {}),
        ...(text(source.channelId) ? { channelId: text(source.channelId) } : {}),
        ...(text(source.upstreamModel) ? { upstreamModel: text(source.upstreamModel) } : {}),
        ...(protocol ? { protocol } : {}),
        ...(Number.isFinite(Number(source.elapsedMs)) && Number(source.elapsedMs) >= 0 ? { elapsedMs: Number(source.elapsedMs) } : {}),
        ...(Number.isFinite(Number(source.pointsCost)) && Number(source.pointsCost) >= 0 ? { pointsCost: Number(source.pointsCost) } : {}),
        skills,
    };
}

function roundedPoints(value: number) {
    return Number(value.toFixed(2));
}

function stageDuration(start?: number, end?: number) {
    return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}

function finiteNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
