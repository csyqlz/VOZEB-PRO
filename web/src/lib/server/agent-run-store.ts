import { nanoid } from "nanoid";
import type { CreativeFoundation, CreativeReview } from "@/lib/creative-agent-contract";
import { CreativeRuntimeInputError, MAX_SNAPSHOT_BYTES, type CreativeAsset, type CreativeGenerationPreferences, type CreativeProjectHandoffPlan, type CreativeRunRequest, type CreativeSurface } from "@/lib/creative-runtime-contract";
import { extractImageSizeFromPrompt } from "@/lib/image-size";
import { videoFrameAssetIds, type VideoReferenceRole } from "@/lib/video-reference-contract";
import type { ProductProtectionRegions } from "./ecommerce-product-regions";
import type { EcommerceCompiledImageRequest } from "./ecommerce-image-compiler";
import { createCreativeRunBundle, getCreativeAssetsByIds, getCreativeRunByClientRequestId, mutateCreativeRun } from "./creative-runtime-store";
import { getStoredGenerationTask, queryStoredGenerationTasks } from "./generation-task-store";
import { cancelledRunCanvasOps, taskCanvasEventOps } from "./agent-run-canvas-ops";
import { agentRequirementAcknowledgement } from "@/lib/agent-requirement-acknowledgement";
import { agentTaskCompletionMessage } from "./agent-run-messages";
import type { AgentRunPlannerAudit } from "./agent-run-audit";
import { AGENT_REQUEST_SCHEMA } from "./agent-prompt-json";
import { normalizeAgentRunCanvasSnapshot, selectedCanvasNodeIds } from "./agent-run-canvas-snapshot";
import { getDramaProject } from "./drama-project-store";
import { getCanvasProject } from "./canvas-project-store";
import { ECOMMERCE_GENERATION_SNAPSHOT_VERSION, type EcommerceGenerationSnapshotRecord } from "./ecommerce-generation-snapshot";
import { toSafeGenerationErrorMessage } from "./generation-errors";

