import { getCameraMotionPath } from "../schema/cameraMotion";
import type { DirectorProject, ViewMode } from "../schema/directorProject";
import { getRuntimePlaybackProgress } from "../runtime/playbackRuntime";
import { DIRECTOR_PROJECT_SCHEMA_VERSION, getDirectorProjectFingerprint } from "./projectDocument";
import type { CleanFrameExportResult } from "./cleanFrameExport";
import type { ReferenceVideoExportResult } from "./referenceVideoExport";
import type { DirectorPluginResultRecord } from "./pluginResultRegistry";

export const DIRECTOR_EXTENSION_PROTOCOL_VERSION = 1;
export const DIRECTOR_EXTENSION_REQUEST_TYPE = "storyai:director-desk:request";
export const DIRECTOR_EXTENSION_RESPONSE_TYPE = "storyai:director-desk:response";

export const DIRECTOR_EXTENSION_ACTIONS = [
  "capabilities.get",
  "project.get",
  "timeline.get",
  "export.frame",
  "export.video",
  "plugin.result.submit",
  "plugin.results.list",
] as const;

export type DirectorExtensionAction = (typeof DIRECTOR_EXTENSION_ACTIONS)[number];

export interface DirectorExtensionRequestPayload {
  requestId: string;
  action: DirectorExtensionAction;
  options?: {
    fileName?: string;
    fps?: 24 | 30 | 60;
    position?: "current" | "first" | "last";
    quality?: "720p" | "1080p";
    result?: unknown;
  };
}

export interface DirectorExtensionCapabilities {
  protocolVersion: typeof DIRECTOR_EXTENSION_PROTOCOL_VERSION;
  projectSchemaVersion: typeof DIRECTOR_PROJECT_SCHEMA_VERSION;
  actions: readonly DirectorExtensionAction[];
  uiExports: readonly ["project-json", "reference-video", "viewport-still"];
  protocolExports: readonly ["clean-frame", "reference-video"];
  assetPersistence: "browser-local-references";
}

export interface DirectorExtensionProjectSnapshot {
  protocolVersion: typeof DIRECTOR_EXTENSION_PROTOCOL_VERSION;
  projectSchemaVersion: typeof DIRECTOR_PROJECT_SCHEMA_VERSION;
  projectFingerprint: string;
  project: DirectorProject;
  portability: {
    portable: boolean;
    browserLocalAssetIds: string[];
    note: string | null;
  };
}

export interface DirectorExtensionTimelineSnapshot {
  protocolVersion: typeof DIRECTOR_EXTENSION_PROTOCOL_VERSION;
  progress: number;
  timeSeconds: number;
  durationSeconds: number;
  playing: boolean;
  viewMode: ViewMode;
  activeCameraId: string | null;
}

export type DirectorExtensionResponsePayload = {
  protocolVersion: typeof DIRECTOR_EXTENSION_PROTOCOL_VERSION;
  requestId: string;
  action: DirectorExtensionAction | "unknown";
  ok: true;
  data:
    | DirectorExtensionCapabilities
    | DirectorExtensionProjectSnapshot
    | DirectorExtensionTimelineSnapshot
    | CleanFrameExportResult
    | ReferenceVideoExportResult
    | DirectorPluginResultRecord
    | DirectorPluginResultRecord[];
} | {
  protocolVersion: typeof DIRECTOR_EXTENSION_PROTOCOL_VERSION;
  requestId: string;
  action: DirectorExtensionAction | "unknown";
  ok: false;
  error: {
    code:
      | "invalid-request"
      | "unsupported-action"
      | "export-busy"
      | "export-failed"
      | "invalid-plugin-result";
    message: string;
  };
};

