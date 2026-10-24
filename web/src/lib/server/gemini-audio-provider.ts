import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg } from "@/lib/server/ffmpeg";

const GEMINI_VOICES = new Set(["Kore", "Charon", "Fenrir", "Aoede", "Puck", "Leda"]);

export function geminiAudioVoice(voice: string | undefined) {
    if (!voice || voice.toLowerCase() === "alloy") return "Kore";
    const selected = [...GEMINI_VOICES].find((item) => item.toLowerCase() === voice.toLowerCase());
    if (!selected) throw new Error(`Gemini TTS 不支持音色 ${voice}；请选择 Kore、Charon、Fenrir、Aoede、Puck 或 Leda`);
    return selected;
}

export function geminiAudioRequest(prompt: string, voice: string | undefined) {
    return {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiAudioVoice(voice) } } },
        },
    };
}

export async function geminiAudioResult(payload: unknown, format: string | undefined) {
    const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> })?.candidates;
    const audio = candidates?.flatMap((candidate) => candidate.content?.parts || []).find((part) => part.inlineData?.mimeType?.startsWith("audio/"))?.inlineData;
    if (!audio?.mimeType || !audio.data) throw new Error("Gemini 没有返回音频数据");
    const bytes = Buffer.from(audio.data, "base64");
    if (!bytes.length) throw new Error("Gemini 返回了空音频数据");
    if (bytes.length > 30 * 1024 * 1024) throw new Error("Gemini 音频结果超过 30MB 限制");
    if (!audio.mimeType.toLowerCase().startsWith("audio/l16")) return { bytes, mimeType: audio.mimeType.split(";")[0] };
    const rate = Number(audio.mimeType.match(/(?:^|;)\s*rate=(\d+)/i)?.[1]);
    const channels = Number(audio.mimeType.match(/(?:^|;)\s*channels=(\d+)/i)?.[1] || 1);
    if (!Number.isSafeInteger(rate) || rate <= 0 || !Number.isSafeInteger(channels) || channels <= 0) throw new Error("Gemini 音频采样参数无效");
    const outputFormat = format === "pcm" ? "wav" : format || "mp3";
    if (!["wav", "mp3", "opus", "aac", "flac"].includes(outputFormat)) throw new Error(`Gemini 音频输出格式不受支持：${outputFormat}`);
    const directory = await mkdtemp(join(tmpdir(), "vozeb-gemini-audio-"));
    const input = join(directory, "input.pcm");
    const output = join(directory, `output.${outputFormat}`);
    try {
        await writeFile(input, bytes);
        await runFfmpeg(["-y", "-f", "s16le", "-ar", String(rate), "-ac", String(channels), "-i", input, output]);
        return { bytes: await readFile(output), mimeType: outputFormat === "wav" ? "audio/wav" : outputFormat === "mp3" ? "audio/mpeg" : outputFormat === "opus" ? "audio/ogg" : `audio/${outputFormat}` };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
