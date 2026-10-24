import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { loadDisasterObjectStorageConfig, requiresObjectBackup } from "./disaster-object-storage.mjs";
import { LOCAL_MEDIA_ROOTS } from "./disaster-recovery-core.mjs";

const dataDir = path.resolve(process.env.VOZEB_PRO_DATA_DIR || path.join(process.cwd(), ".data"));

try {
    const localMediaPresent = (await Promise.all(LOCAL_MEDIA_ROOTS.map((name) => hasFiles(path.join(dataDir, name))))).some(Boolean);
    const config = await loadDisasterObjectStorageConfig({
        databaseUrl: process.env.DATABASE_URL?.trim() || "",
        dataDir,
        encryptionKey: process.env.VOZEB_PRO_ENCRYPTION_KEY,
    });
    process.stdout.write(`${JSON.stringify({ localMediaPresent, objectStorageRequired: requiresObjectBackup(config) })}\n`);
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}

async function hasFiles(directory) {
    try {
        if (!(await lstat(directory)).isDirectory()) throw new Error(`媒体路径不是目录：${directory}`);
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error(`媒体目录包含符号链接：${path.join(directory, entry.name)}`);
        if (entry.isFile()) return true;
        if (entry.isDirectory() && (await hasFiles(path.join(directory, entry.name)))) return true;
    }
    return false;
}
