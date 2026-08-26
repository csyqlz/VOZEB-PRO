import type { VideoReferenceRole } from "@/lib/video-reference-contract";

export const GLOBAL_AIOPC_LLM_BASE_URL = "http://apillm.globalaiopc.com/gw_llm_power";
export const GLOBAL_AIOPC_MEDIA_BASE_URL = "https://zcbservice.aizfw.cn/kyyReactApiServer";

type GlobalAiOpcCapability = "text" | "image" | "video";
type GlobalAiOpcVideoRequestMode =
    "content" | "content-first-frame" | "input-reference" | "seedance2" | "grok" | "omni" | "sd2-manxue" | "starvideos" | "videos" | "vidu" | "happyhorse-t2v" | "happyhorse-i2v" | "happyhorse-r2v" | "happyhorse-edit" | "luxvid";

export type GlobalAiOpcPreset = {
    id: string;
    label: string;
    capability: GlobalAiOpcCapability;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    createPath: string;
    queryPath?: string;
    modelExamples: string[];
    requestMode?: GlobalAiOpcVideoRequestMode;
    durationRange?: string;
    supportsReferenceImage?: boolean;
    supportsReferenceVideo?: boolean;
    supportsReferenceAudio?: boolean;
    videoReferenceRoles?: VideoReferenceRole[];
};