export type AgentRunStatus = "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type AgentRunReviewStatus = "review_pending" | "reviewing" | "review_completed" | "review_unavailable";
export type AgentRunFailureStage = "planning" | "task_execution" | "refund";
export type AgentRunCandidateFailure = { channelId: string; upstreamModel: string; error: string };
export type AgentRunReference = {
    assetId?: string;
    nodeId?: string;
    sourceTaskId?: string;
    url: string;
    type: "image" | "video" | "audio";
    role?: VideoReferenceRole;
    ecommerceRole?: "product" | "scene";
    width?: number;
    height?: number;
};
export type AgentRunChildTask = {
    id: string;
    status: "pending" | "needs_review" | "completed" | "failed" | "cancelled";
    attempt: number;
    result?: unknown;
    error?: string;
};
export type AgentRunTask = {
    id: string;
    targetNodeId?: string;
    referenceAssetId?: string;
    referenceUrl?: string;
    referenceType?: "image" | "video" | "audio";
    references?: AgentRunReference[];
    productProtectionRegions?: ProductProtectionRegions;
    sceneProtection?: import("./ecommerce-product-regions").SceneEditProtection;
    ecommerceExecution?: EcommerceCompiledImageRequest;
    title: string;
    type: "text" | "image" | "video" | "audio";
    model?: string;
    optimizedPrompt?: string;
    prompt: string;
    count: number;
    ratio?: string;
    quality?: string;
    seconds?: number;
    voice?: string;
    format?: string;
    generateAudio?: boolean;
    watermark?: boolean;
    speed?: number;
    dependencies: string[];
    status: "ready" | "running" | "needs_review" | "completed" | "failed" | "cancelled";
    attempts: number;
    taskId?: string;
    taskIds?: string[];
    childTasks?: AgentRunChildTask[];
    assetIds?: string[];
    result?: unknown;
    error?: string;
};
export type AgentRun = {
    id: string;
    userId: string;
    conversationId: string;
    clientRequestId: string;
    surface: CreativeSurface;
    projectId?: string;
    inputMessageId: string;
    assistantMessageId: string;
    prompt: string;
    publicPrompt?: string;
    snapshot?: unknown;
    referencedAssetIds: string[];
    selectedSkillIds?: string[];
    requestedModelIds?: string[];
    requestedImageSize?: string;
    generationPreferences?: CreativeGenerationPreferences;
    assetIds: string[];
    status: AgentRunStatus;
    executionId?: string;
    tasks: AgentRunTask[];
    foundation?: CreativeFoundation;
    projectHandoff?: CreativeProjectHandoffPlan;
    projectHandoffEmitted?: boolean;
    review?: CreativeReview;
    reviewed: boolean;
    reviewStatus?: AgentRunReviewStatus;
    reviewAttempts?: number;
    plannerContext?: AgentRunPlannerContextSummary;
    promptSchemaVersion?: typeof AGENT_REQUEST_SCHEMA;
    promptTransport?: "json" | "legacy";
    contextDigest?: string;
    plannerStreamMode?: "stream" | "complete";
    plannerStreamFallbackReason?: string;
    plannerAudit?: AgentRunPlannerAudit;
    ecommerceSnapshot?: EcommerceGenerationSnapshotRecord;
    cancellation?: AgentRunCancellation;
    failure?: string;
    failureStage?: AgentRunFailureStage;
    candidateFailures?: AgentRunCandidateFailure[];
    timings?: AgentRunTimings;
    createdAt: number;
    updatedAt: number;
};
export type AgentRunCancellation = {
    requestedAt: number;
    pendingChildTaskIds: string[];
    lastError?: string;
};
export type AgentRunPlannerContextSummary = {
    serializedChars: number;
    kept: { modelIds: string[]; skillIds: string[]; assetIds: string[]; recentMessageSequences: number[] };
    omitted: { modelIds: string[]; skillIds: string[]; assetIds: string[]; recentMessageSequences: number[] };
};
export type AgentRunTimings = {
    requestAcceptedAt: number;
    planningStartedAt?: number;
    plannerFirstByteAt?: number;
    planningCompletedAt?: number;
    firstTaskSubmittedAt?: number;
    firstResultReadyAt?: number;
    allResultsReadyAt?: number;
    reviewCompletedAt?: number;
    runCompletedAt?: number;
};
const TTL = 365 * 24 * 60 * 60 * 1000;
export const AGENT_RUN_TTL_MS = TTL;

export async function createAgentRun(userId: string, input: CreativeRunRequest) {
    await assertVideoFrameAssets(userId, input);
    const now = Date.now();
    const conversationId = input.conversationId || `conversation-${nanoid()}`;
    const snapshot =
        input.surface === "canvas" && input.projectId
            ? await resolveCanvasRunSnapshot(userId, input.projectId, input.snapshot)
            : input.surface === "drama" && input.projectId
              ? await resolveDramaRunSnapshot(userId, input.projectId, input.snapshot)
              : input.snapshot;
    const run: AgentRun = {
        id: `agent-${nanoid()}`,
        userId,
        conversationId,
        clientRequestId: input.clientRequestId,
        surface: input.surface,
        projectId: input.projectId,
        inputMessageId: `message-${nanoid()}`,
        assistantMessageId: `message-${nanoid()}`,
        prompt: input.prompt,
        promptSchemaVersion: AGENT_REQUEST_SCHEMA,
        promptTransport: "json",
        ...(input.publicPrompt ? { publicPrompt: input.publicPrompt } : {}),
        snapshot,
        referencedAssetIds: input.assetIds,
        selectedSkillIds: input.skillIds,
        ...(input.modelIds.length ? { requestedModelIds: input.modelIds } : {}),
        requestedImageSize: extractImageSizeFromPrompt(input.prompt) || undefined,
        ...(input.preferences ? { generationPreferences: input.preferences } : {}),
        assetIds: [],
        status: "planning",
        tasks: [],
        reviewed: false,
        timings: { requestAcceptedAt: now },
        createdAt: now,
        updatedAt: now,
    };
    const publicPrompt = input.publicPrompt || input.prompt;
    return createCreativeRunBundle(userId, {
        run,
        conversationId: input.conversationId,
        prompt: publicPrompt,
        title: publicPrompt.slice(0, 48),
        assetIds: input.assetIds,
        acknowledgement: agentRequirementAcknowledgement(publicPrompt, input.surface, input.assetIds.length > 0 || (input.surface === "canvas" && selectedCanvasNodeIds(snapshot).length > 0)),
        ttlMs: TTL,
    });
}

