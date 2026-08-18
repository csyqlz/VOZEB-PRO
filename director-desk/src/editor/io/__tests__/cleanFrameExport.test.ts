import { afterEach, expect, it, vi } from "vitest";
import {
  clearCleanFrameExportHandler,
  requestCleanFrameExport,
  setCleanFrameExportHandler,
} from "../cleanFrameExport";

afterEach(clearCleanFrameExportHandler);

it("forwards clean frame options and returns the PNG result", async () => {
  const handler = vi.fn(async () => ({
    dataUrl: "data:image/png;base64,frame",
    fileName: "首帧.png",
    height: 720,
    mimeType: "image/png" as const,
    position: "first" as const,
    progress: 0,
    width: 1280,
  }));
  setCleanFrameExportHandler(handler);

  const result = await requestCleanFrameExport({ fileName: "首帧.png", position: "first", quality: "720p" });

  expect(handler).toHaveBeenCalledWith({ fileName: "首帧.png", position: "first", quality: "720p" });
  expect(result).toMatchObject({ mimeType: "image/png", progress: 0, width: 1280, height: 720 });
});

it("fails clearly before the clean render canvas is registered", async () => {
  await expect(requestCleanFrameExport({
    fileName: "当前帧.png",
    position: "current",
    quality: "1080p",
  })).rejects.toThrow("成片帧导出器尚未准备好");
});
