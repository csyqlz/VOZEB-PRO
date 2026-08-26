import type { SystemChannelModelConfig } from "@/lib/auth/store-types";

export const YUMENG_MODEL_CENTER_BASE_URL = "https://zcbservice.aizfw.cn/kyyReactApiServer";
export const YUMENG_MODEL_CENTER_CREATE_PATH = "/kyyReactApiServer/v2/model-center/tasks";
export const YUMENG_MODEL_CENTER_QUERY_PATH = "/kyyReactApiServer/v2/model-center/tasks/:task_id";

type YumengReference = { type: "image" | "video" | "audio"; url: string; role?: string };

type YumengVideoRequestInput = {
    model: string;
    prompt: string;
    duration: number;
    aspectRatio?: string;
    resolution?: string;
    generateAudio: boolean;
    watermark: boolean;
    images: string[];
    videos: string[];
    audios: string[];
    firstFrame?: string;
    lastFrame?: string;
};

type YumengImageRequestInput = {
    model: string;
    prompt: string;
    images: string[];
    aspectRatio?: string;
    resolution?: string;
    size?: string;
};

const imageBase = {
    capability: "image",
    source: "official",
    protocol: "yumeng",
    apiFormat: "openai",
    createPath: YUMENG_MODEL_CENTER_CREATE_PATH,
    editPath: YUMENG_MODEL_CENTER_CREATE_PATH,
    queryPath: YUMENG_MODEL_CENTER_QUERY_PATH,
    resultField: "result_url / image_url",
    statusField: "status",
    referenceRule: "参考图片使用上游可访问的 URL；当前模型中心不接受 image base64。",
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
} as const satisfies SystemChannelModelConfig;

const videoBase = {
    capability: "video",
    source: "official",
    protocol: "yumeng",
    apiFormat: "openai",
    createPath: YUMENG_MODEL_CENTER_CREATE_PATH,
    imageToVideoPath: YUMENG_MODEL_CENTER_CREATE_PATH,
    queryPath: YUMENG_MODEL_CENTER_QUERY_PATH,
    resultField: "result_url / video_url",
    statusField: "status",
} as const satisfies SystemChannelModelConfig;

function imageOperation(requestTemplate: string): SystemChannelModelConfig {
    return { ...imageBase, requestTemplate };
}

function videoOperation(requestTemplate: string, durationRange: string, references: Pick<SystemChannelModelConfig, "supportsReferenceImage" | "supportsReferenceVideo" | "supportsReferenceAudio" | "referenceRule">): SystemChannelModelConfig {
    return { ...videoBase, requestTemplate, durationRange, ...references };
}

const seedreamOperation = imageOperation('{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","size":"{{size}}","watermark":false}');
const seedreamProOperation = imageOperation('{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","watermark":false}');
const multimodalVideoReferences = {
    referenceRule: "首帧/首尾帧与多模态参考互斥；音频不能单独输入。模型中心接口使用上游可访问的公网 URL；素材库 ID 仅用于旧版 Seedance2 专用接口。",
    supportsReferenceImage: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
};
const frameImageReferences = {
    referenceRule: "可使用首帧或首尾帧图片；普通参考图片会作为首帧输入。",
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
};
const referenceImageOnly = {
    referenceRule: "必须提供至少一张参考图片。",
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
};
const textOnly = {
    referenceRule: "当前模型仅支持文本生成视频。",
    supportsReferenceImage: false,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
};

