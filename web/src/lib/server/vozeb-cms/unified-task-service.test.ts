import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getTask: vi.fn(),
    mutateTask: vi.fn(),
    linkTask: vi.fn(),
    schedule: vi.fn(),
    recover: vi.fn(),
    cost: vi.fn(),
    listUnified: vi.fn(),
    enabledCapabilities: vi.fn(),
    getWorkflowRun: vi.fn(),
    advanceWorkflow: vi.fn(),
    controlWorkflow: vi.fn(),
    refundImage: vi.fn(),
    refundVideo: vi.fn(),
    refundAudio: vi.fn(),
    refundText: vi.fn(),
}));

vi.mock("@/lib/server/generation-task-store", () => ({
    getStoredGenerationTaskRecordForUser: mocks.getTask,
    mutateStoredGenerationTask: mocks.mutateTask,
    linkStoredGenerationTask: mocks.linkTask,
    generationTaskPointsCost: mocks.cost,
}));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/generation-task-user-recovery", () => ({ recoverGenerationTaskFromUpstream: mocks.recover }));
vi.mock("@/lib/server/generation-task-cancellation-service", () => ({ cancellationExecutionPatch: vi.fn(() => ({ executionPhase: "cancel_requested", nextPollAt: Date.now() })) }));
vi.mock("@/lib/server/image-task-refund", () => ({ refundImageTask: mocks.refundImage }));
vi.mock("@/lib/server/video-task-refund", () => ({ refundVideoTask: mocks.refundVideo }));
vi.mock("@/lib/server/audio-task-refund", () => ({ refundAudioTask: mocks.refundAudio }));
vi.mock("@/lib/server/text-task-refund", () => ({ refundTextTask: mocks.refundText }));
vi.mock("@/lib/server/vozeb-cms/module-service", () => ({ listEnabledVozebCmsCapabilities: mocks.enabledCapabilities }));
vi.mock("@/lib/server/vozeb-cms/workflow-store", () => ({ getVozebCmsWorkflowRun: mocks.getWorkflowRun }));
vi.mock("@/lib/server/vozeb-cms/workflow-runtime", () => ({
    advanceVozebCmsWorkflowRun: mocks.advanceWorkflow,
    controlVozebCmsWorkflowRun: mocks.controlWorkflow,
    getRecoverableVozebCmsWorkflowRun: mocks.getWorkflowRun,
}));
vi.mock("./unified-task-store", () => ({ listVozebCmsUnifiedTaskRecords: mocks.listUnified }));

import { controlVozebCmsTask, getVozebCmsTask, listVozebCmsTaskPage } from "./unified-task-service";

