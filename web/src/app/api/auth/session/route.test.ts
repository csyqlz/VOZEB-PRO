import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAuthSettings: vi.fn(),
    getCurrentUser: vi.fn(),
    getInstallStatus: vi.fn(),
    serializeCurrentUser: vi.fn(),
    serializePublicSettings: vi.fn(),
    serializePublicSiteSettings: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({
    DEFAULT_SITE_SETTINGS: { title: "VOZEB PRO", logoUrl: "/logo.svg" },
    getAuthSettings: mocks.getAuthSettings,
}));

vi.mock("@/lib/auth/session", () => ({
    getCurrentUser: mocks.getCurrentUser,
    serializeCurrentUser: mocks.serializeCurrentUser,
    serializePublicSettings: mocks.serializePublicSettings,
    serializePublicSiteSettings: mocks.serializePublicSiteSettings,
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
            settings: { site: { title: "VOZEB PRO" } },
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
        mocks.serializePublicSettings.mockReturnValue({ site: { title: "站点" }, logicalModels: [{ id: "image-main", name: "图片模型", capability: "image" }] });

        const response = await GET();

        await expect(response.json()).resolves.toMatchObject({ user, settings: { site: { title: "站点" }, logicalModels: [{ id: "image-main" }] }, install: { ready: true, database: { healthy: true } } });
        expect(mocks.getInstallStatus).not.toHaveBeenCalled();
        expect(mocks.getAuthSettings).toHaveBeenCalledTimes(1);
    });

    it("checks installation before loading settings for an anonymous installed session", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        mocks.getInstallStatus.mockResolvedValue({ ready: true, firstAdminRequired: false, database: { configured: true, healthy: true, schemaReady: true } });
        mocks.getAuthSettings.mockResolvedValue({
            site: { title: "站点" },
            systemChannels: [{ id: "secret-channel", baseUrl: "https://provider.internal/v1", apiKey: "secret-key", models: ["private-model"] }],
            logicalModels: [{ id: "private-logical-model", capability: "image", bindings: [] }],
        });
        mocks.serializePublicSiteSettings.mockReturnValue({ title: "站点" });

        const response = await GET();
        const payload = await response.json();

        expect(payload).toMatchObject({ user: null, settings: { site: { title: "站点" } }, install: { ready: true } });
        expect(mocks.getInstallStatus).toHaveBeenCalledTimes(1);
        expect(mocks.getAuthSettings).toHaveBeenCalledTimes(1);
        expect(mocks.serializePublicSettings).not.toHaveBeenCalled();
        expect(JSON.stringify(payload)).not.toMatch(/secret-channel|provider\.internal|secret-key|private-model/);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
});
