import { safeProtocolDocumentationUrl } from "@/lib/channel-protocol-security";
import { isGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";

import type { LogicalModelCapability, SystemChannelAdvancedConfig, SystemChannelProtocol } from "./store-types";

const CHANNEL_PROTOCOLS: SystemChannelProtocol[] = ["auto", "openai", "yumeng", "gemini", "sub2api", "newapi", "vozeb-recommended", "globalaiopc", "seedance", "stable-diffusion", "volcengine-video", "seedance-special", "custom", "compatible"];

export function normalizeSystemChannelAdvancedConfig(config: Partial<SystemChannelAdvancedConfig> | undefined): SystemChannelAdvancedConfig | undefined {
    if (!config || typeof config !== "object") return undefined;
    const protocol = CHANNEL_PROTOCOLS.includes(config.protocol || "auto") ? config.protocol! : "auto";
    const globalAiOpcPresets = Array.from(new Set((Array.isArray(config.globalAiOpcPresets) ? config.globalAiOpcPresets : []).filter(isGlobalAiOpcPreset)));
    const legacyGlobalAiOpcPreset = isGlobalAiOpcPreset(config.globalAiOpcPreset) ? config.globalAiOpcPreset : undefined;
    const modelCapabilities = normalizeChannelModelCapabilities(config.modelCapabilities);
    const modelConfigs = normalizeChannelModelConfigs(config.modelConfigs);
    const operationConfigs = normalizeChannelOperationConfigs(config.operationConfigs);
    const modelCatalogPaths = Array.from(new Set((Array.isArray(config.modelCatalogPaths) ? config.modelCatalogPaths : []).map(normalizeApiPath).filter(Boolean))).slice(0, 12);
    return {
        protocol,
        ...(config.authMode === "none" || config.authMode === "bearer" || config.authMode === "x-api-key" || config.authMode === "custom-header" ? { authMode: config.authMode } : {}),
        ...(textOrEmpty(config.authHeader, 120) ? { authHeader: textOrEmpty(config.authHeader, 120) } : {}),
        ...(textOrEmpty(config.authPrefix, 120) ? { authPrefix: textOrEmpty(config.authPrefix, 120) } : {}),
        ...(normalizeDocumentationUrl(config.documentationUrl) ? { documentationUrl: normalizeDocumentationUrl(config.documentationUrl) } : {}),
        ...(globalAiOpcPresets.length
            ? { globalAiOpcPresets, ...(globalAiOpcPresets.length === 1 ? { globalAiOpcPreset: globalAiOpcPresets[0] } : {}) }
            : legacyGlobalAiOpcPreset
              ? { globalAiOpcPreset: legacyGlobalAiOpcPreset, globalAiOpcPresets: [legacyGlobalAiOpcPreset] }
              : {}),
        textModel: textOrEmpty(config.textModel, 120),
        imageModel: textOrEmpty(config.imageModel, 120),
        videoModel: textOrEmpty(config.videoModel, 120),
        createPath: normalizeApiPath(config.createPath),
        editPath: normalizeApiPath(config.editPath),
        imageToVideoPath: normalizeApiPath(config.imageToVideoPath),
        queryPath: normalizeApiPath(config.queryPath),
        ...(normalizeApiPath(config.cancelPath) ? { cancelPath: normalizeApiPath(config.cancelPath) } : {}),
        ...(config.cancelMethod === "POST" || config.cancelMethod === "DELETE" ? { cancelMethod: config.cancelMethod } : {}),
        requestTemplate: textOrEmpty(config.requestTemplate, 12_000),
        resultField: textOrEmpty(config.resultField, 500),
        statusField: textOrEmpty(config.statusField, 500),
        durationRange: textOrEmpty(config.durationRange, 120),
        referenceRule: textOrEmpty(config.referenceRule, 1000),
        supportsReferenceImage: Boolean(config.supportsReferenceImage),
        supportsReferenceVideo: Boolean(config.supportsReferenceVideo),
        supportsReferenceAudio: Boolean(config.supportsReferenceAudio),
        ...(normalizeStreamingConfig(config.streaming) ? { streaming: normalizeStreamingConfig(config.streaming) } : {}),
        ...(normalizePositiveInteger(config.contextWindowTokens) ? { contextWindowTokens: normalizePositiveInteger(config.contextWindowTokens) } : {}),
        ...(modelCatalogPaths.length ? { modelCatalogPaths } : {}),
        ...(Object.keys(modelCapabilities).length ? { modelCapabilities } : {}),
        ...(Object.keys(modelConfigs).length ? { modelConfigs } : {}),
        ...(Object.keys(operationConfigs).length ? { operationConfigs } : {}),
    };
}

export function normalizeApiPath(value: unknown) {
    const path = textOrEmpty(value, 300);
    if (!path) return "";
    return path.startsWith("/") ? path : `/${path}`;
}

export function textOrEmpty(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeChannelModelCapabilities(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as NonNullable<SystemChannelAdvancedConfig["modelCapabilities"]>;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([model, capability]) => {
            const key = normalizeChannelModelKey(model);
            return key && isModelCapability(capability) ? [[key, capability] as const] : [];
        }),
    ) as NonNullable<SystemChannelAdvancedConfig["modelCapabilities"]>;
}

