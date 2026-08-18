import type { ReferenceVideoExportQuality } from "./referenceVideoExport";

export type CleanFramePosition = "current" | "first" | "last";

export interface CleanFrameExportRequest {
  fileName: string;
  position: CleanFramePosition;
  quality: ReferenceVideoExportQuality;
}

export interface CleanFrameExportResult {
  dataUrl: string;
  fileName: string;
  height: number;
  mimeType: "image/png";
  position: CleanFramePosition;
  progress: number;
  width: number;
}

type CleanFrameExportHandler = (request: CleanFrameExportRequest) => Promise<CleanFrameExportResult>;

let exportHandler: CleanFrameExportHandler | null = null;

export function setCleanFrameExportHandler(handler: CleanFrameExportHandler) {
  exportHandler = handler;
}

export function clearCleanFrameExportHandler() {
  exportHandler = null;
}

export async function requestCleanFrameExport(request: CleanFrameExportRequest) {
  if (!exportHandler) throw new Error("成片帧导出器尚未准备好");
  return exportHandler(request);
}
