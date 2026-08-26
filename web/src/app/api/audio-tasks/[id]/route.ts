import { after, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getAudioTask, transitionAudioTask } from "@/lib/server/audio-task-store";
import { refundAudioTask } from "@/lib/server/audio-task-refund";
import { pointsResponseHeaders } from "@/lib/server/points-response";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { generationModelId } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { cancellationExecutionPatch, type GenerationCancellationTarget } from "@/lib/server/generation-task-cancellation-service";
import { getStoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { recoverGenerationTaskFromUpstream } from "@/lib/server/generation-task-user-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const task = await getAudioTask((await params).id);
    if (!task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
    const shouldRefund = Boolean(task.billing?.pointsRecordId && !task.billing.refunded && task.status === "error");
    const settledTask = shouldRefund ? await refundAudioTask(task) : task;
    const refreshedUser = shouldRefund ? await getCurrentUser(request) : user;
    return NextResponse.json({ task: { ...publicTask(settledTask), needsReview: task.executionPhase === "needs_review", reviewReason: task.reviewReason, executionPhase: task.executionPhase } }, { headers: pointsResponseHeaders(refreshedUser) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    const task = user ? await getAudioTask((await params).id) : null;
    if (!user || !task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "任务不存在或已过期" }, { status: user ? 404 : 401 });
    const parsed = await readJsonBodyResult<{ action?: string }>(request);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    if (parsed.data.action !== "recover") return NextResponse.json({ error: "不支持的音频任务操作" }, { status: 400 });
    if (task.status === "success") return NextResponse.json({ task: publicTask(task) }, { headers: pointsResponseHeaders(user) });
    if (task.status !== "running") return NextResponse.json({ error: "当前音频任务无法继续检查" }, { status: 409 });

    const schedule = await getStoredGenerationTaskRecord("audio", task.id);
    const upstreamTaskId = task.upstream?.id || schedule?.upstreamTaskId;
    if (!upstreamTaskId) return NextResponse.json({ error: "原任务没有保存上游任务 ID，无法安全追回结果" }, { status: 409 });
    const recovered = await recoverGenerationTaskFromUpstream({
        type: "audio",
        id: task.id,
        upstreamTaskId,
        channelId: task.config.channelId,
        provider: task.config.advancedConfig?.protocol || task.config.apiFormat,
        queryPath: schedule?.queryPath || task.config.advancedConfig?.queryPath,
        submittedAt: schedule?.submittedAt || task.createdAt,
        origin: resolveInternalOrigin(new URL(request.url).origin),
        cookie: request.headers.get("cookie") || "",
    });
    if (!recovered) return NextResponse.json({ error: "音频任务状态已变化，请刷新后重试" }, { status: 409 });
    const latest = await getAudioTask(task.id);
    const latestSchedule = await getStoredGenerationTaskRecord("audio", task.id);
    if (!latest) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
    return NextResponse.json(
        { task: { ...publicTask(latest), needsReview: latestSchedule?.executionPhase === "needs_review", reviewReason: latestSchedule?.executionPhase === "needs_review" ? latest.reviewReason : undefined, executionPhase: latestSchedule?.executionPhase } },
        { headers: pointsResponseHeaders(latest.status === "error" ? await getCurrentUser(request) : user) },
    );
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser(request);
    const task = user ? await getAudioTask((await params).id) : null;
    if (!user || !task || (task.userId !== user.id && user.role !== "admin")) return NextResponse.json({ error: "任务不存在或已过期" }, { status: user ? 404 : 401 });
    const parsed = await readJsonBodyResult<{ status?: string }>(request);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    if (body.status !== "cancelled" || !["pending", "running"].includes(task.status)) return NextResponse.json({ error: "当前任务无法取消" }, { status: 409 });
    const target: GenerationCancellationTarget = {
        type: "audio",
        taskId: task.id,
        userId: task.userId,
        executionPhase: task.executionPhase,
        upstreamTaskId: task.upstream?.id,
        queryPath: task.config.advancedConfig?.queryPath,
        config: task.config,
    };
    const next = await transitionAudioTask(task, ["pending", "running"], { status: "cancelled", error: "任务已取消", billing: task.billing }, cancellationExecutionPatch(target));
    if (!next) return NextResponse.json({ error: "当前任务无法取消" }, { status: 409 });
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    after(() => runGenerationTaskRecoveryBatch({ origin, limit: 1, taskIds: [task.id] }));
    const refreshedUser = await getCurrentUser(request);
    return NextResponse.json({ task: publicTask(next) }, { headers: pointsResponseHeaders(refreshedUser) });
}

function publicTask(task: NonNullable<Awaited<ReturnType<typeof getAudioTask>>>) {
    return {
        id: task.id,
        status: task.status,
        model: generationModelId(task.config),
        result: task.result,
        error: task.error,
        billing: task.billing ? { pointsCost: task.billing.pointsCost, refunded: task.billing.refunded } : undefined,
    };
}
