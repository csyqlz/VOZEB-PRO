import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: { id: "user-one" },
    stored: null as { id: string; userId: string; status: string; version: number } | null,
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => mocks.user) }));
vi.mock("@/lib/server/vozeb-cms/workflow-store", () => ({ getVozebCmsWorkflowRun: vi.fn(async () => mocks.stored) }));
vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: vi.fn(async () => null) }));

import { GET } from "./route";

describe("VOZEBCMS workflow run route", () => {
    it("returns a waiting run without advancing it from the read route", async () => {
        mocks.stored = { id: "run-one", userId: "user-one", status: "waiting", version: 3 };
        const response = await GET(new Request("http://localhost/api/vozeb-cms/workflows/runs/run-one"), { params: Promise.resolve({ runId: "run-one" }) });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ data: { run: { status: "waiting" } } });
    });

    it("does not mutate a terminal run while reading it", async () => {
        mocks.stored = { id: "run-two", userId: "user-one", status: "completed", version: 5 };
        const response = await GET(new Request("http://localhost/api/vozeb-cms/workflows/runs/run-two"), { params: Promise.resolve({ runId: "run-two" }) });
        expect(response.status).toBe(200);
    });
});