interface RuntimeSnapshotSource {
  project: DirectorProject;
  cameraMotionPlaying: boolean;
  viewMode: ViewMode;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isDirectorExtensionAction(value: unknown): value is DirectorExtensionAction {
  return typeof value === "string" && DIRECTOR_EXTENSION_ACTIONS.includes(value as DirectorExtensionAction);
}

export function parseDirectorExtensionRequest(value: unknown): DirectorExtensionRequestPayload | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<DirectorExtensionRequestPayload>;
  const requestId = typeof request.requestId === "string" ? request.requestId.trim().slice(0, 128) : "";
  if (!requestId || !isDirectorExtensionAction(request.action)) return null;
  const sourceOptions = request.options && typeof request.options === "object" ? request.options : {};
  const requestedFps = Number(sourceOptions.fps);
  const fps = requestedFps === 24 || requestedFps === 60 ? requestedFps : 30;
  const quality = sourceOptions.quality === "1080p" ? "1080p" : "720p";
  const position = sourceOptions.position === "first" || sourceOptions.position === "last"
    ? sourceOptions.position
    : "current";
  const fileName = typeof sourceOptions.fileName === "string"
    ? sourceOptions.fileName.trim().slice(0, 160)
    : "";
  return {
    requestId,
    action: request.action,
    ...(request.action === "export.frame"
      ? { options: { fileName: fileName || `${position}-frame.png`, position, quality } }
      : request.action === "export.video"
        ? { options: { fileName: fileName || "director-reference.mp4", fps, quality } }
        : request.action === "plugin.result.submit"
          ? { options: { result: sourceOptions.result } }
        : {}),
  };
}

export function createDirectorExtensionCapabilities(): DirectorExtensionCapabilities {
  return {
    protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
    projectSchemaVersion: DIRECTOR_PROJECT_SCHEMA_VERSION,
    actions: DIRECTOR_EXTENSION_ACTIONS,
    uiExports: ["project-json", "reference-video", "viewport-still"],
    protocolExports: ["clean-frame", "reference-video"],
    assetPersistence: "browser-local-references",
  };
}

export function createDirectorExtensionProjectSnapshot(project: DirectorProject): DirectorExtensionProjectSnapshot {
  const browserLocalAssetIds = [
    ...project.assets.filter((asset) => Boolean(asset.storageKey) || asset.url.startsWith("blob:")).map((asset) => asset.id),
    ...(project.animationAssets ?? [])
      .filter((asset) => Boolean(asset.storageKey) || asset.url.startsWith("blob:"))
      .map((asset) => asset.id),
  ];
  return {
    protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
    projectSchemaVersion: DIRECTOR_PROJECT_SCHEMA_VERSION,
    projectFingerprint: getDirectorProjectFingerprint(project),
    project: cloneJson(project),
    portability: {
      portable: browserLocalAssetIds.length === 0,
      browserLocalAssetIds,
      note: browserLocalAssetIds.length > 0
        ? "这些素材只保存在当前浏览器，工程 JSON 仅包含引用；跨设备使用时需要重新导入原始素材。"
        : null,
    },
  };
}

export function createDirectorExtensionTimelineSnapshot(source: RuntimeSnapshotSource): DirectorExtensionTimelineSnapshot {
  const activeCamera = source.project.cameras.find((camera) => camera.id === source.project.activeCameraId)
    ?? source.project.cameras[0];
  const durationSeconds = activeCamera ? getCameraMotionPath(activeCamera).duration : 0;
  const progress = getRuntimePlaybackProgress();
  return {
    protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
    progress,
    timeSeconds: progress * durationSeconds,
    durationSeconds,
    playing: source.cameraMotionPlaying,
    viewMode: source.viewMode,
    activeCameraId: activeCamera?.id ?? null,
  };
}

export function createDirectorExtensionResponse(
  request: DirectorExtensionRequestPayload,
  source: RuntimeSnapshotSource
): DirectorExtensionResponsePayload {
  if (
    request.action === "export.frame"
    || request.action === "export.video"
    || request.action === "plugin.result.submit"
    || request.action === "plugin.results.list"
  ) {
    throw new Error("该操作需要由宿主桥专用管线处理");
  }
  const data = request.action === "capabilities.get"
    ? createDirectorExtensionCapabilities()
    : request.action === "project.get"
      ? createDirectorExtensionProjectSnapshot(source.project)
      : createDirectorExtensionTimelineSnapshot(source);
  return {
    protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
    requestId: request.requestId,
    action: request.action,
    ok: true,
    data,
  };
}
