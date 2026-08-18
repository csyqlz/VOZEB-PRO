import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDirectorDeskHostBridge,
  initDirectorDeskHostBridge,
  postDirectorDeskCapturesToHost,
  postDirectorDeskCloseToHost,
  subscribeToDirectorDeskCaptureDelivery,
} from "../hostBridge";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { setRuntimePlaybackProgress } from "../../runtime/playbackRuntime";
import { DIRECTOR_EXTENSION_REQUEST_TYPE, DIRECTOR_EXTENSION_RESPONSE_TYPE } from "../extensionProtocol";
import { clearCleanFrameExportHandler, setCleanFrameExportHandler } from "../cleanFrameExport";
import { clearReferenceVideoExportHandler, setReferenceVideoExportHandler } from "../referenceVideoExport";
import { clearDirectorPluginResults } from "../pluginResultRegistry";
import { getDirectorProjectFingerprint } from "../projectDocument";

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  useDirectorStore.getState().openScopedScene(null);
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

afterEach(() => {
  clearDirectorDeskHostBridge();
  clearCleanFrameExportHandler();
  clearReferenceVideoExportHandler();
  clearDirectorPluginResults();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves the VOZEB session nonce for captures, delivery receipts, and close", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const onDelivery = vi.fn();
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: "storyai:director-desk-session",
      payload: { instanceId: "node_director_nonce", nonce: "session-nonce" },
    },
    origin: window.location.origin,
  }));

  const unsubscribe = subscribeToDirectorDeskCaptureDelivery(onDelivery);
  const requestId = postDirectorDeskCapturesToHost([
    { dataUrl: "data:image/png;base64,capture", fileName: "capture.png" },
  ]);

  expect(requestId).toMatch(/^capture-/);
  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-captures-sent",
      payload: {
        captures: [{ dataUrl: "data:image/png;base64,capture", fileName: "capture.png" }],
        nonce: "session-nonce",
        requestId,
      },
    },
    window.location.origin
  );

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: "storyai:director-desk-captures-accepted",
      payload: { requestId, nonce: "wrong-nonce" },
    },
    origin: window.location.origin,
  }));
  expect(onDelivery).not.toHaveBeenCalled();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: "storyai:director-desk-captures-accepted",
      payload: { requestId, nonce: "session-nonce" },
    },
    origin: window.location.origin,
  }));
  expect(onDelivery).toHaveBeenCalledWith({ requestId, status: "accepted", error: undefined });

  postDirectorDeskCloseToHost();
  expect(postMessage).toHaveBeenLastCalledWith(
    { type: "storyai:director-desk-close", payload: { nonce: "session-nonce" } },
    window.location.origin
  );
  unsubscribe();
});

it("loads the VOZEB project snapshot and reports later project changes", () => {
  vi.useFakeTimers();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const project = structuredClone(useDirectorStore.getState().project);
  project.scene.backgroundColor = "#112233";
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: "storyai:director-desk-session",
      payload: {
        instanceId: "node_director_project",
        nonce: "project-nonce",
        project,
      },
    },
    origin: window.location.origin,
  }));

  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#112233");
  postMessage.mockClear();
  useDirectorStore.getState().updateScene({ backgroundColor: "#334455" });
  vi.advanceTimersByTime(500);

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-project-changed",
      payload: expect.objectContaining({
        nonce: "project-nonce",
        project: expect.objectContaining({
          scene: expect.objectContaining({ backgroundColor: "#334455" }),
        }),
      }),
    },
    window.location.origin
  );
  vi.useRealTimers();
});

it("imports a valid host panorama into the active director scene", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director",
          sourceNodeId: "node_image",
          imageUrl: "data:image/png;base64,panorama",
          fileName: "画布图片.png",
        },
      },
      origin: window.location.origin,
    })
  );

  const state = useDirectorStore.getState();
  const panoramaAsset = state.project.assets.find((asset) => asset.id === state.project.panoramaAssetId);
  expect(panoramaAsset).toMatchObject({
    kind: "panorama",
    sourceType: "image",
    name: "画布图片.png",
    fileName: "画布图片.png",
    url: "data:image/png;base64,panorama",
    projectionMode: "equirectangular",
  });
});

it("rejects host panorama messages from an unexpected origin", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director",
          sourceNodeId: "node_image",
          imageUrl: "data:image/png;base64,panorama",
          fileName: "画布图片.png",
        },
      },
      origin: "https://unexpected-host.example",
    })
  );

  expect(useDirectorStore.getState().project.panoramaAssetId).toBeNull();
});

it("rejects host panorama messages with incomplete source metadata", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director",
          imageUrl: "data:image/png;base64,panorama",
          fileName: "画布图片.png",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(useDirectorStore.getState().project.panoramaAssetId).toBeNull();
});

