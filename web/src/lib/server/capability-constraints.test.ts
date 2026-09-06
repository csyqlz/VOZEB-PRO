import { describe, expect, it } from "vitest";

import { assertCapabilityConstraints, reconcileCapabilityConstraints } from "./capability-constraints";

describe("capability constraints", () => {
    it("rejects unsupported reference count, duration, batch and ratio", () => {
        const profile = { maxReferenceImages: 2, maxDurationSeconds: 8, durationSeconds: [5, 8], maxBatchSize: 2, aspectRatios: ["16:9"], resolutions: ["1080P", "2K"] };
        expect(() => assertCapabilityConstraints(profile, { capability: "video", referenceCount: 3 })).toThrow("最多支持 2 张参考图");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", durationSeconds: 9 })).toThrow("最长视频时长");
        expect(() => assertCapabilityConstraints(profile, { capability: "image", batchSize: 3 })).toThrow("批量生成");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", aspectRatio: "9:16" })).toThrow("不支持 9:16 比例");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", durationSeconds: 6 })).toThrow("不支持 6 秒时长");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", resolution: "720p" })).toThrow("不支持 720p 分辨率");
        expect(() => assertCapabilityConstraints(profile, { capability: "image", aspectRatio: "1920x1080", resolution: "2k" })).not.toThrow();
        expect(() => assertCapabilityConstraints(profile, { capability: "image", aspectRatio: "auto", resolution: "AUTO" })).not.toThrow();
    });

    it("falls back to declared provider presets", () => {
        const profile = { aspectRatios: ["1024x1024", "9:16"], resolutions: ["1K", "2K"] };
        expect(reconcileCapabilityConstraints(profile, { capability: "image", aspectRatio: "2048x2048", resolution: "4K" })).toMatchObject({ aspectRatio: "1024x1024", resolution: "1K" });
        expect(reconcileCapabilityConstraints(profile, { capability: "image", aspectRatio: "16:9", resolution: "2k" })).toMatchObject({ aspectRatio: "1024x1024", resolution: "2k" });
        expect(reconcileCapabilityConstraints(profile, { capability: "image", aspectRatio: "9:16", resolution: "2k" })).toMatchObject({ aspectRatio: "9:16", resolution: "2k" });
    });

    it("prefers exact pixel presets when a provider declares them", () => {
        const profile = { sizes: ["1024x1024", "1536x1024"] };
        expect(reconcileCapabilityConstraints(profile, { capability: "image", aspectRatio: "3072x2048" }).aspectRatio).toBe("1536x1024");
        expect(() => assertCapabilityConstraints(profile, { capability: "image", aspectRatio: "1536x1024" })).not.toThrow();
        expect(() => assertCapabilityConstraints(profile, { capability: "image", aspectRatio: "2048x2048" })).toThrow("不支持");
    });
});
