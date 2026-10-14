import type { CreativeGenerationMode } from "@/lib/creative-runtime-contract";
import type { CreativeAgentRun } from "@/services/api/creative";

export type CreativeRunPresentationItem = { key: string; label: string; value: string };

export function creativeRunPresentation(run: CreativeAgentRun | undefined, modelNames: ReadonlyMap<string, string>) {
    if (!run) return [];
    const mode = creativeRunMode(run);
    const mediaTasks = run.tasks.filter((task) => task.type === "image" || task.type === "video" || task.type === "audio");
    const tasks = mode ? mediaTasks.filter((task) => task.type === mode) : run.tasks;
    const preferences = mode ? run.generationPreferences?.[mode] : undefined;
    const items: CreativeRunPresentationItem[] = [];
    if (mode) items.push({ key: "mode", label: "类型", value: mediaModeLabel(mode) });

    const modelIds = uniqueText([...mediaTasks.map((task) => task.model), ...(run.requestedModelIds || [])]);
    if (modelIds.length) items.push({ key: "model", label: "模型", value: modelIds.map((id) => modelNames.get(id) || id).join(" + ") });

    const size = firstText(tasks.map((task) => task.ratio)) || (preferences && "size" in preferences ? preferences.size : undefined);
    if (size) items.push({ key: "size", label: mode === "video" ? "比例" : "尺寸", value: size });

    const quality = firstText(tasks.map((task) => task.quality)) || (preferences && "quality" in preferences ? preferences.quality : undefined);
    if (quality) items.push({ key: "quality", label: mode === "video" ? "清晰度" : "画质", value: qualityLabel(quality) });

    const seconds = firstNumber(tasks.map((task) => task.seconds)) || (preferences && "seconds" in preferences ? preferences.seconds : undefined);
    if (seconds) items.push({ key: "seconds", label: "时长", value: `${seconds}秒` });

    const voice = firstText(tasks.map((task) => task.voice)) || (preferences && "voice" in preferences ? preferences.voice : undefined);
    if (voice) items.push({ key: "voice", label: "音色", value: voice });
    const format = firstText(tasks.map((task) => task.format)) || (preferences && "format" in preferences ? preferences.format : undefined);
    if (format) items.push({ key: "format", label: "格式", value: format.toUpperCase() });

    const count = mediaTasks.reduce((total, task) => total + (task.count || 1), 0);
    if (count > 1) items.push({ key: "count", label: "数量", value: `${count}个结果` });
    items.push({ key: "status", label: "状态", value: runStatusLabel(run.status) });
    return items;
}

export function creativeRunDuration(run: CreativeAgentRun | undefined) {
    const startedAt = Number(run?.createdAt);
    const finishedAt = Number(run?.updatedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt <= startedAt) return "";
    const totalSeconds = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}小时${minutes ? `${minutes}分` : ""}`;
    if (minutes) return `${minutes}分${seconds ? `${seconds}秒` : ""}`;
    return `${seconds}秒`;
}

export function creativeRunMode(run: CreativeAgentRun | undefined): CreativeGenerationMode | undefined {
    const taskMode = run?.tasks.find((task) => task.type === "image" || task.type === "video" || task.type === "audio")?.type;
    return taskMode === "image" || taskMode === "video" || taskMode === "audio" ? taskMode : run?.generationPreferences?.mode;
}

export function mediaModeLabel(mode: CreativeGenerationMode) {
    return mode === "image" ? "图片生成" : mode === "video" ? "视频生成" : "音频生成";
}

function qualityLabel(value: string) {
    const labels: Record<string, string> = { auto: "智能", high: "高画质", medium: "标准", low: "快速" };
    return labels[value.toLowerCase()] || value;
}

function runStatusLabel(status: CreativeAgentRun["status"]) {
    if (status === "planning") return "规划中";
    if (status === "running") return "生成中";
    if (status === "paused") return "已暂停";
    if (status === "completed") return "已完成";
    if (status === "cancelled") return "已取消";
    return "失败";
}

function uniqueText(values: Array<string | undefined>) {
    return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function firstText(values: Array<string | undefined>) {
    return values.find((value) => Boolean(value?.trim()))?.trim();
}

function firstNumber(values: Array<number | undefined>) {
    return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}
