import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getAuthSettings: vi.fn(),
    buildAgentReadiness: vi.fn(),
    probeDefaultTextModel: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));
vi.mock("@/lib/server/agent-readiness", () => ({ buildAgentReadiness: mocks.buildAgentReadiness, probeDefaultTextModel: mocks.probeDefaultTextModel }));

import { GET, POST } from "./route";

describe("/api/admin/agent-readiness", () => {
    const settings = { id: "settings" };
    const readiness = {
        ready: true,
        capabilities: [],
        skills: { image: 0, video: 0, canvas: 0, drama: 0 },
        defaults: {},
        concurrency: {},
        diagnostics: { checkedAt: "2026-09-14T00:00:00.000Z", summary: "模型配置已就绪", blockingIssues: [], warnings: [] },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin-one", role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        mocks.getAuthSettings.mockResolvedValue(settings);
        mocks.buildAgentReadiness.mockReturnValue(readiness);
        mocks.probeDefaultTextModel.mockResolvedValue({ capability: "text", status: "pass", message: "默认文本模型实测通过", elapsedMs: 120, protocol: "chat" });
    });

    it("returns static readiness for GET", async () => {
        const response = await GET();
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload).toMatchObject({ code: 0, data: readiness });
    });

    it("runs the low-cost text probe for POST", async () => {
        const request = new Request("https://app.example/api/admin/agent-readiness", { method: "POST", headers: { cookie: "session=abc" } });
        const response = await POST(request);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.probeDefaultTextModel).toHaveBeenCalledWith({ settings, request, userId: "admin-one" });
        expect(payload).toMatchObject({ code: 0, msg: "模型诊断完成", data: { diagnostics: { probes: [expect.objectContaining({ status: "pass" })] } } });
    });

    it("requires upstream management permission", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one", role: "user", status: "active", adminPermissions: [] });

        expect((await GET()).status).toBe(403);
        expect((await POST(new Request("https://app.example/api/admin/agent-readiness", { method: "POST" }))).status).toBe(403);
    });
});
