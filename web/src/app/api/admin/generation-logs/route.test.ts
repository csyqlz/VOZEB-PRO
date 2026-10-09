import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPublicUsersByIds: vi.fn(),
    listGenerationLogs: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ getPublicUsersByIds: mocks.getPublicUsersByIds }));
vi.mock("@/lib/server/generation-log-store", () => ({ deleteGenerationLogs: vi.fn(), listGenerationLogs: mocks.listGenerationLogs }));

import { GET } from "./route";

describe("GET /api/admin/generation-logs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["generation.read"] });
        mocks.listGenerationLogs.mockResolvedValue({ items: [{ id: "log-one", userId: "user-one", username: "creator", displayName: "创作者" }], total: 1, page: 1, pageSize: 20 });
        mocks.getPublicUsersByIds.mockResolvedValue([{ id: "user-one", accountId: "0001", username: "creator", displayName: "创作者" }]);
    });

    it("requires an administrator", async () => {
        mocks.getCurrentUser.mockResolvedValueOnce(null);

        expect((await GET(request())).status).toBe(401);
        expect(mocks.listGenerationLogs).not.toHaveBeenCalled();
    });

    it("adds public account ids and preserves the user filter", async () => {
        const response = await GET(request("?userId=user-one&keyword=poster"));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.listGenerationLogs).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", keyword: "poster", includeEcommerceTrace: true }));
        expect(payload.logs[0]).toMatchObject({ userId: "user-one", accountId: "0001" });
    });
});

function request(search = "") {
    return new NextRequest(`http://localhost/api/admin/generation-logs${search}`);
}
