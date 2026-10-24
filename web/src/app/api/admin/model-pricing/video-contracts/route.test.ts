import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), options: vi.fn(), history: vi.fn(), review: vi.fn(), audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-video-contract-service", () => ({ getVideoPriceContractOptions: mocks.options, getVideoPriceContractHistory: mocks.history, reviewVideoPriceContract: mocks.review }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { GET, POST } from "./route";
import { PricingConflictError, PricingInputError } from "@/lib/model-pricing";

const url = "http://localhost/api/admin/model-pricing/video-contracts";
const request = (body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("admin reviewed video price contract API", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["billing.manage"] });
        mocks.history.mockResolvedValue({ version: { id: "approved" }, contracts: [] });
        mocks.options.mockResolvedValue({ version: { id: "approved" }, bindings: [], resolutions: [] });
        mocks.review.mockResolvedValue({ id: "contract-v1", officialVersionId: "approved", channelId: "channel", requestedModel: "upstream" });
    });

    it("requires billing permission and an optimistic current version", async () => {
        expect((await GET(new Request(`${url}?officialVersionId=approved`))).status).toBe(200);
        expect(mocks.options).toHaveBeenCalledWith("approved", undefined);
        expect((await GET(new Request(`${url}?officialVersionId=approved&logicalModelId=logical`))).status).toBe(200);
        expect(mocks.options).toHaveBeenCalledWith("approved", "logical");
        expect((await GET(new Request(`${url}?officialVersionId=approved&channelId=channel&requestedModel=upstream`))).status).toBe(200);
        expect(mocks.history).toHaveBeenCalledWith("approved", "channel", "upstream");
        expect((await POST(request({ officialVersionId: "approved", expectedCurrentId: null, contract: { channelId: "channel" } }))).status).toBe(200);
        expect(mocks.review).toHaveBeenCalledWith("approved", { channelId: "channel" }, null, "admin", undefined);
        expect((await POST(request({ officialVersionId: "approved", logicalModelId: "logical", expectedCurrentId: null, contract: { channelId: "channel" } }))).status).toBe(200);
        expect(mocks.review).toHaveBeenCalledWith("approved", { channelId: "channel" }, null, "admin", "logical");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.video-contract-review" }));
        expect((await POST(request({ officialVersionId: "approved", contract: {} }))).status).toBe(400);
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        expect((await POST(request({ officialVersionId: "approved", expectedCurrentId: null, contract: {} }))).status).toBe(403);
        mocks.user.mockResolvedValue(null);
        expect((await GET(new Request(url))).status).toBe(401);
    });
    it("maps review conflicts and invalid contracts without writing success audit or private evidence", async () => {
        for (const [error, status] of [
            [new PricingConflictError("stale"), 409],
            [new PricingInputError("invalid"), 400],
        ] as const) {
            mocks.review.mockRejectedValueOnce(error);
            const response = await POST(request({ officialVersionId: "approved", expectedCurrentId: "previous", contract: { evidence: "private proof" } }));
            expect(response.status).toBe(status);
            expect(await response.json()).toMatchObject({ code: status, data: null, msg: error.message });
        }
        expect(mocks.audit).not.toHaveBeenCalled();
        await POST(request({ officialVersionId: "approved", expectedCurrentId: null, contract: { evidence: "private proof", reviewedBy: "forged" } }));
        expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/private proof|forged/);
    });
    it("rejects malformed JSON and non-object bodies at the HTTP boundary", async () => {
        for (const value of [null, [], true]) expect((await POST(request(value))).status).toBe(400);
        const response = await POST(new Request(url, { method: "POST", body: "{invalid" }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 400, data: null });
        expect(mocks.review).not.toHaveBeenCalled();
        expect(mocks.audit).not.toHaveBeenCalled();
    });
});
