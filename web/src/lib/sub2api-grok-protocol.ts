import type { ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";

export const sub2apiGrokProtocol: ChannelProtocolDefinition = {
    id: "sub2api-grok",
    label: "Grok（经 sub2api）",
    description: "使用 sub2api 的 Grok 分组与用户 Key；覆盖当前创作入口的文本、图片、视频和 TTS。",
    apiFormat: "openai",
    authMode: "bearer",
    modelCatalogPaths: ["/v1/models"],
    capabilities: ["text", "image", "video", "audio"],
    operations: {
        text: { capability: "text", createPath: "/chat/completions", requestTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}', resultField: "choices[0].message.content" },
        image: {
            capability: "image",
            createPath: "/images/generations",
            editPath: "/images/edits",
            requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":{"url":"{{image}}","type":"image_url"}}',
            resultField: "data[0].url / data[0].b64_json",
            referenceRule: "图片编辑使用 JSON 的 image.url；多张参考图使用 images[].url，并由上游 Grok 模型决定能力。",
            supportsReferenceImage: true,
        },
        video: {
            capability: "video",
            createPath: "/videos/generations",
            imageToVideoPath: "/videos/generations",
            queryPath: "/videos/:task_id",
            requestTemplate:
                '{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}","image":{"url":"{{first_frame}}"},"last_frame":{"url":"{{last_frame}}"},"reference_images":"{{images}}","generate_audio":"{{generate_audio}}"}',
            resultField: "video.url",
            statusField: "status",
            referenceRule: "JSON 视频任务；首帧、尾帧和普通参考图分别映射为 image.url、last_frame.url、reference_images[].url。具体组合以 Grok 模型为准。",
            supportsReferenceImage: true,
        },
        audio: {
            capability: "audio",
            createPath: "/tts",
            requestTemplate: '{"text":"{{text}}","voice_id":"{{voice}}","language":"auto","codec":"{{format}}"}',
            resultField: "binary",
        },
    },
    strict: true,
};

export function buildSub2apiGrokVideoRequest(input: { model: string; prompt: string; duration?: number; aspectRatio?: string; resolution?: string; generateAudio: boolean; references: readonly { type: string; url: string; role?: string }[] }) {
    const first = input.references.find((item) => item.type === "image" && item.role === "first_frame");
    const last = input.references.find((item) => item.type === "image" && item.role === "last_frame");
    const ordinary = input.references.filter((item) => item.type === "image" && item.role !== "first_frame" && item.role !== "last_frame");
    return {
        model: input.model,
        prompt: input.prompt,
        ...(input.duration && input.duration > 0 ? { duration: input.duration } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        generate_audio: input.generateAudio,
        ...(first ? { image: { url: first.url } } : {}),
        ...(last ? { last_frame: { url: last.url } } : {}),
        ...(ordinary.length ? { reference_images: ordinary.map((item) => ({ url: item.url })) } : {}),
    };
}

export function buildSub2apiGrokTtsRequest(input: { text: string; voice: string; format: string; speed: number }) {
    const voice = input.voice === "alloy" ? "eve" : input.voice.trim();
    if (!voice) throw new Error("Grok TTS 需要选择音色");
    if (!["mp3", "wav", "pcm"].includes(input.format)) throw new Error("Grok TTS 仅支持当前页面提供的 MP3、WAV 或 PCM 格式");
    if (input.speed < 0.7 || input.speed > 1.5) throw new Error("Grok TTS 语速必须在 0.7 到 1.5 倍之间");
    return { text: input.text, voice_id: voice, language: "auto", codec: input.format, speed: input.speed };
}
