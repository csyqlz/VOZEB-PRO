import { describe, expect, it, vi } from "vitest";
import { createVozebCmsWorkflowRun as createRun, normalizeVozebCmsWorkflowDefinition } from "@/lib/vozeb-cms/workflow-contract";

const register = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/lib/server/creative-runtime-service", () => ({ registerGenerationTaskAssetsForUser: register }));

import { extractWorkflowAssets, persistVozebCmsWorkflowOutputAssets } from "./workflow-output";

const outputDefinition = normalizeVozebCmsWorkflowDefinition({ id: "workflow-one", name: "输出", nodes: [{ id: "video", kind: "task", name: "视频生成", config: {} }] }, "user-one");

function outputRun(overrides: Partial<ReturnType<typeof createRun>> = {}) {
    return { ...createRun(outputDefinition, "user-one", {}), ...overrides };
}

describe("VOZEBCMS workflow output", () => {
    it("normalizes media results from task payloads and removes duplicates", () => {
        expect(
            extractWorkflowAssets({
                results: [
                    { url: "/media/a.png", mimeType: "image/png" },
                    { url: "/media/a.png", mimeType: "image/png" },
                    { url: "/media/a.mp4", mimeType: "video/mp4" },
                ],
            }),
        ).toEqual([
            { type: "image", url: "/media/a.png", mimeType: "image/png" },
            { type: "video", url: "/media/a.mp4", mimeType: "video/mp4" },
        ]);
    });

    it("registers output assets through the existing creative asset service", async () => {
        await persistVozebCmsWorkflowOutputAssets({
            userId: "user-one",
            run: outputRun({ id: "run-one", projectId: "project-one", context: { conversationId: "conversation-one", surface: "drama" } }),
            node: { id: "video", kind: "task", name: "视频生成", dependsOn: [], config: {} },
            taskId: "task-one",
            output: { url: "/media/video.mp4", mimeType: "video/mp4" },
        });
        expect(register).toHaveBeenCalledWith("user-one", expect.objectContaining({ conversationId: "conversation-one", projectId: "project-one", taskId: "task-one", assets: [{ type: "video", url: "/media/video.mp4", mimeType: "video/mp4" }] }));
    });

    it("keeps project workflow output eligible for asset registration without a conversation id", async () => {
        register.mockClear();
        await persistVozebCmsWorkflowOutputAssets({
            userId: "user-one",
            run: outputRun({ id: "run-two", projectId: "project-one", projectRef: { id: "project-one", type: "drama", ownerId: "user-one" } }),
            node: { id: "video", kind: "task", name: "视频生成", dependsOn: [], config: {} },
            taskId: "task-two",
            output: { url: "/media/video-two.mp4", mimeType: "video/mp4" },
        });

        expect(register).toHaveBeenCalledWith("user-one", expect.objectContaining({ projectId: "project-one", surface: "drama", taskId: "task-two", assets: [{ type: "video", url: "/media/video-two.mp4", mimeType: "video/mp4" }] }));
    });

    it("keeps each multi-shot asset linked to its own generation task", async () => {
        register.mockClear();
        await persistVozebCmsWorkflowOutputAssets({
            userId: "user-one",
            run: outputRun({ id: "run-three", projectId: "drama-one" }),
            node: { id: "video", kind: "task", name: "视频生成", dependsOn: [], config: {} },
            output: [
                { type: "video", url: "/media/shot-one.mp4", taskId: "task-one" },
                { type: "video", url: "/media/shot-two.mp4", taskId: "task-two" },
            ],
        });

        expect(register).toHaveBeenCalledTimes(2);
        expect(register).toHaveBeenCalledWith("user-one", expect.objectContaining({ runId: "run-three", taskId: "task-one", assets: [{ type: "video", url: "/media/shot-one.mp4" }] }));
        expect(register).toHaveBeenCalledWith("user-one", expect.objectContaining({ runId: "run-three", taskId: "task-two", assets: [{ type: "video", url: "/media/shot-two.mp4" }] }));
    });
});
