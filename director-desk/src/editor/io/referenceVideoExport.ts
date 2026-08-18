export type ReferenceVideoExportQuality = "720p" | "1080p";

export interface ReferenceVideoExportOptions {
  fps: number;
  quality: ReferenceVideoExportQuality;
}

export interface ReferenceVideoExportRequest extends ReferenceVideoExportOptions {
  fileName: string;
}

export interface ReferenceVideoExportResult {
  blob: Blob;
  durationSeconds: number;
  fileName: string;
  height: number;
  mimeType: string;
  width: number;
}

type ReferenceVideoExportHandler = (request: ReferenceVideoExportRequest) => Promise<ReferenceVideoExportResult>;

let exportHandler: ReferenceVideoExportHandler | null = null;

export function setReferenceVideoExportHandler(handler: ReferenceVideoExportHandler) {
  exportHandler = handler;
}

export function clearReferenceVideoExportHandler() {
  exportHandler = null;
}

export async function requestReferenceVideoExport(request: ReferenceVideoExportRequest) {
  if (!exportHandler) throw new Error("参考视频导出器尚未准备好");
  return exportHandler({ ...request, fileName: normalizeReferenceVideoFileName(request.fileName) });
}

export function normalizeReferenceVideoFileName(fileName: string) {
  const trimmed = fileName.trim() || "director-reference";
  return `${trimmed.replace(/\.(?:mp4|mov|webm)$/i, "")}.mp4`;
}

export function downloadReferenceVideo(result: ReferenceVideoExportResult) {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function getSupportedReferenceVideoMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}
