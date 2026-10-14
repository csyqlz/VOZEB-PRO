import type { ResolvedLogicalModel } from "./logical-model-router";
import { resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { resolveChannelModelAdvancedConfig, resolveChannelModelConfig } from "@/lib/channel-protocol-registry";

type GenerationApiFormat = "openai" | "gemini";
export type SystemGenerationChannelConfig = {
    apiSource: "system";
    baseUrl: string;
    apiKey: "system";
    apiFormat: GenerationApiFormat;
    model: string;
    channelId?: string;
    logicalModel?: string;
    advancedConfig?: import("@/lib/auth/store").SystemChannelAdvancedConfig;
    capabilityProfile?: ReturnType<typeof import("@/lib/model-routing-config").resolveLogicalModelCapabilityProfile>;
};

function sanitizeSystemGenerationChannel(config?: { apiSource?: string; baseUrl?: string; apiFormat?: string; model?: string }): SystemGenerationChannelConfig | null {
    const baseUrl = config?.baseUrl?.trim() || "";
    const model = rawModelName(config?.model || "");
    if (config?.apiSource !== "system" || !baseUrl.startsWith("/api/ai/system/") || !model) return null;
    return {
        apiSource: "system",
        baseUrl,
        apiKey: "system",
        apiFormat: config.apiFormat === "gemini" ? "gemini" : "openai",
        model,
    };
}

export function resolveSystemGenerationChannel(config: { apiSource?: string; baseUrl?: string; apiFormat?: string; model?: string } | undefined, channels: Array<{ id: string; enabled: boolean; apiFormat: GenerationApiFormat; models: string[] }>) {
    const sanitized = sanitizeSystemGenerationChannel(config);
    const match = sanitized?.baseUrl.match(/^\/api\/ai\/system\/([^/?#]+)\/?$/);
    if (!sanitized || !match) return null;
    let channelId = "";
    try {
        channelId = decodeURIComponent(match[1]);
    } catch {
        return null;
    }
    const channel = channels.find((item) => item.id === channelId && item.enabled);
    if (!channel || !channelSupportsModel(channel.models, sanitized.model)) return null;
    return { ...sanitized, apiFormat: channel.apiFormat };
}

export function toSystemGenerationChannel(resolved: ResolvedLogicalModel): SystemGenerationChannelConfig {
    const modelConfig = resolveChannelModelConfig(resolved.channel.advancedConfig, resolved.upstreamModel);
    const advancedConfig = resolveModelAdvancedConfig(resolved.channel.advancedConfig, resolved.upstreamModel);
    return {
        apiSource: "system",
        baseUrl: `/api/ai/system/${encodeURIComponent(resolved.channelId)}`,
        apiKey: "system",
        apiFormat: modelConfig?.apiFormat || resolved.channel.apiFormat,
        model: resolved.upstreamModel,
        channelId: resolved.channelId,
        logicalModel: resolved.logicalModelId,
        advancedConfig:
            advancedConfig && resolved.capabilityProfile
                ? {
                      ...advancedConfig,
                      supportsReferenceImage: resolved.capabilityProfile.supportsReferenceImage,
                      supportsReferenceVideo: resolved.capabilityProfile.supportsReferenceVideo,
                      supportsReferenceAudio: resolved.capabilityProfile.supportsReferenceAudio,
                  }
                : advancedConfig,
        capabilityProfile: resolved.capabilityProfile,
    };
}

export function resolveModelAdvancedConfig(config: import("@/lib/auth/store").SystemChannelAdvancedConfig | undefined, model: string) {
    if (!config) return undefined;
    const resolved = resolveChannelModelAdvancedConfig(config, model)!;
    const preset = resolveGlobalAiOpcPreset(resolved, model);
    if (!preset) return resolved;
    return {
        ...resolved,
        globalAiOpcPreset: preset.id as import("@/lib/auth/store").SystemChannelAdvancedConfig["globalAiOpcPreset"],
        createPath: preset.createPath,
        queryPath: preset.queryPath || "",
        requestTemplate: "",
        durationRange: preset.durationRange || "",
        supportsReferenceImage: Boolean(preset.supportsReferenceImage),
        supportsReferenceVideo: Boolean(preset.supportsReferenceVideo),
        supportsReferenceAudio: Boolean(preset.supportsReferenceAudio),
    };
}

export function generationModelId(config: { model: string; logicalModel?: string }) {
    return config.logicalModel?.trim() || config.model;
}

export function systemGenerationChannelId(baseUrl: string) {
    const match = baseUrl.match(/^\/api\/ai\/system\/([^/?#]+)\/?$/);
    if (!match) return "";
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return "";
    }
}

export function rawModelName(value: string) {
    const model = value.trim();
    const separator = model.indexOf("::");
    return separator >= 0 ? model.slice(separator + 2).trim() : model;
}

export function channelSupportsModel(models: string[], requested: string) {
    const target = rawModelName(requested)
        .replace(/^models\//, "")
        .toLowerCase();
    return models.some(
        (model) =>
            rawModelName(model)
                .replace(/^models\//, "")
                .toLowerCase() === target,
    );
}
