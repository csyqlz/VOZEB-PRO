import type { DirectorProject } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { requestCleanFrameExport } from "./cleanFrameExport";
import {
  DIRECTOR_EXTENSION_PROTOCOL_VERSION,
  DIRECTOR_EXTENSION_REQUEST_TYPE,
  DIRECTOR_EXTENSION_RESPONSE_TYPE,
  createDirectorExtensionResponse,
  isDirectorExtensionAction,
  parseDirectorExtensionRequest,
  type DirectorExtensionResponsePayload,
} from "./extensionProtocol";
import { listDirectorPluginResults, submitDirectorPluginResult } from "./pluginResultRegistry";
import { getDirectorProjectFingerprint } from "./projectDocument";
import { requestReferenceVideoExport } from "./referenceVideoExport";
import {
  initTauriDirectorHostTransport,
  postTauriDirectorHostMessage,
  type DirectorDeskTransportMessage,
} from "./tauriHostTransport";

interface HostPanoramaPayload {
  edgeId?: unknown;
  sourceNodeId?: unknown;
  imageUrl?: unknown;
  fileName?: unknown;
  nonce?: unknown;
}

interface HostSessionPayload {
  instanceId?: unknown;
  theme?: unknown;
  project?: unknown;
  nonce?: unknown;
}

export interface HostCaptureItemPayload {
  dataUrl?: unknown;
  fileName?: unknown;
}

export interface HostCaptureBatchPayload {
  captures?: HostCaptureItemPayload[];
}

export interface DirectorDeskCaptureDelivery {
  requestId: string;
  status: "accepted" | "failed";
  error?: string;
}

interface HostConnectedPanorama {
  edgeId: string;
  sourceNodeId: string;
}

let initialized = false;
let activeExtensionExportRequestId: string | null = null;
let hostConnectedPanorama: HostConnectedPanorama | null = null;
let removeUnsubscribe: (() => void) | null = null;
let suppressNextPanoramaRemovalNotice = false;
let hostSessionNonce = "";
let projectChangeTimer: ReturnType<typeof setTimeout> | null = null;
let captureRequestSequence = 0;
const captureDeliveryListeners = new Set<(delivery: DirectorDeskCaptureDelivery) => void>();
let clearTauriTransport: (() => void) | null = null;
export const DIRECTOR_DESK_SESSION_OPENED_EVENT = "storyai:director-desk-session-opened";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

const HOST_ORIGIN_QUERY_KEY = "hostOrigin";

function normalizeOrigin(value: unknown) {
  const text = normalizeString(value);
  if (!text) return null;

  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

export function getDirectorDeskHostOrigin() {
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeOrigin(params.get(HOST_ORIGIN_QUERY_KEY)) ?? window.location.origin;
  } catch {
    return window.location.origin;
  }
}

function isAllowedHostEvent(event: MessageEvent) {
  const fromExpectedOrigin = event.origin === getDirectorDeskHostOrigin();
  const fromParentWindow = window.parent === window || event.source === window.parent;
  return fromExpectedOrigin && fromParentWindow;
}

function postToHost(type: string, payload: Record<string, unknown> = {}) {
  postDirectorDeskMessageToHost(
    Object.keys(payload).length ? { type, payload } : { type }
  );
}

function isDirectorProject(value: unknown): value is DirectorProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<DirectorProject>;
  return project.version === 1
    && Boolean(project.scene)
    && Array.isArray(project.assets)
    && Array.isArray(project.objects)
    && Array.isArray(project.cameras);
}

function hostProjectSnapshot(project: DirectorProject): DirectorProject {
  const connectedPanoramaAssetId = hostConnectedPanorama ? project.panoramaAssetId : null;
  return {
    ...project,
    assets: connectedPanoramaAssetId
      ? project.assets.filter((asset) => asset.id !== connectedPanoramaAssetId)
      : project.assets,
    panoramaAssetId: connectedPanoramaAssetId ? null : project.panoramaAssetId,
    cameras: project.cameras.map((camera) => ({ ...camera, lastCaptureUrl: null, captures: [] })),
  };
}

function scheduleProjectChanged(project: DirectorProject) {
  if (!hostSessionNonce) return;
  if (projectChangeTimer) clearTimeout(projectChangeTimer);
  projectChangeTimer = setTimeout(() => {
    postToHost("storyai:director-desk-project-changed", { project: hostProjectSnapshot(project) });
    projectChangeTimer = null;
  }, 500);
}

function normalizeTheme(value: unknown): "dark" | "light" | null {
  return value === "light" || value === "dark" ? value : null;
}

function applyDirectorDeskTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function getInitialHostTheme() {
  try {
    return normalizeTheme(new URLSearchParams(window.location.search).get("theme"));
  } catch {
    return null;
  }
}

function isSupportedHostImageUrl(value: string) {
  if (value.startsWith("data:image/")) return true;

  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "blob:";
  } catch {
    return false;
  }
}

function notifyPanoramaRemoved() {
  if (!hostConnectedPanorama) return;
  postToHost("storyai:director-desk-panorama-removed", { ...hostConnectedPanorama });
  hostConnectedPanorama = null;
}

