export const DIRECTOR_PLUGIN_RESULT_RECEIVED_EVENT = "storyai:director-desk-plugin-result";
export const MAX_PLUGIN_RESULT_BYTES = 512 * 1024;
export const MAX_PLUGIN_RESULTS = 50;

export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export interface DirectorPluginDescriptor {
  id: string;
  name: string;
  version: string;
}

export interface DirectorPluginResultInput {
  basedOnProjectFingerprint: string;
  data: PluginJsonValue;
  kind: string;
  plugin: DirectorPluginDescriptor;
  status: "success" | "error";
  summary: string;
}

export interface DirectorPluginResultRecord extends DirectorPluginResultInput {
  id: string;
  receivedAt: string;
  stale: boolean;
}

let sequence = 0;
let results: DirectorPluginResultRecord[] = [];
const listeners = new Set<(result: DirectorPluginResultRecord) => void>();

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeJsonData(value: unknown): PluginJsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("插件结果 data 必须是可序列化 JSON");
  }
  if (serialized === undefined) throw new Error("插件结果 data 必须是可序列化 JSON");
  if (new TextEncoder().encode(serialized).byteLength > MAX_PLUGIN_RESULT_BYTES) {
    throw new Error(`插件结果不能超过 ${MAX_PLUGIN_RESULT_BYTES / 1024} KB`);
  }
  return JSON.parse(serialized) as PluginJsonValue;
}

export function normalizeDirectorPluginResultInput(value: unknown): DirectorPluginResultInput {
  if (!value || typeof value !== "object") throw new Error("插件结果格式不完整");
  const input = value as Partial<DirectorPluginResultInput>;
  const plugin = input.plugin && typeof input.plugin === "object" ? input.plugin : {} as DirectorPluginDescriptor;
  const pluginId = boundedString(plugin.id, 80);
  const pluginName = boundedString(plugin.name, 120);
  const pluginVersion = boundedString(plugin.version, 40);
  const kind = boundedString(input.kind, 80);
  const summary = boundedString(input.summary, 500);
  const basedOnProjectFingerprint = boundedString(input.basedOnProjectFingerprint, 80);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) throw new Error("插件 ID 只能使用字母、数字、点、下划线和连字符");
  if (!pluginName || !pluginVersion || !kind || !summary || !basedOnProjectFingerprint) {
    throw new Error("插件结果缺少名称、版本、类型、摘要或工程指纹");
  }
  if (input.status !== "success" && input.status !== "error") throw new Error("插件结果 status 必须是 success 或 error");
  return {
    basedOnProjectFingerprint,
    data: normalizeJsonData(input.data),
    kind,
    plugin: { id: pluginId, name: pluginName, version: pluginVersion },
    status: input.status,
    summary,
  };
}

function cloneResult<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function submitDirectorPluginResult(
  value: unknown,
  currentProjectFingerprint: string,
  receivedAt = new Date().toISOString()
) {
  const input = normalizeDirectorPluginResultInput(value);
  sequence += 1;
  const record: DirectorPluginResultRecord = {
    ...input,
    id: `plugin-result-${sequence}`,
    receivedAt,
    stale: input.basedOnProjectFingerprint !== currentProjectFingerprint,
  };
  results = [...results, record].slice(-MAX_PLUGIN_RESULTS);
  const detached = cloneResult(record);
  listeners.forEach((listener) => listener(detached));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DIRECTOR_PLUGIN_RESULT_RECEIVED_EVENT, { detail: detached }));
  }
  return detached;
}

export function listDirectorPluginResults(currentProjectFingerprint?: string) {
  return cloneResult(results.map((result) => ({
    ...result,
    stale: currentProjectFingerprint
      ? result.basedOnProjectFingerprint !== currentProjectFingerprint
      : result.stale,
  })));
}

export function clearDirectorPluginResults() {
  results = [];
  sequence = 0;
}

export function subscribeDirectorPluginResults(listener: (result: DirectorPluginResultRecord) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
