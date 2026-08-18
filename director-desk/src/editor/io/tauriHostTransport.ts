export const DIRECTOR_DESK_HOST_EVENT = "director-desk:host-message";
export const DIRECTOR_DESK_MESSAGE_EVENT = "director-desk:message";

export interface DirectorDeskTransportMessage {
  type: string;
  payload?: Record<string, unknown>;
}

interface DirectorDeskTransportEnvelope {
  instanceId: string;
  message: DirectorDeskTransportMessage;
}

interface TauriEventApi {
  emit: (event: string, payload?: unknown) => Promise<void>;
  listen: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: {
      event?: TauriEventApi;
    };
  }
}

const ALLOWED_HOST_MESSAGE_TYPES = new Set([
  "storyai:director-desk-session",
  "storyai:director-desk-panorama",
  "storyai:director-desk:request",
]);

let activeInstanceId: string | null = null;
let unlistenHost: (() => void) | null = null;

function normalizeInstanceId(value: unknown) {
  if (typeof value !== "string") return null;
  const instanceId = value.trim();
  if (!instanceId || instanceId.length > 128) return null;
  return instanceId;
}

function isTauriTransportRequested() {
  try {
    return new URLSearchParams(window.location.search).get("transport") === "tauri";
  } catch {
    return false;
  }
}

function getTauriEventApi(): TauriEventApi | null {
  if (!isTauriTransportRequested()) return null;
  const eventApi = window.__TAURI__?.event;
  if (!eventApi || typeof eventApi.emit !== "function" || typeof eventApi.listen !== "function") {
    return null;
  }
  return eventApi;
}

function getInitialInstanceId() {
  try {
    return normalizeInstanceId(new URLSearchParams(window.location.search).get("instanceId"));
  } catch {
    return null;
  }
}

function parseHostEnvelope(value: unknown): DirectorDeskTransportEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const instanceId = normalizeInstanceId(candidate.instanceId);
  if (!instanceId || !candidate.message || typeof candidate.message !== "object") return null;
  const message = candidate.message as Record<string, unknown>;
  if (typeof message.type !== "string" || !ALLOWED_HOST_MESSAGE_TYPES.has(message.type)) return null;
  if (message.payload !== undefined && (!message.payload || typeof message.payload !== "object")) return null;
  return {
    instanceId,
    message: {
      type: message.type,
      ...(message.payload ? { payload: message.payload as Record<string, unknown> } : {}),
    },
  };
}

export function getCurrentDirectorDeskInstanceId() {
  activeInstanceId ??= getInitialInstanceId();
  return activeInstanceId;
}

export function postTauriDirectorHostMessage(
  message: DirectorDeskTransportMessage,
): boolean {
  const eventApi = getTauriEventApi();
  const instanceId = getCurrentDirectorDeskInstanceId();
  if (!eventApi || !instanceId) return false;
  void eventApi.emit(DIRECTOR_DESK_MESSAGE_EVENT, { instanceId, message }).catch((error) => {
    console.error("[director-desk] Tauri 消息发送失败", error);
  });
  return true;
}

export async function initTauriDirectorHostTransport(
  onMessage: (message: DirectorDeskTransportMessage) => void,
): Promise<(() => void) | null> {
  const eventApi = getTauriEventApi();
  if (!eventApi) return null;
  activeInstanceId ??= getInitialInstanceId();
  if (unlistenHost) return unlistenHost;

  unlistenHost = await eventApi.listen(DIRECTOR_DESK_HOST_EVENT, (event) => {
    const envelope = parseHostEnvelope(event.payload);
    if (!envelope) return;

    const isSession = envelope.message.type === "storyai:director-desk-session";
    if (isSession) {
      const payloadInstanceId = normalizeInstanceId(envelope.message.payload?.instanceId);
      if (payloadInstanceId !== envelope.instanceId) return;
      activeInstanceId = envelope.instanceId;
    } else if (envelope.instanceId !== activeInstanceId) {
      return;
    }

    onMessage(envelope.message);
  });

  return () => {
    unlistenHost?.();
    unlistenHost = null;
  };
}

export function resetTauriDirectorHostTransportForTests() {
  unlistenHost?.();
  unlistenHost = null;
  activeInstanceId = null;
}
