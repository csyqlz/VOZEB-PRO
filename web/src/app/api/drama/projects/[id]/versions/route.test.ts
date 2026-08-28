import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), createVersion: vi.fn(), listVersions: vi.fn(), requireCapability: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
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
    createDramaProjectVersionForUser: mocks.createVersion,
    listDramaProjectVersionsForUser: mocks.listVersions,
}));

import { GET, POST } from "./route";

describe("Drama project versions route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.listVersions.mockResolvedValue([]);
        mocks.createVersion.mockResolvedValue({ id: "version-one", version: 1 });
    });

    it("blocks version history when the Drama module is disabled", async () => {
        mocks.requireCapability.mockResolvedValue(new Response(null, { status: 403 }));

        const response = await GET(new Request("http://localhost/api/drama/projects/drama-one/versions"), context());

        expect(response.status).toBe(403);
        expect(mocks.requireCapability).toHaveBeenCalledWith("drama.project.manage", "user-one");
        expect(mocks.listVersions).not.toHaveBeenCalled();
    });

    it("blocks new versions when the Drama module is disabled", async () => {
        mocks.requireCapability.mockResolvedValue(new Response(null, { status: 403 }));

        const response = await POST(
            new Request("http://localhost/api/drama/projects/drama-one/versions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: "manual" }),
            }),
            context(),
        );

        expect(response.status).toBe(403);
        expect(mocks.createVersion).not.toHaveBeenCalled();
    });
});

function context() {
    return { params: Promise.resolve({ id: "drama-one" }) };
}
