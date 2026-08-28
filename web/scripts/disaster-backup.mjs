import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { backupObjectStorage, loadDisasterObjectStorageConfig } from "./disaster-object-storage.mjs";
import {
    copyDirectorySnapshot,
    createRecoveryPointId,
    DISASTER_FORMAT_VERSION,
    DISASTER_MANIFEST_FILE,
    ensureNewDirectory,
    hashFile,
    LOCAL_MEDIA_ROOTS,
    parseCliArguments,
    publicDatabaseIdentity,
    requireOfflineConfirmation,
    runPostgresTool,
    verifyRecoveryPoint,
    writeJsonAtomic,
} from "./disaster-recovery-core.mjs";

const options = parseCliArguments(process.argv.slice(2));

try {
    requireOfflineConfirmation(options);
    const output = options.output || options.positional[0];
    if (!output) throw new Error("用法：pnpm backup:disaster -- --output <独立备份目录> --confirm-offline");

    const databaseUrl = process.env.DATABASE_URL?.trim() || "";
    if (!databaseUrl) throw new Error("完整灾备仅支持配置 DATABASE_URL 的 PostgreSQL 部署");
    const recoveryPointDir = await ensureNewDirectory(output);
    const recoveryPointId = createRecoveryPointId();
    const incompleteMarker = path.join(recoveryPointDir, ".incomplete");
    await writeFile(incompleteMarker, `${recoveryPointId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

    const startedAt = new Date().toISOString();
    const databaseFile = "database/vozeb-pro.dump";
    const databasePath = path.join(recoveryPointDir, databaseFile);
    await mkdir(path.dirname(databasePath), { recursive: true });
    await runPostgresTool(process.env.VOZEB_PRO_PG_DUMP_PATH || "pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", "--file", databasePath], databaseUrl);
    await runPostgresTool(process.env.VOZEB_PRO_PG_RESTORE_PATH || "pg_restore", ["--list", databasePath], databaseUrl, { silent: true });
    const database = { file: databaseFile, ...(await hashFile(databasePath)) };

    const dataDir = path.resolve(process.env.VOZEB_PRO_DATA_DIR || path.join(process.cwd(), ".data"));
    const localMediaRoots = [];
    for (const name of LOCAL_MEDIA_ROOTS) {
        const snapshot = await copyDirectorySnapshot(path.join(dataDir, name), path.join(recoveryPointDir, "local-media", name));
        localMediaRoots.push({
            name,
            present: snapshot.present,
            files: snapshot.files.map((file) => ({ ...file, file: `local-media/${name}/${file.path}` })),
        });
    }

    const objectStorageConfig = await loadDisasterObjectStorageConfig({ databaseUrl, dataDir, encryptionKey: process.env.VOZEB_PRO_ENCRYPTION_KEY });
    const objectStorage = await backupObjectStorage(objectStorageConfig, recoveryPointDir);
    const completedAt = new Date().toISOString();
    const manifest = {
        app: "VOZEB PRO",
        formatVersion: DISASTER_FORMAT_VERSION,
        recoveryPointId,
        backupType: "disaster",
        startedAt,
        completedAt,
        consistency: "offline",
        source: {
            database: publicDatabaseIdentity(databaseUrl),
            dataDirectory: dataDir,
        },
        database,
        localMedia: { roots: localMediaRoots },
        objectStorage,
        requiredSecrets: ["DATABASE_URL", "VOZEB_PRO_ENCRYPTION_KEY"],
    };
    await verifyRecoveryPoint(recoveryPointDir, manifest);
    await writeJsonAtomic(path.join(recoveryPointDir, DISASTER_MANIFEST_FILE), manifest);
    await rm(incompleteMarker, { force: true });
    process.stdout.write(`完整恢复点已创建：${recoveryPointDir}\n恢复点 ID：${recoveryPointId}\n`);
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
