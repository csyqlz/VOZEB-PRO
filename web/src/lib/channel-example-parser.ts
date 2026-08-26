import type { SystemChannelAdvancedConfig, SystemChannelProtocol, SystemModelChannel } from "@/lib/auth/store";
import { textContainsUrlHost } from "@/lib/url-host";

type ChannelExampleParseResult = {
    patch: Partial<SystemModelChannel>;
    summary: string[];
};

type ExampleKind = "text" | "image" | "image-edit" | "video" | "audio" | "unknown";

type EndpointSpec = {
    marker: string;
    kind: ExampleKind;
};

type EndpointMatch = EndpointSpec & {
    baseUrl?: string;
    createPath: string;
    requestUrl?: string;
};

const ENDPOINT_SPECS: EndpointSpec[] = [
    { marker: "/kyyReactApiServer/v2/model-center/tasks", kind: "unknown" },
    { marker: "/v1/seedance-special/videos", kind: "video" },
    { marker: "/sdapi/v1/txt2img", kind: "image" },
    { marker: "/sdapi/v1/img2img", kind: "image-edit" },
    { marker: "/contents/generations/tasks", kind: "video" },
    { marker: "/videos/videos", kind: "video" },
    { marker: "/videos/generations", kind: "video" },
    { marker: "/video/generations", kind: "video" },
    { marker: "/images/generations", kind: "image" },
    { marker: "/images/edits", kind: "image-edit" },
    { marker: "/audio/speech", kind: "audio" },
    { marker: "/chat/completions", kind: "text" },
    { marker: "/responses", kind: "text" },
    { marker: "/videos", kind: "video" },
];

const IMAGE_REFERENCE_KEYS = new Set(["image", "images", "image_url", "image_urls", "input_image", "input_images", "ref_assets", "reference_image", "reference_images", "first_frame_url", "first_frame_image", "last_frame_url", "last_frame_image"]);
const VIDEO_REFERENCE_KEYS = new Set(["referencevideo", "referencevideos", "reference_video", "reference_videos", "video", "videos", "input_video", "input_videos"]);
const AUDIO_REFERENCE_KEYS = new Set(["referenceaudio", "referenceaudios", "reference_audio", "reference_audios", "audio", "audios", "input_audio", "input_audios"]);
const RESULT_URL_KEYS = new Set([
    "url",
    "image_url",
    "imageUrl",
    "video_url",
    "videoUrl",
    "media_url",
    "mediaUrl",
    "output_url",
    "outputUrl",
    "download_url",
    "downloadUrl",
    "file_url",
    "fileUrl",
    "asset_url",
    "assetUrl",
    "result_url",
    "resultUrl",
    "content_url",
    "contentUrl",
    "source_url",
    "sourceUrl",
    "play_url",
    "playUrl",
    "stream_url",
    "streamUrl",
    "b64_json",
    "base64",
    "image_base64",
    "imageBase64",
]);
const STATUS_KEYS = new Set(["status", "state", "task_status", "taskStatus"]);
const DOCUMENT_TEMPLATE_FIELDS: Record<string, string> = {
    model: "model",
    prompt: "prompt",
    input: "input",
    text: "text",
    messages: "messages",
    size: "size",
    width: "width",
    height: "height",
    quality: "quality",
    n: "n",
    count: "count",
    num_images: "num_images",
    batch_size: "batch_size",
    ratio: "ratio",
    aspect_ratio: "aspect_ratio",
    resolution: "resolution",
    duration: "duration",
    seconds: "seconds",
    image: "image",
    images: "images",
    image_url: "image",
    image_urls: "images",
    input_image: "image",
    input_images: "images",
    reference_image: "image",
    reference_images: "images",
    first_frame: "first_frame",
    first_frame_url: "first_frame_url",
    first_image: "first_frame",
    last_frame: "last_frame",
    last_frame_url: "last_frame_url",
    last_image: "last_frame",
    video: "video",
    videos: "videos",
    input_video: "video",
    input_videos: "videos",
    reference_video: "video",
    reference_videos: "videos",
    audio: "audio",
    audios: "audios",
    input_audio: "audio",
    input_audios: "audios",
    reference_audio: "audio",
    reference_audios: "audios",
    references: "references",
    content: "content",
    generate_audio: "generate_audio",
    voice: "voice",
    format: "format",
    response_format: "response_format",
    speed: "speed",
};

