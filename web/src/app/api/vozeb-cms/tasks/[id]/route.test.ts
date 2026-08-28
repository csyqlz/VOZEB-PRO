import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: { id: "user-one" },
    get: vi.fn(),
    control: vi.fn(),
    capability: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => mocks.user) }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: mocks.capability }));
vi.mock("@/lib/server/vozeb-cms/unified-task-service", () => ({
    getVozebCmsTask: mocks.get,
    controlVozebCmsTask: mocks.control,
    vozebCmsTaskCapabilityId: (type: string) => (type === "workflow" ? "workflow.run" : `${type}.generate`),
    VozebCmsTaskActionError: class VozebCmsTaskActionError extends Error {
        constructor(
            message: string,
            readonly status = 409,
        ) {
            super(message);
        }
    },
}));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: (value: string) => value }));

import { GET, POST } from "./route";

describe("VOZEBCMS unified task route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.capability.mockResolvedValue(null);
        mocks.get.mockResolvedValue({ id: "task-one", type: "image", status: "running" });
        mocks.control.mockResolvedValue({ id: "task-one" });
    });

    it("requires authentication", async () => {
        const session = await import("@/lib/auth/session");
        vi.mocked(session.getCurrentUser).mockResolvedValueOnce(null);
        const response = await GET(new Request("http://localhost/api/vozeb-cms/tasks/task-one"), { params: Promise.resolve({ id: "task-one" }) });
        expect(response.status).toBe(401);
    });

    it("routes retry through the unified service with capability checks", async () => {
        const response = await POST(new Request("http://localhost/api/vozeb-cms/tasks/task-one", { method: "POST", body: JSON.stringify({ action: "retry" }) }), { params: Promise.resolve({ id: "task-one" }) });
        expect(response.status).toBe(200);
        expect(mocks.capability).toHaveBeenCalledWith("image.generate", "user-one");
        expect(mocks.control).toHaveBeenCalledWith(expect.objectContaining({ id: "task-one", action: "retry", userId: "user-one" }));
    });

    it("rejects unknown operations before touching the service", async () => {
        const response = await POST(new Request("http://localhost/api/vozeb-cms/tasks/task-one", { method: "POST", body: JSON.stringify({ action: "delete" }) }), { params: Promise.resolve({ id: "task-one" }) });
        expect(response.status).toBe(400);
        expect(mocks.control).not.toHaveBeenCalled();
    });

    it("uses the workflow capability for workflow task controls", async () => {
        mocks.get.mockResolvedValueOnce({ id: "workflow-one", type: "workflow", status: "waiting" });

        const response = await POST(new Request("http://localhost/api/vozeb-cms/tasks/workflow-one", { method: "POST", body: JSON.stringify({ action: "recover" }) }), { params: Promise.resolve({ id: "workflow-one" }) });

        expect(response.status).toBe(200);
        expect(mocks.capability).toHaveBeenCalledWith("workflow.run", "user-one");
    });
});
