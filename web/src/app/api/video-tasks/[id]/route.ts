import { after, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getVideoTask, transitionVideoTask } from "@/lib/server/video-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { pointsResponseHeaders } from "@/lib/server/points-response";
import { generationModelId } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { cancellationExecutionPatch, type GenerationCancellationTarget } from "@/lib/server/generation-task-cancellation-service";
import { refundVideoTask } from "@/lib/server/video-task-refund";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { writeVideoGenerationLog } from "@/lib/server/video-task-log";
import { recoverGenerationTaskFromUpstream } from "@/lib/server/generation-task-user-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    const task = user ? await getVideoTask((await params).id) : null;
    if (!user || !task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "视频任务不存在" }, { status: user ? 404 : 401 });
    const schedule = await getStoredGenerationTaskRecord("video", task.id);
    const executionPhase = schedule?.executionPhase || settledExecutionPhase(task.status);
    const shouldRefund = Boolean(task.upstream.pointsRecordId && !task.upstream.refunded && task.status === "error");
    const settledTask = shouldRefund ? await refundVideoTask(task) : task;
    const refreshedUser = shouldRefund ? await getCurrentUser(request) : user;
    return NextResponse.json(
        { task: { ...publicTask(settledTask), needsReview: executionPhase === "needs_review", reviewReason: executionPhase === "needs_review" ? task.reviewReason : undefined, executionPhase } },
        { headers: pointsResponseHeaders(refreshedUser) },
    );
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    const task = user ? await getVideoTask((await params).id) : null;
    if (!user || !task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "视频任务不存在" }, { status: user ? 404 : 401 });
    const parsed = await readJsonBodyResult<{ action?: string }>(request);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    if (parsed.data.action !== "recover") return NextResponse.json({ error: "不支持的视频任务操作" }, { status: 400 });
    if (task.status === "success") return NextResponse.json({ task: publicTask(task) }, { headers: pointsResponseHeaders(user) });
    if (task.status !== "running") return NextResponse.json({ error: "当前视频任务无法继续检查" }, { status: 409 });

    const schedule = await getStoredGenerationTaskRecord("video", task.id);
    const upstreamTaskId = task.upstream.id || schedule?.upstreamTaskId;
    if (!upstreamTaskId) return NextResponse.json({ error: "原任务没有保存上游任务 ID，无法安全追回结果" }, { status: 409 });
    const recovered = await recoverGenerationTaskFromUpstream({
        type: "video",
        id: task.id,
        upstreamTaskId,
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        queryPath: task.upstream.queryPath || schedule?.queryPath || task.config.advancedConfig?.queryPath,
        submittedAt: schedule?.submittedAt || task.createdAt,
        origin: resolveInternalOrigin(new URL(request.url).origin),
        cookie: request.headers.get("cookie") || "",
    });
    if (!recovered) return NextResponse.json({ error: "视频任务状态已变化，请刷新后重试" }, { status: 409 });
    const latest = await getVideoTask(task.id);
    const latestSchedule = await getStoredGenerationTaskRecord("video", task.id);
    if (!latest) return NextResponse.json({ error: "视频任务不存在" }, { status: 404 });
    return NextResponse.json(
        { task: { ...publicTask(latest), needsReview: latestSchedule?.executionPhase === "needs_review", reviewReason: latestSchedule?.executionPhase === "needs_review" ? latest.reviewReason : undefined, executionPhase: latestSchedule?.executionPhase } },
        { headers: pointsResponseHeaders(latest.status === "error" ? await getCurrentUser(request) : user) },
    );
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    const id = (await params).id;
    const task = user ? await getVideoTask(id) : null;
    if (!user || !task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "视频任务不存在" }, { status: user ? 404 : 401 });
    const schedule = await getStoredGenerationTaskRecord("video", task.id);
    const executionPhase = schedule?.executionPhase || settledExecutionPhase(task.status);
    const parsed = await readJsonBodyResult<{ action?: string; status?: string; result?: unknown; error?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    if (body.result !== undefined || body.error !== undefined || (body.status && body.status !== "cancelled")) {
        return NextResponse.json({ error: "视频任务终态和结果只能由服务端更新" }, { status: 403 });
    }
    if (body.action !== "cancel" && body.status !== "cancelled") return NextResponse.json({ error: "不支持的视频任务操作" }, { status: 400 });
    if (task.status !== "running") return NextResponse.json({ error: "当前任务无法取消" }, { status: 409 });
    const target: GenerationCancellationTarget = {
        type: "video",
        taskId: task.id,
        userId: task.userId,
        executionPhase,
        upstreamTaskId: task.upstream.id,
        queryPath: task.config.advancedConfig?.queryPath,
        config: task.config,
    };
    const next = await transitionVideoTask(task, { status: "cancelled", error: "任务已取消", retryable: false }, cancellationExecutionPatch(target));
    if (!next) return NextResponse.json({ error: "当前任务状态无法修改" }, { status: 409 });
    await writeVideoGenerationLog(next, "failed", "任务已取消", false).catch((error) => console.warn("Cancelled video generation log update failed", { taskId: task.id, error }));
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    after(() => runGenerationTaskRecoveryBatch({ origin, limit: 1, taskIds: [task.id] }));
    const refreshedUser = await getCurrentUser();
    return NextResponse.json({ task: publicTask(next) }, { headers: pointsResponseHeaders(refreshedUser) });
}

type VideoTask = NonNullable<Awaited<ReturnType<typeof getVideoTask>>>;

function publicTask(task: VideoTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), upstreamId: task.upstream.id, durationSeconds: task.requestedDurationSeconds, result: task.result, error: task.error, canRetry: task.retryable === true };
}

function settledExecutionPhase(status: string) {
    return status === "pending" || status === "running" ? "created" : "completed";
}
