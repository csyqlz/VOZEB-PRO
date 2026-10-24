import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {});
const identifier = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "");

/** Resolve only the file returned by the already authorized, successful original task. */
export async function resolveHailuoVideoFile(payload: unknown, taskId: string, queryUrl: string, headers: Headers, signal: AbortSignal) {
    const task = object(payload);
    if (String(task.status).toLowerCase() !== "success") return payload;
    const fileId = identifier(task.file_id);
    if (identifier(task.task_id) !== taskId || !fileId || object(task.base_resp).status_code !== 0) throw new Error("Hailuo 完成响应缺少有效的原任务文件凭据");
    const fileTarget = new URL("../files/retrieve", queryUrl);
    fileTarget.searchParams.set("file_id", fileId);
    const fileResponse = await fetchSafeOutbound(fileTarget.toString(), { headers, cache: "no-store", redirect: "manual", signal });
    if (!fileResponse.ok) throw new Error("Hailuo 原任务文件查询失败");
    const response = object(await fileResponse.json());
    const file = object(response.file);
    if (object(response.base_resp).status_code !== 0 || identifier(file.file_id) !== fileId || typeof file.download_url !== "string") throw new Error("Hailuo 原任务文件地址暂不可用，请再次检查状态");
    const url = new URL(file.download_url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Hailuo 返回了无效的视频下载地址");
    return { ...task, download_url: file.download_url };
}
