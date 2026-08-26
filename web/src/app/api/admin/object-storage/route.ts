import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { isAuthInputError } from "@/lib/auth/store";
import type { ObjectStorageSettingsUpdate } from "@/lib/object-storage-contract";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";
import { getObjectStorageAdminSettings, saveObjectStorageAdminSettings } from "@/lib/server/object-storage-config";
import { checkConfiguredObjectStorage } from "@/lib/server/object-storage-service";
import { hasAdminPermission } from "@/lib/admin-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const denied = await requireAdmin();
    if (denied) return denied;
    return NextResponse.json({ code: 0, data: await getObjectStorageAdminSettings(), msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "system.manage")) return NextResponse.json({ code: 403, data: null, msg: "当前管理员没有管理存储的职责权限" }, { status: 403 });
    try {
        const parsed = await readJsonBodyResult<Partial<ObjectStorageSettingsUpdate>>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data;
        const data = await saveObjectStorageAdminSettings({
            enabled: body.enabled === true,
            endpoint: stringValue(body.endpoint),
            region: stringValue(body.region),
            bucket: stringValue(body.bucket),
            prefix: stringValue(body.prefix),
            forcePathStyle: body.forcePathStyle === true,
            accessKeyId: stringValue(body.accessKeyId),
            secretAccessKey: stringValue(body.secretAccessKey),
            clearAccessKeyId: body.clearAccessKeyId === true,
            clearSecretAccessKey: body.clearSecretAccessKey === true,
        });
        await safeRecordAuditLog({
            action: "admin.object-storage.update",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "object_storage", id: "primary" },
            metadata: { enabled: body.enabled === true, forcePathStyle: body.forcePathStyle === true },
        });
        return NextResponse.json({ code: 0, data, msg: "外部存储配置已保存" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        await safeRecordAuditLog({
            action: "admin.object-storage.update",
            status: "failure",
            actor: auditActorFromRequest(request, currentUser),
            target: { type: "object_storage", id: "primary" },
            metadata: { error: error instanceof Error ? error.message : "unknown" },
        });
        const status = isAuthInputError(error) ? error.status : 400;
        return NextResponse.json({ code: status, data: null, msg: error instanceof Error ? error.message : "外部存储配置保存失败" }, { status });
    }
}

export async function POST() {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
        await checkConfiguredObjectStorage();
        return NextResponse.json({ code: 0, data: { available: true }, msg: "外部存储列表、写入和删除权限正常" });
    } catch (error) {
        console.error("Object storage connection test failed", error);
        return NextResponse.json({ code: 502, data: { available: false }, msg: error instanceof Error ? error.message : "外部存储连接检测失败" }, { status: 502 });
    }
}

async function requireAdmin() {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    return hasAdminPermission(user, "system.manage") ? null : NextResponse.json({ code: 403, data: null, msg: "当前管理员没有管理存储的职责权限" }, { status: 403 });
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}
