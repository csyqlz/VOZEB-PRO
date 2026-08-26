import { describe, expect, it } from "vitest";

import { normalizeVideoResolutionValue, videoResolutionLabel, videoSecondOptionsFromConfig } from "./video-settings-panel";

describe("video settings duration options", () => {
    it("keeps intelligent resolution visible instead of presenting it as 720p", () => {
        expect(normalizeVideoResolutionValue("auto")).toBe("auto");
        expect(videoResolutionLabel("auto")).toBe("智能");
    });

    it("keeps all administrator-configured durations for generic video models", () => {
        const config = {
            generationPointMultipliers: {
                videoSeconds: { "5": 1, "10": 1, "60": 1, "120": 1 },
            },
        } as unknown as Parameters<typeof videoSecondOptionsFromConfig>[0];

        expect(videoSecondOptionsFromConfig(config)).toEqual([5, 10, 60, 120]);
    });

    it("applies a duration ceiling only when a protocol-specific limit is provided", () => {
        const config = {
            generationPointMultipliers: {
                videoSeconds: { "-1": 1, "5": 1, "10": 1, "15": 1, "60": 1 },
            },
        } as unknown as Parameters<typeof videoSecondOptionsFromConfig>[0];

        expect(videoSecondOptionsFromConfig(config, true, 15)).toEqual([-1, 5, 10, 15]);
    });
});
