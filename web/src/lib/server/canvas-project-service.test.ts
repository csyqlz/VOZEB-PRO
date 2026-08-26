import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasProject } from "@/lib/canvas-project-contract";

const mocks = vi.hoisted(() => ({
    CreativeEntityDeletionConflict: class CreativeEntityDeletionConflict extends Error {},
    createCreativeConversation: vi.fn(),
    createCanvasProject: vi.fn(),
    deleteCanvasProjectAggregates: vi.fn(),
    deleteCanvasAssistantConversationAggregates: vi.fn(),
    getCanvasProject: vi.fn(),
    listCanvasProjectSummaries: vi.fn(),
    updateCanvasProject: vi.fn(),
    updateCanvasProjectMutationPatch: vi.fn(),
    deleteUserMediaAssetsCascade: vi.fn(),
}));

vi.mock("@/lib/server/creative-runtime-store", () => ({ createCreativeConversation: mocks.createCreativeConversation }));
vi.mock("@/lib/server/canvas-project-store", () => ({
    CanvasProjectStoreError: class CanvasProjectStoreError extends Error {},
    createCanvasProject: mocks.createCanvasProject,
    getCanvasProject: mocks.getCanvasProject,
    listCanvasProjectSummaries: mocks.listCanvasProjectSummaries,
    updateCanvasProject: mocks.updateCanvasProject,
    updateCanvasProjectMutationPatch: mocks.updateCanvasProjectMutationPatch,
}));
vi.mock("@/lib/server/creative-entity-deletion-store", () => ({
    CreativeEntityDeletionConflict: mocks.CreativeEntityDeletionConflict,
    deleteCanvasProjectAggregates: mocks.deleteCanvasProjectAggregates,
    deleteCanvasAssistantConversationAggregates: mocks.deleteCanvasAssistantConversationAggregates,
}));
vi.mock("@/lib/server/user-media-deletion-service", () => ({ deleteUserMediaAssetsCascade: mocks.deleteUserMediaAssetsCascade }));

import { createCanvasProjectForUser, deleteCanvasAssistantConversationsForUser, deleteCanvasProjectsForUser, updateCanvasProjectForUser } from "./canvas-project-service";

