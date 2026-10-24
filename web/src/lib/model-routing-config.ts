import type { LogicalModel, LogicalModelBinding, LogicalModelCapability, LogicalModelCapabilityProfile, SystemDefaultModels, SystemModelChannel } from "@/lib/auth/store";
import { resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";
import { inferModelCapability, isCreativeGenerationModel, normalizeModelId } from "@/lib/model-capability";
import { channelConnectionReady, protocolCatalogCapability, resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { currentChannelModels } from "@/lib/channel-model-availability";

const CAPABILITY_DEFAULT_KEYS = {
    text: "textModel",
    image: "imageModel",
    video: "videoModel",
    audio: "audioModel",
} as const satisfies Record<LogicalModelCapability, keyof SystemDefaultModels>;

export function normalizeLogicalModelsConfig(models: LogicalModel[] | undefined, channels: SystemModelChannel[]) {
    return synchronizeLogicalModelsWithChannels(Array.isArray(models) ? models : [], channels);
}

export function deriveLogicalModelsConfig(channels: SystemModelChannel[]): LogicalModel[] {
    return synchronizeLogicalModelsWithChannels([], channels);
}

export function synchronizeLogicalModelsWithChannels(existingModels: LogicalModel[], channels: SystemModelChannel[]): LogicalModel[] {
    const catalog = new Map<
        string,
        {
            upstreamModel: string;
            capability: LogicalModelCapability;
            authoritative: boolean;
            bindings: Array<{ channel: SystemModelChannel; channelIndex: number; upstreamModel: string }>;
        }
    >();
    channels.forEach((channel, channelIndex) => {
        channel.models.forEach((upstreamModel) => {
            const id = rawModelName(upstreamModel);
            if (!id || !isCreativeGenerationModel(id)) return;
            const key = normalizeModelName(id);
            const detected = resolveChannelModelCapability(channel, upstreamModel);
            const model = catalog.get(key) || { upstreamModel: id, capability: detected.capability, authoritative: detected.authoritative, bindings: [] };
            if ((!model.authoritative && detected.authoritative) || (model.capability === "text" && detected.capability !== "text")) {
                model.capability = detected.capability;
                model.authoritative = detected.authoritative;
            }
            if (!model.bindings.some((binding) => binding.channel.id === channel.id)) model.bindings.push({ channel, channelIndex, upstreamModel });
            catalog.set(key, model);
        });
    });

    const usedExistingIds = new Set<string>();
    const usedModelIds = new Set<string>();
    return Array.from(catalog.entries()).flatMap(([modelKey, catalogModel]) => {
        const matchingModels = existingModels.filter((model) => model.bindings?.some((binding) => normalizeModelName(binding.upstreamModel) === modelKey));
        const availableModels = matchingModels.filter((model) => !usedExistingIds.has(model.id.toLowerCase()));
        const currentModels = availableModels.filter((model) => model.bindings.some((binding) => catalogModel.bindings.some((item) => item.channel.id === binding.channelId && normalizeModelName(binding.upstreamModel) === modelKey)));
        const variants = currentModels.length ? currentModels : [availableModels.find((model) => normalizeModelName(model.id) === modelKey) || availableModels[0]];
        return variants.map((existing) => {
            if (existing) usedExistingIds.add(existing.id.toLowerCase());
            const id = uniqueLogicalModelId(existing?.id || catalogModel.upstreamModel, usedModelIds);
            const channelBindings =
                currentModels.length > 1 ? catalogModel.bindings.filter((item) => existing?.bindings.some((binding) => binding.channelId === item.channel.id && normalizeModelName(binding.upstreamModel) === modelKey)) : catalogModel.bindings;
            const bindings = channelBindings
                .map(({ channel, channelIndex, upstreamModel }) => {
                    const stored = currentModels.length > 1 ? existing?.bindings.find((binding) => binding.channelId === channel.id && normalizeModelName(binding.upstreamModel) === modelKey) : findStoredBinding(existingModels, channel.id, upstreamModel);
                    const capabilityProfile = normalizeStoredCapabilityProfile(stored?.capabilityProfile);
                    const weight = clampWeight(stored?.weight);
                    const protocol = resolveChannelModelConfig(channel.advancedConfig, upstreamModel)?.protocol || channel.advancedConfig?.protocol;
                    return {
                        id: text(stored?.id, 120) || `${channel.id}:${rawModelName(upstreamModel)}`,
                        channelId: channel.id,
                        upstreamModel,
                        enabled: stored?.enabled !== false,
                        ...(stored?.acceptanceOnly === true || (!stored && catalogModel.capability === "text" && protocol === "anthropic") ? { acceptanceOnly: true } : {}),
                        priority: clampPriority(stored?.priority, channelIndex + 1),
                        ...(weight !== undefined ? { weight } : {}),
                        ...(capabilityProfile ? { capabilityProfile } : {}),
                    };
                })
                .sort(compareLogicalModelBindings);
            return {
                id,
                name: text(existing?.name, 120) || catalogModel.upstreamModel,
                ...(text(existing?.manufacturer, 80) ? { manufacturer: text(existing?.manufacturer, 80) } : {}),
                ...(text(existing?.series, 80) ? { series: text(existing?.series, 80) } : {}),
                capability: catalogModel.authoritative || !existing ? catalogModel.capability : normalizeCapability(existing.capability),
                enabled: existing?.enabled !== false,
                bindings,
            };
        });
    });
}

export function mergeChannelModelsIntoLogicalModels(logicalModels: LogicalModel[], channels: SystemModelChannel[]) {
    return synchronizeLogicalModelsWithChannels(logicalModels, channels);
}

export function normalizeDefaultModelsConfig(defaults: Partial<SystemDefaultModels> | undefined, logicalModels: LogicalModel[], channels: SystemModelChannel[]): SystemDefaultModels {
    return Object.fromEntries(
        (Object.entries(CAPABILITY_DEFAULT_KEYS) as Array<[LogicalModelCapability, keyof SystemDefaultModels]>).map(([capability, key]) => {
            const modelId = text(defaults?.[key], 120);
            if (!modelId || isLogicalModelResolvable(logicalModels, channels, capability, modelId)) return [key, modelId];
            const fallback = logicalModels.find((model) => model.capability === capability && isLogicalModelResolvable(logicalModels, channels, capability, model.id));
            return [key, fallback?.id || ""];
        }),
    ) as SystemDefaultModels;
}

export function isLogicalModelResolvable(logicalModels: LogicalModel[], channels: SystemModelChannel[], capability: LogicalModelCapability, modelId: string) {
    return Boolean(resolveLogicalModelConfig(logicalModels, channels, capability, modelId));
}

export function resolveLogicalModelConfig(logicalModels: LogicalModel[], channels: SystemModelChannel[], capability: LogicalModelCapability, modelId: string) {
    const logical = logicalModels.find((model) => model.enabled && model.capability === capability && model.id.toLowerCase() === rawModelName(modelId).toLowerCase());
    if (!logical) return null;
    const bindings = [...logical.bindings].filter((binding) => binding.enabled).sort(compareLogicalModelBindings);
    for (const binding of bindings) {
        const channel = channels.find((item) => item.id === binding.channelId && item.enabled && channelConnectionReady(item) && channelSupportsModel({ models: currentChannelModels(item) }, binding.upstreamModel));
        if (channel) return { logicalModel: logical, binding, channel };
    }
    return null;
}

export function compareLogicalModelBindings(left: Pick<LogicalModelBinding, "priority" | "weight" | "id">, right: Pick<LogicalModelBinding, "priority" | "weight" | "id">) {
    return left.priority - right.priority || (right.weight || 100) - (left.weight || 100) || left.id.localeCompare(right.id);
}

export function modelRoutingValidationErrors(logicalModels: LogicalModel[], channels: SystemModelChannel[], defaults: SystemDefaultModels) {
    const errors: string[] = [];
    const modelIds = new Set<string>();
    for (const model of logicalModels) {
        const key = rawModelName(model.id).toLowerCase();
        if (!key) errors.push("逻辑模型 ID 不能为空");
        else if (modelIds.has(key)) errors.push(`逻辑模型 ID 重复：${model.id}`);
        modelIds.add(key);
        if (!model.bindings.length) errors.push(`逻辑模型 ${model.name || model.id} 至少需要一个渠道绑定`);
        const bindingKeys = new Set<string>();
        for (const binding of model.bindings) {
            const channel = channels.find((item) => item.id === binding.channelId);
            const bindingKey = `${binding.channelId}:${normalizeModelName(binding.upstreamModel)}`;
            if (!channel) errors.push(`逻辑模型 ${model.id} 引用了不存在的渠道`);
            else if (!channelSupportsModel(channel, binding.upstreamModel)) errors.push(`渠道 ${channel.name} 未启用上游模型 ${binding.upstreamModel}`);
            if (bindingKeys.has(bindingKey)) errors.push(`逻辑模型 ${model.id} 存在重复绑定`);
            bindingKeys.add(bindingKey);
        }
    }
    for (const [capability, key] of Object.entries(CAPABILITY_DEFAULT_KEYS) as Array<[LogicalModelCapability, keyof SystemDefaultModels]>) {
        const modelId = defaults[key];
        if (modelId && !isLogicalModelResolvable(logicalModels, channels, capability, modelId)) errors.push(`默认${capabilityLabel(capability)}模型不可解析：${modelId}`);
    }
    return Array.from(new Set(errors));
}

export function capabilityLabel(capability: LogicalModelCapability) {
    return capability === "text" ? "文本" : capability === "image" ? "图片" : capability === "video" ? "视频" : "音频";
}

export function channelModelCapability(channel: Pick<SystemModelChannel, "advancedConfig">, model: string): LogicalModelCapability {
    return resolveChannelModelCapability(channel, model).capability;
}

function resolveChannelModelCapability(channel: Pick<SystemModelChannel, "advancedConfig">, model: string) {
    const key = normalizeModelId(model);
    if (key === "auto") return { capability: "text" as const, authoritative: true };
    const protocolCapability = protocolCatalogCapability(channel.advancedConfig?.protocol || "auto");
    if (protocolCapability) return { capability: protocolCapability, authoritative: true };
    const config = channel.advancedConfig?.modelConfigs?.[key];
    const inferred = inferModelCapability(model);
    if (config?.source === "health" && inferred !== "text") return { capability: inferred, authoritative: true };
    const configured = config?.capability || channel.advancedConfig?.modelCapabilities?.[key];
    if (!config && configured === "text" && inferred !== "text") return { capability: inferred, authoritative: true };
    return configured ? { capability: configured, authoritative: true } : { capability: inferred, authoritative: false };
}

export function channelDetectedCapabilities(channel: Pick<SystemModelChannel, "baseUrl" | "advancedConfig" | "models">) {
    return new Set(
        currentChannelModels(channel)
            .filter(isCreativeGenerationModel)
            .map((model) => channelModelCapability(channel, model)),
    );
}

export function resolveLogicalModelCapabilityProfile(binding: Pick<LogicalModelBinding, "capabilityProfile">, capability: LogicalModelCapability, channel?: Pick<SystemModelChannel, "advancedConfig">, upstreamModel = "") {
    if (!binding.capabilityProfile && !channel?.advancedConfig) return undefined;
    const stored = binding.capabilityProfile || {};
    const advanced = channel?.advancedConfig;
    const globalPreset = resolveGlobalAiOpcPreset(advanced, upstreamModel);
    const modelConfig = resolveChannelModelConfig(advanced, upstreamModel) || advanced?.operationConfigs?.[capability];
    return {
        supportsReferenceImage: booleanValue(stored.supportsReferenceImage, globalPreset?.supportsReferenceImage ?? modelConfig?.supportsReferenceImage ?? advanced?.supportsReferenceImage),
        supportsReferenceVideo: booleanValue(stored.supportsReferenceVideo, globalPreset?.supportsReferenceVideo ?? modelConfig?.supportsReferenceVideo ?? advanced?.supportsReferenceVideo),
        supportsReferenceAudio: booleanValue(stored.supportsReferenceAudio, globalPreset?.supportsReferenceAudio ?? modelConfig?.supportsReferenceAudio ?? advanced?.supportsReferenceAudio),
        maxReferenceImages: positiveInteger(stored.maxReferenceImages),
        aspectRatios: normalizeAspectRatios(stored.aspectRatios),
        resolutions: normalizeTextOptions(stored.resolutions, 20),
        durationSeconds: normalizePositiveIntegers(stored.durationSeconds, 64),
        minDurationSeconds: positiveNumber(stored.minDurationSeconds),
        maxDurationSeconds: positiveNumber(stored.maxDurationSeconds),
        maxBatchSize: positiveInteger(stored.maxBatchSize),
        supportsAsync: booleanValue(stored.supportsAsync, capability === "video" || capability === "image"),
        supportsCancel: booleanValue(stored.supportsCancel),
        supportsWebhook: booleanValue(stored.supportsWebhook),
        timeoutMs: timeoutMilliseconds(stored.timeoutMs),
        concurrencyLimit: positiveInteger(stored.concurrencyLimit),
        unitCost: positiveNumber(stored.unitCost),
        unitCostCurrency: text(stored.unitCostCurrency, 12) || undefined,
    };
}

function channelSupportsModel(channel: Pick<SystemModelChannel, "models">, model: string) {
    const target = normalizeModelName(model);
    return Boolean(target && channel.models.some((item) => normalizeModelName(item) === target));
}

function findStoredBinding(models: LogicalModel[], channelId: string, upstreamModel: string) {
    const modelKey = normalizeModelName(upstreamModel);
    return models.flatMap((model) => model.bindings || []).find((binding) => binding.channelId === channelId && normalizeModelName(binding.upstreamModel) === modelKey);
}

function uniqueLogicalModelId(value: string, usedIds: Set<string>) {
    const base = text(rawModelName(value), 120) || "model";
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate.toLowerCase())) {
        const ending = `-${suffix++}`;
        candidate = `${base.slice(0, 120 - ending.length)}${ending}`;
    }
    usedIds.add(candidate.toLowerCase());
    return candidate;
}

