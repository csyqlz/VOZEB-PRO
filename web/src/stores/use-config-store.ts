"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { nanoid } from "nanoid";

import { flattenPublicCapabilityModels, resolvePublicCapabilityModels } from "@/lib/public-model-catalog";
import type { GlobalAiOpcPresetId } from "@/lib/globalaiopc-catalog";
import { resolveChannelModelAdvancedConfig } from "@/lib/channel-protocol-registry";
import { inferModelCapability, normalizeModelId } from "@/lib/model-capability";
import { materializeLogicalModelPointCosts } from "@/lib/model-point-cost";
import type { LogicalModelCapabilityProfile } from "@/lib/auth/store-types";

type ApiCallFormat = "openai" | "gemini";
type SystemChannelProtocol = "auto" | "openai" | "yumeng" | "gemini" | "gcp-agent-platform" | "sub2api" | "newapi" | "vozeb-recommended" | "globalaiopc" | "seedance" | "stable-diffusion" | "volcengine-video" | "seedance-special" | "custom" | "compatible";

type SystemChannelAdvancedConfig = {
    protocol: SystemChannelProtocol;
    authMode?: "none" | "bearer" | "x-api-key" | "custom-header" | "google-adc";
    authHeader?: string;
    authPrefix?: string;
    gcpProjectId?: string;
    gcpLocation?: string;
    documentationUrl?: string;
    globalAiOpcPreset?: GlobalAiOpcPresetId;
    globalAiOpcPresets?: GlobalAiOpcPresetId[];
    textModel: string;
    imageModel: string;
    videoModel: string;
    createPath: string;
    queryPath: string;
    requestTemplate: string;
    resultField: string;
    statusField: string;
    durationRange: string;
    referenceRule: string;
    supportsReferenceImage: boolean;
    supportsReferenceVideo: boolean;
    supportsReferenceAudio: boolean;
    modelCatalogPaths?: string[];
    modelCapabilities?: Record<string, ModelCapability>;
    modelConfigs?: Record<
        string,
        {
            capability: ModelCapability;
            source?: "manual" | "provider" | "official" | "health";
            apiFormat?: ApiCallFormat;
            protocol?: SystemChannelProtocol;
            createPath?: string;
            queryPath?: string;
            requestTemplate?: string;
            resultField?: string;
            statusField?: string;
            durationRange?: string;
            referenceRule?: string;
            supportsReferenceImage?: boolean;
            supportsReferenceVideo?: boolean;
            supportsReferenceAudio?: boolean;
        }
    >;
};

type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: string[];
    advancedConfig?: SystemChannelAdvancedConfig;
};

type LogicalModel = {
    id: string;
    name: string;
    capability: ModelCapability;
    enabled: boolean;
    bindings: Array<{ id: string; channelId: string; upstreamModel: string; enabled: boolean; priority: number; capabilityProfile?: LogicalModelCapabilityProfile }>;
};

export type AiConfig = {
    apiSource: "system" | "custom";
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    logicalModels: LogicalModel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    count: string;
    canvasImageCount: string;
    modelPointCosts: Record<string, number>;
    generationPointMultipliers: GenerationPointMultipliers;
    generationConcurrency: GenerationConcurrencySettings;
    advancedConfig?: SystemChannelAdvancedConfig;
};

type GenerationPointMultipliers = {
    imageQuality: Record<string, number>;
    videoQuality: Record<string, number>;
    videoSeconds: Record<string, number>;
};

type GenerationConcurrencySettings = {
    agent: number;
    image: number;
    video: number;
    audio: number;
    text: number;
    render: number;
};

export type PublicSystemSettings = {
    modelPointCosts?: Record<string, number>;
    generationPointMultipliers?: GenerationPointMultipliers;
    generationConcurrency?: GenerationConcurrencySettings;
    generationDefaults?: {
        canvasImageCount?: number;
        imageSize?: string;
        imageQuality?: string;
        imageCount?: number;
        videoQuality?: string;
        videoSeconds?: number;
        audioVoice?: string;
        audioFormat?: string;
    };
    defaultModels?: {
        imageModel?: string;
        videoModel?: string;
        textModel?: string;
        audioModel?: string;
    };
    systemChannels?: Array<ModelChannel & { enabled?: boolean; hasApiKey?: boolean }>;
    logicalModels?: LogicalModel[];
};