function normalizeChannelModelConfigs(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as NonNullable<SystemChannelAdvancedConfig["modelConfigs"]>;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([model, raw]) => {
            const key = normalizeChannelModelKey(model);
            if (!key || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const config = raw as Record<string, unknown>;
            if (!isModelCapability(config.capability)) return [];
            const protocol = CHANNEL_PROTOCOLS.includes(String(config.protocol || "") as SystemChannelProtocol) ? (config.protocol as SystemChannelProtocol) : undefined;
            return [
                [
                    key,
                    {
                        capability: config.capability,
                        ...(["manual", "provider", "official", "health"].includes(String(config.source || "")) ? { source: config.source as "manual" | "provider" | "official" | "health" } : {}),
                        ...(config.apiFormat === "openai" || config.apiFormat === "gemini" ? { apiFormat: config.apiFormat } : {}),
                        ...(protocol ? { protocol } : {}),
                        ...(normalizeApiPath(config.createPath) ? { createPath: normalizeApiPath(config.createPath) } : {}),
                        ...(normalizeApiPath(config.editPath) ? { editPath: normalizeApiPath(config.editPath) } : {}),
                        ...(normalizeApiPath(config.imageToVideoPath) ? { imageToVideoPath: normalizeApiPath(config.imageToVideoPath) } : {}),
                        ...(normalizeApiPath(config.queryPath) ? { queryPath: normalizeApiPath(config.queryPath) } : {}),
                        ...(normalizeApiPath(config.cancelPath) ? { cancelPath: normalizeApiPath(config.cancelPath) } : {}),
                        ...(config.cancelMethod === "POST" || config.cancelMethod === "DELETE" ? { cancelMethod: config.cancelMethod } : {}),
                        ...(textOrEmpty(config.requestTemplate, 12_000) ? { requestTemplate: textOrEmpty(config.requestTemplate, 12_000) } : {}),
                        ...(textOrEmpty(config.resultField, 500) ? { resultField: textOrEmpty(config.resultField, 500) } : {}),
                        ...(textOrEmpty(config.statusField, 500) ? { statusField: textOrEmpty(config.statusField, 500) } : {}),
                        ...(textOrEmpty(config.durationRange, 120) ? { durationRange: textOrEmpty(config.durationRange, 120) } : {}),
                        ...(textOrEmpty(config.referenceRule, 1000) ? { referenceRule: textOrEmpty(config.referenceRule, 1000) } : {}),
                        ...(typeof config.supportsReferenceImage === "boolean" ? { supportsReferenceImage: config.supportsReferenceImage } : {}),
                        ...(typeof config.supportsReferenceVideo === "boolean" ? { supportsReferenceVideo: config.supportsReferenceVideo } : {}),
                        ...(typeof config.supportsReferenceAudio === "boolean" ? { supportsReferenceAudio: config.supportsReferenceAudio } : {}),
                        ...(normalizeStreamingConfig(config.streaming) ? { streaming: normalizeStreamingConfig(config.streaming) } : {}),
                    },
                ] as const,
            ];
        }),
    ) as NonNullable<SystemChannelAdvancedConfig["modelConfigs"]>;
}

function normalizeStreamingConfig(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const path = normalizeApiPath(input.path);
    const format = input.format === "sse" || input.format === "ndjson" ? input.format : undefined;
    if (input.enabled !== true && input.enabled !== false && !path && !format) return undefined;
    return { ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}), ...(path ? { path } : {}), ...(format ? { format } : {}) } as SystemChannelAdvancedConfig["streaming"];
}

function normalizePositiveInteger(value: unknown) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeChannelOperationConfigs(value: unknown) {
    const configs = normalizeChannelModelConfigs(value);
    return Object.fromEntries(Object.entries(configs).filter(([capability, config]) => capability === config.capability && isModelCapability(capability))) as NonNullable<SystemChannelAdvancedConfig["operationConfigs"]>;
}

function normalizeDocumentationUrl(value: unknown) {
    return safeProtocolDocumentationUrl(textOrEmpty(value, 2_000));
}

function normalizeChannelModelKey(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase()
        .slice(0, 200);
}

function isModelCapability(value: unknown): value is LogicalModelCapability {
    return value === "text" || value === "image" || value === "video" || value === "audio";
}
