import type { ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";

export function isHailuo23Model(model: string) {
    return /^minimax-hailuo-2\.3(?:-fast)?$/i.test(model.trim());
}

export const hailuo23VideoOperation: ChannelProtocolDefinition["operations"]["video"] = {
    capability: "video",
    createPath: "/v1/video_generation",
    imageToVideoPath: "/v1/video_generation",
    queryPath: "/v1/query/video_generation?task_id=:task_id",
    requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","first_frame_image":"{{first_frame}}","duration":"{{duration}}","resolution":"{{resolution}}"}',
    resultField: "download_url",
    statusField: "status",
    supportsReferenceImage: true,
    durationRange: "768P：6 或 10 秒；1080P：6 秒",
    referenceRule: "Hailuo 2.3 使用单张首帧 first_frame_image；Fast 必须提供首帧，不支持纯文生视频或尾帧。",
};

/** Official direct API presets. Some catalogs are provisional and may require manual model IDs. */
export const officialProviderProtocols: ChannelProtocolDefinition[] = [
    {
        id: "zai-glm",
        label: "GLM（智谱 / Z.AI）",
        description: "Z.AI 官方文本接口。可尝试同步模型目录，失败时手动填写模型 ID。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://api.z.ai",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text"],
        operations: { text: { capability: "text", createPath: "/api/paas/v4/chat/completions", requestTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}', resultField: "choices[0].message.content" } },
        strict: true,
    },
    {
        id: "alibaba-bailian",
        label: "阿里云百炼（Qwen 图片 / Wan / HappyHorse）",
        description: "Qwen Image 3.0 同步图片、Wan 与 HappyHorse 异步视频；Base URL 需与模型和 API Key 的地域一致。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://dashscope-intl.aliyuncs.com",
        modelCatalogPaths: [],
        capabilities: ["image", "video"],
        operations: {
            image: {
                capability: "image",
                createPath: "/compatible-mode/v1/images/generations",
                editPath: "/compatible-mode/v1/images/generations",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{image}}"}',
                resultField: "data[0].url",
                supportsReferenceImage: true,
                referenceRule: "Qwen Image 3.0 图片编辑使用同一 JSON 接口的 image 字段；旧版型号需单独配置接口。",
            },
            video: {
                capability: "video",
                createPath: "/api/v1/services/aigc/video-generation/video-synthesis",
                imageToVideoPath: "/api/v1/services/aigc/video-generation/video-synthesis",
                queryPath: "/api/v1/tasks/:task_id",
                requestTemplate: '{"model":"{{model}}","input":{"prompt":"{{prompt}}","media":"{{references}}"},"parameters":{"duration":"{{duration}}","ratio":"{{ratio}}","resolution":"{{resolution}}"}}',
                resultField: "output.video_url",
                statusField: "output.task_status",
                supportsReferenceImage: true,
                referenceRule: "Wan 2.1–2.6 首帧使用 input.img_url；Wan 3.0/HappyHorse 使用 input.media。",
            },
        },
        strict: true,
    },
    {
        id: "bfl",
        label: "Black Forest Labs（FLUX）",
        description: "BFL 官方图片接口；以返回的 polling_url 查询任务。",
        apiFormat: "openai",
        authMode: "custom-header",
        authHeader: "x-key",
        defaultBaseUrl: "https://api.bfl.ai",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["image"],
        operations: {
            image: {
                capability: "image",
                createPath: "/v1/:model",
                editPath: "/v1/:model",
                queryPath: "/v1/get_result?id=:task_id",
                requestTemplate: '{"prompt":"{{prompt}}","input_image":"{{image}}"}',
                resultField: "result.sample",
                supportsReferenceImage: true,
                referenceRule: "支持参考图的 FLUX 型号可传 input_image；按返回的轮询地址查询。",
            },
        },
        strict: true,
    },
    {
        id: "kling",
        label: "Kling（可灵）",
        description: "可灵官方文生视频和图生视频异步接口。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://api-singapore.klingai.com",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["video"],
        operations: {
            video: {
                capability: "video",
                createPath: "/v1/videos/text2video",
                imageToVideoPath: "/v1/videos/image2video",
                requestTemplate: '{"model_name":"{{model}}","prompt":"{{prompt}}","image":"{{first_frame}}","image_tail":"{{last_frame}}","duration":"{{duration}}","aspect_ratio":"{{ratio}}"}',
                resultField: "data.task_result.videos[0].url",
                statusField: "data.task_status",
                supportsReferenceImage: true,
                referenceRule: "首帧写入 image，尾帧写入 image_tail；查询沿创建路径加任务 ID。",
            },
        },
        strict: true,
    },
    {
        id: "vidu",
        label: "Vidu",
        description: "Vidu 官方文生视频和图生视频接口，使用 Token 鉴权。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://api.vidu.com",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["video"],
        operations: {
            video: {
                capability: "video",
                createPath: "/ent/v2/text2video",
                imageToVideoPath: "/ent/v2/img2video",
                queryPath: "/ent/v2/tasks/:task_id/creations",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{images}}","duration":"{{duration}}","aspect_ratio":"{{ratio}}","resolution":"{{resolution}}"}',
                resultField: "creations[0].url",
                statusField: "state",
                supportsReferenceImage: true,
                referenceRule: "图生视频使用 images URL 数组。",
            },
        },
        strict: true,
    },
    {
        id: "minimax",
        label: "MiniMax",
        description: "MiniMax 官方文本、图片、视频和语音接口。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://api.minimax.io",
        modelCatalogPaths: [],
        capabilities: ["text", "image", "video", "audio"],
        operations: {
            text: { capability: "text", createPath: "/v1/chat/completions", requestTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}', resultField: "choices[0].message.content" },
            image: { capability: "image", createPath: "/v1/image_generation", requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","response_format":"url"}', resultField: "data.image_urls[0]" },
            video: {
                capability: "video",
                createPath: "/v2/video_generation",
                queryPath: "/v2/query/video_generation/:task_id",
                requestTemplate: '{"model":"{{model}}","content":[{"type":"text","text":"{{prompt}}"}],"duration":"{{duration}}","ratio":"{{ratio}}","resolution":"{{resolution}}"}',
                resultField: "task.content.url",
                statusField: "task.status",
            },
            audio: {
                capability: "audio",
                createPath: "/v1/t2a_v2",
                requestTemplate: '{"model":"{{model}}","text":"{{text}}","stream":false,"output_format":"hex","voice_setting":{"voice_id":"{{voice}}","speed":"{{speed}}"},"audio_setting":{"format":"{{format}}"}}',
                resultField: "data.audio",
            },
        },
        strict: true,
    },
    {
        id: "anthropic",
        label: "Anthropic（Claude）",
        description: "Claude 官方 Messages API；使用 x-api-key 和 anthropic-version。",
        apiFormat: "openai",
        authMode: "x-api-key",
        defaultBaseUrl: "https://api.anthropic.com",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text"],
        operations: { text: { capability: "text", createPath: "/v1/messages", requestTemplate: '{"model":"{{model}}","max_tokens":4096,"messages":[{"role":"user","content":"{{prompt}}"}]}', resultField: "content[0].text" } },
        strict: true,
    },
    {
        id: "xai",
        label: "xAI（Grok 官方）",
        description: "xAI 官方 Grok 文本、图片、视频和 TTS 接口。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://api.x.ai",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "video", "audio"],
        operations: {
            text: { capability: "text", createPath: "/v1/chat/completions", requestTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}', resultField: "choices[0].message.content" },
            image: {
                capability: "image",
                createPath: "/v1/images/generations",
                editPath: "/v1/images/edits",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":{"url":"{{image}}","type":"image_url"}}',
                resultField: "data[0].url",
                supportsReferenceImage: true,
                referenceRule: "编辑图片使用 JSON image.url。",
            },
            video: {
                capability: "video",
                createPath: "/v1/videos/generations",
                imageToVideoPath: "/v1/videos/generations",
                queryPath: "/v1/videos/:task_id",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","aspect_ratio":"{{ratio}}","resolution":"{{resolution}}","image":{"url":"{{first_frame}}"},"last_frame":{"url":"{{last_frame}}"}}',
                resultField: "video.url",
                statusField: "status",
                supportsReferenceImage: true,
                referenceRule: "首帧、尾帧使用 image.url、last_frame.url。",
            },
            audio: { capability: "audio", createPath: "/v1/tts", requestTemplate: '{"text":"{{text}}","voice_id":"{{voice}}","language":"auto","codec":"{{format}}"}', resultField: "binary" },
        },
        strict: true,
    },
];