async function resolveCanvasRunSnapshot(userId: string, projectId: string, requestSnapshot: unknown) {
    const project = await getCanvasProject(projectId.trim(), userId);
    if (!project) throw new CreativeRuntimeInputError("画布项目不存在", 404);
    const requestBytes = requestSnapshot === undefined ? 0 : new TextEncoder().encode(JSON.stringify(requestSnapshot)).length;
    if (requestBytes <= MAX_SNAPSHOT_BYTES) return normalizeAgentRunCanvasSnapshot(requestSnapshot, projectId);
    const transient = record(requestSnapshot);
    const snapshot = normalizeAgentRunCanvasSnapshot(
        {
            ...project,
            ...(Array.isArray(transient.selectedNodeIds) ? { selectedNodeIds: transient.selectedNodeIds } : {}),
            ...(typeof transient.imageSize === "string" && transient.imageSize.trim() ? { imageSize: transient.imageSize.trim() } : {}),
        },
        project.id,
    );
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_SNAPSHOT_BYTES) throw new CreativeRuntimeInputError("当前项目快照过大", 413);
    return snapshot;
}

async function resolveDramaRunSnapshot(userId: string, projectId: string, requestSnapshot: unknown) {
    const project = await getDramaProject(projectId.trim(), userId);
    if (!project) throw new CreativeRuntimeInputError("短剧项目不存在", 404);
    const transient = record(requestSnapshot);
    const activeEpisode = project.episodes.find((episode) => episode.id === project.activeEpisodeId) || project.episodes[0];
    const suppliedEpisode = record(transient.episode);
    const episode = activeEpisode && suppliedEpisode.id === activeEpisode.id ? suppliedEpisode : activeEpisode;
    return {
        ...project,
        ...(typeof transient.currentStage === "string" && transient.currentStage.trim() ? { currentStage: transient.currentStage.trim() } : {}),
        ...(typeof transient.selectedShotId === "string" && transient.selectedShotId.trim() ? { selectedShotId: transient.selectedShotId.trim() } : {}),
        ...(Array.isArray(transient.currentTurnReferences) ? { currentTurnReferences: transient.currentTurnReferences } : {}),
        project: {
            id: project.id,
            title: project.title,
            summary: project.summary,
            style: project.style,
            ratio: project.ratio,
            status: project.status,
            activeEpisodeId: project.activeEpisodeId,
            defaultVideoMode: project.defaultVideoMode,
        },
        ...(episode ? { episode } : {}),
    };
}

async function assertVideoFrameAssets(userId: string, input: CreativeRunRequest) {
    const frameIds = videoFrameAssetIds(input.preferences?.video);
    if (!frameIds.length) return;
    const assets = await getCreativeAssetsByIds(frameIds, userId);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    for (const id of frameIds) {
        const asset = byId.get(id);
        if (!asset || asset.userId !== userId || asset.status !== "ready") throw new CreativeRuntimeInputError("视频首尾帧图片不存在或已失效");
        if (asset.type !== "image") throw new CreativeRuntimeInputError("视频首尾帧只能使用图片素材");
    }
}

