import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class AccessError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    }
    return { AccessError, assertCapability: vi.fn(), assertUserCapability: vi.fn(), recordBlock: vi.fn(async () => null) };
});

vi.mock("@/lib/server/vozeb-cms/module-service", () => ({
    VozebCmsModuleAccessError: mocks.AccessError,
    assertVozebCmsCapabilityEnabled: mocks.assertCapability,
    assertVozebCmsUserCapability: mocks.assertUserCapability,
}));
vi.mock("@/lib/server/vozeb-cms/audit", () => ({ recordVozebCmsAccessBlock: mocks.recordBlock }));

import { requireVozebCmsCapability } from "./vozeb-cms-capability";

describe("requireVozebCmsCapability", () => {
    beforeEach(() => vi.clearAllMocks());

    it("checks the user entitlement when a user identity is provided", async () => {
        await expect(requireVozebCmsCapability("image.generate", "user-one")).resolves.toBeNull();
        expect(mocks.assertUserCapability).toHaveBeenCalledWith("user-one", "image.generate");
        expect(mocks.assertCapability).not.toHaveBeenCalled();
    });

    it("checks only module availability for anonymous/internal callers", async () => {
        await expect(requireVozebCmsCapability("asset.manage")).resolves.toBeNull();
        expect(mocks.assertCapability).toHaveBeenCalledWith("asset.manage");
        expect(mocks.assertUserCapability).not.toHaveBeenCalled();
    });

    it("maps module access errors to the platform response contract", async () => {
        mocks.assertUserCapability.mockRejectedValueOnce(new mocks.AccessError("能力已停用", 403));
        const request = new Request("http://localhost/api/video-tasks", { method: "POST", body: JSON.stringify({ prompt: "private prompt" }) });
        const response = await requireVozebCmsCapability("video.generate", "user-one", request);
        expect(response).toBeInstanceOf(Response);
        expect(response?.status).toBe(403);
        expect(await response?.json()).toEqual({ code: 403, data: null, msg: "能力已停用", error: "能力已停用" });
        expect(mocks.recordBlock).toHaveBeenCalledWith({ request, user: { id: "user-one" }, kind: "capability", id: "video.generate", status: 403 });
        expect(JSON.stringify(mocks.recordBlock.mock.calls)).not.toContain("private prompt");
    });

    it("does not hide unexpected infrastructure errors", async () => {
        const error = new Error("database unavailable");
        mocks.assertCapability.mockRejectedValueOnce(error);
        await expect(requireVozebCmsCapability("workflow.run")).rejects.toBe(error);
    });
});
