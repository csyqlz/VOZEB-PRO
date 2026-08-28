import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capability: vi.fn() }));

vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.capability }));

import { requireGenerationResourceAccess } from "./generation-resource-access";

describe("generation resource access", () => {
    beforeEach(() => mocks.capability.mockReset().mockResolvedValue(null));

    it("allows the owner only after the matching capability gate", async () => {
        await expect(requireGenerationResourceAccess({ actor: { id: "user-one", role: "user" }, ownerUserId: "user-one", capabilityId: "image.generate", adminPermission: "generation.read", notFoundMessage: "任务不存在" })).resolves.toBeNull();
        expect(mocks.capability).toHaveBeenCalledWith("image.generate", "user-one");
    });

    it("returns the module or entitlement denial before exposing a resource", async () => {
        const blocked = new Response(null, { status: 403 });
        mocks.capability.mockResolvedValue(blocked);

        await expect(requireGenerationResourceAccess({ actor: { id: "user-one", role: "user" }, ownerUserId: "user-one", capabilityId: "video.generate", adminPermission: "generation.read", notFoundMessage: "任务不存在" })).resolves.toBe(blocked);
    });

    it("hides another user's resource from a normal user", async () => {
        const response = await requireGenerationResourceAccess({ actor: { id: "user-two", role: "user" }, ownerUserId: "user-one", capabilityId: "agent.run", adminPermission: "generation.read", notFoundMessage: "Agent 任务不存在" });

        expect(response?.status).toBe(404);
    });

    it("requires the exact administrator duty for cross-user reads and mutations", async () => {
        const actor = { id: "admin-one", role: "admin", status: "active", adminPermissions: ["generation.read"] };

        await expect(requireGenerationResourceAccess({ actor, ownerUserId: "user-one", capabilityId: "image.generate", adminPermission: "generation.read", notFoundMessage: "任务不存在" })).resolves.toBeNull();
        const denied = await requireGenerationResourceAccess({ actor, ownerUserId: "user-one", capabilityId: "image.generate", adminPermission: "generation.manage", notFoundMessage: "任务不存在" });
        expect(denied?.status).toBe(403);
    });
});
