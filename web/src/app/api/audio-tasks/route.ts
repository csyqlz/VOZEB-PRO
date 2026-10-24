import { after, NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { PricingConflictError } from "@/lib/model-pricing";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings, isAuthInputError } from "@/lib/auth/store";
import { mediaTaskSource } from "@/lib/media-management-contract";
import { resolveAudioTaskOptions } from "@/lib/server/audio-task-config";
import { createAudioTask, type AudioTask, type AudioTaskConfig } from "@/lib/server/audio-task-store";
import { generationModelId, toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { runGenerationTaskRecoveryBatch } from "@/lib/server/generation-task-recovery-service";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { getStoredGenerationTaskByRequest, linkStoredGenerationTask, normalizeGenerationTaskContext, withGenerationConcurrencyLimit, type GenerationTaskContext } from "@/lib/server/generation-task-store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { publicModelPricingMode } from "@/lib/server/model-pricing-activation-service";
import { auditDirectedPricingTask, selectDirectedPricingBinding } from "@/lib/server/model-pricing-directed-test";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    let body: { config?: AudioTaskConfig; prompt?: string; source?: string; context?: GenerationTaskContext };
    try {
        body = await readJsonBody(request);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        throw error;
    }
    const context = normalizeGenerationTaskContext(body.context || {});
    if (context.clientRequestId) {
        const existing = await getStoredGenerationTaskByRequest<AudioTask>("audio", user.id, context.clientRequestId, context.attemptNo);
        if (existing) return NextResponse.json({ task: publicTask(existing) });
    }
    const rate = await checkGenerationRateLimit(user.id, request, "audio");
    if (!rate.allowed) return NextResponse.json({ error: "音频生成请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const settings = await getAuthSettings();
    const response = await withGenerationConcurrencyLimit(
        user.id,
        "audio",
        10 * 60 * 1000,
        settings.generationConcurrency.audio,
        async () => {
            if (context.clientRequestId) {
                const existing = await getStoredGenerationTaskByRequest<AudioTask>("audio", user.id, context.clientRequestId, context.attemptNo);
                if (existing) return NextResponse.json({ task: publicTask(existing) });
            }
            const channels = resolveLogicalModelCandidates(settings, "audio", body.config?.model || settings.defaultModels.audioModel).map((resolved) => ({ ...toSystemGenerationChannel(resolved), channelId: resolved.channelId }));
            const prompt = String(body.prompt || "").trim();
            const supportedChannels = channels.filter((channel) => channel.apiFormat !== "gemini" || channel.advancedConfig?.protocol === "gemini" || channel.advancedConfig?.protocol === "dataeyes-gemini");
            if (!supportedChannels.length || !prompt) return NextResponse.json({ error: "音频任务参数不完整或渠道不支持" }, { status: 400 });
            const configs: AudioTaskConfig[] = supportedChannels.map((channel) => ({ ...channel, ...resolveAudioTaskOptions(body.config, settings.generationDefaults), instructions: clean(body.config?.instructions, 2_000) }));
            const directed = selectDirectedPricingBinding(request, user, configs);
            if (directed.error) return NextResponse.json({ error: directed.error }, { status: directed.status });
            const selected = directed.directed ? directed.configs : configs;
            const audioOperation = pricingOperation(selected[0]);
            const group = pricingGroup(selected[0]);
            const scopedConfigs = selected.filter((item) => pricingGroup(item) === group);
            const pricing = directed.directed ? undefined : await publicModelPricingMode(generationModelId(scopedConfigs[0]), "audio", scopedConfigs, undefined, audioOperation);
            if (pricing?.billingMode === "blocked") return NextResponse.json({ error: pricing.reason }, { status: 409 });
            let selectedConfigs = pricing?.bindingKeys ? scopedConfigs.filter((item) => pricing.bindingKeys!.includes(`${item.channelId}/${item.model}`)) : scopedConfigs;
            if (!directed.directed && !pricing && scopedConfigs.length !== configs.length) {
                const remaining = new Map<string, AudioTaskConfig[]>();
                for (const config of configs) {
                    const key = pricingGroup(config);
                    if (key !== group) remaining.set(key, [...(remaining.get(key) || []), config]);
                }
                let allFixed = true;
                for (const candidates of remaining.values()) {
                    if (await publicModelPricingMode(generationModelId(candidates[0]), "audio", candidates, undefined, pricingOperation(candidates[0]))) {
                        allFixed = false;
                        break;
                    }
                }
                if (allFixed) selectedConfigs = configs;
            }
            const billingApproval = pricing;
            let task: AudioTask;
            try {
                task = await createAudioTask({
                    ...context,
                    userId: user.id,
                    config: selectedConfigs[0],
                    candidateConfigs: selectedConfigs.slice(1),
                    prompt: prompt.slice(0, 20_000),
                    source: mediaTaskSource(body.source, body.context, "audio-task"),
                    ...(billingApproval ? { billingMode: billingApproval.billingMode, billingApproval } : {}),
                });
            } catch (error) {
                if (error instanceof PricingConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
                throw error;
            }
            await auditDirectedPricingTask(request, user, directed.key, "audio", task.id);
            await linkStoredGenerationTask("audio", task.id, body.context || {});
            const origin = resolveInternalOrigin(new URL(request.url).origin);
            const cookie = request.headers.get("cookie") || "";
            await scheduleGenerationTask("audio", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
            after(() => runGenerationTaskRecoveryBatch({ origin, cookie, limit: 1, taskIds: [task.id] }));
            return NextResponse.json({ task: publicTask(task) });
        },
        undefined,
        context.clientRequestId,
    );
    if (response) return response;
    const existing = context.clientRequestId && (await getStoredGenerationTaskByRequest<AudioTask>("audio", user.id, context.clientRequestId, context.attemptNo));
    return existing ? NextResponse.json({ task: publicTask(existing) }) : NextResponse.json({ error: "当前用户音频任务已达到并发上限" }, { status: 429 });
}

function pricingOperation(config: AudioTaskConfig): "chat/completions" | "generateContent" | undefined {
    const protocol = config.advancedConfig?.protocol;
    return protocol === "openai" ? "chat/completions" : protocol === "gemini" || protocol === "dataeyes-gemini" ? "generateContent" : undefined;
}

function pricingGroup(config: AudioTaskConfig) {
    return pricingOperation(config) || config.advancedConfig?.protocol || "";
}

function publicTask(task: AudioTask) {
    return { id: task.id, status: task.status, model: generationModelId(task.config), result: task.result, error: task.error };
}

function clean(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}
