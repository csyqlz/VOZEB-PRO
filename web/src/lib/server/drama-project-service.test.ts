import { beforeEach, describe, expect, it, vi } from "vitest";

import { DRAMA_PROJECT_MAX_BYTES, type DramaProject } from "@/lib/drama-project-contract";

const mocks = vi.hoisted(() => {
    class MockDramaProjectStoreError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    }
    return {
        DramaProjectStoreError: MockDramaProjectStoreError,
        createCreativeConversation: vi.fn(),
        deleteDramaConversationAggregate: vi.fn(),
        getCreativeConversation: vi.fn(),
        listCreativeConversations: vi.fn(),
        listAgentRuns: vi.fn(),
        updateCreativeConversation: vi.fn(),
        createDramaProject: vi.fn(),
        deleteDramaProject: vi.fn(),
        findDramaProjectBySourceHandoffId: vi.fn(),
        getDramaProject: vi.fn(),
        listDramaProjectSummaries: vi.fn(),
        updateDramaProject: vi.fn(),
        assignDramaContentTask: vi.fn(),
        assignDramaVisualTask: vi.fn(),
        applyDramaVisualResult: vi.fn(),
        createDramaProjectVersion: vi.fn(),
        getDramaProjectVersion: vi.fn(),
        listDramaProjectVersions: vi.fn(),
        deleteUserMediaAssetsCascade: vi.fn(),
    };
});

vi.mock("@/lib/server/agent-run-store", () => ({ listAgentRuns: mocks.listAgentRuns }));
vi.mock("@/lib/server/creative-entity-deletion-store", () => ({
    CreativeEntityDeletionConflict: class CreativeEntityDeletionConflict extends Error {},
    deleteDramaConversationAggregate: mocks.deleteDramaConversationAggregate,
}));
vi.mock("@/lib/server/creative-runtime-store", () => ({
    createCreativeConversation: mocks.createCreativeConversation,
    getCreativeConversation: mocks.getCreativeConversation,
    listCreativeConversations: mocks.listCreativeConversations,
    updateCreativeConversation: mocks.updateCreativeConversation,
}));
vi.mock("@/lib/server/drama-project-store", () => ({
    DramaProjectStoreError: mocks.DramaProjectStoreError,
    createDramaProject: mocks.createDramaProject,
    deleteDramaProject: mocks.deleteDramaProject,
    findDramaProjectBySourceHandoffId: mocks.findDramaProjectBySourceHandoffId,
    getDramaProject: mocks.getDramaProject,
    listDramaProjectSummaries: mocks.listDramaProjectSummaries,
    updateDramaProject: mocks.updateDramaProject,
    assignDramaContentTask: mocks.assignDramaContentTask,
    assignDramaVisualTask: mocks.assignDramaVisualTask,
    applyDramaVisualResult: mocks.applyDramaVisualResult,
}));
vi.mock("@/lib/server/drama-project-version-store", () => ({
    createDramaProjectVersion: mocks.createDramaProjectVersion,
    getDramaProjectVersion: mocks.getDramaProjectVersion,
    listDramaProjectVersions: mocks.listDramaProjectVersions,
}));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: mocks.deleteUserMediaAssetsCascade }));

import {
    applyDramaVisualResultForUser,
    assignDramaVisualTaskForUser,
    createDramaProjectForUser,
    createDramaProjectVersionForUser,
    deleteDramaAgentConversationForUser,
    deleteDramaProjectForUser,
    DramaProjectServiceError,
    restoreDramaProjectVersionForUser,
    updateDramaProjectForUser,
} from "./drama-project-service";
import { DramaProjectStoreError } from "./drama-project-store";