const presets = [
    { id: "text-openai-chat", label: "文本 - OpenAI Chat", capability: "text", baseUrl: GLOBAL_AIOPC_LLM_BASE_URL, apiFormat: "openai", createPath: "/chat/completions", modelExamples: ["gpt-4.1"] },
    { id: "text-openai-responses", label: "文本 - OpenAI Responses", capability: "text", baseUrl: GLOBAL_AIOPC_LLM_BASE_URL, apiFormat: "openai", createPath: "/responses", modelExamples: ["gpt-4.1"] },
    { id: "text-gemini-native", label: "文本 - Gemini 原生", capability: "text", baseUrl: GLOBAL_AIOPC_LLM_BASE_URL, apiFormat: "gemini", createPath: "/models/:model:generateContent", modelExamples: ["gemini-3.1-pro-preview"] },
    { id: "text-claude-native", label: "文本 - Claude Messages 原生", capability: "text", baseUrl: GLOBAL_AIOPC_LLM_BASE_URL, apiFormat: "openai", createPath: "/messages", modelExamples: ["claude-opus-4-6"] },
    {
        id: "image-gpt-image-2",
        label: "图片 - GPT Image 2",
        capability: "image",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/image2/images",
        queryPath: "/result/:task_id",
        modelExamples: ["gpt-image-2"],
        supportsReferenceImage: true,
    },
    {
        id: "image-nano-banana",
        label: "图片 - Nano Banana",
        capability: "image",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/banana/images",
        queryPath: "/result/:task_id",
        modelExamples: ["nano-banana-2"],
        supportsReferenceImage: true,
    },
    {
        id: "video-sora",
        label: "视频 - Sora",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/sora/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["openAiSora2Plus"],
        requestMode: "input-reference",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        videoReferenceRoles: ["reference", "first_frame"],
    },
    {
        id: "video-veo",
        label: "视频 - VEO",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/veo/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["veo_3_1_fast"],
        requestMode: "input-reference",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        videoReferenceRoles: ["reference", "first_frame"],
    },
    {
        id: "video-seedance",
        label: "视频 - Seedance 1.5",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/seedance/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["seedance_1_5_pro_720p"],
        requestMode: "content",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        videoReferenceRoles: ["reference"],
    },
    {
        id: "video-seedance-2",
        label: "视频 - Seedance 2.0 满血版",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/kyyvideo2/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["seedance_2_0"],
        requestMode: "seedance2",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: true,
        videoReferenceRoles: ["reference"],
    },
    {
        id: "video-seedance-discount",
        label: "视频 - Seedance 2.0 官方折扣版",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/seedance-discount/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["sd_2.0_fast_discount_720p"],
        requestMode: "content",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: true,
        videoReferenceRoles: ["reference", "first_frame", "last_frame"],
    },
    {
        id: "video-seedance-special",
        label: "视频 - Seedance 2.0 特价版",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/seedance-special/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["sd_2.0_fast_special_720p"],
        requestMode: "content",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: true,
        videoReferenceRoles: ["reference", "first_frame", "last_frame"],
    },
    {
        id: "video-seedance-x1",
        label: "视频 - Seedance X1 首帧版",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/seedance-x1/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["seedance_2_0_x1_official"],
        requestMode: "content-first-frame",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        videoReferenceRoles: ["first_frame"],
    },
    {
        id: "video-sd2-manxue",
        label: "视频 - sd2_manxue",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/sd2_manxue/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["sd2_manxue_1080p"],
        requestMode: "sd2-manxue",
        durationRange: "按模型限制",
    },
    {
        id: "video-grok",
        label: "视频 - Grok",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/grok/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["grok_video3_max"],
        requestMode: "grok",
        durationRange: "按模型限制",
    },
    {
        id: "video-omni-flash",
        label: "视频 - Omni Flash",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/omni-flash/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["omni-flash"],
        requestMode: "omni",
        durationRange: "按模型限制",
    },
    {
        id: "video-happyhorse-t2v",
        label: "视频 - Happy Horse 文生视频",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/happyhorse-t2v/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["happyhorse-1.0-t2v"],
        requestMode: "happyhorse-t2v",
        durationRange: "按模型限制",
    },
    {
        id: "video-happyhorse-i2v",
        label: "视频 - Happy Horse 首帧生视频",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/happyhorse-i2v/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["happyhorse-1.0-i2v"],
        requestMode: "happyhorse-i2v",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        videoReferenceRoles: ["first_frame"],
    },
    {
        id: "video-happyhorse-r2v",
        label: "视频 - Happy Horse 参考生视频",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/happyhorse-r2v/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["happyhorse-1.0-r2v"],
        requestMode: "happyhorse-r2v",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
    },
    {
        id: "video-happyhorse-edit",
        label: "视频 - Happy Horse 视频编辑",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/happyhorse-edit/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["happyhorse-1.0-video-edit"],
        requestMode: "happyhorse-edit",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
    },
    {
        id: "video-starvideos",
        label: "视频 - StarVideos O3",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/starvideos/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["starvideos_o3"],
        requestMode: "starvideos",
        durationRange: "按模型限制",
    },
    {
        id: "video-videos",
        label: "视频 - Videos",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/videos/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["videos", "videos_stable", "videos_stable_fast", "videos_pro", "videos_pro_fast"],
        requestMode: "videos",
        durationRange: "4-15 秒",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: true,
    },
    {
        id: "video-luxvid",
        label: "视频 - LuxVid Video",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/luxvid-video/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["LuxVid_video_fast"],
        requestMode: "luxvid",
        durationRange: "按模型限制",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: true,
    },
    {
        id: "video-vidu",
        label: "视频 - Vidu",
        capability: "video",
        baseUrl: GLOBAL_AIOPC_MEDIA_BASE_URL,
        apiFormat: "openai",
        createPath: "/vidu/videos",
        queryPath: "/result/:task_id",
        modelExamples: ["viduq3-pro"],
        requestMode: "vidu",
        durationRange: "按模型限制",
    },
] as const satisfies readonly GlobalAiOpcPreset[];

export type GlobalAiOpcPresetId = (typeof presets)[number]["id"];

export const GLOBAL_AIOPC_PRESETS: readonly GlobalAiOpcPreset[] = presets;

type GlobalAiOpcConfig = {
    protocol?: unknown;
    globalAiOpcPreset?: unknown;
    globalAiOpcPresets?: unknown;
    createPath?: unknown;
};

export function getGlobalAiOpcPreset(value: unknown): GlobalAiOpcPreset | undefined {
    return presets.find((preset) => preset.id === value);
}

