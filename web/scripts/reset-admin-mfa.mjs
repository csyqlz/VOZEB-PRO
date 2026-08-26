import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
    printHelp();
    process.exit(0);
}

try {
    if (databaseProvider() === "file") await resetFileProvider();
    else await resetPostgresProvider();
} catch (error) {
    console.error(error instanceof Error ? error.message : "管理员 MFA 重置失败");
    process.exitCode = 1;
}

async function resetPostgresProvider() {
    const connectionString = process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim() || "";
    if (!connectionString) fail("PostgreSQL 模式缺少 DATABASE_URL 或 POSTGRES_URL。");
    const client = new Client({ connectionString, ssl: postgresSslConfig() });
    await client.connect();
    try {
        if (args.listAdmins) {
            listAdmins((await client.query("SELECT id, username, email, status, mfa_enabled_at FROM vozeb_pro_users WHERE role = 'admin' ORDER BY created_at ASC")).rows);
            return;
        }
        const selector = adminSelector();
        await client.query("BEGIN");
        const result = await client.query(`SELECT id, username, email, status, mfa_secret_ciphertext, mfa_enabled_at FROM vozeb_pro_users WHERE role = 'admin' AND ${selector.sql} FOR UPDATE`, selector.values);
        const user = exactAdmin(result.rows);
        if (!user.mfa_secret_ciphertext && !user.mfa_enabled_at) fail("指定管理员没有可重置的 MFA 设置。");
        await client.query("UPDATE vozeb_pro_users SET mfa_secret_ciphertext = NULL, mfa_enabled_at = NULL, updated_at = now() WHERE id = $1", [user.id]);
        await client.query("DELETE FROM vozeb_pro_sessions WHERE user_id = $1", [user.id]);
        await client.query("COMMIT");
        console.log(`管理员 MFA 已重置：${user.username}`);
        console.log("该管理员的登录会话已全部撤销，请使用账号密码重新登录并设置 MFA。");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        await client.end();
    }
}

async function resetFileProvider() {
    const dataDir = path.resolve(args.dataDir || process.env.VOZEB_PRO_DATA_DIR || path.join(webRoot, ".data"));
    const authFile = path.join(dataDir, "auth.json");
    const raw = await readFile(authFile, "utf8").catch(() => fail(`无法读取 ${authFile}，请确认数据目录是否正确。`));
    const db = parseAuthDb(raw, authFile);
    if (args.listAdmins) {
        listAdmins(db.users.filter((user) => user?.role === "admin"));
        return;
    }
    const user = exactAdmin(filterAdmins(db.users));
    if (!user.mfaSecretCiphertext && !user.mfaEnabledAt) fail("指定管理员没有可重置的 MFA 设置。");
    const backupDir = path.join(dataDir, "restore-backups");
    await mkdir(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `auth-mfa-reset-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`);
    await writeFile(backupFile, raw, "utf8");
    user.mfaSecretCiphertext = undefined;
    user.mfaEnabledAt = undefined;
    user.updatedAt = new Date().toISOString();
    db.sessions = Array.isArray(db.sessions) ? db.sessions.filter((session) => session.userId !== user.id) : [];
    const tempFile = `${authFile}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, "utf8");
    await rename(tempFile, authFile);
    console.log(`管理员 MFA 已重置：${user.username}`);
    console.log("该管理员的登录会话已全部撤销，请使用账号密码重新登录并设置 MFA。");
    console.log(`原始账号数据库已备份：${backupFile}`);
}

function parseArgs(argv) {
    const parsed = { dataDir: "", email: "", help: false, id: "", listAdmins: false, username: "" };
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
        } else if (item === "--username") {
            parsed.username = readValue(item, next).trim().toLowerCase();
            index += 1;
        } else fail(`未知参数：${item}`);
    }
    return parsed;
}

function readValue(name, value) {
    if (!value || value.startsWith("--")) fail(`${name} 缺少参数值。`);
    return value;
}

function adminSelector() {
    const clauses = [];
    const values = [];
    if (args.id) {
        values.push(args.id);
        clauses.push(`id = $${values.length}`);
    }
    if (args.username) {
        values.push(args.username);
        clauses.push(`lower(username) = $${values.length}`);
    }
    if (args.email) {
        values.push(args.email);
        clauses.push(`lower(coalesce(email, '')) = $${values.length}`);
    }
    if (!clauses.length) fail("为避免误改账号，必须指定 --username、--email 或 --id。");
    return { sql: clauses.join(" AND "), values };
}

function filterAdmins(users) {
    adminSelector();
    return users.filter((user) => user?.role === "admin" && (!args.id || user.id === args.id) && (!args.username || String(user.username || "").toLowerCase() === args.username) && (!args.email || String(user.email || "").toLowerCase() === args.email));
}

function exactAdmin(users) {
    if (users.length === 1) return users[0];
    if (!users.length) fail("没有找到匹配的管理员账号。");
    fail("匹配到多个管理员账号，请增加筛选条件精确指定。");
}

function listAdmins(users) {
    if (!users.length) {
        console.log("未找到管理员账号。");
        return;
    }
    console.log("管理员账号：");
    for (const user of users) {
        const enabled = Boolean(user.mfaEnabledAt || user.mfa_enabled_at);
        console.log(`- username=${user.username || "-"} email=${user.email || "-"} id=${user.id || "-"} status=${user.status || "-"} mfa=${enabled ? "enabled" : "disabled"}`);
    }
}

function parseAuthDb(raw, authFile) {
    try {
        const db = JSON.parse(raw);
        if (!db || typeof db !== "object" || !Array.isArray(db.users)) throw new Error("invalid auth database");
        return db;
    } catch {
        fail(`${authFile} 不是有效的账号数据库 JSON。`);
    }
}

function databaseProvider() {
    return process.env.VOZEB_PRO_DATABASE_PROVIDER?.trim().toLowerCase() === "file" ? "file" : "postgres";
}

function postgresSslConfig() {
    if (!["1", "true", "yes", "on"].includes(process.env.VOZEB_PRO_DATABASE_SSL?.trim().toLowerCase() || "")) return undefined;
    const rejectUnauthorized = !["0", "false", "no", "off"].includes(process.env.VOZEB_PRO_DATABASE_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() || "");
    const ca = process.env.VOZEB_PRO_DATABASE_SSL_CA?.trim().replace(/\\n/g, "\n") || "";
    return { rejectUnauthorized, ...(ca ? { ca } : {}) };
}

function printHelp() {
    console.log(`星启智域管理员 MFA 恢复

用法：
  pnpm reset:admin-mfa -- --username admin

可选参数：
  --username <账号>       按登录用户名选择管理员
  --email <邮箱>          按邮箱选择管理员
  --id <用户ID>           按用户 ID 选择管理员
  --data-dir <目录>       文件 Provider 数据目录
  --list-admins           只列出管理员及 MFA 状态
  --help                  查看帮助
`);
}

function fail(message) {
    throw new Error(message);
}
