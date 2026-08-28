import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DramaProject } from "@/lib/drama-project-contract";
import type { VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";
import { createVozebCmsDramaProductionWorkflow } from "@/lib/vozeb-cms/workflow-templates";
import { getVozebCmsBuiltInWorkflowNodeExecutor } from "./workflow-default-executors";

const mocks = vi.hoisted(() => ({ project: null as DramaProject | null }));

const run = { projectRef: { id: "drama-one", type: "drama" as const, ownerId: "user-one" }, context: { episodeId: "episode-one" } } as unknown as VozebCmsWorkflowRun;

vi.mock("@/lib/server/drama-project-store", () => ({ getDramaProject: vi.fn(async () => mocks.project) }));

describe("VOZEBCMS built-in drama workflow executors", () => {
    beforeEach(() => {
        mocks.project = {
            id: "drama-one",
            title: "测试短剧",
            summary: "",
            style: "",
            ratio: "9:16",
            status: "active",
            activeEpisodeId: "episode-one",
            characters: [{ id: "character-one", name: "角色", description: "", references: [] }],
            scenes: [{ id: "scene-one", name: "场景", description: "", references: [] }],
            props: [],
            clues: [],
            defaultVideoMode: "direct",
            episodes: [
                {
                    id: "episode-one",
                    title: "第 1 集",
                    script: "一个完整剧本",
                    outline: "",
                    hook: "",
                    nextPreview: "",
                    sourceRange: "",
                    reviewStatus: "approved",
                    shots: [
                        {
                            id: "shot-one",
                            order: 1,
                            title: "镜头",
                            description: "",
                            sourceText: "",
                            shotBoundary: "",
                            dialogue: "",
                            narration: "",
                            utterances: [],
                            imagePrompt: "",
                            videoPrompt: "",
                            cameraMotion: "",
                            duration: 5,
                            characterIds: [],
                            propIds: [],
                            clueIds: [],
                            videoUrl: "https://example.test/shot.mp4",
                            generationStatus: "success",
                        },
                    ],
                },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
    });

    it("uses completed drama videos as action output", async () => {
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one" });
        const node = workflow.nodes.find((item) => item.id === "video")!;
        const executor = getVozebCmsBuiltInWorkflowNodeExecutor(node, run);
        await expect(executor!({ userId: "user-one", run, node, state: {} as never })).resolves.toMatchObject({ status: "success", output: [{ type: "video", url: "https://example.test/shot.mp4" }] });
    });

    it("fails clearly instead of waiting forever for a missing script", async () => {
        mocks.project!.episodes[0].script = "";
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one" });
        const node = workflow.nodes.find((item) => item.id === "script")!;
        const executor = getVozebCmsBuiltInWorkflowNodeExecutor(node, run);
        await expect(executor!({ userId: "user-one", run, node, state: {} as never })).resolves.toEqual({ status: "failed", error: "当前剧集还没有可执行剧本" });
    });

    it("keeps the run bound to its explicit episode when the active episode changes", async () => {
        mocks.project!.episodes.push({ ...structuredClone(mocks.project!.episodes[0]), id: "episode-two", title: "第 2 集", script: "" });
        mocks.project!.activeEpisodeId = "episode-two";
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one" });
        const node = workflow.nodes.find((item) => item.id === "script")!;
        const executor = getVozebCmsBuiltInWorkflowNodeExecutor(node, run);

        await expect(executor!({ userId: "user-one", run, node, state: {} as never })).resolves.toMatchObject({ status: "success", output: { episodeId: "episode-one" } });
    });

    it("rejects a run without an explicit episode identity", async () => {
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one" });
        const node = workflow.nodes.find((item) => item.id === "script")!;
        const executor = getVozebCmsBuiltInWorkflowNodeExecutor(node, { ...run, context: {} } as never);

        await expect(executor!({ userId: "user-one", run: { ...run, context: {} } as never, node, state: {} as never })).resolves.toEqual({ status: "failed", error: "短剧工作流缺少剧集标识" });
    });

    it("returns a clear failure for a failed video shot", async () => {
        mocks.project!.episodes[0].shots[0].generationStatus = "error";
        mocks.project!.episodes[0].shots[0].generationError = "上游拒绝";
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one" });
        const node = workflow.nodes.find((item) => item.id === "video")!;
        const executor = getVozebCmsBuiltInWorkflowNodeExecutor(node, run);
        await expect(executor!({ userId: "user-one", run, node, state: {} as never })).resolves.toMatchObject({ status: "failed", error: "上游拒绝" });
    });

    it("rejects an unknown action instead of leaving the node waiting", async () => {
        const workflow = createVozebCmsDramaProductionWorkflow({ userId: "user-one", projectId: "drama-one" });
        const node = { ...workflow.nodes[0], config: { ...workflow.nodes[0].config, actionId: "drama.unknown" } };
        const executor = getVozebCmsBuiltInWorkflowNodeExecutor(node, run);
        await expect(executor!({ userId: "user-one", run, node, state: {} as never })).resolves.toEqual({ status: "failed", error: "工作流 Action 未注册：drama.unknown" });
    });
});
