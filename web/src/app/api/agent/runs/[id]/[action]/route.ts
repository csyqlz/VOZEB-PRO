import { after, NextResponse } from "next/server";
import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { abortAgentRun } from "@/lib/server/agent-run-executor";
import { getAgentRun, setAgentRunStatus, updateAgentRunById, type AgentRun, type AgentRunStatus } from "@/lib/server/agent-run-store";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { publicAgentRun } from "@/lib/server/agent-run-public";
import { publicAgentRunForRequest } from "@/lib/server/agent-run-public-selection";
import { prepareEcommerceSceneSelectionResume } from "@/lib/server/ecommerce-generation-service";
import { parseCreativeReferenceRecovery, REFERENCE_CHECKPOINT_REASONS } from "@/lib/server/ecommerce-reference-recovery";
import { recoverEcommerceReferences } from "@/lib/server/ecommerce-reference-recovery-service";

export const maxDuration = 2400;

const actions: Record<string, AgentRunStatus> = { pause: "paused", resume: "running" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const { id, action } = await params;
    const parsed = await readJsonBodyResult<{ conversationId?: unknown; sceneSelection?: unknown; referenceRecovery?: unknown }>(request);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    const expectedConversationId = typeof body?.conversationId === "string" ? body.conversationId.trim() : "";
    if (body?.conversationId !== undefined && !expectedConversationId) return NextResponse.json({ code: 400, data: null, msg: "对话标识无效" }, { status: 400 });
    const status = actions[action];
    if (!status && action !== "retry" && action !== "cancel") return NextResponse.json({ code: 400, data: null, msg: "不支持的 Agent 操作" }, { status: 400 });
    const run = await getAgentRun(id);
    if (!run || (run.userId !== user.id && user.role !== "admin")) return NextResponse.json({ code: 404, data: null, msg: "Agent 任务不存在" }, { status: 404 });
    if (expectedConversationId && run.conversationId !== expectedConversationId) return NextResponse.json({ code: 409, data: null, msg: "当前对话与 Agent 任务不匹配" }, { status: 409 });
    if (action === "retry" && (run.status !== "failed" || run.tasks.length)) return NextResponse.json({ code: 409, data: null, msg: "只有规划阶段失败的任务可以整体重试" }, { status: 409 });
    if (action === "pause" && !["planning", "running"].includes(run.status)) return NextResponse.json({ code: 409, data: null, msg: "当前任务无法暂停" }, { status: 409 });
    if (action === "resume" && (run.status !== "paused" || run.cancellation)) return NextResponse.json({ code: 409, data: null, msg: run.cancellation ? "任务正在取消，无法恢复" : "只有暂停中的任务可以恢复" }, { status: 409 });
    if (action === "resume" && run.ecommerceSnapshot?.fallback?.reason === "reference_source_changed") return NextResponse.json({ code: 409, data: null, msg: "原参考图片内容已变化，请重新选择原图开始创作。" }, { status: 409 });
    if (body?.referenceRecovery !== undefined) {
        if (action !== "resume" || body.sceneSelection !== undefined || !expectedConversationId) return NextResponse.json({ code: 400, data: null, msg: "参考恢复必须对应原对话，且不能同时提交编辑区域" }, { status: 400 });
        let recovery;
        try {
            recovery = parseCreativeReferenceRecovery(body.referenceRecovery);
        } catch (error) {
            return NextResponse.json({ code: 400, data: null, msg: error instanceof Error ? error.message : "参考恢复操作无效" }, { status: 400 });
        }
        const limit = (await getAuthSettings()).generationConcurrency.agent;
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const cookie = request.headers.get("cookie") || "";
        try {
            const result = await withGenerationConcurrencyLimit(
                run.userId,
                "agent",
                10 * 60 * 1000,
                limit,
                async () => ({ updated: await recoverEcommerceReferences({ run, recovery, actorId: user.id, conversationId: expectedConversationId, origin, cookie }) }),
                run.id,
            );
            if (result === null) return NextResponse.json({ code: 429, data: null, msg: `当前最多同时运行 ${limit} 个 Agent 任务` }, { status: 429 });
            if (!result.updated) return NextResponse.json({ code: 409, data: null, msg: "参考复核或素材状态已变化，请刷新后重试" }, { status: 409 });
            after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [result.updated!.id] }));
            return NextResponse.json({ code: 0, data: { run: await publicAgentRunForRequest(result.updated, request) }, msg: "OK" });
        } catch {
            return NextResponse.json({ code: 409, data: null, msg: "参考图片无法核对，请检查素材后重试" }, { status: 409 });
        }
    }
    if (action === "resume" && REFERENCE_CHECKPOINT_REASONS.has(run.ecommerceSnapshot?.fallback?.reason || "") && run.tasks.every((task) => !task.attempts && !task.taskId && !task.taskIds?.length && !task.childTasks?.length))
        return NextResponse.json({ code: 409, data: null, msg: run.ecommerceSnapshot?.referenceCheckpoint ? "请使用本轮参考用途确认或重新分析入口" : "这条历史任务无法直接继续，请重新选择原图片开始创作。" }, { status: 409 });
    let selectedTasks: AgentRun["tasks"] | undefined;
    if (body?.sceneSelection !== undefined || (action === "resume" && run.ecommerceSnapshot?.fallback?.reason === "scene_selection_required" && !run.tasks.some((task) => task.sceneProtection))) {
        if (action !== "resume" || !body?.sceneSelection) return NextResponse.json({ code: 409, data: null, msg: "请在原图上确认允许编辑的区域，包含新增物体及其接触阴影" }, { status: 409 });
        try {
            selectedTasks = await prepareEcommerceSceneSelectionResume(run, body.sceneSelection, resolveInternalOrigin(new URL(request.url).origin), request.headers.get("cookie") || "", user.id);
        } catch (error) {
            return NextResponse.json({ code: 409, data: null, msg: error instanceof Error ? error.message : "编辑区域无法确认" }, { status: 409 });
        }
    }
    const limit = action === "resume" || action === "retry" ? (await getAuthSettings()).generationConcurrency.agent : 0;
    if (action === "cancel" && ["completed", "failed", "cancelled"].includes(run.status)) return NextResponse.json({ code: 409, data: null, msg: "当前任务无法取消" }, { status: 409 });
    if (action === "cancel") return cancelAgentRun(request, run);
    if (action !== "resume") abortAgentRun(run.id);
    const mutate = async () => ({
        updated:
            action === "retry"
                ? await updateAgentRunById(
                      run.id,
                      {
                          status: "planning",
                          executionId: undefined,
                          tasks: [],
                          foundation: undefined,
                          projectHandoff: undefined,
                          projectHandoffEmitted: undefined,
                          review: undefined,
                          reviewed: false,
                          assetIds: [],
                          failure: undefined,
                          failureStage: undefined,
                          candidateFailures: undefined,
                      },
                      { type: "run.retry.requested" },
                      ["failed"],
                  )
                : selectedTasks
                  ? await updateAgentRunById(run.id, { status: "running", executionId: undefined, tasks: selectedTasks }, { type: "run.resumed" }, ["paused"], undefined, run.tasks)
                  : await setAgentRunStatus(run, status!),
    });
    const result = action === "resume" || action === "retry" ? await withGenerationConcurrencyLimit(run.userId, "agent", 10 * 60 * 1000, limit, mutate, run.id) : await mutate();
    if (result === null) return NextResponse.json({ code: 429, data: null, msg: `当前最多同时运行 ${limit} 个 Agent 任务` }, { status: 429 });
    const { updated } = result;
    if (!updated) return NextResponse.json({ code: 409, data: null, msg: "Agent 状态已变化，请刷新后重试" }, { status: 409 });
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    const cookie = request.headers.get("cookie") || "";
    if (action === "resume" || action === "retry") {
        await scheduleGenerationTask("agent", updated.id, { executionPhase: "created", nextPollAt: Date.now(), lastUpstreamStatus: action });
        after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [updated.id] }));
    } else {
        await scheduleGenerationTask("agent", updated.id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: action });
    }
    return NextResponse.json({ code: 0, data: { run: await publicAgentRunForRequest(updated, request) }, msg: "OK" });
}

