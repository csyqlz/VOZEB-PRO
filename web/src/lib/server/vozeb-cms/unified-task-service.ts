import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import { cancellationExecutionPatch, type GenerationCancellationTarget } from "@/lib/server/generation-task-cancellation-service";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { generationTaskPointsCost, getStoredGenerationTaskRecordForUser, linkStoredGenerationTask, mutateStoredGenerationTask, type StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import type { GenerationTaskStatus, GenerationTaskType } from "@/lib/server/generation-task-types";
import { recoverGenerationTaskFromUpstream } from "@/lib/server/generation-task-user-recovery";
import type { SystemGenerationChannelConfig } from "@/lib/server/generation-channel";
import { refundAudioTask } from "@/lib/server/audio-task-refund";
import type { AudioTask } from "@/lib/server/audio-task-store";
import { refundImageTask } from "@/lib/server/image-task-refund";
import type { ImageTask } from "@/lib/server/image-task-store";
import { refundTextTask } from "@/lib/server/text-task-refund";
import type { TextTask } from "@/lib/server/text-task-store";
import { refundVideoTask } from "@/lib/server/video-task-refund";
import type { VideoTask } from "@/lib/server/video-task-store";
import { listEnabledVozebCmsCapabilities } from "@/lib/server/vozeb-cms/module-service";
import { getVozebCmsWorkflowRun } from "@/lib/server/vozeb-cms/workflow-store";
import type { VozebCmsProjectRef } from "@/lib/vozeb-cms/project-ref";
import type { VozebCmsResourcePage, VozebCmsTask, VozebCmsTaskStatus, VozebCmsTaskType } from "@/lib/vozeb-cms/unified-resource-contract";
import type { VozebCmsWorkflowRun, VozebCmsWorkflowRunStatus } from "@/lib/vozeb-cms/workflow-contract";
import { decodeVozebCmsResourceCursor, encodeVozebCmsResourceCursor } from "./unified-resource-cursor";
import { listVozebCmsUnifiedTaskRecords, type VozebCmsUnifiedTaskRecord } from "./unified-task-store";

const GENERATION_TYPES: GenerationTaskType[] = ["text", "image", "video", "audio", "agent", "render"];

export async function listVozebCmsTaskPage(
    userId: string,
    input: { projectId?: string; projectRef?: VozebCmsProjectRef; type?: VozebCmsTaskType; status?: VozebCmsTaskStatus; cursor?: string; limit?: number } = {},
): Promise<VozebCmsResourcePage<VozebCmsTask>> {
    const cursor = decodeVozebCmsResourceCursor(input.cursor);
    if (input.cursor && !cursor) throw new VozebCmsTaskQueryError("任务游标无效", 400);
    const enabled = new Set((await listEnabledVozebCmsCapabilities()).map((capability) => capability.id));
    const allowedGenerationTypes = GENERATION_TYPES.filter((type) => enabled.has(vozebCmsTaskCapabilityId(type)));
    const generationTypes = input.type === "workflow" ? [] : input.type ? (allowedGenerationTypes.includes(input.type as GenerationTaskType) ? [input.type as GenerationTaskType] : []) : allowedGenerationTypes;
    const includeWorkflow = input.type !== "workflow" ? !input.type && enabled.has("workflow.run") : enabled.has("workflow.run");
    const generationStatuses = generationStatusesFor(input.status);
    const workflowStatuses = workflowStatusesFor(input.status);
    const limit = boundedLimit(input.limit, 50);
    const result = await listVozebCmsUnifiedTaskRecords({
        userId,
        projectId: clean(input.projectRef?.id || input.projectId),
        generationTypes: generationStatuses === null ? [] : generationTypes,
        ...(generationStatuses?.length ? { generationStatuses } : {}),
        includeWorkflow: includeWorkflow && workflowStatuses !== null,
        ...(workflowStatuses?.length ? { workflowStatuses } : {}),
        cursor,
        limit,
    });
    const items = result.items.map((record) => toTask(record, input.projectRef));
    const last = items.at(-1);
    const lastRecord = result.items.at(-1);
    return {
        items,
        total: result.total,
        limit,
        ...(result.hasMore && last && lastRecord ? { nextCursor: encodeVozebCmsResourceCursor({ time: Date.parse(last.updated_at || last.created_at), source: last.source, id: lastRecord.id }) } : {}),
    };
}

export async function listVozebCmsTasks(userId: string, input: Parameters<typeof listVozebCmsTaskPage>[1] = {}) {
    return (await listVozebCmsTaskPage(userId, input)).items;
}

export async function getVozebCmsTask(userId: string, id: string, projectRef?: VozebCmsProjectRef) {
    const record = await getStoredGenerationTaskRecordForUser(id, userId);
    if (record) return toGenerationTask(record, projectRef);
    const runtime = await import("@/lib/server/vozeb-cms/workflow-runtime");
    const run = await runtime.getRecoverableVozebCmsWorkflowRun(userId, id);
    return run ? toWorkflowTask(run, projectRef) : null;
}

export type VozebCmsTaskAction = "cancel" | "recover" | "retry";

export async function controlVozebCmsTask(input: { userId: string; id: string; action: VozebCmsTaskAction; origin: string; cookie?: string; publicOrigin?: string }) {
    const record = await getStoredGenerationTaskRecordForUser(input.id, input.userId);
    if (record) {
        if (input.action === "cancel") return cancelTask(record);
        if (input.action === "retry") return retryTask(record);
        return recoverTask(record, input);
    }
    const run = await getVozebCmsWorkflowRun(input.userId, input.id);
    if (!run) throw new VozebCmsTaskActionError("任务不存在或已过期", 404);
    const runtime = await import("@/lib/server/vozeb-cms/workflow-runtime");
    if (input.action === "cancel") return runtime.controlVozebCmsWorkflowRun(input.userId, input.id, "cancel");
    if (input.action === "retry") return runtime.controlVozebCmsWorkflowRun(input.userId, input.id, "retry");
    if (run.status === "paused" || run.status === "waiting") return runtime.controlVozebCmsWorkflowRun(input.userId, input.id, "resume");
    if (run.status === "pending" || run.status === "running") return runtime.advanceVozebCmsWorkflowRun(input.userId, input.id);
    throw new VozebCmsTaskActionError("当前工作流无法恢复");
}

export class VozebCmsTaskQueryError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

export class VozebCmsTaskActionError extends Error {
    constructor(
        message: string,
        readonly status = 409,
    ) {
        super(message);
    }
}

export function vozebCmsTaskCapabilityId(type: VozebCmsTaskType | GenerationTaskType) {
    if (type === "image") return "image.generate";
    if (type === "video") return "video.generate";
    if (type === "audio") return "audio.generate";
    if (type === "text") return "text.generate";
    if (type === "agent") return "agent.run";
    if (type === "render") return "drama.workflow.run";
    if (type === "workflow") return "workflow.run";
    return "asset.manage";
}

async function cancelTask(record: StoredGenerationTaskRecord) {
    if (!(record.status === "pending" || record.status === "running" || record.status === "paused")) throw new VozebCmsTaskActionError("当前任务无法取消");
    const next = await mutateStoredGenerationTask<GenerationTaskPayload>(record.type, record.id, GENERATION_TASK_RETENTION_MS, (current) => ({ ...current, status: "cancelled", error: "任务已取消", retryable: false }));
    if (!next) throw new VozebCmsTaskActionError("任务状态已变化，请刷新后重试");
    if (record.type === "text" || record.type === "image" || record.type === "video" || record.type === "audio") {
        const target: GenerationCancellationTarget = {
            type: record.type,
            taskId: record.id,
            userId: record.userId,
            executionPhase: record.executionPhase || "created",
            upstreamTaskId: record.upstreamTaskId || upstreamId(record),
            queryPath: record.queryPath || upstreamQueryPath(record),
            config: (record.payload.config || {}) as SystemGenerationChannelConfig,
        };
        await scheduleGenerationTask(record.type, record.id, cancellationExecutionPatch(target));
    } else {
        await scheduleGenerationTask(record.type, record.id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "cancelled" }, { cancellation: true });
    }
    return getStoredGenerationTaskRecordForUser(record.id, record.userId);
}

