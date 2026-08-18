import { afterEach, expect, it, vi } from "vitest";
import {
  clearReferenceVideoExportHandler,
  downloadReferenceVideo,
  getSupportedReferenceVideoMimeType,
  normalizeReferenceVideoFileName,
  requestReferenceVideoExport,
  setReferenceVideoExportHandler,
} from "../referenceVideoExport";

afterEach(() => {
  clearReferenceVideoExportHandler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("returns the reference video blob produced by the active render pipeline", async () => {
  const blob = new Blob(["video"], { type: "video/mp4" });
  setReferenceVideoExportHandler(async (request) => ({
    blob,
    durationSeconds: 8,
    fileName: request.fileName,
    height: 720,
    mimeType: "video/mp4",
    width: 1280,
  }));

  await expect(requestReferenceVideoExport({ fileName: "镜头.webm", fps: 30, quality: "720p" }))
    .resolves.toMatchObject({ blob, durationSeconds: 8, fileName: "镜头.mp4" });
});

it("normalizes common video extensions to MP4", () => {
  expect(normalizeReferenceVideoFileName("镜头.webm")).toBe("镜头.mp4");
  expect(normalizeReferenceVideoFileName("镜头.mov")).toBe("镜头.mp4");
  expect(normalizeReferenceVideoFileName("  ")).toBe("director-reference.mp4");
});

it("only selects a real MP4 MediaRecorder type", () => {
  vi.stubGlobal("MediaRecorder", {
    isTypeSupported: vi.fn((type: string) => type === "video/mp4;codecs=avc1.42E01E"),
  });
  expect(getSupportedReferenceVideoMimeType()).toBe("video/mp4;codecs=avc1.42E01E");
});

it("downloads a returned video only when the UI asks for it", () => {
  const click = vi.fn();
  const appendChild = vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video-result");
  vi.spyOn(document, "createElement").mockReturnValue({
    click,
    remove: vi.fn(),
  } as unknown as HTMLAnchorElement);

  downloadReferenceVideo({
    blob: new Blob(["video"]),
    durationSeconds: 6,
    fileName: "参考.mp4",
    height: 720,
    mimeType: "video/mp4",
    width: 1280,
  });

  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(appendChild).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
});
