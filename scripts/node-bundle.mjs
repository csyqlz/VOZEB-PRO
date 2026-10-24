#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const toolPath = fileURLToPath(import.meta.url);
const defaultSource = path.resolve(path.dirname(toolPath), "..");
const manifestName = "node-bundle.json";
const sourceName = "source.tar.gz";
const imagesName = "images.tar.gz";
const encryptedEnvName = "deployment.env.enc";
const composeName = "docker-compose.local.yml";
const excludedDirectories = new Set([".git", ".agents", ".codex", ".idea", ".tmp", ".trellis", "node_modules", ".next", "out", ".data", ".e2e-data", ".e2e-artifacts", "playwright-report", ".pnpm-store"]);

export function parseOptions(values) {
    const [action, ...args] = values;
    if (!action || !["backup", "restore", "verify"].includes(action)) throw new Error("用法：node scripts/node-bundle.mjs backup|restore|verify [选项]");
    const options = { action };
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (!value.startsWith("--")) throw new Error(`未知参数：${value}`);
        const equals = value.indexOf("=");
        const key = value.slice(2, equals < 0 ? undefined : equals);
        if (Object.hasOwn(options, key)) throw new Error(`重复参数：--${key}`);
        if (key === "apply") {
            if (equals >= 0) throw new Error("--apply 是独立确认开关，不接受值");
            options[key] = true;
        }
        else {
            const next = equals < 0 ? args[++index] : value.slice(equals + 1);
            if (!next || next.startsWith("--")) throw new Error(`--${key} 缺少值`);
            options[key] = next;
        }
    }
    const allowed = action === "backup"
        ? ["mode", "output", "source", "deployment", "passphrase-file", "local-media", "object-storage"]
        : action === "restore"
            ? ["input", "target", "domain", "passphrase-file", "apply", "confirm"]
            : ["input"];
    for (const key of Object.keys(options)) if (key !== "action" && !allowed.includes(key)) throw new Error(`不支持的参数：--${key}`);
    return options;
}

export function validateDomain(value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("--domain 必须是完整 HTTPS 站点地址"); }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || value.endsWith("/")) throw new Error("--domain 必须是无路径、参数及尾部斜杠的 HTTPS 站点地址");
    return parsed.origin;
}

export function sourceEntryIncluded(relativePath, isDirectory) {
    const parts = relativePath.split(path.sep);
    const name = parts.at(-1);
    if (isDirectory && (excludedDirectories.has(name) || name.startsWith(".next-") || name.startsWith(".tmp-"))) return false;
    if (parts.some((part) => excludedDirectories.has(part))) return false;
    if (name.startsWith(".env") && name !== ".env.example") return false;
    if (name.endsWith(".log") || name.endsWith(".tsbuildinfo") || name.startsWith(".tmp-") || name.startsWith(".tmp_") || /\.(pem|p12|pfx|key)$/i.test(name) || name === "id_rsa") return false;
    if (parts[0] === "data") return false;
    return true;
}

export function createFreshEnvironment(example, domain) {
    const replacements = {
        NEXT_PUBLIC_SITE_URL: validateDomain(domain),
        VOZEB_PRO_IMAGE: "vozeb-pro:local",
        POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
        VOZEB_PRO_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        VOZEB_PRO_INSTALL_TOKEN: randomBytes(32).toString("hex"),
        VOZEB_PRO_MAINTENANCE_TOKEN: randomBytes(32).toString("hex"),
        VOZEB_PRO_WORKER_TOKEN: randomBytes(32).toString("hex"),
    };
    return replaceEnvironment(example, replacements);
}

export function replaceEnvironment(value, replacements) {
    const seen = new Set();
    const updated = value.replace(/^([A-Za-z_][A-Za-z_0-9]*)=.*$/gm, (line, key) => {
        if (!(key in replacements)) return line;
        seen.add(key);
        return `${key}=${replacements[key]}`;
    });
    for (const key of Object.keys(replacements)) if (!seen.has(key)) throw new Error(`环境文件缺少 ${key}`);
    return updated;
}

