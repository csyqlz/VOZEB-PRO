import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRecord: vi.fn() }));
vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskRecord: mocks.getRecord }));

import { authorizeGenerationMediaProxyRequest } from "./generation-media-access";
import { generationMediaProxyHeaders } from "./generation-media-authorization";

describe("generation media proxy access", () => {
    beforeEach(() => {
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "test-encryption-key-that-is-at-least-32-characters");
        mocks.getRecord.mockReset().mockResolvedValue({ userId: "user", status: "running", payload: { config: { baseUrl: "/api/ai/system/channel", model: "vendor-video" } } });
    });

    it("accepts only a server-signed target tied to an owned task", async () => {
        const url = "https://cdn.example.com/result.mp4";
        const headers = generationMediaProxyHeaders({ userId: "user", taskType: "video", taskId: "task", channelId: "channel", upstreamModel: "vendor-video", url });
        await expect(authorizeGenerationMediaProxyRequest(new Request("http://localhost", { headers }), { userId: "user", channelId: "channel", url })).resolves.toBe(true);
        expect(mocks.getRecord).toHaveBeenCalledWith("video", "task");
    });

    it("authorizes image results by upstream identity even when the logical model differs", async () => {
        const url = "https://cdn.example.com/result.png";
        mocks.getRecord.mockResolvedValue({ userId: "user", status: "running", payload: { config: { baseUrl: "/api/ai/system/channel", model: "flux-kontext-pro", logicalModel: "logical-image" } } });
        for (const upstreamModel of ["flux-kontext-pro", "logical-image"]) {
            const headers = generationMediaProxyHeaders({ userId: "user", taskType: "image", taskId: "task", channelId: "channel", upstreamModel, url });
            await expect(authorizeGenerationMediaProxyRequest(new Request("http://localhost", { headers }), { userId: "user", channelId: "channel", url })).resolves.toBe(upstreamModel === "flux-kontext-pro");
        }
    });

    it("rejects unsigned, cross-user and cancelled task media", async () => {
        const url = "https://cdn.example.com/result.mp4";
        await expect(authorizeGenerationMediaProxyRequest(new Request("http://localhost"), { userId: "user", channelId: "channel", url })).resolves.toBe(false);

        const headers = generationMediaProxyHeaders({ userId: "user", taskType: "video", taskId: "task", channelId: "channel", upstreamModel: "vendor-video", url });
        mocks.getRecord.mockResolvedValueOnce({ userId: "other", status: "running", payload: { config: { baseUrl: "/api/ai/system/channel", model: "vendor-video" } } });
        await expect(authorizeGenerationMediaProxyRequest(new Request("http://localhost", { headers }), { userId: "user", channelId: "channel", url })).resolves.toBe(false);
        mocks.getRecord.mockResolvedValueOnce({ userId: "user", status: "cancelled", payload: { config: { baseUrl: "/api/ai/system/channel", model: "vendor-video" } } });
        await expect(authorizeGenerationMediaProxyRequest(new Request("http://localhost", { headers }), { userId: "user", channelId: "channel", url })).resolves.toBe(false);
    });
});
