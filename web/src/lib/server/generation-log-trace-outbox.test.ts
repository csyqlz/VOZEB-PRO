import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getImageTask: vi.fn(),
    getStoredGenerationTask: vi.fn(),
}));

vi.mock("./image-task-store", () => ({ getImageTask: mocks.getImageTask }));
vi.mock("./generation-task-store", async (original) => ({ ...(await original<typeof import("./generation-task-store")>()), getStoredGenerationTask: mocks.getStoredGenerationTask }));

import { hydrateEcommerceTracesFromImageTasks } from "./generation-log-store";
import type { EcommerceGenerationTrace } from "./ecommerce-generation-trace";
import type { StoredGenerationLog } from "./generation-log-types";

describe("ecommerce generation trace outbox", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getStoredGenerationTask.mockResolvedValue(null);
    });

    it("hydrates an administrator log from the durable image-task trace", async () => {
        const trace = ecommerceTrace();
        const persist = vi.fn(async () => ({ updated: 1 }));
        mocks.getImageTask.mockResolvedValue({ id: "image-task-1", userId: "user-1", ecommerceTrace: trace });

        const [hydrated] = await hydrateEcommerceTracesFromImageTasks([generationLog()], persist);

        expect(hydrated.ecommerceTrace).toEqual(trace);
        expect(mocks.getImageTask).toHaveBeenCalledWith("image-task-1");
        expect(persist).toHaveBeenCalledWith(["image-task-1"], trace, null);
    });

    it("reconciles pending advisory logs from the same child without overwriting a newer trace", async () => {
        const pending = pendingTrace();
        const final = { ...ecommerceTrace(), finalStatus: "completed", recordedAt: 2 };
        mocks.getImageTask.mockResolvedValue({ id: "image-task-1", userId: "user-1", ecommerceTrace: final });
        const persist = vi.fn(async () => ({ updated: 1 }));
        const [hydrated] = await hydrateEcommerceTracesFromImageTasks([{ ...generationLog(), ecommerceTrace: pending }], persist);
        expect(hydrated.ecommerceTrace).toEqual(final);
        expect(persist).toHaveBeenCalledWith(["image-task-1"], final, pending);
        expect(mocks.getStoredGenerationTask).not.toHaveBeenCalled();
    });

    it("rebuilds advisory evidence from the frozen Run when both trace writes were interrupted", async () => {
        const pending = pendingTrace();
        mocks.getImageTask.mockResolvedValue({ id: "image-task-1", userId: "user-1", runId: "run-1", parentTaskId: "agent-task-1", ecommerceTrace: pending });
        mocks.getStoredGenerationTask.mockResolvedValue(completedRun());
        const persist = vi.fn(async () => ({ updated: 1 }));
        const log = { ...generationLog(), ecommerceTrace: pending };
        const [first] = await hydrateEcommerceTracesFromImageTasks([log], persist);
        const [second] = await hydrateEcommerceTracesFromImageTasks([log], persist);
        expect(first.ecommerceTrace).toMatchObject({
            runId: "run-1",
            agentTaskId: "agent-task-1",
            imageTaskIds: ["image-task-1"],
            finalStatus: "completed",
            recordedAt: 2,
            stages: expect.arrayContaining([expect.objectContaining({ key: "quality_check", status: "blocked", output: expect.objectContaining({ policy: "advisory" }) })]),
        });
        expect(second.ecommerceTrace).toEqual(first.ecommerceTrace);
    });

    it.each(["owner", "child", "parent", "unfrozen"])("rejects mismatched or incomplete advisory recovery (%s)", async (condition) => {
        const pending = pendingTrace();
        mocks.getImageTask.mockResolvedValue({
            id: condition === "child" ? "other" : "image-task-1",
            userId: condition === "owner" ? "other" : "user-1",
            runId: "run-1",
            parentTaskId: condition === "parent" ? "other" : "agent-task-1",
            ecommerceTrace: pending,
        });
        mocks.getStoredGenerationTask.mockResolvedValue({ ...completedRun(), reviewed: condition !== "unfrozen" });
        const log = { ...generationLog(), ecommerceTrace: pending };
        const persist = vi.fn();
        expect(await hydrateEcommerceTracesFromImageTasks([log], persist)).toEqual([log]);
        expect(persist).not.toHaveBeenCalled();
    });

    it("does not read image tasks when a log already has its trace", async () => {
        const log = { ...generationLog(), ecommerceTrace: ecommerceTrace() };

        await expect(hydrateEcommerceTracesFromImageTasks([log], vi.fn())).resolves.toEqual([log]);
        expect(mocks.getImageTask).not.toHaveBeenCalled();
    });
});

function pendingTrace(): EcommerceGenerationTrace {
    return { ...ecommerceTrace(), finalStatus: "completed", stages: ecommerceTrace().stages.map((stage) => (stage.key === "quality_check" ? { ...stage, status: "not_run", output: { policy: "advisory" } } : stage)) };
}

function completedRun() {
    return {
        id: "run-1",
        userId: "user-1",
        status: "completed",
        reviewed: true,
        timings: { reviewCompletedAt: 2 },
        tasks: [{ id: "agent-task-1", status: "completed", taskIds: ["image-task-1"], ecommerceExecution: { state: "ready", parameters: {}, referenceRoles: [] } }],
        ecommerceSnapshot: {
            qualityPolicy: "advisory",
            technicalCheck: { status: "passed" },
            qualityCheck: {
                version: "ecommerce-quality.v1",
                status: "blocked",
                publicStatus: "needs_review",
                checkedAt: 2,
                modelRole: { logicalRole: "quality_check", capability: "text", logicalModelId: "quality", channelId: "fixture", upstreamModel: "fixture", apiFormat: "openai" },
                checks: [],
                hardFailures: [],
                internalReason: "fixture visual opinion",
            },
        },
    };
}

function ecommerceTrace(): EcommerceGenerationTrace {
    return {
        version: "ecommerce-generation-trace.v1",
        runId: "run-1",
        agentTaskId: "agent-task-1",
        imageTaskIds: ["image-task-1"],
        stages: [
            { key: "visual_analysis", status: "completed", output: {} },
            { key: "edit_planning", status: "completed", output: {} },
            { key: "image_generation", status: "completed", output: {} },
            {
                key: "quality_check",
                status: "blocked",
                output: {
                    observations: { baseline: { readable: true, visibleStructure: [] } },
                    contradictions: [{ source: "plan", observedCount: 3, reportedCount: 2 }],
                    sceneProtectionEvidence: [{ resultId: "result", evidence: { outsideMaskMatches: false } }],
                    canvasEvidence: [{ resultId: "result", nativeStatus: "readable", nativeSize: { width: 1254, height: 1254 }, nativeMatches: false, storedStatus: "unavailable", storedMatches: null }],
                },
            },
        ],
        finalStatus: "needs_review",
        recordedAt: 1,
    };
}

function generationLog(): StoredGenerationLog {
    return {
        id: "log-1",
        userId: "user-1",
        username: "creator",
        displayName: "Creator",
        kind: "image",
        source: "agent",
        status: "success",
        title: "Product scene",
        prompt: "Place the product in a room",
        model: "image-model",
        summary: "done",
        durationMs: 100,
        count: 1,
        successCount: 1,
        failCount: 0,
        assets: [],
        taskId: "image-task-1",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };
}
