import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), project: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/canvas-project-service", () => ({
    getCanvasProjectForUser: mocks.project,
    canvasProjectError: (error: unknown) => (error instanceof Error && "status" in error ? { status: error.status, message: error.message } : null),
}));
vi.mock("@/lib/server/generation-project-billing-service", () => ({ getGenerationProjectBillingSummary: mocks.summary }));

import { GET } from "./route";

const request = new Request("http://localhost/api/canvas/projects/canvas-one/billing");
const context = { params: Promise.resolve({ id: "canvas-one" }) };

describe("canvas project billing route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "user-one" });
        mocks.project.mockResolvedValue({ id: "canvas-one" });
        mocks.summary.mockResolvedValue({ actualPoints: 7, pendingHeldPoints: 4.25, charges: [], pending: [{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }] });
    });

    it("only reads charges after verifying project ownership", async () => {
        const response = await GET(request, context);
        expect(mocks.project).toHaveBeenCalledWith("user-one", "canvas-one");
        expect(mocks.summary).toHaveBeenCalledWith("user-one", "canvas-one");
        expect(await response.json()).toEqual({ code: 0, data: { summary: { actualPoints: 7, pendingHeldPoints: 4.25, charges: [], pending: [{ type: "image", logicalModelId: "image-a", heldPoints: 4.25, count: 1 }] } }, msg: "OK" });
    });

    it("does not read billing for another user's project", async () => {
        mocks.project.mockRejectedValue(Object.assign(new Error("画布项目不存在"), { status: 404 }));
        const response = await GET(request, context);
        expect(response.status).toBe(404);
        expect(mocks.summary).not.toHaveBeenCalled();
    });

    it("requires a session", async () => {
        mocks.user.mockResolvedValue(null);
        const response = await GET(request, context);
        expect(response.status).toBe(401);
        expect(mocks.project).not.toHaveBeenCalled();
    });
});
