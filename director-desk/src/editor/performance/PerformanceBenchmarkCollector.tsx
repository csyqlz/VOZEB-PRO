import type { WebGLRenderer } from "three";
import type { EffectivePerformanceProfileId } from "./performanceProfiles";
import {
  STANDARD_BENCHMARK_SAMPLE_MS,
  STANDARD_BENCHMARK_WARMUP_MS,
  getPerformanceBenchmarkSceneConfig,
  summarizeBenchmarkFrames,
  type PerformanceBenchmarkMode,
} from "./performanceBenchmark";
import {
  PERFORMANCE_BENCHMARK_COMPLETE_EVENT,
  detectBrowserLabel,
} from "./performanceBenchmarkReport";

type RendererPeak = {
  calls: number;
  geometries: number;
  textures: number;
  triangles: number;
};

const EMPTY_PEAK: RendererPeak = {
  calls: 0,
  geometries: 0,
  textures: 0,
  triangles: 0,
};

export function startPerformanceBenchmarkCollection(
  gl: WebGLRenderer,
  mode: PerformanceBenchmarkMode,
  performanceProfile: EffectivePerformanceProfileId
) {
  const sceneConfig = getPerformanceBenchmarkSceneConfig(mode);
  const frameIntervals: number[] = [];
  const rendererPeak: RendererPeak = { ...EMPTY_PEAK };
  let animationFrame = 0;
  let previousFrameAt: number | null = null;
  let startedAt: number | null = null;
  let completed = false;
  gl.domElement.dataset.benchmarkStatus = "warming-up";
  delete gl.domElement.dataset.benchmarkReport;
  window.__DIRECTOR_BENCHMARK_STATUS__ = "warming-up";
  delete window.__DIRECTOR_BENCHMARK_REPORT__;

  function getWebGlRendererName() {
    try {
      const context = gl.getContext();
      const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
      return String(context.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER) ?? "unknown");
    } catch {
      return "unknown";
    }
  }

  function sample(now: number) {
    if (completed) return;
    if (startedAt === null) startedAt = now;
    const elapsed = now - startedAt;

    if (elapsed >= STANDARD_BENCHMARK_WARMUP_MS) {
      window.__DIRECTOR_BENCHMARK_STATUS__ = "sampling";
      gl.domElement.dataset.benchmarkStatus = "sampling";
      if (previousFrameAt !== null) frameIntervals.push(Math.max(0, now - previousFrameAt));
      previousFrameAt = now;
      rendererPeak.calls = Math.max(rendererPeak.calls, gl.info.render.calls);
      rendererPeak.triangles = Math.max(rendererPeak.triangles, gl.info.render.triangles);
      rendererPeak.geometries = Math.max(rendererPeak.geometries, gl.info.memory.geometries);
      rendererPeak.textures = Math.max(rendererPeak.textures, gl.info.memory.textures);
    }

    if (elapsed >= STANDARD_BENCHMARK_WARMUP_MS + STANDARD_BENCHMARK_SAMPLE_MS) {
      completed = true;
      const canvas = gl.domElement;
      const report = {
          status: "complete",
          mode,
          performanceProfile,
          appVersion: __APP_VERSION__,
          ...summarizeBenchmarkFrames(frameIntervals),
          canvasCount: document.querySelectorAll("canvas").length,
          devicePixelRatio: window.devicePixelRatio || 1,
        system: {
          browser: detectBrowserLabel(navigator.userAgent),
          hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
          platform: navigator.platform || "unknown",
          webglRenderer: getWebGlRendererName(),
        },
        renderer: { ...rendererPeak },
          scene: {
            characters: sceneConfig.characterCount,
            props: sceneConfig.propCount,
            monitorEnabled: sceneConfig.monitorEnabled,
            panoramaEnabled: sceneConfig.panoramaEnabled,
          },
          viewport: {
            cssHeight: canvas.clientHeight,
            cssWidth: canvas.clientWidth,
            pixelHeight: canvas.height,
            pixelWidth: canvas.width,
          },
      } satisfies NonNullable<Window["__DIRECTOR_BENCHMARK_REPORT__"]>;
      window.__DIRECTOR_BENCHMARK_REPORT__ = report;
      window.__DIRECTOR_BENCHMARK_STATUS__ = "complete";
      gl.domElement.dataset.benchmarkStatus = "complete";
      gl.domElement.dataset.benchmarkReport = JSON.stringify(report);
      window.dispatchEvent(new CustomEvent(PERFORMANCE_BENCHMARK_COMPLETE_EVENT, { detail: report }));
      return;
    }

    animationFrame = requestAnimationFrame(sample);
  }

  animationFrame = requestAnimationFrame(sample);
  return () => cancelAnimationFrame(animationFrame);
}
