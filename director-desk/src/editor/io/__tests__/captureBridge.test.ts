import { afterEach, expect, it, vi } from "vitest";
import {
  clearViewportCaptureHandler,
  requestViewportCapture,
  setViewportCaptureHandler,
} from "../captureBridge";

afterEach(() => {
  clearViewportCaptureHandler();
});

it("forwards capture requests to the active canvas handler", async () => {
  const handler = vi.fn(async () => [
    {
      label: "当前视角",
      dataUrl: "data:image/png;base64,demo",
      meta: {
        mode: "director" as const,
        cameraId: null,
        fov: 50,
        position: [0, 2.2, 9] as [number, number, number],
        target: [0, 1.2, 0] as [number, number, number],
      },
    },
  ]);

  setViewportCaptureHandler(handler);

  const results = await requestViewportCapture({
    preset: "current",
    source: "capture-panel",
  });

  expect(handler).toHaveBeenCalledWith({
    preset: "current",
    source: "capture-panel",
  });
  expect(results[0]?.dataUrl).toContain("data:image/png");
});

it("throws a clear error when the viewport capture handler is missing", async () => {
  await expect(
    requestViewportCapture({
      preset: "current",
      source: "camera-panel",
      cameraId: "cam_1",
    })
  ).rejects.toThrow("Viewport capture handler is not registered");
});
