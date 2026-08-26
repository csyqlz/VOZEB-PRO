import { describe, expect, it } from "vitest";

import { buildOpenAiVideoFormData } from "./video-task-openai";

describe("OpenAI video form data", () => {
    it("uses the documented Grok aspect ratio and resolution fields", async () => {
        const body = await buildOpenAiVideoFormData({
            model: "grok-video-3",
            prompt: "A paper plane flies through a clear sky",
            seconds: 6,
            width: 1280,
            height: 720,
            aspectRatio: "16:9",
            quality: "720p",
            imageUrls: [],
            origin: "",
            cookie: "",
        });

        expect(Object.fromEntries(body.entries())).toEqual({
            model: "grok-video-3",
            prompt: "A paper plane flies through a clear sky",
            seconds: "6",
            aspect_ratio: "16:9",
            size: "720P",
        });
    });

    it("retains width and height sizing for other OpenAI video channels", async () => {
        const body = await buildOpenAiVideoFormData({
            model: "video-one",
            prompt: "A paper plane flies through a clear sky",
            seconds: 6,
            width: 1280,
            height: 720,
            aspectRatio: "16:9",
            quality: "720p",
            imageUrls: [],
            origin: "",
            cookie: "",
        });

        expect(Object.fromEntries(body.entries())).toEqual({
            model: "video-one",
            prompt: "A paper plane flies through a clear sky",
            seconds: "6",
            size: "1280x720",
        });
    });
});