export function parseChannelExampleConfig(example: string, channel: SystemModelChannel, currentAdvanced: SystemChannelAdvancedConfig): ChannelExampleParseResult | null {
    const raw = example.trim();
    if (!raw) return null;

    const requestUrl = pickRequestUrl(raw);
    const matchedEndpoint = requestUrl ? matchEndpointUrl(requestUrl) : matchEndpointText(raw);
    const documentedBaseUrl = baseUrlForRequestPath(matchedEndpoint?.baseUrl || pickDocumentBaseUrl(raw), matchedEndpoint?.createPath || "");
    const endpoint = matchedEndpoint;
    const jsonBlocks = extractJsonBlocks(raw);
    const requestBody = /(?:^|\n)\s*(?:GET|DELETE)\s+(?:https?:\/\/|\/(?!\/))/i.test(raw) ? null : pickRequestBody(jsonBlocks);
    const kind = inferKind(endpoint, requestBody, raw);
    const model = findModel(requestBody, jsonBlocks, raw);
    const protocol = inferProtocol(raw, endpoint, requestBody, currentAdvanced.protocol);
    const documentFields = requestBody ? [] : documentRequestFields(raw);
    const requestTemplate = requestBody || endpoint ? buildRequestTemplate(requestBody, kind, protocol, documentFields) : "";
    const resultField = inferResultField(jsonBlocks, requestBody, kind, raw);
    const statusField = inferStatusField(jsonBlocks, requestBody, raw);
    const referenceFields = uniqueList([...(requestBody && isRecord(requestBody) ? collectReferenceFields(requestBody) : []), ...documentFields.filter((field) => isReferenceKey(field))]);
    const referenceRule = inferReferenceRule(raw, kind, protocol, referenceFields);
    const apiKey = extractBearerKey(raw);

    if (!endpoint && !requestBody && !model && !apiKey && !resultField && !statusField) return null;

    const advancedPatch: Partial<SystemChannelAdvancedConfig> = {
        protocol,
        ...(model && kind === "text" ? { textModel: model } : {}),
        ...(model && (kind === "image" || kind === "image-edit") ? { imageModel: model } : {}),
        ...(model && kind === "video" ? { videoModel: model } : {}),
        ...(requestTemplate ? { requestTemplate } : {}),
        ...(resultField ? { resultField } : {}),
        ...(statusField ? { statusField } : {}),
        ...(referenceRule ? { referenceRule } : {}),
        supportsReferenceImage: currentAdvanced.supportsReferenceImage || kind === "image-edit" || referenceFields.some((field) => IMAGE_REFERENCE_KEYS.has(field) || IMAGE_REFERENCE_KEYS.has(field.toLowerCase())),
        supportsReferenceVideo: currentAdvanced.supportsReferenceVideo || referenceFields.some((field) => VIDEO_REFERENCE_KEYS.has(field)),
        supportsReferenceAudio: currentAdvanced.supportsReferenceAudio || referenceFields.some((field) => AUDIO_REFERENCE_KEYS.has(field)),
    };

    if (kind === "video" && endpoint?.createPath) {
        advancedPatch.createPath = endpoint.createPath;
        if (referenceFields.some((field) => IMAGE_REFERENCE_KEYS.has(field))) advancedPatch.imageToVideoPath = endpoint.createPath;
        advancedPatch.queryPath = videoQueryPath(endpoint.createPath);
        advancedPatch.durationRange = inferDurationRange(requestBody, endpoint.createPath, raw);
    }
    if (kind === "image" && endpoint?.createPath) advancedPatch.createPath = endpoint.createPath;
    if (kind === "image-edit" && endpoint?.createPath) {
        advancedPatch.editPath = endpoint.createPath;
        if (endpoint.marker.toLowerCase().includes("model-center/tasks")) advancedPatch.createPath = endpoint.createPath;
    }
    if (kind === "text" && endpoint?.createPath) advancedPatch.createPath = endpoint.createPath;
    if (kind === "audio" && endpoint?.createPath) advancedPatch.createPath = endpoint.createPath;

    const nextAdvanced: SystemChannelAdvancedConfig = { ...currentAdvanced, ...advancedPatch };
    const patch: Partial<SystemModelChannel> = { advancedConfig: nextAdvanced };
    if (documentedBaseUrl) patch.baseUrl = documentedBaseUrl;
    if (apiKey) patch.apiKey = apiKey;
    if (model) patch.models = uniqueList([...channel.models, model]);

    const summary = [
        documentedBaseUrl ? `Base URL：${documentedBaseUrl}` : "",
        model ? `模型：${model}` : "",
        `协议：${protocolLabel(protocol)}`,
        kindLabel(kind),
        referenceFields.length ? `参考字段：${referenceFields.join("、")}` : "",
        resultField ? `结果字段：${resultField}` : "",
    ].filter(Boolean);

    return { patch, summary };
}

