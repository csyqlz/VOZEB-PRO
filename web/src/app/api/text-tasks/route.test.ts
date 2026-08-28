import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    requireCapability: vi.fn(),
    getAuthSettings: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.requireCapability }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));

import { POST } from "./route";

describe("POST /api/text-tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.requireCapability.mockResolvedValue(new Response(JSON.stringify({ code: 403, data: null, msg: "文本生成模块已停用" }), { status: 403 }));
    });

    it("rejects disabled text generation before loading settings or creating work", async () => {
        const response = await POST(new Request("http://localhost/api/text-tasks", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "生成一段文案" }] }) }));

        expect(response.status).toBe(403);
        expect(mocks.requireCapability).toHaveBeenCalledWith("text.generate", "user-one");
        expect(mocks.getAuthSettings).not.toHaveBeenCalled();
    });
});
