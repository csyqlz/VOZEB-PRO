import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listStates: vi.fn(),
    updateState: vi.fn(),
}));

vi.mock("@/lib/server/vozeb-cms/module-state-store", () => ({
    listVozebCmsModuleStates: mocks.listStates,
    updateVozebCmsModuleState: mocks.updateState,
}));

import { VozebCmsModuleAccessError, assertVozebCmsCapabilityEnabled, changeVozebCmsModuleState, listVozebCmsModules } from "@/lib/server/vozeb-cms/module-service";

describe("VOZEBCMS module service", () => {
    beforeEach(() => {
        mocks.listStates.mockReset().mockResolvedValue([]);
        mocks.updateState.mockReset().mockImplementation(async (input) => ({ moduleId: input.moduleId, enabled: input.enabled, revision: input.baseRevision + 1 }));
    });

    it("keeps every official module enabled before an administrator changes state", async () => {
        expect((await listVozebCmsModules()).every((module) => module.enabled)).toBe(true);
        await expect(assertVozebCmsCapabilityEnabled("video.generate")).resolves.toMatchObject({ moduleId: "video" });
    });

    it("does not disable a module while enabled dependents still require it", async () => {
        await expect(changeVozebCmsModuleState({ moduleId: "create", enabled: false, baseRevision: 0, mutationId: "mutation-one", updatedBy: "admin-one" })).rejects.toEqual(
            expect.objectContaining<Partial<VozebCmsModuleAccessError>>({ status: 409, message: expect.stringContaining("图片生成") }),
        );
        expect(mocks.updateState).not.toHaveBeenCalled();
    });

    it("rejects capabilities owned by a disabled module while platform capabilities remain registered", async () => {
        mocks.listStates.mockResolvedValue([{ moduleId: "video", enabled: false, revision: 1 }]);

        await expect(assertVozebCmsCapabilityEnabled("video.generate")).rejects.toMatchObject({ status: 403 });
        await expect(assertVozebCmsCapabilityEnabled("asset.manage")).resolves.toMatchObject({ moduleId: "platform" });
    });
});
