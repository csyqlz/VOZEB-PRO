import { agnesModelCatalog, agnesModelConfigs } from "@/lib/agnes-model-catalog";
import { capabilityFromHint, inferModelCapability, isCreativeGenerationModel, normalizeModelId, type ModelCatalogEntry, type ModelCatalogSource } from "@/lib/model-capability";
import type { LogicalModelCapability } from "@/lib/auth/store-types";
import type { SystemChannelModelConfig, SystemChannelProtocol } from "@/lib/auth/store-types";
import { protocolCatalogCapability } from "@/lib/channel-protocol-registry";

type ModelsResponse = Record<string, unknown> & {
    data?: unknown;
    models?: unknown;
    result?: unknown;
    error?: unknown;
    message?: unknown;
    msg?: unknown;
};

const SOURCE_PRIORITY: Record<ModelCatalogSource, number> = { configured: 1, provider: 2, official: 3 };
const MODEL_CONTAINER_KEYS = ["data", "models", "result", "items", "list", "model_list", "modelList", "available_models", "availableModels"] as const;
const MODEL_METADATA_KEYS = new Set([
    "capability",
    "capabilities",
    "type",
    "task",
    "task_type",
    "taskType",
    "category",
    "kind",
    "endpoint",
    "route",
    "path",
    "modalities",
    "modality",
    "output_modalities",
    "outputModalities",
    "supported_generation_methods",
    "supportedGenerationMethods",
    "supported_endpoint_types",
    "supportedEndpointTypes",
    "supported_endpoints",
    "supportedEndpoints",
    "endpoints",
    "interfaces",
]);

export function buildModelsUrl(baseUrl: string, apiFormat: "openai" | "gemini", globalAiOpc = false) {
    const normalized = baseUrl
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/(?:chat\/completions|responses|images\/(?:generations|edits)|video\/generations|videos\/(?:generations)?)$/i, "");
    if (/\/models$/i.test(normalized)) return normalized;
    if (apiFormat === "gemini" && !globalAiOpc) return `${normalized.replace(/\/(?:v1|v1beta)$/i, "")}/v1beta/models`;
    return `${normalized.toLowerCase().endsWith("/v1") ? normalized : `${normalized}/v1`}/models`;
}

export function buildModelCatalogUrls(baseUrl: string, apiFormat: "openai" | "gemini", configuredPaths: unknown) {
    if (!Array.isArray(configuredPaths) || !configuredPaths.length) return [buildModelsUrl(baseUrl, apiFormat)];
    const base = new URL(baseUrl);
    return Array.from(
        new Set(
            configuredPaths.flatMap((value) => {
                if (typeof value !== "string" || !value.trim()) return [];
                try {
                    const url = new URL(value.trim(), base.origin);
                    return url.origin === base.origin ? [url.toString()] : [];
                } catch {
                    return [];
                }
            }),
        ),
    );
}

export function parseModels(payload: ModelsResponse) {
    return parseModelCatalog(payload).map((entry) => entry.id);
}

export function parseModelCatalog(payload: unknown, source: ModelCatalogSource = "provider", protocol?: SystemChannelProtocol) {
    return mergeModelCatalogEntries(
        ...collectModelValues(payload)
            .filter(({ id }) => isCreativeGenerationModel(id))
            .map(({ id, metadata }) => [
                {
                    id,
                    capability: resolveCatalogCapability(id, metadata, protocol),
                    source,
                },
            ]),
    );
}

export function parseModelConfigs(payload: unknown, protocol?: SystemChannelProtocol) {
    return Object.fromEntries(
        collectModelValues(payload)
            .filter(({ id }) => isCreativeGenerationModel(id))
            .map(({ id, metadata }) => {
                const capability = resolveCatalogCapability(id, metadata, protocol);
                return [normalizeModelId(id), { ...modelConfigFromMetadata(metadata, capability), source: "provider" as const }] as const;
            }),
    ) as Record<string, SystemChannelModelConfig>;
}

