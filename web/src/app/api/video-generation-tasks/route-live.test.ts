import { afterEach, describe, expect, it } from "vitest";

import { createProtocolFixtureServer } from "../../../../scripts/protocol-fixture-server.mjs";
import { createUpstream } from "./video-generation-route";
import { queryVideoTaskUpstream } from "@/lib/server/video-task-runtime";
import type { VideoTask } from "@/lib/server/video-task-store";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

describe("video creation protocols over a live fixture", () => {
    let close: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it("uses the selected preset endpoint once, preserves headers, and polls /result/:task_id", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const baseUrl = "http://127.0.0.1:" + address.port;
        close = () => new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));

        const config = {
            apiSource: "system" as const,
            baseUrl,
            apiKey: "system" as const,
            apiFormat: "openai" as const,
            model: "sd_2.0_fast_discount_720p",
            logicalModel: "video",
            channelId: "global-video",
            advancedConfig: {
                ...emptyAdvancedConfig(),
                protocol: "globalaiopc" as const,
                globalAiOpcPreset: "video-seedance-discount" as const,
                createPath: "/seedance-discount/videos",
                queryPath: "/result/:task_id",
                supportsReferenceImage: true,
                supportsReferenceVideo: true,
                supportsReferenceAudio: true,
            },
        };

        const upstream = await createUpstream("user-live", "", "", config, "animate a blue logo", { videoSeconds: 5, size: "16:9", vquality: "720" }, [], { imageQuality: {}, videoQuality: { "720": 1 }, videoSeconds: { "5": 1 } }, "video-request-live");

        expect(upstream).toMatchObject({ model: config.model, pollPath: "/seedance-discount/videos" });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/seedance-discount/videos" });
        expect(fixture.requests[0]?.headers.authorization).toBeUndefined();
        expect(fixture.requests[0]?.headers["idempotency-key"]).toBe("video-request-live");
        expect(fixture.requests[0]?.headers["x-client-request-id"]).toBe("video-request-live");
        expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ model: config.model, duration: 5, ratio: "16:9" });

        const task = { config, upstream, userId: "user-live" } as unknown as VideoTask;
        const result = await queryVideoTaskUpstream(task, "", "");
        expect(result).toMatchObject({ state: "result_ready", resultUrl: expect.stringContaining("/media/fixture.mp4") });
        expect(fixture.requests.map((request) => request.path)).toEqual(["/seedance-discount/videos", "/result/" + upstream.id]);
    });

    it("uses a custom video template and declared create/query/result fields", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const baseUrl = "http://127.0.0.1:" + address.port;
        close = () => new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        const config = {
            apiSource: "system" as const,
            baseUrl,
            apiKey: "system" as const,
            apiFormat: "openai" as const,
            model: "custom-video-model",
            logicalModel: "video",
            channelId: "custom-video",
            advancedConfig: {
                ...emptyAdvancedConfig(),
                protocol: "custom" as const,
                createPath: "/custom/videos",
                queryPath: "/custom/results/:task_id",
                requestTemplate: '{"deployment":"{{model}}","input":"{{prompt}}","seconds":"{{duration}}","aspect":"{{ratio}}"}',
                resultField: "data.video_url",
                statusField: "data.status",
            },
        };

        const upstream = await createUpstream(
            "user-live",
            "",
            "",
            config,
            "animate a blue logo",
            { videoSeconds: 8, size: "9:16", vquality: "1080" },
            [],
            { imageQuality: {}, videoQuality: { "1080": 1 }, videoSeconds: { "8": 1 } },
            "custom-video-request-live",
        );

        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]?.path).toBe("/custom/videos");
        expect(fixture.requests[0]?.headers["idempotency-key"]).toBe("custom-video-request-live");
        expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toEqual({ deployment: config.model, input: "animate a blue logo", seconds: "8", aspect: "9:16" });

        const result = await queryVideoTaskUpstream({ config, upstream, userId: "user-live" } as unknown as VideoTask, "", "");
        expect(result).toMatchObject({ state: "result_ready", status: "completed", resultUrl: expect.stringContaining("/media/fixture.mp4") });
        expect(fixture.requests.map((request) => request.path)).toEqual(["/custom/videos", "/custom/results/" + upstream.id]);
    });

    it("uses the VOZEB recommended JSON contract and reads metadata.url", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const baseUrl = "http://127.0.0.1:" + address.port;
        close = () => new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        const config = {
            apiSource: "system" as const,
            baseUrl,
            apiKey: "system" as const,
            apiFormat: "openai" as const,
            model: "Seedance 2.0-fast-720p",
            logicalModel: "video",
            channelId: "vozeb-video",
            advancedConfig: {
                ...emptyAdvancedConfig(),
                protocol: "vozeb-recommended" as const,
                createPath: "/v1/videos/generations",
                imageToVideoPath: "/v1/videos/generations",
                queryPath: "/v1/videos/generations/:task_id",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}"}',
                resultField: "metadata.url",
                statusField: "status",
                durationRange: "5-15 秒",
                supportsReferenceImage: true,
                supportsReferenceVideo: true,
                supportsReferenceAudio: true,
            },
        };
        const referenceUrl = "https://cdn.example.com/reference.png";

        const upstream = await createUpstream(
            "user-live",
            "",
            "",
            config,
            "animate a blue logo",
            { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: true },
            [{ type: "image", url: referenceUrl }],
            { imageQuality: {}, videoQuality: { "720": 1 }, videoSeconds: { "5": 1 } },
            "vozeb-video-request-live",
        );

        expect(upstream).toMatchObject({ model: config.model, pollPath: "/v1/videos/generations" });
        expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/videos/generations" });
        expect(fixture.requests[0]?.contentType).toContain("application/json");
        expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toEqual({
            model: config.model,
            prompt: "animate a blue logo",
            duration: 5,
            resolution: "720p",
            metadata: { resolution: "720p" },
            generate_audio: false,
            aspect_ratio: "16:9",
            images: [referenceUrl],
        });

        const result = await queryVideoTaskUpstream({ config, upstream, userId: "user-live" } as unknown as VideoTask, "", "");
        expect(result).toMatchObject({ state: "result_ready", status: "completed", resultUrl: expect.stringContaining("/media/fixture.mp4") });
        expect(fixture.requests.map((request) => request.path)).toEqual(["/v1/videos/generations", "/v1/videos/generations/" + upstream.id]);
    });
});