describe("VOZEBCMS unified task service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getTask.mockResolvedValue(null);
        mocks.getWorkflowRun.mockResolvedValue(null);
        mocks.cost.mockReturnValue(12.5);
        mocks.enabledCapabilities.mockResolvedValue([{ id: "image.generate" }, { id: "video.generate" }, { id: "text.generate" }, { id: "audio.generate" }, { id: "agent.run" }, { id: "drama.workflow.run" }, { id: "workflow.run" }]);
        mocks.listUnified.mockResolvedValue({ items: [], total: 0, hasMore: false });
        mocks.refundImage.mockImplementation(async (task) => task);
        mocks.refundVideo.mockImplementation(async (task) => task);
        mocks.refundAudio.mockImplementation(async (task) => task);
        mocks.refundText.mockImplementation(async (task) => task);
    });

    it("projects generation and workflow records through one cursor page", async () => {
        mocks.listUnified.mockResolvedValue({
            total: 2,
            hasMore: true,
            items: [
                {
                    source: "generation",
                    id: "video-one",
                    updatedAt: Date.parse("2026-08-26T00:00:02.000Z"),
                    record: {
                        id: "video-one",
                        type: "video",
                        status: "running",
                        userId: "user-one",
                        projectId: "project-one",
                        payload: { prompt: "镜头", preferences: { seconds: 5 } },
                        createdAt: Date.parse("2026-08-26T00:00:00.000Z"),
                        updatedAt: Date.parse("2026-08-26T00:00:02.000Z"),
                        expiresAt: Date.parse("2026-09-26T00:00:00.000Z"),
                        executionPhase: "polling",
                    },
                },
                {
                    source: "workflow",
                    id: "workflow-one",
                    updatedAt: Date.parse("2026-08-26T00:00:01.000Z"),
                    run: {
                        id: "workflow-one",
                        userId: "user-one",
                        workflowId: "definition-one",
                        definitionVersion: 1,
                        definitionSnapshot: { id: "definition-one" },
                        projectId: "project-one",
                        status: "waiting",
                        version: 3,
                        context: {},
                        nodeStates: { generate: { status: "waiting", attempts: 1, updatedAt: 1 } },
                        createdAt: Date.parse("2026-08-26T00:00:00.000Z"),
                        updatedAt: Date.parse("2026-08-26T00:00:01.000Z"),
                    },
                },
            ],
        });

        const page = await listVozebCmsTaskPage("user-one", { projectId: "project-one", limit: 2 });

        expect(page).toMatchObject({
            total: 2,
            limit: 2,
            items: [
                { id: "video-one", source: "generation", type: "video", status: "running", project_id: "project-one", cost: 12.5 },
                { id: "workflow-one", source: "workflow", type: "workflow", status: "waiting", project_id: "project-one", cost: 0 },
            ],
        });
        expect(page.nextCursor).toEqual(expect.any(String));
        expect(mocks.listUnified).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", projectId: "project-one", includeWorkflow: true, limit: 2 }));
    });

    it("removes disabled task types before querying the store", async () => {
        mocks.enabledCapabilities.mockResolvedValue([{ id: "image.generate" }, { id: "workflow.run" }]);

        await listVozebCmsTaskPage("user-one", { type: "video" });

        expect(mocks.listUnified).toHaveBeenCalledWith(expect.objectContaining({ generationTypes: [], includeWorkflow: false }));
    });

    it("controls a failed task through the existing refund, store and scheduler", async () => {
        const record = failedTask("image-one", "image");
        mocks.getTask
            .mockResolvedValueOnce(record)
            .mockResolvedValueOnce(record)
            .mockResolvedValueOnce({ ...record, status: "pending", payload: { ...record.payload, status: "pending", retryable: false }, attemptNo: 2 });
        mocks.mutateTask.mockImplementation(async (_type: string, _id: string, _ttl: number, mutate: (value: unknown) => unknown) => mutate(record.payload));

        await expect(controlVozebCmsTask({ userId: "user-one", id: record.id, action: "retry", origin: "http://localhost" })).resolves.toMatchObject({ status: "pending" });
        expect(mocks.refundImage).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
        expect(mocks.linkTask).toHaveBeenCalledWith("image", record.id, expect.objectContaining({ attemptNo: 2 }));
        expect(mocks.schedule).toHaveBeenCalledWith("image", record.id, expect.objectContaining({ executionPhase: "created" }), { resetUpstreamIdentity: true });
    });

    it("does not mutate or schedule when the native refund fails", async () => {
        const record = failedTask("image-refund-failure", "image");
        mocks.getTask.mockResolvedValueOnce(record).mockResolvedValueOnce(record);
        mocks.refundImage.mockRejectedValueOnce(new Error("refund unavailable"));

        await expect(controlVozebCmsTask({ userId: "user-one", id: record.id, action: "retry", origin: "http://localhost" })).rejects.toThrow("refund unavailable");
        expect(mocks.mutateTask).not.toHaveBeenCalled();
        expect(mocks.schedule).not.toHaveBeenCalled();
    });

    it("preserves video upstream shape and billed attempt provenance during retry", async () => {
        const record = failedTask("video-one", "video", {
            upstream: { id: "upstream-one", provider: "generation", model: "video-model", pollPath: "/videos", queryPath: "/videos/upstream-one", pointsCost: 4.5, pointsRecordId: "video-points" },
            attempts: [{ attemptNo: 1, model: "video-model", status: "failed", startedAt: Date.now() - 900 }],
        });
        mocks.getTask
            .mockResolvedValueOnce(record)
            .mockResolvedValueOnce(record)
            .mockResolvedValueOnce({ ...record, status: "running", payload: { ...record.payload, status: "running", retryable: false }, attemptNo: 2 });
        mocks.mutateTask.mockImplementationOnce(async (_type: string, _id: string, _ttl: number, mutate: (value: unknown) => unknown) => mutate(record.payload));

        await controlVozebCmsTask({ userId: "user-one", id: record.id, action: "retry", origin: "http://localhost" });

        const payload = (await mocks.mutateTask.mock.results[0]?.value) as Record<string, unknown>;
        expect(payload.upstream).toEqual({ id: "", provider: "generation", model: "video-model", pollPath: "/videos", queryPath: "/videos/upstream-one" });
        expect(payload.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ attemptNo: 1, pointsCost: 4.5, pointsRecordId: "video-points" })]));
    });

    it("delegates workflow controls without creating another queue", async () => {
        const run = { id: "workflow-one", userId: "user-one", status: "waiting" };
        mocks.getWorkflowRun.mockResolvedValue(run);
        mocks.controlWorkflow.mockResolvedValue({ ...run, status: "running" });

        await expect(controlVozebCmsTask({ userId: "user-one", id: run.id, action: "recover", origin: "http://localhost" })).resolves.toMatchObject({ status: "running" });
        expect(mocks.controlWorkflow).toHaveBeenCalledWith("user-one", run.id, "resume");
    });

    it("reads workflow projections only within the current user", async () => {
        mocks.getWorkflowRun.mockResolvedValue({
            id: "workflow-one",
            userId: "user-one",
            workflowId: "definition-one",
            definitionVersion: 1,
            definitionSnapshot: {},
            status: "completed",
            version: 1,
            context: {},
            nodeStates: {},
            createdAt: 1,
            updatedAt: 2,
        });

        await expect(getVozebCmsTask("user-one", "workflow-one")).resolves.toMatchObject({ id: "workflow-one", source: "workflow", status: "success" });
        expect(mocks.getWorkflowRun).toHaveBeenCalledWith("user-one", "workflow-one");
    });
});

function failedTask(id: string, type: "image" | "video", extra: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
        id,
        type,
        status: "error",
        userId: "user-one",
        payload: {
            id,
            userId: "user-one",
            status: "error",
            createdAt: now - 1_000,
            updatedAt: now,
            retryable: true,
            attemptNo: 1,
            config: { channelId: "channel-one", apiFormat: "openai", model: type === "video" ? "video-model" : "image-model", baseUrl: "", apiKey: "" },
            ...extra,
        },
        attemptNo: 1,
        createdAt: now - 1_000,
        updatedAt: now,
        expiresAt: now + 10_000,
    };
}
