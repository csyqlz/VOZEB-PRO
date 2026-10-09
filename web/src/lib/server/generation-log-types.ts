import type { GenerationLogRequestSnapshot } from "@/lib/generation-log-snapshot";
import type { EcommerceGenerationTrace } from "@/lib/server/ecommerce-generation-trace";

export type GenerationLogKind = "image" | "video";
export type GenerationLogSource = "agent" | "image-workbench" | "video-workbench" | "canvas" | "drama" | "unknown";
export type GenerationLogStatus = "pending" | "success" | "failed";

export type GenerationLogAsset = {
    type: GenerationLogKind;
    url: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
};

export type StoredGenerationLog = {
    id: string;
    userId: string;
    accountId?: string;
    conversationId?: string;
    username: string;
    displayName: string;
    kind: GenerationLogKind;
    source: GenerationLogSource;
    status: GenerationLogStatus;
    title: string;
    prompt: string;
    model: string;
    summary: string;
    durationMs: number;
    count: number;
    successCount: number;
    failCount: number;
    assets: GenerationLogAsset[];
    requestSnapshot?: GenerationLogRequestSnapshot;
    ecommerceTrace?: EcommerceGenerationTrace;
    taskId?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
};

export type GenerationLogInput = Partial<Pick<StoredGenerationLog, "id" | "taskId" | "title" | "summary" | "error" | "requestSnapshot">> & {
    userId: string;
    username: string;
    displayName: string;
    conversationId?: string;
    kind: GenerationLogKind;
    source?: GenerationLogSource;
    status: GenerationLogStatus;
    prompt?: string;
    model?: string;
    durationMs?: number;
    count?: number;
    successCount?: number;
    failCount?: number;
    assets?: Array<Partial<GenerationLogAsset> & { url?: string; targetSize?: string }>;
    createdAt?: string | number;
    completedAt?: string | number;
};

export type GenerationTaskLogResultInput = {
    logId?: string;
    slotId?: string;
    clientRequestId?: string;
    taskId: string;
    userId: string;
    username: string;
    displayName: string;
    kind: GenerationLogKind;
    source: GenerationLogSource;
    status: "success" | "failed";
    title: string;
    prompt: string;
    model: string;
    summary: string;
    durationMs: number;
    asset?: Partial<GenerationLogAsset> & { url?: string; targetSize?: string };
    assets?: Array<Partial<GenerationLogAsset> & { url?: string; targetSize?: string }>;
    error?: string;
    canRetry?: boolean;
    taskKind?: "generation" | "edit";
    taskProvider?: "openai" | "seedance" | "generation";
    taskPollPath?: string;
    serverTaskId?: string;
    createdAt: string | number;
};

export type GenerationLogListOptions = {
    page?: number;
    pageSize?: number;
    keyword?: string;
    kind?: string;
    source?: string;
    status?: string;
    userId?: string;
    start?: string;
    end?: string;
    includeEcommerceTrace?: boolean;
};

export type GenerationAssetStats = {
    totalFiles: number;
    totalBytes: number;
    referencedFiles: number;
    referencedBytes: number;
    unreferencedFiles: number;
    unreferencedBytes: number;
    missingReferences: number;
};

export type GenerationLogDatabase = {
    version: 1;
    logs: StoredGenerationLog[];
};