export function getGlobalAiOpcPresetForModel(model: unknown, candidates: readonly GlobalAiOpcPreset[] = presets): GlobalAiOpcPreset | undefined {
    const modelKey = normalizeGlobalAiOpcModel(model);
    return modelKey ? candidates.find((preset) => preset.modelExamples.some((example) => normalizeGlobalAiOpcModel(example) === modelKey)) : undefined;
}

export function resolveGlobalAiOpcPresets(config?: GlobalAiOpcConfig): GlobalAiOpcPreset[] {
    if (config?.protocol !== "globalaiopc") return [];
    const selected: GlobalAiOpcPreset[] = Array.isArray(config.globalAiOpcPresets) ? Array.from(new Set(config.globalAiOpcPresets.map(getGlobalAiOpcPreset).filter((preset): preset is GlobalAiOpcPreset => Boolean(preset)))) : [];
    if (selected.length) return selected;
    const legacy = getGlobalAiOpcPreset(config.globalAiOpcPreset);
    if (legacy) return [legacy];
    const createPath = normalizeGlobalAiOpcPath(config.createPath);
    const inferred = createPath ? presets.find((preset) => normalizeGlobalAiOpcPath(preset.createPath) === createPath) : undefined;
    return inferred ? [inferred] : [];
}

export function resolveGlobalAiOpcPreset(config?: GlobalAiOpcConfig, model?: unknown): GlobalAiOpcPreset | undefined {
    const selected = resolveGlobalAiOpcPresets(config);
    const modelKey = normalizeGlobalAiOpcModel(model);
    if (modelKey) {
        const matched = getGlobalAiOpcPresetForModel(modelKey, selected);
        if (matched) return matched;
    }
    return selected.length === 1 ? selected[0] : undefined;
}

export function resolveGlobalAiOpcCatalogPresets(baseUrl: unknown, config?: GlobalAiOpcConfig): GlobalAiOpcPreset[] {
    const serviceBase = normalizeGlobalAiOpcBaseUrl(baseUrl);
    if (!serviceBase) return [];
    const knownGlobalAiOpcBase = presets.some((preset) => normalizeGlobalAiOpcBaseUrl(preset.baseUrl) === serviceBase);
    if (!knownGlobalAiOpcBase) return [];
    const selected = resolveGlobalAiOpcPresets(config);
    const createPath = normalizeGlobalAiOpcPath(config?.createPath);
    if (selected.length && createPath) return selected;
    const selectedPreset = getGlobalAiOpcPreset(config?.globalAiOpcPreset);
    if (selectedPreset && createPath) return [selectedPreset];
    const matchedPath = createPath ? presets.find((preset) => normalizeGlobalAiOpcPath(preset.createPath) === createPath) : undefined;
    return matchedPath ? [matchedPath] : [...presets];
}

export function resolveGlobalAiOpcPathPreset(config: GlobalAiOpcConfig | undefined, path: readonly string[]): GlobalAiOpcPreset | undefined {
    const requestedPath = normalizeGlobalAiOpcPath(path.join("/"));
    if (!requestedPath) return undefined;
    return resolveGlobalAiOpcPresets(config).find((preset) => [preset.createPath, preset.queryPath].some((candidate) => candidate && pathPatternMatches(candidate, requestedPath)));
}

export function isGlobalAiOpcBaseUrl(value: unknown) {
    const baseUrl = normalizeGlobalAiOpcBaseUrl(value);
    return Boolean(baseUrl && presets.some((preset) => normalizeGlobalAiOpcBaseUrl(preset.baseUrl) === baseUrl));
}