export function encryptEnvironment(plaintext, passphrase) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from("VZB1"), salt, iv, cipher.getAuthTag(), body]);
}

export function decryptEnvironment(payload, passphrase) {
    if (payload.length < 48 || payload.subarray(0, 4).toString() !== "VZB1") throw new Error("加密环境文件格式不正确");
    const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase, payload.subarray(4, 20), 32), payload.subarray(20, 32));
    decipher.setAuthTag(payload.subarray(32, 48));
    return Buffer.concat([decipher.update(payload.subarray(48)), decipher.final()]).toString("utf8");
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.action === "backup") await backup(options);
    else if (options.action === "restore") await restore(options);
    else {
        const bundle = await verifyBundle(requiredPath(options.input, "--input"));
        process.stdout.write(`备份包校验通过：${bundle.id}，模式：${bundle.mode}\n`);
    }
}

async function backup(options) {
    const mode = options.mode || "template";
    if (!["full", "template"].includes(mode)) throw new Error("--mode 只能是 full 或 template");
    const source = path.resolve(options.source || defaultSource);
    const deployment = path.resolve(options.deployment || source);
    const output = path.resolve(requiredPath(options.output, "--output"));
    if (isWithin(source, output) || isWithin(deployment, output)) throw new Error("备份输出目录必须位于源码和部署目录之外");
    if (mode === "full" && !options.deployment) throw new Error("完整迁移须显式指定 --deployment，避免备份错误实例");
    if (mode === "full" && !options["passphrase-file"]) throw new Error("完整迁移须提供 --passphrase-file 加密部署密钥");
    if (mode === "full" && isWithin(source, path.resolve(options["passphrase-file"]))) throw new Error("口令文件必须放在源码目录之外");
    const localMedia = options["local-media"] || (mode === "full" ? "include" : "omit");
    const objectStorage = options["object-storage"] || (mode === "full" ? "include" : "omit");
    if (!["include", "omit"].includes(localMedia) || !["include", "omit"].includes(objectStorage)) throw new Error("媒体选项只能是 include 或 omit");
    if (mode === "template" && (localMedia !== "omit" || objectStorage !== "omit")) throw new Error("新节点模板不包含生产数据库或媒体，请使用 --mode full");
    await requireFile(path.join(source, composeName));
    await requireFile(path.join(source, ".env.example"));
    for (const file of ["Dockerfile", "web/package.json", "web/pnpm-lock.yaml", "web/scripts/disaster-backup.mjs", "web/scripts/disaster-restore.mjs", "web/scripts/disaster-media-check.mjs"]) await requireFile(path.join(source, file));
    if (mode === "full") {
        await requireFile(path.join(deployment, composeName));
        await requireFile(path.join(deployment, ".env"));
    }
    await createEmptyDirectory(output);
    await writeFile(path.join(output, ".incomplete"), "正在创建备份包\n", { mode: 0o600 });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    const artifacts = {};
    try {
        await archiveSource(source, path.join(output, sourceName));
        artifacts.source = await artifact(output, sourceName);
        await copyFile(toolPath, path.join(output, "node-bundle.mjs"));
        artifacts.tool = await artifact(output, "node-bundle.mjs");
        const image = "vozeb-pro:local";
        const images = [image, "postgres:16-alpine"];
        const inspected = JSON.parse(await run("docker", ["image", "inspect", ...images], { capture: true }));
        if (inspected.length !== images.length) throw new Error("Docker 镜像检查结果不完整");
        if (inspected.some((item) => item.Architecture !== inspected[0].Architecture)) throw new Error("应用与 PostgreSQL 镜像架构不一致");
        if (mode === "full") await verifyDeployedImage(deployment, inspected[0].Id);
        await saveImages(images, path.join(output, imagesName));
        artifacts.images = await artifact(output, imagesName);
        let domain = null;
        if (mode === "full") {
            const environment = await readFile(path.join(deployment, ".env"), "utf8");
            domain = environmentValue(environment, "NEXT_PUBLIC_SITE_URL");
            if (!domain) throw new Error("部署环境缺少 NEXT_PUBLIC_SITE_URL");
            const passphrase = await readPassphrase(options["passphrase-file"]);
            await writeFile(path.join(output, encryptedEnvName), encryptEnvironment(environment, passphrase), { mode: 0o600 });
            artifacts.environment = await artifact(output, encryptedEnvName);
            await backupData({ output, deployment, source, localMedia, objectStorage });
            artifacts.recovery = await artifact(output, "recovery/point/recovery-point.json");
        }
        const manifest = {
            formatVersion: 1, id, mode, createdAt: new Date().toISOString(), domain,
            appImage: image, postgresImage: "postgres:16-alpine",
            architecture: inspected[0].Architecture,
            imageIds: inspected.map((value) => value.Id),
            media: { local: localMedia, objectStorage }, artifacts,
            sourceNote: "源码为打包时工作树快照；镜像为打包时本机镜像。构建新域名时使用此源码重新构建。",
        };
        await writeFile(path.join(output, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        await rm(path.join(output, ".incomplete"));
        process.stdout.write(`备份包已创建：${output}\n确认 ID：${id}\n模式：${mode}\n`);
    } catch (error) {
        process.stderr.write(`备份未完成，目录保留 .incomplete 标记：${output}\n`);
        throw error;
    }
}

async function backupData({ output, deployment, source, localMedia, objectStorage }) {
    const args = composeArgs(deployment);
    const running = (await run("docker", [...args, "ps", "--status", "running", "--services"], { cwd: deployment, capture: true })).trim().split("\n").filter(Boolean);
    const stopped = running.filter((name) => ["app", "generation-worker"].includes(name));
    try {
        await run("docker", [...args, "stop", "generation-worker"], { cwd: deployment });
        await run("docker", [...args, "stop", "app"], { cwd: deployment });
        const recovery = path.join(output, "recovery");
        await mkdir(recovery, { mode: 0o700 });
        const mounts = ["-v", `${recovery}:/backup`, "-v", `${path.join(source, "web/scripts")}:/app/web/scripts:ro`];
        const prefix = [...args, "run", "--rm", "--no-deps", "--user", "0:0", ...mounts, "app", "node"];
        const inventory = JSON.parse(await run("docker", [...prefix, "/app/web/scripts/disaster-media-check.mjs"], { cwd: deployment, capture: true }));
        if (localMedia === "omit" && inventory.localMediaPresent) throw new Error("本地媒体仍有文件，完整迁移不能省略；请选择 include 或新节点模板");
        if (objectStorage === "omit" && inventory.objectStorageRequired) throw new Error("对象存储已启用或仍有历史媒体引用，完整迁移不能省略；请选择 include 或新节点模板");
        await run("docker", [...prefix, "/app/web/scripts/disaster-backup.mjs", "--output", "/backup/point", "--confirm-offline"], { cwd: deployment });
    } finally {
        for (const name of ["app", "generation-worker"]) if (stopped.includes(name)) await run("docker", [...args, "start", name], { cwd: deployment });
    }
}

async function verifyDeployedImage(deployment, imageId) {
    const args = composeArgs(deployment);
    for (const service of ["app", "generation-worker"]) {
        const containers = (await run("docker", [...args, "ps", "-a", "-q", service], { cwd: deployment, capture: true })).trim().split("\n").filter(Boolean);
        if (!containers.length && service === "app") throw new Error("部署目录没有 App 容器，无法确认本次备份的运行镜像");
        for (const container of containers) {
            const actual = (await run("docker", ["container", "inspect", "--format", "{{.Image}}", container], { capture: true })).trim();
            if (actual !== imageId) throw new Error(`${service} 容器镜像与 vozeb-pro:local 标签不一致，先核对部署版本`);
        }
    }
}

async function restore(options) {
    const input = requiredPath(options.input, "--input");
    const target = path.resolve(requiredPath(options.target, "--target"));
    const domain = validateDomain(requiredValue(options.domain, "--domain"));
    const bundle = await verifyBundle(input);
    if (isWithin(path.resolve(input), target)) throw new Error("目标目录不能位于备份包内");
    await assertEmptyDirectory(target);
    const targetArch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
    if (targetArch !== bundle.architecture) throw new Error(`镜像架构 ${bundle.architecture} 与当前机器 ${targetArch} 不一致，请在目标架构重新构建镜像`);
    if (bundle.mode === "full" && !options["passphrase-file"]) throw new Error("完整恢复须提供 --passphrase-file");
    const restoredEnvironment = bundle.mode === "full"
        ? decryptEnvironment(await readFile(path.join(input, encryptedEnvName)), await readPassphrase(options["passphrase-file"]))
        : null;
    if (restoredEnvironment && environmentValue(restoredEnvironment, "NEXT_PUBLIC_SITE_URL") !== bundle.domain) throw new Error("加密部署环境与备份清单中的原站点地址不一致");
    if (!options.apply) {
        process.stdout.write(`预检通过：${bundle.id}（${bundle.mode}），目标：${target}，域名：${domain}\n执行时添加 --apply --confirm ${bundle.id}\n`);
        return;
    }
    if (options.confirm !== bundle.id) throw new Error("--confirm 必须填写备份包的完整确认 ID");
    for (const [image, expectedId] of [[bundle.appImage, bundle.imageIds[0]], [bundle.postgresImage, bundle.imageIds[1]]]) {
        const currentId = (await run("docker", ["image", "ls", "-q", "--no-trunc", image], { capture: true })).trim();
        if (currentId && currentId !== expectedId) throw new Error(`目标服务器已有不同版本的 ${image}，导入会覆盖现有镜像标签，请使用干净目标服务器`);
    }
    await createEmptyDirectory(target);
    await run("tar", ["-xzf", path.join(input, sourceName), "-C", target, "--no-same-owner"]);
    const original = restoredEnvironment || await readFile(path.join(target, ".env.example"), "utf8");
    let environment = bundle.mode === "full"
        ? replaceEnvironment(original, { NEXT_PUBLIC_SITE_URL: domain })
        : createFreshEnvironment(original, domain);
    environment = setEnvironmentLine(environment, "VOZEB_PRO_IMAGE", "vozeb-pro:local");
    environment = setEnvironmentLine(environment, "VOZEB_PRO_APP_BIND", "127.0.0.1");
    environment = setEnvironmentLine(environment, "VOZEB_PRO_BUILD_CONTEXT", ".");
    const projectName = `vozeb-${randomBytes(4).toString("hex")}`;
    environment = setEnvironmentLine(environment, "COMPOSE_PROJECT_NAME", projectName);
    await writeFile(path.join(target, ".env"), environment, { mode: 0o600, flag: "wx" });
    await run("docker", ["image", "load", "-i", path.join(input, imagesName)]);
    const loaded = JSON.parse(await run("docker", ["image", "inspect", bundle.appImage, bundle.postgresImage], { capture: true }));
    if (loaded.length !== bundle.imageIds.length || loaded.some((item, index) => item.Id !== bundle.imageIds[index])) throw new Error("导入镜像与备份清单不一致");
    if (bundle.appImage !== "vozeb-pro:local") await run("docker", ["image", "tag", bundle.appImage, "vozeb-pro:local"]);
    const args = composeArgs(target, projectName);
    if (domain !== bundle.domain) await run("docker", [...args, "build", "app"], { cwd: target });
    await run("docker", [...args, "up", "-d", "--wait", "--no-build", "postgres"], { cwd: target });
    if (bundle.mode === "full") {
        const recovery = path.join(input, "recovery", "point");
        const safety = path.join(target, ".restore-safety");
        await mkdir(safety, { mode: 0o700 });
        const recoveryManifest = JSON.parse(await readFile(path.join(recovery, "recovery-point.json"), "utf8"));
        await run("docker", [...args, "run", "--rm", "--no-deps", "--user", "0:0", "-v", `${recovery}:/recovery:ro`, "-v", `${safety}:/safety`, "-v", `${path.join(target, "web/scripts")}:/app/web/scripts:ro`, "app", "node", "/app/web/scripts/disaster-restore.mjs", "--input", "/recovery", "--safety-dir", "/safety/pre-restore", "--confirm", recoveryManifest.recoveryPointId, "--confirm-offline"], { cwd: target });
        await run("docker", [...args, "run", "--rm", "--no-deps", "--user", "0:0", "app", "chown", "-R", "node:node", "/app/web/.data"], { cwd: target });
    }
    await run("docker", [...args, "up", "-d", "--wait", "--no-build", "app"], { cwd: target });
    const staleKeys = bundle.mode === "full" && domain !== bundle.domain ? oldDomainKeys(environment, bundle.domain) : [];
    process.stdout.write(`App 已启动，Worker 尚未启动。请完成新域名 HTTPS、回调和媒体检查后执行：\ncd ${target} && docker compose -p ${projectName} -f ${composeName} up -d --no-build generation-worker\n`);
    if (staleKeys.length) process.stdout.write(`以下环境变量仍包含旧域名，须逐项核对：${staleKeys.join("、")}\n`);
    if (bundle.mode === "template") process.stdout.write("新节点尚需访问 /install 初始化数据库与管理员；安装令牌保存在目标 .env 中。\n");
}

async function verifyBundle(rootPath) {
    const root = path.resolve(rootPath);
    if (await exists(path.join(root, ".incomplete"))) throw new Error("备份包尚未完成");
    const value = JSON.parse(await readFile(path.join(root, manifestName), "utf8"));
    if (value.formatVersion !== 1 || !["full", "template"].includes(value.mode) || !value.id || !value.artifacts || !value.architecture || value.appImage !== "vozeb-pro:local" || value.postgresImage !== "postgres:16-alpine" || !Array.isArray(value.imageIds) || value.imageIds.length !== 2 || value.imageIds.some((id) => typeof id !== "string" || !id.startsWith("sha256:"))) throw new Error("备份包清单格式不正确");
    for (const item of Object.values(value.artifacts)) {
        if (!item?.file || !item.sha256 || !Number.isSafeInteger(item.bytes)) throw new Error("备份包文件清单不完整");
        const filePath = await checkedFilePath(root, item.file);
        const actual = await hashFile(filePath);
        if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error(`备份文件校验失败：${item.file}`);
    }
    for (const file of [sourceName, imagesName, "node-bundle.mjs", ...(value.mode === "full" ? [encryptedEnvName, "recovery/point/recovery-point.json"] : [])]) {
        if (!Object.values(value.artifacts).some((item) => item.file === file)) throw new Error(`备份包缺少 ${file}`);
    }
    await verifySourceArchive(path.join(root, sourceName), root);
    if (value.mode === "full") await verifyRecoveryFiles(path.join(root, "recovery", "point"));
    return value;
}

async function verifyRecoveryFiles(recovery) {
    if (await exists(path.join(recovery, ".incomplete"))) throw new Error("灾备恢复点尚未完成");
    const manifest = JSON.parse(await readFile(path.join(recovery, "recovery-point.json"), "utf8"));
    const entries = [manifest.database, ...(manifest.localMedia?.roots || []).flatMap((root) => root.files || []), ...(manifest.objectStorage?.objects || [])];
    if (!manifest.recoveryPointId || !manifest.database?.file || !Array.isArray(manifest.localMedia?.roots) || !Array.isArray(manifest.objectStorage?.objects)) throw new Error("灾备恢复点清单不完整");
    for (const item of entries) {
        if (!item?.file || !item.sha256 || !Number.isSafeInteger(item.bytes)) throw new Error("灾备文件清单不完整");
        const actual = await hashFile(await checkedFilePath(recovery, item.file));
        if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error(`灾备文件校验失败：${item.file}`);
    }
}

async function archiveSource(source, output) {
    const names = [];
    async function visit(relative = "") {
        for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
            const next = path.join(relative, entry.name);
            if (!sourceEntryIncluded(next, entry.isDirectory())) continue;
            if (/[\r\n\0]/.test(next)) throw new Error(`源码路径包含控制字符：${next}`);
            if (entry.isSymbolicLink()) throw new Error(`源码中存在符号链接，需先核对：${next}`);
            if (entry.isDirectory()) await visit(next);
            else if (entry.isFile()) names.push(next);
            else throw new Error(`源码包含非普通文件：${next}`);
        }
    }
    await visit();
    if (!names.includes("Dockerfile") || !names.includes(composeName) || !names.includes(".env.example")) throw new Error("源码快照缺少构建或部署文件");
    const list = `${output}.files`;
    await writeFile(list, Buffer.from(`${names.join("\0")}\0`), { mode: 0o600 });
    try { await run("tar", ["-czf", output, "-C", source, "--null", "-T", list]); }
    finally { await rm(list, { force: true }); }
}

async function saveImages(images, output) {
    const child = spawn("docker", ["image", "save", ...images], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`docker image save 失败：${code}`)));
    });
    await Promise.all([pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(output, { flags: "wx", mode: 0o600 })), exited]);
}

