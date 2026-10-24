import type { ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";

const operations: ChannelProtocolDefinition["operations"] = {
    text: {
        capability: "text",
        createPath: "/models/:model:generateContent",
        requestTemplate: '{"contents":[{"role":"user","parts":[{"text":"{{prompt}}"}]}]}',
        resultField: "candidates[0].content.parts[0].text",
        supportsReferenceImage: true,
    },
    image: {
        capability: "image",
        createPath: "/models/:model:generateContent",
        editPath: "/models/:model:generateContent",
        requestTemplate: '{"contents":[{"role":"user","parts":[{"text":"{{prompt}}"}]}],"generationConfig":{"responseModalities":["TEXT","IMAGE"]}}',
        resultField: "candidates[0].content.parts[0].inlineData.data",
        supportsReferenceImage: true,
    },
    audio: {
        capability: "audio",
        createPath: "/models/:model:generateContent",
        requestTemplate: '{"contents":[{"parts":[{"text":"{{input}}"}]}],"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"{{voice}}"}}}}}',
        resultField: "candidates[0].content.parts[0].inlineData.data",
    },
    video: {
        capability: "video",
        createPath: "/models/:model:predictLongRunning",
        imageToVideoPath: "/models/:model:predictLongRunning",
        queryPath: "/models/:model/operations/:task_id",
        requestTemplate:
            '{"instances":[{"prompt":"{{prompt}}","image":"{{image}}","lastFrame":"{{last_frame}}","referenceImages":"{{references}}"}],"parameters":{"durationSeconds":"{{duration}}","aspectRatio":"{{ratio}}","resolution":"{{resolution}}","generateAudio":"{{generate_audio}}"}}',
        resultField: "response.generateVideoResponse.generatedSamples[0].video.uri",
        statusField: "done",
        durationRange: "4、6、8 秒",
        referenceRule: "服务端将参考图片转为 inlineData；支持普通参考图、首帧和尾帧，不支持参考视频或参考音频。",
        supportsReferenceImage: true,
        supportsReferenceVideo: false,
        supportsReferenceAudio: false,
    },
};

export const geminiChannelProtocols: ChannelProtocolDefinition[] = [
    {
        id: "gemini",
        label: "Google Gemini / Veo",
        description: "Google Gemini API 原生文本、图片、语音与 Veo 异步视频协议。",
        apiFormat: "gemini",
        authMode: "custom-header",
        authHeader: "x-goog-api-key",
        defaultBaseUrl: "https://generativelanguage.googleapis.com",
        modelCatalogPaths: ["/v1beta/models"],
        capabilities: ["text", "image", "audio", "video"],
        operations,
        strict: true,
    },
    {
        id: "dataeyes-gemini",
        label: "DataEyes Gemini / Veo",
        description: "DataEyes 网关的 Gemini 原生文本、图片、语音与 Veo 视频协议，使用 Bearer 鉴权。",
        apiFormat: "gemini",
        authMode: "bearer",
        defaultBaseUrl: "https://platform.dataeyes.ai",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "audio", "video"],
        operations,
        strict: true,
    },
];
