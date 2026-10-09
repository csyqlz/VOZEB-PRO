import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OBJECT_STORAGE_CDN_BASE_URL } from "@/lib/object-storage-contract";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), read: vi.fn(), write: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/server/data-adapter", () => ({ readJsonDataFile: mocks.read, writeJsonDataFile: mocks.write }));
vi.mock("@/lib/server/database/postgres", () => ({ getDatabaseProvider: mocks.provider, ensurePostgresSchema: vi.fn(), postgresQuery: mocks.query }));

import { readObjectStorageSettings, writeObjectStorageSettings } from "./object-storage-repository";

describe("object storage CDN settings persistence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.provider.mockReturnValue("file");
        mocks.read.mockResolvedValue({});
        mocks.write.mockImplementation(async (_name, value) => mocks.read.mockResolvedValue(value));
    });

    it("defaults a new configuration to the requested CDN", async () => {
        await expect(readObjectStorageSettings()).resolves.toMatchObject({ cdnBaseUrl: DEFAULT_OBJECT_STORAGE_CDN_BASE_URL });
    });

    it.each(["https://cdn.example.com/media", ""])("round-trips the explicit CDN value %s in file storage", async (cdnBaseUrl) => {
        const settings = await readObjectStorageSettings();
        await writeObjectStorageSettings({ ...settings, cdnBaseUrl });
        await expect(readObjectStorageSettings()).resolves.toMatchObject({ cdnBaseUrl });
    });

    it.each(["https://cdn.example.com/media", ""])("round-trips the explicit CDN value %s through PostgreSQL", async (cdnBaseUrl) => {
        const settings = await readObjectStorageSettings();
        mocks.provider.mockReturnValue("postgres");
        mocks.query.mockResolvedValue({ rows: [{ cdn_base_url: cdnBaseUrl }] });
        await expect(writeObjectStorageSettings({ ...settings, cdnBaseUrl })).resolves.toMatchObject({ cdnBaseUrl });
        expect(mocks.query.mock.calls[0]?.[0]).toContain("cdn_base_url = EXCLUDED.cdn_base_url");
        expect(mocks.query.mock.calls[0]?.[1]?.[10]).toBe(cdnBaseUrl);
        await expect(readObjectStorageSettings()).resolves.toMatchObject({ cdnBaseUrl });
    });
});
