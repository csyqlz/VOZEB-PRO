import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), review: vi.fn(), mark: vi.fn(), unmark: vi.fn(), audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-ai-review", () => ({
    PriceReviewError: class PriceReviewError extends Error {
        constructor(
            message: string,
            readonly status = 422,
        ) {
            super(message);
        }
    },
    reviewOfficialPrices: mocks.review,
    markByteDanceSeedRetired: mocks.mark,
    unmarkByteDanceSeedRetired: mocks.unmark,
}));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { PATCH, POST } from "./route";

const request = (method: "POST" | "PATCH", body: unknown) => new Request("http://localhost/api/admin/model-pricing/ai-review", { method, headers: { "content-type": "application/json", cookie: "session=test" }, body: JSON.stringify(body) });
const admin = (permissions: string[]) => ({ id: "admin", role: "admin", status: "active", adminPermissions: permissions });

describe("model price AI review route", () => {
    afterEach(() => vi.unstubAllEnvs());
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        mocks.review.mockResolvedValue({ findings: [] });
        mocks.mark.mockResolvedValue({ logicalModelId: "ByteDance-Seedream-4.5" });
    });

    it("requires upstream management permission for review and lifecycle changes", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await POST(request("POST", {}))).status).toBe(401);
        expect((await PATCH(request("PATCH", { action: "mark" }))).status).toBe(401);
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await POST(request("POST", {}))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "mark" }))).status).toBe(403);
        expect(mocks.review).not.toHaveBeenCalled();
        expect(mocks.mark).not.toHaveBeenCalled();
    });

    it("passes only review excerpts and server controlled context to the service", async () => {
        vi.stubEnv("VOZEB_PRO_INTERNAL_ORIGIN", "http://127.0.0.1:3000");
        const response = await POST(request("POST", { requestId: "0d8798e2-c4ef-4bfc-b55a-82ee8ea7ce22", manufacturer: "OpenAI", sourceText: "官网价目", sourceUrl: "https://example.com/forged" }));
        expect(response.status).toBe(200);
        expect(mocks.review).toHaveBeenCalledWith({
            origin: "http://127.0.0.1:3000",
            cookie: "session=test",
            userId: "admin",
            requestId: "0d8798e2-c4ef-4bfc-b55a-82ee8ea7ce22",
            manufacturer: "OpenAI",
            sourceUrl: "https://example.com/forged",
            sourceText: "官网价目",
            retirementText: undefined,
        });
    });

    it("streams real review stages and a terminal result", async () => {
        mocks.review.mockImplementation(async ({ onProgress, onPartial }: { onProgress: (progress: unknown) => void; onPartial: (result: unknown) => void }) => {
            onProgress({ stage: "source", status: "active", detail: "读取官网价目" });
            onProgress({ stage: "source", status: "done", detail: "官网正文已读取" });
            onPartial({ findings: [{ officialModelId: "seedream-4-5-251128" }] });
            return { findings: [] };
        });
        const response = await POST(
            new Request("http://localhost/api/admin/model-pricing/ai-review", {
                method: "POST",
                headers: { "content-type": "application/json", accept: "text/event-stream" },
                body: JSON.stringify({ manufacturer: "OpenAI", sourceUrl: "https://example.com" }),
            }),
        );
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        const body = await response.text();
        expect(body).toContain('event: progress\ndata: {"stage":"source","status":"active"');
        expect(body).toContain('event: progress\ndata: {"stage":"source","status":"done"');
        expect(body).toContain('event: partial\ndata: {"findings":[{"officialModelId":"seedream-4-5-251128"}]}');
        expect(body).toContain('event: result\ndata: {"findings":[]}');
    });

    it("keeps the connection alive while the model is still working", async () => {
        vi.useFakeTimers();
        try {
            mocks.review.mockImplementation(({ onProgress }: { onProgress: (progress: unknown) => void }) => {
                onProgress({ stage: "model", status: "active", detail: "调用模型" });
                return new Promise(() => undefined);
            });
            const response = await POST(new Request("http://localhost/api/admin/model-pricing/ai-review", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: "{}" }));
            const reader = response.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: progress\ndata: {"stage":"model"');
            await vi.advanceTimersByTimeAsync(15_000);
            expect(new TextDecoder().decode((await reader.read()).value)).toContain(": heartbeat");
            await reader.cancel();
        } finally {
            vi.useRealTimers();
        }
    });

    it("audits confirmed lifecycle marks and unmarks", async () => {
        expect(
            (
                await PATCH(
                    request("PATCH", {
                        action: "mark",
                        logicalModelId: "ByteDance-Seedream-4.5",
                        officialModelId: "seedream-4-5-251128",
                        evidence: "已停用",
                        evidenceMode: "admin-excerpt",
                        deactivationDate: "2026-01-01",
                        observedAt: "2026-09-30T00:00:00Z",
                    }),
                )
            ).status,
        ).toBe(200);
        expect(mocks.mark).toHaveBeenCalledWith(expect.objectContaining({ actorId: "admin", evidenceMode: "admin-excerpt" }));
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.lifecycle-mark" }));
        expect((await PATCH(request("PATCH", { action: "unmark", logicalModelId: "ByteDance-Seedream-4.5" }))).status).toBe(200);
        expect(mocks.unmark).toHaveBeenCalledWith("ByteDance-Seedream-4.5");
    });
});