async function retryTask(record: StoredGenerationTaskRecord) {
    if (record.status !== "error" || record.payload.retryable !== true) throw new VozebCmsTaskActionError("当前任务不可重试");
    if (!(record.type === "text" || record.type === "image" || record.type === "video" || record.type === "audio")) throw new VozebCmsTaskActionError("当前任务类型不支持重试");
    const current = await getStoredGenerationTaskRecordForUser(record.id, record.userId);
    if (!current || current.type !== record.type || current.status !== "error" || current.payload.retryable !== true) throw new VozebCmsTaskActionError("任务状态已变化，请刷新后重试");
    const refunded = await refundTaskAttempt(current);
    const attemptNo = nextAttemptNo(refunded);
    const next = await mutateStoredGenerationTask<GenerationTaskPayload>(record.type, record.id, GENERATION_TASK_RETENTION_MS, (value) => (value.status === "error" && value.retryable === true ? retryPayload(record.type, value, attemptNo) : null));
    if (!next) throw new VozebCmsTaskActionError("任务状态已变化，请刷新后重试");
    await linkStoredGenerationTask(record.type, record.id, { attemptNo, clientRequestId: record.clientRequestId });
    await scheduleGenerationTask(record.type, record.id, { executionPhase: "created", nextPollAt: Date.now(), lastUpstreamStatus: "user_retry" }, { resetUpstreamIdentity: true });
    return getStoredGenerationTaskRecordForUser(record.id, record.userId);
}

