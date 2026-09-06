import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getLibraryAsset: vi.fn(),
    deleteLibraryAsset: vi.fn(),
    deleteUserLocalMediaAssets: vi.fn(),
    createLibraryAsset: vi.fn(),
    updateLibraryAsset: vi.fn(),
    listLibraryAssetPage: vi.fn(),
    promoteLocalMediaRegistration: vi.fn(),
}));

vi.mock("@/lib/server/library-asset-store", () => ({
    createLibraryAsset: mocks.createLibraryAsset,
    deleteLibraryAsset: mocks.deleteLibraryAsset,
    getLibraryAsset: mocks.getLibraryAsset,
    listLibraryAssetPage: mocks.listLibraryAssetPage,
    updateLibraryAsset: mocks.updateLibraryAsset,
}));
vi.mock("@/lib/server/local-media-storage", () => ({ deleteUserLocalMediaAssets: mocks.deleteUserLocalMediaAssets }));
vi.mock("@/lib/server/local-media-registry", () => ({ promoteLocalMediaRegistration: mocks.promoteLocalMediaRegistration }));

import { deleteLibraryAssetForUser } from "./library-asset-service";

describe("deleteLibraryAssetForUser", () => {
    beforeEach(() => vi.clearAllMocks());

    it("removes only the library record and deletes media only when unreferenced", async () => {
        mocks.getLibraryAsset.mockResolvedValue({ id: "asset-one", kind: "image", title: "图", coverUrl: "", tags: [], data: { storageKey: "temporary/one.png" } });
        mocks.deleteLibraryAsset.mockResolvedValue(true);

        await deleteLibraryAssetForUser("user-one", "asset-one");

        expect(mocks.deleteLibraryAsset).toHaveBeenCalledWith("user-one", "asset-one");
        expect(mocks.deleteUserLocalMediaAssets).toHaveBeenCalledWith("user-one", ["temporary/one.png"]);
    });
});
