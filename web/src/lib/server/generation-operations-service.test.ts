import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listStoredGenerationTaskRecords: vi.fn(),
    listStoredGenerationTaskRecordsByRunIds: vi.fn(),
    summarizeStoredAgentPerformance: vi.fn(),
    generationTaskPointsCost: vi.fn((_payload: Record<string, unknown>) => 3),
    findPublicUserIdsByKeyword: vi.fn(),
    getPublicUsersByIds: vi.fn(),
    getAuthSettings: vi.fn(),
    getDatabaseProvider: vi.fn(),
}));

vi.mock("@/lib/server/generation-task-store", () => ({
    listStoredGenerationTaskRecords: mocks.listStoredGenerationTaskRecords,
    listStoredGenerationTaskRecordsByRunIds: mocks.listStoredGenerationTaskRecordsByRunIds,
    summarizeStoredAgentPerformance: mocks.summarizeStoredAgentPerformance,
    generationTaskPointsCost: mocks.generationTaskPointsCost,
}));
vi.mock("@/lib/auth/store", () => ({ findPublicUserIdsByKeyword: mocks.findPublicUserIdsByKeyword, getPublicUsersByIds: mocks.getPublicUsersByIds, getAuthSettings: mocks.getAuthSettings }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: mocks.getDatabaseProvider }));
vi.mock("@/lib/server/channel-runtime-health", () => ({
    getChannelRuntimeHealth: vi.fn(() => ({ channelId: "channel-one", capability: "image", consecutiveFailures: 0 })),
    isChannelRuntimeCooling: vi.fn(() => false),
}));

import { listAdminGenerationOperations } from "./generation-operations-service";

