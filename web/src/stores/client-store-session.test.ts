import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasProject, CanvasProjectSummary } from "@/lib/canvas-project-contract";
import { summarizeCanvasProjectRecord } from "@/lib/canvas-project-summary";
import type { DramaProject, DramaProjectSummary } from "@/lib/drama-project-contract";
import { summarizeDramaProject } from "@/lib/drama-project-summary";
import type { Asset } from "@/lib/library-asset-contract";

const mocks = vi.hoisted(() => ({
    listAssets: vi.fn(),
    createAsset: vi.fn(),
    saveAsset: vi.fn(),
    deleteAsset: vi.fn(),
    uploadImage: vi.fn(),
    uploadMediaFile: vi.fn(),
    listCanvasProjectSummaries: vi.fn(),
    getCanvasProject: vi.fn(),
    createCanvasProject: vi.fn(),
    saveCanvasProjectMutation: vi.fn(),
    deleteCanvasProjects: vi.fn(),
    listDramaProjectSummaries: vi.fn(),
    getDramaProject: vi.fn(),
    createDramaProject: vi.fn(),
    saveDramaProject: vi.fn(),
    deleteDramaProject: vi.fn(),
    createDramaProjectVersion: vi.fn(),
    listDramaProjectVersions: vi.fn(),
    restoreDramaProjectVersion: vi.fn(),
}));

vi.mock("@/services/api/library-assets", () => ({
    listLibraryAssets: mocks.listAssets,
    createLibraryAsset: mocks.createAsset,
    saveLibraryAsset: mocks.saveAsset,
    deleteLibraryAsset: mocks.deleteAsset,
}));
vi.mock("@/services/image-storage", () => ({ uploadImage: mocks.uploadImage }));
vi.mock("@/services/file-storage", () => ({ uploadMediaFile: mocks.uploadMediaFile }));
vi.mock("@/services/api/canvas-projects", () => ({
    CanvasProjectRequestError: class extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    listCanvasProjectSummaries: mocks.listCanvasProjectSummaries,
    getCanvasProject: mocks.getCanvasProject,
    createCanvasProject: mocks.createCanvasProject,
    saveCanvasProjectMutation: mocks.saveCanvasProjectMutation,
    deleteCanvasProjects: mocks.deleteCanvasProjects,
}));
vi.mock("@/services/api/drama-projects", () => ({
    listDramaProjectSummaries: mocks.listDramaProjectSummaries,
    getDramaProject: mocks.getDramaProject,
    createDramaProject: mocks.createDramaProject,
    saveDramaProject: mocks.saveDramaProject,
    deleteDramaProject: mocks.deleteDramaProject,
    createDramaProjectVersion: mocks.createDramaProjectVersion,
    listDramaProjectVersions: mocks.listDramaProjectVersions,
    restoreDramaProjectVersion: mocks.restoreDramaProjectVersion,
}));

import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useDramaStore } from "@/app/(user)/drama/stores/use-drama-store";
import { CanvasProjectRequestError } from "@/services/api/canvas-projects";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

