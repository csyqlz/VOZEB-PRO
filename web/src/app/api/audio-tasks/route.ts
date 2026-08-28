import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { mediaTaskSource } from "@/lib/media-management-contract";
import { resolveAudioTaskOptions } from "@/lib/server/audio-task-config";
import { createAudioTask, type AudioTask, type AudioTaskConfig } from "@/lib/server/audio-task-store";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getStoredGenerationTaskByRequest, linkStoredGenerationTask, withGenerationConcurrencyLimit, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("audio.generate", user.id);
    if (blocked) return blocked;
    const rate = await checkGenerationRateLimit(user.id, request, "audio");
    if (!rate.allowed) return NextResponse.json({ error: "音频生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const settings = await getAuthSettings();
    const response = await withGenerationConcurrencyLimit(user.id, "audio", 10 * 60 * 1000, settings.generationConcurrency.audio, async () => {
        let body: { config?: AudioTaskConfig; prompt?: string; source?: string; context?: GenerationTaskContext };
        try {
            body = await readJsonBody(request);
        } catch (error) {
            if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
            throw error;
        }
        const channels = resolveLogicalModelCandidates(settings, "audio", body.config?.model || settings.defaultModels.audioModel).map((resolved) => ({ ...toSystemGenerationChannel(resolved), channelId: resolved.channelId }));
        const prompt = String(body.prompt || "").trim();
        const supportedChannels = channels.filter((channel) => channel.apiFormat !== "gemini");
        if (!supportedChannels.length || !prompt) return NextResponse.json({ error: "音频任务参数不完整或渠道不支持" }, { status: 400 });
        const configs: AudioTaskConfig[] = supportedChannels.map((channel) => ({ ...channel, ...resolveAudioTaskOptions(body.config, settings.generationDefaults), instructions: clean(body.config?.instructions, 2_000) }));
        const requestId = body.context?.clientRequestId?.trim();
        if (requestId) {
            const existing = await getStoredGenerationTaskByRequest<AudioTask>("audio", user.id, requestId, body.context?.attemptNo);
            if (existing) return NextResponse.json({ task: publicTask(existing) });
        }
        const task = await createAudioTask({ ...(body.context || {}), userId: user.id, config: configs[0], candidateConfigs: configs.slice(1), prompt: prompt.slice(0, 20_000), source: mediaTaskSource(body.source, body.context, "audio-task") });
        await linkStoredGenerationTask("audio", task.id, body.context || {});
        const origin = resolveInternalOrigin(new URL(request.url).origin);
        const cookie = request.headers.get("cookie") || "";
        await scheduleGenerationTask("audio", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
        after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [task.id] }));
        return NextResponse.json({ task: publicTask(task) });
    });
    return response || NextResponse.json({ error: "当前用户音频任务已达到并发上限" }, { status: 429 });
}

function publicTask(task: AudioTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), result: task.result, error: task.error };
}

function clean(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}