async function hashFile(filePath) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
    return { bytes, sha256: hash.digest("hex") };
}

async function artifact(root, file) { return { file, ...(await hashFile(path.join(root, file))) }; }
function composeArgs(deployment, projectName) { return ["compose", ...(projectName ? ["-p", projectName] : []), "--project-directory", deployment, "-f", path.join(deployment, composeName)]; }
function requiredValue(value, name) { if (!value || value === true) throw new Error(`必须提供 ${name}`); return value; }
function requiredPath(value, name) { return path.resolve(requiredValue(value, name)); }
function isWithin(parent, target) { const relative = path.relative(parent, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function safePath(root, relative) { if (path.isAbsolute(relative) || !relative || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || !isWithin(path.resolve(root), path.resolve(root, relative))) throw new Error(`备份路径越界：${relative}`); return path.join(root, relative); }
async function checkedFilePath(root, relative) {
    const file = safePath(root, relative);
    let current = path.resolve(root);
    for (const part of path.relative(root, file).split(path.sep)) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`备份路径包含符号链接：${relative}`);
    }
    if (!(await stat(file)).isFile()) throw new Error(`备份文件不是普通文件：${relative}`);
    return file;
}
async function verifySourceArchive(file, root) {
    const names = (await run("tar", ["-tzf", file], { capture: true })).trim().split("\n").filter(Boolean);
    for (const name of names) safePath(root, name);
    const verbose = (await run("tar", ["-tvzf", file], { capture: true })).trim().split("\n").filter(Boolean);
    if (!names.length || verbose.length !== names.length || verbose.some((line) => line[0] !== "-")) throw new Error("源码归档包含非普通文件或清单不完整");
    for (const required of ["Dockerfile", composeName, ".env.example", "web/package.json", "web/pnpm-lock.yaml"]) if (!names.includes(required)) throw new Error(`源码归档缺少 ${required}`);
}
function environmentValue(text, key) { return text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || ""; }
function setEnvironmentLine(value, key, replacement) { return new RegExp(`^${key}=`, "m").test(value) ? value.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${replacement}`) : `${value.trimEnd()}\n${key}=${replacement}\n`; }
function oldDomainKeys(text, oldDomain) { return text.split("\n").filter((line) => /^[A-Z_][A-Z_0-9]*=/.test(line) && line.includes(oldDomain)).map((line) => line.slice(0, line.indexOf("="))).filter((key) => key !== "NEXT_PUBLIC_SITE_URL"); }
async function readPassphrase(file) { const info = await stat(file); if (info.mode & 0o077) throw new Error("口令文件权限必须为 0600 或更严格"); const value = (await readFile(file, "utf8")).trimEnd(); if (value.length < 16) throw new Error("口令文件内容至少需要 16 个字符"); return value; }
async function requireFile(file) { if (!(await stat(file)).isFile()) throw new Error(`不是普通文件：${file}`); }
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function assertEmptyDirectory(target) { if (await exists(target) && (!(await lstat(target)).isDirectory() || (await readdir(target)).length)) throw new Error(`目标目录必须不存在或为空：${target}`); }
async function createEmptyDirectory(target) { await assertEmptyDirectory(target); await mkdir(target, { recursive: true, mode: 0o700 }); }

async function run(command, args, { cwd, capture = false } = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
        let output = "";
        if (capture) child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} ${args[0] || ""} 执行失败，退出码 ${code}`)));
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolPath) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
