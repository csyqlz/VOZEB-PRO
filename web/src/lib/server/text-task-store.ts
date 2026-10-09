import { randomUUID } from "node:crypto";

import type { LogicalModelCapabilityProfile, SystemChannelAdvancedConfig } from "@/lib/auth/store";
import type { AiTextMessage } from "@/types/ai";
import { createStoredGenerationTask, getStoredGenerationTask, mutateStoredGenerationTask, touchStoredGenerationTask, transitionStoredGenerationTask } from "@/lib/server/generation-task-store";
import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";
import type { GenerationTaskContext } from "@/lib/server/generation-task-store";
import type { DramaAnalyzeBody } from "@/lib/server/drama-analysis-input";

type TextTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type TextTaskConfig = {
    apiSource?: "system" | "custom";
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    model: string;
    channelId?: string;
    logicalModel?: string;
    capabilityProfile?: LogicalModelCapabilityProfile;
    advancedConfig?: SystemChannelAdvancedConfig;
    systemPrompt?: string;
};

export type TextTask = GenerationTaskContext & {
    id: string;
    userId: string;
    status: TextTaskStatus;
    createdAt: number;
    updatedAt: number;
    config: TextTaskConfig;
    messages: AiTextMessage[];
    result?: { content: string };
    upstream?: { id: string; createPath: string };
    billing?: { pointsCost: number; pointsRecordId?: string; refunded: boolean };
    error?: string;
    pointsRemaining?: number;
    candidateConfigs?: TextTaskConfig[];
    attempts?: GenerationAttempt[];
    attemptNo?: number;
    dramaAnalysis?: { body: DramaAnalyzeBody };
};

export async function createTextTask(input: Omit<TextTask, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const task: TextTask = {
        ...input,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
    };
    return createStoredGenerationTask("text", task, GENERATION_TASK_RETENTION_MS);
}

export async function getTextTask(id: string) {
    return getStoredGenerationTask<TextTask>("text", id);
}

export function transitionTextTask(
    task: TextTask,
    allowedStatuses: TextTaskStatus[],
    patch: Partial<Pick<TextTask, "config" | "messages" | "result" | "error" | "pointsRemaining" | "upstream" | "billing">> & { status: TextTaskStatus },
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
) {
    return transitionStoredGenerationTask<TextTask>("text", task.id, task.userId, allowedStatuses, patch, GENERATION_TASK_RETENTION_MS, executionPatch);
}

export function touchTextTask(id: string) {
    return touchStoredGenerationTask("text", id, Date.now(), GENERATION_TASK_RETENTION_MS);
}

export function updateTextTask(id: string, patch: Partial<Pick<TextTask, "config" | "candidateConfigs" | "attempts" | "attemptNo" | "upstream" | "billing">>) {
    return mutateStoredGenerationTask<TextTask>("text", id, GENERATION_TASK_RETENTION_MS, (task) => ({ ...task, ...patch }));
}