type VideoReference = { type: string; url: string; role?: string };

export function isOfficialDirectVideoProtocol(value: unknown): value is "alibaba-bailian" | "kling" | "vidu" | "minimax" | "xai" {
    return value === "alibaba-bailian" || value === "kling" || value === "vidu" || value === "minimax" || value === "xai";
}

export function buildOfficialVideoRequest(
    protocol: "alibaba-bailian" | "kling" | "vidu" | "minimax",
    input: {
        model: string;
        prompt: string;
        duration?: number;
        ratio?: string;
        resolution?: string;
        references: readonly VideoReference[];
    },
) {
    const first = input.references.find((item) => item.type === "image" && item.role === "first_frame");
    const last = input.references.find((item) => item.type === "image" && item.role === "last_frame");
    const ordinary = input.references.filter((item) => item.type === "image" && item.role !== "first_frame" && item.role !== "last_frame");
    const image = first || ordinary[0];
    if (protocol === "alibaba-bailian") {
        const horse = /^happyhorse/i.test(input.model);
        const legacyWan = /^wan(?:x)?2\.[1-6](?:[-_.]|$)/i.test(input.model);
        if (legacyWan && input.references.length) {
            if (!image || last || ordinary.length > 1 || input.references.some((item) => item.type !== "image")) throw new Error("Wan 2.1–2.6 图生视频仅支持一张首帧图片");
            return {
                model: input.model,
                input: { prompt: input.prompt, img_url: image.url },
                parameters: { ...(input.duration && input.duration > 0 ? { duration: input.duration } : {}), ...(input.resolution ? { resolution: input.resolution.toUpperCase() } : {}) },
            };
        }
        const media = input.references.map((item) => ({
            type: item.role === "first_frame" || item.role === "last_frame" ? item.role : item.type === "image" ? (horse && /-i2v/i.test(input.model) ? "first_frame" : "reference_image") : item.type === "video" ? "reference_video" : "reference_audio",
            url: item.url,
        }));
        return {
            model: input.model,
            input: { prompt: input.prompt, ...(media.length ? { media } : {}) },
            parameters: { ...(input.duration && input.duration > 0 ? { duration: input.duration } : {}), ...(input.resolution ? { resolution: input.resolution.toUpperCase() } : {}), ...(!media.length && input.ratio ? { ratio: input.ratio } : {}) },
        };
    }
    if (protocol === "kling") {
        if (input.references.some((item) => item.type !== "image") || ordinary.length > 1) throw new Error("可灵视频预设只支持首帧与可选尾帧图片");
        return {
            model_name: input.model,
            prompt: input.prompt,
            ...(image ? { image: image.url } : {}),
            ...(last ? { image_tail: last.url } : {}),
            ...(input.duration && input.duration > 0 ? { duration: String(input.duration) } : {}),
            ...(!image && input.ratio ? { aspect_ratio: input.ratio } : {}),
        };
    }
    if (protocol === "vidu") {
        if (input.references.some((item) => item.type !== "image") || ordinary.length + Number(Boolean(first)) > 1 || last) throw new Error("Vidu 图生视频预设只支持一张首帧图片");
        return {
            model: input.model,
            prompt: input.prompt,
            ...(image ? { images: [image.url] } : {}),
            ...(input.duration && input.duration > 0 ? { duration: input.duration } : {}),
            ...(input.resolution ? { resolution: input.resolution.toLowerCase() } : {}),
            ...(!image && input.ratio ? { aspect_ratio: input.ratio } : {}),
        };
    }
    if (isHailuo23Model(input.model)) {
        if (input.references.some((item) => item.type !== "image") || input.references.length > 1 || last) throw new Error("Hailuo 2.3 只支持单张首帧图片，不支持尾帧、视频或音频参考");
        if (/-fast$/i.test(input.model) && !image) throw new Error("Hailuo 2.3 Fast 仅支持图生视频，请提供首帧图片");
        const resolution = input.resolution?.toUpperCase();
        const duration = input.duration && input.duration > 0 ? input.duration : undefined;
        if (resolution && !["768P", "1080P"].includes(resolution)) throw new Error("Hailuo 2.3 仅支持 768P 或 1080P");
        if (duration !== undefined && (![6, 10].includes(duration) || (resolution === "1080P" && duration !== 6))) throw new Error("Hailuo 2.3 的 768P 支持 6 或 10 秒，1080P 仅支持 6 秒");
        return { model: input.model, prompt: input.prompt, ...(image ? { first_frame_image: image.url } : {}), ...(duration !== undefined ? { duration } : {}), ...(resolution ? { resolution } : {}) };
    }
    const max = /h3-max/i.test(input.model);
    const requested = input.resolution?.toUpperCase();
    const resolution = !requested || requested === "720P" ? "768P" : requested;
    if (!(max ? ["480P", "768P"] : ["768P", "2K"]).includes(resolution)) throw new Error(`${input.model} 不支持 ${requested} 清晰度`);
    if (input.duration && (input.duration < (max ? 5 : 4) || input.duration > 15)) throw new Error(`${input.model} 不支持 ${input.duration} 秒时长`);
    const frames = Boolean(first || last);
    const content = [
        { type: "text", text: input.prompt },
        ...input.references.map((item) => ({
            type: item.type === "image" ? "image_url" : item.type === "video" ? "video_url" : "audio_url",
            ...(item.type === "image" ? { image_url: { url: item.url } } : item.type === "video" ? { video_url: { url: item.url } } : { audio_url: { url: item.url } }),
            role: item.role === "first_frame" || item.role === "last_frame" ? item.role : item.type === "image" ? "reference_image" : item.type === "video" ? "reference_video" : "reference_audio",
        })),
    ];
    if (frames && ordinary.length) throw new Error("MiniMax 首尾帧不能与普通参考图混用");
    if (!input.references.length && !input.ratio) throw new Error("MiniMax 文生视频需要明确选择画面比例");
    return { model: input.model, content, resolution, duration: input.duration || 5, ratio: frames ? "adaptive" : input.ratio || "adaptive" };
}