export function configuredModelCatalog(models: unknown, capabilities: unknown, configs?: Record<string, SystemChannelModelConfig>): ModelCatalogEntry[] {
    const capabilityMap = normalizeCapabilityMap(capabilities);
    if (!Array.isArray(models)) return [];
    return mergeModelCatalogEntries(
        models.flatMap((value) => {
            if (typeof value !== "string" || !value.trim()) return [];
            const id = value.trim().replace(/^models\//i, "");
            if (!isCreativeGenerationModel(id) && configs?.[normalizeModelId(id)]?.source !== "manual") return [];
            return [{ id, capability: capabilityMap[normalizeModelId(id)] || inferModelCapability(id), source: "configured" as const }];
        }),
    );
}

export function officialModelCatalog(baseUrl: string) {
    return agnesModelCatalog(baseUrl);
}

export function officialModelConfigs(baseUrl: string) {
    return agnesModelConfigs(baseUrl);
}

export function mergeModelCatalogEntries(...catalogs: ModelCatalogEntry[][]) {
    const merged = new Map<string, ModelCatalogEntry>();
    for (const entry of catalogs.flat()) {
        const id = entry.id.trim().replace(/^models\//i, "");
        const key = normalizeModelId(id);
        if (!key) continue;
        const current = merged.get(key);
        if (!current || SOURCE_PRIORITY[entry.source] > SOURCE_PRIORITY[current.source]) merged.set(key, { id, capability: entry.capability, source: entry.source });
    }
    return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export function modelCapabilitiesRecord(catalog: ModelCatalogEntry[], configs?: Record<string, SystemChannelModelConfig>) {
    return Object.fromEntries(catalog.map((entry) => [normalizeModelId(entry.id), configs?.[normalizeModelId(entry.id)]?.capability || entry.capability])) as Record<string, LogicalModelCapability>;
}

export function mergeModelConfigs(catalog: ModelCatalogEntry[], ...configs: Array<Record<string, SystemChannelModelConfig> | undefined>) {
    const merged: Record<string, SystemChannelModelConfig> = {};
    for (const config of configs) {
        for (const [model, incoming] of Object.entries(config || {})) {
            const key = normalizeModelId(model);
            const current = merged[key];
            if (current?.source === "manual" && incoming.source !== "manual") continue;
            merged[key] = { ...(current || {}), ...incoming };
        }
    }
    for (const entry of catalog) {
        const key = normalizeModelId(entry.id);
        const current = merged[key];
        merged[key] = current?.source === "manual" ? current : { ...(current || {}), capability: entry.capability };
    }
    return merged;
}

export function normalizeModelConfigs(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([model, config]) => {
            if (!config || typeof config !== "object" || Array.isArray(config)) return [];
            const raw = config as Record<string, unknown>;
            const capability = raw.capability;
            if (capability !== "text" && capability !== "image" && capability !== "video" && capability !== "audio") return [];
            return [
                [normalizeModelId(model), { ...modelConfigFromMetadata(raw, capability), ...(["manual", "provider", "official", "health"].includes(String(raw.source || "")) ? { source: raw.source as SystemChannelModelConfig["source"] } : {}) }] as const,
            ];
        }),
    ) as Record<string, SystemChannelModelConfig>;
}

export function modelConfigsFromOperations(catalog: ModelCatalogEntry[], value: unknown) {
    const operations = normalizeModelConfigs(value);
    return Object.fromEntries(
        catalog.flatMap((entry) => {
            const config = operations[entry.capability];
            return config ? [[normalizeModelId(entry.id), { ...config, capability: entry.capability, source: "provider" as const }] as const] : [];
        }),
    ) as Record<string, SystemChannelModelConfig>;
}

export function nextModelsPageUrl(currentUrl: string, payload: ModelsResponse, apiFormat: "openai" | "gemini", lastModelId: string) {
    const token = paginationString(payload, ["nextPageToken", "next_page_token"]);
    if (token) return withQuery(currentUrl, apiFormat === "gemini" ? "pageToken" : "page_token", token);

    const cursor = paginationString(payload, ["nextCursor", "next_cursor"]);
    if (cursor) return withQuery(currentUrl, "cursor", cursor);

    const next = paginationString(payload, ["next", "nextUrl", "next_url", "nextPageUrl", "next_page_url"]);
    if (next && (/^https?:\/\//i.test(next) || next.startsWith("/"))) {
        const candidate = new URL(next, currentUrl);
        if (candidate.origin === new URL(currentUrl).origin && candidate.toString() !== currentUrl) return candidate.toString();
    }

    const hasMore = paginationValue(payload, ["has_more", "hasMore"]);
    if (hasMore === true || hasMore === "true") {
        const after = paginationString(payload, ["last_id", "lastId"]) || lastModelId;
        if (after) return withQuery(currentUrl, "after", after);
    }
    return "";
}

export function isModelCatalogUnsupported(status: number, payload: ModelsResponse) {
    if (![404, 405, 501].includes(status)) return false;
    const message = JSON.stringify(payload).toLowerCase();
    return /\/models(?:["'\\s?]|$)/.test(message) && /no handler found|method not allowed|not implemented|route not found|endpoint not found/.test(message);
}

function collectModelValues(value: unknown, depth = 0): Array<{ id: string; metadata?: Record<string, unknown> }> {
    if (!value || depth > 5) return [];
    if (Array.isArray(value)) return value.flatMap((item) => collectModelValues(item, depth + 1));
    if (typeof value === "string") return value.trim() ? [{ id: value.trim() }] : [];
    if (typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const grouped = (["text", "image", "video", "audio"] as const).flatMap((capability) =>
        [record[capability], record[`${capability}_models`], record[`${capability}Models`]].flatMap((item) => collectModelValues(item, depth + 1).map((entry) => ({ ...entry, metadata: { capability, ...(entry.metadata || {}) } }))),
    );
    const nested = MODEL_CONTAINER_KEYS.flatMap((key) => collectModelValues(record[key], depth + 1));
    if (grouped.length || nested.length) return mergeCollectedModelValues([...grouped, ...nested]);
    const direct = [record.id, record.name, record.model, record.model_id, record.modelId, record.title].find((item) => typeof item === "string" && item.trim());
    if (typeof direct === "string") return [{ id: direct.trim(), metadata: record }];
    return mergeCollectedModelValues(collectModelMap(record));
}

function capabilityFromModelMetadata(record: Record<string, unknown> | undefined) {
    if (!record) return undefined;
    const directHints = [
        record.capability,
        record.type,
        record.task,
        record.task_type,
        record.taskType,
        record.category,
        record.kind,
        record.endpoint,
        record.route,
        record.path,
        record.capabilities,
        record.supported_generation_methods,
        record.supportedGenerationMethods,
        record.supported_endpoint_types,
        record.supportedEndpointTypes,
        record.supported_endpoints,
        record.supportedEndpoints,
        record.endpoints,
        record.interfaces,
    ];
    for (const hint of directHints) {
        const capability = capabilityFromHint(hint);
        if (capability) return capability;
    }
    const outputCapability = capabilityFromHint(record.output_modalities ?? record.outputModalities ?? record.output_modality ?? record.outputModality);
    if (outputCapability) return outputCapability;
    const modalities = record.modalities ?? record.modality;
    if (!Array.isArray(modalities) || modalities.length <= 1) return capabilityFromHint(modalities);
    return undefined;
}

function resolveCatalogCapability(model: string, metadata: Record<string, unknown> | undefined, protocol?: SystemChannelProtocol) {
    return capabilityFromModelMetadata(metadata) || (protocol ? protocolCatalogCapability(protocol) : undefined) || inferModelCapability(model);
}

function modelConfigFromMetadata(record: Record<string, unknown> | undefined, capability: LogicalModelCapability): SystemChannelModelConfig {
    if (!record) return { capability };
    const apiFormatHint = String(record.apiFormat ?? record.api_format ?? "")
        .trim()
        .toLowerCase();
    const apiFormat = apiFormatHint.includes("gemini") ? "gemini" : apiFormatHint.includes("openai") ? "openai" : undefined;
    const protocolValue = record.protocol;
    const protocol = isChannelProtocol(protocolValue) ? protocolValue : undefined;
    const createPath = firstApiPath(record, ["createPath", "create_path", "generationEndpoint", "generation_endpoint", "endpoint", "route", "path"]);
    const editPath = firstApiPath(record, ["editPath", "edit_path", "editEndpoint", "edit_endpoint", "imageEditEndpoint", "image_edit_endpoint"]);
    const imageToVideoPath = firstApiPath(record, ["imageToVideoPath", "image_to_video_path", "imageToVideoEndpoint", "image_to_video_endpoint", "i2vEndpoint", "i2v_endpoint"]);
    const queryPath = firstApiPath(record, ["queryPath", "query_path", "pollEndpoint", "poll_endpoint", "statusEndpoint", "status_endpoint", "taskEndpoint", "task_endpoint"]);
    const cancelPath = firstApiPath(record, ["cancelPath", "cancel_path", "cancelEndpoint", "cancel_endpoint"]);
    const cancelMethod = record.cancelMethod === "DELETE" || record.cancel_method === "DELETE" ? "DELETE" : record.cancelMethod === "POST" || record.cancel_method === "POST" ? "POST" : undefined;
    return {
        capability,
        ...(apiFormat === "openai" || apiFormat === "gemini" ? { apiFormat } : {}),
        ...(protocol ? { protocol } : {}),
        ...(createPath && !/\/models(?:\/|$)/i.test(createPath) ? { createPath } : {}),
        ...(editPath ? { editPath } : {}),
        ...(imageToVideoPath ? { imageToVideoPath } : {}),
        ...(queryPath ? { queryPath } : {}),
        ...(cancelPath ? { cancelPath } : {}),
        ...(cancelMethod ? { cancelMethod } : {}),
        ...optionalMetadataText(record, "requestTemplate", "request_template", 12_000),
        ...optionalMetadataText(record, "resultField", "result_field", 500),
        ...optionalMetadataText(record, "statusField", "status_field", 500),
        ...optionalMetadataText(record, "durationRange", "duration_range", 120),
        ...optionalMetadataText(record, "referenceRule", "reference_rule", 1_000),
        ...(typeof record.supportsReferenceImage === "boolean" ? { supportsReferenceImage: record.supportsReferenceImage } : {}),
        ...(typeof record.supportsReferenceVideo === "boolean" ? { supportsReferenceVideo: record.supportsReferenceVideo } : {}),
        ...(typeof record.supportsReferenceAudio === "boolean" ? { supportsReferenceAudio: record.supportsReferenceAudio } : {}),
    };
}

function optionalMetadataText(record: Record<string, unknown>, camelKey: string, snakeKey: string, max: number) {
    const value = record[camelKey] ?? record[snakeKey];
    return typeof value === "string" && value.trim() ? { [camelKey]: value.trim().slice(0, max) } : {};
}

function firstApiPath(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value !== "string" || !value.trim()) continue;
        try {
            const url = new URL(value);
            return `${url.pathname}${url.search}`;
        } catch {
            return value.trim().startsWith("/") ? value.trim() : "";
        }
    }
    return "";
}

function isChannelProtocol(value: unknown): value is SystemChannelProtocol {
    return (
        value === "auto" ||
        value === "openai" ||
        value === "siliconflow" ||
        value === "yumeng" ||
        value === "gemini" ||
        value === "sub2api" ||
        value === "newapi" ||
        value === "vozeb-recommended" ||
        value === "globalaiopc" ||
        value === "seedance" ||
        value === "stable-diffusion" ||
        value === "volcengine-video" ||
        value === "seedance-special" ||
        value === "custom" ||
        value === "compatible"
    );
}

function normalizeCapabilityMap(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, LogicalModelCapability>;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([model, capability]) => (capability === "text" || capability === "image" || capability === "video" || capability === "audio" ? [[normalizeModelId(model), capability] as const] : [])),
    ) as Record<string, LogicalModelCapability>;
}

function paginationValue(payload: ModelsResponse, keys: string[]) {
    const data = payload.data && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : undefined;
    const result = payload.result && !Array.isArray(payload.result) ? (payload.result as Record<string, unknown>) : undefined;
    const wrappers = [payload, payload.meta, payload.pagination, payload.links, data, data?.meta, data?.pagination, data?.links, result, result?.meta, result?.pagination, result?.links];
    for (const wrapper of wrappers) {
        if (!wrapper || typeof wrapper !== "object") continue;
        for (const key of keys) {
            const value = (wrapper as Record<string, unknown>)[key];
            if (value !== undefined && value !== null && value !== "") return value;
        }
    }
    return undefined;
}

function paginationString(payload: ModelsResponse, keys: string[]) {
    const value = paginationValue(payload, keys);
    return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function withQuery(currentUrl: string, key: string, value: string) {
    const url = new URL(currentUrl);
    url.searchParams.set(key, value);
    return url.toString();
}

function collectModelMap(record: Record<string, unknown>) {
    const entries = Object.entries(record).filter(([key]) => !MODEL_CONTAINER_KEYS.includes(key as (typeof MODEL_CONTAINER_KEYS)[number]) && !isCatalogMetadataKey(key));
    if (!entries.length) return [];
    const capabilityMap = entries.every(([, value]) => value === "text" || value === "image" || value === "video" || value === "audio");
    if (capabilityMap) return entries.map(([id, capability]) => ({ id, metadata: { capability } }));
    return entries.flatMap(([id, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const metadata = value as Record<string, unknown>;
        const looksLikeModel = Object.keys(metadata).some((key) => MODEL_METADATA_KEYS.has(key)) || /[./_-]|\d/.test(id);
        return looksLikeModel ? [{ id, metadata }] : [];
    });
}

function mergeCollectedModelValues(values: Array<{ id: string; metadata?: Record<string, unknown> }>) {
    const merged = new Map<string, { id: string; metadata?: Record<string, unknown> }>();
    for (const value of values) {
        const id = value.id.trim().replace(/^models\//i, "");
        const key = normalizeModelId(id);
        if (!key) continue;
        const current = merged.get(key);
        merged.set(key, current ? { id: current.id, metadata: { ...(value.metadata || {}), ...(current.metadata || {}) } } : { id, metadata: value.metadata });
    }
    return Array.from(merged.values());
}

function isCatalogMetadataKey(key: string) {
    return ["meta", "pagination", "links", "object", "has_more", "hasMore", "last_id", "lastId", "next", "next_url", "nextUrl", "next_page_url", "nextPageUrl", "next_page_token", "nextPageToken"].includes(key);
}