it("switches director store persistence when the host sends a card session", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
    })
  );

  useDirectorStore.getState().updateScene({ backgroundColor: "#151515" });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_b",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#000000");

  useDirectorStore.getState().updateScene({ backgroundColor: "#303640" });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#151515");
});

it("applies the light theme sent by the host session to the director desk document", () => {
  document.documentElement.classList.add("dark");
  document.documentElement.dataset.theme = "dark";
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_light",
          theme: "light",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("applies the dark theme sent by the host session to the director desk document", () => {
  document.documentElement.dataset.theme = "light";
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_dark",
          theme: "dark",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("keeps host panoramas isolated between scoped director scenes", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
    })
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director-a",
          sourceNodeId: "node_image_a",
          imageUrl: "data:image/png;base64,panorama-a",
          fileName: "画布图片A.png",
        },
      },
      origin: window.location.origin,
    })
  );

  const sceneAPanoramaId = useDirectorStore.getState().project.panoramaAssetId;
  expect(
    useDirectorStore.getState().project.assets.find((asset) => asset.id === sceneAPanoramaId)?.url
  ).toBe("data:image/png;base64,panorama-a");

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_b",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(useDirectorStore.getState().project.panoramaAssetId).toBeNull();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director-b",
          sourceNodeId: "node_image_b",
          imageUrl: "https://assets.example/panorama-b.jpg",
          fileName: "画布图片B.jpg",
        },
      },
      origin: window.location.origin,
    })
  );

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
    })
  );

  expect(
    useDirectorStore.getState().project.assets.find((asset) => asset.id === sceneAPanoramaId)?.url
  ).toBe("data:image/png;base64,panorama-a");

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_b",
        },
      },
      origin: window.location.origin,
    })
  );

  const sceneBPanoramaId = useDirectorStore.getState().project.panoramaAssetId;
  expect(sceneBPanoramaId).not.toBe(sceneAPanoramaId);
  expect(
    useDirectorStore.getState().project.assets.find((asset) => asset.id === sceneBPanoramaId)?.url
  ).toBe("https://assets.example/panorama-b.jpg");
});

it("returns a versioned project snapshot to an allowed host", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "project-request", action: "project.get" },
    },
    origin: window.location.origin,
  }));

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: DIRECTOR_EXTENSION_RESPONSE_TYPE,
      payload: expect.objectContaining({
        requestId: "project-request",
        action: "project.get",
        ok: true,
        data: expect.objectContaining({ projectSchemaVersion: 1, project: expect.objectContaining({ version: 1 }) }),
      }),
    }),
    window.location.origin
  );
});

it("returns the current runtime timeline without changing playback", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  setRuntimePlaybackProgress(0.42);
  useDirectorStore.setState({ cameraMotionPlaying: true, viewMode: "camera" });
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "timeline-request", action: "timeline.get" },
    },
    origin: window.location.origin,
  }));

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: "timeline-request",
        ok: true,
        data: expect.objectContaining({ progress: 0.42, playing: true, viewMode: "camera" }),
      }),
    }),
    window.location.origin
  );
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
});

it("rejects unsupported extension actions with a correlated error", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "bad-request", action: "project.delete" },
    },
    origin: window.location.origin,
  }));

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: DIRECTOR_EXTENSION_RESPONSE_TYPE,
      payload: {
        protocolVersion: 1,
        requestId: "bad-request",
        action: "unknown",
        ok: false,
        error: {
          code: "unsupported-action",
          message: "不支持的二创接口操作：project.delete",
        },
      },
    },
    window.location.origin
  );
});

it("does not answer extension requests from an unexpected origin", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "foreign-request", action: "capabilities.get" },
    },
    origin: "https://unexpected-host.example",
  }));

  expect(postMessage).not.toHaveBeenCalled();
});

it("does not answer same-origin extension requests from a window other than the iframe parent", () => {
  const parentWindow = { postMessage: vi.fn() } as unknown as Window;
  vi.spyOn(window, "parent", "get").mockReturnValue(parentWindow);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "wrong-source-request", action: "capabilities.get" },
    },
    origin: window.location.origin,
    source: window,
  }));

  expect(parentWindow.postMessage).not.toHaveBeenCalled();
});

it("returns a clean first frame through the extension protocol", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  setCleanFrameExportHandler(async (request) => ({
    dataUrl: "data:image/png;base64,first-frame",
    fileName: request.fileName,
    height: 1080,
    mimeType: "image/png",
    position: request.position,
    progress: 0,
    width: 1920,
  }));
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: {
        requestId: "first-frame-request",
        action: "export.frame",
        options: { fileName: "首帧.png", position: "first", quality: "1080p" },
      },
    },
    origin: window.location.origin,
  }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: "first-frame-request",
        ok: true,
        data: expect.objectContaining({ dataUrl: "data:image/png;base64,first-frame", progress: 0 }),
      }),
    }),
    window.location.origin
  ));
});

