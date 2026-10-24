import { beforeEach, describe, expect, it, vi } from "vitest";
import { PricingConflictError } from "@/lib/model-pricing";
const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), review: vi.fn(), audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-task-review-service", () => ({ getPricingTaskReview: mocks.get, reviewPricingTask: mocks.review }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn((_request, user) => ({ id: user.id })), safeRecordAuditLog: mocks.audit }));
import { GET, POST } from "./route";
const request = (body?: unknown) => new Request("https://app.example/api/admin/generation-operations/text/task-one/billing-review", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
describe.each(["text", "image", "video", "audio"])("admin pricing task review (%s)", (type) => {
    const context = { params: Promise.resolve({ type, id: "task-one" }) };
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["generation.manage", "billing.manage"] });
    });
    it("requires a session and both independent responsibilities for reads and writes", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await GET(request(), context)).status).toBe(401);
        for (const adminPermissions of [["generation.manage"], ["billing.manage"], []]) {
            mocks.user.mockResolvedValue({ id: "restricted", role: "admin", status: "active", adminPermissions });
            expect((await GET(request(), context)).status).toBe(403);
            expect((await POST(request({ action: "resume_billing" }), context)).status).toBe(403);
        }
        expect(mocks.get).not.toHaveBeenCalled();
        expect(mocks.review).not.toHaveBeenCalled();
    });
    it("keeps reads private and audits the session actor without evidence or response bodies", async () => {
        mocks.get.mockResolvedValue({ attemptNo: 2, pending: true });
        const read = await GET(request(), context);
        expect(read.headers.get("cache-control")).toBe("private, no-store");
        const body = { action: "provide_metered_result", attemptNo: 2, reviewedBy: "spoofed", evidence: "sensitive supplier proof", response: "private supplier response" };
        mocks.review.mockResolvedValue({ executionPhase: "completed", reviewId: "review-one" });
        expect((await POST(request(body), context)).status).toBe(200);
        expect(mocks.review).toHaveBeenCalledWith("task-one", body, "admin", type, expect.any(String));
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "admin" }, target: { type: `${type}_task`, id: "task-one" }, metadata: { executionPhase: "completed", reviewId: "review-one" } }));
        expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/sensitive supplier proof|private supplier response|spoofed/);
    });
    it("maps stale decisions to conflict and records a redacted failure audit", async () => {
        mocks.review.mockRejectedValue(new PricingConflictError("任务尝试已变化"));
        const result = await POST(request({ action: "confirm_no_charge", attemptNo: 1 }), context);
        expect(result.status).toBe(409);
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ status: "failure", metadata: { errorType: expect.any(String) } }));
    });
});
