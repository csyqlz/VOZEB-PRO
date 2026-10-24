import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), options: vi.fn(), history: vi.fn(), review: vi.fn(), audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-token-contract-service", () => ({ getFlatTextPriceContractOptions: mocks.options, getFlatTextPriceContractHistory: mocks.history, reviewFlatTextPriceContract: mocks.review }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { GET, POST } from "./route";

const url = "http://localhost/api/admin/model-pricing/token-contracts";
const request = (body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("admin reviewed text price contract API", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["billing.manage"] });
        mocks.history.mockResolvedValue({ version: { id: "approved" }, contracts: [] });
        mocks.options.mockResolvedValue({ version: { id: "approved" }, bindings: [], protocolMeters: {} });
        mocks.review.mockResolvedValue({ id: "contract-v1", officialVersionId: "approved", channelId: "channel", requestedModel: "upstream" });
    });

    it("requires billing permission and an optimistic current version", async () => {
        expect((await GET(new Request(`${url}?officialVersionId=approved`))).status).toBe(200);
        expect(mocks.options).toHaveBeenCalledWith("approved", undefined);
        expect((await GET(new Request(`${url}?officialVersionId=approved&logicalModelId=upstream`))).status).toBe(200);
        expect(mocks.options).toHaveBeenCalledWith("approved", "upstream");
        expect((await GET(new Request(`${url}?officialVersionId=approved&channelId=channel&requestedModel=upstream`))).status).toBe(200);
        expect(mocks.history).toHaveBeenCalledWith("approved", "channel", "upstream");
        expect((await POST(request({ officialVersionId: "approved", expectedCurrentId: null, contract: { channelId: "channel" } }))).status).toBe(200);
        expect(mocks.review).toHaveBeenCalledWith("approved", { channelId: "channel" }, null, "admin", undefined);
        expect((await POST(request({ officialVersionId: "approved", logicalModelId: "upstream", expectedCurrentId: null, contract: { channelId: "channel" } }))).status).toBe(200);
        expect(mocks.review).toHaveBeenCalledWith("approved", { channelId: "channel" }, null, "admin", "upstream");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.flat-text-contract-review" }));
        expect((await POST(request({ officialVersionId: "approved", contract: {} }))).status).toBe(400);
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        expect((await POST(request({ officialVersionId: "approved", expectedCurrentId: null, contract: {} }))).status).toBe(403);
        mocks.user.mockResolvedValue(null);
        expect((await GET(new Request(url))).status).toBe(401);
    });
});