describe("drama project service updates", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.updateDramaProject.mockImplementation(async (_userId: string, value: DramaProject) => value);
        mocks.createCreativeConversation.mockResolvedValue({ id: "conversation-new" });
        mocks.updateCreativeConversation.mockResolvedValue({ id: "conversation-new", status: "archived" });
        mocks.getCreativeConversation.mockResolvedValue({ id: "conversation-one", userId: "user-one", surface: "drama", source: "drama", projectId: "drama-one", status: "active" });
        mocks.listCreativeConversations.mockResolvedValue([{ id: "conversation-one" }, { id: "conversation-two" }]);
        mocks.listAgentRuns.mockResolvedValue([]);
        mocks.deleteDramaConversationAggregate.mockResolvedValue({ deletedConversations: 1, mediaStorageKeys: ["permanent/agent.png"], dramaProject: { ...project("2026-07-19T08:00:03.000Z", "项目"), creativeConversationId: "conversation-two" } });
        mocks.findDramaProjectBySourceHandoffId.mockResolvedValue(null);
        mocks.listDramaProjectSummaries.mockResolvedValue([]);
        mocks.createDramaProjectVersion.mockResolvedValue({ id: "version-new", projectId: "drama-one", version: 2, reason: "恢复前自动快照", createdAt: new Date().toISOString() });
        mocks.assignDramaVisualTask.mockResolvedValue({ updatedAt: "2026-08-26T06:00:00.000Z" });
    });

    it("binds and applies a complete visual result through the server project state", async () => {
        const current = project("2026-07-19T08:00:02.000Z", "项目");
        current.episodes[0].visualTaskId = "visual-task-one";
        current.episodes[0].shots = [
            {
                id: "shot-one",
                order: 1,
                title: "镜头一",
                description: "描述",
                sourceText: "原文",
                shotBoundary: "边界",
                dialogue: "对白",
                narration: "",
                utterances: [],
                imagePrompt: "",
                videoPrompt: "",
                cameraMotion: "",
                duration: 5,
                characterIds: [],
                propIds: [],
                clueIds: [],
            },
        ];
        mocks.getDramaProject.mockResolvedValue(current);
        mocks.applyDramaVisualResult.mockResolvedValue({ project: current, version: { id: "version-one" } });

        await expect(assignDramaVisualTaskForUser("user-one", current.id, "episode-one", "visual-task-one")).resolves.toMatchObject({ updatedAt: "2026-08-26T06:00:00.000Z" });
        await expect(
            applyDramaVisualResultForUser("user-one", current.id, "episode-one", {
                taskId: "visual-task-one",
                analysis: {
                    shots: [
                        {
                            shotId: "shot-one",
                            imagePrompt: "图片提示词",
                            videoPrompt: "视频提示词",
                            cameraMotion: "推进",
                            startFramePrompt: "起始",
                            endFramePrompt: "结束",
                            negativePrompt: "模糊",
                            continuity: {},
                        },
                    ],
                },
            }),
        ).resolves.toMatchObject({ version: { id: "version-one" } });
        expect(mocks.applyDramaVisualResult).toHaveBeenCalledWith("user-one", current.id, "episode-one", "visual-task-one", expect.objectContaining({ shots: [expect.objectContaining({ shotId: "shot-one" })] }));
    });

    it("does not let an older client snapshot overwrite the current project", async () => {
        const current = project("2026-07-19T08:00:02.000Z", "最新标题");
        mocks.getDramaProject.mockResolvedValue(current);

        const saved = await updateDramaProjectForUser("user-one", current.id, project("2026-07-19T08:00:01.000Z", "旧标题"));

        expect(saved).toEqual(current);
        expect(mocks.updateDramaProject).not.toHaveBeenCalled();
    });

    it("normalizes and stores a newer client snapshot", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        mocks.getDramaProject.mockResolvedValue(current);

        const saved = await updateDramaProjectForUser("user-one", current.id, project("2026-07-19T08:00:02.000Z", "新标题"));

        expect(saved.title).toBe("新标题");
        expect(saved.updatedAt).toBe("2026-07-19T08:00:02.000Z");
        expect(mocks.updateDramaProject).toHaveBeenCalledWith("user-one", expect.objectContaining({ id: current.id, title: "新标题", updatedAt: "2026-07-19T08:00:02.000Z" }), current.updatedAt);
    });

    it("preserves exact project dimensions and reference metadata", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        mocks.getDramaProject.mockResolvedValue(current);
        const input = {
            ...project("2026-07-19T08:00:02.000Z", "新标题"),
            ratio: "1080x1920",
            characters: [
                {
                    id: "character-one",
                    name: "主角",
                    description: "",
                    references: [{ id: "reference-one", url: "/api/reference-assets/hero.png", source: "upload", label: "主角", width: 1080, height: 1920, createdAt: "2026-07-19T08:00:00.000Z" }],
                },
            ],
        };

        const saved = await updateDramaProjectForUser("user-one", current.id, input);

        expect(saved).toMatchObject({ ratio: "1080x1920", characters: [{ references: [{ width: 1080, height: 1920 }] }] });
    });

    it("preserves exact project dimensions without a platform ceiling", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        mocks.getDramaProject.mockResolvedValue(current);

        await expect(updateDramaProjectForUser("user-one", current.id, { ...project("2026-07-19T08:00:02.000Z", "新标题"), ratio: "5000x5000" })).resolves.toMatchObject({ ratio: "5000x5000" });
    });

    it("keeps projects beyond the former collection and text thresholds", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        mocks.getDramaProject.mockResolvedValue(current);
        const longDescription = "完整镜头说明".repeat(1_000);
        const shots = Array.from({ length: 501 }, (_, index) => ({
            id: `shot-${index}`,
            order: index + 1,
            title: `镜头 ${index}`,
            description: index === 500 ? longDescription : "描述",
            sourceText: "原文",
            duration: index === 500 ? 21 : 5,
            utterances: index === 500 ? Array.from({ length: 101 }, (__, utteranceIndex) => ({ id: `utterance-${utteranceIndex}`, order: utteranceIndex + 1, type: "dialogue", speaker: "角色", text: `台词 ${utteranceIndex}` })) : [],
            characterIds: Array.from({ length: 51 }, (__, relationIndex) => `character-${relationIndex}`),
            propIds: Array.from({ length: 51 }, (__, relationIndex) => `prop-${relationIndex}`),
            clueIds: Array.from({ length: 51 }, (__, relationIndex) => `clue-${relationIndex}`),
        }));
        const characters = Array.from({ length: 201 }, (_, index) => ({
            id: `character-${index}`,
            name: `角色 ${index}`,
            references: index === 200 ? Array.from({ length: 13 }, (__, referenceIndex) => ({ id: `reference-${referenceIndex}`, url: `/api/reference-assets/reference-${referenceIndex}.png`, source: "upload", label: `参考 ${referenceIndex}` })) : [],
        }));
        const episodes = Array.from({ length: 101 }, (_, index) => ({
            id: `episode-${index}`,
            title: `第 ${index + 1} 集`,
            script: "剧本",
            shots: index === 100 ? shots : [],
            contentTaskId: index === 100 ? "content-task-one" : undefined,
            contentError: index === 100 ? "内容任务暂时失败" : undefined,
            visualTaskId: index === 100 ? "visual-task-one" : undefined,
            visualError: index === 100 ? "视觉任务暂时失败" : undefined,
            visualReview:
                index === 100 ? { mode: "text", status: "needs_revision", summary: "需要调整", issues: Array.from({ length: 9 }, (__, issueIndex) => ({ category: `问题 ${issueIndex}`, severity: "low", message: `说明 ${issueIndex}` })) } : undefined,
        }));
        const input = {
            ...project("2026-07-19T08:00:02.000Z", "新标题"),
            activeEpisodeId: "episode-100",
            episodes,
            characters,
            scenes: Array.from({ length: 201 }, (_, index) => ({ id: `scene-${index}`, name: `场景 ${index}` })),
            props: Array.from({ length: 201 }, (_, index) => ({ id: `prop-${index}`, name: `道具 ${index}` })),
            clues: Array.from({ length: 201 }, (_, index) => ({ id: `clue-${index}`, name: `线索 ${index}` })),
            sourceAssets: Array.from({ length: 101 }, (_, index) => ({ id: `source-${index}`, type: "text", title: `素材 ${index}`, textContent: `内容 ${index}` })),
        };

        const saved = await updateDramaProjectForUser("user-one", current.id, input);

        expect(saved.episodes).toHaveLength(101);
        expect(saved.characters).toHaveLength(201);
        expect(saved.scenes).toHaveLength(201);
        expect(saved.props).toHaveLength(201);
        expect(saved.clues).toHaveLength(201);
        expect(saved.sourceAssets).toHaveLength(101);
        expect(saved.episodes[100].shots).toHaveLength(501);
        expect(saved.episodes[100].shots[500]).toMatchObject({ duration: 21, description: longDescription });
        expect(saved.episodes[100].shots[500].utterances).toHaveLength(101);
        expect(saved.episodes[100].shots[500].characterIds).toHaveLength(51);
        expect(saved.episodes[100].shots[500].propIds).toHaveLength(51);
        expect(saved.episodes[100].shots[500].clueIds).toHaveLength(51);
        expect(saved.episodes[100].visualReview?.issues).toHaveLength(9);
        expect(saved.episodes[100]).toMatchObject({ contentTaskId: "content-task-one", contentError: "内容任务暂时失败", visualTaskId: "visual-task-one", visualError: "视觉任务暂时失败" });
        expect(saved.characters[200].references).toHaveLength(13);
    });

    it("accepts imported projects and versions between 2 MiB and the shared 8 MiB limit", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        const imported = { ...project("2026-07-19T08:00:02.000Z", "整本剧本"), episodes: [{ ...current.episodes[0], script: "剧".repeat(1_050_000) }] };
        mocks.getDramaProject.mockResolvedValue(current);

        expect(Buffer.byteLength(JSON.stringify(imported))).toBeGreaterThan(2 * 1024 * 1024);
        expect(Buffer.byteLength(JSON.stringify(imported))).toBeLessThan(DRAMA_PROJECT_MAX_BYTES);
        await expect(updateDramaProjectForUser("user-one", current.id, imported)).resolves.toMatchObject({ title: "整本剧本" });
        await expect(createDramaProjectVersionForUser("user-one", current.id, { reason: "整本导入后", snapshot: imported })).resolves.toMatchObject({ id: "version-new" });
    });

    it("rejects oversized project creation, updates, and versions at the shared limit", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        const script = "x".repeat(DRAMA_PROJECT_MAX_BYTES);
        const oversized = { ...project("2026-07-19T08:00:02.000Z", "超大剧本"), episodes: [{ ...current.episodes[0], script }] };
        mocks.getDramaProject.mockResolvedValue(current);

        await expect(createDramaProjectForUser("user-one", { title: "超大剧本", initialScript: script })).rejects.toMatchObject({ status: 413, message: "短剧项目数据过大" });
        await expect(updateDramaProjectForUser("user-one", current.id, oversized)).rejects.toMatchObject({ status: 413, message: "短剧项目数据过大" });
        await expect(createDramaProjectVersionForUser("user-one", current.id, { snapshot: oversized })).rejects.toMatchObject({ status: 413, message: "短剧版本数据过大" });
        expect(mocks.createDramaProject).not.toHaveBeenCalled();
        expect(mocks.updateDramaProject).not.toHaveBeenCalled();
    });

    it("archives the new conversation when project creation fails", async () => {
        const error = new Error("write failed");
        mocks.createDramaProject.mockRejectedValue(error);

        await expect(createDramaProjectForUser("user-one", { title: "项目" })).rejects.toBe(error);

        expect(mocks.updateCreativeConversation).toHaveBeenCalledWith("conversation-new", "user-one", { status: "archived" });
    });

    it("reuses a handoff project without listing every project snapshot", async () => {
        const existing = { ...project("2026-07-19T08:00:02.000Z", "已存在项目"), sourceHandoffId: "handoff-one" };
        mocks.findDramaProjectBySourceHandoffId.mockResolvedValue(existing);

        await expect(createDramaProjectForUser("user-one", { title: "重复创建", sourceHandoffId: "handoff-one" })).resolves.toEqual(existing);

        expect(mocks.findDramaProjectBySourceHandoffId).toHaveBeenCalledWith("user-one", "handoff-one");
        expect(mocks.createCreativeConversation).not.toHaveBeenCalled();
        expect(mocks.createDramaProject).not.toHaveBeenCalled();
    });

    it("archives the linked conversation after deleting a project", async () => {
        mocks.getDramaProject.mockResolvedValue({ ...project("2026-07-19T08:00:02.000Z", "项目"), creativeConversationId: "conversation-one" });
        mocks.deleteDramaProject.mockResolvedValue(true);

        await deleteDramaProjectForUser("user-one", "drama-one");

        expect(mocks.updateCreativeConversation).toHaveBeenCalledWith("conversation-one", "user-one", { status: "archived" });
        expect(mocks.deleteUserMediaAssetsCascade).toHaveBeenCalled();
    });

    it("deletes a project-owned drama conversation and returns the replacement project", async () => {
        mocks.getDramaProject.mockResolvedValue({ ...project("2026-07-19T08:00:02.000Z", "项目"), creativeConversationId: "conversation-one" });

        await expect(deleteDramaAgentConversationForUser("user-one", "drama-one", "conversation-one")).resolves.toMatchObject({ deleted: true, activeConversationId: "conversation-two" });

        expect(mocks.listAgentRuns).toHaveBeenCalledWith({ userId: "user-one", conversationId: "conversation-one", surface: "drama", statuses: ["planning", "running", "paused"], limit: 1 });
        expect(mocks.deleteDramaConversationAggregate).toHaveBeenCalledWith("user-one", "drama-one", "conversation-one", "conversation-two");
        expect(mocks.deleteUserMediaAssetsCascade).toHaveBeenCalledWith("user-one", ["permanent/agent.png"]);
    });

    it("rejects deleting a running or unrelated drama conversation", async () => {
        mocks.getDramaProject.mockResolvedValue({ ...project("2026-07-19T08:00:02.000Z", "项目"), creativeConversationId: "conversation-one" });
        mocks.listAgentRuns.mockResolvedValueOnce([{ id: "run-one" }]);

        await expect(deleteDramaAgentConversationForUser("user-one", "drama-one", "conversation-one")).rejects.toMatchObject({ status: 409, message: "运行中的对话需先停止任务再删除" });
        mocks.getCreativeConversation.mockResolvedValueOnce({ id: "conversation-other", userId: "user-one", surface: "drama", source: "drama", projectId: "drama-other" });
        await expect(deleteDramaAgentConversationForUser("user-one", "drama-one", "conversation-other")).rejects.toMatchObject({ status: 409, message: "Agent 对话与当前短剧项目不匹配" });
        expect(mocks.deleteDramaConversationAggregate).not.toHaveBeenCalled();
    });

    it("restores an older snapshot after saving the current project", async () => {
        const current = project("2026-07-19T08:00:02.000Z", "当前版本");
        const legacySnapshot = {
            id: current.id,
            title: "历史版本",
            summary: "旧项目摘要",
            style: "旧画风",
            ratio: "9:16",
            status: "active",
            activeEpisodeId: "episode-one",
            characters: [],
            scenes: [],
            episodes: [{ id: "episode-one", title: "第 1 集", script: "旧剧本", shots: [] }],
            createdAt: current.createdAt,
            updatedAt: "2026-07-18T08:00:00.000Z",
        };
        mocks.getDramaProject.mockResolvedValue(current);
        mocks.getDramaProjectVersion.mockResolvedValue({ id: "version-one", projectId: current.id, version: 1, reason: "初稿", createdAt: current.createdAt, snapshot: legacySnapshot });

        const restored = await restoreDramaProjectVersionForUser("user-one", current.id, "version-one");

        expect(mocks.createDramaProjectVersion).toHaveBeenCalledWith("user-one", current.id, "恢复前自动快照", current);
        expect(restored).toMatchObject({
            title: "历史版本",
            props: [],
            clues: [],
            defaultVideoMode: "storyboard",
            episodes: [{ id: "episode-one", sourceRange: "", reviewStatus: "draft" }],
        });
        expect(mocks.updateDramaProject).toHaveBeenCalledWith("user-one", expect.objectContaining({ title: "历史版本" }), current.updatedAt);
    });

    it("maps a concurrent persistence conflict to a user-readable 409", async () => {
        const current = project("2026-07-19T08:00:01.000Z", "旧标题");
        mocks.getDramaProject.mockResolvedValue(current);
        mocks.updateDramaProject.mockRejectedValueOnce(new DramaProjectStoreError("短剧项目已在其他页面更新，请刷新后重试", 409));

        await expect(updateDramaProjectForUser("user-one", current.id, project("2026-07-19T08:00:02.000Z", "新标题"))).rejects.toMatchObject({ status: 409, message: "短剧项目已在其他页面更新，请刷新后重试" });
    });

    it("returns 404 before reading another user's version", async () => {
        mocks.getDramaProject.mockResolvedValue(null);

        await expect(restoreDramaProjectVersionForUser("user-two", "drama-one", "version-one")).rejects.toMatchObject({ status: 404 });

        expect(mocks.getDramaProjectVersion).not.toHaveBeenCalled();
        expect(mocks.createDramaProjectVersion).not.toHaveBeenCalled();
    });
});

function project(updatedAt: string, title: string): DramaProject {
    return {
        id: "drama-one",
        title,
        summary: "",
        style: "电影感",
        ratio: "9:16",
        status: "active",
        activeEpisodeId: "episode-one",
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        defaultVideoMode: "storyboard",
        episodes: [{ id: "episode-one", title: "第 1 集", script: "", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft", shots: [] }],
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt,
    };
}
