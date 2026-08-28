import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const DISASTER_MANIFEST_FILE = "recovery-point.json";
export const DISASTER_FORMAT_VERSION = 1;
export const LOCAL_MEDIA_ROOTS = ["reference-assets", "generation-assets"];

export function createRecoveryPointId(now = new Date()) {
    return `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}

export function parseCliArguments(values) {
    const options = { positional: [] };
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (!value.startsWith("--")) {
            options.positional.push(value);
            continue;
        }
        const [name, inline] = value.slice(2).split("=", 2);
        if (inline !== undefined) options[name] = inline;
        else if (values[index + 1] && !values[index + 1].startsWith("--")) options[name] = values[++index];
        else options[name] = true;
    }
    return options;
}

export function requireOfflineConfirmation(options) {
    if (options["confirm-offline"] !== true) throw new Error("请先停止 App 与 Worker，并在命令中加入 --confirm-offline");
}

export async function ensureNewDirectory(targetDir) {
    const resolved = path.resolve(targetDir);
    try {
        const entries = await readdir(resolved);
        if (entries.length) throw new Error(`目标目录必须为空：${resolved}`);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(resolved, { recursive: true });
    }
    return resolved;
}

export async function copyDirectorySnapshot(sourceDir, targetDir) {
    const source = path.resolve(sourceDir);
    const target = path.resolve(targetDir);
    const files = [];
    try {
        if (!(await lstat(source)).isDirectory()) throw new Error(`媒体路径不是目录：${source}`);
    } catch (error) {
        if (error?.code === "ENOENT") return { present: false, files };
        throw error;
    }
    await mkdir(target, { recursive: true });
    await walk(source, async (absolutePath, relativePath, entry) => {
        if (entry.isSymbolicLink()) throw new Error(`灾备不允许媒体目录包含符号链接：${absolutePath}`);
        if (entry.isDirectory()) {
            await mkdir(resolveWithin(target, relativePath), { recursive: true });
            return;
        }
        if (!entry.isFile()) throw new Error(`灾备只支持普通文件：${absolutePath}`);
        const destination = resolveWithin(target, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        const result = await copyFileWithHash(absolutePath, destination);
        files.push({ path: toPortablePath(relativePath), ...result });
    });
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { present: true, files };
}

export async function hashFile(filePath) {
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
        createReadStream(filePath),
        new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
            },
        }),
        new Transform({
            transform(_chunk, _encoding, callback) {
                callback();
            },
        }),
    );
    return { bytes, sha256: hash.digest("hex") };
}

export async function writeJsonAtomic(filePath, value) {
    const target = path.resolve(filePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(temporary, target);
}

export async function readRecoveryManifest(recoveryPointDir) {
    const filePath = path.join(path.resolve(recoveryPointDir), DISASTER_MANIFEST_FILE);
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    validateManifestShape(parsed);
    return parsed;
}

export async function verifyRecoveryPoint(recoveryPointDir, manifest) {
    const root = path.resolve(recoveryPointDir);
    const artifacts = [manifest.database, ...(manifest.localMedia?.roots || []).flatMap((item) => item.files || []), ...(manifest.objectStorage?.objects || [])];
    for (const artifact of artifacts) {
        if (!artifact?.file || !artifact.sha256 || !Number.isFinite(Number(artifact.bytes))) throw new Error("灾备恢复点包含不完整文件清单");
        const filePath = resolveWithin(root, artifact.file);
        const actual = await hashFile(filePath);
        if (actual.bytes !== Number(artifact.bytes) || actual.sha256 !== artifact.sha256) throw new Error(`灾备文件校验失败：${artifact.file}`);
    }
    return { files: artifacts.length };
}

export async function runPostgresTool(executable, argumentsList, databaseUrl, options = {}) {
    if (!databaseUrl) throw new Error("缺少 DATABASE_URL");
    const connectionEnvironment = postgresConnectionEnvironment(databaseUrl);
    await new Promise((resolve, reject) => {
        const child = spawn(executable, argumentsList, {
            env: { ...process.env, ...connectionEnvironment },
            stdio: options.silent ? ["ignore", "ignore", "inherit"] : "inherit",
            windowsHide: true,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${executable} 执行失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`))));
    });
}

export function postgresDatabaseName(databaseUrl) {
    try {
        return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
    } catch {
        throw new Error("DATABASE_URL 格式不正确");
    }
}

export function publicDatabaseIdentity(databaseUrl) {
    try {
        const value = new URL(databaseUrl);
        value.username = "";
        value.password = "";
        value.search = "";
        return `${value.protocol}//${value.host}${value.pathname}`;
    } catch {
        return "configured-postgresql";
    }
}

export function resolveWithin(rootDir, relativePath) {
    const root = path.resolve(rootDir);
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`路径超出灾备目录：${relativePath}`);
    return target;
}

async function copyFileWithHash(source, target) {
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
        createReadStream(source),
        new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
            },
        }),
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    return { bytes, sha256: hash.digest("hex") };
}

async function walk(root, visit, relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        const nextRelative = path.join(relative, entry.name);
        await visit(path.join(root, nextRelative), nextRelative, entry);
        if (entry.isDirectory()) await walk(root, visit, nextRelative);
    }
}

function toPortablePath(value) {
    return value.split(path.sep).join("/");
}

function validateManifestShape(value) {
    if (!value || value.app !== "VOZEB PRO" || value.formatVersion !== DISASTER_FORMAT_VERSION || typeof value.recoveryPointId !== "string" || !value.recoveryPointId) throw new Error("灾备恢复点清单格式不正确");
    if (!value.database?.file?.startsWith("database/") || !value.database.sha256) throw new Error("灾备恢复点缺少 PostgreSQL 快照");
    const roots = Array.isArray(value.localMedia?.roots) ? value.localMedia.roots : [];
    if (roots.length !== LOCAL_MEDIA_ROOTS.length || !LOCAL_MEDIA_ROOTS.every((name) => roots.some((root) => root?.name === name))) throw new Error("灾备恢复点缺少完整本地媒体目录清单");
    for (const root of roots) {
        if (!Array.isArray(root.files) || root.files.some((file) => !file?.file?.startsWith(`local-media/${root.name}/`))) throw new Error(`本地媒体清单不正确：${root.name}`);
    }
    if (!value.objectStorage || !Array.isArray(value.objectStorage.objects) || value.objectStorage.objects.some((item) => !item?.key || !item?.file?.startsWith("object-storage/objects/"))) throw new Error("对象存储清单格式不正确");
}

function postgresConnectionEnvironment(databaseUrl) {
    try {
        const value = new URL(databaseUrl);
        return {
            PGHOST: value.hostname,
            PGPORT: value.port || "5432",
            PGUSER: decodeURIComponent(value.username),
            PGPASSWORD: decodeURIComponent(value.password),
            PGDATABASE: decodeURIComponent(value.pathname.replace(/^\//, "")),
            ...(value.searchParams.get("sslmode") ? { PGSSLMODE: value.searchParams.get("sslmode") } : {}),
        };
    } catch {
        throw new Error("DATABASE_URL 格式不正确");
    }
}