describe("generation operations aggregation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generationTaskPointsCost.mockReturnValue(3);
        mocks.getDatabaseProvider.mockReturnValue("file");
        mocks.findPublicUserIdsByKeyword.mockResolvedValue(["user-one"]);
        mocks.getPublicUsersByIds.mockResolvedValue([{ id: "user-one", accountId: "0001", username: "creator", displayName: "创作者" }]);
        mocks.listStoredGenerationTaskRecordsByRunIds.mockResolvedValue([]);
        mocks.summarizeStoredAgentPerformance.mockResolvedValue({ sampleSize: 0, planningP50Ms: 0, planningP95Ms: 0, firstResultP50Ms: 0, firstResultP95Ms: 0, queueAverageMs: 0, upstreamAverageMs: 0, reviewAverageMs: 0 });
        mocks.listStoredGenerationTaskRecords.mockResolvedValue({
            items: [task()],
            all: [task()],
            total: 1,
            page: 1,
            pageSize: 20,
            summary: { total: 1, active: 0, success: 0, failed: 1, averageDurationMs: 3000, totalPointsCost: 3, byType: { agent: 1 }, byStatus: { error: 1 } },
        });
        mocks.getAuthSettings.mockResolvedValue({
            systemChannels: [{ id: "channel-one", name: "主渠道", enabled: true }],
            logicalModels: [{ id: "image-model", name: "图片模型", capability: "image", enabled: true, bindings: [{ channelId: "channel-one", upstreamModel: "vendor/image", enabled: true }] }],
        });
    });

    it("returns traceable task, point and channel summaries without inventing currency cost", async () => {
        const result = await listAdminGenerationOperations({ page: 1, search: "0001" });

        expect(result.items[0]).toMatchObject({
            id: "task-one",
            displayName: "创作者",
            accountId: "0001",
            surface: "chat",
            conversationId: "conversation-one",
            model: "image-model",
            pointsCost: 3,
            retryTaskId: "child-failed",
            leaseExpired: false,
            pointsBreakdown: { planner: 3, childTasks: 0, total: 3 },
        });
        expect(result.summary).toMatchObject({ total: 1, failed: 1, totalPointsCost: 3 });
        expect(result.agentPerformance).toEqual(expect.objectContaining({ sampleSize: 0 }));
        expect(result.channels).toEqual([expect.objectContaining({ id: "channel-one", capability: "image", enabled: true, runtimeHealth: { status: "healthy", consecutiveFailures: 0 } })]);
        expect(mocks.getPublicUsersByIds).toHaveBeenCalledWith(["user-one"]);
        expect(mocks.findPublicUserIdsByKeyword).toHaveBeenCalledWith("0001");
        expect(mocks.listStoredGenerationTaskRecords).toHaveBeenNthCalledWith(1, { page: 1, search: "0001", searchUserIds: ["user-one"], includeAll: false });
        expect(mocks.summarizeStoredAgentPerformance).toHaveBeenCalledWith({ page: 1, search: "0001", searchUserIds: ["user-one"] });
        expect(mocks.listStoredGenerationTaskRecordsByRunIds).toHaveBeenCalledWith(["task-one"], ["user-one"]);
        expect(JSON.stringify(result)).not.toContain("amountCents");
    });

    it("lets PostgreSQL search users inside the task query instead of preloading user ids", async () => {
        mocks.getDatabaseProvider.mockReturnValue("postgres");

        await listAdminGenerationOperations({ page: 1, search: "创作者" });

        expect(mocks.findPublicUserIdsByKeyword).not.toHaveBeenCalled();
        expect(mocks.listStoredGenerationTaskRecords).toHaveBeenCalledWith({ page: 1, search: "创作者", searchUserIds: [], includeAll: false });
        expect(mocks.summarizeStoredAgentPerformance).toHaveBeenCalledWith({ page: 1, search: "创作者", searchUserIds: [] });
    });

    it("shows planner audit, child-task points and only marks an actually expired lease", async () => {
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(5_000);
        mocks.generationTaskPointsCost.mockImplementation((payload: Record<string, unknown>) => Number(payload.pointsCost) || 0);
        mocks.listStoredGenerationTaskRecords.mockResolvedValue({
            items: [
                {
                    ...task(),
                    status: "running",
                    executionPhase: "polling",
                    provider: "openai",
                    queryPath: "/videos/task-upstream",
                    workerId: "worker-one",
                    leaseUntil: 4_999,
                    lastHeartbeatAt: 4_500,
                    nextPollAt: 5_100,
                    payload: {
                        ...task().payload,
                        pointsCost: undefined,
                        plannerAudit: {
                            schemaVersion: 1,
                            mode: "model",
                            logicalModelId: "planner",
                            channelId: "planner-backup",
                            upstreamModel: "vendor/planner",
                            protocol: "chat",
                            elapsedMs: 1200,
                            pointsCost: 1.25,
                            skills: [{ id: "skill-one", name: "商品视觉", sourceCommit: "abcdef" }],
                        },
                        plannerStreamMode: "stream",
                        plannerStreamFallbackReason: "",
                        plannerContext: { serializedChars: 12_345 },
                        timings: { planningStartedAt: 1_000, plannerFirstByteAt: 1_240, planningCompletedAt: 2_600 },
                    },
                },
            ],
            all: [],
            total: 1,
            page: 1,
            pageSize: 20,
            summary: { total: 1, active: 1, success: 0, failed: 0, averageDurationMs: 0, totalPointsCost: 1.25, byType: { agent: 1 }, byStatus: { running: 1 } },
        });
        mocks.listStoredGenerationTaskRecordsByRunIds.mockResolvedValue([{ ...task(), id: "child-one", type: "video", runId: "task-one", status: "success", payload: { pointsCost: 4.5 } }]);

        const result = await listAdminGenerationOperations({ page: 1 });
        nowSpy.mockRestore();

        expect(result.items[0]).toMatchObject({
            model: "planner",
            channelId: "planner-backup",
            provider: "openai",
            queryPath: "/videos/task-upstream",
            workerId: "worker-one",
            leaseExpired: true,
            pointsCost: 5.75,
            pointsBreakdown: { planner: 1.25, childTasks: 4.5, total: 5.75 },
            plannerAudit: { schemaVersion: 1, protocol: "chat", skills: [{ id: "skill-one", name: "商品视觉", sourceCommit: "abcdef" }] },
            plannerRuntime: { transport: "stream", firstByteMs: 240, planningMs: 1600, serializedChars: 12_345 },
        });
    });

    it("exposes a sanitized complete-response fallback without planner content", async () => {
        mocks.listStoredGenerationTaskRecords.mockResolvedValue({
            items: [
                {
                    ...task(),
                    payload: {
                        ...task().payload,
                        plannerStreamMode: "complete",
                        plannerStreamFallbackReason: "HTTP 405 不支持流式规划",
                        plannerContext: { serializedChars: 4_096, input: "不应公开的内部上下文" },
                        timings: { planningStartedAt: 2_000, plannerFirstByteAt: 1_999, planningCompletedAt: 2_900 },
                    },
                },
            ],
            all: [],
            total: 1,
            page: 1,
            pageSize: 20,
            summary: { total: 1, active: 0, success: 0, failed: 1, averageDurationMs: 0, totalPointsCost: 0, byType: { agent: 1 }, byStatus: { error: 1 } },
        });

        const result = await listAdminGenerationOperations({ page: 1 });

        expect(result.items[0]?.plannerRuntime).toEqual({ transport: "complete", planningMs: 900, serializedChars: 4_096, fallbackReason: "HTTP 405 不支持流式规划" });
        expect(JSON.stringify(result.items[0]?.plannerRuntime)).not.toContain("不应公开");
    });

    it("exposes compact persisted Agent failure diagnostics only to generation operations", async () => {
        mocks.listStoredGenerationTaskRecords.mockResolvedValue({
            items: [
                {
                    ...task(),
                    payload: {
                        ...task().payload,
                        failure: "全部规划渠道不可用",
                        failureStage: "planning",
                        candidateFailures: [
                            { channelId: "channel-one", upstreamModel: "planner-a", error: "鉴权失败" },
                            { channelId: "channel-two", upstreamModel: "planner-b", error: "请求超时" },
                        ],
                    },
                },
            ],
            all: [],
            total: 1,
            page: 1,
            pageSize: 20,
            summary: { total: 1, active: 0, success: 0, failed: 1, averageDurationMs: 0, totalPointsCost: 0, byType: { agent: 1 }, byStatus: { error: 1 } },
        });

        const result = await listAdminGenerationOperations({ page: 1 });

        expect(result.items[0]).toMatchObject({
            error: "全部规划渠道不可用",
            agentFailure: {
                stage: "planning",
                message: "全部规划渠道不可用",
                candidates: [
                    { channelId: "channel-one", upstreamModel: "planner-a", error: "鉴权失败" },
                    { channelId: "channel-two", upstreamModel: "planner-b", error: "请求超时" },
                ],
            },
        });
    });

    it("shows the persisted review reason when a task has no terminal error", async () => {
        mocks.listStoredGenerationTaskRecords.mockResolvedValue({
            items: [{ ...task(), type: "image", status: "running", executionPhase: "needs_review", payload: { config: { model: "image-model" } }, resultPayload: { reviewReason: "图片生成失败：上游接口 /v1/images/edits 返回 HTTP 502" } }],
            all: [],
            total: 1,
            page: 1,
            pageSize: 20,
            summary: { total: 1, active: 1, success: 0, failed: 0, averageDurationMs: 0, totalPointsCost: 0, byType: { image: 1 }, byStatus: { running: 1 } },
        });

        const result = await listAdminGenerationOperations({ page: 1 });

        expect(result.items[0]).toMatchObject({ canReview: true, error: "图片生成失败：上游接口 /v1/images/edits 返回 HTTP 502" });
    });

    it("explains a legacy uncertain submission when no reason was persisted", async () => {
        mocks.listStoredGenerationTaskRecords.mockResolvedValue({
            items: [{ ...task(), type: "image", status: "running", executionPhase: "needs_review", lastUpstreamStatus: "submission_outcome_unknown", payload: { config: { model: "image-model" } } }],
            all: [],
            total: 1,
            page: 1,
            pageSize: 20,
            summary: { total: 1, active: 1, success: 0, failed: 0, averageDurationMs: 0, totalPointsCost: 0, byType: { image: 1 }, byStatus: { running: 1 } },
        });

        const result = await listAdminGenerationOperations({ page: 1 });

        expect(result.items[0]).toMatchObject({ canReview: true, error: expect.stringContaining("避免重复生成和扣费") });
    });
});

function task() {
    return {
        id: "task-one",
        userId: "user-one",
        type: "agent",
        status: "error",
        payload: {
            prompt: "生成商品图",
            logicalModelId: "image-model",
            pointsCost: 3,
            tasks: [{ id: "child-failed", status: "failed", error: "上游失败" }],
        },
        createdAt: 1000,
        updatedAt: 4000,
        expiresAt: 10000,
        conversationId: "conversation-one",
        runId: "task-one",
        surface: "chat",
    };
}
