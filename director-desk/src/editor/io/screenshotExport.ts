export interface ScreenshotMeta {
  mode: "director" | "camera";
  cameraId: string | null;
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface ScreenshotResult {
  label: string;
  dataUrl: string;
  meta: ScreenshotMeta;
}

export function buildScreenshotMeta(input: ScreenshotMeta) {
  return input;
}

export function buildCaptureFileName(result: ScreenshotResult, index = 0) {
  const labelSlug = result.label.replace(/\s+/g, "-");
  const cameraSuffix = result.meta.cameraId ? `-${result.meta.cameraId}` : "";
  return `storyai-director-desk-${result.meta.mode}${cameraSuffix}-${labelSlug}-${index + 1}.png`;
}

export function downloadDataUrl(dataUrl: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.click();
}

export function downloadCaptureResults(results: ScreenshotResult[]) {
  results.forEach((result, index) => {
    downloadDataUrl(result.dataUrl, buildCaptureFileName(result, index));
  });

  return results.length;
}