const seedance25Operation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","reference_videos":"{{videos}}","reference_audios":"{{audios}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","first_image":"{{first_frame}}","last_image":"{{last_frame}}"}',
    "4-30 秒",
    multimodalVideoReferences,
);
const seedance15Operation = videoOperation('{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","size":"{{aspect_ratio}}","first_image":"{{first_frame_or_image}}","last_image":"{{last_frame}}"}', "4-11 秒", frameImageReferences);
const seedance20Operation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","reference_videos":"{{videos}}","reference_audios":"{{audios}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","seed":"-1","first_image":"{{first_frame}}","last_image":"{{last_frame}}","generate_audio":"{{generate_audio_text}}","tools":[],"watermark":"{{watermark_text}}"}',
    "4-15 秒",
    multimodalVideoReferences,
);
const videos933Operation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{frame_or_reference_images}}","reference_videos":"{{videos}}","reference_audios":"{{audios}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","face_processing":"true","generate_audio":"{{generate_audio}}","reference_mode":"{{reference_mode}}"}',
    "4-15 秒",
    multimodalVideoReferences,
);
const klingOperation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","first_image":"{{first_frame}}","last_image":"{{last_frame}}","generate_audio":"{{generate_audio}}","reference_mode":"{{reference_mode}}"}',
    "3-15 秒",
    frameImageReferences,
);
const happyHorseImageOperation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","resolution":"{{resolution}}","seed":0,"first_image":"{{first_frame_or_image}}","watermark":"{{watermark}}"}',
    "3-15 秒",
    frameImageReferences,
);
const happyHorseReferenceOperation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","seed":0,"watermark":"{{watermark}}"}',
    "3-15 秒",
    referenceImageOnly,
);
const happyHorseTextOperation = videoOperation('{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","seed":0,"watermark":"{{watermark}}"}', "3-15 秒", textOnly);
const wanImageOperation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","resolution":"{{resolution}}","seed":0,"first_image":"{{first_frame_or_image}}","last_image":"{{last_frame}}","watermark":"{{watermark}}"}',
    "4-15 秒",
    frameImageReferences,
);
const wanReferenceOperation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","seed":0,"watermark":"{{watermark}}"}',
    "4-15 秒",
    referenceImageOnly,
);
const wanTextOperation = videoOperation('{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","seed":0,"watermark":"{{watermark}}"}', "4-15 秒", textOnly);
const wanEditOperation = videoOperation(
    '{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","reference_videos":"{{videos}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","seed":0,"audio_setting":"{{generate_audio}}","watermark":"{{watermark}}"}',
    "",
    {
        referenceRule: "必须提供参考视频，可同时提供参考图片。",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: false,
    },
);

export const YUMENG_DEFAULT_IMAGE_OPERATION = seedreamOperation;
export const YUMENG_DEFAULT_VIDEO_OPERATION = seedance20Operation;

// 仅注册当前官方文档导航中公开的模型，不猜测未公开目录或旧模型 ID。
export const YUMENG_MODEL_CENTER_MODELS = [
    { id: "seedream_5.0Pro", label: "seedream_5.0Pro", capability: "image", operation: seedreamProOperation },
    { id: "seedream-5.0", label: "seedream-5.0", capability: "image", operation: seedreamOperation },
    { id: "seedance-2.5-c1", label: "seedance-2.5-c1", capability: "video", operation: seedance25Operation },
    { id: "sd_2.0_fast_special", label: "sd_2.0_fast_special", capability: "video", operation: seedance20Operation },
    { id: "sd_2.0_special", label: "sd_2.0_special", capability: "video", operation: seedance20Operation },
    { id: "sd_2.0_discount", label: "sd_2.0_discount", capability: "video", operation: seedance20Operation },
    { id: "sd_2.0_fast_discount", label: "sd_2.0_fast_discount", capability: "video", operation: seedance20Operation },
    { id: "seedance_1_5_pro_1080p", label: "seedance_1_5_pro_1080p", capability: "video", operation: seedance15Operation },
    { id: "seedance_1_5_pro_480p", label: "seedance_1_5_pro_480p", capability: "video", operation: seedance15Operation },
    { id: "seedance_1_5_pro_720p", label: "seedance_1_5_pro_720p", capability: "video", operation: seedance15Operation },
    { id: "videos_933_c1", label: "videos_933_c1", capability: "video", operation: videos933Operation },
    { id: "videos_fast_933_c1", label: "videos_fast_933_c1", capability: "video", operation: videos933Operation },
    { id: "happyhorse-1.0-r2v", label: "HappyHorse 1.0 参考生视频", capability: "video", operation: happyHorseReferenceOperation },
    { id: "happyhorse-1.0-i2v", label: "HappyHorse 1.0 图生视频", capability: "video", operation: happyHorseImageOperation },
    { id: "happyhorse-1.0-t2v", label: "HappyHorse 1.0 文生视频", capability: "video", operation: happyHorseTextOperation },
    { id: "hh-1.1-r2v-o", label: "HappyHorse 1.1 v2 参考生视频", capability: "video", operation: happyHorseReferenceOperation },
    { id: "hh-1.1-i2v-o", label: "HappyHorse 1.1 v2 图生视频", capability: "video", operation: happyHorseImageOperation },
    { id: "hh-1.1-t2v-o", label: "HappyHorse 1.1 v2 文生视频", capability: "video", operation: happyHorseTextOperation },
    { id: "happyhorse-1.1-r2v", label: "HappyHorse 1.1 参考生视频", capability: "video", operation: happyHorseReferenceOperation },
    { id: "happyhorse-1.1-i2v", label: "HappyHorse 1.1 图生视频", capability: "video", operation: happyHorseImageOperation },
    { id: "happyhorse-1.1-t2v", label: "HappyHorse 1.1 文生视频", capability: "video", operation: happyHorseTextOperation },
    { id: "wan2.7-r2v", label: "Wan2.7 参考生视频", capability: "video", operation: wanReferenceOperation },
    { id: "wan2.7-i2v", label: "Wan2.7 图生视频", capability: "video", operation: wanImageOperation },
    { id: "wan2.7-t2v", label: "Wan2.7 文生视频", capability: "video", operation: wanTextOperation },
    { id: "wan2.7-videoedit", label: "Wan2.7 编辑视频", capability: "video", operation: wanEditOperation },
    { id: "KlingO3", label: "Kling O3 视频生成", capability: "video", operation: klingOperation },
] as const;

