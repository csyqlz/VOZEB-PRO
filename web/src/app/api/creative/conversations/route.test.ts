import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    createConversationForUser: vi.fn(),
    listConversationsForUser: vi.fn(),
    deleteConversationsForUser: vi.fn(),
}));

vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: vi.fn(async () => null) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/creative-runtime-service", () => ({
    createConversationForUser: mocks.createConversationForUser,
    CreativeRuntimeServiceError: class CreativeRuntimeServiceError extends Error {
        constructor(
            message: string,
            public readonly status: number,
        ) {
            super(message);
        }
    },
    listConversationsForUser: mocks.listConversationsForUser,
    deleteConversationsForUser: mocks.deleteConversationsForUser,
}));

import { DELETE, GET, POST } from "./route";

describe("creative conversation collection route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.listConversationsForUser.mockResolvedValue([
            { id: "one", title: "一", updatedAt: 2 },
            { id: "two", title: "二", updatedAt: 1 },
        ]);
        mocks.deleteConversationsForUser.mockResolvedValue(2);
        mocks.createConversationForUser.mockResolvedValue({ id: "new-conversation" });
    });

    it("creates conversations through the Agent capability gate", async () => {
        const response = await POST(new Request("http://localhost/api/creative/conversations", { method: "POST", body: JSON.stringify({ surface: "chat" }) }));
        expect(response.status).toBe(200);
        expect(mocks.createConversationForUser).toHaveBeenCalledWith("user-one", expect.anything());
    });

    it("returns one bounded conversation page with server-side filters", async () => {
        const response = await GET(new Request("http://localhost/api/creative/conversations?surface=chat&source=agent&projectId=project-one&limit=1&offset=2"));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.listConversationsForUser).toHaveBeenCalledWith("user-one", { surface: "chat", source: "agent", projectId: "project-one", status: null, limit: "2", offset: "2" });
        expect(payload.data).toEqual({ conversations: [expect.objectContaining({ id: "one" })], hasMore: true });
    });

    it("rejects anonymous conversation reads", async () => {
        mocks.getCurrentUser.mockResolvedValueOnce(null);
        const response = await GET(new Request("http://localhost/api/creative/conversations"));
        expect(response.status).toBe(401);
        expect(mocks.listConversationsForUser).not.toHaveBeenCalled();
    });

    it("hard-deletes a bounded conversation batch for the current user", async () => {
        const response = await DELETE(
            new Request("http://localhost/api/creative/conversations", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: ["one", "two"] }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.deleteConversationsForUser).toHaveBeenCalledWith("user-one", ["one", "two"]);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { deleted: 2 } });
    });
});
