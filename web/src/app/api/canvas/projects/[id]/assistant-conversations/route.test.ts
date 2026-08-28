import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), requireCapability: vi.fn(), remove: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/server/canvas-project-service", () => ({
    canvasProjectError: vi.fn(),
    deleteCanvasAssistantConversationsForUser: mocks.remove,
}));

import { DELETE } from "./route";

describe("Canvas Agent conversation deletion route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(null);
        mocks.remove.mockResolvedValue({
            deleted: 2,
            chatSessions: [{ id: "session-new", title: "新对话", messages: [], createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" }],
            activeChatId: "session-new",
        });
    });

    it("blocks deletion when the Canvas module capability is disabled", async () => {
        mocks.requireCapability.mockResolvedValueOnce(new Response(JSON.stringify({ code: 403 }), { status: 403 }));
        const response = await DELETE(new Request("http://localhost/api/canvas/projects/canvas-one/assistant-conversations", { method: "DELETE", body: "{}" }), { params: Promise.resolve({ id: "canvas-one" }) });

        expect(response.status).toBe(403);
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("passes project-scoped conversation identities to the service", async () => {
        const response = await DELETE(
            new Request("http://localhost/api/canvas/projects/canvas-one/assistant-conversations", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationIds: ["conversation-one", "conversation-two"] }),
            }),
            { params: Promise.resolve({ id: "canvas-one" }) },
        );

        expect(mocks.remove).toHaveBeenCalledWith("user-one", "canvas-one", ["conversation-one", "conversation-two"]);
        expect(await response.json()).toEqual({
            code: 0,
            data: {
                deleted: 2,
                chatSessions: [{ id: "session-new", title: "新对话", messages: [], createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" }],
                activeChatId: "session-new",
            },
            msg: "OK",
        });
    });

    it("requires an authenticated user", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const response = await DELETE(new Request("http://localhost/api/canvas/projects/canvas-one/assistant-conversations", { method: "DELETE", body: "{}" }), { params: Promise.resolve({ id: "canvas-one" }) });

        expect(response.status).toBe(401);
        expect(mocks.remove).not.toHaveBeenCalled();
    });
});
