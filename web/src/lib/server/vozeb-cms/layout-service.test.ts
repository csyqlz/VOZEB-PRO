import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    assertCapability: vi.fn(),
    assertModule: vi.fn(),
    resolveProject: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
}));

vi.mock("./module-service", () => ({ assertVozebCmsCapabilityEnabled: mocks.assertCapability, assertVozebCmsUserCapability: mocks.assertCapability, assertVozebCmsModuleEnabled: mocks.assertModule }));
vi.mock("./project-ref-service", () => ({ resolveVozebCmsProjectRef: mocks.resolveProject }));
vi.mock("./layout-store", () => ({
    VozebCmsLayoutStoreError: class VozebCmsLayoutStoreError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    createVozebCmsLayout: mocks.create,
    getVozebCmsLayout: mocks.get,
    getPublishedVozebCmsLayout: vi.fn(),
    listVozebCmsLayouts: vi.fn(),
    publishVozebCmsLayout: vi.fn(),
    rollbackVozebCmsLayout: vi.fn(),
    saveVozebCmsLayoutDraft: vi.fn(),
}));

import { createVozebCmsLayoutForUser } from "./layout-service";

describe("VOZEBCMS layout service module gates", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveProject.mockResolvedValue(undefined);
        mocks.create.mockImplementation(async (definition) => definition);
        mocks.assertCapability.mockResolvedValue(undefined);
        mocks.assertModule.mockResolvedValue(undefined);
    });

    it("checks every registered component module before creating a layout", async () => {
        await createVozebCmsLayoutForUser("user-one", { name: "Canvas 页", nodes: [{ id: "canvas", componentId: "canvas.workspace", region: "main", props: {} }] });

        expect(mocks.assertCapability).toHaveBeenCalledWith("user-one", "layout.compose");
        expect(mocks.assertModule).toHaveBeenCalledWith("canvas");
    });

    it("does not create a layout when a referenced module is disabled", async () => {
        mocks.assertModule.mockRejectedValueOnce(new Error("Canvas 模块已停用"));

        await expect(createVozebCmsLayoutForUser("user-one", { nodes: [{ id: "canvas", componentId: "canvas.workspace", region: "main", props: {} }] })).rejects.toThrow("已停用");
        expect(mocks.create).not.toHaveBeenCalled();
    });
});
