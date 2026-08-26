import type { ApiCallFormat, LogicalModelCapability, SystemChannelAuthMode, SystemChannelModelConfig, SystemModelChannel } from "@/lib/auth/store-types";
import { parseChannelExampleConfig } from "@/lib/channel-example-parser";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { redactProtocolUrlSecrets, safeProtocolDocumentationUrl } from "@/lib/channel-protocol-security";

export type ChannelProtocolOperationDraft = {
    capability: LogicalModelCapability;
    apiFormat: ApiCallFormat;
    models: string[];
    config: SystemChannelModelConfig;
};

export type ChannelProtocolDraft = {
    baseUrl: string;
    apiFormat: ApiCallFormat;
    authMode: SystemChannelAuthMode;
    authHeader?: string;
    authPrefix?: string;
    documentationUrl?: string;
    modelCatalogPaths: string[];
    operations: ChannelProtocolOperationDraft[];
    summary: string[];
    assisted: boolean;
};

const capabilities = new Set<LogicalModelCapability>(["text", "image", "video", "audio"]);
const authModes = new Set<SystemChannelAuthMode>(["none", "bearer", "x-api-key", "custom-header"]);
const templateVariables = new Set([
    "model",
    "prompt",
    "input",
    "text",
    "messages",
    "size",
    "width",
    "height",
    "quality",
    "n",
    "count",
    "num_images",
    "batch_size",
    "ratio",
    "aspect_ratio",
    "resolution",
    "duration",
    "seconds",
    "image",
    "images",
    "video",
    "videos",
    "audio",
    "audios",
    "first_frame",
    "first_frame_url",
    "last_frame",
    "last_frame_url",
    "generate_audio",
    "voice",
    "format",
    "response_format",
    "speed",
    "references",
    "content",
]);

export function parseDeterministicProtocolDraft(input: { text: string; documentationUrl?: string }): ChannelProtocolDraft | null {
    const modelCatalogPaths = extractModelCatalogPaths(input.text);
    const operations = mergeOperations(
        protocolExampleSegments(input.text).flatMap((text) => {
            const channel: SystemModelChannel = { id: "draft", name: "自定义协议草稿", baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: false };
            const parsed = parseChannelExampleConfig(text, channel, emptyAdvancedConfig());
            if (!parsed) return [];
            const advanced = parsed.patch.advancedConfig || emptyAdvancedConfig();
            const request = exampleRequestLine(text);
            if (request && looksLikeModelCatalogPath(request.path)) return [];
            const role = requestRole(request);
            const capability = parsedCapability(advanced) || capabilityFromPath(request?.path || "");
            if (!capability) return [];
            const explicitPath = request && !request.absolute ? request.path : "";
            const createPath = role === "create" ? explicitPath || advanced.createPath : "";
            const config: SystemChannelModelConfig = {
                capability,
                source: "manual",
                protocol: "custom",
                apiFormat: parsed.patch.apiFormat || "openai",
                ...(createPath ? { createPath } : {}),
                ...(advanced.editPath ? { editPath: explicitPath || advanced.editPath } : {}),
                ...(advanced.imageToVideoPath ? { imageToVideoPath: explicitPath || advanced.imageToVideoPath } : {}),
                ...(role === "query" && request ? { queryPath: request.path } : role === "create" && advanced.queryPath ? { queryPath: advanced.queryPath } : {}),
                ...(role === "cancel" && request ? { cancelPath: request.path, cancelMethod: request.method === "DELETE" ? "DELETE" : "POST" } : {}),
                ...(role === "create" && advanced.requestTemplate ? { requestTemplate: advanced.requestTemplate } : {}),
                ...(role !== "cancel" && advanced.resultField ? { resultField: advanced.resultField } : {}),
                ...(role !== "cancel" && advanced.statusField ? { statusField: advanced.statusField } : {}),
                ...(role === "create" && advanced.durationRange ? { durationRange: advanced.durationRange } : {}),
                ...(role === "create" && advanced.referenceRule ? { referenceRule: advanced.referenceRule } : {}),
                supportsReferenceImage: advanced.supportsReferenceImage,
                supportsReferenceVideo: advanced.supportsReferenceVideo,
                supportsReferenceAudio: advanced.supportsReferenceAudio,
            };
            return [
                {
                    capability,
                    apiFormat: parsed.patch.apiFormat || "openai",
                    models: uniqueModels(parsed.patch.models || []).filter(isConcreteModel),
                    config,
                    baseUrl: parsed.patch.baseUrl || "",
                    summary: parsed.summary,
                },
            ];
        }),
    );
    if (!operations.length) return null;
    const auth = deterministicAuth(input.text);
    const baseUrl = operations.find((item) => item.baseUrl)?.baseUrl || inferDocumentedBaseUrl(input.text, operations);
    return validateProtocolDraft({
        baseUrl,
        apiFormat: operations[0]?.apiFormat || "openai",
        ...auth,
        documentationUrl: input.documentationUrl,
        modelCatalogPaths,
        operations: operations.map(({ baseUrl: _baseUrl, summary: _summary, ...operation }) => operation),
        summary: Array.from(new Set(operations.flatMap((item) => item.summary))).slice(0, 12),
        assisted: false,
    });
}

