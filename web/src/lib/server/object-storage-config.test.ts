import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OBJECT_STORAGE_CDN_BASE_URL } from "@/lib/object-storage-contract";

const mocks = vi.hoisted(() => ({
    read: vi.fn(),
    write: vi.fn(),
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/server/database/object-storage-repository", () => ({
    readObjectStorageSettings: mocks.read,
    writeObjectStorageSettings: mocks.write,
}));
vi.mock("@/lib/server/secret-crypto", () => ({
    encryptSecretValue: mocks.encrypt,
    decryptSecretValue: mocks.decrypt,
}));

import { getObjectStorageAdminSettings, getObjectStorageRuntimeConfig, saveObjectStorageAdminSettings } from "./object-storage-config";

const storedSettings = {
    id: "default" as const,
    enabled: false,
    endpoint: "https://oss.example.com",
    region: "cn-test-1",
    bucket: "media",
    prefix: "vozeb-pro",
    cdnBaseUrl: DEFAULT_OBJECT_STORAGE_CDN_BASE_URL,
    accessKeyIdCiphertext: "encrypted:old-access",
    secretAccessKeyCiphertext: "encrypted:old-secret",
    forcePathStyle: false,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
};

describe("object storage configuration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.read.mockResolvedValue(storedSettings);
        mocks.write.mockImplementation(async (value) => {
            mocks.read.mockResolvedValue(value);
            return value;
        });
    });

    it("redacts stored credentials from administrator settings", async () => {
        const settings = await getObjectStorageAdminSettings();

        expect(settings).toMatchObject({ hasAccessKeyId: true, hasSecretAccessKey: true });
        expect(JSON.stringify(settings)).not.toContain("old-access");
        expect(JSON.stringify(settings)).not.toContain("old-secret");
    });

    it("preserves encrypted credentials when secret fields are empty", async () => {
        await saveObjectStorageAdminSettings({
            enabled: true,
            endpoint: "https://oss.example.com/",
            region: "cn-test-1",
            bucket: "media",
            prefix: "/tenant/assets/",
            forcePathStyle: true,
            accessKeyId: "",
            secretAccessKey: "",
        });

        expect(mocks.write).toHaveBeenCalledWith(
            expect.objectContaining({
                enabled: true,
                endpoint: "https://oss.example.com",
                prefix: "tenant/assets",
                accessKeyIdCiphertext: "encrypted:old-access",
                secretAccessKeyCiphertext: "encrypted:old-secret",
            }),
        );
        expect(mocks.encrypt).not.toHaveBeenCalled();
    });

    it("rejects unsafe endpoints and incomplete enabled configurations", async () => {
        await expect(saveObjectStorageAdminSettings({ enabled: false, endpoint: "ftp://oss.example.com", region: "auto", bucket: "media", prefix: "vozeb-pro", forcePathStyle: false })).rejects.toThrow("Endpoint");
        mocks.read.mockResolvedValue({ ...storedSettings, accessKeyIdCiphertext: "", secretAccessKeyCiphertext: "" });
        await expect(saveObjectStorageAdminSettings({ enabled: true, endpoint: "", region: "auto", bucket: "media", prefix: "vozeb-pro", forcePathStyle: false })).rejects.toThrow("Access Key");
    });

    it("saves, immediately rereads and clears the CDN prefix without stale cache values", async () => {
        await getObjectStorageAdminSettings();
        await expect(getObjectStorageRuntimeConfig()).resolves.toMatchObject({ cdnBaseUrl: DEFAULT_OBJECT_STORAGE_CDN_BASE_URL });

        const saved = await saveObjectStorageAdminSettings({ ...storedSettings, cdnBaseUrl: " https://cdn.example.com/assets/// " });
        expect(saved.cdnBaseUrl).toBe("https://cdn.example.com/assets");
        expect(mocks.write).toHaveBeenLastCalledWith(expect.objectContaining({ cdnBaseUrl: saved.cdnBaseUrl }));
        await expect(getObjectStorageRuntimeConfig()).resolves.toMatchObject({ cdnBaseUrl: saved.cdnBaseUrl });
        await expect(getObjectStorageAdminSettings()).resolves.toMatchObject({ cdnBaseUrl: saved.cdnBaseUrl });

        const cleared = await saveObjectStorageAdminSettings({ ...storedSettings, cdnBaseUrl: "" });
        expect(cleared.cdnBaseUrl).toBe("");
        await expect(getObjectStorageRuntimeConfig()).resolves.toMatchObject({ cdnBaseUrl: "" });
        await expect(getObjectStorageAdminSettings()).resolves.toMatchObject({ cdnBaseUrl: "" });
    });

    it("uses the requested default CDN when no value was submitted", async () => {
        const { cdnBaseUrl: _cdnBaseUrl, ...input } = storedSettings;
        await expect(saveObjectStorageAdminSettings(input)).resolves.toMatchObject({ cdnBaseUrl: DEFAULT_OBJECT_STORAGE_CDN_BASE_URL });
    });

    it.each(["ftp://cdn.example.com", "//cdn.example.com", "https://user:secret@cdn.example.com", "https://cdn.example.com?token=secret", "https://cdn.example.com#preview", "https://cdn.example.com?", "https://cdn.example.com#"])(
        "rejects invalid CDN prefix %s before persistence",
        async (cdnBaseUrl) => {
            await expect(saveObjectStorageAdminSettings({ ...storedSettings, cdnBaseUrl })).rejects.toThrow("CDN");
            expect(mocks.write).not.toHaveBeenCalled();
        },
    );

    it("refreshes runtime cache from a direct administrator read", async () => {
        await getObjectStorageAdminSettings();
        mocks.read.mockResolvedValue({ ...storedSettings, cdnBaseUrl: "https://changed.example.com" });
        await expect(getObjectStorageAdminSettings()).resolves.toMatchObject({ cdnBaseUrl: "https://changed.example.com" });
        await expect(getObjectStorageRuntimeConfig()).resolves.toMatchObject({ cdnBaseUrl: "https://changed.example.com" });
        expect(mocks.read).toHaveBeenCalledTimes(2);
    });

    it("does not let an old in-flight read overwrite the cache after a switch change", async () => {
        vi.resetModules();
        const { getObjectStorageRuntimeConfig, saveObjectStorageAdminSettings } = await import("./object-storage-config");
        let resolveOld!: (value: typeof storedSettings) => void;
        mocks.read.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve))).mockResolvedValue({ ...storedSettings, enabled: true });
        const oldRead = getObjectStorageRuntimeConfig();
        await Promise.resolve();

        await saveObjectStorageAdminSettings({
            enabled: true,
            endpoint: storedSettings.endpoint,
            region: storedSettings.region,
            bucket: storedSettings.bucket,
            prefix: storedSettings.prefix,
            forcePathStyle: false,
        });
        resolveOld(storedSettings);
        await oldRead;

        await expect(getObjectStorageRuntimeConfig()).resolves.toMatchObject({ enabled: true });
        expect(mocks.read).toHaveBeenCalledTimes(3);
    });

    it("does not let an older administrator read replace saved CDN configuration", async () => {
        let resolveOld!: (value: typeof storedSettings) => void;
        mocks.read.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
        const oldRead = getObjectStorageAdminSettings();
        await saveObjectStorageAdminSettings({ ...storedSettings, cdnBaseUrl: "https://current.example.com" });
        resolveOld(storedSettings);
        await oldRead;

        await expect(getObjectStorageRuntimeConfig()).resolves.toMatchObject({ cdnBaseUrl: "https://current.example.com" });
    });
});
