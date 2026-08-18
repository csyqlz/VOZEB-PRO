import { Download, Gauge, Play, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDirectorStore } from "../store/directorStore";
import {
  PERFORMANCE_PROFILE_OPTIONS,
  PERFORMANCE_PROFILE_CONFIGS,
  getEffectivePerformanceProfile,
} from "./performanceProfiles";
import {
  getAutomaticPerformanceRuntimeSnapshot,
  subscribeAutomaticPerformanceRuntime,
} from "./automaticPerformanceRuntime";
import {
  PERFORMANCE_BENCHMARK_COMPLETE_EVENT,
  buildPerformanceBenchmarkUrl,
  downloadPerformanceBenchmarkReport,
} from "./performanceBenchmarkReport";
import {
  PERFORMANCE_BENCHMARK_SCENES,
  getPerformanceBenchmarkMode,
  type DirectorBenchmarkReport,
} from "./performanceBenchmark";

export function PerformanceSettings() {
  const profile = useDirectorStore((state) => state.performanceProfile);
  const setProfile = useDirectorStore((state) => state.setPerformanceProfile);
  const [open, setOpen] = useState(false);
  const [benchmarkStatus, setBenchmarkStatus] = useState(() => window.__DIRECTOR_BENCHMARK_STATUS__);
  const [benchmarkReport, setBenchmarkReport] = useState<DirectorBenchmarkReport | null>(
    () => window.__DIRECTOR_BENCHMARK_REPORT__ ?? null
  );
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const automaticRuntime = useSyncExternalStore(
    subscribeAutomaticPerformanceRuntime,
    getAutomaticPerformanceRuntimeSnapshot,
    getAutomaticPerformanceRuntimeSnapshot
  );
  const effectiveProfile = profile === "auto"
    ? PERFORMANCE_PROFILE_CONFIGS[automaticRuntime.effectiveProfileId]
    : getEffectivePerformanceProfile(profile);
  const benchmarkMode = getPerformanceBenchmarkMode(window.location.search);
  const selectedOption = PERFORMANCE_PROFILE_OPTIONS.find((option) => option.id === profile)
    ?? PERFORMANCE_PROFILE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!(event.target instanceof Node) || wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!benchmarkMode) return;
    function updateBenchmarkResult(event: Event) {
      const detail = (event as CustomEvent<DirectorBenchmarkReport>).detail;
      setBenchmarkReport(detail);
      setBenchmarkStatus("complete");
    }
    const interval = window.setInterval(() => {
      setBenchmarkStatus(window.__DIRECTOR_BENCHMARK_STATUS__);
    }, 250);
    window.addEventListener(PERFORMANCE_BENCHMARK_COMPLETE_EVENT, updateBenchmarkResult);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(PERFORMANCE_BENCHMARK_COMPLETE_EVENT, updateBenchmarkResult);
    };
  }, [benchmarkMode]);

  function openBenchmark(mode: "light" | "medium" | "heavy") {
    const url = buildPerformanceBenchmarkUrl(window.location.href, mode, effectiveProfile.id);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="performance-settings" ref={wrapperRef}>
      <button
        ref={triggerRef}
        aria-label={`性能 ${selectedOption.label}`}
        aria-controls="performance-settings-popover"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`performance-settings-trigger${open ? " is-active" : ""}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Gauge aria-hidden="true" size={15} strokeWidth={1.9} />
        <span>性能</span>
        <small>{selectedOption.label}</small>
      </button>

      {open ? (
        <section
          id="performance-settings-popover"
          aria-label="性能档位设置"
          className="performance-settings-popover"
          role="dialog"
        >
          <header className="performance-settings-header">
            <div>
              <strong>性能档位</strong>
              <small>切换后立即生效，并自动保存</small>
            </div>
            <button aria-label="关闭性能档位设置" type="button" onClick={() => setOpen(false)}>
              <X aria-hidden="true" size={15} />
            </button>
          </header>

          <div className="performance-profile-list" role="radiogroup" aria-label="选择性能档位">
            {PERFORMANCE_PROFILE_OPTIONS.map((option) => {
              const checked = option.id === profile;
              return (
                <button
                  key={option.id}
                  aria-checked={checked}
                  aria-label={`${option.label}：${option.description}`}
                  className={checked ? "is-selected" : ""}
                  role="radio"
                  type="button"
                  onClick={() => setProfile(option.id)}
                >
                  <span className="performance-profile-radio" aria-hidden="true" />
                  <span><strong>{option.label}</strong><small>{option.description}</small></span>
                </button>
              );
            })}
          </div>

          <p aria-label="当前实际性能档位" className="performance-settings-status">
            当前实际使用：<strong>{effectiveProfile.label}</strong>
            {profile === "auto" && automaticRuntime.averageFps !== null
              ? `，最近约 ${automaticRuntime.averageFps} FPS`
              : null}。只影响编辑预览，视频导出仍按导出面板选择的 720p / 1080p 生成。
          </p>

          <section className="performance-benchmark-tools" aria-label="标准性能测试">
            <header>
              <strong>标准性能测试</strong>
              <small>在新标签运行固定场景，不会改动当前导演台</small>
            </header>
            <div className="performance-benchmark-actions">
              {(["light", "medium", "heavy"] as const).map((mode) => (
                <button key={mode} type="button" onClick={() => openBenchmark(mode)}>
                  <Play aria-hidden="true" size={13} />
                  <span>{PERFORMANCE_BENCHMARK_SCENES[mode].label}</span>
                </button>
              ))}
            </div>
            {benchmarkMode ? (
              <div className="performance-benchmark-result" role="status">
                {benchmarkReport ? (
                  <>
                    <span>{benchmarkReport.averageFps} FPS · 低帧 {benchmarkReport.onePercentLowFps} FPS</span>
                    <button type="button" onClick={() => downloadPerformanceBenchmarkReport(benchmarkReport)}>
                      <Download aria-hidden="true" size={13} />
                      下载匿名报告
                    </button>
                  </>
                ) : (
                  <span>{benchmarkStatus === "sampling" ? "正在采样…" : "正在预热场景…"}</span>
                )}
              </div>
            ) : null}
          </section>
        </section>
      ) : null}
      {benchmarkMode ? (
        <aside className="performance-benchmark-hud" role="status" aria-label="性能基准进度">
          <div>
            <strong>{PERFORMANCE_BENCHMARK_SCENES[benchmarkMode].label}性能基准</strong>
            <small>{effectiveProfile.label}档</small>
          </div>
          {benchmarkReport ? (
            <>
              <span>{benchmarkReport.averageFps} FPS · 1% Low {benchmarkReport.onePercentLowFps}</span>
              <button type="button" onClick={() => downloadPerformanceBenchmarkReport(benchmarkReport)}>
                <Download aria-hidden="true" size={13} />
                下载匿名报告
              </button>
            </>
          ) : (
            <span>{benchmarkStatus === "sampling" ? "正在采样，约 6 秒" : "正在预热场景，约 2 秒"}</span>
          )}
        </aside>
      ) : null}
    </div>
  );
}
