import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyDirectorySnapshot, createRecoveryPointId, ensureNewDirectory, hashFile, parseCliArguments, readRecoveryManifest, resolveWithin, verifyRecoveryPoint, writeJsonAtomic } from "./disaster-recovery-core.mjs";
import { requiresObjectBackup } from "./disaster-object-storage.mjs";

describe("disaster recovery core", () => {
    it("keeps historical object media even after external storage is disabled", () => {
        expect(requiresObjectBackup({ enabled: false, hasReferencedObjects: true })).toBe(true);
        expect(requiresObjectBackup({ enabled: true, hasReferencedObjects: false })).toBe(true);
        expect(requiresObjectBackup({ enabled: false, hasReferencedObjects: false })).toBe(false);
    });
    it("creates a bounded recovery point identity and parses explicit confirmations", () => {
        expect(createRecoveryPointId(new Date("2026-08-01T00:00:00.000Z"))).toMatch(/^2026-08-01T00-00-00-000Z-[a-f0-9]{8}$/);
        expect(parseCliArguments(["--input", "backup", "--confirm=id", "--confirm-offline"])).toMatchObject({ input: "backup", confirm: "id", "confirm-offline": true });
    });

    it("copies ordinary files, rejects path traversal and verifies hashes", async () => {
        const root = await temporaryDirectory();
        const source = path.join(root, "source");
        const recovery = path.join(root, "recovery");
        await mkdir(path.join(source, "nested"), { recursive: true });
        await writeFile(path.join(source, "nested", "media.bin"), "safe-media");
        await ensureNewDirectory(recovery);
        const snapshot = await copyDirectorySnapshot(source, path.join(recovery, "local-media", "reference-assets"));
        const file = { ...snapshot.files[0], file: `local-media/reference-assets/${snapshot.files[0].path}` };
        const databasePath = path.join(recovery, "database", "vozeb-pro.dump");
        await mkdir(path.dirname(databasePath), { recursive: true });
        await writeFile(databasePath, "database");
        const manifest = {
            app: "VOZEB PRO",
            formatVersion: 1,
            recoveryPointId: "point-one",
            database: { ...(await hashFile(databasePath)), file: "database/vozeb-pro.dump" },
            localMedia: {
                roots: [
                    { name: "reference-assets", files: [file] },
                    { name: "generation-assets", present: false, files: [] },
                ],
            },
            objectStorage: { objects: [] },
        };
        await writeJsonAtomic(path.join(recovery, "recovery-point.json"), manifest);

        expect((await readRecoveryManifest(recovery)).recoveryPointId).toBe("point-one");
        await expect(verifyRecoveryPoint(recovery, manifest)).resolves.toEqual({ files: 2 });
        expect(() => resolveWithin(recovery, "../escape")).toThrow("路径超出灾备目录");

        await writeFile(path.join(recovery, file.file), "tampered");
        await expect(verifyRecoveryPoint(recovery, manifest)).rejects.toThrow("灾备文件校验失败");
    });

    it("never overwrites a non-empty recovery directory", async () => {
        const root = await temporaryDirectory();
        await writeFile(path.join(root, "existing"), "keep");
        await expect(ensureNewDirectory(root)).rejects.toThrow("目标目录必须为空");
        expect(await readFile(path.join(root, "existing"), "utf8")).toBe("keep");
    });
});

async function temporaryDirectory() {
    const root = path.join(os.tmpdir(), `vozeb-disaster-test-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    return root;
}