type RetryableGenerationTask = ImageTask | VideoTask | AudioTask | TextTask;
type GenerationTaskPayload = StoredGenerationTaskRecord["payload"] & { id: string; userId: string; status: string; createdAt: number; updatedAt: number };

async function refundTaskAttempt(record: StoredGenerationTaskRecord): Promise<RetryableGenerationTask> {
    if (record.type === "image") return refundImageTask(record.payload as ImageTask);
    if (record.type === "video") return refundVideoTask(record.payload as VideoTask);
    if (record.type === "audio") return refundAudioTask(record.payload as AudioTask);
    return refundTextTask(record.payload as TextTask);
}

function nextAttemptNo(task: RetryableGenerationTask) {
    const attempts = Array.isArray(task.attempts) ? task.attempts : [];
    return Math.max(0, Number(task.attemptNo || 0), ...attempts.map((attempt) => Number(attempt.attemptNo || 0))) + 1;
}

function retryPayload(type: StoredGenerationTaskRecord["type"], current: GenerationTaskPayload, attemptNo: number): GenerationTaskPayload {
    const upstream = object(current.upstream);
    const attempts = preserveAttemptBilling(Array.isArray(current.attempts) ? (current.attempts as GenerationAttempt[]) : [], current);
    return { ...current, status: type === "video" ? "running" : "pending", attemptNo, upstream: type === "video" ? videoRetryUpstream(upstream) : undefined, result: undefined, error: undefined, retryable: false, billing: undefined, attempts };
}

