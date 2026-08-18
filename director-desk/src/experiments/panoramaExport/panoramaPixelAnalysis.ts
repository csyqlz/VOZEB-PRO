export interface PanoramaPixelFingerprint {
  height: number;
  luminance: number;
  pixels: number[];
  variance: number;
  width: number;
}

const ANALYSIS_WIDTH = 48;
const ANALYSIS_HEIGHT = 27;

export function createPanoramaPixelFingerprint(source: CanvasImageSource): PanoramaPixelFingerprint {
  const canvas = document.createElement("canvas");
  canvas.width = ANALYSIS_WIDTH;
  canvas.height = ANALYSIS_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建像素分析画布");
  context.drawImage(source, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const data = context.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
  const pixels: number[] = [];
  let luminanceTotal = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    pixels.push(red, green, blue);
    luminanceTotal += red * 0.2126 + green * 0.7152 + blue * 0.0722;
  }

  const luminance = luminanceTotal / (ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 255);
  let varianceTotal = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    const pixelLuminance = (
      (pixels[index] ?? 0) * 0.2126
      + (pixels[index + 1] ?? 0) * 0.7152
      + (pixels[index + 2] ?? 0) * 0.0722
    ) / 255;
    varianceTotal += Math.pow(pixelLuminance - luminance, 2);
  }

  return {
    height: ANALYSIS_HEIGHT,
    luminance: Number(luminance.toFixed(6)),
    pixels,
    variance: Number((varianceTotal / (ANALYSIS_WIDTH * ANALYSIS_HEIGHT)).toFixed(6)),
    width: ANALYSIS_WIDTH,
  };
}

export function getPanoramaPixelDelta(
  left: PanoramaPixelFingerprint,
  right: PanoramaPixelFingerprint,
) {
  if (left.pixels.length !== right.pixels.length) return Number.POSITIVE_INFINITY;
  const difference = left.pixels.reduce(
    (total, value, index) => total + Math.abs(value - (right.pixels[index] ?? 0)),
    0,
  );
  return Number((difference / (left.pixels.length * 255)).toFixed(6));
}

export function comparePanoramaViewFingerprints(
  fingerprints: Record<string, PanoramaPixelFingerprint>,
  baselineViewId: string,
) {
  const baseline = fingerprints[baselineViewId];
  if (!baseline) throw new Error(`缺少基准视图：${baselineViewId}`);
  const deltas = Object.fromEntries(
    Object.entries(fingerprints).map(([viewId, fingerprint]) => [
      viewId,
      getPanoramaPixelDelta(baseline, fingerprint),
    ]),
  );
  return {
    deltas,
    maxDelta: Math.max(...Object.values(deltas)),
  };
}
