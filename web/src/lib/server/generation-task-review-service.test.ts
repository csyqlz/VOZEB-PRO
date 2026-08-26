import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getRecord: vi.fn(),
    schedule: vi.fn(),
    getText: vi.fn(),
    updateText: vi.fn(),
    transitionText: vi.fn(),
    markTextFailed: vi.fn(),
    getImage: vi.fn(),
    updateImage: vi.fn(),
    markImageFailed: vi.fn(),
    getAudio: vi.fn(),
    updateAudio: vi.fn(),
    markAudioFailed: vi.fn(),
    getVideo: vi.fn(),
    updateVideo: vi.fn(),
    markVideoFailed: vi.fn(),
}));

vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getRecord }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/text-task-store", () => ({ getTextTask: mocks.getText, updateTextTask: mocks.updateText, transitionTextTask: mocks.transitionText }));
vi.mock("@/lib/server/text-task-runtime", () => ({ markTextTaskFailed: mocks.markTextFailed }));
vi.mock("@/lib/server/image-task-store", () => ({ getImageTask: mocks.getImage, updateImageTask: mocks.updateImage }));
vi.mock("@/lib/server/image-task-runtime", () => ({ markImageTaskFailed: mocks.markImageFailed }));
vi.mock("@/lib/server/audio-task-store", () => ({ getAudioTask: mocks.getAudio, updateAudioTask: mocks.updateAudio }));
vi.mock("@/lib/server/audio-task-runtime", () => ({ markAudioTaskFailed: mocks.markAudioFailed }));
vi.mock("@/lib/server/video-task-store", () => ({ getVideoTask: mocks.getVideo, updateVideoTask: mocks.updateVideo }));
vi.mock("@/lib/server/video-task-runtime", () => ({ failVideoTaskFromWorker: mocks.markVideoFailed }));

import { reviewGenerationTask } from "./generation-task-review-service";

describe("generation task manual review", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getRecord.mockResolvedValue({ executionPhase: "needs_review", submittedAt: 100 });
    });

    it("rejects tasks that are no longer waiting for review", async () => {
        mocks.getRecord.mockResolvedValueOnce({ executionPhase: "polling" });

        await expect(reviewGenerationTask("image", "image-one", { action: "provide_result", result: "https://cdn.example/image.png" })).rejects.toMatchObject({
            status: 409,
            message: "当前任务不需要人工确认",
        });
        expect(mocks.schedule).not.toHaveBeenCalled();
    });

    it("attaches an existing upstream task ID without creating another task", async () => {
        mocks.getImage.mockResolvedValue({ id: "image-one", config: { baseUrl: "/api/ai/system/channel-one" } });

        await expect(reviewGenerationTask("image", "image-one", { action: "resume_upstream", upstreamTaskId: "upstream-existing", origin: "http://internal" })).resolves.toEqual({
            action: "resume_upstream",
            executionPhase: "submitted",
        });
        expect(mocks.updateImage).toHaveBeenCalledWith("image-one", {
            upstream: {
                id: "upstream-existing",
                mediaBaseUrl: "http://internal/api/ai/system/channel-one",
                pollBaseUrl: "http://internal/api/ai/system/channel-one",
            },
        });
        expect(mocks.schedule).toHaveBeenCalledWith("image", "image-one", expect.objectContaining({ executionPhase: "submitted", upstreamTaskId: "upstream-existing", nextPollAt: expect.any(Number) }));
    });

    it("queues a supplied media URL for persistence and rejects unsafe schemes", async () => {
        await expect(reviewGenerationTask("video", "video-one", { action: "provide_result", result: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
        await expect(reviewGenerationTask("video", "video-one", { action: "provide_result", result: "https://cdn.example/video.mp4" })).resolves.toEqual({
            action: "provide_result",
            executionPhase: "result_ready",
        });
        expect(mocks.schedule).toHaveBeenLastCalledWith("video", "video-one", expect.objectContaining({ executionPhase: "result_ready", resultPayload: { url: "https://cdn.example/video.mp4" } }));
    });

    it("completes a text task directly with the supplied final text", async () => {
        const task = { id: "text-one", status: "running", config: { apiKey: "secret" } };
        mocks.getText.mockResolvedValue(task);
        mocks.transitionText.mockResolvedValue({ ...task, status: "success" });

        await expect(reviewGenerationTask("text", "text-one", { action: "provide_result", result: "人工核对后的结果" })).resolves.toEqual({
            action: "provide_result",
            executionPhase: "completed",
        });
        expect(mocks.transitionText).toHaveBeenCalledWith(task, ["pending", "running"], expect.objectContaining({ status: "success", result: { content: "人工核对后的结果" }, messages: [], config: { apiKey: "" } }));
        expect(mocks.schedule).toHaveBeenCalledWith("text", "text-one", expect.objectContaining({ executionPhase: "completed", nextPollAt: undefined }));
    });

    it.each([
        ["text", "text-one", mocks.getText, mocks.markTextFailed],
        ["image", "image-one", mocks.getImage, mocks.markImageFailed],
        ["video", "video-one", mocks.getVideo, mocks.markVideoFailed],
        ["audio", "audio-one", mocks.getAudio, mocks.markAudioFailed],
    ] as const)("uses the normal %s failure path so its runtime refunds billing exactly once", async (type, id, getTask, markFailed) => {
        const task = { id };
        getTask.mockResolvedValue(task);

        await reviewGenerationTask(type, id, { action: "confirm_failed", reason: "上游确认未创建" });

        expect(markFailed).toHaveBeenCalledWith(task, "上游确认未创建");
        expect(mocks.schedule).toHaveBeenCalledWith(type, id, expect.objectContaining({ executionPhase: "completed", lastUpstreamStatus: "manually_failed" }));
    });
});
