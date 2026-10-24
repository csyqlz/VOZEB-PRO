import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import { createUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import { emptyAdvancedConfig, protocolModelConfig } from "@/lib/channel-protocol-registry";
import type { SystemChannelProtocol } from "@/lib/auth/store-types";
import type { ImageTask } from "@/lib/server/image-task-store";
import type { SystemGenerationChannelConfig } from "@/lib/server/generation-channel";
import { queryVideoTaskUpstream } from "@/lib/server/video-task-runtime";
import type { VideoTask } from "@/lib/server/video-task-store";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

const multipliers = { imageQuality: { auto: 1 }, videoQuality: { "720": 1 }, videoSeconds: { "5": 1 } };
let fixture: ReturnType<typeof createProtocolFixtureServer>;
let origin = "";

describe("official direct media protocols over a local TCP upstream", () => {
    beforeEach(async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("TCP fixture did not start");
        origin = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
    });

    it.each([
        ["alibaba-bailian", "qwen-image-3.0", "/compatible-mode/v1/images/generations"],
        ["bfl", "flux-2-pro", "/v1/flux-2-pro"],
        ["minimax", "image-01", "/v1/image_generation"],
        ["xai", "grok-imagine-image-2.0", "/v1/images/generations"],
    ] as const)("creates %s images and reads the vendor result", async (protocol, model, path) => {
        const advancedConfig = { ...emptyAdvancedConfig(), ...protocolModelConfig(protocol, "image", model) };
        const task: ImageTask = {
            id: `official-${protocol}`,
            userId: "fixture-user",
            username: "fixture",
            displayName: "Fixture",
            kind: "generation",
            source: "image-workbench",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            config: { baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", model, advancedConfig },
            candidateConfigs: [],
            prompt: "a red kite",
            references: [],
        };
        const result = await runOpenAiImageTask(task, origin, origin, "");
        expect(result.dataUrl || result.remoteUrl).toContain("/media/fixture.png");
        const post = fixture.requests.find((item) => item.method === "POST");
        expect(post?.path).toBe(path);
        expect(JSON.parse(post?.body.toString("utf8") || "{}").prompt).toContain("a red kite");
        if (protocol === "bfl") {
            expect(post?.headers["x-key"]).toBe("fixture-key");
            expect(fixture.requests.some((item) => item.method === "GET" && item.path === "/v1/get_result")).toBe(true);
        }
    });

    it.each([
        ["alibaba-bailian", "qwen-image-3.0", "/compatible-mode/v1/images/generations"],
        ["bfl", "flux-2-pro", "/v1/flux-2-pro"],
        ["xai", "grok-imagine-image-2.0", "/v1/images/edits"],
    ] as const)("sends %s image edits as the vendor JSON shape", async (protocol, model, path) => {
        const advancedConfig = { ...emptyAdvancedConfig(), ...protocolModelConfig(protocol, "image", model) };
        const task: ImageTask = {
            id: `official-edit-${protocol}`,
            userId: "fixture-user",
            username: "fixture",
            displayName: "Fixture",
            kind: "edit",
            source: "image-workbench",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            config: { baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", model, advancedConfig },
            candidateConfigs: [],
            prompt: "turn the kite blue",
            references: [{ id: "reference", dataUrl: "", remoteUrl: "https://cdn.example.com/reference.png" }],
        };
        const result = await runOpenAiImageTask(task, origin, origin, "");
        expect(result.dataUrl || result.remoteUrl).toBeTruthy();
        const post = fixture.requests.find((item) => item.method === "POST");
        expect(post?.path).toBe(path);
        const body = JSON.parse(post?.body.toString("utf8") || "{}");
        expect(protocol === "bfl" ? body.input_image : protocol === "xai" ? body.image?.url : body.image).toBe("https://cdn.example.com/reference.png");
    });

    it.each([
        ["alibaba-bailian", "wan3.0-video", "/api/v1/services/aigc/video-generation/video-synthesis", "/api/v1/tasks/"],
        ["kling", "kling-v3", "/v1/videos/text2video", "/v1/videos/text2video/"],
        ["vidu", "viduq3-pro", "/ent/v2/text2video", "/ent/v2/tasks/"],
        ["minimax", "MiniMax-H3", "/v2/video_generation", "/v2/query/video_generation/"],
        ["xai", "grok-imagine-video-1.5", "/v1/videos/generations", "/v1/videos/"],
    ] as const)("creates and queries %s video tasks", async (protocol, model, createPath, queryPrefix) => {
        const advancedConfig = { ...emptyAdvancedConfig(), ...protocolModelConfig(protocol, "video", model) };
        const config: SystemGenerationChannelConfig = { apiSource: "system", baseUrl: origin, apiKey: "system", apiFormat: "openai", model, logicalModel: model, channelId: `official-${protocol}`, advancedConfig };
        const upstream = await createUpstream("fixture-user", "", "", config, "a red kite", { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false }, [], multipliers, `official-video-${protocol}`);
        const result = await queryVideoTaskUpstream({ config, upstream, userId: "fixture-user" } as VideoTask, "", "");
        expect(result).toMatchObject({ state: "result_ready", resultUrl: expect.stringContaining("/media/fixture.mp4") });
        expect(fixture.requests.find((item) => item.method === "POST")?.path).toBe(createPath);
        expect(fixture.requests.some((item) => item.method === "GET" && item.path.startsWith(queryPrefix))).toBe(true);
    });

    it.each([
        ["alibaba-bailian", "wan3.0-video", "/api/v1/services/aigc/video-generation/video-synthesis"],
        ["kling", "kling-v3", "/v1/videos/image2video"],
        ["vidu", "viduq3-pro", "/ent/v2/img2video"],
        ["minimax", "MiniMax-H3", "/v2/video_generation"],
        ["xai", "grok-imagine-video-1.5", "/v1/videos/generations"],
    ] as const)("sends %s image-to-video input and queries the same task", async (protocol, model, createPath) => {
        const advancedConfig = { ...emptyAdvancedConfig(), ...protocolModelConfig(protocol, "video", model) };
        const config: SystemGenerationChannelConfig = { apiSource: "system", baseUrl: origin, apiKey: "system", apiFormat: "openai", model, logicalModel: model, channelId: `official-${protocol}`, advancedConfig };
        const upstream = await createUpstream(
            "fixture-user",
            "",
            "",
            config,
            "animate the kite",
            { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false },
            [{ type: "image", url: "https://cdn.example.com/reference.png", role: "first_frame" }],
            multipliers,
            `official-i2v-${protocol}`,
        );
        expect((await queryVideoTaskUpstream({ config, upstream, userId: "fixture-user" } as VideoTask, "", "")).state).toBe("result_ready");
        const post = fixture.requests.find((item) => item.method === "POST");
        expect(post?.path).toBe(createPath);
        expect(post?.body.toString("utf8")).toContain("reference.png");
    });
});
