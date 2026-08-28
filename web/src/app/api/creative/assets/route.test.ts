import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    requireCapability: vi.fn(),
    uploadAssetForUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/server/creative-runtime-service", () => ({
    CreativeRuntimeServiceError: class CreativeRuntimeServiceError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    uploadAssetForUser: mocks.uploadAssetForUser,
}));

import { POST } from "./route";

describe("POST /api/creative/assets", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.uploadAssetForUser.mockResolvedValue({ id: "asset-one", type: "audio" });
    });

    it("requires authentication", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        const response = await POST(request("conversation-one", new File(["audio"], "voice.mp3", { type: "audio/mpeg" })));

        expect(response.status).toBe(401);
        expect(mocks.uploadAssetForUser).not.toHaveBeenCalled();
    });

    it("requires the unified asset capability", async () => {
        mocks.requireCapability.mockResolvedValueOnce(new Response(JSON.stringify({ code: 403 }), { status: 403 }));
        const response = await POST(request("conversation-one", new File(["audio"], "voice.mp3", { type: "audio/mpeg" })));

        expect(response.status).toBe(403);
        expect(mocks.uploadAssetForUser).not.toHaveBeenCalled();
    });

    it("passes a multipart media file to the owned conversation", async () => {
        const file = new File(["audio"], "voice.mp3", { type: "audio/mpeg" });
        const response = await POST(request("conversation-one", file));

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { asset: { id: "asset-one" } } });
        expect(mocks.uploadAssetForUser).toHaveBeenCalledWith("user-one", "conversation-one", expect.objectContaining({ name: "voice.mp3", type: "audio/mpeg" }));
    });

    it("rejects a missing conversation before calling the service", async () => {
        const response = await POST(request("", new File(["video"], "clip.mp4", { type: "video/mp4" })));

        expect(response.status).toBe(400);
        expect(mocks.uploadAssetForUser).not.toHaveBeenCalled();
    });

    it("rejects an oversized multipart request before parsing it", async () => {
        const response = await POST(
            new Request("http://localhost/api/creative/assets", {
                method: "POST",
                headers: { "content-type": "multipart/form-data; boundary=test", "content-length": String(20 * 1024 * 1024 + 64 * 1024 + 1) },
                body: "--test--",
            }),
        );

        expect(response.status).toBe(413);
        expect((await response.json()).msg).toBe("单个素材不能超过 20MB");
        expect(mocks.uploadAssetForUser).not.toHaveBeenCalled();
    });
});

function request(conversationId: string, file: File) {
    const body = new FormData();
    body.set("conversationId", conversationId);
    body.set("file", file);
    return new Request("http://localhost/api/creative/assets", { method: "POST", body });
}
