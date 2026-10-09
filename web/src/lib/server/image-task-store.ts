import { randomUUID } from "crypto";

import type { LogicalModelCapabilityProfile, SystemChannelAdvancedConfig } from "@/lib/auth/store";
import type { ImageEditRegion } from "@/lib/image-edit-region";
import type { GenerationAttempt } from "@/lib/server/generation-attempt";
import type { GenerationLogSource } from "@/lib/server/generation-log-store";
import { countActiveStoredGenerationTasks, createStoredGenerationTask, getStoredGenerationTask, mutateStoredGenerationTask, touchStoredGenerationTask, transitionStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "@/lib/server/generation-task-retention";
import type { ProductProtectionSnapshot, SceneEditProtection, SceneEditProtectionEvidence } from "@/lib/server/ecommerce-product-regions";
import type { EcommerceCompiledImageRequest } from "@/lib/server/ecommerce-image-compiler";
import type { EcommerceGenerationTrace } from "@/lib/server/ecommerce-generation-trace";
import type { EcommerceCanvasMediaEvidence, EcommerceCanvasProviderRequest, EcommerceDimensions } from "@/lib/server/ecommerce-edit-plan";

type ImageTaskKind = "generation" | "edit";
type ImageTaskStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type ImageTaskConfig = {
    apiSource?: "system" | "custom";
    baseUrl: string;
    apiKey: string;
    apiFormat: "openai" | "gemini";
    model: string;
    channelId?: string;
    logicalModel?: string;
    capabilityProfile?: LogicalModelCapabilityProfile;
    quality?: string;
    size?: string;
    outputBackground?: "opaque" | "transparent";
    outputMode?: "layers";
    systemPrompt?: string;
    advancedConfig?: SystemChannelAdvancedConfig;
};

export type ImageTaskReference = {
    id?: string;
    name?: string;
    type?: string;
    dataUrl: string;
    url?: string;
    remoteUrl?: string;
    serverUrl?: string;
    width?: number;
    height?: number;
    editRegion?: ImageEditRegion;
    ecommerceRole?: "product" | "scene";
};

export type StoredImageTaskMediaResult = {
    resultId?: string;
    dataUrl: string;
    remoteUrl?: string;
    serverUrl?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    canvasEvidence?: EcommerceCanvasMediaEvidence;
    sceneProtectionEvidence?: SceneEditProtectionEvidence;
};

export type ImageTaskResultEvidence = {
    resultId: string;
    resultIndex: number;
    nativeStatus: "readable" | "unavailable";
    nativeSize?: EcommerceDimensions;
    storageStatus: "stored" | "unavailable";
    storedSize?: EcommerceDimensions;
    storedUrl?: string;
    failureStage?: "read" | "decode" | "validation" | "store";
    failureReason?: string;
};

export type ImageTask = GenerationTaskContext & {
    id: string;
    userId: string;
    username: string;
    displayName: string;
    kind: ImageTaskKind;
    source: GenerationLogSource;
    title?: string;
    status: ImageTaskStatus;
    createdAt: number;
    updatedAt: number;
    config: ImageTaskConfig;
    prompt: string;
    references: ImageTaskReference[];
    mask?: ImageTaskReference;
    productProtection?: ProductProtectionSnapshot;
    sceneProtection?: SceneEditProtection;
    ecommerceExecution?: EcommerceCompiledImageRequest;
    ecommerceTrace?: EcommerceGenerationTrace;
    ecommerceCanvasRequest?: EcommerceCanvasProviderRequest;
    result?: StoredImageTaskMediaResult & { results?: StoredImageTaskMediaResult[]; batchEvidence?: ImageTaskResultEvidence[] };
    upstream?: { id: string; mediaBaseUrl: string; pollBaseUrl: string; explicitPollUrl?: string };
    billing?: { pointsCost: number; pointsRecordId?: string; refunded: boolean };
    error?: string;
    retryable?: boolean;
    pointsRemaining?: number;
    candidateConfigs?: ImageTaskConfig[];
    attempts?: GenerationAttempt[];
    attemptNo?: number;
};

const TASK_STALE_MS = 3 * 60 * 1000;
export async function createImageTask(input: Omit<ImageTask, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const task: ImageTask = {
        ...input,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
    };
    return createStoredGenerationTask("image", task, GENERATION_TASK_RETENTION_MS, { referenceDispatch: input.referenceDispatch });
}

export async function getImageTask(id: string) {
    return getStoredGenerationTask<ImageTask>("image", id);
}

export function countActiveImageTasksForUser(userId: string) {
    return countActiveStoredGenerationTasks(userId, "image", TASK_STALE_MS);
}

export function transitionImageTask(
    task: ImageTask,
    allowedStatuses: ImageTaskStatus[],
    patch: Partial<Pick<ImageTask, "result" | "error" | "pointsRemaining" | "retryable" | "config" | "billing">> & { status: ImageTaskStatus },
    executionPatch?: import("@/lib/server/generation-task-scheduler").GenerationTaskSchedulePatch,
) {
    return transitionStoredGenerationTask<ImageTask>("image", task.id, task.userId, allowedStatuses, patch, GENERATION_TASK_RETENTION_MS, executionPatch);
}

export function touchImageTask(id: string) {
    return touchStoredGenerationTask("image", id, Date.now(), GENERATION_TASK_RETENTION_MS);
}

export async function updateImageTask(id: string, patch: Partial<Pick<ImageTask, "config" | "candidateConfigs" | "attempts" | "attemptNo" | "upstream" | "billing" | "result" | "retryable" | "ecommerceTrace" | "ecommerceCanvasRequest">>) {
    return mutateStoredGenerationTask<ImageTask>("image", id, GENERATION_TASK_RETENTION_MS, (task) => ({ ...task, ...patch }));
}
