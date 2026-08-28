import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    configured: vi.fn(() => true),
    authorized: vi.fn(() => true),
    install: vi.fn(async () => ({ database: { schemaReady: true } })),
    claim: vi.fn(async () => [{ id: "run-1", userId: "user-1", status: "running" }]),
    nextDue: vi.fn(async () => 5_000),
    advance: vi.fn(async () => ({ id: "run-1", status: "completed" })),
}));

vi.mock("@/lib/server/maintenance-auth", () => ({ isWorkerTokenConfigured: mocks.configured, isAuthorizedWorkerRequest: mocks.authorized }));
vi.mock("@/lib/server/install-status", () => ({ getInstallStatus: mocks.install }));
vi.mock("@/lib/server/vozeb-cms/workflow-store", () => ({ claimVozebCmsWorkflowRunsForMaintenance: mocks.claim, getNextVozebCmsWorkflowDueAt: mocks.nextDue }));
vi.mock("@/lib/server/vozeb-cms/workflow-runtime", () => ({ advanceVozebCmsWorkflowRun: mocks.advance }));

import { POST } from "./route";

describe("POST /api/maintenance/vozeb-workflows/run", () => {
    it("advances claimed workflow runs through the worker boundary", async () => {
        const response = await POST(new Request("http://localhost/api/maintenance/vozeb-workflows/run", { method: "POST" }));
        expect(response.status).toBe(200);
        expect(mocks.claim).toHaveBeenCalledWith("vozeb-workflow-maintenance", 20);
        expect(mocks.advance).toHaveBeenCalledWith("user-1", "run-1", { owner: "vozeb-workflow-maintenance", claimed: true });
        await expect(response.json()).resolves.toMatchObject({ data: { claimed: 1, completed: 1, nextDueAt: 5_000 } });
    });

    it("rejects requests without a configured worker credential", async () => {
        mocks.claim.mockClear();
        mocks.configured.mockReturnValueOnce(false);
        const response = await POST(new Request("http://localhost/api/maintenance/vozeb-workflows/run", { method: "POST" }));
        expect(response.status).toBe(503);
        expect(mocks.claim).not.toHaveBeenCalled();
    });
});
