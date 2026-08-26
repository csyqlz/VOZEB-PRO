import type { GenerationTaskExecutionPhase } from "@/lib/server/generation-task-scheduler";

export type GenerationTaskType = "text" | "image" | "video" | "audio" | "agent" | "render";
export type GenerationTaskStatus = "pending" | "running" | "success" | "error" | "paused" | "cancelled";

export type GenerationTaskContext = {
    conversationId?: string;
    runId?: string;
    surface?: "chat" | "canvas" | "drama";
    projectId?: string;
    episodeId?: string;
    shotId?: string;
    estimatedPoints?: number;
    parentTaskId?: string;
    attemptNo?: number;
    clientRequestId?: string;
    generationLogId?: string;
    generationSlotId?: string;
    concurrencyClass?: "canvas-layer";
};

export type StoredGenerationTaskRecord = {
    id: string;
    userId: string;
    type: GenerationTaskType;
    status: GenerationTaskStatus;
    payload: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    executionPhase?: GenerationTaskExecutionPhase;
    upstreamTaskId?: string;
    channelId?: string;
    provider?: string;
    queryPath?: string;
    submittedAt?: number;
    nextPollAt?: number;
    lastPollAt?: number;
    lastUpstreamStatus?: string;
    resultPayload?: Record<string, unknown>;
    reviewReason?: string;
    workerId?: string;
    leaseUntil?: number;
    lastHeartbeatAt?: number;
} & GenerationTaskContext;

export type GenerationTaskRecordListOptions = {
    page?: number;
    pageSize?: number;
    type?: string;
    status?: string;
    surface?: string;
    projectId?: string;
    userId?: string;
    search?: string;
    searchUserIds?: string[];
    includeAll?: boolean;
};

export type GenerationTaskRecordSummary = {
    total: number;
    active: number;
    success: number;
    failed: number;
    averageDurationMs: number;
    totalPointsCost: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
};

export type GenerationTaskCostAggregate = {
    type: GenerationTaskType;
    status: GenerationTaskStatus;
    taskCount: number;
    estimatedPoints: number;
    actualPoints: number;
};

export type GenerationTaskPerformanceSummary = {
    sampleSize: number;
    planningP50Ms: number;
    planningP95Ms: number;
    firstResultP50Ms: number;
    firstResultP95Ms: number;
    queueAverageMs: number;
    upstreamAverageMs: number;
    reviewAverageMs: number;
};

export type GenerationTaskExecutionState = Pick<StoredGenerationTaskRecord, "executionPhase" | "lastUpstreamStatus" | "reviewReason">;