export const getAgentRun = (id: string) => getStoredGenerationTask<AgentRun>("agent", id);
export const listAgentRuns = (options: { userId: string; conversationId?: string; projectId?: string; surface?: CreativeSurface; statuses?: AgentRunStatus[]; limit?: number }) => queryStoredGenerationTasks<AgentRun>("agent", options);

export async function selectCurrentSceneBaseline(conversationId: string, explicitResultId?: string, userId?: string): Promise<CreativeAsset | null> {
    if (!conversationId.trim() || !userId?.trim()) return null;
    if (explicitResultId) {
        const selected = (await getCreativeAssetsByIds([explicitResultId], userId)).find((asset) => asset.id === explicitResultId);
        if (!selected?.sourceRunId || selected.userId !== userId || selected.conversationId !== conversationId || selected.type !== "image" || selected.status !== "ready") return null;
        const parentRun = await getAgentRun(selected.sourceRunId);
        return parentRun?.userId === userId &&
            parentRun.conversationId === conversationId &&
            parentRun.surface === "chat" &&
            parentRun.status === "completed" &&
            parentRun.assetIds.includes(selected.id) &&
            validBaselineQuality(parentRun, true) &&
            (await hasEcommerceResultLineage(selected, parentRun))
            ? baselineWithEvidence(selected, parentRun)
            : null;
    }

    const runs = (await listAgentRuns({ userId, conversationId, surface: "chat", statuses: ["completed"], limit: 100 }))
        .filter((run) => run.status === "completed" && run.userId === userId && run.conversationId === conversationId && validBaselineQuality(run))
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const ids = [...new Set(runs.flatMap((run) => [...run.assetIds].reverse()))];
    if (!ids.length) return null;
    const byId = new Map((await getCreativeAssetsByIds(ids, userId)).map((asset) => [asset.id, asset]));
    for (const run of runs) {
        for (const id of [...run.assetIds].reverse()) {
            const asset = byId.get(id);
            if (asset?.sourceRunId === run.id && asset.userId === userId && asset.conversationId === conversationId && asset.type === "image" && asset.status === "ready" && (await hasEcommerceResultLineage(asset, run)))
                return baselineWithEvidence(asset, run);
        }
    }
    return null;
}

function validBaselineQuality(run: AgentRun, explicit = false) {
    if (run.ecommerceSnapshot?.qualityPolicy) return run.ecommerceSnapshot.mode === "active" && Boolean(run.ecommerceSnapshot.plan) && run.ecommerceSnapshot.technicalCheck?.status === "passed";
    const quality = run.ecommerceSnapshot?.qualityCheck;
    return Boolean(quality && quality.hardFailures.length === 0 && ((quality.status === "passed" && quality.publicStatus === "passed") || (explicit && quality.status === "needs_adjustment" && quality.publicStatus === "needs_adjustment")));
}

function baselineWithEvidence(asset: CreativeAsset, run: AgentRun): CreativeAsset {
    return {
        ...asset,
        metadata: {
            ...asset.metadata,
            ecommerceContinuity: {
                ...record(asset.metadata.ecommerceContinuity),
                productAnchorId: run.ecommerceSnapshot?.plan?.source.productAnchorId || null,
                sceneRootAssetId: run.ecommerceSnapshot?.continuity?.sceneRootAssetId || null,
                ...(run.ecommerceSnapshot?.qualityCheck ? { parentQualityCheck: structuredClone(run.ecommerceSnapshot.qualityCheck) } : {}),
            },
        },
    };
}

