import { describe, expect, it } from "vitest";

import type { ResolvedLogicalModel } from "./logical-model-router";
import { dramaShotDurationInstruction, resolveDramaShotDuration, resolveDramaShotDurations, resolveDramaVideoDurationPolicy } from "./drama-shot-config";

describe("resolveDramaShotDuration", () => {
    it("uses the backend video duration when the model omits it", () => {
        expect(resolveDramaShotDuration(undefined, 10)).toBe(10);
    });

    it("keeps an explicit model duration", () => {
        expect(resolveDramaShotDuration(6, 10)).toBe(6);
    });

    it("keeps durations above the former platform ceiling", () => {
        expect(resolveDramaShotDuration(60, 10)).toBe(60);
        expect(resolveDramaShotDuration(0, 30)).toBe(30);
    });

    it("splits a long shot across supported tiers from longest to shortest", () => {
        const policy = { defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] };
        expect(resolveDramaShotDurations(40, policy)).toEqual([15, 15, 10]);
        expect(resolveDramaShotDurations(16, policy)).toEqual([15, 5]);
        expect(dramaShotDurationInstruction(policy)).toContain("5、8、10、15 秒");
    });

    it("rounds one shot to the nearest backend tier and resolves ties upward", () => {
        const policy = { defaultSeconds: 5, durationSeconds: [5, 10] };

        expect(resolveDramaShotDurations(6, policy)).toEqual([5]);
        expect(resolveDramaShotDurations(9, policy)).toEqual([10]);
        expect(resolveDramaShotDurations(7, { defaultSeconds: 5, durationSeconds: [5, 9] })).toEqual([9]);
    });

    it("uses backend duration tiers from longest to shortest when model capabilities omit them", () => {
        const policy = resolveDramaVideoDurationPolicy([], 5, { "5": 1, "8": 1, "10": 1, "15": 1, "-1": 1 });

        expect(policy).toMatchObject({ defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] });
        expect(resolveDramaShotDurations(16, policy)).toEqual([15, 5]);
        expect(resolveDramaShotDurations(9, policy)).toEqual([10]);
    });

    it("prefers explicit model tiers before backend tiers", () => {
        const policy = resolveDramaVideoDurationPolicy(
            [
                {
                    logicalModelId: "video-planner",
                    upstreamModel: "vendor-video",
                    channelId: "video-channel",
                    channel: { id: "video-channel", name: "视频渠道", baseUrl: "https://video.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-video"], enabled: true },
                    capabilityProfile: { durationSeconds: [6, 9] },
                } as ResolvedLogicalModel,
            ],
            5,
            { "5": 1, "10": 1, "15": 1 },
        );

        expect(policy).toMatchObject({ defaultSeconds: 6, durationSeconds: [6, 9] });
    });

    it("filters backend tiers through the configured provider range", () => {
        const policy = resolveDramaVideoDurationPolicy(
            [
                {
                    logicalModelId: "video-planner",
                    upstreamModel: "vendor-video",
                    channelId: "video-channel",
                    channel: {
                        id: "video-channel",
                        name: "视频渠道",
                        baseUrl: "https://video.example.com/v1",
                        apiKey: "secret",
                        apiFormat: "openai",
                        models: ["vendor-video"],
                        enabled: true,
                        advancedConfig: { durationRange: "6-10 秒" },
                    },
                    capabilityProfile: { minDurationSeconds: 6, maxDurationSeconds: 10 },
                } as ResolvedLogicalModel,
            ],
            6,
            { "5": 1, "8": 1, "10": 1, "15": 1 },
        );

        expect(policy).toMatchObject({ defaultSeconds: 8, durationSeconds: [8, 10], minDurationSeconds: 6, maxDurationSeconds: 10 });
    });

    it("splits continuous ranges without creating unsupported durations", () => {
        const durations = resolveDramaShotDurations(40, { defaultSeconds: 5, minDurationSeconds: 4, maxDurationSeconds: 15 });
        expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(40);
        expect(durations.every((duration) => duration >= 4 && duration <= 15)).toBe(true);
    });

    it("does not invent a provider ceiling without a capability declaration", () => {
        expect(resolveDramaShotDurations(40, { defaultSeconds: 5 })).toEqual([40]);
    });
});