it.each([
  { position: "current" as const, expectedProgress: 0.42 },
  { position: "last" as const, expectedProgress: 1 },
])("returns a clean $position frame through the extension protocol", async ({ position, expectedProgress }) => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  setRuntimePlaybackProgress(0.42);
  setCleanFrameExportHandler(async (request) => ({
    dataUrl: `data:image/png;base64,${position}-frame`,
    fileName: request.fileName,
    height: 720,
    mimeType: "image/png",
    position: request.position,
    progress: request.position === "last" ? 1 : 0.42,
    width: 1280,
  }));
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: {
        requestId: `${position}-frame-request`,
        action: "export.frame",
        options: { fileName: `${position}.png`, position, quality: "720p" },
      },
    },
    origin: window.location.origin,
  }));

  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: `${position}-frame-request`,
        ok: true,
        data: expect.objectContaining({
          dataUrl: `data:image/png;base64,${position}-frame`,
          position,
          progress: expectedProgress,
        }),
      }),
    }),
    window.location.origin
  ));
});

it("returns a video Blob without forcing a browser download", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const blob = new Blob(["video"], { type: "video/mp4" });
  setReferenceVideoExportHandler(async (request) => ({
    blob,
    durationSeconds: 8,
    fileName: request.fileName,
    height: 720,
    mimeType: "video/mp4",
    width: 1280,
  }));
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "video-request", action: "export.video", options: { fps: 30 } },
    },
    origin: window.location.origin,
  }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: "video-request",
        ok: true,
        data: expect.objectContaining({ blob, mimeType: "video/mp4" }),
      }),
    }),
    window.location.origin
  ));
});

it("rejects a concurrent media export while the first export is still running", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  let finishFirstExport!: (result: {
    dataUrl: string;
    fileName: string;
    height: number;
    mimeType: "image/png";
    position: "first";
    progress: number;
    width: number;
  }) => void;
  setCleanFrameExportHandler((request) => new Promise((resolve) => {
    finishFirstExport = resolve;
    expect(request.position).toBe("first");
  }));
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: {
        requestId: "long-frame-request",
        action: "export.frame",
        options: { position: "first" },
      },
    },
    origin: window.location.origin,
  }));
  await vi.waitFor(() => expect(typeof finishFirstExport).toBe("function"));

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "busy-video-request", action: "export.video" },
    },
    origin: window.location.origin,
  }));

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: "busy-video-request",
        action: "export.video",
        ok: false,
        error: expect.objectContaining({ code: "export-busy" }),
      }),
    }),
    window.location.origin
  );

  finishFirstExport({
    dataUrl: "data:image/png;base64,first",
    fileName: "first-frame.png",
    height: 720,
    mimeType: "image/png",
    position: "first",
    progress: 0,
    width: 1280,
  });
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ requestId: "long-frame-request", ok: true }) }),
    window.location.origin
  ));
});

it("returns a correlated export error when no renderer is ready", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "missing-exporter", action: "export.frame" },
    },
    origin: window.location.origin,
  }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    {
      type: DIRECTOR_EXTENSION_RESPONSE_TYPE,
      payload: {
        protocolVersion: 1,
        requestId: "missing-exporter",
        action: "export.frame",
        ok: false,
        error: { code: "export-failed", message: "成片帧导出器尚未准备好" },
      },
    },
    window.location.origin
  ));
});

it("accepts a bounded plugin result and exposes it through the result inbox", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const fingerprint = getDirectorProjectFingerprint(useDirectorStore.getState().project);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: {
        requestId: "plugin-submit",
        action: "plugin.result.submit",
        options: {
          result: {
            basedOnProjectFingerprint: fingerprint,
            data: { prompt: "camera dolly in" },
            kind: "camera-plan",
            plugin: { id: "group.camera-agent", name: "镜头 Agent", version: "1.0" },
            status: "success",
            summary: "生成镜头建议",
          },
        },
      },
    },
    origin: window.location.origin,
  }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ requestId: "plugin-submit", ok: true }) }),
    window.location.origin
  ));
  postMessage.mockClear();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: { requestId: "plugin-list", action: "plugin.results.list" },
    },
    origin: window.location.origin,
  }));

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: "plugin-list",
        ok: true,
        data: [expect.objectContaining({ stale: false, summary: "生成镜头建议" })],
      }),
    }),
    window.location.origin
  );
});

it("rejects an invalid plugin result without storing it", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(new MessageEvent("message", {
    data: {
      type: DIRECTOR_EXTENSION_REQUEST_TYPE,
      payload: {
        requestId: "invalid-plugin",
        action: "plugin.result.submit",
        options: { result: { plugin: { id: "bad/id" } } },
      },
    },
    origin: window.location.origin,
  }));

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        requestId: "invalid-plugin",
        ok: false,
        error: expect.objectContaining({ code: "invalid-plugin-result" }),
      }),
    }),
    window.location.origin
  );
});
