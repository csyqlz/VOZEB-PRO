import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), remove: vi.fn(), requireCapability: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/server/drama-project-service", () => ({
    DramaProjectServiceError: class DramaProjectServiceError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    deleteDramaProjectVersionForUser: mocks.remove,
    restoreDramaProjectVersionForUser: vi.fn(),
}));

import { DELETE } from "./route";

describe("Drama project version deletion route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.remove.mockResolvedValue({ deleted: true });
    });

    it("passes every ownership identity to the scoped service", async () => {
        const response = await DELETE(new Request("http://localhost/api/drama/projects/drama-one/versions/version-one", { method: "DELETE" }), context());

        expect(response.status).toBe(200);
        expect(mocks.remove).toHaveBeenCalledWith("user-one", "drama-one", "version-one");
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { deleted: true } });
    });

    it("requires authentication", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const response = await DELETE(new Request("http://localhost/api/drama/projects/drama-one/versions/version-one", { method: "DELETE" }), context());

        expect(response.status).toBe(401);
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("blocks version mutations when the Drama module is disabled", async () => {
        mocks.requireCapability.mockResolvedValue(new Response(null, { status: 403 }));

        const response = await DELETE(new Request("http://localhost/api/drama/projects/drama-one/versions/version-one", { method: "DELETE" }), context());

        expect(response.status).toBe(403);
        expect(mocks.remove).not.toHaveBeenCalled();
    });
});

function context() {
    return { params: Promise.resolve({ id: "drama-one", versionId: "version-one" }) };
}