function normalizeStoredCapabilityProfile(value: unknown): LogicalModelCapabilityProfile | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const profile: LogicalModelCapabilityProfile = {
        supportsReferenceImage: optionalBoolean(input.supportsReferenceImage),
        supportsReferenceVideo: optionalBoolean(input.supportsReferenceVideo),
        supportsReferenceAudio: optionalBoolean(input.supportsReferenceAudio),
        maxReferenceImages: positiveInteger(input.maxReferenceImages),
        aspectRatios: normalizeAspectRatios(input.aspectRatios),
        resolutions: normalizeTextOptions(input.resolutions, 20),
        durationSeconds: normalizePositiveIntegers(input.durationSeconds, 64),
        minDurationSeconds: positiveNumber(input.minDurationSeconds),
        maxDurationSeconds: positiveNumber(input.maxDurationSeconds),
        maxBatchSize: positiveInteger(input.maxBatchSize),
        supportsAsync: optionalBoolean(input.supportsAsync),
        supportsCancel: optionalBoolean(input.supportsCancel),
        supportsWebhook: optionalBoolean(input.supportsWebhook),
        timeoutMs: timeoutMilliseconds(input.timeoutMs),
        concurrencyLimit: positiveInteger(input.concurrencyLimit),
        unitCost: positiveNumber(input.unitCost),
        unitCostCurrency: text(input.unitCostCurrency, 12) || undefined,
    };
    return Object.values(profile).some((item) => item !== undefined && (!Array.isArray(item) || item.length > 0)) ? profile : undefined;
}