describe("client store session isolation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useUserStore.getState().setUser(null);
        useAssetStore.getState().reset();
        useCanvasStore.getState().reset();
        useDramaStore.getState().reset();
    });

    it("reloads assets after a reset instead of reusing the previous user's request", async () => {
        const oldRequest = deferred<Asset[]>();
        const freshAssets = [textAsset("asset-b", "用户 B 素材")];
        mocks.listAssets.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(freshAssets);

        useUserStore.getState().setUser(user("user-a"));
        const oldHydrate = useAssetStore.getState().hydrate();
        useAssetStore.getState().reset();
        useUserStore.getState().setUser(user("user-b"));
        const freshHydrate = useAssetStore.getState().hydrate();

        oldRequest.resolve([textAsset("asset-a", "用户 A 素材")]);
        await Promise.all([oldHydrate, freshHydrate]);

        expect(mocks.listAssets).toHaveBeenCalledTimes(2);
        expect(useAssetStore.getState().assets).toEqual(freshAssets);
    });

    it("refreshes hydrated assets when a picker requests the latest server state", async () => {
        const initialAssets = [textAsset("asset-old", "旧素材")];
        const freshAssets = [textAsset("asset-new", "新素材")];
        mocks.listAssets.mockResolvedValueOnce(initialAssets).mockResolvedValueOnce(freshAssets);
        useUserStore.getState().setUser(user("user-a"));

        await useAssetStore.getState().hydrate();
        await useAssetStore.getState().hydrate(true);

        expect(mocks.listAssets).toHaveBeenCalledTimes(2);
        expect(useAssetStore.getState().assets).toEqual(freshAssets);
    });

    it("reloads Canvas projects for the new user after a reset", async () => {
        const oldRequest = deferred<{ projects: CanvasProjectSummary[]; total: number; page: number; pageSize: number }>();
        const freshProjects = [summarizeCanvasProjectRecord(canvasProject("canvas-b", "用户 B 画布"))];
        mocks.listCanvasProjectSummaries.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce({ projects: freshProjects, total: 1, page: 1, pageSize: 12 });

        useUserStore.getState().setUser(user("user-a"));
        const oldHydrate = useCanvasStore.getState().hydrate();
        useCanvasStore.getState().reset();
        useUserStore.getState().setUser(user("user-b"));
        const freshHydrate = useCanvasStore.getState().hydrate();

        oldRequest.resolve({ projects: [summarizeCanvasProjectRecord(canvasProject("canvas-a", "用户 A 画布"))], total: 1, page: 1, pageSize: 12 });
        await Promise.all([oldHydrate, freshHydrate]);

        expect(mocks.listCanvasProjectSummaries).toHaveBeenCalledTimes(2);
        expect(useCanvasStore.getState().summaries).toEqual(freshProjects);
        expect(useCanvasStore.getState().summaryTotal).toBe(1);
        expect(useCanvasStore.getState().projects).toEqual([]);
    });

    it("loads only the requested Canvas detail and ignores a previous user's late response", async () => {
        const oldRequest = deferred<CanvasProject>();
        const freshProject = canvasProject("canvas-shared", "用户 B 画布");
        mocks.getCanvasProject.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(freshProject);

        useUserStore.getState().setUser(user("user-a"));
        const oldLoad = useCanvasStore.getState().loadProject("canvas-shared");
        useCanvasStore.getState().reset();
        useUserStore.getState().setUser(user("user-b"));
        const freshLoad = useCanvasStore.getState().loadProject("canvas-shared");

        oldRequest.resolve(canvasProject("canvas-shared", "用户 A 画布"));
        await Promise.allSettled([oldLoad, freshLoad]);

        expect(useCanvasStore.getState().projects).toEqual([freshProject]);
        expect(useCanvasStore.getState().summaries).toEqual([summarizeCanvasProjectRecord(freshProject)]);
    });

    it("forces a fresh Canvas detail and ignores the older overlapping response", async () => {
        const staleRequest = deferred<CanvasProject>();
        const freshProject = canvasProject("canvas-shared", "服务端最新画布");
        mocks.getCanvasProject.mockReturnValueOnce(staleRequest.promise).mockResolvedValueOnce(freshProject);
        useUserStore.getState().setUser(user("user-a"));

        const staleLoad = useCanvasStore.getState().loadProject("canvas-shared");
        const freshLoad = useCanvasStore.getState().loadProject("canvas-shared", true);
        staleRequest.resolve(canvasProject("canvas-shared", "旧缓存画布"));
        await Promise.all([staleLoad, freshLoad]);

        expect(mocks.getCanvasProject).toHaveBeenCalledTimes(2);
        expect(useCanvasStore.getState().projects).toEqual([freshProject]);
    });

    it("clamps a stale Canvas page to the last available server page", async () => {
        const firstPage = [summarizeCanvasProjectRecord(canvasProject("canvas-a", "画布一"))];
        mocks.listCanvasProjectSummaries.mockResolvedValueOnce({ projects: [], total: 1, page: 2, pageSize: 12 }).mockResolvedValueOnce({ projects: firstPage, total: 1, page: 1, pageSize: 12 });
        useUserStore.getState().setUser(user("user-a"));

        await useCanvasStore.getState().hydrate(true, 2);

        expect(mocks.listCanvasProjectSummaries).toHaveBeenNthCalledWith(1, { page: 2, pageSize: 12 });
        expect(mocks.listCanvasProjectSummaries).toHaveBeenNthCalledWith(2, { page: 1, pageSize: 12 });
        expect(useCanvasStore.getState()).toMatchObject({ summaries: firstPage, summaryPage: 1, summaryTotal: 1 });
    });

    it("keeps a newly created Canvas off a later summary page", async () => {
        const secondPage = [summarizeCanvasProjectRecord(canvasProject("canvas-old", "第二页画布"))];
        const created = canvasProject("canvas-new", "新画布");
        mocks.listCanvasProjectSummaries.mockResolvedValue({ projects: secondPage, total: 13, page: 2, pageSize: 12 });
        mocks.createCanvasProject.mockResolvedValue(created);
        useUserStore.getState().setUser(user("user-a"));

        await useCanvasStore.getState().hydrate(true, 2);
        await useCanvasStore.getState().createProject("新画布");

        expect(useCanvasStore.getState().summaries).toEqual(secondPage);
        expect(useCanvasStore.getState().summaryTotal).toBe(14);
        expect(useCanvasStore.getState().projects).toContainEqual(created);
    });

    it("coalesces rapid Canvas edits and exposes a non-blocking save state", async () => {
        vi.useFakeTimers();
        try {
            const project = canvasProject("canvas-save", "保存队列");
            useUserStore.getState().setUser(user("user-a"));
            mocks.getCanvasProject.mockResolvedValue(project);
            mocks.saveCanvasProjectMutation.mockResolvedValue({ projectId: project.id, updatedAt: "2026-08-05T12:00:00.000Z", mutationId: "mutation-one" });
            await useCanvasStore.getState().loadProject(project.id);

            useCanvasStore.getState().updateProject(project.id, { backgroundMode: "dots" });
            useCanvasStore.getState().updateProject(project.id, { backgroundMode: "blank" });

            expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "saving" });
            await vi.advanceTimersByTimeAsync(250);

            expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledTimes(1);
            expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledWith(project.id, expect.objectContaining({ baseUpdatedAt: project.updatedAt, backgroundMode: "blank", mutationId: expect.any(String) }));
            expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "saved" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps a failed Canvas snapshot available for an automatic retry", async () => {
        vi.useFakeTimers();
        try {
            const project = canvasProject("canvas-retry", "失败重试");
            useUserStore.getState().setUser(user("user-a"));
            mocks.getCanvasProject.mockResolvedValue(project);
            mocks.saveCanvasProjectMutation.mockRejectedValueOnce(new Error("网络暂时不可用")).mockResolvedValueOnce({ projectId: project.id, updatedAt: "2026-08-05T12:00:01.000Z", mutationId: "mutation-two" });
            await useCanvasStore.getState().loadProject(project.id);

            useCanvasStore.getState().updateProject(project.id, { showImageInfo: true });
            await vi.advanceTimersByTimeAsync(250);

            expect(useCanvasStore.getState().projects[0]).toMatchObject({ id: project.id, showImageInfo: true });
            expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "saving", message: "网络波动，正在重新保存" });
            await vi.advanceTimersByTimeAsync(1_000);

            expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledTimes(2);
            expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "saved" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("replays the failed Canvas mutation before saving newer edits", async () => {
        vi.useFakeTimers();
        try {
            const project = canvasProject("canvas-retry-order", "重试顺序");
            useUserStore.getState().setUser(user("user-a"));
            mocks.getCanvasProject.mockResolvedValue(project);
            mocks.saveCanvasProjectMutation
                .mockRejectedValueOnce(new Error("响应丢失"))
                .mockResolvedValueOnce({ projectId: project.id, updatedAt: "2026-08-05T12:00:01.000Z", mutationId: "mutation-first" })
                .mockResolvedValueOnce({ projectId: project.id, updatedAt: "2026-08-05T12:00:02.000Z", mutationId: "mutation-second" });
            await useCanvasStore.getState().loadProject(project.id);

            useCanvasStore.getState().updateProject(project.id, { backgroundMode: "dots" });
            await vi.advanceTimersByTimeAsync(250);
            const firstMutation = mocks.saveCanvasProjectMutation.mock.calls[0][1];

            useCanvasStore.getState().updateProject(project.id, { backgroundMode: "blank" });
            await vi.advanceTimersByTimeAsync(1_000);

            expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledTimes(3);
            expect(mocks.saveCanvasProjectMutation.mock.calls[1][1]).toMatchObject({ mutationId: firstMutation.mutationId, baseUpdatedAt: project.updatedAt, backgroundMode: "dots" });
            expect(mocks.saveCanvasProjectMutation.mock.calls[2][1]).toMatchObject({ baseUpdatedAt: "2026-08-05T12:00:01.000Z", backgroundMode: "blank" });
            expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "saved" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("exposes a Canvas version conflict instead of retrying it as a network error", async () => {
        vi.useFakeTimers();
        try {
            const project = canvasProject("canvas-conflict", "并发冲突");
            useUserStore.getState().setUser(user("user-a"));
            mocks.getCanvasProject.mockResolvedValue(project);
            mocks.saveCanvasProjectMutation.mockRejectedValue(new CanvasProjectRequestError("画布项目已在其他页面更新，请刷新后重试", 409));
            await useCanvasStore.getState().loadProject(project.id);

            useCanvasStore.getState().updateProject(project.id, { showImageInfo: true });
            await vi.advanceTimersByTimeAsync(250);

            expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "conflict", message: "画布项目已在其他页面更新，请刷新后重试" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("flushes the current Canvas snapshot with keepalive when the page is leaving", async () => {
        const project = canvasProject("canvas-keepalive", "离开前保存");
        useUserStore.getState().setUser(user("user-a"));
        mocks.getCanvasProject.mockResolvedValue(project);
        mocks.saveCanvasProjectMutation.mockResolvedValue({ projectId: project.id, updatedAt: "2026-08-05T12:00:02.000Z", mutationId: "mutation-keepalive" });
        await useCanvasStore.getState().loadProject(project.id);

        useCanvasStore.getState().updateProject(project.id, { showImageInfo: true });
        await useCanvasStore.getState().flushProjectSave(project.id, true);

        expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledWith(project.id, expect.objectContaining({ showImageInfo: true }), { keepalive: true });
        expect(useCanvasStore.getState().saveStateByProject[project.id]).toEqual({ status: "saved" });
    });

    it("serializes a second Canvas edit against the acknowledged revision", async () => {
        const project = canvasProject("canvas-serialized", "串行保存");
        const first = deferred<{ projectId: string; updatedAt: string; mutationId: string }>();
        useUserStore.getState().setUser(user("user-a"));
        mocks.getCanvasProject.mockResolvedValue(project);
        mocks.saveCanvasProjectMutation.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ projectId: project.id, updatedAt: "2026-08-05T12:00:03.000Z", mutationId: "mutation-second" });
        await useCanvasStore.getState().loadProject(project.id);

        vi.useFakeTimers();
        try {
            useCanvasStore.getState().updateProject(project.id, { backgroundMode: "dots" });
            await vi.advanceTimersByTimeAsync(250);
            useCanvasStore.getState().updateProject(project.id, { backgroundMode: "blank" });
            const pending = useCanvasStore.getState().flushProjectSave(project.id);
            expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledTimes(1);

            first.resolve({ projectId: project.id, updatedAt: "2026-08-05T12:00:02.500Z", mutationId: "mutation-first" });
            await pending;
            expect(mocks.saveCanvasProjectMutation).toHaveBeenCalledTimes(2);
            expect(mocks.saveCanvasProjectMutation).toHaveBeenLastCalledWith(project.id, expect.objectContaining({ baseUpdatedAt: "2026-08-05T12:00:02.500Z", backgroundMode: "blank" }));
        } finally {
            vi.useRealTimers();
        }
    });

    it("reloads Drama projects for the new user after a reset", async () => {
        const oldRequest = deferred<{ projects: DramaProjectSummary[]; total: number; page: number; pageSize: number }>();
        const freshProjects = [summarizeDramaProject(dramaProject("drama-b", "用户 B 短剧"))];
        mocks.listDramaProjectSummaries.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce({ projects: freshProjects, total: 1, page: 1, pageSize: 12 });

        useUserStore.getState().setUser(user("user-a"));
        const oldHydrate = useDramaStore.getState().hydrate();
        useDramaStore.getState().reset();
        useUserStore.getState().setUser(user("user-b"));
        const freshHydrate = useDramaStore.getState().hydrate();

        oldRequest.resolve({ projects: [summarizeDramaProject(dramaProject("drama-a", "用户 A 短剧"))], total: 1, page: 1, pageSize: 12 });
        await Promise.all([oldHydrate, freshHydrate]);

        expect(mocks.listDramaProjectSummaries).toHaveBeenCalledTimes(2);
        expect(useDramaStore.getState().summaries).toEqual(freshProjects);
        expect(useDramaStore.getState().summaryTotal).toBe(1);
    });

    it("appends the next Drama summary page without reloading project details", async () => {
        const first = summarizeDramaProject(dramaProject("drama-a", "短剧一"));
        const second = summarizeDramaProject(dramaProject("drama-b", "短剧二"));
        mocks.listDramaProjectSummaries.mockResolvedValueOnce({ projects: [first], total: 2, page: 1, pageSize: 1 }).mockResolvedValueOnce({ projects: [second], total: 2, page: 2, pageSize: 1 });
        useUserStore.getState().setUser(user("user-a"));

        await useDramaStore.getState().hydrate();
        await useDramaStore.getState().loadMore();

        expect(mocks.listDramaProjectSummaries).toHaveBeenNthCalledWith(1, { page: 1, pageSize: 12 });
        expect(mocks.listDramaProjectSummaries).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 1 });
        expect(useDramaStore.getState()).toMatchObject({ summaries: [first, second], summaryTotal: 2, summaryPage: 2, summaryLoadingMore: false });
        expect(mocks.getDramaProject).not.toHaveBeenCalled();
    });

    it("loads only the requested Drama project and ignores a previous user's late response", async () => {
        const oldRequest = deferred<DramaProject>();
        const freshProject = dramaProject("drama-shared", "用户 B 短剧");
        mocks.getDramaProject.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(freshProject);

        useUserStore.getState().setUser(user("user-a"));
        const oldLoad = useDramaStore.getState().loadProject("drama-shared");
        useDramaStore.getState().reset();
        useUserStore.getState().setUser(user("user-b"));
        const freshLoad = useDramaStore.getState().loadProject("drama-shared");

        oldRequest.resolve(dramaProject("drama-shared", "用户 A 短剧"));
        await Promise.allSettled([oldLoad, freshLoad]);

        expect(mocks.getDramaProject).toHaveBeenCalledTimes(2);
        expect(useDramaStore.getState().projects).toEqual([freshProject]);
        expect(useDramaStore.getState().summaries).toEqual([summarizeDramaProject(freshProject)]);
    });

    it("keeps stable character and scene ids when applying Drama analysis", () => {
        useUserStore.getState().setUser(user("user-a"));
        const project = dramaProject("drama-a", "用户 A 短剧");
        project.characters = [
            { id: "character-hero", name: "女主", description: "人工设定" },
            { id: "character-support", name: "店员", description: "保留角色" },
        ];
        project.scenes = [
            { id: "scene-home", name: "客厅", description: "人工场景" },
            { id: "scene-street", name: "街道", description: "保留场景" },
        ];
        useDramaStore.setState({ projects: [project], hydrated: true, hydratedUserId: "user-a" });

        useDramaStore.getState().applyContentAnalysis("drama-a", "drama-a-episode-1", {
            episode: { outline: "对峙", hook: "危机", nextPreview: "追击", sourceRange: "第一章" },
            characters: [
                { name: " 女主 ", description: "分析更新" },
                { name: "反派", description: "新增角色" },
            ],
            scenes: [
                { name: "客厅", description: "分析场景" },
                { name: "天台", description: "新增场景" },
            ],
            props: [],
            clues: [],
            shots: [
                {
                    title: "对峙",
                    description: "双方相遇",
                    sourceText: "双方在天台相遇",
                    shotBoundary: "场景节拍",
                    dialogue: "开始吧",
                    narration: "",
                    utterances: [],
                    duration: 5,
                    characterNames: ["女主", "反派"],
                    sceneName: "天台",
                    propNames: [],
                    clueNames: [],
                },
            ],
        });

        const updated = useDramaStore.getState().projects[0];
        expect(updated.characters).toEqual(
            expect.arrayContaining([
                { id: "character-hero", name: " 女主 ", description: "分析更新" },
                { id: "character-support", name: "店员", description: "保留角色" },
            ]),
        );
        expect(updated.scenes).toEqual(
            expect.arrayContaining([
                { id: "scene-home", name: "客厅", description: "分析场景" },
                { id: "scene-street", name: "街道", description: "保留场景" },
            ]),
        );
        const newCharacter = updated.characters.find((item) => item.name === "反派");
        const newScene = updated.scenes.find((item) => item.name === "天台");
        expect(newCharacter?.id).toMatch(/^character-/);
        expect(newScene?.id).toMatch(/^scene-/);
        expect(updated.episodes[0].shots[0]).toMatchObject({ characterIds: ["character-hero", newCharacter?.id], sceneId: newScene?.id });
    });

    it("does not reset queued or running Drama shot tasks", () => {
        useUserStore.getState().setUser(user("user-a"));
        const project = dramaProject("drama-a", "用户 A 短剧");
        project.episodes[0].reviewStatus = "visual_ready";
        const runningShot = {
            ...dramaShot("shot-running"),
            storyboardStatus: "running" as const,
            storyboardTaskId: "image-task-running",
        };
        const idleShot = dramaShot("shot-idle");
        project.episodes[0].shots = [runningShot, idleShot];
        useDramaStore.setState({ projects: [project], hydrated: true, hydratedUserId: "user-a" });

        useDramaStore.getState().queueShots("drama-a", "drama-a-episode-1", [runningShot.id, idleShot.id]);

        const shots = useDramaStore.getState().projects[0].episodes[0].shots;
        expect(shots[0]).toEqual(runningShot);
        expect(shots[1]).toMatchObject({ id: "shot-idle", storyboardStatus: "queued", storyboardAttempt: 1, generationStatus: "idle", audioStatus: "idle" });
    });

    it("replaces imported Drama episodes only after the server save succeeds", async () => {
        useUserStore.getState().setUser(user("user-a"));
        const project = dramaProject("drama-a", "用户 A 短剧");
        const pendingSave = deferred<DramaProject>();
        mocks.saveDramaProject.mockReturnValueOnce(pendingSave.promise);
        useDramaStore.setState({ projects: [project], hydrated: true, hydratedUserId: "user-a" });

        const importing = useDramaStore.getState().importEpisodes(project.id, [
            { title: "第一章", script: "第一集正文", sourceRange: "第一章" },
            { title: "第二章", script: "第二集正文", sourceRange: "第二章" },
        ]);
        await Promise.resolve();

        expect(useDramaStore.getState().projects[0].episodes).toHaveLength(1);
        expect(mocks.saveDramaProject).toHaveBeenCalledWith(expect.objectContaining({ id: project.id, episodes: [expect.objectContaining({ script: "第一集正文" }), expect.objectContaining({ script: "第二集正文" })] }));
        const saved = mocks.saveDramaProject.mock.calls[0][0] as DramaProject;
        pendingSave.resolve(saved);
        await importing;

        expect(useDramaStore.getState().projects[0].episodes).toHaveLength(2);
        expect(useDramaStore.getState().saveStateByProject[project.id]).toEqual({ status: "saved", savedAt: saved.updatedAt });
    });

    it("waits for an in-flight save before restoring a Drama version", async () => {
        vi.useFakeTimers();
        try {
            useUserStore.getState().setUser(user("user-a"));
            const project = dramaProject("drama-a", "当前版本");
            const pendingSave = deferred<DramaProject>();
            const restored = { ...project, title: "历史版本", updatedAt: new Date(Date.now() + 1000).toISOString() };
            mocks.saveDramaProject.mockReturnValueOnce(pendingSave.promise);
            mocks.restoreDramaProjectVersion.mockResolvedValueOnce(restored);
            useDramaStore.setState({ projects: [project], hydrated: true, hydratedUserId: "user-a" });

            useDramaStore.getState().updateProject(project.id, { title: "待保存版本" });
            await vi.advanceTimersByTimeAsync(250);
            const restoring = useDramaStore.getState().restoreVersion(project.id, "version-1");

            expect(mocks.restoreDramaProjectVersion).not.toHaveBeenCalled();
            pendingSave.resolve({ ...project, title: "待保存版本" });
            await restoring;

            expect(mocks.restoreDramaProjectVersion).toHaveBeenCalledWith(project.id, "version-1");
            expect(useDramaStore.getState().projects[0].title).toBe("历史版本");
        } finally {
            vi.useRealTimers();
        }
    });

    it("flushes critical Drama task state without waiting for the debounce timer", async () => {
        vi.useFakeTimers();
        try {
            useUserStore.getState().setUser(user("user-a"));
            const project = dramaProject("drama-a", "用户 A 短剧");
            mocks.saveDramaProject.mockImplementationOnce(async (value: DramaProject) => value);
            useDramaStore.setState({ projects: [project], hydrated: true, hydratedUserId: "user-a" });

            useDramaStore.getState().updateEpisode(project.id, project.episodes[0].id, { contentTaskId: "text-task-one" });
            await useDramaStore.getState().saveProjectNow(project.id);

            expect(mocks.saveDramaProject).toHaveBeenCalledOnce();
            expect(mocks.saveDramaProject).toHaveBeenCalledWith(expect.objectContaining({ episodes: [expect.objectContaining({ contentTaskId: "text-task-one" })] }));
            await vi.runAllTimersAsync();
            expect(mocks.saveDramaProject).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

function user(id: string) {
    return {
        id,
        accountId: id === "user-a" ? "0001" : "0002",
        username: id,
        email: `${id}@example.test`,
        displayName: id,
        bio: "",
        role: "user" as const,
        adminPermissions: [],
        status: "active" as const,
        planId: "free",
        planName: "免费",
        hasActivePlan: false,
        pointsBalance: 0,
        mfaEnabled: false,
    };
}

function textAsset(id: string, title: string): Asset {
    const now = new Date().toISOString();
    return { id, kind: "text", title, coverUrl: "", tags: [], data: { content: title }, createdAt: now, updatedAt: now };
}

function canvasProject(id: string, title: string): CanvasProject {
    const now = new Date().toISOString();
    return {
        id,
        title,
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        createdAt: now,
        updatedAt: now,
    };
}

function dramaProject(id: string, title: string): DramaProject {
    const now = new Date().toISOString();
    return {
        id,
        title,
        summary: "",
        style: "电影感",
        ratio: "9:16",
        status: "active",
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        defaultVideoMode: "storyboard",
        episodes: [{ id: `${id}-episode-1`, title: "第 1 集", script: "", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft", shots: [] }],
        activeEpisodeId: `${id}-episode-1`,
        createdAt: now,
        updatedAt: now,
    };
}

function dramaShot(id: string) {
    return {
        id,
        order: 1,
        title: "镜头",
        description: "描述",
        sourceText: "描述",
        shotBoundary: "段落边界",
        dialogue: "",
        narration: "",
        utterances: [],
        imagePrompt: "画面",
        videoPrompt: "动作",
        cameraMotion: "推进",
        duration: 5,
        characterIds: [],
        propIds: [],
        clueIds: [],
        storyboardStatus: "idle" as const,
        generationStatus: "idle" as const,
        audioStatus: "idle" as const,
    };
}
