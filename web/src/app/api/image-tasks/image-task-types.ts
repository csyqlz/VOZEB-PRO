import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { configureServerProxyDispatcher } from "@/lib/server/proxy-dispatcher";
import { fetchInternalApi, isInternalApiBaseUrl, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { finishGenerationAttempt, startGenerationAttempt } from "@/lib/server/generation-attempt";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { assertReferenceCapabilities } from "@/lib/server/provider-task-config";
import { countActiveImageTasksForUser, createImageTask, getImageTask, touchImageTask, transitionImageTask, type ImageTask, type ImageTaskConfig, type ImageTaskReference, updateImageTask } from "@/lib/server/image-task-store";
import type { CanvasImageLayerBatchRequest } from "@/lib/server/canvas-image-layer-grant";
import { isGenerationSource, recordGenerationLog } from "@/lib/server/generation-log-store";
import { writeReferenceImageDataUrl } from "@/lib/server/reference-asset-store";
import { resolveImageTaskOptions } from "@/lib/server/image-task-config";
import { linkStoredGenerationTask, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import { createSignedReferenceAssetUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { assertCapabilityConstraints } from "@/lib/server/capability-constraints";

export type CreateImageTaskBody = {
    kind?: "generation" | "edit";
    config?: ImageTaskConfig;
    prompt?: string;
    references?: ImageTaskReference[];
    mask?: ImageTaskReference;
    source?: string;
    title?: string;
    context?: GenerationTaskContext;
    layerBatch?: CanvasImageLayerBatchRequest;
};

export type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    id?: string;
    task_id?: string;
    status?: string;
    result?: unknown;
    results?: unknown;
    content?: unknown;
    output?: unknown;
    code?: number;
    msg?: string;
};
export type ImageTaskMediaResult = {
    dataUrl: string;
    remoteUrl?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};
export type ImageTaskResult = ImageTaskMediaResult & {
    results?: ImageTaskMediaResult[];
    pending?: { id: string; mediaBaseUrl: string; pollBaseUrl: string; explicitPollUrl?: string };
    needsReview?: {
        upstream: { id: string; mediaBaseUrl: string; pollBaseUrl: string; explicitPollUrl?: string };
        reason: string;
    };
};
export type ImageTaskRunResult = ImageTaskResult & { pointsRemaining?: number; pointsCost?: number; pointsRecordId?: string };

export type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
};

export type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};

export const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
export const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
export const DEFAULT_IMAGE_SHORT_SIDE = 1024;
export const IMAGE_SIZE_STEP = 16;
export const IMAGE_MIN_PIXELS = 655360;
export const IMAGE_OUTPUT_FORMAT = "png";
export const TASK_HEARTBEAT_MS = 30 * 1000;
export const MODEL_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const IMAGE_TASK_POLL_INTERVAL_MS = 2500;
export const IMAGE_TASK_POLL_ATTEMPTS = 120;
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
export const INLINE_IMAGE_TIMEOUT_MS = 30 * 1000;
export const IMAGE_RESPONSE_FORMATS = ["b64_json", "url"] as const;
export const IMAGE_URL_KEYS = [
    "url",
    "uri",
    "src",
    "image",
    "image_url",
    "imageUrl",
    "media_url",
    "mediaUrl",
    "source_url",
    "sourceUrl",
    "content_url",
    "contentUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
    "file_url",
    "fileUrl",
    "asset_url",
    "assetUrl",
    "result_url",
    "resultUrl",
];
export const IMAGE_BASE64_KEYS = ["b64_json", "b64", "base64", "image_base64", "imageBase64", "base64_json"];
export const IMAGE_CONTAINER_KEYS = ["data", "result", "results", "response", "payload", "content", "output", "outputs", "images", "image", "asset", "assets", "file", "files", "artifact", "artifacts", "items", "task", "job"];
export const IMAGE_TASK_ID_KEYS = ["task_id", "taskId", "id", "job_id", "jobId", "request_id", "requestId", "generation_id", "generationId"];
export const IMAGE_STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
export const IMAGE_POLL_URL_KEYS = ["poll_url", "pollUrl", "polling_url", "pollingUrl", "status_url", "statusUrl", "task_url", "taskUrl"];
export type ImageEditReferenceMode = "auto" | "multipart" | "json" | "public-url";
