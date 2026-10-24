export const OPENAI_CHAT_AUDIO_PATH = "/chat/completions";

export function isOpenAiChatAudioModel(model: string) {
    return model.trim() === "gpt-audio-1.5" || /^gpt-4o-audio-preview(?:-\d{4}-\d{2}-\d{2})?$/i.test(model.trim());
}

export function buildOpenAiChatAudioRequest(input: { model: string; prompt: string; voice?: string; format?: string; speed?: string; instructions?: string }) {
    const format = (input.format || "mp3").toLowerCase();
    if (!["mp3", "wav", "flac", "opus"].includes(format)) throw new Error(`OpenAI Chat Audio 不支持 ${format} 输出格式，请选择 MP3、WAV、FLAC 或 Opus`);
    if (input.speed && Number(input.speed) !== 1) throw new Error("OpenAI Chat Audio 的 Chat Completions 接口不支持调节语速");
    return {
        model: input.model,
        modalities: ["text", "audio"],
        audio: { voice: input.voice || "alloy", format },
        messages: [...(input.instructions ? [{ role: "system", content: input.instructions }] : []), { role: "user", content: input.prompt }],
        stream: false,
    };
}
