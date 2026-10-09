import { describe, expect, it } from "vitest";

import type { SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { channelProtocolLabel, channelWorkspaceStatus, channelWorkspaceStatusLabel, defaultModelField, removeChannelFromWorkspace, updateChannelInWorkspace } from "./admin-channel-workspace-model";

const channel = applyChannelProtocol({ id: "sd2", name: "SD2 渠道", baseUrl: "https://api.example.com", apiKey: "secret", apiFormat: "openai", models: ["seedance-pro"], enabled: true } satisfies SystemModelChannel, "seedance");

describe("admin channel workspace model", () => {
    it("keeps SD2 and Stable Diffusion labels distinct", () => {
        const stableDiffusion = applyChannelProtocol({ ...channel, id: "sd", models: ["sdxl"] }, "stable-diffusion");
        expect(channelProtocolLabel(channel)).toContain("SD2");
        expect(channelProtocolLabel(stableDiffusion)).toContain("Stable Diffusion");
    });

    it("derives channel status from configuration only", () => {
        expect(channelWorkspaceStatus(channel)).toBe("enabled");
        expect(channelWorkspaceStatus({ ...channel, enabled: false })).toBe("disabled");
        expect(channelWorkspaceStatus({ ...channel, enabled: false, baseUrl: "" })).toBe("draft");
    });

    it("uses configuration status labels", () => {
        expect(channelWorkspaceStatusLabel(channelWorkspaceStatus(channel))).toBe("已启用");
    });

    it("removes dead bindings and defaults with a deleted channel", () => {
        const settings = {
            systemChannels: [channel],
            ecommerceVisualQualityCheckEnabled: true,
            logicalModels: [{ id: "video-pro", name: "专业视频", capability: "video" as const, enabled: true, bindings: [{ id: "binding", channelId: channel.id, upstreamModel: "seedance-pro", enabled: true, priority: 1 }] }],
            defaultModels: { textModel: "", imageModel: "", videoModel: "video-pro", audioModel: "" },
        };
        expect(removeChannelFromWorkspace(settings, channel.id)).toEqual({ systemChannels: [], logicalModels: [], defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" }, ecommerceVisualQualityCheckEnabled: true });
        expect(defaultModelField("video")).toBe("videoModel");
    });

    it("clears an unresolved default as soon as its only channel is disabled", () => {
        const settings = {
            systemChannels: [channel],
            logicalModels: [{ id: "video-pro", name: "专业视频", capability: "video" as const, enabled: true, bindings: [{ id: "binding", channelId: channel.id, upstreamModel: "seedance-pro", enabled: true, priority: 1 }] }],
            defaultModels: { textModel: "", imageModel: "", videoModel: "video-pro", audioModel: "" },
        };

        expect(updateChannelInWorkspace(settings, channel.id, { enabled: false }).defaultModels.videoModel).toBe("");
    });
});
