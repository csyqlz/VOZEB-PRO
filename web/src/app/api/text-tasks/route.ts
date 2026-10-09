import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { CREATIVE_UPLOAD_JSON_BODY_MAX_BYTES } from "@/lib/creative-upload";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { withGenerationConcurrencyLimit } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { createTextTask, type TextTask, type TextTaskConfig } from "@/lib/server/text-task-store";
import type { AiTextMessage } from "@/types/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type CreateTextTaskBody = {
    config?: TextTaskConfig;
    messages?: AiTextMessage[];
};

export async function POST(request: Request) {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const rate = await checkGenerationRateLimit(currentUser.id, request, "text");
    if (!rate.allowed) return NextResponse.json({ error: "文本生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const settings = await getAuthSettings();
    const response = await withGenerationConcurrencyLimit(currentUser.id, "text", 5 * 60 * 1000, settings.generationConcurrency.text, async () => {
        let body: CreateTextTaskBody;
        try {
            body = await readJsonBody(request, CREATIVE_UPLOAD_JSON_BODY_MAX_BYTES);
        } catch (error) {
            if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
            throw error;
        }
        const configs = sanitizeConfigs(body.config, settings);
        const messages = sanitizeMessages(body.messages);
        if (!configs.length || !messages.length) return NextResponse.json({ error: "任务参数不完整" }, { status: 400 });

        const task = await createTextTask({ userId: currentUser.id, config: configs[0], candidateConfigs: configs.slice(1), messages });
        const cookie = request.headers.get("cookie") || "";
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        await scheduleGenerationTask("text", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
        after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [task.id] }));
        return NextResponse.json({ task: publicTask(task) });
    });
    return response || NextResponse.json({ error: "当前用户文本任务已达到并发上限" }, { status: 429 });
}

function publicTask(task: TextTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), result: task.result, error: task.error };
}

function sanitizeConfigs(config: TextTaskConfig | undefined, settings: Awaited<ReturnType<typeof getAuthSettings>>): TextTaskConfig[] {
    const requestedModel = config?.model || settings.defaultModels.textModel;
    return resolveLogicalModelCandidates(settings, "text", requestedModel).map((resolved) => ({ ...toSystemGenerationChannel(resolved), channelId: resolved.channelId, systemPrompt: "" }));
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