export function normalizeYumengModelCenterBaseUrl(value: string) {
    const configured = value.trim().replace(/\/+$/, "");
    if (!configured) return YUMENG_MODEL_CENTER_BASE_URL;
    try {
        return new URL(configured).hostname.toLowerCase() === "token.myairealm.com" ? YUMENG_MODEL_CENTER_BASE_URL : configured;
    } catch {
        return configured;
    }
}

export function resolveYumengImageResolution(model: string, quality: string | undefined) {
    const normalized = normalizeModel(model);
    const value = quality?.trim().toLowerCase();
    if (!value || value === "auto") return undefined;
    if (normalized === "seedream_5.0pro") return value === "high" || value === "2k" ? "2K" : "1K";
    if (value === "high" || value === "4k") return "4K";
    if (value === "medium" || value === "3k") return "3K";
    return "2K";
}

export function buildYumengImageRequest(input: YumengImageRequestInput) {
    const model = canonicalModel(input.model);
    if (normalizeModel(model) !== "seedream_5.0pro" && normalizeModel(model) !== "seedream-5.0") throw new Error(`昱梦图片模型未注册：${input.model}`);
    return compact({
        model,
        prompt: input.prompt,
        reference_images: input.images,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution,
        ...(normalizeModel(model) === "seedream-5.0" && /^\d+x\d+$/i.test(input.size || "") ? { size: input.size } : {}),
        watermark: false,
    });
}

export function assertYumengVideoReferences(model: string, references: YumengReference[]) {
    const id = normalizeModel(model);
    const images = references.filter((item) => item.type === "image" && !item.role);
    const videos = references.filter((item) => item.type === "video");
    const audios = references.filter((item) => item.type === "audio");
    const first = references.find((item) => item.type === "image" && item.role === "first_frame");
    const last = references.find((item) => item.type === "image" && item.role === "last_frame");
    if (last && !first) throw new Error("尾帧输入必须同时提供首帧");
    if ((first || last) && (images.length || videos.length || audios.length)) throw new Error("首帧/首尾帧与多模态参考不能同时使用");
    if (audios.length && !images.length && !videos.length) throw new Error("参考音频不能单独使用，请同时提供参考图片或视频");
    if (isImageToVideo(id) && !first && !images.length) throw new Error("当前图生视频模型需要一张首帧图片");
    if (isHappyHorse(id) && id.includes("-i2v") && last) throw new Error("当前图生视频模型不支持尾帧输入");
    if (id === "wan2.7-i2v" && (!last || (!first && !images.length))) throw new Error("Wan2.7 图生视频需要首帧和尾帧图片");
    if (isReferenceToVideo(id) && !images.length) throw new Error("当前参考生视频模型需要至少一张参考图片");
    if (id === "wan2.7-videoedit" && !videos.length) throw new Error("Wan2.7 视频编辑需要参考视频");
}

