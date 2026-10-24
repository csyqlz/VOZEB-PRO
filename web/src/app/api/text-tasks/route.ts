import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { PricingConflictError } from "@/lib/model-pricing";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getStoredGenerationTaskByRequest, normalizeGenerationTaskContext, withGenerationConcurrencyLimit, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { publicModelPricingMode } from "@/lib/server/model-pricing-activation-service";
import { getCurrentSalesVersion } from "@/lib/server/model-pricing-store";
import { getLatestTextUsageRule } from "@/lib/server/model-pricing-text-usage-rule-store";
import { auditDirectedPricingTask, selectDirectedPricingBinding } from "@/lib/server/model-pricing-directed-test";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { createTextTask, type TextTask, type TextTaskConfig } from "@/lib/server/text-task-store";
import type { AiTextMessage } from "@/types/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type CreateTextTaskBody = {
    config?: TextTaskConfig;
    messages?: AiTextMessage[];
    context?: GenerationTaskContext;
};

export async function POST(request: Request) {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const headerRequestId = request.headers.get("x-vozeb-pro-client-request-id")?.trim();
    const headerAttemptNo = Number(request.headers.get("x-vozeb-pro-attempt-no"));
    const attemptNo = Number.isSafeInteger(headerAttemptNo) && headerAttemptNo > 0 ? headerAttemptNo : undefined;
    let body: CreateTextTaskBody;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
    const context = normalizeGenerationTaskContext({ ...body.context, clientRequestId: headerRequestId || body.context?.clientRequestId, ...(attemptNo ? { attemptNo } : {}) });
    if (context.clientRequestId) {
        const existing = await getStoredGenerationTaskByRequest<TextTask>("text", currentUser.id, context.clientRequestId, context.attemptNo);
        if (existing) return NextResponse.json({ task: publicTask(existing) });
    }
    const rate = await checkGenerationRateLimit(currentUser.id, request, "text");
    if (!rate.allowed) return NextResponse.json({ error: "文本生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const settings = await getAuthSettings();
    const response = await withGenerationConcurrencyLimit(
        currentUser.id,
        "text",
        5 * 60 * 1000,
        settings.generationConcurrency.text,
        async () => {
            if (context.clientRequestId) {
                const existing = await getStoredGenerationTaskByRequest<TextTask>("text", currentUser.id, context.clientRequestId, context.attemptNo);
                if (existing) return NextResponse.json({ task: publicTask(existing) });
            }
            const configs = sanitizeConfigs(body.config, settings);
            const messages = sanitizeMessages(body.messages);
            if (!configs.length || !messages.length) return NextResponse.json({ error: "任务参数不完整" }, { status: 400 });
            const directed = selectDirectedPricingBinding(request, currentUser, configs);
            if (directed.error) return NextResponse.json({ error: directed.error }, { status: directed.status });
            const pricing = directed.directed ? undefined : await publicModelPricingMode(generationModelId(configs[0]), "text", configs);
            if (pricing?.billingMode === "blocked") return NextResponse.json({ error: pricing.reason }, { status: 409 });
            const selected = pricing?.bindingKeys
                ? configs.filter((item) => pricing.bindingKeys!.includes(`${item.channelId}/${item.model}`))
                : directed.directed
                  ? directed.configs
                  : configs.filter(
                        (item) => !settings.logicalModels.some((model) => model.id === generationModelId(item) && model.bindings.some((binding) => binding.channelId === item.channelId && binding.upstreamModel === item.model && binding.acceptanceOnly)),
                    );
            if (!selected.length) return NextResponse.json({ error: "当前模型没有可用于普通调用的渠道；待验收绑定只允许管理员定向调用" }, { status: 409 });
            const billingApproval = pricing;
            const directedVersionId = directed.directed ? (await getCurrentSalesVersion())?.priceVersionIds[generationModelId(configs[0])] : undefined;
            const directedRule = directedVersionId ? await getLatestTextUsageRule(generationModelId(configs[0]), directedVersionId) : undefined;
            let task: TextTask;
            try {
                task = await createTextTask({
                    ...context,
                    userId: currentUser.id,
                    config: selected[0],
                    candidateConfigs: selected.slice(1),
                    messages,
                    ...(directedRule ? { directedPricingRuleId: directedRule.id } : {}),
                    ...(billingApproval ? { billingMode: billingApproval.billingMode, billingApproval } : {}),
                });
            } catch (error) {
                if (error instanceof PricingConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
                throw error;
            }
            await auditDirectedPricingTask(request, currentUser, directed.key, "text", task.id);
            const cookie = request.headers.get("cookie") || "";
            const origin = resolveInternalOrigin(new URL(request.url).origin);
            await scheduleGenerationTask("text", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
            after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [task.id] }));
            return NextResponse.json({ task: publicTask(task) });
        },
        undefined,
        context.clientRequestId,
    );
    if (response) return response;
    const existing = context.clientRequestId && (await getStoredGenerationTaskByRequest<TextTask>("text", currentUser.id, context.clientRequestId, context.attemptNo));
    return existing ? NextResponse.json({ task: publicTask(existing) }) : NextResponse.json({ error: "当前用户文本任务已达到并发上限" }, { status: 429 });
}

function publicTask(task: TextTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), result: task.result, error: task.error };
}

function sanitizeConfigs(config: TextTaskConfig | undefined, settings: Awaited<ReturnType<typeof getAuthSettings>>): TextTaskConfig[] {
    const requestedModel = config?.model || settings.defaultModels.textModel;
    return resolveLogicalModelCandidates(settings, "text", requestedModel, "", true).map((resolved) => ({ ...toSystemGenerationChannel(resolved), channelId: resolved.channelId, systemPrompt: "" }));
}

function sanitizeMessages(messages?: AiTextMessage[]) {
    if (!Array.isArray(messages)) return [];
    return messages
        .map((message) => ({ role: message.role === "system" || message.role === "assistant" ? message.role : ("user" as const), content: sanitizeContent(message.content) }))
        .filter((message) => (Array.isArray(message.content) ? message.content.length > 0 : Boolean(message.content.trim())))
        .slice(0, 20);
}

function sanitizeContent(content: AiTextMessage["content"]): AiTextMessage["content"] {
    if (!Array.isArray(content)) return String(content || "").slice(0, 20_000);
    return content
        .map((item) => (item.type === "text" ? { type: "text" as const, text: item.text.slice(0, 20_000) } : { type: "image_url" as const, image_url: { url: item.image_url.url } }))
        .filter((item) => (item.type === "text" ? Boolean(item.text.trim()) : Boolean(item.image_url.url)));
}
