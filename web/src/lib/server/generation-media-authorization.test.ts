import { beforeEach, describe, expect, it, vi } from "vitest";

import { generationMediaProxyHeaders, readGenerationMediaClaim } from "./generation-media-authorization";

describe("generation media authorization", () => {
    beforeEach(() => vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "test-encryption-key-that-is-at-least-32-characters"));

    it("binds the signed capability to owner, task, channel, model and exact url", () => {
        const headers = generationMediaProxyHeaders({ userId: "user", taskType: "video", taskId: "task", channelId: "channel", upstreamModel: "vendor-video", url: "https://cdn.example.com/result.mp4" });
        const request = new Request("http://localhost", { headers });

        expect(readGenerationMediaClaim(request, { userId: "user", channelId: "channel", url: "https://cdn.example.com/result.mp4" })).toMatchObject({ taskType: "video", taskId: "task", upstreamModel: "vendor-video" });
        expect(readGenerationMediaClaim(request, { userId: "other", channelId: "channel", url: "https://cdn.example.com/result.mp4" })).toBeNull();
        expect(readGenerationMediaClaim(request, { userId: "user", channelId: "channel", url: "https://cdn.example.com/other.mp4" })).toBeNull();
    });

    it("authorizes long signed upstream media urls without truncating the target", () => {
        const url = `https://s3.siliconflow.cn/temporary/result.png?X-Amz-Signature=${"a".repeat(6000)}`;
        const headers = generationMediaProxyHeaders({ userId: "user", taskType: "image", taskId: "task", channelId: "channel", upstreamModel: "vendor-image", url });
        const request = new Request("http://localhost", { headers });

        expect(readGenerationMediaClaim(request, { userId: "user", channelId: "channel", url })).toMatchObject({ taskType: "image", taskId: "task", upstreamModel: "vendor-image" });
        expect(readGenerationMediaClaim(request, { userId: "user", channelId: "channel", url: `${url}tampered` })).toBeNull();
    });

    it("rejects tampered and expired capabilities", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
        const headers = generationMediaProxyHeaders({ userId: "user", taskType: "image", taskId: "task", channelId: "channel", upstreamModel: "vendor-image", url: "https://cdn.example.com/result.png" });
        const token = String(headers["x-vozeb-pro-media-authorization"]);
        const tampered = new Request("http://localhost", { headers: { "x-vozeb-pro-media-authorization": `${token}x` } });
        expect(readGenerationMediaClaim(tampered, { userId: "user", channelId: "channel", url: "https://cdn.example.com/result.png" })).toBeNull();

        vi.advanceTimersByTime(10 * 60_000 + 1);
        const expired = new Request("http://localhost", { headers });
        expect(readGenerationMediaClaim(expired, { userId: "user", channelId: "channel", url: "https://cdn.example.com/result.png" })).toBeNull();
        vi.useRealTimers();
    });
});
