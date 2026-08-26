import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCreativeConversation: vi.fn(),
    getCreativeConversationsByIds: vi.fn(),
    registerCreativeAssets: vi.fn(),
    writePersistentMediaDataUrl: vi.fn(),
    deleteCreativeConversationAggregates: vi.fn(),
    deleteUserMediaAssetsCascade: vi.fn(),
}));

vi.mock("@/lib/server/creative-runtime-store", () => ({
    createCreativeConversation: vi.fn(),
    getCreativeAsset: vi.fn(),
    getCreativeConversation: mocks.getCreativeConversation,
    getCreativeConversationsByIds: mocks.getCreativeConversationsByIds,
    listCreativeAssets: vi.fn(),
    listCreativeConversations: vi.fn(),
    listCreativeMessages: vi.fn(),
    registerCreativeAssets: mocks.registerCreativeAssets,
    updateCreativeConversation: vi.fn(),
}));
vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: mocks.writePersistentMediaDataUrl }));
vi.mock("@/lib/server/creative-entity-deletion-store", () => ({ deleteCreativeConversationAggregates: mocks.deleteCreativeConversationAggregates }));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: mocks.deleteUserMediaAssetsCascade }));

import { deleteConversationsForUser, registerGenerationTaskAssetsForUser, uploadAssetForUser } from "./creative-runtime-service";

function file(name: string, type: string, size = 4): File {
    return { name, type, size, arrayBuffer: async () => new Uint8Array(Math.min(size, 4)).buffer } as File;
}

describe("创作会话素材上传", () => {
    beforeEach(() => {
        mocks.getCreativeConversation.mockReset().mockResolvedValue({ id: "conversation-one", userId: "user-one", surface: "chat", status: "active" });
        mocks.getCreativeConversationsByIds.mockReset().mockResolvedValue([{ id: "conversation-one", userId: "user-one", surface: "chat", status: "active" }]);
        mocks.writePersistentMediaDataUrl.mockReset().mockResolvedValue({ token: "persistent-one.mp4", storage: "local", bytes: 4, mimeType: "video/mp4" });
        mocks.deleteCreativeConversationAggregates.mockReset().mockResolvedValue({ deletedConversations: 1, deletedProjects: 0, mediaStorageKeys: ["permanent/one.png"] });
        mocks.deleteUserMediaAssetsCascade.mockReset().mockResolvedValue({ deletedFiles: 1, deletedBytes: 4, blocked: [] });
        mocks.registerCreativeAssets.mockReset().mockImplementation(async ([input]) => [{ ...input, id: "asset-one", status: "ready", metadata: input.metadata || {}, createdAt: 1, updatedAt: 1 }]);
    });

    it("hard-deletes conversations before reclaiming only their candidate media", async () => {
        await expect(deleteConversationsForUser("user-one", ["conversation-one", "conversation-one"])).resolves.toBe(1);

        expect(mocks.deleteCreativeConversationAggregates).toHaveBeenCalledWith("user-one", ["conversation-one"]);
        expect(mocks.deleteUserMediaAssetsCascade).toHaveBeenCalledWith("user-one", ["permanent/one.png"]);
    });

    it("rejects deleting project conversations through the ordinary chat endpoint", async () => {
        mocks.getCreativeConversationsByIds.mockResolvedValue([{ id: "conversation-one", userId: "user-one", surface: "canvas", projectId: "canvas-one", status: "active" }]);

        await expect(deleteConversationsForUser("user-one", ["conversation-one"])).rejects.toMatchObject({ status: 409 });
        expect(mocks.deleteCreativeConversationAggregates).not.toHaveBeenCalled();
    });

    it("stores image, video and audio as stable assets without persisting base64", async () => {
        const asset = await uploadAssetForUser("user-one", "conversation-one", file("clip.mp4", "video/mp4"));

        expect(mocks.writePersistentMediaDataUrl).toHaveBeenCalledWith(
            expect.stringMatching(/^data:video\/mp4;base64,/),
            "video",
            expect.objectContaining({ ownerUserId: "user-one", conversationId: "conversation-one", originalName: "clip.mp4", maxBytes: 20 * 1024 * 1024 }),
        );
        expect(asset).toMatchObject({ id: "asset-one", type: "video", serverUrl: "/api/reference-assets/persistent-one.mp4", storageKey: "persistent-one.mp4" });
        expect(JSON.stringify(mocks.registerCreativeAssets.mock.calls[0][0])).not.toContain("base64");
    });

    it("keeps the internal storage key while marking object-backed uploads", async () => {
        mocks.writePersistentMediaDataUrl.mockResolvedValue({ token: "permanent/object.png", storage: "object", bytes: 4, mimeType: "image/png" });

        const asset = await uploadAssetForUser("user-one", "conversation-one", file("image.png", "image/png"));

        expect(asset).toMatchObject({ storageKind: "object", storageKey: "permanent/object.png", serverUrl: "/api/reference-assets/permanent/object.png" });
    });

    it("rejects unsupported files, oversized files and other users' conversations", async () => {
        await expect(uploadAssetForUser("user-one", "conversation-one", file("notes.pdf", "application/pdf"))).rejects.toMatchObject({ status: 400 });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("vector.svg", "image/svg+xml"))).rejects.toMatchObject({ status: 400 });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("limit.mp4", "video/mp4", 20 * 1024 * 1024))).resolves.toMatchObject({ id: "asset-one" });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("large.mp4", "video/mp4", 20 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
        mocks.getCreativeConversation.mockResolvedValueOnce({ id: "conversation-one", userId: "user-two", status: "active" });
        await expect(uploadAssetForUser("user-one", "conversation-one", file("image.png", "image/png"))).rejects.toMatchObject({ status: 404 });
    });

    it("registers unified Agent task media against the owned conversation", async () => {
        const assets = await registerGenerationTaskAssetsForUser("user-one", {
            conversationId: "conversation-one",
            runId: "run-one",
            surface: "chat",
            taskId: "task-one",
            title: "商品主图",
            assets: [{ type: "image", url: "/api/generation-log-assets/user/file.png", mimeType: "image/png", width: 1024, height: 1024 }],
        });

        expect(assets[0]).toMatchObject({ type: "image", serverUrl: "/api/generation-log-assets/user/file.png", storageKind: "local" });
        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([expect.objectContaining({ conversationId: "conversation-one", sourceRunId: "run-one", sourceTaskId: "task-one", metadata: { surface: "chat", projectId: undefined } })]);
    });
});