export function buildYumengVideoRequest(input: YumengVideoRequestInput) {
    const model = canonicalModel(input.model);
    const id = normalizeModel(model);
    const firstFrame = input.firstFrame || (isImageToVideo(id) || id.startsWith("seedance_1_5_pro_") ? input.images[0] : "");
    const frameMode = Boolean(input.firstFrame || input.lastFrame);
    const resolution = normalizeVideoResolution(id, input.resolution);
    if (id.startsWith("sd_2.0_")) {
        return {
            ...compact({
                model,
                prompt: input.prompt,
                reference_images: input.images,
                reference_videos: input.videos,
                reference_audios: input.audios,
                duration: input.duration,
                aspect_ratio: input.aspectRatio,
                resolution,
                seed: "-1",
                first_image: input.firstFrame,
                last_image: input.lastFrame,
                generate_audio: String(input.generateAudio),
                watermark: String(input.watermark),
            }),
            tools: [],
        };
    }
    if (id === "seedance-2.5-c1") {
        return compact({
            model,
            prompt: input.prompt,
            reference_images: input.images,
            reference_videos: input.videos,
            reference_audios: input.audios,
            duration: input.duration,
            aspect_ratio: input.aspectRatio,
            resolution,
            first_image: input.firstFrame,
            last_image: input.lastFrame,
        });
    }
    if (id.startsWith("seedance_1_5_pro_")) {
        return compact({ model, prompt: input.prompt, duration: input.duration, size: input.aspectRatio, first_image: firstFrame, last_image: input.lastFrame });
    }
    if (id === "videos_933_c1" || id === "videos_fast_933_c1") {
        return compact({
            model,
            prompt: input.prompt,
            reference_images: frameMode ? [input.firstFrame, input.lastFrame].filter(Boolean) : input.images,
            reference_videos: frameMode ? [] : input.videos,
            reference_audios: frameMode ? [] : input.audios,
            duration: input.duration,
            aspect_ratio: input.aspectRatio,
            resolution,
            face_processing: "true",
            generate_audio: input.generateAudio,
            reference_mode: frameMode ? "frame" : "image",
        });
    }
    if (id === "klingo3") {
        return compact({
            model,
            prompt: input.prompt,
            reference_images: input.images,
            duration: input.duration,
            aspect_ratio: input.aspectRatio,
            resolution,
            first_image: input.firstFrame,
            last_image: input.lastFrame,
            generate_audio: input.generateAudio,
            reference_mode: frameMode ? "frame" : "image",
        });
    }
    if (isHappyHorse(id)) {
        const common = { model, prompt: input.prompt, duration: input.duration, resolution, seed: 0, watermark: input.watermark };
        if (id.includes("-i2v")) return compact({ ...common, first_image: firstFrame });
        if (id.includes("-r2v")) return compact({ ...common, reference_images: input.images, aspect_ratio: input.aspectRatio });
        return compact({ ...common, aspect_ratio: input.aspectRatio });
    }
    if (id === "wan2.7-i2v") return compact({ model, prompt: input.prompt, duration: input.duration, resolution, seed: 0, first_image: firstFrame, last_image: input.lastFrame, watermark: input.watermark });
    if (id === "wan2.7-r2v") return compact({ model, prompt: input.prompt, reference_images: input.images, duration: input.duration, aspect_ratio: input.aspectRatio, resolution, seed: 0, watermark: input.watermark });
    if (id === "wan2.7-t2v") return compact({ model, prompt: input.prompt, duration: input.duration, aspect_ratio: input.aspectRatio, resolution, seed: 0, watermark: input.watermark });
    if (id === "wan2.7-videoedit")
        return compact({ model, prompt: input.prompt, reference_images: input.images, reference_videos: input.videos, aspect_ratio: input.aspectRatio, resolution, seed: 0, audio_setting: input.generateAudio, watermark: input.watermark });
    throw new Error(`昱梦视频模型未注册：${input.model}`);
}

function canonicalModel(model: string) {
    return YUMENG_MODEL_CENTER_MODELS.find((item) => normalizeModel(item.id) === normalizeModel(model))?.id || model.trim();
}

function normalizeModel(model: string) {
    return model.trim().toLowerCase();
}

function isHappyHorse(model: string) {
    return model.startsWith("happyhorse-") || model.startsWith("hh-");
}

function isImageToVideo(model: string) {
    return (isHappyHorse(model) && model.includes("-i2v")) || model === "wan2.7-i2v";
}

function isReferenceToVideo(model: string) {
    return (isHappyHorse(model) && model.includes("-r2v")) || model === "wan2.7-r2v";
}

function normalizeVideoResolution(model: string, value?: string) {
    const lower = value?.trim().toLowerCase();
    if (!lower || lower === "auto") return undefined;
    if (model === "sd_2.0_fast_special") return "720p";
    if (model === "sd_2.0_fast_discount" || model === "seedance-2.5-c1" || model === "videos_fast_933_c1") return lower === "480p" ? "480p" : "720p";
    if (isHappyHorse(model) || model.startsWith("wan2.7-")) return lower === "720p" ? "720P" : "1080P";
    return lower;
}

function compact(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "" && (!Array.isArray(item) || item.length > 0)));
}