function subscribeToProjectChanges() {
  if (removeUnsubscribe) return;

  let previousPanoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;
  let previousProject = useDirectorStore.getState().project;
  removeUnsubscribe = useDirectorStore.subscribe((state) => {
    const nextPanoramaAssetId = state.project.panoramaAssetId;
    if (previousPanoramaAssetId && !nextPanoramaAssetId) {
      if (suppressNextPanoramaRemovalNotice) {
        suppressNextPanoramaRemovalNotice = false;
        hostConnectedPanorama = null;
      } else {
        notifyPanoramaRemoved();
      }
    }

    previousPanoramaAssetId = nextPanoramaAssetId;
    if (state.project !== previousProject) {
      previousProject = state.project;
      scheduleProjectChanged(state.project);
    }
  });
}

function importHostPanorama(payload: HostPanoramaPayload) {
  const edgeId = normalizeString(payload.edgeId);
  const sourceNodeId = normalizeString(payload.sourceNodeId);
  const imageUrl = normalizeString(payload.imageUrl);
  const fileName = normalizeString(payload.fileName);

  if (!edgeId || !sourceNodeId || !fileName || !imageUrl || !isSupportedHostImageUrl(imageUrl)) return;

  const panoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;
  if (hostConnectedPanorama && panoramaAssetId) {
    suppressNextPanoramaRemovalNotice = true;
    useDirectorStore.getState().removeImportedAsset(panoramaAssetId);
  }

  hostConnectedPanorama = { edgeId, sourceNodeId };
  useDirectorStore.getState().setPanoramaAsset({
    name: fileName,
    fileName,
    url: imageUrl,
    projectionMode: "equirectangular",
  });
}

function clearHostPanorama() {
  const panoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;
  if (!hostConnectedPanorama || !panoramaAssetId) return;
  suppressNextPanoramaRemovalNotice = true;
  useDirectorStore.getState().removeImportedAsset(panoramaAssetId);
  hostConnectedPanorama = null;
}

function openHostSession(payload: HostSessionPayload) {
  const instanceId = normalizeString(payload.instanceId);
  const theme = normalizeTheme(payload.theme);
  hostSessionNonce = normalizeString(payload.nonce);
  if (theme) applyDirectorDeskTheme(theme);

  suppressNextPanoramaRemovalNotice = Boolean(useDirectorStore.getState().project.panoramaAssetId);
  useDirectorStore.getState().openScopedScene(instanceId || null);
  if (isDirectorProject(payload.project)) useDirectorStore.getState().replaceProject(payload.project);
  suppressNextPanoramaRemovalNotice = false;
  hostConnectedPanorama = null;

  if (instanceId) {
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_SESSION_OPENED_EVENT, { detail: { instanceId } }));
    postDirectorDeskMessageToHost({ type: "storyai:director-desk-ready" });
  }
}

export function postDirectorDeskMessageToHost(message: DirectorDeskTransportMessage) {
  const nextMessage = hostSessionNonce
    ? {
        ...message,
        payload: {
          ...(message.payload || {}),
          nonce: hostSessionNonce,
        },
      }
    : message;
  if (postTauriDirectorHostMessage(nextMessage)) return;
  window.parent?.postMessage(nextMessage, getDirectorDeskHostOrigin());
}

function postDirectorExtensionResponse(payload: DirectorExtensionResponsePayload) {
  postDirectorDeskMessageToHost({ type: DIRECTOR_EXTENSION_RESPONSE_TYPE, payload });
}

async function handleDirectorExtensionRequest(payload: unknown) {
  const request = parseDirectorExtensionRequest(payload);
  if (request) {
    if (request.action === "plugin.results.list") {
      const projectFingerprint = getDirectorProjectFingerprint(useDirectorStore.getState().project);
      postDirectorExtensionResponse({
        protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
        requestId: request.requestId,
        action: request.action,
        ok: true,
        data: listDirectorPluginResults(projectFingerprint),
      });
      return;
    }
    if (request.action === "plugin.result.submit") {
      try {
        const project = useDirectorStore.getState().project;
        const result = submitDirectorPluginResult(
          request.options?.result,
          getDirectorProjectFingerprint(project)
        );
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: true,
          data: result,
        });
      } catch (error) {
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          error: {
            code: "invalid-plugin-result",
            message: error instanceof Error ? error.message : "插件结果无效",
          },
        });
      }
      return;
    }
    if (request.action === "export.frame" || request.action === "export.video") {
      if (activeExtensionExportRequestId) {
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          error: { code: "export-busy", message: "已有导出任务正在进行，请稍后再试" },
        });
        return;
      }
      activeExtensionExportRequestId = request.requestId;
      try {
        const result = request.action === "export.frame"
          ? await requestCleanFrameExport({
              fileName: request.options?.fileName ?? "current-frame.png",
              position: request.options?.position ?? "current",
              quality: request.options?.quality ?? "720p",
            })
          : await requestReferenceVideoExport({
              fileName: request.options?.fileName ?? "director-reference.mp4",
              fps: request.options?.fps ?? 30,
              quality: request.options?.quality ?? "720p",
            });
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: true,
          data: result,
        });
      } catch (error) {
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          error: {
            code: "export-failed",
            message: error instanceof Error ? error.message : "导出失败",
          },
        });
      } finally {
        activeExtensionExportRequestId = null;
      }
      return;
    }

    const state = useDirectorStore.getState();
    postDirectorExtensionResponse(createDirectorExtensionResponse(request, state));
    return;
  }

  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const requestId = normalizeString(value.requestId).slice(0, 128) || "unknown";
  const action = normalizeString(value.action);
  const unsupportedAction = Boolean(action) && !isDirectorExtensionAction(action);
  postDirectorExtensionResponse({
    protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
    requestId,
    action: "unknown",
    ok: false,
    error: {
      code: unsupportedAction ? "unsupported-action" : "invalid-request",
      message: unsupportedAction ? `不支持的二创接口操作：${action}` : "二创接口请求缺少有效的 requestId 或 action",
    },
  });
}

