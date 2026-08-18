import type {
  DirectorBenchmarkReport,
  PerformanceBenchmarkMode,
} from "./performanceBenchmark";

export const PERFORMANCE_BENCHMARK_COMPLETE_EVENT = "director:performance-benchmark-complete";
export const PERFORMANCE_BENCHMARK_REPORT_SCHEMA_VERSION = 3;

export interface PublicPerformanceBenchmarkReport {
  schemaVersion: 3;
  benchmark: {
    mode: DirectorBenchmarkReport["mode"];
    performanceProfile: DirectorBenchmarkReport["performanceProfile"];
    appVersion: string;
  };
  fps: {
    average: number;
    onePercentLow: number;
  };
  frameTimeMs: {
    average: number;
    p50FrameMs: number;
    p95FrameMs: number;
    p99FrameMs: number;
  };
  browser: string;
  operatingSystem: string;
  gpu: string;
  threads: number | null;
  sceneScale: {
    characters: number;
    props: number;
    monitorEnabled: boolean;
    panoramaEnabled: boolean;
  };
  canvas: DirectorBenchmarkReport["viewport"];
}

export function detectBrowserLabel(userAgent: string) {
  const candidates: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Version\/(\d+).+Safari\//, "Safari"],
  ];
  for (const [pattern, name] of candidates) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return `${name} ${match[1]}`;
  }
  return "未知浏览器";
}

export function detectOperatingSystemLabel(platform: string) {
  const normalized = platform.toLowerCase();
  if (normalized.includes("win")) return "Windows";
  if (normalized.includes("iphone") || normalized.includes("ipad") || normalized.includes("ipod")) return "iOS";
  if (normalized.includes("mac")) return "macOS";
  if (normalized.includes("cros")) return "ChromeOS";
  if (normalized.includes("android")) return "Android";
  if (normalized.includes("linux")) return "Linux";
  return "未知系统";
}

export function buildPublicPerformanceBenchmarkReport(
  report: DirectorBenchmarkReport
): PublicPerformanceBenchmarkReport {
  return {
    schemaVersion: PERFORMANCE_BENCHMARK_REPORT_SCHEMA_VERSION,
    benchmark: {
      mode: report.mode,
      performanceProfile: report.performanceProfile,
      appVersion: report.appVersion,
    },
    fps: {
      average: report.averageFps,
      onePercentLow: report.onePercentLowFps,
    },
    frameTimeMs: {
      average: report.averageFrameMs,
      p50FrameMs: report.p50FrameMs,
      p95FrameMs: report.p95FrameMs,
      p99FrameMs: report.p99FrameMs,
    },
    browser: report.system.browser,
    operatingSystem: detectOperatingSystemLabel(report.system.platform),
    gpu: report.system.webglRenderer,
    threads: report.system.hardwareConcurrency,
    sceneScale: {
      characters: report.scene.characters,
      props: report.scene.props,
      monitorEnabled: report.scene.monitorEnabled,
      panoramaEnabled: report.scene.panoramaEnabled,
    },
    canvas: { ...report.viewport },
  };
}

export function buildPerformanceBenchmarkUrl(
  href: string,
  mode: Exclude<PerformanceBenchmarkMode, "standard">,
  profile: DirectorBenchmarkReport["performanceProfile"]
) {
  const currentUrl = new URL(href);
  const url = new URL(currentUrl.pathname, currentUrl.origin);
  url.searchParams.set("benchmark", mode);
  url.searchParams.set("performance", profile);
  return url.toString();
}

export function downloadPerformanceBenchmarkReport(report: DirectorBenchmarkReport) {
  const publicReport = buildPublicPerformanceBenchmarkReport(report);
  const blob = new Blob([`${JSON.stringify(publicReport, null, 2)}\n`], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = "director-performance-report.json";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
