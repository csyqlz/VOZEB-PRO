import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAuthSettings: vi.fn(),
    getCurrentUser: vi.fn(),
    getInstallStatus: vi.fn(),
    serializeCurrentUser: vi.fn(),
    serializePublicSettings: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({
    DEFAULT_SITE_SETTINGS: { title: "星启智域", logoUrl: "/logo.svg" },
    getAuthSettings: mocks.getAuthSettings,
}));

vi.mock("@/lib/auth/session", () => ({
    getCurrentUser: mocks.getCurrentUser,
    serializeCurrentUser: mocks.serializeCurrentUser,
    serializePublicSettings: mocks.serializePublicSettings,
}));

vi.mock("@/lib/server/install-status", () => ({
    getInstallStatus: mocks.getInstallStatus,
}));

import { GET } from "./route";

describe("public session route before installation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getInstallStatus.mockResolvedValue({
            ready: false,
            firstAdminRequired: false,
            database: { configured: true, healthy: true, schemaReady: false },
        });
    });

    it("returns installation defaults without reading missing business tables", async () => {
        const response = await GET();

        await expect(response.json()).resolves.toMatchObject({
            user: null,
            settings: { site: { title: "星启智域" } },
            install: { database: { healthy: true, schemaReady: false } },
        });
        expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);
        expect(mocks.getAuthSettings).not.toHaveBeenCalled();
    });

    it("skips installation status for an authenticated user", async () => {
        const user = { id: "user-one", role: "user" };
        mocks.getCurrentUser.mockResolvedValue(user);
        mocks.getAuthSettings.mockResolvedValue({ site: { title: "站点" } });
        mocks.serializeCurrentUser.mockReturnValue(user);
        mocks.serializePublicSettings.mockReturnValue({ site: { title: "站点" } });

        const response = await GET();

        await expect(response.json()).resolves.toMatchObject({ user, settings: { site: { title: "站点" } }, install: { ready: true, database: { healthy: true } } });
        expect(mocks.getInstallStatus).not.toHaveBeenCalled();
        expect(mocks.getAuthSettings).toHaveBeenCalledTimes(1);
    });

    it("checks installation before loading settings for an anonymous installed session", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        mocks.getInstallStatus.mockResolvedValue({ ready: true, firstAdminRequired: false, database: { configured: true, healthy: true, schemaReady: true } });
        mocks.getAuthSettings.mockResolvedValue({ site: { title: "站点" } });
        mocks.serializePublicSettings.mockReturnValue({ site: { title: "站点" } });

        const response = await GET();

        await expect(response.json()).resolves.toMatchObject({ user: null, settings: { site: { title: "站点" } }, install: { ready: true } });
        expect(mocks.getInstallStatus).toHaveBeenCalledTimes(1);
        expect(mocks.getAuthSettings).toHaveBeenCalledTimes(1);
    });
});
