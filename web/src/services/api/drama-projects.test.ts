import { afterEach, describe, expect, it, vi } from "vitest";

import { createDramaProjectVersion, deleteDramaProjectVersion, listDramaProjectSummaries } from "./drama-projects";
import type { DramaProject } from "@/lib/drama-project-contract";

describe("drama project api", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("requests a bounded summary page", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { projects: [], total: 24, page: 2, pageSize: 12 }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(listDramaProjectSummaries({ page: 2, pageSize: 12 })).resolves.toMatchObject({ total: 24, page: 2, pageSize: 12 });
        expect(fetchMock).toHaveBeenCalledWith("/api/drama/projects?page=2&pageSize=12", { cache: "no-store" });
    });

    it("deletes an encoded project version", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { deleted: true }, msg: "短剧版本已删除" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(deleteDramaProjectVersion("drama/one", "version one")).resolves.toEqual({ deleted: true });
        expect(fetchMock).toHaveBeenCalledWith("/api/drama/projects/drama%2Fone/versions/version%20one", { method: "DELETE", cache: "no-store" });
    });

    it("sends only the selected episodes for an automatic version", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { version: { id: "version-one" } }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);
        const episodes = Array.from({ length: 288 }, (_, index) => ({ id: `episode-${index + 1}`, script: `第 ${index + 1} 集剧本`.repeat(1_000) }));
        const project = { id: "drama-one", episodes } as DramaProject;

        await createDramaProjectVersion(project, "视觉方案生成前", { episodeIds: ["episode-2"] });

        const rawBody = fetchMock.mock.calls[0]?.[1]?.body as string;
        const body = JSON.parse(rawBody) as { snapshot: DramaProject; scope: { episodeIds: string[] } };
        expect(body.scope.episodeIds).toEqual(["episode-2"]);
        expect(body.snapshot.episodes.map((episode) => episode.id)).toEqual(["episode-2"]);
        expect(rawBody.length).toBeLessThan(JSON.stringify({ snapshot: project }).length / 100);
    });
});
