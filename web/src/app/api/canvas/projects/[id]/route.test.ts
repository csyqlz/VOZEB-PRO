import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), getProject: vi.fn(), updateProject: vi.fn() }));

vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: vi.fn(async () => null) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/canvas-project-service", () => ({
    canvasProjectError: vi.fn(),
    getCanvasProjectForUser: mocks.getProject,
    updateCanvasProjectForUser: mocks.updateProject,
}));

import { GET, PATCH } from "./route";

describe("canvas project detail route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.getProject.mockResolvedValue({ id: "canvas-one", nodes: [], connections: [] });
    });

    it("loads one owned project detail", async () => {
        const response = await GET(new Request("http://localhost/api/canvas/projects/canvas-one"), { params: Promise.resolve({ id: "canvas-one" }) });

        expect(mocks.getProject).toHaveBeenCalledWith("user-one", "canvas-one");
        expect(await response.json()).toEqual({ code: 0, data: { project: { id: "canvas-one", nodes: [], connections: [] } }, msg: "OK" });
    });

    it("passes the project and expected version to the service", async () => {
        const body = { project: { id: "canvas-one", title: "新标题" }, expectedUpdatedAt: "2026-08-01T00:00:00.000Z" };
        mocks.updateProject.mockResolvedValue({ ...body.project, updatedAt: "2026-08-01T00:00:01.000Z" });

        const response = await PATCH(new Request("http://localhost/api/canvas/projects/canvas-one", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "canvas-one" }) });

        expect(mocks.updateProject).toHaveBeenCalledWith("user-one", "canvas-one", body);
        expect(response.status).toBe(200);
    });

    it("returns a compact acknowledgement for a mutation batch", async () => {
        const mutation = { mutationId: "mutation-one", baseUpdatedAt: "2026-08-01T00:00:00.000Z", title: "增量标题" };
        mocks.updateProject.mockResolvedValue({ projectId: "canvas-one", updatedAt: "2026-08-01T00:00:00.001Z", mutationId: mutation.mutationId });

        const response = await PATCH(new Request("http://localhost/api/canvas/projects/canvas-one", { method: "PATCH", body: JSON.stringify({ mutation }) }), { params: Promise.resolve({ id: "canvas-one" }) });

        expect(mocks.updateProject).toHaveBeenCalledWith("user-one", "canvas-one", { mutation });
        expect(await response.json()).toEqual({ code: 0, data: { ack: { projectId: "canvas-one", updatedAt: "2026-08-01T00:00:00.001Z", mutationId: "mutation-one" } }, msg: "画布项目已保存" });
    });
});
