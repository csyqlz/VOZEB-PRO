import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/vozeb-cms/layout-service", () => ({
    VozebCmsLayoutStoreError: class VozebCmsLayoutStoreError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    createVozebCmsLayoutForUser: mocks.create,
    listVozebCmsLayoutsForUser: mocks.list,
}));
vi.mock("@/lib/server/vozeb-cms/module-service", () => ({ VozebCmsModuleAccessError: class VozebCmsModuleAccessError extends Error {} }));
vi.mock("@/lib/server/vozeb-cms/project-ref-service", () => ({
    VozebCmsProjectRefError: class VozebCmsProjectRefError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
}));

import { GET, POST } from "./route";
import { VozebCmsProjectRefError } from "@/lib/server/vozeb-cms/project-ref-service";

describe("VOZEBCMS layout collection route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.list.mockResolvedValue([]);
        mocks.create.mockResolvedValue({ id: "layout-one", revision: 1 });
    });

    it("requires authentication for layout reads and writes", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const read = await GET(new Request("http://localhost/api/vozeb-cms/layouts"));
        const write = await POST(new Request("http://localhost/api/vozeb-cms/layouts", { method: "POST", body: "{}" }));

        expect(read.status).toBe(401);
        expect(write.status).toBe(401);
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it("passes project filters and ownership identity to the service", async () => {
        const response = await GET(new Request("http://localhost/api/vozeb-cms/layouts?projectId=canvas-one&projectType=canvas&limit=12"));

        expect(response.status).toBe(200);
        expect(mocks.list).toHaveBeenCalledWith("user-one", { projectId: "canvas-one", projectType: "canvas", sitePath: undefined, limit: 12 });
    });

    it("rejects direct requests without the system management duty", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "limited-admin", role: "admin", status: "active", adminPermissions: ["content.manage"] });
        const response = await GET(new Request("http://localhost/api/vozeb-cms/layouts"));
        expect(response.status).toBe(403);
        expect(mocks.list).not.toHaveBeenCalled();
    });

    it("maps unsafe layout and cross-user project errors to client errors", async () => {
        mocks.create.mockRejectedValueOnce(new Error("页面配置包含不安全内容"));
        const unsafe = await POST(new Request("http://localhost/api/vozeb-cms/layouts", { method: "POST", body: JSON.stringify({ nodes: [{ componentId: "module.header" }] }) }));
        expect(unsafe.status).toBe(400);

        mocks.create.mockRejectedValueOnce(new VozebCmsProjectRefError("项目不存在或无权访问", 404));
        const forbiddenProject = await POST(new Request("http://localhost/api/vozeb-cms/layouts", { method: "POST", body: JSON.stringify({ projectRef: { id: "other", type: "canvas" } }) }));
        expect(forbiddenProject.status).toBe(404);
    });
});
