import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cleanupExpired: vi.fn(),
    getRegistration: vi.fn(),
    register: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
    copyFile: vi.fn(),
    mkdir: vi.fn(),
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));
vi.mock("@/lib/server/local-media-registry", () => ({
    getLocalMediaRegistration: mocks.getRegistration,
    registerLocalMediaAsset: mocks.register,
}));
vi.mock("@/lib/server/object-storage-service", () => ({ persistExternalMediaIfEnabled: vi.fn(async () => null) }));
vi.mock("@/lib/server/local-media-storage", () => ({
    cleanupExpiredLocalMediaAssets: mocks.cleanupExpired,
    createDatedMediaPath: vi.fn(() => "temporary/2026/01/01/images/file.png"),
    REFERENCE_MEDIA_ROOT: "C:\\tmp\\reference-assets",
}));

import { readReferenceAsset, writeReferenceMediaDataUrl } from "./reference-asset-store";

describe("reference asset lifecycle boundaries", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not run media cleanup from the online write path", async () => {
        await expect(writeReferenceMediaDataUrl("invalid", "image", { ownerUserId: "user-one", source: "test" })).rejects.toThrow("参考素材格式不正确");
        expect(mocks.cleanupExpired).not.toHaveBeenCalled();
    });

    it("accepts a generated frame whose base64 exceeds the V8 regexp stack boundary", async () => {
        const bytes = Buffer.alloc(3_300_000, 1);

        await expect(writeReferenceMediaDataUrl(`data:image/png;base64,${bytes.toString("base64")}`, "image", { ownerUserId: "user-one", source: "test" })).resolves.toMatchObject({ bytes: bytes.length, mimeType: "image/png" });
        const written = mocks.writeFile.mock.calls[0]?.[1] as Buffer;
        expect(Buffer.isBuffer(written)).toBe(true);
        expect(written.length).toBe(bytes.length);
        expect(written[0]).toBe(1);
    });

    it("leaves expired temporary files for reference-aware maintenance", async () => {
        const registration = { storageKey: "temporary/2026/01/01/images/20260101-000000-00000000-0000-4000-8000-000000000000.png" };
        mocks.stat.mockResolvedValue({ size: 12, mtimeMs: 0 });
        mocks.getRegistration.mockResolvedValue(registration);

        await expect(readReferenceAsset(registration.storageKey)).resolves.toMatchObject({ size: 12, registration });
        expect(mocks.unlink).not.toHaveBeenCalled();
    });
});