describe("canvas project service lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createCreativeConversation.mockResolvedValue({ id: "conversation-new" });
        mocks.deleteCanvasProjectAggregates.mockResolvedValue({ deletedConversations: 1, deletedProjects: 1, mediaStorageKeys: ["permanent/canvas.png"] });
        mocks.deleteCanvasAssistantConversationAggregates.mockResolvedValue({
            deletedConversations: 1,
            deletedProjects: 0,
            mediaStorageKeys: ["permanent/assistant.png"],
            canvasAssistantState: { chatSessions: [assistantSession("session-new")], activeChatId: "session-new" },
        });
        mocks.getCanvasProject.mockResolvedValue(null);
    });

    it("deletes the new conversation when project creation fails", async () => {
        const error = new Error("write failed");
        mocks.createCanvasProject.mockRejectedValue(error);

        await expect(createCanvasProjectForUser("user-one", { title: "画布" })).rejects.toBe(error);

        expect(mocks.deleteCanvasProjectAggregates).toHaveBeenCalledWith("user-one", [expect.stringMatching(/^canvas-/)]);
    });

    it("reuses a source handoff project through its stable primary key", async () => {
        const existing = { ...project(), id: "canvas-handoff-one", sourceHandoffId: "handoff-one" };
        mocks.getCanvasProject.mockResolvedValue(existing);

        await expect(createCanvasProjectForUser("user-one", { sourceHandoffId: "handoff-one" })).resolves.toEqual(existing);

        expect(mocks.getCanvasProject).toHaveBeenCalledWith("canvas-handoff-one", "user-one");
        expect(mocks.createCreativeConversation).not.toHaveBeenCalled();
        expect(mocks.createCanvasProject).not.toHaveBeenCalled();
    });

    it("deletes linked conversations and reclaims only unreferenced media after deleting projects", async () => {
        await deleteCanvasProjectsForUser("user-one", ["canvas-one"]);

        expect(mocks.deleteCanvasProjectAggregates).toHaveBeenCalledWith("user-one", ["canvas-one"]);
        expect(mocks.deleteUserMediaAssetsCascade).toHaveBeenCalledWith("user-one", ["permanent/canvas.png"]);
    });

    it("deletes only assistant conversations linked to the current Canvas project", async () => {
        mocks.getCanvasProject.mockResolvedValue({ ...project(), chatSessions: [assistantSession("session-one", "conversation-agent")] });

        await expect(deleteCanvasAssistantConversationsForUser("user-one", "canvas-one", ["conversation-agent"])).resolves.toMatchObject({ deleted: 1, activeChatId: "session-new" });

        expect(mocks.deleteCanvasAssistantConversationAggregates).toHaveBeenCalledWith("user-one", "canvas-one", ["conversation-agent"]);
        expect(mocks.deleteUserMediaAssetsCascade).toHaveBeenCalledWith("user-one", ["permanent/assistant.png"]);
    });

    it("returns the owned project state when no assistant conversation id is provided", async () => {
        const current = { ...project(), chatSessions: [assistantSession("session-one")], activeChatId: "session-one" };
        mocks.getCanvasProject.mockResolvedValue(current);

        await expect(deleteCanvasAssistantConversationsForUser("user-one", "canvas-one", [])).resolves.toEqual({
            deleted: 0,
            chatSessions: current.chatSessions,
            activeChatId: "session-one",
        });

        expect(mocks.getCanvasProject).toHaveBeenCalledWith("canvas-one", "user-one");
        expect(mocks.deleteCanvasAssistantConversationAggregates).not.toHaveBeenCalled();
        expect(mocks.deleteUserMediaAssetsCascade).not.toHaveBeenCalled();
    });

    it("protects the Canvas primary conversation and unrelated assistant conversations", async () => {
        mocks.getCanvasProject.mockResolvedValue({ ...project(), chatSessions: [assistantSession("session-one", "conversation-agent")] });
        mocks.deleteCanvasAssistantConversationAggregates.mockRejectedValue(new mocks.CreativeEntityDeletionConflict("Agent 对话与当前画布不匹配"));

        await expect(deleteCanvasAssistantConversationsForUser("user-one", "canvas-one", ["conversation-one"])).rejects.toMatchObject({ status: 409 });
        await expect(deleteCanvasAssistantConversationsForUser("user-one", "canvas-one", ["conversation-other"])).rejects.toMatchObject({ status: 409 });
        expect(mocks.deleteUserMediaAssetsCascade).not.toHaveBeenCalled();
    });

    it("passes the explicit server version to the conditional store update", async () => {
        const current = project();
        mocks.getCanvasProject.mockResolvedValue(current);
        mocks.updateCanvasProject.mockResolvedValue({ ...current, title: "新标题" });

        await updateCanvasProjectForUser("user-one", current.id, { project: { ...current, title: "新标题" }, expectedUpdatedAt: current.updatedAt });

        expect(mocks.updateCanvasProject).toHaveBeenCalledWith("user-one", expect.objectContaining({ title: "新标题" }), current.updatedAt);
    });

    it("always advances the persisted version beyond the current snapshot", async () => {
        const current = { ...project(), updatedAt: "2099-01-01T00:00:00.000Z" };
        mocks.getCanvasProject.mockResolvedValue(current);
        mocks.updateCanvasProject.mockImplementation(async (_userId, next) => next);

        await updateCanvasProjectForUser("user-one", current.id, { project: { ...current, title: "新标题" }, expectedUpdatedAt: current.updatedAt });

        const saved = mocks.updateCanvasProject.mock.calls[0][1] as CanvasProject;
        expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(current.updatedAt));
    });

    it("rejects saves without a valid base version", async () => {
        await expect(updateCanvasProjectForUser("user-one", "canvas-one", { project: project() })).rejects.toMatchObject({ status: 400 });
        expect(mocks.getCanvasProject).not.toHaveBeenCalled();
    });

    it("applies a compact mutation and returns an idempotent save acknowledgement", async () => {
        const current = project();
        mocks.getCanvasProject.mockResolvedValue(current);
        mocks.updateCanvasProjectMutationPatch.mockResolvedValue({ projectId: current.id, updatedAt: "2026-08-01T00:00:00.001Z", mutationId: "mutation-one" });

        await expect(
            updateCanvasProjectForUser("user-one", current.id, {
                mutation: {
                    mutationId: "mutation-one",
                    baseUpdatedAt: current.updatedAt,
                    title: "增量标题",
                    viewport: { x: 12, y: 24, k: 0.05 },
                },
            }),
        ).resolves.toMatchObject({ projectId: current.id, mutationId: "mutation-one" });

        expect(mocks.updateCanvasProjectMutationPatch).toHaveBeenCalledWith("user-one", current.id, expect.objectContaining({ title: "增量标题", viewport: { x: 12, y: 24, k: 0.05 } }));
        expect(mocks.updateCanvasProject).not.toHaveBeenCalled();
    });

    it("keeps only stable unique entity ids in compact upserts", async () => {
        const current = project();
        mocks.getCanvasProject.mockResolvedValue(current);
        mocks.updateCanvasProjectMutationPatch.mockResolvedValue({ projectId: current.id, updatedAt: current.updatedAt, mutationId: "mutation-ids" });

        await updateCanvasProjectForUser("user-one", current.id, {
            mutation: {
                mutationId: "mutation-ids",
                baseUpdatedAt: current.updatedAt,
                nodeUpserts: [{ id: "node-one", type: "text" }, { id: "node-one", type: "text", title: "latest" }, { id: "" }, { title: "missing-id" }],
                connectionUpserts: [
                    { id: "edge-one", fromNodeId: "node-one", toNodeId: "node-two" },
                    { id: "edge-one", fromNodeId: "node-two", toNodeId: "node-three" },
                ],
            },
        });

        expect(mocks.updateCanvasProjectMutationPatch).toHaveBeenCalledWith(
            "user-one",
            current.id,
            expect.objectContaining({
                nodeUpserts: [{ id: "node-one", type: "text", title: "latest" }],
                connectionUpserts: [{ id: "edge-one", fromNodeId: "node-two", toNodeId: "node-three" }],
            }),
        );
    });

    it("removes transient media payloads before compact persistence", async () => {
        const current = project();
        mocks.updateCanvasProjectMutationPatch.mockResolvedValue({ projectId: current.id, updatedAt: current.updatedAt, mutationId: "mutation-media" });

        await updateCanvasProjectForUser("user-one", current.id, {
            mutation: {
                mutationId: "mutation-media",
                baseUpdatedAt: current.updatedAt,
                nodeUpserts: [{ id: "node-media", metadata: { content: "data:image/png;base64,AA==", preview: "blob:temporary" } }],
            },
        });

        expect(mocks.updateCanvasProjectMutationPatch).toHaveBeenCalledWith("user-one", current.id, expect.objectContaining({ nodeUpserts: [{ id: "node-media", metadata: { content: "", preview: "" } }] }));
    });
});

function project(): CanvasProject {
    const now = new Date().toISOString();
    return {
        id: "canvas-one",
        title: "画布",
        creativeConversationId: "conversation-one",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        createdAt: now,
        updatedAt: now,
    };
}

function assistantSession(id: string, conversationId?: string): CanvasProject["chatSessions"][number] {
    const now = new Date().toISOString();
    return { id, ...(conversationId ? { conversationId } : {}), title: "Agent 对话", messages: [], createdAt: now, updatedAt: now };
}
