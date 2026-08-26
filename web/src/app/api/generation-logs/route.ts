import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { deleteGenerationLogs, listGenerationLogs, listUserGenerationLogsForDelete } from "@/lib/server/generation-log-store";
import { deleteGenerationLogResultsForUser, GenerationLogDraftValidationError, GenerationLogOwnershipError, recordGenerationLogDraft, renameGenerationLogForUser } from "@/lib/server/generation-log-task-service";
import type { GenerationLogInput } from "@/lib/server/generation-log-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") || 1);
    const pageSize = Number(url.searchParams.get("pageSize") || 100);
    const kind = url.searchParams.get("kind") || undefined;
    const source = url.searchParams.get("source") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const keyword = url.searchParams.get("keyword") || undefined;
    return NextResponse.json(await listGenerationLogs({ page, pageSize, kind, source, status, keyword, userId: currentUser.id }));
}

export async function POST(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const body = await readJsonBody<Omit<GenerationLogInput, "userId" | "username" | "displayName">>(request, 5 * 1024 * 1024);
    if (body.status !== "pending") return NextResponse.json({ error: "生成结果和终态只能由服务端任务写入" }, { status: 403 });
    if (body.assets?.length || body.taskId || body.error || body.completedAt) return NextResponse.json({ error: "浏览器不能提交生成结果、任务终态或结果地址" }, { status: 403 });
    if (body.source !== "image-workbench" && body.source !== "video-workbench") return NextResponse.json({ error: "当前入口不允许浏览器登记生成记录" }, { status: 403 });
    try {
        const log = await recordGenerationLogDraft({ ...body, userId: currentUser.id, username: currentUser.username, displayName: currentUser.displayName });
        return NextResponse.json({ log });
    } catch (error) {
        if (error instanceof GenerationLogDraftValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
        if (error instanceof GenerationLogOwnershipError) return NextResponse.json({ error: "生成记录不存在" }, { status: 404 });
        throw error;
    }
}

export async function PATCH(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const body = await readJsonBody<{ action?: string; id?: string; title?: string; slotIds?: string[] }>(request);
    const id = String(body.id || "").trim();
    if (!id) return NextResponse.json({ error: "生成记录 ID 不能为空" }, { status: 400 });
    try {
        if (body.action === "rename") {
            const log = await renameGenerationLogForUser(currentUser.id, id, String(body.title || ""));
            return log ? NextResponse.json({ log }) : NextResponse.json({ error: "生成记录不存在或标题为空" }, { status: 404 });
        }
        if (body.action === "delete-results") {
            const log = await deleteGenerationLogResultsForUser(currentUser.id, id, Array.isArray(body.slotIds) ? body.slotIds : []);
            return log ? NextResponse.json({ log }) : NextResponse.json({ error: "生成记录或结果不存在" }, { status: 404 });
        }
    } catch (error) {
        if (error instanceof GenerationLogOwnershipError) return NextResponse.json({ error: "生成记录不存在" }, { status: 404 });
        throw error;
    }
    return NextResponse.json({ error: "不支持的生成记录操作" }, { status: 400 });
}

export async function DELETE(request: Request) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    const body = await readJsonBody<{ ids?: string[] }>(request);
    const requestedIds = Array.isArray(body.ids) ? Array.from(new Set(body.ids.map((id) => id.trim()).filter(Boolean))) : [];
    if (!requestedIds.length) return NextResponse.json({ deleted: 0 });

    const deletableIds = (await listUserGenerationLogsForDelete(currentUser.id, requestedIds)).map((log) => log.id);
    if (!deletableIds.length) return NextResponse.json({ deleted: 0 });

    return NextResponse.json(await deleteGenerationLogs(deletableIds, { cascadeUserMedia: true }));
}
