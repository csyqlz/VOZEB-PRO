import { ALL_ADMIN_PERMISSIONS, hasAdminPermission, hasAllAdminPermissions } from "@/lib/admin-permissions";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { encryptAuthDbSecretsForStorage } from "@/lib/auth/store-normalizers";
import { mergeAuthBackupSecrets } from "@/lib/server/admin-backup-policy";
import { readAdminBackupData, restoreAdminBackupData, type AdminBackupData } from "@/lib/server/admin-backup-store";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getDatabaseProvider } from "@/lib/server/database";
import { copyDataFile, ensureDataDirectory, listDataDirectory, removeDataPath, resolveDataPath, writeJsonDataFile } from "@/lib/server/data-adapter";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESTORE_FILE_MAP = {
    auth: "auth.json",
    prompts: "prompts.json",
    generationLogs: "generation-logs.json",
    accountDeletionRequests: "account-deletion-requests.json",
} as const;
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
const MAX_IMPORT_REQUEST_BYTES = MAX_IMPORT_BYTES + 64 * 1024;
const RESTORE_IMPORT_BACKUP_LIMIT = 3;
const RESTORE_IMPORT_BACKUP_PATTERN = /^\d{4}-\d{2}-\d{2}T.+Z$/;

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "system.manage")) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) return NextResponse.json({ error: "备份上传格式不正确" }, { status: 400 });
    let formData: FormData;
    try {
        const bytes = await readRequestBodyBytes(request, MAX_IMPORT_REQUEST_BYTES);
        formData = await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "备份文件过大，请确认文件是否正确" }, { status: error.status });
        return NextResponse.json({ error: "备份上传格式不正确" }, { status: 400 });
    }
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择要导入的备份文件" }, { status: 400 });
    if (file.size > MAX_IMPORT_BYTES) return NextResponse.json({ error: "备份文件过大，请确认文件是否正确" }, { status: 400 });

    let parsed: unknown;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        return NextResponse.json({ error: "备份文件不是有效 JSON" }, { status: 400 });
    }

    const files = extractBackupFiles(parsed);
    const restoreMode = extractRestoreMode(parsed);
    if (restoreMode === "disaster") return NextResponse.json({ error: "当前业务 JSON 备份不包含数据库、媒体和对象存储完整清单，不能用于整库灾难恢复" }, { status: 400 });
    try {
        validateBackupFiles(files);
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "备份文件格式不正确" }, { status: 400 });
    }
    if (files.auth !== undefined && files.auth !== null && !hasAllAdminPermissions(currentUser, ALL_ADMIN_PERMISSIONS)) {
        return NextResponse.json({ error: "导入用户账户备份需要全权限管理员" }, { status: 403 });
    }
    const currentData = await readAdminBackupData();
    const currentAuth = files.auth === undefined || files.auth === null ? null : currentData.auth;
    const entries = Object.entries(RESTORE_FILE_MAP)
        .map(([key, fileName]) => ({ key, fileName, value: files[key as keyof BackupFiles] }))
        .filter((entry) => entry.value !== undefined && entry.value !== null);
    if (!entries.length) return NextResponse.json({ error: "备份文件里没有可导入的数据" }, { status: 400 });

    let values: Array<(typeof entries)[number] & { value: unknown }>;
    try {
        values = entries.map((entry) => ({ ...entry, value: entry.key === "auth" ? mergeAuthBackupSecrets(entry.value, currentAuth) : entry.value }));
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "认证备份不能安全导入" }, { status: 400 });
    }

    const importedAt = new Date().toISOString();
    const safetyBackupName = importedAt.replace(/[:.]/g, "-");
    const safetyBackupPath = `restore-backups/${safetyBackupName}`;
    const safetyBackupDir = resolveDataPath(safetyBackupPath);
    const valueByKey = new Map(values.map((entry) => [entry.key, entry.value]));
    let removedSafetyBackups = 0;
    try {
        await ensureDataDirectory(safetyBackupPath);
        await createSafetyBackup(currentData, safetyBackupPath);
        await restoreAdminBackupData(
            {
                auth: (valueByKey.get("auth") ?? currentData.auth) as AdminBackupData["auth"],
                prompts: (valueByKey.get("prompts") ?? currentData.prompts) as AdminBackupData["prompts"],
                generationLogs: (valueByKey.get("generationLogs") ?? currentData.generationLogs) as AdminBackupData["generationLogs"],
                accountDeletionRequests: (valueByKey.get("accountDeletionRequests") ?? currentData.accountDeletionRequests) as AdminBackupData["accountDeletionRequests"],
            },
            { mode: "account-config", preserveCurrentAuth: !valueByKey.has("auth") },
        );
        removedSafetyBackups = await pruneRestoreImportBackups();
        await safeRecordAuditLog({
            action: "admin.backup.restore",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "backup", id: safetyBackupName },
            metadata: { mode: "account-config", imported: values.map((entry) => entry.key) },
        });
    } catch (error) {
        await safeRecordAuditLog({
            action: "admin.backup.restore",
            status: "failure",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "backup", id: safetyBackupName },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        console.error("Admin backup restore failed", error);
        return NextResponse.json({ error: "备份恢复失败，原数据未被确认替换" }, { status: 500 });
    }

    return NextResponse.json({
        ok: true,
        mode: "account-config",
        imported: values.map((entry) => entry.key),
        safetyBackupDir,
        removedSafetyBackups,
    });
}

