import {
  comparePanoramaViewFingerprints,
  getPanoramaPixelDelta,
  type PanoramaPixelFingerprint,
} from "../panoramaPixelAnalysis";

function fingerprint(pixels: number[], luminance = 0.5): PanoramaPixelFingerprint {
  return { width: 1, height: 1, luminance, variance: 0.1, pixels };
}

it("normalizes pixel differences to a zero-to-one delta", () => {
  expect(getPanoramaPixelDelta(fingerprint([0, 0, 0]), fingerprint([255, 255, 255]))).toBe(1);
  expect(getPanoramaPixelDelta(fingerprint([10, 20, 30]), fingerprint([10, 20, 30]))).toBe(0);
});

it("compares every panorama view against one explicit baseline", () => {
  expect(comparePanoramaViewFingerprints({
    main: fingerprint([10, 20, 30]),
    monitor: fingerprint([11, 20, 30]),
    export: fingerprint([10, 22, 30]),
  }, "main")).toEqual({
    deltas: { main: 0, monitor: 0.001307, export: 0.002614 },
    maxDelta: 0.002614,
  });
});