export function postDirectorDeskCapturesToHost(
  captures: Array<{ dataUrl: string; fileName?: string }>
): string | null {
  const normalizedCaptures = captures
    .map((capture, index) => {
      const dataUrl = normalizeString(capture.dataUrl);
      if (!dataUrl) return null;
      return {
        dataUrl,
        fileName: normalizeString(capture.fileName) || `director-desk-capture-${index + 1}.png`,
      };
    })
    .filter((capture): capture is { dataUrl: string; fileName: string } => Boolean(capture));

  if (normalizedCaptures.length === 0) return null;

  const requestId = `capture-${Date.now()}-${++captureRequestSequence}`;
  postToHost("storyai:director-desk-captures-sent", {
    requestId,
    captures: normalizedCaptures.slice(0, 12),
  });
  return requestId;
}

export function subscribeToDirectorDeskCaptureDelivery(
  listener: (delivery: DirectorDeskCaptureDelivery) => void
) {
  captureDeliveryListeners.add(listener);
  return () => captureDeliveryListeners.delete(listener);
}

export function postDirectorDeskReadyToHost() {
  postDirectorDeskMessageToHost({ type: "storyai:director-desk-ready" });
}

export function postDirectorDeskCloseToHost() {
  postToHost("storyai:director-desk-close");
}

function hasValidSessionNonce(payload: unknown) {
  if (!hostSessionNonce) return true;
  if (!payload || typeof payload !== "object") return false;
  return normalizeString((payload as { nonce?: unknown }).nonce) === hostSessionNonce;
}

function handleHostProtocolMessage(message: DirectorDeskTransportMessage) {
  if (message.type === "storyai:director-desk-session") {
    openHostSession((message.payload || {}) as HostSessionPayload);
    return;
  }

  if (message.type === DIRECTOR_EXTENSION_REQUEST_TYPE) {
    void handleDirectorExtensionRequest(message.payload);
    return;
  }

  if (!hasValidSessionNonce(message.payload)) return;

  if (message.type === "storyai:director-desk-panorama") {
    importHostPanorama((message.payload || {}) as HostPanoramaPayload);
    return;
  }

  if (message.type === "storyai:director-desk-panorama-clear") {
    clearHostPanorama();
    return;
  }

  if (
    message.type === "storyai:director-desk-captures-accepted"
    || message.type === "storyai:director-desk-captures-failed"
  ) {
    const requestId = normalizeString(message.payload?.requestId);
    if (!requestId) return;
    const status = message.type === "storyai:director-desk-captures-accepted" ? "accepted" : "failed";
    const error = normalizeString(message.payload?.error) || undefined;
    captureDeliveryListeners.forEach((listener) => listener({ requestId, status, error }));
  }
}

function handleHostMessage(event: MessageEvent) {
  if (!isAllowedHostEvent(event)) return;
  if (!event.data || typeof event.data !== "object" || typeof event.data.type !== "string") return;
  handleHostProtocolMessage(event.data as DirectorDeskTransportMessage);
}

export function initDirectorDeskHostBridge() {
  if (initialized) return;
  initialized = true;
  applyDirectorDeskTheme(getInitialHostTheme() ?? "dark");
  window.addEventListener("message", handleHostMessage);
  subscribeToProjectChanges();
  void initTauriDirectorHostTransport(handleHostProtocolMessage).then((cleanup) => {
    if (!cleanup) return;
    if (!initialized) {
      cleanup();
      return;
    }
    clearTauriTransport = cleanup;
  });
}

export function clearDirectorDeskHostBridge() {
  if (!initialized) return;
  initialized = false;
  activeExtensionExportRequestId = null;
  hostConnectedPanorama = null;
  suppressNextPanoramaRemovalNotice = false;
  hostSessionNonce = "";
  captureDeliveryListeners.clear();
  if (projectChangeTimer) clearTimeout(projectChangeTimer);
  projectChangeTimer = null;
  window.removeEventListener("message", handleHostMessage);
  removeUnsubscribe?.();
  removeUnsubscribe = null;
  clearTauriTransport?.();
  clearTauriTransport = null;
}