async function cancelAgentRun(request: Request, run: AgentRun) {
    const origin = resolveInternalOrigin(new URL(request.url).origin);
    const cookie = request.headers.get("cookie") || "";
    const children = run.tasks
        .filter((task) => (task.status === "running" || task.status === "needs_review") && ["text", "image", "video", "audio"].includes(task.type))
        .flatMap((task) => cancellableChildTaskIds(task).map((taskId) => ({ type: task.type, taskId })));
    const requestedAt = run.cancellation?.requestedAt || Date.now();
    const stopping = await updateAgentRunById(
        run.id,
        { status: "paused", executionId: undefined, cancellation: { requestedAt, pendingChildTaskIds: children.map((child) => child.taskId) } },
        { type: "run.cancel.requested", data: { pendingCount: children.length } },
        ["planning", "running", "paused"],
    );
    if (!stopping) return NextResponse.json({ code: 409, data: null, msg: "Agent 状态已变化，请刷新后重试" }, { status: 409 });
    abortAgentRun(run.id);
    await scheduleGenerationTask("agent", stopping.id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "cancel_requested" });

    const results = await Promise.all(children.map((child) => cancelChildTask(child, origin, cookie)));
    const pending = results.filter((result) => !result.confirmed);
    if (pending.length) {
        const message = pending.map((result) => `${result.taskId}：${result.error || "取消状态待确认"}`).join("；");
        const updated = await updateAgentRunById(
            run.id,
            { cancellation: { requestedAt, pendingChildTaskIds: pending.map((result) => result.taskId), lastError: message } },
            { type: "run.cancel.pending", data: { pendingTaskIds: pending.map((result) => result.taskId) } },
            ["paused"],
        );
        return NextResponse.json({ code: 502, data: { run: publicAgentRun(updated || stopping), pendingCount: pending.length }, msg: "部分子任务取消状态尚未确认，请稍后再次取消" }, { status: 502 });
    }

    const latest = (await getAgentRun(run.id)) || stopping;
    const cancelled = await setAgentRunStatus(latest, "cancelled");
    if (!cancelled) return NextResponse.json({ code: 409, data: null, msg: "Agent 状态已变化，请刷新后重试" }, { status: 409 });
    await scheduleGenerationTask("agent", cancelled.id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "cancel" });
    return NextResponse.json({ code: 0, data: { run: publicAgentRun(cancelled) }, msg: "OK" });
}