type BackupFiles = {
    auth?: unknown;
    prompts?: unknown;
    generationLogs?: unknown;
    accountDeletionRequests?: unknown;
};

function extractBackupFiles(value: unknown): BackupFiles {
    const root = isRecord(value) ? value : {};
    const files = isRecord(root.files) ? root.files : root;
    return {
        auth: files.auth,
        prompts: files.prompts,
        generationLogs: files.generationLogs ?? files["generation-logs"],
        accountDeletionRequests: files.accountDeletionRequests ?? files["account-deletion-requests"],
    };
}

function extractRestoreMode(value: unknown) {
    if (!isRecord(value)) return "account-config" as const;
    return value.backupType === "disaster" ? ("disaster" as const) : ("account-config" as const);
}

function validateBackupFiles(files: BackupFiles) {
    if (files.auth !== undefined && files.auth !== null) validateAuthBackup(files.auth);
    if (files.prompts !== undefined && files.prompts !== null) validateArrayDatabase(files.prompts, "prompts", "公共提示词备份格式不正确");
    if (files.generationLogs !== undefined && files.generationLogs !== null) validateArrayDatabase(files.generationLogs, "logs", "生成日志备份格式不正确");
    if (files.accountDeletionRequests !== undefined && files.accountDeletionRequests !== null) validateArrayDatabase(files.accountDeletionRequests, "requests", "注销申请备份格式不正确");
}

function validateAuthBackup(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.users) || !isRecord(value.settings)) throw new Error("用户数据库备份格式不正确");
}

function validateArrayDatabase(value: unknown, key: string, message: string) {
    if (!isRecord(value) || !Array.isArray(value[key])) throw new Error(message);
}

async function copyCurrentDataFile(fileName: string, targetFileName: string) {
    try {
        await copyDataFile(fileName, targetFileName);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

async function createSafetyBackup(data: AdminBackupData, targetPath: string) {
    if (getDatabaseProvider() === "postgres") {
        await Promise.all([
            writeJsonDataFile(`${targetPath}/auth.json`, encryptAuthDbSecretsForStorage(data.auth)),
            writeJsonDataFile(`${targetPath}/prompts.json`, data.prompts),
            writeJsonDataFile(`${targetPath}/generation-logs.json`, data.generationLogs),
            writeJsonDataFile(`${targetPath}/account-deletion-requests.json`, data.accountDeletionRequests),
        ]);
        return;
    }
    await Promise.all(Object.values(RESTORE_FILE_MAP).map((fileName) => copyCurrentDataFile(fileName, `${targetPath}/${fileName}`)));
}

async function pruneRestoreImportBackups() {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
        entries = await listDataDirectory("restore-backups");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }

    const importBackups = entries
        .filter((entry) => entry.isDirectory() && RESTORE_IMPORT_BACKUP_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
    const removable = importBackups.slice(RESTORE_IMPORT_BACKUP_LIMIT);

    await Promise.all(removable.map((name) => removeDataPath(`restore-backups/${name}`)));
    return removable.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
