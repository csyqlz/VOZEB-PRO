import type { GenerationTaskType } from "@/lib/server/generation-task-store";
import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import type { GenerationTaskExecutionPhase } from "@/lib/server/generation-task-scheduler";

export type AdminGenerationTask = {
    id: string;
    userId: string;
    accountId?: string;
    username: string;
    displayName: string;
    type: GenerationTaskType;
    status: "pending" | "running" | "success" | "error" | "paused" | "cancelled";
    surface?: "chat" | "canvas" | "drama";
    conversationId?: string;
    runId?: string;
    projectId?: string;
    parentTaskId?: string;
    attemptNo?: number;
    model: string;
    channelId?: string;
    provider?: string;
    queryPath?: string;
    executionPhase?: GenerationTaskExecutionPhase;
    workerId?: string;
    leaseUntil?: number;
    lastHeartbeatAt?: number;
    nextPollAt?: number;
    lastPollAt?: number;
    leaseExpired: boolean;
    upstreamTaskId?: string;
    lastUpstreamStatus?: string;
    attempts?: GenerationAttempt[];
    prompt: string;
    error?: string;
    durationMs: number;
    pointsCost: number;
    pointsBreakdown?: { planner: number; childTasks: number; total: number };
    plannerAudit?: {
        schemaVersion: number;
        mode: "direct" | "model";
        logicalModelId?: string;
        channelId?: string;
        upstreamModel?: string;
        protocol?: "responses" | "chat" | "gemini" | "custom";
        elapsedMs?: number;
        pointsCost?: number;
        skills: Array<{ id: string; name: string; sourceVersion?: string; sourceCommit?: string; sourceContentHash?: string }>;
    };
    plannerRuntime?: {
        transport?: "stream" | "complete";
        firstByteMs?: number;
        planningMs?: number;
        serializedChars?: number;
        fallbackReason?: string;
    };
    agentFailure?: {
        stage: "planning" | "task_execution" | "refund";
        message: string;
        candidates: Array<{ channelId: string; upstreamModel: string; error: string }>;
    };
    createdAt: number;
    updatedAt: number;
    canCancel: boolean;
    retryTaskId?: string;
    canReview: boolean;
};

export type AdminGenerationChannelCluster = {
    id: string;
    name: string;
    capability: AdminGenerationChannel["capability"];
    bindings: AdminGenerationChannel[];
    cooling: boolean;
    disabledBindings: number;
    consecutiveFailures: number;
};

export type AdminGenerationChannelGroup = {
    capability: AdminGenerationChannel["capability"];
    channels: AdminGenerationChannelCluster[];
};

export type AdminGenerationChannel = {
    id: string;
    name: string;
    capability: "text" | "image" | "video" | "audio";
    logicalModelId: string;
    logicalModelName: string;
    upstreamModel: string;
    enabled: boolean;
    runtimeHealth: {
        status: "healthy" | "cooling";
        consecutiveFailures: number;
        cooldownUntil?: number;
        lastError?: string;
    };
    planningRuntime?: {
        protocol?: "responses" | "chat" | "gemini" | "custom";
        successCount: number;
        failureCount: number;
        averageLatencyMs?: number;
    };
};

export type AdminAgentPerformance = {
    sampleSize: number;
    planningP50Ms: number;
    planningP95Ms: number;
    firstResultP50Ms: number;
    firstResultP95Ms: number;
    queueAverageMs: number;
    upstreamAverageMs: number;
    reviewAverageMs: number;
};

export type AdminGenerationOperationsPayload = {
    items: AdminGenerationTask[];
    total: number;
    page: number;
    pageSize: number;
    summary: {
        total: number;
        active: number;
        success: number;
        failed: number;
        averageDurationMs: number;
        totalPointsCost: number;
        byType: Record<string, number>;
        byStatus: Record<string, number>;
    };
    channels: AdminGenerationChannel[];
    agentPerformance: AdminAgentPerformance;
};

const capabilityOrder: AdminGenerationChannel["capability"][] = ["text", "image", "video", "audio"];

export function groupAdminGenerationChannels(channels: AdminGenerationChannel[], search: string): AdminGenerationChannelGroup[] {
    const keyword = search.trim().toLowerCase();
    const matched = keyword ? channels.filter((channel) => [channel.name, channel.id, channel.logicalModelName, channel.logicalModelId, channel.upstreamModel].some((value) => value.toLowerCase().includes(keyword))) : channels;
    const byCapability = new Map<AdminGenerationChannel["capability"], Map<string, AdminGenerationChannel[]>>();
    for (const binding of matched) {
        const byChannel = byCapability.get(binding.capability) || new Map<string, AdminGenerationChannel[]>();
        byChannel.set(binding.id, [...(byChannel.get(binding.id) || []), binding]);
        byCapability.set(binding.capability, byChannel);
    }
    return capabilityOrder.flatMap((capability) => {
        const byChannel = byCapability.get(capability);
        if (!byChannel) return [];
        const grouped = Array.from(byChannel.values())
            .map((bindings): AdminGenerationChannelCluster => ({
                id: bindings[0].id,
                name: bindings[0].name,
                capability,
                bindings: bindings.toSorted((left, right) => left.logicalModelName.localeCompare(right.logicalModelName, "zh-CN") || left.upstreamModel.localeCompare(right.upstreamModel)),
                cooling: bindings.some((binding) => binding.runtimeHealth.status === "cooling"),
                disabledBindings: bindings.filter((binding) => !binding.enabled).length,
                consecutiveFailures: Math.max(...bindings.map((binding) => binding.runtimeHealth.consecutiveFailures), 0),
            }))
            .toSorted((left, right) => channelAlertRank(left) - channelAlertRank(right) || left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
        return [{ capability, channels: grouped }];
    });
}

function channelAlertRank(channel: AdminGenerationChannelCluster) {
    if (channel.cooling) return 0;
    if (channel.disabledBindings) return 1;
    if (channel.consecutiveFailures) return 2;
    return 3;
}
