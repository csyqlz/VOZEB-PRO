import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    createDramaProjectForUser: vi.fn(),
    listDramaProjectSummariesForUser: vi.fn(),
    requireCapability: vi.fn(),
}));

vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/drama-project-service", () => ({
    DramaProjectServiceError: class DramaProjectServiceError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    createDramaProjectForUser: mocks.createDramaProjectForUser,
    listDramaProjectSummariesForUser: mocks.listDramaProjectSummariesForUser,
}));

import { GET, POST } from "./route";

describe("/api/drama/projects", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.listDramaProjectSummariesForUser.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
        mocks.createDramaProjectForUser.mockResolvedValue({ id: "drama-one", title: "测试短剧" });
    });

    it("requires authentication", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        expect((await GET(new Request("http://localhost/api/drama/projects"))).status).toBe(401);
    });

    it("uses the current user for project creation", async () => {
        const response = await POST(
            new Request("http://localhost/api/drama/projects", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "测试短剧", ratio: "9:16" }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createDramaProjectForUser).toHaveBeenCalledWith("user-one", expect.objectContaining({ title: "测试短剧" }));
    });

    it("returns lightweight summaries for the current user", async () => {
        mocks.listDramaProjectSummariesForUser.mockResolvedValue({ items: [{ id: "drama-one", title: "测试短剧", episodeCount: 2, shotCount: 12 }], total: 13, page: 2, pageSize: 12 });

        const response = await GET(new Request("http://localhost/api/drama/projects?page=2&pageSize=12"));

        expect(response.status).toBe(200);
        expect(mocks.listDramaProjectSummariesForUser).toHaveBeenCalledWith("user-one", { page: 2, pageSize: 12 });
        await expect(response.json()).resolves.toMatchObject({ data: { projects: [{ id: "drama-one", episodeCount: 2, shotCount: 12 }], total: 13, page: 2, pageSize: 12 } });
    });

    it("blocks project reads when the Drama module is disabled", async () => {
        mocks.requireCapability.mockResolvedValue(new Response(JSON.stringify({ code: 403, data: null, msg: "短剧系统模块已停用" }), { status: 403 }));

        const response = await GET(new Request("http://localhost/api/drama/projects"));

        expect(response.status).toBe(403);
        expect(mocks.requireCapability).toHaveBeenCalledWith("drama.project.manage", "user-one", expect.any(Request));
        expect(mocks.listDramaProjectSummariesForUser).not.toHaveBeenCalled();
    });
});
