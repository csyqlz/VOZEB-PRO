import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    claim: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    fetchInternalApi: vi.fn(),
    get: vi.fn(),
    normalize: vi.fn(),
    refund: vi.fn(),
    register: vi.fn(),
    touch: vi.fn(),
    update: vi.fn(),
    writeLog: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refund }));
vi.mock("@/lib/globalaiopc-catalog", () => ({ resolveGlobalAiOpcPreset: vi.fn(() => undefined) }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi }));
vi.mock("@/lib/server/creative-runtime-service", () => ({ registerGenerationTaskAssetsForUser: mocks.register }));
vi.mock("@/lib/server/video-result-normalizer", () => ({ normalizeVideoResult: mocks.normalize }));
vi.mock("@/lib/server/video-task-log", () => ({ writeVideoGenerationLog: mocks.writeLog }));
vi.mock("@/lib/server/video-task-store", () => ({
    claimVideoTaskPoll: mocks.claim,
    completeReconciledVideoTask: mocks.complete,
    failReconciledVideoTask: mocks.fail,
    getVideoTask: mocks.get,
    touchVideoTask: mocks.touch,
    updateVideoTask: mocks.update,
}));
vi.mock("@/lib/server/generation-media-authorization", () => ({ generationMediaProxyHeaders: vi.fn(() => ({ "x-media-auth": "signed" })) }));

import { queryVideoTaskUpstream, refreshVideoTaskFromUpstream } from "./video-task-runtime";
import type { VideoTask } from "./video-task-store";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

