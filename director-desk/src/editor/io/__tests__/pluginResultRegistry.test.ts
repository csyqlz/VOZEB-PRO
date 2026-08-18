import { afterEach, expect, it, vi } from "vitest";
import {
  DIRECTOR_PLUGIN_RESULT_RECEIVED_EVENT,
  MAX_PLUGIN_RESULTS,
  clearDirectorPluginResults,
  listDirectorPluginResults,
  normalizeDirectorPluginResultInput,
  submitDirectorPluginResult,
  subscribeDirectorPluginResults,
} from "../pluginResultRegistry";

afterEach(clearDirectorPluginResults);

function input(fingerprint = "fnv1a32-current") {
  return {
    basedOnProjectFingerprint: fingerprint,
    data: { shots: [{ type: "over-shoulder", fov: 45 }] },
    kind: "camera-plan",
    plugin: { id: "group.qwen-planner", name: "群友镜头规划", version: "1.0.0" },
    status: "success" as const,
    summary: "生成一组稳定镜头参数",
  };
}

it("stores a detached current-project result and notifies subscribers", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeDirectorPluginResults(listener);
  const received = vi.fn();
  window.addEventListener(DIRECTOR_PLUGIN_RESULT_RECEIVED_EVENT, received);

  const record = submitDirectorPluginResult(input(), "fnv1a32-current", "2026-07-16T12:00:00.000Z");
  (record.data as { shots: unknown[] }).shots.length = 0;

  expect(listDirectorPluginResults()[0]).toMatchObject({
    id: "plugin-result-1",
    receivedAt: "2026-07-16T12:00:00.000Z",
    stale: false,
  });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(received).toHaveBeenCalledTimes(1);
  unsubscribe();
  window.removeEventListener(DIRECTOR_PLUGIN_RESULT_RECEIVED_EVENT, received);
});

it("marks a result stale when the project changed after the plugin read it", () => {
  expect(submitDirectorPluginResult(input("fnv1a32-old"), "fnv1a32-new").stale).toBe(true);
});

it("recomputes stale status when the project changes after submission", () => {
  submitDirectorPluginResult(input(), "fnv1a32-current");
  expect(listDirectorPluginResults("fnv1a32-current")[0]?.stale).toBe(false);
  expect(listDirectorPluginResults("fnv1a32-changed")[0]?.stale).toBe(true);
});

it("rejects unsafe identifiers, unserializable data, and oversized results", () => {
  expect(() => normalizeDirectorPluginResultInput({
    ...input(),
    plugin: { ...input().plugin, id: "bad plugin/id" },
  })).toThrow("插件 ID 只能使用");

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => normalizeDirectorPluginResultInput({ ...input(), data: circular })).toThrow("可序列化 JSON");
  expect(() => normalizeDirectorPluginResultInput({ ...input(), data: "x".repeat(513 * 1024) }))
    .toThrow("不能超过 512 KB");
});

it("keeps only the most recent bounded result history", () => {
  for (let index = 0; index < MAX_PLUGIN_RESULTS + 3; index += 1) {
    submitDirectorPluginResult({ ...input(), summary: `result-${index}` }, "fnv1a32-current");
  }
  const results = listDirectorPluginResults();
  expect(results).toHaveLength(MAX_PLUGIN_RESULTS);
  expect(results[0]?.summary).toBe("result-3");
  expect(results[results.length - 1]?.summary).toBe(`result-${MAX_PLUGIN_RESULTS + 2}`);
});
