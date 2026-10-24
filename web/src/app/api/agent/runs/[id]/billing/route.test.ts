import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), run: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/agent-run-store", () => ({ getAgentRun: mocks.run }));
vi.mock("@/lib/server/generation-run-billing-service", () => ({ getGenerationRunBillingSummary: mocks.summary }));

import { GET } from "./route";

const context = { params: Promise.resolve({ id: "run-one" }) };

describe("GET /api/agent/runs/[id]/billing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "user-one" });
        mocks.run.mockResolvedValue({ id: "run-one", userId: "user-one" });
        mocks.summary.mockResolvedValue({ actualPoints: 7, pendingHeldPoints: 4, charges: [], pending: [] });
    });

    it("returns only the current user's Run billing", async () => {
        const response = await GET(new Request("http://localhost/api/agent/runs/run-one/billing"), context);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { summary: { actualPoints: 7, pendingHeldPoints: 4 } } });
        expect(mocks.summary).toHaveBeenCalledWith("user-one", "run-one");
    });

    it("does not query another user's billing", async () => {
        mocks.run.mockResolvedValue({ id: "run-one", userId: "other-user" });
        const response = await GET(new Request("http://localhost/api/agent/runs/run-one/billing"), context);
        expect(response.status).toBe(404);
        expect(mocks.summary).not.toHaveBeenCalled();
    });
});
