import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { resolveGeneratedMediaUrl } from "@/lib/media-url";
import { getMediaBlob, readStoredMediaFile, uploadGeneratedMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { refreshUserPointsIfSystem, syncUserPointsFromHeaders } from "@/services/api/points";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export type VideoResponse = { id: string; status?: string; error?: { message?: string } };
export type ApiVideoResponse = VideoResponse | { code?: number; data?: VideoResponse | null; msg?: string };
export type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
export type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string };
export type RequestOptions = {
    signal?: AbortSignal;
    conversationId?: string;
    runId?: string;
    surface?: "chat" | "canvas" | "drama";
    source?: "agent" | "video-workbench" | "canvas" | "drama";
    projectId?: string;
    episodeId?: string;
    shotId?: string;
    estimatedPoints?: number;
    parentTaskId?: string;
    attemptNo?: number;
    clientRequestId?: string;
    generationLogId?: string;
    generationSlotId?: string;
};
export type ResolvedVideoMediaUrl = { url: string; remoteUrl?: string };

export type VideoGenerationResult = { blob?: Blob; url?: string; remoteUrl?: string; mimeType?: string; durationMs?: number };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "generation"; model: string; pollPath?: string; resultUrl?: string; serverTaskId?: string; durationSeconds?: number };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string; canRetry?: boolean; needsReview?: boolean };

export const VIDEO_GENERATION_WAIT_TIMEOUT_MS = 30 * 60_000;

export class VideoGenerationUpstreamError extends Error {
    readonly canRetry: boolean;

    constructor(message: string, canRetry = true) {
        super(message);
        this.canRetry = canRetry;
        this.name = "VideoGenerationUpstreamError";
    }
}

export class VideoGenerationWaitTimeoutError extends Error {
    constructor() {
        super("视频仍在后台生成，系统会继续查询原任务");
        this.name = "VideoGenerationWaitTimeoutError";
    }
}

export const GLOBAL_AIOPC_VIDEO_CREATE_PATH = "/videos/videos";
export const GLOBAL_AIOPC_VIDEO_RESULT_PATH = "/result";
export const VIDEO_CREATE_PATHS = ["/video/generations", "/videos/generations", GLOBAL_AIOPC_VIDEO_CREATE_PATH];
export const VIDEO_URL_KEYS = [
    "video_url",
    "videoUrl",
    "media_url",
    "mediaUrl",
    "play_url",
    "playUrl",
    "stream_url",
    "streamUrl",
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
    "src",
    "url",
    "uri",
];
export const VIDEO_CONTAINER_KEYS = ["data", "result", "results", "response", "payload", "content", "output", "outputs", "video", "videos", "media", "asset", "assets", "file", "files", "artifact", "artifacts", "items", "task", "job"];
export const TASK_ID_KEYS = ["task_id", "taskId", "id", "job_id", "jobId", "request_id", "requestId", "generation_id", "generationId"];
export const TASK_STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
export const VIDEO_CREATE_ERROR_PREFIX = "视频任务创建失败：";
export const VIDEO_QUERY_ERROR_PREFIX = "视频任务查询失败：";
export const VIDEO_STAGE_ERROR_PREFIX = "视频生成阶段失败：";
