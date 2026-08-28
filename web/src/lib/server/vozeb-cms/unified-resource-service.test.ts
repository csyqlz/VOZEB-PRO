import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    creative: vi.fn(),
    library: vi.fn(),
    canvas: vi.fn(),
    drama: vi.fn(),
    runIds: vi.fn(),
}));

vi.mock("@/lib/server/creative-runtime-store", () => ({ listCreativeAssetsForProject: mocks.creative }));
vi.mock("./unified-asset-source-store", () => ({
    listLibraryAssetSources: mocks.library,
    listCanvasAssetSources: mocks.canvas,
    listDramaAssetSources: mocks.drama,
    listGenerationTaskRunIds: mocks.runIds,
}));

import { listVozebCmsAssets } from "./unified-resource-service";

describe("VOZEBCMS unified asset projection", () => {
    beforeEach(() => {
        mocks.creative.mockReset().mockResolvedValue([]);
        mocks.library.mockReset().mockResolvedValue([]);
        mocks.canvas.mockReset().mockResolvedValue({ nodes: [] });
        mocks.drama.mockReset().mockResolvedValue({ named: [], sources: [], media: [] });
        mocks.runIds.mockReset().mockResolvedValue({});
    });

    it("projects creative assets by stable source", async () => {
        mocks.creative.mockResolvedValue([
            {
                id: "asset-one",
                userId: "user-one",
                type: "image",
                status: "ready",
                title: "场景",
                serverUrl: "/media/scene.webp",
                metadata: { source: "generation" },
                createdAt: Date.parse("2026-08-26T00:00:00.000Z"),
            },
        ]);
        await expect(listVozebCmsAssets("user-one", { projectId: "project-one" })).resolves.toEqual([expect.objectContaining({ id: "creative:asset-one", owner: "user-one", source: "generation", project_id: "project-one", url: "/media/scene.webp" })]);
    });

    it("keeps the resolved project type on asset projections", async () => {
        const projectRef = { id: "drama-one", type: "drama" as const, ownerId: "user-one" };
        mocks.creative.mockResolvedValue([{ id: "asset-drama", userId: "user-one", type: "video", status: "ready", title: "镜头", metadata: {}, createdAt: Date.now() }]);

        await expect(listVozebCmsAssets("user-one", { projectRef })).resolves.toEqual([expect.objectContaining({ project_ref: { id: "drama-one", type: "drama" } })]);
        expect(mocks.creative).toHaveBeenCalledWith("user-one", "drama-one", 100, "drama");
    });

    it("projects drama media with generation run identity", async () => {
        const projectRef = { id: "drama-one", type: "drama" as const, ownerId: "user-one" };
        mocks.drama.mockResolvedValue({
            named: [],
            sources: [],
            media: [{ userId: "user-one", projectId: "drama-one", kind: "video", episodeId: "episode-one", shotId: "shot-one", url: "/media/shot.mp4", taskId: "task-one", projectUpdatedAt: "2026-08-27T00:00:00.000Z" }],
        });
        mocks.runIds.mockResolvedValue({ "task-one": "run-one" });

        const assets = await listVozebCmsAssets("user-one", { projectRef });

        expect(assets).toEqual([expect.objectContaining({ id: "drama-video:episode-one:shot-one", task_id: "task-one", run_id: "run-one", project_id: "drama-one" })]);
    });

    it("projects canvas nodes without loading unrelated drama sources", async () => {
        mocks.canvas.mockResolvedValue({
            nodes: [{ userId: "user-one", projectId: "canvas-one", projectUpdatedAt: "2026-08-27T00:00:00.000Z", node: { id: "node-one", type: "image", title: "分镜", metadata: { serverUrl: "/media/node.webp", agentTaskId: "task-canvas" } } }],
        });

        await expect(listVozebCmsAssets("user-one", { projectRef: { id: "canvas-one", type: "canvas", ownerId: "user-one" } })).resolves.toEqual([
            expect.objectContaining({ id: "canvas-node:canvas-one:node-one", task_id: "task-canvas", source: "canvas", project_id: "canvas-one" }),
        ]);
        expect(mocks.drama).not.toHaveBeenCalled();
    });
});
