import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    publish: vi.fn(),
    rollback: vi.fn(),
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
    VozebCmsModuleAccessError: class VozebCmsModuleAccessError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    publishVozebCmsLayoutForUser: mocks.publish,
    rollbackVozebCmsLayoutForUser: mocks.rollback,
}));
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

import { POST } from "./route";
import { VozebCmsLayoutStoreError } from "@/lib/server/vozeb-cms/layout-service";

describe("VOZEBCMS layout actions route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        mocks.publish.mockResolvedValue({ id: "layout-one", status: "published" });
        mocks.rollback.mockResolvedValue({ id: "layout-one", status: "draft" });
    });

    it("publishes and rolls back with the scoped user and layout id", async () => {
        const publish = await POST(new Request("http://localhost/api/vozeb-cms/layouts/layout-one/publish", { method: "POST", body: JSON.stringify({ baseRevision: 2 }) }), context("publish"));
        const rollback = await POST(new Request("http://localhost/api/vozeb-cms/layouts/layout-one/rollback", { method: "POST", body: JSON.stringify({ baseRevision: 2, targetRevision: 1 }) }), context("rollback"));

        expect(publish.status).toBe(200);
        expect(rollback.status).toBe(200);
        expect(mocks.publish).toHaveBeenCalledWith("user-one", "layout-one", { baseRevision: 2 });
        expect(mocks.rollback).toHaveBeenCalledWith("user-one", "layout-one", { baseRevision: 2, targetRevision: 1 });
    });

    it("preserves revision conflicts from the service", async () => {
        mocks.publish.mockRejectedValueOnce(new VozebCmsLayoutStoreError("页面已被其他请求更新，请刷新后重试", 409));

        const response = await POST(new Request("http://localhost/api/vozeb-cms/layouts/layout-one/publish", { method: "POST", body: JSON.stringify({ baseRevision: 1 }) }), context("publish"));

        expect(response.status).toBe(409);
    });
});

function context(action: string) {
    return { params: Promise.resolve({ id: "layout-one", action }) };
}
