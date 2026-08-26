import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    claim: vi.fn(),
    release: vi.fn(),
    renew: vi.fn(),
    schedule: vi.fn(),
    executeAgentRun: vi.fn(),
    processAgentRunReview: vi.fn(),
    getAgentRun: vi.fn(),
    getImageTask: vi.fn(),
    updateImageTask: vi.fn(),
    getVideoTask: vi.fn(),
    queryVideoTaskUpstream: vi.fn(),
    getAudioTask: vi.fn(),
    updateAudioTask: vi.fn(),
    queryAudioTaskUpstreamStep: vi.fn(),
    queryCancelledImageTaskUpstreamStep: vi.fn(),
    createImageTaskUpstreamStep: vi.fn(),
    queryImageTaskUpstreamStep: vi.fn(),
    prepareImageTaskAutomaticRetry: vi.fn(),
    markImageTaskFailed: vi.fn(),
    persistImageTaskResult: vi.fn(),
    queryCancelledTextTaskUpstreamStep: vi.fn(),
    getTextTask: vi.fn(),
    updateTextTask: vi.fn(),
    runTextTaskStep: vi.fn(),
    requestCancellation: vi.fn(),
    refundImageTask: vi.fn(),
    refundVideoTask: vi.fn(),
    refundAudioTask: vi.fn(),
    refundTextTask: vi.fn(),
    getAuthSettings: vi.fn(),
    resolveModelRequestTimeoutMs: vi.fn(),
}));

