import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireManagedMediaInputOwner: vi.fn(async () => "registered-owner"),
}));

vi.mock("@/lib/server/managed-media-input-access", () => ({ requireManagedMediaInputOwner: mocks.requireManagedMediaInputOwner }));

import { signProviderReference } from "./video-generation-route";

describe("video provider reference signing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY", "test-signing-key");
    });

    afterEach(() => vi.unstubAllEnvs());

    it("validates a managed reference and signs with its registered owner", async () => {
        const source = "/api/reference-assets/permanent/2026/08/22/images/source.png";
        const result = await signProviderReference({ type: "image", role: "reference", url: source }, { id: "user-one", role: "user" }, "https://vozeb.example");

        expect(mocks.requireManagedMediaInputOwner).toHaveBeenCalledWith(source, { id: "user-one", role: "user" }, "reference");
        expect(result.url).toMatch(/^https:\/\/vozeb\.example\/api\/reference-assets\/.+purpose=provider-read/);
        expect(result.url).not.toContain("user-one");
    });

    it("rejects an inaccessible managed reference", async () => {
        mocks.requireManagedMediaInputOwner.mockRejectedValueOnce(new Error("参考素材不存在或无权访问"));
        await expect(signProviderReference({ type: "image", role: "reference", url: "/api/reference-assets/permanent/other.png" }, { id: "user-one", role: "user" }, "https://vozeb.example")).rejects.toThrow("参考素材不存在或无权访问");
    });
});
