import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTOR_DESK_HOST_EVENT,
  DIRECTOR_DESK_MESSAGE_EVENT,
  getCurrentDirectorDeskInstanceId,
  initTauriDirectorHostTransport,
  postTauriDirectorHostMessage,
  resetTauriDirectorHostTransportForTests,
} from "../tauriHostTransport";

describe("tauriHostTransport", () => {
  const emit = vi.fn(async () => undefined);
  const unlisten = vi.fn();
  let eventHandler: ((event: { payload: unknown }) => void) | null = null;

  beforeEach(() => {
    window.history.replaceState({}, "", "/?transport=tauri&instanceId=node-14");
    emit.mockClear();
    unlisten.mockClear();
    eventHandler = null;
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        event: {
          emit,
          listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
            eventHandler = handler;
            return unlisten;
          }),
        },
      },
    });
    resetTauriDirectorHostTransportForTests();
  });

  afterEach(() => {
    resetTauriDirectorHostTransportForTests();
    Reflect.deleteProperty(window, "__TAURI__");
  });

  it("emits a director message with the active instance id", async () => {
    await postTauriDirectorHostMessage({ type: "storyai:director-desk-ready" });

    expect(emit).toHaveBeenCalledWith(DIRECTOR_DESK_MESSAGE_EVENT, {
      instanceId: "node-14",
      message: { type: "storyai:director-desk-ready" },
    });
  });

  it("listens for host messages and allows a session to switch instances", async () => {
    const onMessage = vi.fn();
    await initTauriDirectorHostTransport(onMessage);

    expect(eventHandler).not.toBeNull();
    eventHandler?.({
      payload: {
        instanceId: "node-22",
        message: {
          type: "storyai:director-desk-session",
          payload: { instanceId: "node-22", theme: "dark" },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "storyai:director-desk-session",
    }));
    expect(getCurrentDirectorDeskInstanceId()).toBe("node-22");
  });

  it("rejects mismatched non-session messages", async () => {
    const onMessage = vi.fn();
    await initTauriDirectorHostTransport(onMessage);

    eventHandler?.({
      payload: {
        instanceId: "node-99",
        message: { type: "storyai:director-desk:request", payload: {} },
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(getCurrentDirectorDeskInstanceId()).toBe("node-14");
  });

  it("does not initialize outside the explicit Tauri transport mode", async () => {
    window.history.replaceState({}, "", "/?instanceId=node-14");
    const onMessage = vi.fn();

    const cleanup = await initTauriDirectorHostTransport(onMessage);

    expect(cleanup).toBeNull();
    expect(eventHandler).toBeNull();
    expect(await postTauriDirectorHostMessage({ type: "ignored" })).toBe(false);
  });

  it("uses the expected host event name", () => {
    expect(DIRECTOR_DESK_HOST_EVENT).toBe("director-desk:host-message");
  });
});
