import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getRegistration: vi.fn(),
}));

vi.mock("@/lib/server/local-media-registry", () => ({
    getLocalMediaRegistration: mocks.getRegistration,
    isLocalMediaRegistrationExpired: (registration: { storageClass: string; expiresAt?: string }) => registration.storageClass === "temporary" && Boolean(registration.expiresAt) && Date.parse(registration.expiresAt || "") <= Date.now(),
}));

import { requireManagedMediaInputOwner } from "./managed-media-input-access";

describe("managed media input access", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getRegistration.mockResolvedValue({ scope: "reference", storageClass: "permanent", ownerUserId: "user-one" });
    });

    it("returns the registered owner for an owned asset", async () => {
        await expect(requireManagedMediaInputOwner("/api/reference-assets/permanent/2026/08/22/images/source.png", { id: "user-one", role: "user" }, "reference")).resolves.toBe("user-one");
        expect(mocks.getRegistration).toHaveBeenCalledWith("permanent/2026/08/22/images/source.png");
    });

    it("rejects another user's asset", async () => {
        await expect(requireManagedMediaInputOwner("/api/reference-assets/permanent/2026/08/22/images/source.png", { id: "user-two", role: "user" }, "reference")).rejects.toThrow("参考素材不存在或无权访问");
    });

    it("rejects expired and mismatched registrations", async () => {
        mocks.getRegistration.mockResolvedValueOnce({ scope: "reference", storageClass: "temporary", expiresAt: new Date(Date.now() - 1).toISOString(), ownerUserId: "user-one" });
        await expect(requireManagedMediaInputOwner("/api/reference-assets/temporary/source.png", { id: "user-one", role: "user" }, "reference")).rejects.toThrow("参考素材不存在或无权访问");

        mocks.getRegistration.mockResolvedValueOnce({ scope: "generation", storageClass: "permanent", ownerUserId: "user-one" });
        await expect(requireManagedMediaInputOwner("/api/reference-assets/permanent/source.png", { id: "user-one", role: "user" }, "reference")).rejects.toThrow("参考素材不存在或无权访问");
    });

    it("lets an admin sign with the asset's real owner identity", async () => {
        await expect(requireManagedMediaInputOwner("/api/reference-assets/permanent/source.png", { id: "admin-one", role: "admin" }, "reference")).resolves.toBe("user-one");
    });
});
