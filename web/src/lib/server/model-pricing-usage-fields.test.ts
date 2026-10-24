import { describe, expect, it } from "vitest";
import { inspectUsageFields } from "./model-pricing-usage-fields";
import { inspectOpenAiImageUsage } from "./model-pricing-image-usage";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { inspectAudioUsage } from "./model-pricing-audio-usage";
import { inspectMinimaxVideoUsage } from "./model-pricing-video-usage";

describe("safe provider usage inventory", () => {
    it("keeps numeric usage and modality paths while discarding text and media", () => {
        const result = inspectUsageFields(
            {
                input_tokens: 3,
                cached_tokens: "0",
                hidden: "secret",
                details: [
                    { modality: "TEXT", tokenCount: 2, prompt: "private" },
                    { modality: "IMAGE", tokenCount: 1 },
                ],
            },
            ["input_tokens", "cached_tokens", "details[TEXT].tokenCount"],
        );
        expect(result).toEqual({ fields: { input_tokens: "3", cached_tokens: "0", "details[TEXT].tokenCount": "2", "details[IMAGE].tokenCount": "1" }, unmapped: ["details[IMAGE].tokenCount"] });
        expect(JSON.stringify(result)).not.toMatch(/secret|private/);
    });

    it("blocks an unexplained numeric meter in each priced modality", () => {
        expect(inspectOpenAiImageUsage({ usage: { extra_charge_units: 2 } }).invalid).toContain("未解释的图片用量字段：extra_charge_units");
        expect(inspectProviderTokenUsage("openai-chat", { usage: { extra_charge_units: 2 } }).invalid).toBe("未解释的文本用量字段：extra_charge_units");
        expect(inspectAudioUsage("openai-chat-audio", { usage: { extra_charge_units: 2 } }).invalid).toContain("未解释的音频用量字段：extra_charge_units");
        expect(inspectMinimaxVideoUsage({ task: { usage: { extra_charge_units: 2 } } }, "task", "sku").invalid).toContain("未解释的视频用量字段：extra_charge_units");
    });
});