function inferDocumentedBaseUrl(source: string, operations: Array<ChannelProtocolOperationDraft & { baseUrl?: string }>) {
    const requestUrls = Array.from(source.matchAll(/(?:curl(?:\s+--url)?|GET|POST|PUT|PATCH|DELETE)\s+["']?(https?:\/\/[^\s"'\\<>]+)/gi), (match) => match[1].replace(/[),.;]+$/g, ""));
    const operationPaths = operations.flatMap((operation) => [operation.config.createPath, operation.config.editPath, operation.config.imageToVideoPath].filter((path): path is string => Boolean(path))).sort((left, right) => right.length - left.length);
    for (const value of requestUrls) {
        try {
            const url = new URL(value);
            const pathname = url.pathname.replace(/\/+$/g, "");
            const path = operationPaths.find((candidate) => pathname === candidate || pathname.endsWith(candidate));
            if (!path) continue;
            const prefix = pathname.slice(0, pathname.length - path.length).replace(/\/+$/g, "");
            return `${url.origin}${prefix}`;
        } catch {
            continue;
        }
    }
    return "";
}

export function protocolDraftFromUnknown(value: unknown, fallback?: ChannelProtocolDraft | null): ChannelProtocolDraft | null {
    if (!isRecord(value)) return fallback || null;
    const apiFormat = value.apiFormat === "gemini" ? "gemini" : value.apiFormat === "openai" ? "openai" : fallback?.apiFormat || "openai";
    const modelCatalogPaths = normalizeApiPaths(value.modelCatalogPaths);
    const operations = Array.isArray(value.operations) ? value.operations.flatMap((item) => operationFromUnknown(item, apiFormat)) : [];
    const authMode = authModes.has(value.authMode as SystemChannelAuthMode) ? (value.authMode as SystemChannelAuthMode) : fallback?.authMode || "bearer";
    return validateProtocolDraft({
        baseUrl: cleanUrl(value.baseUrl) || fallback?.baseUrl || "",
        apiFormat,
        authMode,
        ...optionalText("authHeader", value.authHeader, 120),
        ...optionalText("authPrefix", value.authPrefix, 120),
        documentationUrl: cleanUrl(value.documentationUrl) || fallback?.documentationUrl,
        modelCatalogPaths: Array.from(new Set([...(fallback?.modelCatalogPaths || []), ...modelCatalogPaths])),
        operations: mergeOperations([...(fallback?.operations || []), ...operations]),
        summary: Array.isArray(value.summary) ? value.summary.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim().slice(0, 200)] : [])).slice(0, 12) : fallback?.summary || [],
        assisted: true,
    });
}

export function validateProtocolDraft(draft: ChannelProtocolDraft): ChannelProtocolDraft | null {
    if (!draft.operations.length || draft.operations.some((operation) => !validateOperation(operation, draft.modelCatalogPaths.length > 0))) return null;
    if (draft.modelCatalogPaths.some((path) => !isApiPath(path))) return null;
    if (draft.authMode === "custom-header" && !draft.authHeader?.trim()) return null;
    return draft;
}