export function buildGlobalAiOpcSelection(values: unknown) {
    const selected: GlobalAiOpcPreset[] = Array.isArray(values) ? Array.from(new Set(values.map(getGlobalAiOpcPreset).filter((preset): preset is GlobalAiOpcPreset => Boolean(preset)))) : [];
    const byCapability = (capability: GlobalAiOpcCapability) => selected.find((preset) => preset.capability === capability);
    const baseUrls = Array.from(new Set(selected.map((preset) => preset.baseUrl)));
    return {
        presetIds: selected.map((preset) => preset.id as GlobalAiOpcPresetId),
        models: Array.from(new Set(selected.flatMap((preset) => preset.modelExamples))),
        baseUrl: baseUrls.length === 1 ? baseUrls[0] : "",
        apiFormat: selected.every((preset) => preset.apiFormat === "gemini") ? ("gemini" as const) : ("openai" as const),
        textModel: byCapability("text")?.modelExamples[0] || "",
        imageModel: byCapability("image")?.modelExamples[0] || "",
        videoModel: byCapability("video")?.modelExamples[0] || "",
        createPath: selected.length === 1 ? selected[0].createPath : "",
        queryPath: selected.length === 1 ? selected[0].queryPath || "" : "",
        durationRange: selected.length === 1 ? selected[0].durationRange || "" : "按模型限制",
        supportsReferenceImage: selected.some((preset) => preset.supportsReferenceImage),
        supportsReferenceVideo: selected.some((preset) => preset.supportsReferenceVideo),
        supportsReferenceAudio: selected.some((preset) => preset.supportsReferenceAudio),
    };
}

export function isGlobalAiOpcPreset(value: unknown): value is GlobalAiOpcPresetId {
    return Boolean(getGlobalAiOpcPreset(value));
}

export function globalAiOpcPresetOptions() {
    return GLOBAL_AIOPC_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, capability: preset.capability }));
}

export type GlobalAiOpcImageRequest = {
    model: string;
    prompt: string;
    quality?: string;
    size?: string;
    ratio?: string;
    resolution?: string;
    imageUrls: string[];
};

export function buildGlobalAiOpcImageRequest(preset: GlobalAiOpcPreset, input: GlobalAiOpcImageRequest) {
    const shared = { model: input.model, prompt: input.prompt, image_urls: input.imageUrls };
    if (preset.id === "image-gpt-image-2") return { ...shared, ...(input.quality ? { quality: input.quality } : {}), ...(input.ratio ? { ratio: input.ratio } : {}), ...(input.resolution ? { resolution: input.resolution } : {}) };
    return { ...shared, ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.ratio || input.size ? { size: input.ratio || input.size } : {}) };
}

export type GlobalAiOpcVideoRequest = {
    model: string;
    prompt: string;
    duration: number;
    ratio?: string;
    resolution?: string;
    images: string[];
    videos: string[];
    audios: string[];
    generateAudio: boolean;
    firstFrame?: string;
    lastFrame?: string;
};

export function buildGlobalAiOpcVideoRequest(preset: GlobalAiOpcPreset, input: GlobalAiOpcVideoRequest): Record<string, unknown> {
    const base = { model: input.model, prompt: input.prompt };
    switch (preset.requestMode) {
        case "content":
            return { model: input.model, ratio: input.ratio, duration: input.duration, content: globalAiOpcContent(input), ...(preset.id === "video-seedance" ? { generate_audio: input.generateAudio } : {}) };
        case "content-first-frame":
            return { model: input.model, resolution: input.resolution, ratio: input.ratio, duration: input.duration, content: globalAiOpcFirstFrameContent(input) };
        case "input-reference":
            return {
                ...base,
                aspect_ratio: input.ratio,
                ...(preset.id === "video-sora" ? { seconds: input.duration } : { resolution: input.resolution }),
                ...(input.firstFrame || input.images[0] ? { input_reference: [input.firstFrame || input.images[0]] } : {}),
            };
        case "seedance2":
            return {
                ...base,
                duration: input.duration,
                aspect_ratio: input.ratio,
                generateAudio: input.generateAudio,
                ...(input.images.length ? { referenceImages: input.images } : {}),
                ...(input.videos.length ? { referenceVideos: input.videos } : {}),
                ...(input.audios.length ? { referenceAudios: input.audios } : {}),
            };
        case "grok":
        case "vidu":
            return { ...base, duration: input.duration, aspect_ratio: input.ratio, resolution: input.resolution };
        case "omni":
            return { ...base, seconds: String(input.duration), aspect_ratio: input.ratio, resolution: input.resolution };
        case "sd2-manxue":
        case "starvideos":
            return { ...base, duration: input.duration, ratio: input.ratio };
        case "videos":
            return {
                ...base,
                duration: input.duration,
                ratio: input.ratio,
                resolution: input.resolution,
                ...(input.images.length ? { referenceImages: input.images } : {}),
                ...(input.videos.length ? { referenceVideos: input.videos } : {}),
                ...(input.audios.length ? { referenceAudios: input.audios } : {}),
            };
        case "happyhorse-t2v":
            return { ...base, duration: input.duration, ratio: input.ratio, resolution: upperResolution(input.resolution), seed: 0 };
        case "happyhorse-i2v":
            return { ...base, first_image: input.firstFrame || input.images[0], duration: input.duration, resolution: upperResolution(input.resolution), seed: 0 };
        case "happyhorse-r2v":
            return { ...base, ...(input.images.length ? { referenceImages: input.images } : {}), duration: input.duration, ratio: input.ratio, resolution: upperResolution(input.resolution), seed: 0 };
        case "happyhorse-edit":
            return { ...base, ...(input.videos.length ? { referenceVideos: input.videos } : {}), ...(input.images.length ? { referenceImages: input.images } : {}), audioSetting: "auto", resolution: upperResolution(input.resolution), seed: 0 };
        case "luxvid":
            return {
                ...base,
                duration: input.duration,
                ratio: input.ratio,
                resolution: input.resolution,
                ...(input.images.length ? { referenceImages: input.images } : {}),
                ...(input.videos.length ? { referenceVideos: input.videos } : {}),
                ...(input.audios.length ? { referenceAudios: input.audios } : {}),
            };
        default:
            return { ...base, duration: input.duration, ratio: input.ratio, aspect_ratio: input.ratio, resolution: input.resolution };
    }
}