function preserveAttemptBilling(attempts: GenerationAttempt[], current: StoredGenerationTaskRecord["payload"]): GenerationAttempt[] {
    const attemptNo = Math.max(1, Number(current.attemptNo || attempts.at(-1)?.attemptNo || 1));
    const billing = object(current.billing);
    const upstream = object(current.upstream);
    const pointsCost = positiveNumber(billing.pointsCost, upstream.pointsCost);
    const pointsRecordId = cleanText(billing.pointsRecordId) || cleanText(upstream.pointsRecordId);
    if (pointsCost === undefined && !pointsRecordId) return attempts;
    let found = false;
    const next = attempts.map((attempt) => {
        if (attempt.attemptNo !== attemptNo) return attempt;
        found = true;
        return { ...attempt, ...(pointsCost !== undefined ? { pointsCost } : {}), ...(pointsRecordId ? { pointsRecordId } : {}) };
    });
    if (found) return next;
    return [
        ...next,
        {
            attemptNo,
            channelId: cleanText(object(current.config).channelId),
            model: cleanText(object(current.config).model) || cleanText(upstream.model) || "unknown",
            status: "failed",
            startedAt: Number(current.createdAt) || Date.now(),
            completedAt: Number(current.updatedAt) || Date.now(),
            ...(pointsCost !== undefined ? { pointsCost } : {}),
            ...(pointsRecordId ? { pointsRecordId } : {}),
            ...(cleanText(current.error) ? { error: cleanText(current.error) } : {}),
        },
    ];
}

function videoRetryUpstream(upstream: Record<string, unknown>): VideoTask["upstream"] {
    const provider = upstream.provider === "openai" || upstream.provider === "seedance" || upstream.provider === "generation" ? upstream.provider : "generation";
    return { id: "", provider, model: cleanText(upstream.model) || "unknown", ...(cleanText(upstream.pollPath) ? { pollPath: cleanText(upstream.pollPath) } : {}), ...(cleanText(upstream.queryPath) ? { queryPath: cleanText(upstream.queryPath) } : {}) };
}

async function recoverTask(record: StoredGenerationTaskRecord, input: { origin: string; publicOrigin?: string; cookie?: string }) {
    if (!(record.status === "running" || record.executionPhase === "needs_review")) throw new VozebCmsTaskActionError("当前任务无法继续检查");
    if (!(record.type === "text" || record.type === "image" || record.type === "video" || record.type === "audio")) throw new VozebCmsTaskActionError("当前任务类型不支持恢复");
    const upstreamTaskId = record.upstreamTaskId || upstreamId(record);
    if (!upstreamTaskId) throw new VozebCmsTaskActionError("原任务没有保存上游任务 ID，无法安全追回结果");
    const recovered = await recoverGenerationTaskFromUpstream({
        type: record.type,
        id: record.id,
        upstreamTaskId,
        channelId: record.channelId || textField(record.payload.config, "channelId"),
        provider: record.provider || textField(object(record.payload.config).advancedConfig, "protocol") || textField(record.payload.config, "apiFormat"),
        queryPath: record.queryPath || upstreamQueryPath(record),
        submittedAt: record.submittedAt || record.createdAt,
        origin: input.origin,
        publicOrigin: input.publicOrigin || input.origin,
        cookie: input.cookie || "",
    });
    if (!recovered) throw new VozebCmsTaskActionError("任务状态已变化，请刷新后重试");
    return getStoredGenerationTaskRecordForUser(record.id, record.userId);
}

function toTask(record: VozebCmsUnifiedTaskRecord, projectRef?: VozebCmsProjectRef): VozebCmsTask {
    return record.source === "generation" ? toGenerationTask(record.record, projectRef) : toWorkflowTask(record.run, projectRef);
}

function toGenerationTask(record: StoredGenerationTaskRecord, projectRef?: VozebCmsProjectRef): VozebCmsTask {
    const payload = record.payload || {};
    return {
        id: record.id,
        type: record.type,
        status: record.status,
        source: "generation",
        input: { prompt: payload.publicPrompt || payload.prompt, preferences: payload.preferences },
        output: payload.result || payload.results || payload.output || record.resultPayload,
        owner: record.userId,
        project_id: record.projectId,
        ...(projectRef ? { project_ref: { id: projectRef.id, type: projectRef.type } } : {}),
        cost: generationTaskPointsCost(payload),
        metadata: compactMetadata({
            conversationId: record.conversationId,
            runId: record.runId,
            surface: record.surface,
            sourceModule: sourceModule(record),
            episodeId: record.episodeId,
            shotId: record.shotId,
            parentTaskId: record.parentTaskId,
            attemptNo: record.attemptNo,
            executionPhase: record.executionPhase,
            upstreamTaskId: record.upstreamTaskId,
            lastUpstreamStatus: record.lastUpstreamStatus,
            retryable: payload.retryable === true,
        }),
        created_at: new Date(record.createdAt).toISOString(),
        updated_at: new Date(record.updatedAt).toISOString(),
        execution_phase: record.executionPhase,
        can_cancel: record.status === "pending" || record.status === "running" || record.status === "paused",
        can_retry: record.status === "error" && payload.retryable === true,
        can_recover: record.status === "running" || record.executionPhase === "needs_review",
    };
}

