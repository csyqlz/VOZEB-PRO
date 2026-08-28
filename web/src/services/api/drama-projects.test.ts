import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDramaVisualResult, DramaVisualResultError, listDramaProjectSummaries } from "./drama-projects";

describe("drama project api", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("requests a bounded summary page", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { projects: [], total: 24, page: 2, pageSize: 12 }, msg: "OK" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(listDramaProjectSummaries({ page: 2, pageSize: 12 })).resolves.toMatchObject({ total: 24, page: 2, pageSize: 12 });
        expect(fetchMock).toHaveBeenCalledWith("/api/drama/projects?page=2&pageSize=12", { cache: "no-store" });
    });

    it("keeps visual persistence conflicts distinct from network failures", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 409, data: null, msg: "视觉任务已被更新，请刷新后重试" }, { status: 409 })));

        const error = await applyDramaVisualResult("project-one", "episode-one", "task-one", { shots: [] }).catch((reason) => reason);

        expect(error).toBeInstanceOf(DramaVisualResultError);
        expect(error).toMatchObject({ status: 409, message: "视觉任务已被更新，请刷新后重试" });
    });
});
