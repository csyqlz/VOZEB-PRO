import { after, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import { CreativeRuntimeInputError, normalizeCreativeRunRequest, normalizeCreativeSurface } from "@/lib/creative-runtime-contract";
import { readJsonBody } from "@/lib/auth/request";
import { checkRateLimit } from "@/lib/server/security";
import { withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { createAgentRun, getAgentRunByClientRequestId, listAgentRuns } from "@/lib/server/agent-run-store";
import { CreativeStoreConflict } from "@/lib/server/creative-runtime-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { publicAgentRun } from "@/lib/server/agent-run-public";
import { assertAgentSkillModeCompatibility } from "@/lib/server/agent-run-surface-policy";

export const maxDuration = 2400;

export async function GET(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId")?.trim() || "";
    const conversationId = url.searchParams.get("conversationId")?.trim() || "";
    const surface = normalizeCreativeSurface(url.searchParams.get("surface"));
    const activeOnly = url.searchParams.get("status") === "active";
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(50, requestedLimit) : 50;
    const runs = (
        await listAgentRuns({
            userId: user.id,
            projectId,
            conversationId,
            surface: surface || undefined,
            statuses: activeOnly ? ["planning", "running", "paused"] : undefined,
            limit,
        })
    ).map(publicAgentRun);
    return NextResponse.json({ code: 0, data: { runs }, msg: "OK" });
}

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const input = normalizeCreativeRunRequest(await readJsonBody<unknown>(request));
        const existing = await getAgentRunByClientRequestId(user.id, input.clientRequestId);
        if (existing) return NextResponse.json({ code: 0, data: { run: publicAgentRun(existing), created: false }, msg: "Agent 任务已存在" });
        const rate = await checkRateLimit(`agent-run:${user.id}`, { maxRequests: 10, windowMs: 60 * 1000 });
        if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "Agent 请求过于频繁，请稍后重试" }, { status: 429 });
        const settings = await getAuthSettings();
        assertAgentSkillModeCompatibility(settings, input);
        const response = await withGenerationConcurrencyLimit(
            user.id,
            "agent",
            10 * 60 * 1000,
            settings.generationConcurrency.agent,
            async () => {
                const created = await createAgentRun(user.id, input);
                if (created.created) {
                    const origin = resolveInternalOrigin(new URL(request.url).origin);
                    after(() => runGenerationTaskRecoveryBatch({ origin, cookie: request.headers.get("cookie") || "", limit: 1, taskIds: [created.run.id] }));
                }
                return NextResponse.json({ code: 0, data: { run: publicAgentRun(created.run), conversation: created.conversation, created: created.created }, msg: created.created ? "Agent 任务已创建" : "Agent 任务已存在" });
            },
            undefined,
            input.clientRequestId,
        );
        return response || NextResponse.json({ code: 429, data: null, msg: `当前最多同时运行 ${settings.generationConcurrency.agent} 个 Agent 任务` }, { status: 429 });
    } catch (error) {
        if (error instanceof CreativeRuntimeInputError || error instanceof CreativeStoreConflict) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