function optionalBoolean(value: unknown) {
    return typeof value === "boolean" ? value : undefined;
}

function booleanValue(value: unknown, fallback = false) {
    return typeof value === "boolean" ? value : Boolean(fallback);
}

function positiveInteger(value: unknown) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(number, 1000000) : undefined;
}

function timeoutMilliseconds(value: unknown) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(number, 30 * 60_000) : undefined;
}

function positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(number, 100000000) : undefined;
}

function normalizeAspectRatios(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    const ratios = Array.from(
        new Set(
            value
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim().slice(0, 20))
                .filter(Boolean),
        ),
    ).slice(0, 12);
    return ratios.length ? ratios : undefined;
}

function normalizeTextOptions(value: unknown, maxLength: number) {
    if (!Array.isArray(value)) return undefined;
    const options = new Map<string, string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const normalized = item.trim().slice(0, maxLength);
        if (normalized) options.set(normalized.toLowerCase(), normalized);
    }
    const result = Array.from(options.values()).slice(0, 24);
    return result.length ? result : undefined;
}

function normalizePositiveIntegers(value: unknown, limit: number) {
    if (!Array.isArray(value)) return undefined;
    const result = Array.from(new Set(value.map(positiveInteger).filter((item): item is number => item !== undefined)))
        .sort((left, right) => left - right)
        .slice(0, limit);
    return result.length ? result : undefined;
}

function normalizeModelName(value: string) {
    return rawModelName(value).toLowerCase();
}

function rawModelName(value: string) {
    return String(value || "")
        .trim()
        .replace(/^models\//i, "");
}

function normalizeCapability(value: unknown): LogicalModelCapability {
    return value === "image" || value === "video" || value === "audio" ? value : "text";
}

function clampPriority(value: unknown, fallback: number) {
    return Math.max(1, Math.min(10000, Math.floor(Number(value) || fallback)));
}

function clampWeight(value: unknown) {
    const weight = Math.floor(Number(value));
    return Number.isFinite(weight) && weight > 0 ? Math.min(weight, 10000) : undefined;
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