function pickRequestUrl(text: string) {
    const urls = extractUrls(text);
    const known = urls.find((url) => matchKnownEndpointUrl(url));
    if (known) return known;
    const explicit = text.match(/(?:--url\s+|\b(?:POST|PUT|PATCH)\s+)(?:["']?)(https?:\/\/[^\s"'\\<>]+)/i)?.[1];
    return explicit?.replace(/[),.;]+$/g, "") || "";
}

function extractUrls(text: string) {
    return Array.from(text.matchAll(/https?:\/\/[^\s"'\\<>]+/gi))
        .map((match) => match[0].replace(/[),.;]+$/g, ""))
        .filter(Boolean);
}

function matchEndpointUrl(value: string): EndpointMatch | null {
    try {
        const url = new URL(value);
        const pathname = url.pathname.replace(/%7B(?:task[_-]?id|id)%7D/gi, ":task_id").replace(/\/+$/g, "");
        const lowerPath = pathname.toLowerCase();
        for (const spec of ENDPOINT_SPECS) {
            const index = lowerPath.lastIndexOf(spec.marker.toLowerCase());
            if (index < 0) continue;
            const end = index + spec.marker.length;
            if (lowerPath.length !== end && lowerPath[end] !== "/") continue;
            const basePath = pathname.slice(0, index).replace(/\/+$/g, "");
            if (basePath && !looksLikeApiBasePath(basePath)) continue;
            url.pathname = basePath || "/";
            url.search = "";
            url.hash = "";
            const baseUrl = `${url.origin}${basePath}`;
            return { ...spec, createPath: spec.marker, requestUrl: value, baseUrl };
        }
        if (url.protocol === "http:" || url.protocol === "https:") {
            return {
                marker: url.pathname,
                kind: "unknown",
                createPath: `${url.pathname}${url.search}`,
                requestUrl: value,
                baseUrl: url.origin,
            };
        }
    } catch {
        return null;
    }
    return null;
}

function looksLikeApiBasePath(path: string) {
    return /(?:^|\/)(?:api|v\d+(?:\.\d+)?)(?:\/|$)/i.test(path);
}

function matchKnownEndpointUrl(value: string) {
    const endpoint = matchEndpointUrl(value);
    return endpoint && endpoint.kind !== "unknown" ? endpoint : null;
}

function matchEndpointText(text: string): EndpointMatch | null {
    const source = text.toLowerCase();
    const spec = ENDPOINT_SPECS.find((item) => source.includes(item.marker.toLowerCase()));
    if (spec) return { ...spec, createPath: spec.marker };
    const request = text.match(/(?:^|\n)\s*(?:GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s"'\\<>]+|\/(?!\/)[^\s"'\\<>]+)/i)?.[1];
    if (!request) return null;
    return /^https?:\/\//i.test(request) ? matchEndpointUrl(request) : { marker: request, kind: "unknown", createPath: request.replace(/\{(?:task[_-]?id|id)\}/gi, ":task_id") };
}

function pickDocumentBaseUrl(text: string) {
    const match = text.match(/(?:base\s*url|基础\s*url)\s*[:：]?\s*(https?:\/\/[^\s"'\\<>]+)/i);
    return match?.[1]?.replace(/\/+$/g, "") || "";
}

function baseUrlForRequestPath(baseUrl: string, path: string) {
    if (!path || !baseUrl) return baseUrl;
    try {
        const url = new URL(baseUrl);
        const basePath = url.pathname.replace(/\/+$/g, "");
        if (basePath && basePath !== "/" && (path === basePath || path.startsWith(`${basePath}/`))) return url.origin;
    } catch {
        return baseUrl;
    }
    return baseUrl;
}

function extractJsonBlocks(text: string) {
    const normalized = text.replace(/\\\r?\n/g, "\n");
    const blocks: unknown[] = [];
    for (let start = 0; start < normalized.length; start += 1) {
        const open = normalized[start];
        if (open !== "{" && open !== "[") continue;
        const stack = [open];
        let inString = false;
        let escaped = false;
        for (let index = start + 1; index < normalized.length; index += 1) {
            const char = normalized[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === "{" || char === "[") stack.push(char);
            if (char === "}" || char === "]") {
                const last = stack[stack.length - 1];
                if ((char === "}" && last !== "{") || (char === "]" && last !== "[")) break;
                stack.pop();
                if (!stack.length) {
                    const candidate = normalized.slice(start, index + 1).trim();
                    const parsed = parseJsonCandidate(candidate);
                    if (parsed !== undefined) {
                        blocks.push(parsed);
                        start = index;
                    }
                    break;
                }
            }
        }
    }
    return blocks;
}

function parseJsonCandidate(value: string) {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

function pickRequestBody(blocks: unknown[]) {
    return blocks.find((block) => isRecord(block) && looksLikeRequestBody(block)) || null;
}

function looksLikeRequestBody(value: Record<string, unknown>) {
    return Boolean(value.model || value.prompt || value.messages || value.input || value.content || value.duration || value.seconds || Object.keys(value).some((key) => isReferenceKey(key)));
}

function inferKind(endpoint: EndpointMatch | null, requestBody: unknown, raw: string): ExampleKind {
    if (endpoint?.kind && endpoint.kind !== "unknown") return endpoint.kind;
    const path = endpoint?.createPath || "";
    if (/audio|speech|voice|tts|music|sound/i.test(path)) return "audio";
    if (/chat|responses|completions|text/i.test(path)) return "text";
    if (/video|videos|i2v|t2v/i.test(path)) return "video";
    if (/image|images|txt2img|img2img/i.test(path)) return /edit|img2img/i.test(path) ? "image-edit" : "image";
    if (/"(?:video_url|videoUrl|media_url|mediaUrl|play_url|playUrl|stream_url|streamUrl)"\s*:|\.mp4\b|\.mov\b|\.webm\b/i.test(raw)) return "video";
    if (/"(?:audio_url|audioUrl|speech_url|speechUrl)"\s*:|\.(?:mp3|wav|m4a|flac)\b/i.test(raw)) return "audio";
    if (/"(?:b64_json|base64|image_url|imageUrl)"\s*:|\.png\b|\.jpe?g\b|\.webp\b/i.test(raw)) return "image";
    if (isRecord(requestBody)) {
        const referenceFields = collectReferenceFields(requestBody);
        const hasVideoReference = referenceFields.some((field) => VIDEO_REFERENCE_KEYS.has(field.toLowerCase()));
        const hasAudioReference = referenceFields.some((field) => AUDIO_REFERENCE_KEYS.has(field.toLowerCase()));
        const hasImageReference = referenceFields.some((field) => IMAGE_REFERENCE_KEYS.has(field.toLowerCase()));
        if (requestBody.messages) return "text";
        if (/seedream|image-gen|图片模型/i.test(raw)) return Object.keys(requestBody).some((key) => isReferenceKey(key)) ? "image-edit" : "image";
        if (/seedance|video-gen|视频模型/i.test(raw)) return "video";
        if (requestBody.duration || requestBody.seconds || hasVideoReference) return "video";
        if (hasAudioReference && !requestBody.prompt) return "audio";
        if (hasImageReference) return /edit|img2img|图生图|图片编辑/i.test(raw) ? "image-edit" : "image";
        if (requestBody.input) return "text";
        if (requestBody.prompt) return "image";
    }
    if (/video|videos|i2v|t2v|图生视频|文生视频/i.test(raw)) return "video";
    if (/audio|speech|voice|tts|音频模型|语音|声音克隆/i.test(raw)) return "audio";
    if (/images\/edits|图生图|图片编辑/i.test(raw)) return "image-edit";
    if (/images\/generations|文生图|生图/i.test(raw)) return "image";
    if (/(?:^|\n)\s*(?:video_url|videoUrl|media_url|mediaUrl|play_url|playUrl|stream_url|streamUrl)\s*(?:\n|$)/i.test(raw)) return "video";
    if (/(?:^|\n)\s*(?:image_url|imageUrl|b64_json|image_base64|imageBase64)\s*(?:\n|$)/i.test(raw)) return "image";
    if (/(?:^|\n)\s*(?:audio_url|audioUrl|speech_url|speechUrl)\s*(?:\n|$)/i.test(raw)) return "audio";
    return "unknown";
}

function findModel(requestBody: unknown, blocks: unknown[], raw: string) {
    const bodyModel = isRecord(requestBody) ? stringValue(requestBody.model) : "";
    if (bodyModel) return bodyModel;
    for (const block of blocks) {
        const model = findStringAtKey(block, "model");
        if (model) return model;
    }
    const match = raw.match(/["']model["']\s*:\s*["']([^"']+)["']/i);
    if (match?.[1]?.trim()) return match[1].trim();
    const lines = raw.split(/\r?\n/).map((line) => line.trim());
    const marker = lines.findIndex((line) => /^(?:模型\s*ID|model\s*(?:id|name))\b/i.test(line.replace(/[（）()]/g, " ")));
    if (marker < 0) return "";
    return lines.slice(marker + 1, marker + 9).find((line) => /^[a-z0-9][a-z0-9._:/-]*(?: [a-z0-9][a-z0-9._:/-]*)*$/i.test(line) && !/^(?:model|id|name|string|required|字段|值)$/i.test(line)) || "";
}

function inferProtocol(raw: string, endpoint: EndpointMatch | null, requestBody: unknown, current: SystemChannelProtocol): SystemChannelProtocol {
    const source = `${raw}\n${endpoint?.requestUrl || ""}`.toLowerCase();
    if (source.includes("/kyyreactapiserver/v2/model-center/tasks")) return "yumeng";
    if (source.includes("/v1/seedance-special/videos") || source.includes("sd_2.0_special_") || source.includes("sd_2.0_fast_special_")) return "custom";
    if (source.includes("/sdapi/v1/txt2img") || source.includes("/sdapi/v1/img2img") || source.includes("alwayson_scripts")) return "custom";
    if (source.includes("sub2api") || textContainsUrlHost(source, ["code2alita.com"])) return "sub2api";
    if (/\bnew\s*api\b|new-api|one-api/i.test(source)) return "newapi";
    if (textContainsUrlHost(source, ["globalaiopc.com"]) || source.includes("/videos/videos") || source.includes("referenceimages")) return "custom";
    if (textContainsUrlHost(source, ["ark.cn-beijing.volces.com"])) return "volcengine-video";
    if (source.includes("seedance") || source.includes("/contents/generations/tasks") || source.includes("/api/plan/v3")) return "seedance";
    if (isRecord(requestBody) && hasSub2ApiImageReferenceShape(requestBody)) return "sub2api";
    if (/multipart\/form-data|\s-F\s|--form\b/i.test(raw)) return "openai";
    if (endpoint?.kind === "video") return "compatible";
    if (endpoint?.kind === "image-edit" && isRecord(requestBody) && Object.keys(requestBody).some((key) => isReferenceKey(key))) return current === "auto" ? "compatible" : current;
    return current && current !== "auto" ? current : "openai";
}

function hasSub2ApiImageReferenceShape(value: Record<string, unknown>) {
    if (Array.isArray(value.image_urls)) return true;
    const images = value.images;
    return Array.isArray(images) && images.some((item) => isRecord(item) && typeof item.image_url === "string");
}

function buildRequestTemplate(requestBody: unknown, kind: ExampleKind, protocol: SystemChannelProtocol, documentFields: string[] = []) {
    if (isRecord(requestBody) || Array.isArray(requestBody)) return JSON.stringify(templateValue(requestBody));
    if (documentFields.length) {
        return JSON.stringify(Object.fromEntries(documentFields.flatMap((field) => (DOCUMENT_TEMPLATE_FIELDS[field.toLowerCase()] ? [[field, `{{${DOCUMENT_TEMPLATE_FIELDS[field.toLowerCase()]}}}`]] : []))));
    }
    if (kind === "text") return '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}';
    if (kind === "video") return '{"model":"{{model}}","prompt":"{{prompt}}"}';
    if (kind === "image-edit" && protocol === "sub2api") return '{"model":"{{model}}","prompt":"{{prompt}}","image_urls":["{{image}}"]}';
    if (kind === "image-edit") return '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{image}}"}';
    if (kind === "image") return '{"model":"{{model}}","prompt":"{{prompt}}"}';
    if (kind === "audio") return '{"model":"{{model}}","input":"{{input}}","voice":"{{voice}}","response_format":"{{response_format}}"}';
    return "";
}

function templateValue(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((item) => templateValue(item, key));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([nextKey, item]) => [nextKey, templateValue(item, nextKey)]));
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return value;
    const lowerKey = key.toLowerCase();
    if (lowerKey === "model") return "{{model}}";
    if (lowerKey === "prompt" || lowerKey === "text" || lowerKey === "content") return "{{prompt}}";
    if (lowerKey === "size") return "{{size}}";
    if (lowerKey === "quality") return "{{quality}}";
    if (lowerKey === "duration") return "{{duration}}";
    if (lowerKey === "seconds") return "{{seconds}}";
    if (lowerKey === "ratio" || lowerKey === "aspect_ratio") return "{{ratio}}";
    if (lowerKey === "resolution") return "{{resolution}}";
    if (lowerKey === "n" || lowerKey === "count" || lowerKey === "num_images" || lowerKey === "batch_size") return "{{n}}";
    if (lowerKey === "width") return "{{width}}";
    if (lowerKey === "height") return "{{height}}";
    if (isReferenceKey(key)) return "{{image}}";
    return value;
}

function inferResultField(blocks: unknown[], requestBody: unknown, kind: ExampleKind, raw = "") {
    const responseBlocks = blocks.filter((block) => block !== requestBody);
    const paths = uniqueList(responseBlocks.flatMap((block) => collectMatchingPaths(block, (key, value) => RESULT_URL_KEYS.has(key) && (typeof value === "string" || typeof value === "number"))));
    if (paths.length) return paths.slice(0, 3).join(" / ");
    if (kind === "text") {
        const textPaths = uniqueList(responseBlocks.flatMap((block) => collectMatchingPaths(block, (key, value) => ["content", "text", "output_text", "outputText"].includes(key) && typeof value === "string")));
        if (textPaths.length) return textPaths.slice(0, 3).join(" / ");
    }
    const documented = documentResponseFields(raw, RESULT_URL_KEYS);
    if (documented.length) return documented.slice(0, 3).join(" / ");
    return "";
}

function inferStatusField(blocks: unknown[], requestBody: unknown, raw = "") {
    const responseBlocks = blocks.filter((block) => block !== requestBody);
    const paths = uniqueList(responseBlocks.flatMap((block) => collectMatchingPaths(block, (key) => STATUS_KEYS.has(key))));
    if (paths.length) return paths.slice(0, 3).join(" / ");
    const documented = documentResponseFields(raw, STATUS_KEYS);
    if (documented.length) return documented.slice(0, 3).join(" / ");
    return "";
}

function documentRequestFields(raw: string) {
    const section = documentSection(raw, /^(?:请求参数|request\s+(?:body|parameters?)|body\s+parameters?)$/i, /^(?:返回约定|响应参数|响应字段|response|查询任务|query)/i);
    return uniqueList(
        section
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^[a-z_][a-z0-9_.-]*$/i.test(line) && Boolean(DOCUMENT_TEMPLATE_FIELDS[line.toLowerCase()])),
    );
}

function documentResponseFields(raw: string, fields: Set<string>) {
    const section = documentSection(raw, /^(?:返回约定|响应参数|响应字段|response(?:\s+(?:body|fields?|parameters?))?)$/i);
    const normalized = new Set(Array.from(fields, (field) => field.toLowerCase()));
    return uniqueList(
        section
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => normalized.has(line.toLowerCase())),
    );
}

function documentSection(raw: string, start: RegExp, end?: RegExp) {
    const lines = raw.split(/\r?\n/);
    const startIndex = lines.findIndex((line) => start.test(line.trim()));
    if (startIndex < 0) return "";
    const remainder = lines.slice(startIndex + 1);
    const endIndex = end ? remainder.findIndex((line) => end.test(line.trim())) : -1;
    return remainder.slice(0, endIndex < 0 ? undefined : endIndex).join("\n");
}

function collectMatchingPaths(value: unknown, matcher: (key: string, value: unknown) => boolean, path: Array<string | number> = [], depth = 0): string[] {
    if (!value || depth > 6) return [];
    if (Array.isArray(value)) return value.flatMap((item, index) => collectMatchingPaths(item, matcher, [...path, index], depth + 1));
    if (!isRecord(value)) return [];
    const paths: string[] = [];
    for (const [key, item] of Object.entries(value)) {
        if (matcher(key, item)) paths.push(formatPath([...path, key]));
        paths.push(...collectMatchingPaths(item, matcher, [...path, key], depth + 1));
    }
    return paths;
}

function collectReferenceFields(value: Record<string, unknown>) {
    const fields = new Set<string>();
    walkRecords(value, (key) => {
        if (isReferenceKey(key)) fields.add(key);
    });
    return Array.from(fields);
}

function inferReferenceRule(raw: string, kind: ExampleKind, protocol: SystemChannelProtocol, fields: string[]) {
    if (/multipart\/form-data|\s-F\s|--form\b/i.test(raw)) return "参考图使用 multipart/form-data 文件上传，由平台自动组装。";
    if (protocol === "sub2api") return "图生图使用 JSON 请求体；参考图字段为 image_urls 字符串数组。站内素材会先保存到服务器，再使用站点地址提供给上游读取。";
    if (!fields.length && kind !== "image-edit") return "";
    const fieldText = fields.length ? fields.join("、") : kind === "image-edit" ? "image/images/ref_assets" : "image/images/referenceImages";
    if (kind === "video" && (protocol === "globalaiopc" || fields.some((field) => /^reference/i.test(field)))) return `参考素材使用 JSON 字段 ${fieldText}；站内图片、视频和音频会通过服务器媒体地址提供给上游读取。`;
    if (kind === "video") return `图生视频参考图使用 JSON 字段 ${fieldText}；站内素材会先保存到服务器再提交。`;
    return `图生图参考图使用 JSON 字段 ${fieldText}；按上游示例提交 URL 或 data:image。`;
}

function videoQueryPath(createPath: string) {
    if (createPath === "/v1/seedance-special/videos") return "/v1/result/:task_id";
    if (createPath === "/videos/videos") return "/result/:task_id";
    if (createPath === "/contents/generations/tasks") return "/contents/generations/tasks/:task_id";
    if (createPath === "/videos") return "/videos/:task_id";
    return `${createPath.replace(/\/+$/g, "")}/:task_id`;
}

function inferDurationRange(requestBody: unknown, createPath: string, raw = "") {
    if (createPath === "/v1/seedance-special/videos") return "4-15 秒";
    if (createPath === "/videos/videos") return "4-15 秒";
    if (createPath === "/contents/generations/tasks") return "按模型限制，常用 5/10 秒";
    const documented = raw.match(/(?:^|\n)\s*(?:duration|seconds)\s*[\s\S]{0,240}?(?:取值范围|range)\s*[:：]?\s*(-?\d+(?:\.\d+)?)\s*[–—~-]\s*(-?\d+(?:\.\d+)?)/i);
    if (documented) return `${documented[1]}-${documented[2]} 秒`;
    const value = isRecord(requestBody) ? stringValue(requestBody.duration || requestBody.seconds) : "";
    return value ? `${value} 秒或按上游限制` : "";
}

function extractBearerKey(text: string) {
    const match = text.match(/authorization:\s*bearer\s+([^"'\s\\]+)/i) || text.match(/bearer\s+([^"'\s\\]+)/i);
    const key = match?.[1]?.trim() || "";
    if (!key || /^(?:sk-)?x+$/i.test(key) || /xxx|your|example|placeholder|\*\*\*|<|>/.test(key.toLowerCase())) return "";
    return key;
}

function findStringAtKey(value: unknown, targetKey: string, depth = 0): string {
    if (!value || depth > 5) return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findStringAtKey(item, targetKey, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (!isRecord(value)) return "";
    for (const [key, item] of Object.entries(value)) {
        if (key === targetKey && typeof item === "string" && item.trim()) return item.trim();
        const found = findStringAtKey(item, targetKey, depth + 1);
        if (found) return found;
    }
    return "";
}

function walkRecords(value: unknown, visit: (key: string, value: unknown) => void, depth = 0) {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) {
        value.forEach((item) => walkRecords(item, visit, depth + 1));
        return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
        visit(key, item);
        walkRecords(item, visit, depth + 1);
    }
}

function isReferenceKey(key: string) {
    const normalized = key.toLowerCase();
    return IMAGE_REFERENCE_KEYS.has(key) || IMAGE_REFERENCE_KEYS.has(normalized) || VIDEO_REFERENCE_KEYS.has(key) || VIDEO_REFERENCE_KEYS.has(normalized) || AUDIO_REFERENCE_KEYS.has(key) || AUDIO_REFERENCE_KEYS.has(normalized);
}

function formatPath(path: Array<string | number>) {
    return path.map((item, index) => (typeof item === "number" ? `[${item}]` : index === 0 ? item : /^[a-zA-Z_$][\w$]*$/.test(item) ? `.${item}` : `[${JSON.stringify(item)}]`)).join("");
}

function protocolLabel(protocol: SystemChannelProtocol) {
    if (protocol === "yumeng") return "昱梦";
    if (protocol === "sub2api") return "sub2api";
    if (protocol === "newapi") return "New API";
    if (protocol === "vozeb-recommended") return "星启智域推荐";
    if (protocol === "globalaiopc") return "GlobalAiOpc";
    if (protocol === "seedance") return "Seedance";
    if (protocol === "volcengine-video") return "火山方舟视频";
    if (protocol === "seedance-special") return "Seedance 2.0 特价版";
    if (protocol === "custom") return "自定义协议";
    if (protocol === "compatible") return "通用兼容";
    if (protocol === "openai") return "OpenAI";
    return "自动";
}

function kindLabel(kind: ExampleKind) {
    if (kind === "text") return "文本接口";
    if (kind === "image") return "文生图接口";
    if (kind === "image-edit") return "图生图接口";
    if (kind === "video") return "视频接口";
    if (kind === "audio") return "音频接口";
    return "自定义接口";
}

function stringValue(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function uniqueList(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