async function hasEcommerceResultLineage(asset: CreativeAsset, run: AgentRun): Promise<boolean> {
    const continuity = record(asset.metadata.ecommerceContinuity);
    const recordedAnchorId = typeof continuity.productAnchorId === "string" ? continuity.productAnchorId : undefined;
    const previousAnchorId = run.ecommerceSnapshot?.plan?.source.productAnchorId;
    const sceneRootAssetId = run.ecommerceSnapshot?.continuity?.sceneRootAssetId;
    const rootId = previousAnchorId || recordedAnchorId || sceneRootAssetId;
    if (!rootId || asset.parentAssetId !== rootId) return false;
    if (
        !previousAnchorId &&
        !recordedAnchorId &&
        (run.ecommerceSnapshot?.plan?.operation !== "scene_edit" ||
            continuity.sceneRootAssetId !== sceneRootAssetId ||
            continuity.branchId !== run.ecommerceSnapshot?.continuity?.branchId ||
            continuity.parentResultId !== run.ecommerceSnapshot?.continuity?.parentResultId)
    )
        return false;
    const requiredIds = [...new Set([rootId, run.ecommerceSnapshot?.plan?.source.currentSceneBaselineId, run.ecommerceSnapshot?.continuity?.parentResultId].filter((id): id is string => Boolean(id)))];
    const sources = await getCreativeAssetsByIds(requiredIds, run.userId);
    return requiredIds.every((id) => sources.some((source) => source.id === id && source.userId === run.userId && source.conversationId === run.conversationId && source.type === "image" && source.status === "ready"));
}

export async function createEditBranch(parentResultId: string, run: AgentRun, expectedExecutionId?: string) {
    const parentId = parentResultId.trim();
    if (!parentId) throw new CreativeRuntimeInputError("父结果 ID 无效");
    const parent = await selectCurrentSceneBaseline(run.conversationId, parentId, run.userId);
    if (!parent) throw new CreativeRuntimeInputError("父结果不存在或不可用于继续编辑");
    const evidence = record(parent.metadata.ecommerceContinuity);
    const continuity = {
        parentResultId: parentId,
        branchId: `ecommerce-${run.id}`,
        sceneRootAssetId: typeof evidence.sceneRootAssetId === "string" ? evidence.sceneRootAssetId : null,
        ...(evidence.parentQualityCheck ? { parentQualityCheck: structuredClone(evidence.parentQualityCheck) as NonNullable<EcommerceGenerationSnapshotRecord["qualityCheck"]> } : {}),
    };
    const updated = await mutateCreativeRun<AgentRun>(
        run.id,
        TTL,
        (current) => {
            if (current.userId !== run.userId || current.conversationId !== run.conversationId) return null;
            const ecommerceSnapshot: EcommerceGenerationSnapshotRecord = {
                ...(current.ecommerceSnapshot || {
                    version: ECOMMERCE_GENERATION_SNAPSHOT_VERSION,
                    mode: "active",
                    input: { userRequest: current.prompt, assetIds: [...current.referencedAssetIds], conversationId: current.conversationId, surface: current.surface },
                    createdAt: Date.now(),
                    runId: current.id,
                    userId: current.userId,
                }),
                continuity,
            };
            return { run: { ...current, ecommerceSnapshot } };
        },
        ["running"],
        expectedExecutionId,
    );
    return updated?.ecommerceSnapshot?.continuity || null;
}
export async function getAgentRunByClientRequestId(userId: string, clientRequestId: string) {
    return getCreativeRunByClientRequestId<AgentRun>(userId, clientRequestId);
}

export async function setAgentRunStatus(run: AgentRun, status: AgentRunStatus) {
    return mutateCreativeRun<AgentRun>(
        run.id,
        TTL,
        (current) => {
            if (current.userId !== run.userId || current.status !== run.status) return null;
            const tasks = status === "cancelled" ? cancelActiveTasks(current.tasks) : current.tasks;
            const ops = status === "cancelled" && current.surface === "canvas" ? cancelledRunCanvasOps(current.id, tasks) : [];
            return {
                run: { ...current, status, tasks, executionId: undefined, ...(status === "cancelled" ? { cancellation: undefined } : {}) },
                event: { type: `run.${status}`, ...(ops.length ? { data: { ops } } : {}) },
                assistant: terminalAssistant(status),
            };
        },
        [run.status],
    );
}