function toWorkflowTask(run: VozebCmsWorkflowRun, projectRef?: VozebCmsProjectRef): VozebCmsTask {
    const states = Object.values(run.nodeStates);
    const byStatus = states.reduce<Record<string, number>>((summary, state) => ({ ...summary, [state.status]: (summary[state.status] || 0) + 1 }), {});
    const resolvedRef = projectRef || run.projectRef;
    return {
        id: run.id,
        type: "workflow",
        status: workflowTaskStatus(run.status),
        source: "workflow",
        input: { workflowId: run.workflowId, projectId: run.projectId },
        ...(run.status === "completed" ? { output: { completedNodes: byStatus.success || 0, skippedNodes: byStatus.skipped || 0, totalNodes: states.length } } : {}),
        owner: run.userId,
        project_id: run.projectId,
        ...(resolvedRef ? { project_ref: { id: resolvedRef.id, type: resolvedRef.type } } : {}),
        cost: 0,
        metadata: compactMetadata({ workflowId: run.workflowId, definitionVersion: run.definitionVersion, runVersion: run.version, workflowStatus: run.status, nodeStatusCounts: byStatus, error: run.error }),
        created_at: new Date(run.createdAt).toISOString(),
        updated_at: new Date(run.updatedAt).toISOString(),
        execution_phase: run.status,
        can_cancel: run.status === "pending" || run.status === "running" || run.status === "waiting" || run.status === "paused",
        can_retry: run.status === "failed",
        can_recover: run.status === "pending" || run.status === "running" || run.status === "waiting" || run.status === "paused",
    };
}

function sourceModule(record: StoredGenerationTaskRecord) {
    if (record.surface === "drama") return "drama";
    if (record.surface === "canvas") return "canvas";
    return record.type === "image" || record.type === "video" ? record.type : "create";
}

function workflowTaskStatus(status: VozebCmsWorkflowRunStatus): VozebCmsTaskStatus {
    if (status === "completed") return "success";
    if (status === "failed") return "error";
    return status;
}

function generationStatusesFor(status?: VozebCmsTaskStatus): GenerationTaskStatus[] | null | undefined {
    if (!status) return undefined;
    if (status === "waiting") return null;
    return [status];
}

function workflowStatusesFor(status?: VozebCmsTaskStatus): VozebCmsWorkflowRunStatus[] | null | undefined {
    if (!status) return undefined;
    if (status === "success") return ["completed"];
    if (status === "error") return ["failed"];
    return [status];
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function upstreamId(record: StoredGenerationTaskRecord) {
    const upstream = object(record.payload.upstream);
    return typeof upstream.id === "string" ? upstream.id : undefined;
}

function upstreamQueryPath(record: StoredGenerationTaskRecord) {
    const upstream = object(record.payload.upstream);
    return typeof upstream.queryPath === "string" ? upstream.queryPath : typeof upstream.pollPath === "string" ? upstream.pollPath : undefined;
}

function textField(value: unknown, key: string) {
    const source = object(value);
    return typeof source[key] === "string" ? source[key]!.trim() : "";
}

function compactMetadata(values: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function clean(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function cleanText(value: unknown) {
    return typeof value === "string" ? value.trim() || undefined : undefined;
}

function positiveNumber(...values: unknown[]) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
    }
    return undefined;
}

function boundedLimit(value: unknown, fallback: number) {
    const limit = Number(value);
    return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : fallback;
}