vi.mock("@/lib/server/generation-task-scheduler", () => ({
    claimDueGenerationTasks: mocks.claim,
    releaseGenerationTaskLease: mocks.release,
    renewGenerationTaskLeases: mocks.renew,
    scheduleGenerationTask: mocks.schedule,
    generationTaskNextPollAt: vi.fn(() => 20_000),
}));
vi.mock("@/lib/server/agent-run-executor", () => ({ executeAgentRun: mocks.executeAgentRun }));
vi.mock("@/lib/server/agent-run-execution", () => ({ processAgentRunReview: mocks.processAgentRunReview }));
vi.mock("@/lib/server/agent-run-store", () => ({ getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/maintenance-auth", () => ({ maintenanceWorkerContext: vi.fn((userId: string) => `worker-context:${userId}`) }));
vi.mock("@/lib/server/video-task-runtime", () => ({ failVideoTaskFromWorker: vi.fn(), persistVideoTaskResult: vi.fn(), queryVideoTaskUpstream: mocks.queryVideoTaskUpstream }));
vi.mock("@/lib/server/video-task-store", () => ({ getVideoTask: mocks.getVideoTask }));
vi.mock("@/lib/server/audio-task-runtime", () => ({ createAudioTaskUpstreamStep: vi.fn(), markAudioTaskFailed: vi.fn(), persistAudioTaskResult: vi.fn(), queryAudioTaskUpstreamStep: mocks.queryAudioTaskUpstreamStep }));
vi.mock("@/lib/server/audio-task-store", () => ({ getAudioTask: mocks.getAudioTask, updateAudioTask: mocks.updateAudioTask }));
vi.mock("@/lib/server/image-task-runtime", () => ({
    createImageTaskUpstreamStep: mocks.createImageTaskUpstreamStep,
    markImageTaskFailed: mocks.markImageTaskFailed,
    persistImageTaskResult: mocks.persistImageTaskResult,
    prepareImageTaskAutomaticRetry: mocks.prepareImageTaskAutomaticRetry,
    queryCancelledImageTaskUpstreamStep: mocks.queryCancelledImageTaskUpstreamStep,
    queryImageTaskUpstreamStep: mocks.queryImageTaskUpstreamStep,
}));
vi.mock("@/lib/server/image-task-store", () => ({ getImageTask: mocks.getImageTask, updateImageTask: mocks.updateImageTask }));
vi.mock("@/lib/server/text-task-runtime", () => ({ queryCancelledTextTaskUpstreamStep: mocks.queryCancelledTextTaskUpstreamStep, runTextTaskStep: mocks.runTextTaskStep }));
vi.mock("@/lib/server/text-task-store", () => ({ getTextTask: mocks.getTextTask, updateTextTask: mocks.updateTextTask }));
vi.mock("@/lib/server/model-request-policy", () => ({ resolveModelRequestTimeoutMs: mocks.resolveModelRequestTimeoutMs }));
vi.mock("@/lib/server/image-task-refund", () => ({ refundImageTask: mocks.refundImageTask }));
vi.mock("@/lib/server/video-task-refund", () => ({ refundVideoTask: mocks.refundVideoTask }));
vi.mock("@/lib/server/audio-task-refund", () => ({ refundAudioTask: mocks.refundAudioTask }));
vi.mock("@/lib/server/text-task-refund", () => ({ refundTextTask: mocks.refundTextTask }));
vi.mock("@/lib/server/generation-task-cancellation-service", () => ({
    hasCancellableUpstreamTaskId: vi.fn((value: string) => Boolean(value)),
    isCancellationExecutionPhase: vi.fn((value: string) => value === "cancel_requested" || value === "cancel_polling"),
    requestUpstreamGenerationCancellation: mocks.requestCancellation,
}));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));

import { runGenerationTaskRecoveryBatch } from "./generation-task-recovery-service";

describe("generation task recovery service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.release.mockResolvedValue({});
        mocks.renew.mockResolvedValue(1);
        mocks.getAuthSettings.mockResolvedValue({ dataLifecycle: { maintenanceBatchSize: 20 } });
        mocks.resolveModelRequestTimeoutMs.mockReturnValue(180_000);
    });

    it("returns without starting a heartbeat when no task is due", async () => {
        mocks.claim.mockResolvedValue([]);

        await expect(runGenerationTaskRecoveryBatch({ origin: "http://internal" })).resolves.toEqual({ claimed: 0, pending: 0, resultReady: 0, completed: 0, failed: 0, needsReview: 0, deferred: 0 });
        expect(mocks.release).not.toHaveBeenCalled();
    });

    it("executes an active Agent through its persisted lease and closes the terminal schedule", async () => {
        const run = { id: "agent-one", userId: "user-one", status: "planning", tasks: [], createdAt: 1_000 };
        mocks.claim.mockResolvedValue([lease()]);
        mocks.getAgentRun.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, status: "completed" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.executeAgentRun).toHaveBeenCalledWith(run, "http://internal", "worker-context:user-one");
        expect(mocks.release).toHaveBeenCalledWith("agent", "agent-one", "worker-one", expect.objectContaining({ executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "completed" }));
        expect(result).toMatchObject({ claimed: 1, completed: 1 });
    });

    it("does not restart a paused Agent", async () => {
        mocks.claim.mockResolvedValue([lease()]);
        mocks.getAgentRun.mockResolvedValue({ id: "agent-one", userId: "user-one", status: "paused", tasks: [], createdAt: 1_000 });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.executeAgentRun).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledWith("agent", "agent-one", "worker-one", expect.objectContaining({ executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "paused" }));
        expect(result).toMatchObject({ claimed: 1, failed: 1 });
    });

    it("runs a completed Agent review from its persistent review lease", async () => {
        const run = { id: "agent-one", userId: "user-one", status: "completed", reviewed: false, reviewStatus: "review_pending", tasks: [], createdAt: 1_000 };
        mocks.claim.mockResolvedValue([{ ...lease(), status: "success", executionPhase: "review_pending" }]);
        mocks.getAgentRun.mockResolvedValue(run);
        mocks.processAgentRunReview.mockResolvedValue({ status: "completed", attempts: 1 });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.executeAgentRun).not.toHaveBeenCalled();
        expect(mocks.processAgentRunReview).toHaveBeenCalledWith(run, "http://internal", "worker-context:user-one");
        expect(mocks.release).toHaveBeenCalledWith("agent", "agent-one", "worker-one", { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "review_completed" });
        expect(result).toMatchObject({ claimed: 1, completed: 1 });
    });

    it("advances an existing child task before resuming its parent Agent", async () => {
        const run = {
            id: "agent-one",
            userId: "user-one",
            status: "running",
            tasks: [{ id: "agent-task", type: "image", status: "running", taskId: "child-one", taskIds: ["child-one"], childTasks: [{ id: "child-one", status: "pending", attempt: 1 }] }],
            createdAt: 1_000,
        };
        mocks.claim.mockResolvedValueOnce([lease()]).mockResolvedValueOnce([{ ...lease(), id: "child-one", type: "image", status: "running" }]);
        mocks.getAgentRun.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, status: "completed" });
        mocks.getImageTask.mockResolvedValue({ id: "child-one", userId: "user-one", status: "success" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.claim).toHaveBeenNthCalledWith(2, expect.objectContaining({ workerId: "worker-one:children", taskIds: ["child-one"], limit: 1 }));
        expect(mocks.release).toHaveBeenCalledWith("image", "child-one", "worker-one:children", expect.objectContaining({ executionPhase: "completed", nextPollAt: undefined }));
        expect(mocks.release.mock.invocationCallOrder.find((order) => order < mocks.executeAgentRun.mock.invocationCallOrder[0]!)).toBeTruthy();
        expect(mocks.executeAgentRun).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ claimed: 1, completed: 1 });
    });

    it("persists a ready image without querying the upstream a second time", async () => {
        const task = { id: "image-ready", userId: "user-one", status: "running", config: {} };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "running", executionPhase: "persisting", resultPayload: { url: "https://cdn.example.com/result.png" } }]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.persistImageTaskResult.mockResolvedValue({ status: "success" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.persistImageTaskResult).toHaveBeenCalledWith(task, "http://internal", "https://cdn.example.com/result.png", "", task.userId);
        expect(mocks.queryImageTaskUpstreamStep).not.toHaveBeenCalled();
        expect(result).toMatchObject({ claimed: 1, completed: 1, deferred: 0 });
    });

    it("recovers every Agent child task in configured batches", async () => {
        const childTasks = Array.from({ length: 51 }, (_, index) => ({ id: `child-${index}`, status: "pending", attempt: 1 }));
        const run = {
            id: "agent-one",
            userId: "user-one",
            status: "running",
            tasks: [{ id: "agent-task", type: "image", status: "running", childTasks }],
            createdAt: 1_000,
        };
        mocks.claim.mockResolvedValueOnce([lease()]).mockResolvedValue([]);
        mocks.getAgentRun.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, status: "completed" });

        await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.claim).toHaveBeenNthCalledWith(2, expect.objectContaining({ workerId: "worker-one:children", taskIds: childTasks.slice(0, 20).map((item) => item.id), limit: 20 }));
        expect(mocks.claim).toHaveBeenNthCalledWith(3, expect.objectContaining({ workerId: "worker-one:children", taskIds: childTasks.slice(20, 40).map((item) => item.id), limit: 20 }));
        expect(mocks.claim).toHaveBeenNthCalledWith(4, expect.objectContaining({ workerId: "worker-one:children", taskIds: childTasks.slice(40).map((item) => item.id), limit: 11 }));
        expect(mocks.executeAgentRun).toHaveBeenCalledWith(run, "http://internal", "worker-context:user-one");
    });

    it("passes the task owner to a worker-driven video poll", async () => {
        const task = { id: "video-one", userId: "user-one", status: "running", upstream: { id: "upstream-one" }, createdAt: 1_000 };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "video", status: "running", executionPhase: "polling", upstreamTaskId: task.upstream.id }]);
        mocks.getVideoTask.mockResolvedValue(task);
        mocks.queryVideoTaskUpstream.mockResolvedValue({ state: "pending", status: "processing" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.queryVideoTaskUpstream).toHaveBeenCalledWith(task, "http://internal", "", task.userId);
        expect(mocks.release).toHaveBeenCalledWith("video", task.id, "worker-one", expect.objectContaining({ executionPhase: "polling", lastUpstreamStatus: "processing" }));
        expect(result).toMatchObject({ claimed: 1, pending: 1 });
    });

    it("stops automatic video polling at the configured model deadline without losing the upstream id", async () => {
        const task = { id: "video-timeout", userId: "user-one", status: "running", upstream: { id: "upstream-timeout" }, config: { capabilityProfile: { timeoutMs: 15_000 } }, createdAt: Date.now() - 200_000 };
        mocks.claim.mockResolvedValue([
            {
                ...lease(),
                id: task.id,
                userId: task.userId,
                type: "video",
                status: "running",
                executionPhase: "polling",
                upstreamTaskId: task.upstream.id,
                submittedAt: Date.now() - 180_001,
            },
        ]);
        mocks.getVideoTask.mockResolvedValue(task);
        mocks.queryVideoTaskUpstream.mockResolvedValue({ state: "pending", status: "processing" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.resolveModelRequestTimeoutMs).toHaveBeenCalledWith(task.config, "video");
        expect(mocks.release).toHaveBeenCalledWith(
            "video",
            task.id,
            "worker-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                upstreamTaskId: "upstream-timeout",
                nextPollAt: undefined,
                lastUpstreamStatus: "query_window_elapsed:processing",
                resultPayload: expect.objectContaining({ reviewReason: expect.stringContaining("原上游任务已保留") }),
            }),
        );
        expect(result).toMatchObject({ claimed: 1, pending: 0, needsReview: 1 });
    });

    it("lets a user-requested check query the original video after the automatic deadline", async () => {
        const task = { id: "video-user-check", userId: "user-one", status: "running", upstream: { id: "upstream-user-check" }, config: { capabilityProfile: { timeoutMs: 15_000 } }, createdAt: Date.now() - 200_000 };
        mocks.claim.mockResolvedValue([
            {
                ...lease(),
                id: task.id,
                userId: task.userId,
                type: "video",
                status: "running",
                executionPhase: "polling",
                upstreamTaskId: task.upstream.id,
                submittedAt: Date.now() - 180_001,
                lastUpstreamStatus: "user_recovery_requested",
            },
        ]);
        mocks.getVideoTask.mockResolvedValue(task);
        mocks.queryVideoTaskUpstream.mockResolvedValue({ state: "pending", status: "processing" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one", userRequested: true });

        expect(mocks.queryVideoTaskUpstream).toHaveBeenCalledWith(task, "http://internal", "", task.userId);
        expect(mocks.release).toHaveBeenCalledWith("video", task.id, "worker-one", expect.objectContaining({ executionPhase: "polling", upstreamTaskId: "upstream-user-check", lastUpstreamStatus: "processing" }));
        expect(result).toMatchObject({ claimed: 1, pending: 1, needsReview: 0 });
    });

    it("recovers a Gemini operation already persisted while submission was in flight", async () => {
        const task = {
            id: "video-gemini",
            userId: "user-one",
            status: "running",
            upstream: {
                id: "operation-one",
                queryPath: "/models/veo-3.1-generate-preview/operations/operation-one",
            },
            config: {
                channelId: "channel-gemini",
                apiFormat: "gemini",
                model: "veo-3.1-generate-preview",
                advancedConfig: { protocol: "gemini", queryPath: "" },
            },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "video", status: "running", executionPhase: "submitting", upstreamTaskId: undefined }]);
        mocks.getVideoTask.mockResolvedValue(task);

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.queryVideoTaskUpstream).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledWith(
            "video",
            task.id,
            "worker-one",
            expect.objectContaining({
                executionPhase: "submitted",
                upstreamTaskId: "operation-one",
                queryPath: "/models/veo-3.1-generate-preview/operations/operation-one",
                lastUpstreamStatus: "recovered_submitted",
            }),
        );
        expect(result).toMatchObject({ claimed: 1, pending: 1, needsReview: 0 });
    });

    it("moves an image with an invalid OpenAI query contract to manual review", async () => {
        const task = {
            id: "image-one",
            userId: "user-one",
            status: "running",
            upstream: { id: "upstream-one" },
            config: { channelId: "channel-one", apiFormat: "openai", advancedConfig: { protocol: "openai", queryPath: "" } },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "running", executionPhase: "polling", upstreamTaskId: task.upstream.id }]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.queryImageTaskUpstreamStep.mockResolvedValue({ state: "needs_review", status: "query_contract_invalid", reason: "图片任务查询路径返回了网页内容" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.release).toHaveBeenCalledWith(
            "image",
            task.id,
            "worker-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                upstreamTaskId: "upstream-one",
                nextPollAt: undefined,
                lastUpstreamStatus: expect.stringContaining("query_contract_invalid"),
                resultPayload: { reviewReason: "图片任务查询路径返回了网页内容" },
            }),
        );
        expect(result).toMatchObject({ claimed: 1, needsReview: 1 });
        expect(mocks.refundImageTask).not.toHaveBeenCalled();
    });

    it("releases one explicit upstream image failure as a clean second submission", async () => {
        const task = {
            id: "image-retry",
            userId: "user-one",
            status: "running",
            attemptNo: 1,
            upstream: { id: "upstream-failed" },
            config: { channelId: "channel-one", apiFormat: "openai", advancedConfig: { protocol: "openai" } },
        };
        const retry = { ...task, upstream: undefined, config: { channelId: "channel-two", apiFormat: "gemini", advancedConfig: { protocol: "gemini" } } };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "running", executionPhase: "polling", upstreamTaskId: task.upstream.id }]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.queryImageTaskUpstreamStep.mockResolvedValue({ state: "failed", status: "failed", error: "上游生成失败", retryReason: "upstream_failed" });
        mocks.prepareImageTaskAutomaticRetry.mockResolvedValue(retry);

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.prepareImageTaskAutomaticRetry).toHaveBeenCalledWith(task, "上游生成失败");
        expect(mocks.release).toHaveBeenCalledWith(
            "image",
            task.id,
            "worker-one",
            expect.objectContaining({ executionPhase: "created", channelId: "channel-two", nextPollAt: expect.any(Number), lastUpstreamStatus: "automatic_retry_after_upstream_failure" }),
            { resetUpstreamIdentity: true },
        );
        expect(mocks.markImageTaskFailed).not.toHaveBeenCalled();
        expect(result).toMatchObject({ claimed: 1, pending: 1, failed: 0 });
    });

    it("stops after the second explicit upstream image failure", async () => {
        const task = { id: "image-retry-exhausted", userId: "user-one", status: "running", attemptNo: 2, upstream: { id: "upstream-failed-again" }, config: { channelId: "channel-one", apiFormat: "openai", advancedConfig: { protocol: "openai" } } };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "running", executionPhase: "polling", upstreamTaskId: task.upstream.id }]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.queryImageTaskUpstreamStep.mockResolvedValue({ state: "failed", status: "failed", error: "再次失败", retryReason: "upstream_failed" });
        mocks.prepareImageTaskAutomaticRetry.mockResolvedValue(null);

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.markImageTaskFailed).toHaveBeenCalledWith(task, "再次失败");
        expect(mocks.release).toHaveBeenCalledWith("image", task.id, "worker-one", expect.objectContaining({ executionPhase: "completed", nextPollAt: undefined }));
        expect(result).toMatchObject({ claimed: 1, pending: 0, failed: 1 });
    });

    it("recovers an image upstream identity already saved in the task payload", async () => {
        const task = {
            id: "image-one",
            userId: "user-one",
            status: "running",
            upstream: { id: "upstream-one", explicitPollUrl: "/images/upstream-one" },
            config: { channelId: "channel-one", apiFormat: "openai", advancedConfig: { protocol: "openai", queryPath: "/images/:task_id" } },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "running", executionPhase: "submitting", upstreamTaskId: undefined }]);
        mocks.getImageTask.mockResolvedValue(task);

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.queryImageTaskUpstreamStep).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledWith(
            "image",
            task.id,
            "worker-one",
            expect.objectContaining({ executionPhase: "submitted", upstreamTaskId: "upstream-one", channelId: "channel-one", queryPath: "/images/upstream-one", lastUpstreamStatus: "recovered_submitted" }),
        );
        expect(result).toMatchObject({ claimed: 1, pending: 1, needsReview: 0 });
    });

    it("restores a scheduler-only image upstream identity before querying", async () => {
        const task = {
            id: "image-one",
            userId: "user-one",
            status: "running",
            config: { baseUrl: "/api/ai/system/channel-one", channelId: "channel-one", apiFormat: "openai", advancedConfig: { protocol: "openai" } },
        };
        const restored = {
            ...task,
            upstream: {
                id: "upstream-one",
                mediaBaseUrl: "http://internal/api/ai/system/channel-one",
                pollBaseUrl: "http://internal/api/ai/system/channel-one",
                explicitPollUrl: "/images/upstream-one",
            },
        };
        mocks.claim.mockResolvedValue([
            {
                ...lease(),
                id: task.id,
                userId: task.userId,
                type: "image",
                status: "running",
                executionPhase: "polling",
                upstreamTaskId: "upstream-one",
                queryPath: "/images/upstream-one",
            },
        ]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.updateImageTask.mockResolvedValue(restored);
        mocks.queryImageTaskUpstreamStep.mockResolvedValue({ state: "pending", upstream: restored.upstream, status: "processing" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.updateImageTask).toHaveBeenCalledWith(task.id, { upstream: restored.upstream });
        expect(mocks.queryImageTaskUpstreamStep).toHaveBeenCalledWith(restored, "http://internal", "", task.userId);
        expect(mocks.createImageTaskUpstreamStep).not.toHaveBeenCalled();
        expect(result).toMatchObject({ claimed: 1, pending: 1, needsReview: 0 });
    });

    it("records why an interrupted image submission requires review", async () => {
        const task = {
            id: "image-interrupted",
            userId: "user-one",
            status: "running",
            config: { channelId: "channel-one", apiFormat: "openai", advancedConfig: { protocol: "openai", queryPath: "" } },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "running", executionPhase: "submitting", resultPayload: { trace: "kept" } }]);
        mocks.getImageTask.mockResolvedValue(task);

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.release).toHaveBeenCalledWith(
            "image",
            task.id,
            "worker-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                resultPayload: { trace: "kept", reviewReason: "图片任务在提交阶段中断，未取得上游任务 ID" },
            }),
        );
        expect(result).toMatchObject({ claimed: 1, needsReview: 1 });
    });

    it("stops repeated image query errors at the configured model deadline", async () => {
        const task = {
            id: "image-query-timeout",
            userId: "user-one",
            status: "running",
            upstream: { id: "upstream-image" },
            config: { capabilityProfile: { timeoutMs: 30_000 }, advancedConfig: {} },
            createdAt: Date.now() - 200_000,
        };
        mocks.claim.mockResolvedValue([
            {
                ...lease(),
                id: task.id,
                userId: task.userId,
                type: "image",
                status: "running",
                executionPhase: "polling",
                upstreamTaskId: task.upstream.id,
                submittedAt: Date.now() - 180_001,
                lastUpstreamStatus: "query_error:4",
            },
        ]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.queryImageTaskUpstreamStep.mockRejectedValue(new Error("gateway timeout"));

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.release).toHaveBeenCalledWith(
            "image",
            task.id,
            "worker-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                upstreamTaskId: "upstream-image",
                nextPollAt: undefined,
                lastUpstreamStatus: "query_window_elapsed:error",
            }),
        );
        expect(result).toMatchObject({ claimed: 1, needsReview: 1, deferred: 0 });
    });

    it("bounds repeated image result persistence by the configured model deadline", async () => {
        const now = Date.now();
        const task = { id: "image-persist-timeout", userId: "user-one", status: "running", config: { capabilityProfile: { timeoutMs: 30_000 } }, createdAt: now - 200_000 };
        mocks.claim.mockResolvedValue([
            {
                ...lease(),
                id: task.id,
                userId: task.userId,
                type: "image",
                status: "running",
                executionPhase: "persisting",
                resultPayload: { url: "https://cdn.example.com/result.png", persistenceStartedAt: now - 180_001 },
            },
        ]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.persistImageTaskResult.mockRejectedValue(new Error("storage unavailable"));

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.release).toHaveBeenCalledWith(
            "image",
            task.id,
            "worker-one",
            expect.objectContaining({
                executionPhase: "needs_review",
                nextPollAt: undefined,
                lastUpstreamStatus: "persist_window_elapsed",
                resultPayload: expect.objectContaining({ url: "https://cdn.example.com/result.png", persistenceStartedAt: now - 180_001, reviewReason: expect.stringContaining("原结果") }),
            }),
        );
        expect(result).toMatchObject({ claimed: 1, needsReview: 1, deferred: 0 });
    });

    it("recovers an audio upstream identity already saved in the task payload", async () => {
        const task = {
            id: "audio-one",
            userId: "user-one",
            status: "running",
            upstream: { id: "upstream-audio-one", createPath: "/audio/speech" },
            config: { channelId: "channel-audio", apiFormat: "openai", advancedConfig: { protocol: "custom", queryPath: "/audio/:task_id" } },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "audio", status: "running", executionPhase: "submitting", upstreamTaskId: undefined }]);
        mocks.getAudioTask.mockResolvedValue(task);

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.queryAudioTaskUpstreamStep).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledWith(
            "audio",
            task.id,
            "worker-one",
            expect.objectContaining({ executionPhase: "submitted", upstreamTaskId: "upstream-audio-one", channelId: "channel-audio", queryPath: "/audio/:task_id", lastUpstreamStatus: "recovered_submitted" }),
        );
        expect(result).toMatchObject({ claimed: 1, pending: 1, needsReview: 0 });
    });

    it("persists the selected text channel before the next upstream query", async () => {
        const task = {
            id: "text-one",
            userId: "user-one",
            status: "running",
            upstream: { id: "upstream-one", createPath: "/jobs" },
            config: { channelId: "channel-two", apiFormat: "openai", advancedConfig: { protocol: "custom", queryPath: "/jobs/:task_id" } },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, type: "text", status: "running", executionPhase: "submitting" }]);
        mocks.getTextTask.mockResolvedValue(task);
        mocks.runTextTaskStep.mockResolvedValue({ state: "pending", status: "submitted", upstreamTaskId: "upstream-one", createPath: "/jobs" });

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.release).toHaveBeenCalledWith("text", task.id, "worker-one", expect.objectContaining({ upstreamTaskId: "upstream-one", channelId: "channel-two", provider: "custom", queryPath: "/jobs/:task_id" }));
        expect(result).toMatchObject({ claimed: 1, pending: 1 });
    });

    it("keeps polling a cancelled task after the upstream only accepts the cancellation request", async () => {
        const task = {
            id: "image-one",
            userId: "user-one",
            status: "cancelled",
            upstream: { id: "upstream-one" },
            config: { baseUrl: "https://provider.example", apiKey: "key", apiFormat: "openai", model: "image-model" },
        };
        mocks.claim.mockResolvedValue([{ ...lease(), id: task.id, userId: task.userId, type: "image", status: "cancelled", executionPhase: "cancel_requested", upstreamTaskId: "upstream-one", resultPayload: { cancellationRequestedAt: 1_000 } }]);
        mocks.getImageTask.mockResolvedValue(task);
        mocks.requestCancellation.mockResolvedValue("accepted");

        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", workerId: "worker-one" });

        expect(mocks.release).toHaveBeenCalledWith("image", task.id, "worker-one", expect.objectContaining({ executionPhase: "cancel_polling", lastUpstreamStatus: "cancel_accepted_polling" }), { cancellation: true });
        expect(result).toMatchObject({ claimed: 1, pending: 1, completed: 0 });
    });
});

function lease() {
    return {
        id: "agent-one",
        userId: "user-one",
        type: "agent",
        status: "pending",
        payload: {},
        executionPhase: "created",
        nextPollAt: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 60_000,
    };
}