describe("video task upstream reconciliation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.normalize.mockResolvedValue({ url: "/api/reference-assets/result.mp4", mimeType: "video/mp4", durationMs: 5_000 });
        mocks.register.mockResolvedValue(undefined);
        mocks.update.mockResolvedValue(undefined);
        mocks.writeLog.mockResolvedValue({});
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("forwards the maintenance worker identity when polling the internal system proxy", async () => {
        const token = "maintenance-token-used-by-generation-worker";
        const task = videoTask();
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", `${token}-maintenance`);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", token);
        mocks.fetchInternalApi.mockResolvedValue(json({ id: task.upstream.id, status: "processing" }));

        await expect(queryVideoTaskUpstream(task, "http://localhost", "", task.userId)).resolves.toMatchObject({ state: "pending" });

        const headers = new Headers((mocks.fetchInternalApi.mock.calls[0]?.[1] as RequestInit).headers);
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(headers.get("x-vozeb-pro-worker-user-id")).toBe(task.userId);
        expect(headers.has("cookie")).toBe(false);
    });

    it("treats a provider business error in the configured result field as failure", async () => {
        const task = videoTask({
            config: {
                ...videoTask().config,
                advancedConfig: { ...videoTask().config.advancedConfig, resultField: "content" } as NonNullable<VideoTask["config"]["advancedConfig"]>,
            },
        });
        mocks.fetchInternalApi.mockResolvedValue(json({ status: "completed", content: "TokenPony business error 0:" }));

        await expect(queryVideoTaskUpstream(task, "http://localhost", "session=test")).resolves.toEqual({
            state: "failed",
            status: "completed",
            error: "TokenPony business error 0:",
        });
    });

    it("recovers a locally timed-out task after the provider later returns a video", async () => {
        const task = videoTask({ status: "error", error: "视频任务长时间未更新，请重新查询或生成。" });
        const completed = { ...task, status: "success", result: { url: "/api/reference-assets/result.mp4", mimeType: "video/mp4", durationMs: 5_000 } };
        mocks.claim.mockResolvedValue(task);
        mocks.get.mockResolvedValue(task);
        mocks.fetchInternalApi.mockResolvedValue(json({ id: task.upstream.id, status: "completed", video_url: "https://cdn.example.com/result.mp4" }));
        mocks.complete.mockResolvedValue(completed);

        const result = await refreshVideoTaskFromUpstream(task, "http://localhost", "session=test");

        expect(result).toEqual(completed);
        expect(mocks.normalize).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/_media?url="), requestedDurationSeconds: 5 }));
        expect(mocks.complete).toHaveBeenCalledWith(task.id, expect.objectContaining({ url: "/api/reference-assets/result.mp4" }));
        expect(mocks.register).toHaveBeenCalledOnce();
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("polls and completes through a live Seedance-compatible fixture", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;

        try {
            const created = (await fetch(`${origin}/v1/seedance-special/videos`, { method: "POST" }).then((response) => response.json())) as { task_id: string };
            const task = videoTask({
                config: {
                    channelId: "fixture-video",
                    apiSource: "system",
                    baseUrl: origin,
                    apiKey: "system",
                    apiFormat: "openai",
                    model: "mock-video",
                    advancedConfig: { protocol: "seedance-special", queryPath: "/v1/result/:task_id", statusField: "status", resultField: "video_url" } as NonNullable<VideoTask["config"]["advancedConfig"]>,
                },
                upstream: { id: created.task_id, provider: "generation", model: "mock-video", pollPath: "/v1/seedance-special/videos", pointsCost: 1, pointsUnits: 1, pointsRecordId: "points-fixture" },
            });
            const completed = { ...task, status: "success" as const, result: { url: "/api/reference-assets/result.mp4", mimeType: "video/mp4", durationMs: 5_000 } };
            mocks.claim.mockResolvedValue(task);
            mocks.get.mockResolvedValue(task);
            mocks.fetchInternalApi.mockImplementation((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
            mocks.complete.mockResolvedValue(completed);

            await expect(refreshVideoTaskFromUpstream(task, "", "")).resolves.toEqual(completed);
            expect(fixture.requests.map((request) => request.path)).toEqual(["/v1/seedance-special/videos", `/v1/result/${created.task_id}`]);
            expect(mocks.normalize).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining(`${origin}/_media?url=`), requestedDurationSeconds: 5 }));
            expect(mocks.complete).toHaveBeenCalledOnce();
            expect(mocks.refund).not.toHaveBeenCalled();
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("polls a Gemini Veo operation and reads generateVideoResponse", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;

        try {
            const created = (await fetch(`${origin}/v1beta/models/veo-3.1-generate-preview:predictLongRunning`, { method: "POST", body: "{}" }).then((response) => response.json())) as { name: string };
            const operationId = created.name.split("/").at(-1) || "";
            const task = videoTask({
                config: {
                    channelId: "fixture-gemini",
                    apiSource: "system",
                    baseUrl: origin,
                    apiKey: "system",
                    apiFormat: "gemini",
                    model: "veo-3.1-generate-preview",
                    advancedConfig: { protocol: "gemini", queryPath: `/v1beta/models/veo-3.1-generate-preview/operations/${operationId}` } as NonNullable<VideoTask["config"]["advancedConfig"]>,
                },
                upstream: {
                    id: operationId,
                    provider: "generation",
                    model: "veo-3.1-generate-preview",
                    pollPath: "/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
                    queryPath: `/v1beta/models/veo-3.1-generate-preview/operations/${operationId}`,
                    pointsCost: 1,
                    pointsUnits: 1,
                    pointsRecordId: "points-gemini",
                },
            });
            const completed = { ...task, status: "success" as const, result: { url: "/api/reference-assets/result.mp4", mimeType: "video/mp4", durationMs: 5_000 } };
            mocks.claim.mockResolvedValue(task);
            mocks.get.mockResolvedValue(task);
            mocks.fetchInternalApi.mockImplementation((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
            mocks.complete.mockResolvedValue(completed);

            await expect(refreshVideoTaskFromUpstream(task, "", "")).resolves.toEqual(completed);
            expect(fixture.requests.map((request) => request.path)).toEqual(["/v1beta/models/veo-3.1-generate-preview:predictLongRunning", `/v1beta/models/veo-3.1-generate-preview/operations/${operationId}`]);
            expect(mocks.complete).toHaveBeenCalledWith(task.id, expect.objectContaining({ url: "/api/reference-assets/result.mp4" }));
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("persists the real provider failure and refunds a still-running task", async () => {
        const task = videoTask();
        const failed = { ...task, status: "error", error: "The output video may contain sensitive information" };
        mocks.claim.mockResolvedValue(task);
        mocks.fetchInternalApi.mockResolvedValue(json({ id: task.upstream.id, status: "failed", error: failed.error }));
        mocks.fail.mockResolvedValue(failed);

        const result = await refreshVideoTaskFromUpstream(task, "http://localhost", "session=test");

        expect(result).toEqual(failed);
        expect(mocks.fail).toHaveBeenCalledWith(task.id, failed.error, true);
        expect(mocks.refund).toHaveBeenCalledOnce();
        expect(mocks.normalize).not.toHaveBeenCalled();
    });

    it("keeps a queued provider task pending without settling or refunding it", async () => {
        const task = videoTask();
        mocks.claim.mockResolvedValue(task);
        mocks.fetchInternalApi.mockResolvedValue(json({ id: task.upstream.id, status: "processing" }));
        mocks.get.mockResolvedValue(task);

        const result = await refreshVideoTaskFromUpstream(task, "http://localhost", "session=test");

        expect(result).toEqual(task);
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(mocks.fail).not.toHaveBeenCalled();
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("recovers a completed New API video from the standard content endpoint when status queries are unavailable", async () => {
        const task = videoTask();
        mocks.fetchInternalApi.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url).endsWith(`/v1/videos/${task.upstream.id}/content`) && init?.method === "HEAD") {
                return new Response(null, { status: 200, headers: { "content-type": "video/mp4" } });
            }
            return json({ error: { message: "not implemented" } }, 501);
        });

        await expect(queryVideoTaskUpstream(task, "http://localhost", "session=test")).resolves.toEqual({
            state: "result_ready",
            status: "completed",
            resultUrl: `/v1/videos/${task.upstream.id}/content`,
        });
        expect(mocks.fetchInternalApi).toHaveBeenCalledWith(`http://localhost${task.config.baseUrl}/v1/videos/${task.upstream.id}/content`, expect.objectContaining({ method: "HEAD" }));
    });

    it("ignores an HTML fallback page before probing the standard video content endpoint", async () => {
        const task = videoTask();
        mocks.fetchInternalApi.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url).endsWith(`/v1/videos/${task.upstream.id}/content`) && init?.method === "HEAD") {
                return new Response(null, { status: 200, headers: { "content-type": "video/mp4" } });
            }
            return new Response("<!doctype html><title>New API</title>", { status: 200, headers: { "content-type": "text/html" } });
        });

        await expect(queryVideoTaskUpstream(task, "http://localhost", "session=test")).resolves.toMatchObject({
            state: "result_ready",
            resultUrl: `/v1/videos/${task.upstream.id}/content`,
        });
    });

    it("does not apply the Seedance special content fallback to the official New API protocol", async () => {
        const task = videoTask({
            config: {
                ...videoTask().config,
                advancedConfig: { protocol: "newapi", queryPath: "/v1/videos/:task_id" } as NonNullable<VideoTask["config"]["advancedConfig"]>,
            },
        });
        mocks.fetchInternalApi.mockResolvedValue(new Response("<!doctype html><title>New API</title>", { status: 200, headers: { "content-type": "text/html" } }));

        await expect(queryVideoTaskUpstream(task, "http://localhost", "session=test")).rejects.toThrow("视频接口返回了无效 JSON");
        expect(mocks.fetchInternalApi).toHaveBeenCalledOnce();
        expect((mocks.fetchInternalApi.mock.calls[0]?.[1] as RequestInit).method).toBeUndefined();
    });

    it("does not query upstream again before the polling interval elapses", async () => {
        const task = videoTask();
        mocks.claim.mockResolvedValue(null);
        mocks.get.mockResolvedValue(task);

        expect(await refreshVideoTaskFromUpstream(task, "http://localhost", "session=test")).toEqual(task);
        expect(mocks.fetchInternalApi).not.toHaveBeenCalled();
    });
});

function videoTask(patch: Partial<VideoTask> = {}): VideoTask {
    return {
        id: "local-video",
        userId: "user",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        config: {
            channelId: "channel",
            apiSource: "system",
            baseUrl: "/api/ai/system/channel",
            apiKey: "system",
            apiFormat: "openai",
            model: "sd_2.0_fast_special_720p",
            advancedConfig: { protocol: "seedance-special", queryPath: "/v1/result/:task_id", statusField: "status", resultField: "video_url" } as NonNullable<VideoTask["config"]["advancedConfig"]>,
        },
        upstream: { id: "videos_one", provider: "generation", model: "sd_2.0_fast_special_720p", pollPath: "/v1/seedance-special/videos", pointsCost: 1, pointsUnits: 1, pointsRecordId: "points-one" },
        requestedDurationSeconds: 5,
        source: "agent",
        prompt: "test",
        attempts: [{ attemptNo: 1, channelId: "channel", model: "sd_2.0_fast_special_720p", capability: "video", status: "running", startedAt: Date.now() }],
        ...patch,
    };
}

function json(value: unknown, status = 200) {
    return Response.json(value, { status });
}