function cancelActiveTasks(tasks: AgentRunTask[]) {
    return tasks.map((task): AgentRunTask =>
        task.status === "ready" || task.status === "running" || task.status === "needs_review"
            ? {
                  ...task,
                  status: "cancelled",
                  error: "任务已取消",
                  childTasks: task.childTasks?.map((child) => (child.status === "pending" || child.status === "needs_review" ? { ...child, status: "cancelled" as const, error: "任务已取消" } : child)),
              }
            : task,
    );
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function updateAgentRunById(
    id: string,
    patch: Partial<
        Pick<
            AgentRun,
            | "status"
            | "executionId"
            | "tasks"
            | "foundation"
            | "projectHandoff"
            | "projectHandoffEmitted"
            | "review"
            | "reviewed"
            | "reviewStatus"
            | "reviewAttempts"
            | "plannerContext"
            | "promptSchemaVersion"
            | "promptTransport"
            | "contextDigest"
            | "plannerStreamMode"
            | "plannerStreamFallbackReason"
            | "plannerAudit"
            | "ecommerceSnapshot"
            | "cancellation"
            | "failure"
            | "failureStage"
            | "candidateFailures"
            | "assetIds"
            | "timings"
        >
    >,
    event?: { type: string; data?: unknown },
    allowedStatuses?: AgentRunStatus[],
    expectedExecutionId?: string,
    expectedTasks?: AgentRunTask[],
    expectedReview?: { attempts: number; reviewed: boolean },
) {
    return mutateCreativeRun<AgentRun>(
        id,
        TTL,
        (current) => {
            if (expectedTasks && JSON.stringify(current.tasks) !== JSON.stringify(expectedTasks)) return null;
            if (expectedReview && ((current.reviewAttempts || 0) !== expectedReview.attempts || Boolean(current.reviewed) !== expectedReview.reviewed)) return null;
            const next = { ...current, ...patch, status: patch.status || current.status };
            return {
                run: next,
                event,
                assistant: assistantUpdate(next, event),
                ...(patch.status === "completed" && next.reviewStatus === "review_pending" && !next.reviewed ? { schedule: { executionPhase: "review_pending" as const, nextPollAt: Date.now(), lastUpstreamStatus: "review_pending" } } : {}),
            };
        },
        allowedStatuses,
        expectedExecutionId,
    );
}

export async function updateAgentRunTaskById(id: string, taskId: string, patch: Partial<AgentRunTask>, eventType: string, expectedExecutionId: string) {
    return mutateCreativeRun<AgentRun>(
        id,
        TTL,
        (current) => {
            const tasks = current.tasks.map((task) => (task.id === taskId ? mergeAgentTaskPatch(task, patch) : task));
            const taskIndex = tasks.findIndex((item) => item.id === taskId);
            const task = tasks[taskIndex];
            if (!task) return null;
            const output = current.surface === "canvas" ? taskCanvasEventOps(id, taskIndex, task, eventType, patch.childTasks?.[0]?.id) : null;
            const assetIds = Array.from(new Set([...current.assetIds, ...(task.assetIds || [])]));
            const now = Date.now();
            const completed = tasks.filter((item) => item.status === "completed");
            const completedChildren = task.childTasks?.filter((child) => child.status === "completed").length || 0;
            const failedChildren = task.childTasks?.filter((child) => child.status === "failed").length || 0;
            const totalChildren = Math.max(resolveAgentTaskCountForEvent(task), task.childTasks?.length || 0);
            const timings: AgentRunTimings = {
                ...(current.timings || { requestAcceptedAt: current.createdAt }),
                ...(eventType === "task.created" && !current.timings?.firstTaskSubmittedAt ? { firstTaskSubmittedAt: now } : {}),
                ...((eventType === "task.completed" || eventType === "task.child.completed") && !current.timings?.firstResultReadyAt ? { firstResultReadyAt: now } : {}),
                ...(eventType === "task.completed" && completed.length === tasks.length ? { allResultsReadyAt: now } : {}),
            };
            return {
                run: { ...current, tasks, assetIds, timings },
                event: {
                    type: eventType,
                    data: {
                        taskId,
                        taskNodeId: `task-${id}-${taskIndex}`,
                        outputNodeIds: output?.nodeIds,
                        ops: output?.ops,
                        assetIds: task.assetIds,
                        title: task.title,
                        type: task.type,
                        status: task.status,
                        attempts: task.attempts,
                        error: task.error,
                        completedCount: completedChildren,
                        failedCount: failedChildren,
                        totalCount: totalChildren,
                        message: eventType === "task.completed" ? agentTaskCompletionMessage(task, current.surface) : undefined,
                    },
                },
            };
        },
        ["running"],
        expectedExecutionId,
    );
}

function resolveAgentTaskCountForEvent(task: AgentRunTask) {
    const count = Number(task.count);
    return Number.isSafeInteger(count) && count > 0 ? Math.floor(count) : 1;
}

function mergeAgentTaskPatch(task: AgentRunTask, patch: Partial<AgentRunTask>): AgentRunTask {
    const childTasks = patch.childTasks ? mergeChildTasks(task.childTasks || [], patch.childTasks) : task.childTasks;
    return {
        ...task,
        ...patch,
        ...(childTasks ? { childTasks } : {}),
        ...(patch.taskIds ? { taskIds: Array.from(new Set([...(task.taskIds || []), ...patch.taskIds])) } : {}),
        ...(patch.assetIds ? { assetIds: Array.from(new Set([...(task.assetIds || []), ...patch.assetIds])) } : {}),
    };
}

function mergeChildTasks(current: AgentRunChildTask[], incoming: AgentRunChildTask[]) {
    const merged = new Map(current.map((child) => [child.id, child]));
    for (const child of incoming) {
        const existing = merged.get(child.id);
        if (!existing || existing.status === "pending" || child.status !== "pending") merged.set(child.id, child);
    }
    return Array.from(merged.values());
}

function assistantUpdate(run: AgentRun, event?: { type: string; data?: unknown }) {
    const data = event?.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
    if (event?.type.startsWith("run.review.")) return undefined;
    if (run.status === "completed" && event?.type === "ecommerce.quality") return undefined;
    if (event?.type === "run.paused") {
        const reviewText = run.tasks.find((task) => task.status === "needs_review" && task.error?.trim())?.error?.trim();
        if (reviewText) return { status: "running" as const, content: toSafeGenerationErrorMessage(reviewText, "任务已暂停等待复核") };
    }
    if (event?.type === "task.needs_review") {
        const reviewText = (typeof data.error === "string" ? data.error : run.tasks.find((task) => task.status === "needs_review")?.error)?.trim();
        if (reviewText) return { status: "running" as const, content: reviewText };
    }
    if (event?.type === "run.retry.requested") return { status: "running" as const, content: "正在重新分析并执行这次请求…" };
    if (run.status === "running" && event?.type === "task.retry.requested") return { status: "running" as const, content: "正在重新生成失败任务…" };
    if (run.status === "completed") {
        return {
            status: "completed" as const,
            content: typeof data.reply === "string" && data.reply.trim() ? data.reply.trim() : "创作任务已完成。",
            metadata: {
                assetIds: run.assetIds,
                taskIds: Array.from(new Set(run.tasks.flatMap((task) => task.taskIds || (task.taskId ? [task.taskId] : [])))),
                projectHandoff: data.projectHandoff,
            },
        };
    }
    if (run.status === "failed") return { status: "failed" as const, content: typeof data.message === "string" ? data.message : "Agent 执行失败" };
    if (run.status === "cancelled") return { status: "cancelled" as const, content: "Agent 任务已取消。" };
    return undefined;
}

function terminalAssistant(status: AgentRunStatus) {
    if (status === "cancelled") return { status: "cancelled" as const, content: "Agent 任务已取消。" };
    return undefined;
}
