import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    requireCapability: vi.fn(),
    listPage: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/server/library-asset-service", () => ({
    LibraryAssetServiceError: class LibraryAssetServiceError extends Error {},
    createLibraryAssetForUser: vi.fn(),
    listLibraryAssetPageForUser: mocks.listPage,
}));

import { GET } from "./route";

describe("library assets route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.listPage.mockResolvedValue({ items: [{ id: "asset-one" }], total: 21, page: 2, pageSize: 10 });
    });

    it("uses bounded defaults when pagination is omitted", async () => {
        mocks.listPage.mockResolvedValueOnce({ items: [{ id: "asset-one" }], total: 1, page: 1, pageSize: 20 });
        const response = await GET(new Request("http://localhost/api/library-assets"));

        expect(mocks.listPage).toHaveBeenCalledWith("user-one", { page: null, pageSize: null, kind: null, keyword: null });
        expect(await response.json()).toEqual({ code: 0, data: { assets: [{ id: "asset-one" }], total: 1, page: 1, pageSize: 20 }, msg: "OK" });
    });

    it("passes page filters to the server-side page query", async () => {
        const response = await GET(new Request("http://localhost/api/library-assets?page=2&pageSize=10&kind=image&keyword=logo"));

        expect(mocks.listPage).toHaveBeenCalledWith("user-one", { page: "2", pageSize: "10", kind: "image", keyword: "logo" });
        expect(await response.json()).toEqual({ code: 0, data: { assets: [{ id: "asset-one" }], total: 21, page: 2, pageSize: 10 }, msg: "OK" });
    });
});
