import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const runFfmpeg = vi.hoisted(() =>
    vi.fn(async (args: string[]) => {
        await writeFile(args.at(-1)!, Buffer.from("RIFF-fixture"));
        return { stdout: "", stderr: "" };
    }),
);

vi.mock("@/lib/server/ffmpeg", () => ({ runFfmpeg }));

import { geminiAudioRequest, geminiAudioResult, geminiAudioVoice } from "./gemini-audio-provider";

describe("Gemini speech provider", () => {
    it("uses a documented voice and preserves explicit Gemini voice choices", () => {
        expect(geminiAudioRequest("你好", "Puck")).toMatchObject({
            contents: [{ parts: [{ text: "你好" }] }],
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } },
        });
        expect(geminiAudioVoice("alloy")).toBe("Kore");
        expect(() => geminiAudioVoice("Nova")).toThrow("Gemini TTS 不支持音色");
    });

    it("reads an audio part even when Gemini also returns text", async () => {
        const payload = { candidates: [{ content: { parts: [{ text: "完成" }, { inlineData: { mimeType: "audio/wav", data: Buffer.from("RIFF-fixture").toString("base64") } }] } }] };
        await expect(geminiAudioResult(payload, "wav")).resolves.toMatchObject({ bytes: Buffer.from("RIFF-fixture"), mimeType: "audio/wav" });
    });

    it("converts Gemini PCM using its declared sampling parameters", async () => {
        const payload = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/l16; rate=24000; channels=1", data: Buffer.from([1, 2, 3, 4]).toString("base64") } }] } }] };
        await expect(geminiAudioResult(payload, "mp3")).resolves.toMatchObject({ bytes: Buffer.from("RIFF-fixture"), mimeType: "audio/mpeg" });
        expect(runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(["-f", "s16le", "-ar", "24000", "-ac", "1"]));
        expect(runFfmpeg.mock.calls[0]?.[0].at(-1)).toMatch(/output\.mp3$/);
    });
});
