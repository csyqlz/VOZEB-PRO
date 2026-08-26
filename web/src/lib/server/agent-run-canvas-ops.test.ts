import { describe, expect, it } from "vitest";

import type { AgentRunTask } from "./agent-run-store";
import { planToOps, taskCanvasEventOps, taskResultOps } from "./agent-run-canvas-ops";

describe("Agent Canvas result operations", () => {
    it("connects every visible source directly to planned output nodes", () => {
        const task = imageTask({
            targetNodeId: "source-one",
            references: [
                { nodeId: "source-one", type: "image", url: "/one.webp" },
                { nodeId: "source-two", type: "image", url: "/two.webp" },
            ],
        });
        const snapshot = {
            nodes: [
                { id: "source-one", type: "image" },
                { id: "source-two", type: "image" },
            ],
        };
        const plan = { foundation: { brief: {}, direction: {} }, deliverables: [] };

        const ops = planToOps(plan as never, [task], "run", snapshot);

        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "source-one", toNodeId: "output-run-0-0" });
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "source-two", toNodeId: "output-run-0-0" });
    });

    it("creates additional nodes when one upstream task returns multiple images", () => {
        const task = imageTask({
            targetNodeId: "source-image",
            references: [{ nodeId: "source-image", type: "image", url: "/source.webp" }],
            status: "completed",
            attempts: 1,
            taskId: "child-one",
            taskIds: ["child-one"],
            result: {
                results: [
                    { serverUrl: "/api/generation-log-assets/one.webp", width: 1600, height: 900 },
                    { serverUrl: "/api/generation-log-assets/two.webp", width: 900, height: 1600 },
                ],
            },
        });

        const output = taskResultOps("run", 0, task);

        expect(output.nodeIds).toEqual(["output-run-0-0", "output-run-0-1"]);
        expect(output.ops).toContainEqual(expect.objectContaining({ type: "update_node", id: "output-run-0-0", metadata: expect.objectContaining({ serverUrl: "/api/generation-log-assets/one.webp" }) }));
        expect(output.ops).toContainEqual(expect.objectContaining({ type: "add_node", id: "output-run-0-1", metadata: expect.objectContaining({ serverUrl: "/api/generation-log-assets/two.webp" }) }));
        expect(output.ops).toContainEqual({ type: "connect_nodes", fromNodeId: "source-image", toNodeId: "output-run-0-1" });
    });

    it("preserves every successful result when another child in the batch fails", () => {
        const task = imageTask({
            count: 2,
            status: "failed",
            attempts: 1,
            error: "部分图片生成失败",
            childTasks: [
                {
                    id: "child-success",
                    status: "completed",
                    attempt: 1,
                    result: { results: [{ serverUrl: "/one.webp" }, { serverUrl: "/two.webp" }] },
                },
                { id: "child-failed", status: "failed", attempt: 1, error: "第二个上游任务失败" },
            ],
        });

        const output = taskCanvasEventOps("run", 0, task, "task.failed");

        expect(output?.nodeIds).toEqual(["output-run-0-0", "output-run-0-1", "output-run-0-2"]);
        expect(output?.ops).toContainEqual(expect.objectContaining({ id: "output-run-0-0", metadata: expect.objectContaining({ status: "success", serverUrl: "/one.webp" }) }));
        expect(output?.ops).toContainEqual(expect.objectContaining({ id: "output-run-0-1", metadata: expect.objectContaining({ status: "success", serverUrl: "/two.webp" }) }));
        expect(output?.ops).toContainEqual(expect.objectContaining({ type: "add_node", id: "output-run-0-2", metadata: expect.objectContaining({ status: "error", errorDetails: "第二个上游任务失败" }) }));
    });
});

function imageTask(patch: Partial<AgentRunTask>): AgentRunTask {
    return {
        id: "image-task",
        title: "角色图",
        type: "image",
        prompt: "生成角色图",
        count: 1,
        dependencies: [],
        status: "ready",
        attempts: 0,
        ...patch,
    };
}
