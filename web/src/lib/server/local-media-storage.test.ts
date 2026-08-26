import { access, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = resolve(tmpdir(), `vozeb-pro-local-media-${process.pid}-${Date.now()}`);
const previousDataDir = process.env.VOZEB_PRO_DATA_DIR;
const previousProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;

describe("local media storage", () => {
    beforeAll(async () => {
        process.env.VOZEB_PRO_DATA_DIR = dataDir;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
        vi.resetModules();
    });

    afterAll(async () => {
        if (previousDataDir === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = previousDataDir;
        if (previousProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = previousProvider;
        await rm(dataDir, { recursive: true, force: true });
    });

    it("creates dated names and manages temporary and permanent files", async () => {
        const storage = await import("./local-media-storage");
        const now = new Date(2026, 6, 18, 9, 8, 7);
        expect(storage.createDatedMediaPath("permanent", "image", ".png", now)).toMatch(/^permanent\/2026\/07\/18\/images\/20260718-090807-[0-9a-f-]{36}\.png$/);

        const generationPath = storage.createDatedMediaPath("permanent", "video", ".mp4", now);
        const temporaryPath = storage.createDatedMediaPath("temporary", "audio", ".mp3", now);
        const permanentPath = storage.createDatedMediaPath("permanent", "image", ".png", now);
        const attachmentPath = "permanent/2026/07/18/attachments/20260718-090807-notes.pdf";
        await write(storage.GENERATION_MEDIA_ROOT, generationPath, "video");
        await write(storage.GENERATION_MEDIA_ROOT, attachmentPath, "document");
        const temporaryFile = await write(storage.REFERENCE_MEDIA_ROOT, temporaryPath, "audio");
        await write(storage.REFERENCE_MEDIA_ROOT, permanentPath, "image");
        const expired = new Date(Date.now() - storage.TEMPORARY_MEDIA_TTL_MS - 60_000);
        await utimes(temporaryFile, expired, expired);

        const listed = await storage.listLocalMediaAssets({ pageSize: 10 });
        expect(listed.summary).toMatchObject({ totalFiles: 4, temporaryFiles: 1, permanentFiles: 3, expiredTemporaryFiles: 1 });
        expect(listed.items.map((asset) => [asset.storageClass, asset.type])).toEqual(
            expect.arrayContaining([
                ["temporary", "audio"],
                ["permanent", "image"],
                ["permanent", "video"],
                ["permanent", "attachment"],
            ]),
        );

        expect(await storage.cleanupExpiredLocalMediaAssets()).toMatchObject({ deletedFiles: 1, deletedBytes: 5 });
        await expect(access(temporaryFile)).rejects.toBeTruthy();

        const permanent = (await storage.listLocalMediaAssets({ storageClass: "permanent", pageSize: 10 })).items;
        expect(await storage.deleteLocalMediaAssets(permanent.map((asset) => asset.id))).toMatchObject({ deletedFiles: 3 });
        expect((await storage.listLocalMediaAssets()).summary.totalFiles).toBe(0);
    }, 15_000);

    it("filters registered files by their administrator source group", async () => {
        const storage = await import("./local-media-storage");
        const registry = await import("./local-media-registry");
        const mediaPath = storage.createDatedMediaPath("permanent", "image", ".png");
        await write(storage.REFERENCE_MEDIA_ROOT, mediaPath, "image");
        await registry.registerLocalMediaAsset({ storageKey: mediaPath, scope: "reference", storageClass: "permanent", type: "image", ownerUserId: "user-one", source: "drama-render", mimeType: "image/png", bytes: 5 });

        expect((await storage.listLocalMediaAssets({ source: "drama", pageSize: 10 })).items.map((item) => item.storageKey)).toEqual([mediaPath]);
        expect((await storage.listLocalMediaAssets({ source: "agent", pageSize: 10 })).items).toEqual([]);
        await storage.deleteLocalMediaAssetsByStorageKeys([mediaPath], "reference");
    });

    it("does not delete files outside managed roots", async () => {
        const storage = await import("./local-media-storage");
        const outside = resolve(dataDir, "outside.png");
        await writeFile(outside, "outside");
        const forgedId = Buffer.from(JSON.stringify({ scope: "reference", relativePath: "../outside.png" }), "utf8").toString("base64url");

        expect(await storage.deleteLocalMediaAssets([forgedId])).toEqual({ deletedFiles: 0, deletedBytes: 0, blocked: [] });
        await expect(access(outside)).resolves.toBeUndefined();
    });

    it("keeps files that are still referenced by server business data", async () => {
        const storage = await import("./local-media-storage");
        const mediaPath = storage.createDatedMediaPath("permanent", "image", ".png");
        const file = await write(storage.REFERENCE_MEDIA_ROOT, mediaPath, "image");
        await writeFile(resolve(dataDir, "creative-runtime.json"), JSON.stringify({ version: 1, assets: [{ storageKey: mediaPath }] }));
        const [asset] = (await storage.listLocalMediaAssets({ pageSize: 100 })).items.filter((item) => item.storageKey === mediaPath);

        expect(await storage.deleteLocalMediaAssets([asset.id])).toMatchObject({ deletedFiles: 0, blocked: [{ storageKey: mediaPath, referenceCount: 1 }] });
        await expect(access(file)).resolves.toBeUndefined();

        await writeFile(resolve(dataDir, "creative-runtime.json"), JSON.stringify({ version: 1, assets: [] }));
        expect(await storage.deleteLocalMediaAssets([asset.id])).toMatchObject({ deletedFiles: 1, blocked: [] });
    });

    it("does not expire temporary files that are still referenced", async () => {
        const storage = await import("./local-media-storage");
        const mediaPath = storage.createDatedMediaPath("temporary", "image", ".png");
        const file = await write(storage.REFERENCE_MEDIA_ROOT, mediaPath, "image");
        const expired = new Date(Date.now() - storage.TEMPORARY_MEDIA_TTL_MS - 60_000);
        await utimes(file, expired, expired);
        await writeFile(resolve(dataDir, "creative-runtime.json"), JSON.stringify({ version: 1, assets: [{ storageKey: mediaPath }] }));

        expect(await storage.cleanupExpiredLocalMediaAssets()).toMatchObject({ deletedFiles: 0, blocked: [{ storageKey: mediaPath, referenceCount: 1 }] });
        await expect(access(file)).resolves.toBeUndefined();

        await writeFile(resolve(dataDir, "creative-runtime.json"), JSON.stringify({ version: 1, assets: [] }));
        expect(await storage.cleanupExpiredLocalMediaAssets()).toMatchObject({ deletedFiles: 1, blocked: [] });
        await expect(access(file)).rejects.toBeTruthy();
    });

    it("expires generated media even while its generation log remains", async () => {
        const storage = await import("./local-media-storage");
        const registry = await import("./local-media-registry");
        const mediaPath = storage.createDatedMediaPath("temporary", "image", ".png");
        const file = await write(storage.GENERATION_MEDIA_ROOT, mediaPath, "image");
        const expiredAt = new Date(Date.now() - 60_000).toISOString();
        await registry.registerLocalMediaAsset({ storageKey: mediaPath, scope: "generation", storageClass: "temporary", type: "image", ownerUserId: "user-one", source: "image-workbench", mimeType: "image/png", bytes: 5, expiresAt: expiredAt });
        await writeFile(resolve(dataDir, "generation-logs.json"), JSON.stringify({ version: 1, logs: [{ userId: "user-one", assets: [{ serverUrl: `/api/generation-log-assets/${mediaPath}` }] }] }));

        expect(await storage.cleanupExpiredLocalMediaAssets()).toMatchObject({ deletedFiles: 1, blocked: [] });
        await expect(access(file)).rejects.toBeTruthy();
    });

    it("extracts reference and generated media keys without trusting malformed paths", async () => {
        const { collectLocalMediaStorageKeys } = await import("./local-media-references");
        expect(
            collectLocalMediaStorageKeys({
                reference: "/api/reference-assets/permanent/2026/07/20/images/a%20b.png?token=test",
                generated: "https://example.test/api/generation-log-assets/permanent/2026/07/20/videos/result.mp4#preview",
                malformed: "/api/reference-assets/permanent/%ZZ.png",
            }),
        ).toEqual(["permanent/2026/07/20/images/a b.png", "permanent/2026/07/20/videos/result.mp4"]);
    });
});

async function write(root: string, relativePath: string, value: string) {
    const filePath = resolve(root, relativePath);
    await mkdir(resolve(filePath, ".."), { recursive: true });
    await writeFile(filePath, value);
    return filePath;
}
