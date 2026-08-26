import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HASH_ALGORITHM = "pbkdf2_sha256";
const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const PASSWORD_RESET_BACKUP_LIMIT = 3;
const PASSWORD_RESET_BACKUP_PATTERN = /^auth-password-reset-.+\.json$/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    printHelp();
    process.exit(0);
}

const dataDir = path.resolve(args.dataDir || process.env.VOZEB_PRO_DATA_DIR || path.join(webRoot, ".data"));
const authFile = path.join(dataDir, "auth.json");

if (args.listAdmins) {
    const db = await readAuthDb();
    listAdmins(db);
    process.exit(0);
}

if (!args.password) {
    fail("请通过 --password 指定新密码。");
}

if (args.password.length < 8) {
    fail("新密码至少需要 8 位。");
}

const db = await readAuthDb();
const user = findAdminUser(db);
const now = new Date().toISOString();
const backupFile = await backupAuthFile();

user.passwordHash = hashPassword(args.password);
user.updatedAt = now;
db.sessions = Array.isArray(db.sessions) ? db.sessions.filter((session) => session.userId !== user.id) : [];

await writeAuthDb(db);
const removedBackupCount = await prunePasswordResetBackups();

console.log(`管理员密码已重置：${user.username} (${user.displayName || "未设置昵称"})`);
console.log(`已清理该管理员旧登录会话，请使用新密码重新登录。`);
console.log(`原始账号数据库已备份：${backupFile}`);
if (removedBackupCount > 0) console.log(`已清理 ${removedBackupCount} 份旧密码重置备份，仅保留最近 ${PASSWORD_RESET_BACKUP_LIMIT} 份。`);

function parseArgs(argv) {
    const parsed = {
        dataDir: "",
        email: "",
        help: false,
        id: "",
        listAdmins: false,
        password: "",
        username: "",
    };

    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        const next = argv[index + 1];

        if (item === "--help" || item === "-h") parsed.help = true;
        else if (item === "--list-admins") parsed.listAdmins = true;
        else if (item === "--data-dir") {
            parsed.dataDir = readValue(item, next);
            index += 1;
        } else if (item === "--email") {
            parsed.email = readValue(item, next).trim().toLowerCase();
            index += 1;
        } else if (item === "--id") {
            parsed.id = readValue(item, next).trim();
            index += 1;
        } else if (item === "--password") {
            parsed.password = readValue(item, next);
            index += 1;
        } else if (item === "--username") {
            parsed.username = readValue(item, next).trim().toLowerCase();
            index += 1;
        } else {
            fail(`未知参数：${item}`);
        }
    }

    return parsed;
}

function readValue(name, value) {
    if (!value || value.startsWith("--")) fail(`${name} 缺少参数值。`);
    return value;
}

async function readAuthDb() {
    let raw = "";
    try {
        raw = await readFile(authFile, "utf8");
    } catch (error) {
        fail(`无法读取 ${authFile}，请确认数据目录是否正确。`);
    }

    try {
        const db = JSON.parse(raw);
        if (!db || typeof db !== "object" || !Array.isArray(db.users)) throw new Error("invalid auth database");
        return db;
    } catch {
        fail(`${authFile} 不是有效的账号数据库 JSON。`);
    }
}

function findAdminUser(db) {
    const admins = db.users.filter((user) => user?.role === "admin");

    if (!admins.length) {
        fail("账号数据库里没有管理员账号，已取消修改。");
    }

    if (!args.id && !args.username && !args.email) {
        listAdmins(db);
        fail("为避免误改账号，重置密码必须指定 --username、--email 或 --id。");
    }

    let matched = admins;
    if (args.id) matched = matched.filter((user) => user.id === args.id);
    if (args.username) matched = matched.filter((user) => String(user.username || "").toLowerCase() === args.username);
    if (args.email) matched = matched.filter((user) => String(user.email || "").toLowerCase() === args.email);

    if (matched.length === 1) return matched[0];

    if (!matched.length) {
        listAdmins(db);
        fail("没有找到匹配的管理员账号，请检查 --username、--email 或 --id。");
    }

    listAdmins(db);
    fail("匹配到多个管理员账号，请增加 --username、--email 或 --id 精确指定。");
}

async function backupAuthFile() {
    const backupDir = path.join(dataDir, "restore-backups");
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backupFile = path.join(backupDir, `auth-password-reset-${stamp}.json`);
    await writeFile(backupFile, await readFile(authFile, "utf8"), "utf8");
    return backupFile;
}

async function prunePasswordResetBackups() {
    const backupDir = path.join(dataDir, "restore-backups");
    const entries = await readdir(backupDir, { withFileTypes: true });
    const resetBackups = entries
        .filter((entry) => entry.isFile() && PASSWORD_RESET_BACKUP_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
    const removable = resetBackups.slice(PASSWORD_RESET_BACKUP_LIMIT);

    await Promise.all(removable.map((name) => unlink(path.join(backupDir, name))));
    return removable.length;
}

async function writeAuthDb(db) {
    const tempFile = `${authFile}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, "utf8");
    await rename(tempFile, authFile);
}

function hashPassword(password) {
    const salt = randomBytes(16).toString("base64url");
    const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("base64url");
    return `${HASH_ALGORITHM}$${ITERATIONS}$${salt}$${hash}`;
}

function listAdmins(db) {
    const admins = db.users.filter((user) => user?.role === "admin");
    if (!admins.length) {
        console.log("未找到管理员账号。");
        return;
    }

    console.log("管理员账号：");
    for (const user of admins) {
        console.log(`- username=${user.username || "-"} email=${user.email || "-"} id=${user.id || "-"} status=${user.status || "-"} displayName=${user.displayName || "-"}`);
    }
}

function printHelp() {
    console.log(`星启智域管理员密码重置

用法：
  node scripts/reset-admin-password.mjs --username admin --password "NewPass123!"

可选参数：
  --username <账号>       按登录用户名选择管理员
  --email <邮箱>          按邮箱选择管理员
  --id <用户ID>           按用户 ID 选择管理员
  --password <新密码>     设置新密码，至少 8 位
  --data-dir <目录>       指定数据目录，默认使用 VOZEB_PRO_DATA_DIR 或 web/.data
  --list-admins           只列出管理员账号，不修改密码
  --help                  查看帮助

说明：
  每次重置前会备份 auth.json，密码重置备份最多保留最近 3 份。
`);
}

function fail(message) {
    console.error(message);
    console.error("可先运行：node scripts/reset-admin-password.mjs --list-admins");
    process.exit(1);
}
