import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), requireCapability: vi.fn(), build: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/server/vozeb-cms/layout-builder-service", () => ({
    VozebCmsLayoutBuilderError: class VozebCmsLayoutBuilderError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    buildVozebCmsLayoutForUser: mocks.build,
}));

import { POST } from "./route";
import { VozebCmsLayoutBuilderError } from "@/lib/server/vozeb-cms/layout-builder-service";

describe("VOZEBCMS AI layout builder route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.build.mockResolvedValue({ id: "layout-one", status: "draft" });
    });

    it("requires authentication and the layout capability", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        expect((await POST(request({ requestId: "request-one", brief: "做一个创作页" }))).status).toBe(401);

        mocks.getCurrentUser.mockResolvedValue({ id: "user-one", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.requireCapability.mockResolvedValue(new Response(null, { status: 403 }));
        expect((await POST(request({ requestId: "request-one", brief: "做一个创作页" }))).status).toBe(403);
        expect(mocks.build).not.toHaveBeenCalled();
    });

    it("passes the request to the scoped builder and preserves builder errors", async () => {
        const response = await POST(request({ requestId: "request-one", brief: "做一个创作页", moduleId: "create" }));
        expect(response.status).toBe(201);
        expect(mocks.build).toHaveBeenCalledWith("user-one", { requestId: "request-one", brief: "做一个创作页", moduleId: "create" }, expect.objectContaining({ origin: expect.any(String), cookie: "" }));

        mocks.build.mockRejectedValueOnce(new VozebCmsLayoutBuilderError("页面模块未注册", 400));
        expect((await POST(request({ requestId: "request-two", brief: "做一个页面" }))).status).toBe(400);
    });
});

function request(body: unknown) {
    return new Request("http://localhost/api/vozeb-cms/layouts/ai-build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
