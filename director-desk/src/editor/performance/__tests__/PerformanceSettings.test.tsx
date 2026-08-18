import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { publishAutomaticPerformanceRuntime } from "../automaticPerformanceRuntime";
import { PerformanceSettings } from "../PerformanceSettings";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  delete window.__DIRECTOR_BENCHMARK_REPORT__;
  delete window.__DIRECTOR_BENCHMARK_STATUS__;
  publishAutomaticPerformanceRuntime({ averageFps: null, effectiveProfileId: "balanced" });
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

it("shows the measured profile and recent FPS while automatic mode adapts", async () => {
  const user = userEvent.setup();
  render(<PerformanceSettings />);
  await user.click(screen.getByRole("button", { name: "性能 自动" }));

  act(() => publishAutomaticPerformanceRuntime({ averageFps: 41, effectiveProfileId: "fluid" }));

  expect(screen.getByLabelText("当前实际性能档位")).toHaveTextContent("流畅");
  expect(screen.getByLabelText("当前实际性能档位")).toHaveTextContent("41 FPS");
});

it("opens a clean temporary benchmark without carrying the current director desk", async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  window.history.replaceState({}, "", "/?instanceId=private_desk&token=secret");
  render(<PerformanceSettings />);
  await user.click(screen.getByRole("button", { name: "性能 自动" }));
  await user.click(screen.getByRole("button", { name: "重型" }));

  const openedUrl = new URL(String(open.mock.calls[0]?.[0]));
  expect([...openedUrl.searchParams.keys()].sort()).toEqual(["benchmark", "performance"]);
  expect(openedUrl.searchParams.get("benchmark")).toBe("heavy");
  expect(openedUrl.searchParams.get("performance")).toBe("balanced");
  expect(open).toHaveBeenCalledWith(openedUrl.toString(), "_blank", "noopener,noreferrer");
  open.mockRestore();
});

it("shows beginners only the requested auto, fluid and quality choices", async () => {
  const user = userEvent.setup();
  render(<PerformanceSettings />);

  const trigger = screen.getByRole("button", { name: "性能 自动" });
  await user.click(trigger);

  expect(screen.getByRole("dialog", { name: "性能档位设置" })).toBeInTheDocument();
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.getByRole("radio", { name: "自动：根据电脑性能自动选择" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "高清：优先保证画面清晰，适合性能较强的电脑" })).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "均衡：清晰度和操作流畅度兼顾" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("radio", { name: "流畅：优先降低卡顿，适合 Windows 集显和大场景" }));

  expect(useDirectorStore.getState().performanceProfile).toBe("fluid");
  expect(screen.getByLabelText("当前实际性能档位")).toHaveTextContent("流畅");
  expect(screen.getByText("只影响编辑预览", { exact: false })).toBeInTheDocument();
});

it("closes with Escape and returns focus to the trigger", async () => {
  const user = userEvent.setup();
  render(<PerformanceSettings />);

  const trigger = screen.getByRole("button", { name: "性能 自动" });
  await user.click(trigger);
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog", { name: "性能档位设置" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps benchmark progress and the anonymous download visible without opening settings", () => {
  window.history.replaceState({}, "", "/?benchmark=medium&performance=balanced");
  window.__DIRECTOR_BENCHMARK_REPORT__ = {
    status: "complete",
    mode: "medium",
    performanceProfile: "balanced",
    appVersion: "0.2.0",
    averageFps: 60,
    averageFrameMs: 16.67,
    frameCount: 360,
    longFrameRatio: 0,
    onePercentLowFps: 55,
    p50FrameMs: 16,
    p95FrameMs: 18,
    p99FrameMs: 20,
    canvasCount: 3,
    devicePixelRatio: 1,
    system: { browser: "Chrome 140", hardwareConcurrency: 16, platform: "Win32", webglRenderer: "RTX 3060" },
    renderer: { calls: 20, geometries: 15, textures: 4, triangles: 20_000 },
    scene: { characters: 5, props: 20, monitorEnabled: true, panoramaEnabled: false },
    viewport: { cssHeight: 720, cssWidth: 1280, pixelHeight: 720, pixelWidth: 1280 },
  };

  render(<PerformanceSettings />);

  const hud = screen.getByRole("status", { name: "性能基准进度" });
  expect(hud).toHaveTextContent("中等性能基准");
  expect(hud).toHaveTextContent("60 FPS · 1% Low 55");
  expect(within(hud).getByRole("button", { name: "下载匿名报告" })).toBeInTheDocument();
});