export type ModelCapability = "image" | "video" | "text" | "audio";
const CHANNEL_MODEL_SEPARATOR = "::";
const DEFAULT_SYSTEM_BASE_URL = "";

export const defaultConfig: AiConfig = {
    apiSource: "system",
    channelMode: "local",
    baseUrl: DEFAULT_SYSTEM_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [],
    logicalModels: [],
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "5",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "auto",
    size: "1:1",
    count: "1",
    canvasImageCount: "1",
    modelPointCosts: {},
    generationPointMultipliers: {
        imageQuality: { auto: 1, low: 1, medium: 1, high: 1 },
        videoQuality: { "480": 1, "720": 1, "1080": 1 },
        videoSeconds: { "-1": 1, "5": 1, "10": 1 },
    },
    generationConcurrency: { agent: 2, image: 4, video: 1, audio: 2, text: 4, render: 1 },
};

type ConfigStore = {
    config: AiConfig;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    setConfig: (config: AiConfig) => void;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    return !capability || inferModelCapability(modelOptionName(model)) === capability;
}

function filterModelsByCapability(models: string[], capability?: ModelCapability) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability)) : models;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config[modelListKey(capability)];
}

function modelListKey(capability: ModelCapability) {
    return `${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    if (config.apiSource === "system") return Boolean(model.trim() && channel.baseUrl.trim().startsWith("/api/ai/system/"));
    return false;
}

export function applyPublicSystemSettings(config: AiConfig, settings?: PublicSystemSettings | null): AiConfig {
    const channels = (settings?.systemChannels || [])
        .filter((channel) => channel.enabled !== false && channel.hasApiKey !== false && channel.models?.length)
        .map((channel) => ({
            id: channel.id,
            name: channel.name,
            baseUrl: channel.baseUrl?.startsWith("/api/ai/system/") ? channel.baseUrl : `/api/ai/system/${channel.id}`,
            apiKey: "system",
            apiFormat: channel.apiFormat === "gemini" ? ("gemini" as const) : ("openai" as const),
            models: uniqueRawModels(channel.models || []),
            ...(channel.advancedConfig ? { advancedConfig: channel.advancedConfig } : {}),
        }));
    const logicalModels = (settings?.logicalModels || []).filter(
        (model) =>
            model.enabled &&
            model.bindings.some((binding) => binding.enabled && channels.some((channel) => channel.id === binding.channelId && channel.models.some((upstream) => normalizedModelName(upstream) === normalizedModelName(binding.upstreamModel)))),
    );
    const rawModels = modelOptionsFromChannels(channels);
    const capabilityModels = resolvePublicCapabilityModels(logicalModels, {
        image: filterModelsByCapability(rawModels, "image"),
        video: filterModelsByCapability(rawModels, "video"),
        text: filterModelsByCapability(rawModels, "text"),
        audio: filterModelsByCapability(rawModels, "audio"),
    });
    const { image: imageModels, video: videoModels, text: textModels, audio: audioModels } = capabilityModels;
    const models = flattenPublicCapabilityModels(capabilityModels);
    const defaultModels = settings?.defaultModels || {};
    const imageModel = choosePublicModel(config.imageModel, defaultModels.imageModel, imageModels, logicalModels);
    const videoModel = choosePublicModel(config.videoModel, defaultModels.videoModel, videoModels, logicalModels);
    const textModel = choosePublicModel(config.textModel, defaultModels.textModel, textModels, logicalModels);
    const audioModel = chooseConfiguredDefaultModel(defaultModels.audioModel, audioModels, logicalModels);
    return {
        ...config,
        apiSource: "system",
        channelMode: "local",
        channels,
        logicalModels,
        baseUrl: channels[0]?.baseUrl || "",
        apiKey: "system",
        apiFormat: "openai",
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel,
        videoModel,
        textModel,
        audioModel,
        model: imageModel || textModel || videoModel || audioModel || "",
        systemPrompt: "",
        audioInstructions: "",
        modelPointCosts: materializeLogicalModelPointCosts(settings?.modelPointCosts, logicalModels),
        generationPointMultipliers: normalizeGenerationPointMultipliers(settings?.generationPointMultipliers),
        generationConcurrency: normalizeGenerationConcurrency(settings?.generationConcurrency),
        canvasImageCount: normalizeCanvasImageCount(settings?.generationDefaults?.canvasImageCount),
        size: settings?.generationDefaults?.imageSize || defaultConfig.size,
        quality: settings?.generationDefaults?.imageQuality || defaultConfig.quality,
        count: String(settings?.generationDefaults?.imageCount || defaultConfig.count),
        videoSeconds: String(settings?.generationDefaults?.videoSeconds || defaultConfig.videoSeconds),
        vquality: settings?.generationDefaults?.videoQuality || defaultConfig.vquality,
        audioVoice: settings?.generationDefaults?.audioVoice || defaultConfig.audioVoice,
        audioFormat: settings?.generationDefaults?.audioFormat || defaultConfig.audioFormat,
    };
}

export const useConfigStore = create<ConfigStore>()((set) => ({
    config: defaultConfig,
    isConfigOpen: false,
    shouldPromptContinue: false,
    setConfig: (config) => set({ config: enforceSystemClientConfig(config) }),
    updateConfig: (key, value) => set((state) => ({ config: enforceSystemClientConfig({ ...state.config, [key]: value }) })),
    isAiConfigReady: (config, model) => isAiConfigReady(config, model),
    openConfigDialog: (shouldPromptContinue = false) => {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("vozeb-pro-system-config-missing", { detail: { shouldPromptContinue } }));
        set({ isConfigOpen: false, shouldPromptContinue: false });
    },
    setConfigDialogOpen: (isOpen) => set({ isConfigOpen: isOpen, shouldPromptContinue: false }),
    clearPromptContinue: () => set({ shouldPromptContinue: false }),
}));

function normalizePointCost(value: unknown) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
    return Number(numberValue.toFixed(2));
}

function normalizeGenerationPointMultipliers(settings?: Partial<GenerationPointMultipliers>) {
    return {
        imageQuality: normalizeMultiplierMap(settings?.imageQuality, defaultConfig.generationPointMultipliers.imageQuality),
        videoQuality: normalizeMultiplierMap(settings?.videoQuality, defaultConfig.generationPointMultipliers.videoQuality),
        videoSeconds: normalizeMultiplierMap(settings?.videoSeconds, defaultConfig.generationPointMultipliers.videoSeconds),
    };
}

function normalizeMultiplierMap(settings: Record<string, unknown> | undefined, defaults: Record<string, number>) {
    return {
        ...defaults,
        ...Object.fromEntries(
            Object.entries(settings || {})
                .map(([key, value]) => [key.trim(), normalizePointCost(value)] as const)
                .filter(([key]) => Boolean(key)),
        ),
    };
}

function normalizeGenerationConcurrency(settings?: Partial<GenerationConcurrencySettings>) {
    return {
        agent: positiveInteger(settings?.agent, defaultConfig.generationConcurrency.agent),
        image: positiveInteger(settings?.image, defaultConfig.generationConcurrency.image),
        video: positiveInteger(settings?.video, defaultConfig.generationConcurrency.video),
        audio: positiveInteger(settings?.audio, defaultConfig.generationConcurrency.audio),
        text: positiveInteger(settings?.text, defaultConfig.generationConcurrency.text),
        render: positiveInteger(settings?.render, defaultConfig.generationConcurrency.render),
    };
}

function normalizeCanvasImageCount(value: unknown) {
    return String(positiveInteger(value, Number(defaultConfig.canvasImageCount) || 1));
}

function positiveInteger(value: unknown, fallback: number) {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
    const numberValue = Math.floor(Number(value));
    if (!Number.isFinite(numberValue)) return fallback;
    return Math.max(min, Math.min(max, numberValue));
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || "新渠道",
        baseUrl: channel?.baseUrl?.trim() || DEFAULT_SYSTEM_BASE_URL,
        apiKey: channel?.apiKey || "",
        apiFormat: channel?.apiFormat === "gemini" ? "gemini" : "openai",
        models: uniqueRawModels(channel?.models || []),
        ...(channel?.advancedConfig ? { advancedConfig: channel.advancedConfig } : {}),
    };
}

function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const logical = config.logicalModels.find((model) => model.id.toLowerCase() === value.toLowerCase());
    if (logical) return logical.name;
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

function modelOptionsFromChannels(channels: ModelChannel[]) {
    const names = new Map<string, string>();
    channels.forEach((channel) => channel.models.forEach((model) => names.set(modelOptionName(model).toLowerCase(), modelOptionName(model))));
    return Array.from(names.values());
}

function choosePublicModel(currentValue: string, adminDefault: string | undefined, options: string[], logicalModels: LogicalModel[] = []) {
    const current = modelOptionName(currentValue).trim();
    const currentOption = findEquivalentModelOption(current, options);
    if (currentOption) return currentOption;
    const fallback = resolveLogicalDefaultModel(adminDefault, options, logicalModels);
    return fallback || options[0] || "";
}

function chooseConfiguredDefaultModel(adminDefault: string | undefined, options: string[], logicalModels: LogicalModel[] = []) {
    return resolveLogicalDefaultModel(adminDefault, options, logicalModels);
}

function resolveLogicalDefaultModel(value: string | undefined, options: string[], logicalModels: LogicalModel[]) {
    const requested = modelOptionName(value || "").trim();
    const direct = findEquivalentModelOption(requested, options);
    if (direct) return direct;
    const logical = logicalModels.find((model) => model.enabled && (normalizedModelName(model.id) === normalizedModelName(requested) || model.bindings.some((binding) => normalizedModelName(binding.upstreamModel) === normalizedModelName(requested))));
    return logical ? findEquivalentModelOption(logical.id, options) : "";
}

function findEquivalentModelOption(value: string, options: string[]) {
    const requested = normalizedModelName(value);
    return requested ? options.find((option) => normalizedModelName(option) === requested) || "" : "";
}

function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    if (!channels.length) return "";
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.includes(decoded.model) ? decoded.model : "";
    }
    const legacyModel = model;
    const channel = channels.find((item) => item.models.includes(legacyModel)) || channels[0];
    return channel && channel.models.includes(legacyModel) ? legacyModel : "";
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const channels = normalizeChannels(config);
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const logical = config.logicalModels.find((item) => item.id === model && item.enabled);
    const binding = logical?.bindings
        .filter((item) => item.enabled)
        .sort((a, b) => a.priority - b.priority)
        .find((item) => channels.some((channel) => channel.id === item.channelId));
    const matched = binding ? channels.find((channel) => channel.id === binding.channelId) : decoded ? channels.find((channel) => channel.id === decoded.channelId) : channels.find((channel) => channel.models.includes(model));
    return matched || channels[0] || createModelChannel({ id: "default", name: "默认渠道", models: config.models.map(modelOptionName) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    const model = modelOptionName(value || config.model);
    const advancedConfig = channel.advancedConfig ? resolveChannelModelAdvancedConfig(channel.advancedConfig, model) : undefined;
    return {
        ...config,
        model,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.advancedConfig?.modelConfigs?.[normalizeModelId(model)]?.apiFormat || channel.apiFormat,
        ...(advancedConfig ? { advancedConfig } : {}),
        systemPrompt: "",
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels
        .filter((channel) => channel.baseUrl?.trim().startsWith("/api/ai/system/"))
        .map((channel, index) =>
            createModelChannel({
                ...channel,
                id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
                name: channel.name || (index === 0 ? "默认渠道" : `渠道 ${index + 1}`),
                apiKey: "system",
                models: uniqueRawModels(channel.models || []),
            }),
        );
    return channels.map((channel) => ({ ...channel, models: uniqueRawModels(channel.models) }));
}

function enforceSystemClientConfig(config: AiConfig): AiConfig {
    const channels = normalizeChannels(config);
    return { ...config, apiSource: "system", channelMode: "local", baseUrl: channels[0]?.baseUrl || "", apiKey: channels.length ? "system" : "", channels };
}

function uniqueRawModels(models: string[]) {
    return Array.from(new Set((models || []).map((model) => modelOptionName(model).trim()).filter(Boolean)));
}

function normalizedModelName(model: string) {
    return modelOptionName(model)
        .replace(/^models\//i, "")
        .trim()
        .toLowerCase();
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!normalizedBaseUrl.startsWith("/api/ai/system/")) throw new Error("客户端只能调用后台系统模型渠道");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
