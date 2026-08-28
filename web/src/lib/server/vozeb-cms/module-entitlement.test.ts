import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ states: vi.fn(), authSettings: vi.fn(), users: vi.fn() }));

vi.mock("@/lib/server/vozeb-cms/module-state-store", () => ({ listVozebCmsModuleStates: mocks.states }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.authSettings, getPublicUsersByIds: mocks.users }));

import { VozebCmsModuleAccessError, assertVozebCmsUserCapability } from "./module-service";

describe("VOZEBCMS package capability mapping", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.states.mockResolvedValue([]);
        mocks.authSettings.mockResolvedValue({ entitlements: { enabled: true, plans: [{ id: "free", enabled: true, features: ["canvas"] }] } });
        mocks.users.mockResolvedValue([{ id: "user-one", role: "user", planId: "free" }]);
    });

    it("allows a capability declared by the user's active plan", async () => {
        await expect(assertVozebCmsUserCapability("user-one", "canvas.project.manage")).resolves.toMatchObject({ feature: "canvas" });
    });

    it("rejects a capability missing from the user's active plan and bypasses admins", async () => {
        await expect(assertVozebCmsUserCapability("user-one", "video.generate")).rejects.toEqual(expect.objectContaining<Partial<VozebCmsModuleAccessError>>({ status: 403 }));
        mocks.users.mockResolvedValue([{ id: "admin-one", role: "admin", planId: "free" }]);
        await expect(assertVozebCmsUserCapability("admin-one", "video.generate")).resolves.toMatchObject({ feature: "video-generate" });
    });
});