async function cancelChildTask(child: { type: AgentRun["tasks"][number]["type"]; taskId: string }, origin: string, cookie: string) {
    const url = `${origin}/api/${child.type}-tasks/${encodeURIComponent(child.taskId)}`;
    try {
        const response = await fetchInternalApi(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({ status: "cancelled" }),
        });
        const result = await readChildTaskResponse(response);
        if ((response.ok && childTaskTerminal(result.status)) || response.status === 404) return { taskId: child.taskId, confirmed: true as const };
    } catch {
        // The request may have reached the child route. Confirm its persisted state below.
    }
    try {
        const response = await fetchInternalApi(url, { headers: { cookie } });
        if (response.status === 404) return { taskId: child.taskId, confirmed: true as const };
        const result = await readChildTaskResponse(response);
        if (response.ok && childTaskTerminal(result.status)) return { taskId: child.taskId, confirmed: true as const };
        return { taskId: child.taskId, confirmed: false as const, error: result.error || `子任务仍处于 ${result.status || response.status}` };
    } catch (error) {
        return { taskId: child.taskId, confirmed: false as const, error: error instanceof Error ? error.message : "无法读取子任务状态" };
    }
}

async function readChildTaskResponse(response: Response) {
    const payload = (await response.json().catch(() => null)) as { task?: { status?: unknown }; error?: unknown; msg?: unknown } | null;
    return {
        status: typeof payload?.task?.status === "string" ? payload.task.status.trim().toLowerCase() : "",
        error: typeof payload?.error === "string" ? payload.error : typeof payload?.msg === "string" ? payload.msg : "",
    };
}

function childTaskTerminal(status: string) {
    return ["success", "completed", "error", "failed", "cancelled", "canceled"].includes(status);
}

function cancellableChildTaskIds(task: AgentRun["tasks"][number]) {
    const childStatuses = new Map(task.childTasks?.map((child) => [child.id, child.status]) || []);
    const ids = new Set([...(task.taskIds || []), ...(task.taskId ? [task.taskId] : []), ...(task.childTasks?.map((child) => child.id) || [])]);
    return Array.from(ids).filter((taskId) => !childStatuses.has(taskId) || childStatuses.get(taskId) === "pending" || childStatuses.get(taskId) === "needs_review");
}
