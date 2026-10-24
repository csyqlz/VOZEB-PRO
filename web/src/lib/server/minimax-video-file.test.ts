import { beforeEach, describe, expect, it, vi } from "vitest";
const { fetchSafeOutbound } = vi.hoisted(() => ({ fetchSafeOutbound: vi.fn() }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound }));
import { resolveHailuoVideoFile } from "./minimax-video-file";

const task = { task_id: "original", status: "Success", file_id: "9007199254740993", base_resp: { status_code: 0 } };
const headers = new Headers({ Authorization: "Bearer fixture-key" });
const signal = new AbortController().signal;
const resolve = (payload: unknown = task) => resolveHailuoVideoFile(payload, "original", "https://upstream.example/prefix/v1/query/video_generation?task_id=original", headers, signal);

describe("Hailuo original task file resolution", () => {
    beforeEach(() => vi.clearAllMocks());
    it("retrieves only the successful task's file through the same channel prefix", async () => {
        fetchSafeOutbound.mockResolvedValue(Response.json({ file: { file_id: task.file_id, download_url: "https://cdn.example/result.mp4" }, base_resp: { status_code: 0 } }));
        await expect(resolve()).resolves.toEqual({ ...task, download_url: "https://cdn.example/result.mp4" });
        expect(fetchSafeOutbound).toHaveBeenCalledExactlyOnceWith("https://upstream.example/prefix/v1/files/retrieve?file_id=9007199254740993", { headers, signal, cache: "no-store", redirect: "manual" });
    });
    it.each(["Preparing", "Queueing", "Processing", "Fail"])("does not retrieve files while status is %s", async (status) => {
        const payload = { ...task, status };
        await expect(resolve(payload)).resolves.toEqual(payload);
        expect(fetchSafeOutbound).not.toHaveBeenCalled();
    });
    it.each([{ task_id: "another" }, { file_id: undefined }, { file_id: Number.MAX_SAFE_INTEGER + 1 }, { base_resp: { status_code: 1004 } }])("rejects invalid original task credentials: %j", async (patch) => {
        await expect(resolve({ ...task, ...patch })).rejects.toThrow("原任务文件凭据");
        expect(fetchSafeOutbound).not.toHaveBeenCalled();
    });
    it.each([
        { file: { file_id: "another", download_url: "https://cdn.example/result.mp4" }, base_resp: { status_code: 0 } },
        { file: { file_id: task.file_id, download_url: "https://cdn.example/result.mp4" }, base_resp: { status_code: 1004 } },
        { file: { file_id: task.file_id, download_url: "javascript:alert(1)" }, base_resp: { status_code: 0 } },
    ])("rejects an invalid file response without treating it as a completed task", async (response) => {
        fetchSafeOutbound.mockResolvedValue(Response.json(response));
        await expect(resolve()).rejects.toThrow();
    });
});
