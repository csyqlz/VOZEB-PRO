import { useCallback, useEffect, useMemo, useRef } from "react";

type DirectorAction =
  | "capabilities.get"
  | "project.get"
  | "timeline.get"
  | "export.frame"
  | "export.video"
  | "plugin.result.submit"
  | "plugin.results.list";

type DirectorResponse = {
  protocolVersion: number;
  requestId: string;
  action: DirectorAction | "unknown";
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

type PendingRequest = {
  action: DirectorAction;
  reject: (error: Error) => void;
  resolve: (response: DirectorResponse) => void;
  timeout: number;
};

const DIRECTOR_PROTOCOL_VERSION = 1;
const DIRECTOR_ACTIONS: readonly DirectorAction[] = [
  "capabilities.get",
  "project.get",
  "timeline.get",
  "export.frame",
  "export.video",
  "plugin.result.submit",
  "plugin.results.list",
];

function isDirectorResponse(value: unknown): value is DirectorResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<DirectorResponse>;
  return response.protocolVersion === DIRECTOR_PROTOCOL_VERSION
    && typeof response.requestId === "string"
    && (response.action === "unknown" || DIRECTOR_ACTIONS.includes(response.action as DirectorAction))
    && typeof response.ok === "boolean";
}

export interface DirectorDeskClient {
  exportFrame(options: { fileName?: string; position: "current" | "first" | "last"; quality: "720p" | "1080p" }): Promise<unknown>;
  exportVideo(options: { fileName?: string; fps: 24 | 30 | 60; quality: "720p" | "1080p" }): Promise<unknown>;
  getCapabilities(): Promise<unknown>;
  getProject(): Promise<unknown>;
  getTimeline(): Promise<unknown>;
  listPluginResults(): Promise<unknown>;
  request(action: DirectorAction, options?: Record<string, unknown>): Promise<unknown>;
  submitPluginResult(result: Record<string, unknown>): Promise<unknown>;
}

export function DirectorDeskFrame({
  directorOrigin = "http://localhost:5173",
  instanceId,
  onCaptures,
  onReady,
  theme = "dark",
}: {
  directorOrigin?: string;
  instanceId: string;
  onCaptures?: (captures: Array<{ dataUrl: string; fileName: string }>) => void;
  onReady?: (client: DirectorDeskClient) => void;
  theme?: "dark" | "light";
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const onCapturesRef = useRef(onCaptures);
  const onReadyRef = useRef(onReady);
  const hostOrigin = window.location.origin;
  const normalizedDirectorOrigin = new URL(directorOrigin).origin;
  const src = `${normalizedDirectorOrigin}/?instanceId=${encodeURIComponent(instanceId)}&theme=${theme}&hostOrigin=${encodeURIComponent(hostOrigin)}`;

  useEffect(() => {
    onCapturesRef.current = onCaptures;
  }, [onCaptures]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const request = useCallback(async (action: DirectorAction, options?: Record<string, unknown>) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) throw new Error("3D 导演台 iframe 尚未准备好");
    const requestId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(requestId);
        reject(new Error(`3D 导演台请求超时：${action}`));
      }, action === "export.video" ? 60_000 : 15_000);
      pendingRef.current.set(requestId, {
        action,
        timeout,
        reject,
        resolve: (response) => response.ok
          ? resolve(response.data)
          : reject(new Error(response.error?.message ?? "3D 导演台请求失败")),
      });
      target.postMessage({
        type: "storyai:director-desk:request",
        payload: { requestId, action, ...(options ? { options } : {}) },
      }, normalizedDirectorOrigin);
    });
  }, [normalizedDirectorOrigin]);

  const client = useMemo<DirectorDeskClient>(() => ({
    exportFrame: (options) => request("export.frame", options),
    exportVideo: (options) => request("export.video", options),
    getCapabilities: () => request("capabilities.get"),
    getProject: () => request("project.get"),
    getTimeline: () => request("timeline.get"),
    listPluginResults: () => request("plugin.results.list"),
    request,
    submitPluginResult: (result) => request("plugin.result.submit", { result }),
  }), [request]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== normalizedDirectorOrigin || event.source !== iframeRef.current?.contentWindow) return;

      if (event.data?.type === "storyai:director-desk-ready") {
        iframeRef.current?.contentWindow?.postMessage({
          type: "storyai:director-desk-session",
          payload: { instanceId, theme },
        }, normalizedDirectorOrigin);
        onReadyRef.current?.(client);
        return;
      }

      if (event.data?.type === "storyai:director-desk-captures-sent") {
        onCapturesRef.current?.(event.data.payload?.captures ?? []);
        return;
      }

      if (event.data?.type !== "storyai:director-desk:response") return;
      if (!isDirectorResponse(event.data.payload)) return;
      const response = event.data.payload;
      const pending = pendingRef.current.get(response.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingRef.current.delete(response.requestId);
      if (response.action !== pending.action) {
        pending.reject(new Error(`3D 导演台响应操作不匹配：期望 ${pending.action}，收到 ${response.action}`));
        return;
      }
      pending.resolve(response);
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      pendingRef.current.forEach((pending) => {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error("3D 导演台 iframe 已关闭"));
      });
      pendingRef.current.clear();
    };
  }, [client, instanceId, normalizedDirectorOrigin, theme]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title="3D 导演台"
      style={{ width: "100%", height: "100%", border: 0 }}
    />
  );
}
