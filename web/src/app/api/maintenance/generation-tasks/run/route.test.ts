import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    configured: vi.fn(),
    authorized: vi.fn(),
    recover: vi.fn(),
    nextDueAt: vi.fn(),
    install: vi.fn(),
}));

vi.mock("@/lib/server/maintenance-auth", () => ({
    isWorkerTokenConfigured: mocks.configured,
    isAuthorizedWorkerRequest: mocks.authorized,
}));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: mocks.recover }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ getNextGenerationTaskDueAt: mocks.nextDueAt }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://internal:3000") }));
vi.mock("@/lib/server/install-status", () => ({ getInstallStatus: mocks.install }));

import { maxDuration, POST } from "./route";

describe("POST /api/maintenance/generation-tasks/run", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://vozeb.example");
        mocks.configured.mockReturnValue(true);
        mocks.authorized.mockReturnValue(true);
        mocks.recover.mockResolvedValue({ claimed: 0 });
        mocks.nextDueAt.mockResolvedValue(undefined);
        mocks.install.mockResolvedValue({ database: { schemaReady: true } });
    });

    it("allows a worker batch to outlive the longest upstream model request", () => {
        expect(maxDuration).toBeGreaterThanOrEqual(40 * 60);
    });

    it("refuses to run without a configured worker token", async () => {
        mocks.configured.mockReturnValue(false);
        const response = await POST(request());
        expect(response.status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("requires worker authentication", async () => {
        mocks.authorized.mockReturnValue(false);
        const response = await POST(request());
        expect(response.status).toBe(401);
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it("passes the stable worker identity and server-only origins to the recovery batch", async () => {
        mocks.recover.mockResolvedValue({ claimed: 2 });
        mocks.nextDueAt.mockResolvedValue(5_000);
        const response = await POST(request("worker-one"));

        expect(response.status).toBe(200);
        expect(mocks.recover).toHaveBeenCalledWith({ origin: "http://internal:3000", publicOrigin: "https://vozeb.example", limit: 50, workerId: "worker-one" });
        expect(await response.json()).toMatchObject({ code: 0, data: { claimed: 2, nextDueAt: 5_000 } });
    });

    it("waits quietly before the database is initialized", async () => {
        mocks.install.mockResolvedValue({ database: { schemaReady: false } });

        const response = await POST(request("worker-one"));

        expect(response.status).toBe(200);
        expect(mocks.recover).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { claimed: 0 } });
    });
});

function request(workerId = "") {
    return new Request("http://localhost/api/maintenance/generation-tasks/run", {
        method: "POST",
        headers: {
            authorization: "Bearer test-token",
            ...(workerId ? { "x-vozeb-pro-worker-id": workerId } : {}),
        },
    });
}
