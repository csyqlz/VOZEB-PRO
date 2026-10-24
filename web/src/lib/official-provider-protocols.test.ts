import { describe, expect, it } from "vitest";

import { buildOfficialVideoRequest } from "@/lib/official-provider-protocols";
import { applyChannelProtocol, channelProtocolValidationErrors, emptyAdvancedConfig, protocolAuthHeaders, protocolModelConfig, resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import type { SystemModelChannel } from "@/lib/auth/store-types";
import { inferModelCapability } from "@/lib/model-capability";

const input = { model: "wan3.0-video", prompt: "a red kite", duration: 5, ratio: "16:9", resolution: "720p", references: [] };

describe("official direct provider presets", () => {
    it("resolves Hailuo model operations independently of the H3 operation", () => {
        const h3 = protocolModelConfig("minimax", "video", "MiniMax-H3")!;
        const advanced = { ...emptyAdvancedConfig(), protocol: "minimax" as const, modelConfigs: { "minimax-hailuo-2.3": h3 } };
        expect(resolveChannelModelConfig(advanced, "MiniMax-Hailuo-2.3")).toMatchObject({ createPath: "/v1/video_generation", queryPath: "/v1/query/video_generation?task_id=:task_id", resultField: "download_url", statusField: "status" });
        expect(protocolModelConfig("minimax", "video", "MiniMax-H3")).toEqual(h3);
        expect(protocolModelConfig("minimax", "video", "MiniMax-Hailuo-2.3-Fast")?.supportsReferenceImage).toBe(true);
    });

    it("preserves Hailuo's unselected parameters and distinct fixed-duration request", () => {
        expect(buildOfficialVideoRequest("minimax", { model: "MiniMax-Hailuo-2.3", prompt: "kite", references: [] })).toEqual({ model: "MiniMax-Hailuo-2.3", prompt: "kite" });
        expect(buildOfficialVideoRequest("minimax", { ...input, model: "MiniMax-Hailuo-2.3-Fast", duration: 10, resolution: "768p", references: [{ type: "image", role: "first_frame", url: "https://example.com/first.png" }] })).toEqual({
            model: "MiniMax-Hailuo-2.3-Fast",
            prompt: input.prompt,
            duration: 10,
            resolution: "768P",
            first_frame_image: "https://example.com/first.png",
        });
        expect(() => buildOfficialVideoRequest("minimax", { ...input, model: "MiniMax-Hailuo-2.3-Fast", references: [] })).toThrow("仅支持图生视频");
        expect(() => buildOfficialVideoRequest("minimax", { ...input, model: "MiniMax-Hailuo-2.3", duration: 10, resolution: "1080P" })).toThrow("1080P 仅支持 6 秒");
        expect(() => buildOfficialVideoRequest("minimax", { ...input, model: "MiniMax-Hailuo-2.3", references: [{ type: "image", role: "last_frame", url: "https://example.com/last.png" }] })).toThrow("不支持尾帧");
    });
    it("preserves protocol identity when a configured channel is normalized", () => {
        const channel: SystemModelChannel = { id: "official", name: "官方渠道", baseUrl: "", apiKey: "secret", apiFormat: "openai", models: [], enabled: true };
        for (const protocol of ["zai-glm", "alibaba-bailian", "bfl", "kling", "vidu", "minimax", "anthropic", "xai"] as const) {
            const configured = applyChannelProtocol(channel, protocol);
            expect(configured.advancedConfig?.protocol).toBe(protocol);
            expect(channelProtocolValidationErrors(configured)).toEqual([]);
        }
        expect(protocolAuthHeaders("secret", { protocol: "bfl" })).toEqual({ "x-key": "secret" });
    });

    it("renders the official Bailian video input and distinguishes HappyHorse image-to-video", () => {
        expect(buildOfficialVideoRequest("alibaba-bailian", input)).toEqual({ model: "wan3.0-video", input: { prompt: "a red kite" }, parameters: { duration: 5, resolution: "720P", ratio: "16:9" } });
        expect(buildOfficialVideoRequest("alibaba-bailian", { ...input, model: "happyhorse-1.1-i2v", references: [{ type: "image", url: "https://example.com/first.png", role: "reference" }] })).toMatchObject({
            input: { media: [{ type: "first_frame", url: "https://example.com/first.png" }] },
            parameters: { duration: 5, resolution: "720P" },
        });
        expect(buildOfficialVideoRequest("alibaba-bailian", { ...input, model: "wan2.6-i2v-flash", references: [{ type: "image", url: "https://example.com/first.png", role: "first_frame" }] })).toMatchObject({
            input: { img_url: "https://example.com/first.png" },
            parameters: { duration: 5, resolution: "720P" },
        });
    });

    it("uses the distinct Kling, Vidu and MiniMax reference formats", () => {
        const references = [{ type: "image", url: "https://example.com/first.png", role: "first_frame" }];
        expect(buildOfficialVideoRequest("kling", { ...input, model: "kling-v3", references })).toMatchObject({ image: references[0].url, model_name: "kling-v3" });
        expect(buildOfficialVideoRequest("vidu", { ...input, model: "viduq3-pro", references })).toMatchObject({ images: [references[0].url], resolution: "720p" });
        expect(buildOfficialVideoRequest("minimax", { ...input, model: "MiniMax-H3", references })).toMatchObject({
            resolution: "768P",
            ratio: "adaptive",
            content: [
                { type: "text", text: "a red kite" },
                { type: "image_url", image_url: { url: references[0].url }, role: "first_frame" },
            ],
        });
        expect(() => buildOfficialVideoRequest("vidu", { ...input, references: [...references, { type: "image", url: "https://example.com/last.png", role: "last_frame" }] })).toThrow("只支持一张首帧");
    });

    it.each(["happyhorse-1.1-i2v", "viduq3-pro", "wan2.6", "MiniMax-H3"])("classifies %s as video during manual onboarding", (model) => {
        expect(inferModelCapability(model)).toBe("video");
    });

    it("rejects older Qwen Image IDs whose API shape differs from the 3.0 preset", () => {
        const channel: SystemModelChannel = { id: "qwen", name: "百炼", baseUrl: "", apiKey: "secret", apiFormat: "openai", models: ["qwen-image-2.0"], enabled: true };
        expect(channelProtocolValidationErrors(applyChannelProtocol(channel, "alibaba-bailian"))).toContain("qwen-image-2.0 不属于此预设已验证的 Qwen Image 3.0 接口");
    });
});
