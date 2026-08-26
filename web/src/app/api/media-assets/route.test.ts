import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), readJsonBodyResult: vi.fn(), cascade: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.currentUser }));
vi.mock("@/lib/auth/request", () => ({ readJsonBodyResult: mocks.readJsonBodyResult }));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: mocks.cascade }));

import { DELETE } from "./route";

describe("user media deletion route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.currentUser.mockResolvedValue({ id: "user-one" });
        mocks.readJsonBodyResult.mockResolvedValue({ ok: true, data: { storageKeys: ["permanent/one.png", "permanent/one.png"] } });
        mocks.cascade.mockResolvedValue({ deletedFiles: 1, deletedBytes: 4, blocked: [], removedReferences: 3 });
    });

    it("removes business references before deleting owned local or OSS media", async () => {
        const response = await DELETE(new Request("http://localhost/api/media-assets", { method: "DELETE" }));

        expect(response.status).toBe(200);
        expect(mocks.cascade).toHaveBeenCalledWith("user-one", ["permanent/one.png", "permanent/one.png"]);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { deletedFiles: 1, removedReferences: 3 }, msg: "媒体及关联引用已删除" });
    });

    it("passes every requested media key to cascade deletion", async () => {
        const storageKeys = Array.from({ length: 201 }, (_, index) => `permanent/${index}.png`);
        mocks.readJsonBodyResult.mockResolvedValueOnce({ ok: true, data: { storageKeys } });

        const response = await DELETE(new Request("http://localhost/api/media-assets", { method: "DELETE" }));

        expect(response.status).toBe(200);
        expect(mocks.cascade).toHaveBeenCalledWith("user-one", storageKeys);
    });
});