function globalAiOpcContent(input: GlobalAiOpcVideoRequest) {
    return [
        { type: "text", text: input.prompt },
        ...(input.firstFrame ? [{ type: "image_url", role: "first_frame", image_url: { url: input.firstFrame } }] : []),
        ...(input.lastFrame ? [{ type: "image_url", role: "last_frame", image_url: { url: input.lastFrame } }] : []),
        ...input.images.map((url) => ({ type: "image_url", role: "reference_image", image_url: { url } })),
        ...input.videos.map((url) => ({ type: "video_url", role: "reference_video", video_url: { url } })),
        ...input.audios.map((url) => ({ type: "audio_url", role: "reference_audio", audio_url: { url } })),
    ];
}

function globalAiOpcFirstFrameContent(input: GlobalAiOpcVideoRequest) {
    const firstFrame = input.firstFrame || input.images[0];
    return [{ type: "text", text: input.prompt }, ...(firstFrame ? [{ type: "image_url", role: "first_frame", image_url: { url: firstFrame } }] : [])];
}

function upperResolution(value?: string) {
    return value?.toUpperCase();
}

function normalizeGlobalAiOpcPath(value: unknown) {
    const path = typeof value === "string" ? value.trim() : "";
    if (!path) return "";
    return `/${path.replace(/^\/+|\/+$/g, "")}`.toLowerCase();
}

function normalizeGlobalAiOpcModel(value: unknown) {
    const model = typeof value === "string" ? value.trim() : "";
    if (!model) return "";
    const separator = model.indexOf("::");
    return (separator >= 0 ? model.slice(separator + 2) : model)
        .replace(/^models\//i, "")
        .trim()
        .toLowerCase();
}

function normalizeGlobalAiOpcBaseUrl(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
        const url = new URL(value.trim());
        const pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:v1|v1beta)$/i, "");
        return `${url.protocol}//${url.host}${pathname}`.toLowerCase();
    } catch {
        return "";
    }
}

function pathPatternMatches(pattern: string, requestedPath: string) {
    const normalizedPattern = normalizeGlobalAiOpcPath(pattern).replace(/:(?:task_id|taskid|id)\b/gi, ":id");
    const normalizedRequest = requestedPath.replace(/\/[^/]+$/, "/:id");
    return normalizedPattern === requestedPath || normalizedPattern === normalizedRequest;
}