export function redactProtocolSecrets(value: string) {
    return redactProtocolUrlSecrets(value)
        .replace(/(authorization\s*:\s*bearer\s+)[^\s"'\\]+/gi, "$1[REDACTED]")
        .replace(/((?:^|[\r\n])\s*cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
        .replace(/((?:--cookie|-b)\s+)["'][^"']*["']/gi, '$1"[REDACTED]"')
        .replace(/(["']?(?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'\\}]+/gi, "$1[REDACTED]")
        .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[REDACTED]");
}

function operationFromUnknown(value: unknown, defaultApiFormat: ApiCallFormat): ChannelProtocolOperationDraft[] {
    if (!isRecord(value) || !capabilities.has(value.capability as LogicalModelCapability)) return [];
    const capability = value.capability as LogicalModelCapability;
    const apiFormat = value.apiFormat === "gemini" ? "gemini" : value.apiFormat === "openai" ? "openai" : defaultApiFormat;
    const rawConfig = isRecord(value.config) ? value.config : value;
    const config: SystemChannelModelConfig = {
        capability,
        source: "manual",
        protocol: "custom",
        apiFormat,
        ...optionalPath("createPath", rawConfig.createPath),
        ...optionalPath("editPath", rawConfig.editPath),
        ...optionalPath("imageToVideoPath", rawConfig.imageToVideoPath),
        ...optionalPath("queryPath", rawConfig.queryPath),
        ...optionalPath("cancelPath", rawConfig.cancelPath),
        ...(rawConfig.cancelMethod === "DELETE" || rawConfig.cancelMethod === "POST" ? { cancelMethod: rawConfig.cancelMethod } : {}),
        ...optionalText("requestTemplate", rawConfig.requestTemplate, 12_000),
        ...optionalText("resultField", rawConfig.resultField, 500),
        ...optionalText("statusField", rawConfig.statusField, 500),
        ...optionalText("durationRange", rawConfig.durationRange, 120),
        ...optionalText("referenceRule", rawConfig.referenceRule, 1_000),
        supportsReferenceImage: Boolean(rawConfig.supportsReferenceImage),
        supportsReferenceVideo: Boolean(rawConfig.supportsReferenceVideo),
        supportsReferenceAudio: Boolean(rawConfig.supportsReferenceAudio),
    };
    const models = Array.isArray(value.models) ? uniqueModels(value.models) : [];
    return [{ capability, apiFormat, models, config }];
}

function validateOperation(operation: ChannelProtocolOperationDraft, hasCatalog: boolean) {
    const config = operation.config;
    if (!capabilities.has(operation.capability) || config.capability !== operation.capability || !config.createPath || !config.requestTemplate) return false;
    if (!operation.models.length && !hasCatalog) return false;
    if (!config.resultField && operation.capability !== "audio") return false;
    if ([config.createPath, config.editPath, config.imageToVideoPath, config.queryPath, config.cancelPath].some((path) => path && !isApiPath(path))) return false;
    if (!isSafeJsonTemplate(config.requestTemplate)) return false;
    return !config.cancelMethod || config.cancelMethod === "POST" || config.cancelMethod === "DELETE";
}

function protocolExampleSegments(source: string) {
    const normalized = source.replace(/(^|\n)(\s*(?:GET|POST|PUT|PATCH|DELETE))\s*\r?\n\s*(https?:\/\/[^\s"'\\<>]+|\/(?!\/)[^\s"'\\<>]+)/gi, "$1$2 $3");
    const pages = normalized.split(/(?=^SOURCE\s+https?:\/\/)/gim).filter((page) => page.trim());
    return pages.flatMap((page) => {
        const starts = Array.from(page.matchAll(/(?:^|\n)\s*(?=curl\s|(?:GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/|\/(?!\/)))/gi), (match) => match.index || 0);
        if (starts.length < 2) return [page];
        return starts.map((start, index) => page.slice(start, starts[index + 1] || page.length)).filter((item) => item.trim());
    });
}

type ExampleRequestLine = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; absolute: boolean };

function exampleRequestLine(source: string): ExampleRequestLine | null {
    const match = source.match(/(?:^|\n)\s*(GET|POST|PUT|PATCH|DELETE)\s+["']?(https?:\/\/[^\s"'\\<>]+|\/(?!\/)[^\s"'\\<>]+)/i);
    if (match) return normalizeExampleRequest(match[1], match[2]);

    const curl = source.match(/(?:^|\n)\s*curl\b([\s\S]*?)(?=\n\s*(?:curl\b|GET|POST|PUT|PATCH|DELETE)\s+|$)/i)?.[1] || "";
    if (!curl) return null;
    const urlValue = curl.match(/--url(?:=|\s+)(["']?)(https?:\/\/[^\s"'\\<>]+|\/(?!\/)[^\s"'\\<>]+)\1/i)?.[2] || curl.match(/(?:^|\s)(["']?)(https?:\/\/[^\s"'\\<>]+|\/(?!\/)[^\s"'\\<>]+)\1/i)?.[2];
    if (!urlValue) return null;
    const method = curl.match(/(?:--request(?:=|\s+)|-X\s+)(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1] || (/(?:--data(?:-[a-z]+)?|--form(?:=|\s+)|(?:^|\s)-[dF]\s)/i.test(curl) ? "POST" : "GET");
    return normalizeExampleRequest(method, urlValue);
}

function normalizeExampleRequest(methodValue: string, value: string): ExampleRequestLine | null {
    const absolute = /^https?:\/\//i.test(value);
    let path = value.replace(/[),.;]+$/g, "");
    if (absolute) {
        try {
            const url = new URL(path);
            path = `${url.pathname}${url.search}`.replace(/%7B(?:task[_-]?id|id)%7D/gi, ":task_id");
        } catch {
            return null;
        }
    }
    path = path.replace(/\{(?:task[_-]?id|id)\}|:(?:task[_-]?id|taskId|id)\b/gi, ":task_id");
    return isApiPath(path) ? { method: methodValue.toUpperCase() as ExampleRequestLine["method"], path, absolute } : null;
}

function requestRole(request: ExampleRequestLine | null) {
    if (!request) return "create" as const;
    if (request.method === "DELETE" || (request.method === "POST" && /(?:^|[/_-])(?:cancel|abort|terminate)(?:$|[/?_-])/i.test(request.path))) return "cancel" as const;
    if (request.method === "GET" && /:task_id\b/i.test(request.path)) return "query" as const;
    return "create" as const;
}

function capabilityFromPath(path: string): LogicalModelCapability | null {
    if (/video|videos|i2v|t2v/i.test(path)) return "video";
    if (/image|images|txt2img|img2img/i.test(path)) return "image";
    if (/audio|speech|voice|tts/i.test(path)) return "audio";
    if (/chat|responses|completions/i.test(path)) return "text";
    return null;
}

function parsedCapability(config: ReturnType<typeof emptyAdvancedConfig>): LogicalModelCapability | null {
    const evidence = `${config.createPath}\n${config.requestTemplate}\n${config.resultField}`;
    if (config.videoModel || config.imageToVideoPath || /video|videos|i2v|t2v|video_url|\.mp4/i.test(evidence)) return "video";
    if (config.imageModel || config.editPath || /image|images|txt2img|img2img|image_url|b64_json/i.test(evidence)) return "image";
    if (config.textModel || /chat|responses|completions|choices\[0\]\.message/i.test(evidence)) return "text";
    if (/audio|speech|voice|tts|music|sound|binary/i.test(evidence)) return "audio";
    return null;
}

function mergeOperations<T extends ChannelProtocolOperationDraft & { baseUrl?: string; summary?: string[] }>(operations: T[]) {
    const merged = new Map<LogicalModelCapability, T>();
    for (const operation of operations) {
        const current = merged.get(operation.capability);
        if (!current) {
            merged.set(operation.capability, operation);
            continue;
        }
        merged.set(operation.capability, {
            ...current,
            ...operation,
            models: Array.from(new Set([...current.models, ...operation.models])),
            config: mergeOperationConfig(current.config, operation.config),
            baseUrl: current.baseUrl || operation.baseUrl,
            summary: Array.from(new Set([...(current.summary || []), ...(operation.summary || [])])),
        });
    }
    return Array.from(merged.values());
}

function mergeOperationConfig(current: SystemChannelModelConfig, incoming: SystemChannelModelConfig) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
        if (value !== undefined && value !== "" && value !== false) Object.assign(merged, { [key]: value });
    }
    merged.supportsReferenceImage = Boolean(current.supportsReferenceImage || incoming.supportsReferenceImage);
    merged.supportsReferenceVideo = Boolean(current.supportsReferenceVideo || incoming.supportsReferenceVideo);
    merged.supportsReferenceAudio = Boolean(current.supportsReferenceAudio || incoming.supportsReferenceAudio);
    merged.resultField = mergeFieldPaths(current.resultField, incoming.resultField);
    merged.statusField = mergeFieldPaths(current.statusField, incoming.statusField);
    return merged;
}

function mergeFieldPaths(current?: string, incoming?: string) {
    return Array.from(
        new Set(
            [current, incoming]
                .flatMap((value) => (value || "").split(/\s+\/\s+/))
                .map((value) => value.trim())
                .filter(Boolean),
        ),
    ).join(" / ");
}

function extractModelCatalogPaths(source: string) {
    const paths = Array.from(source.matchAll(/(?:https?:\/\/[^\s"'\\<>]+|\/(?!\/)[a-z0-9._~!$&'()*+,;=:@%/?#-]*models?(?:[a-z0-9._~!$&'()*+,;=:@%/?#-]*))/gi), (match) => match[0]);
    return normalizeApiPaths(
        paths.flatMap((value) => {
            try {
                const url = new URL(value);
                return [`${url.pathname}${url.search}`];
            } catch {
                return [value];
            }
        }),
    ).filter(looksLikeModelCatalogPath);
}

function looksLikeModelCatalogPath(path: string) {
    const lower = path.toLowerCase();
    return /(?:^|[/_-])models?(?:[/_-]?(?:list|catalog))?(?:$|[?])/i.test(lower) && !/[{:](?:model|model_id|id)\b/i.test(lower) && !/:generate(?:content|image|video)/i.test(lower);
}

function normalizeApiPaths(value: unknown) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.flatMap((item) => (typeof item === "string" && isApiPath(item.trim()) ? [item.trim().slice(0, 300)] : [])))).slice(0, 24);
}

function uniqueModels(value: unknown[]) {
    return Array.from(
        new Set(
            value.flatMap((item) =>
                typeof item === "string" && item.trim()
                    ? [
                          item
                              .trim()
                              .replace(/^models\//i, "")
                              .slice(0, 200),
                      ]
                    : [],
            ),
        ),
    ).slice(0, 2_000);
}

function isConcreteModel(value: string) {
    return !/^\s*(?:\{\{[^{}]+\}\}|<[^<>]+>|\[[^\[\]]+\]|model(?:[-_ ]?(?:id|name))?|your[-_ ]?model|authorization|api[-_ ]?key|token|bearer|string|required|example|placeholder|x+)\s*$/i.test(value);
}

function isSafeJsonTemplate(value: string) {
    try {
        const variables = Array.from(value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g), (match) => match[1]);
        if (variables.some((variable) => !templateVariables.has(variable))) return false;
        const parsed = JSON.parse(value.replace(/\{\{[^{}]+\}\}/g, "null")) as unknown;
        return isRecord(parsed) && !hasUnsafeObjectKey(parsed);
    } catch {
        return false;
    }
}

function hasUnsafeObjectKey(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasUnsafeObjectKey);
    if (!isRecord(value)) return false;
    return Object.entries(value).some(([key, item]) => ["__proto__", "prototype", "constructor"].includes(key.toLowerCase()) || hasUnsafeObjectKey(item));
}

function deterministicAuth(source: string): Pick<ChannelProtocolDraft, "authMode" | "authHeader" | "authPrefix"> {
    if (/\bx-api-key\s*:/i.test(source)) return { authMode: "x-api-key" };
    const header = source.match(/(?:--header|-H)\s+["']([^:"']+)\s*:\s*([^"']+)["']/i);
    if (header && !/^(?:authorization|content-type|accept|user-agent)$/i.test(header[1].trim())) {
        const value = header[2].trim();
        const prefix = value.match(/^([^\s{]+)\s+(?:\{\{|\[REDACTED\])/i)?.[1];
        return { authMode: "custom-header", authHeader: header[1].trim(), ...(prefix ? { authPrefix: prefix } : {}) };
    }
    if (!/authorization|api[_-]?key|token/i.test(source)) return { authMode: "none" };
    return { authMode: "bearer" };
}

function optionalPath(key: "createPath" | "editPath" | "imageToVideoPath" | "queryPath" | "cancelPath", value: unknown) {
    const path = cleanText(value, 300);
    return path && isApiPath(path) ? { [key]: path } : {};
}

function optionalText<K extends "requestTemplate" | "resultField" | "statusField" | "durationRange" | "referenceRule" | "authHeader" | "authPrefix">(key: K, value: unknown, max: number) {
    const text = cleanText(value, max);
    return text ? ({ [key]: text } as Record<K, string>) : {};
}

function isApiPath(value: string) {
    return /^\/(?!\/)[^\s?#]*(?:\?[^\s#]*)?$/.test(value) && !value.includes("..") && !/^\/api\/ai\/system\//i.test(value);
}

function cleanUrl(value: unknown) {
    return safeProtocolDocumentationUrl(cleanText(value, 2_000)).replace(/\/+$/, "");
}

function cleanText(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
