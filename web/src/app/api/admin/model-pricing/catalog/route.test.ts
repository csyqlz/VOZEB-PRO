import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), impact: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-catalog-service", () => ({
    getOfficialPriceCatalog: mocks.list,
    getOfficialPriceCatalogImpact: mocks.impact,
    createOfficialPriceCatalog: mocks.create,
    editOfficialPriceCatalog: mocks.edit,
    removeOfficialPriceCatalog: mocks.remove,
}));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { GET, POST, PATCH, DELETE } from "./route";

const admin = (permissions: string[]) => ({ id: "admin", role: "admin", status: "active", adminPermissions: permissions });
const post = (body: unknown) => new Request("http://localhost/api/admin/model-pricing/catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const request = (method: "PATCH" | "DELETE", body: unknown) => new Request("http://localhost/api/admin/model-pricing/catalog", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue(admin(["upstream.manage"]));
    mocks.list.mockResolvedValue([]);
    mocks.impact.mockResolvedValue({ pending: 1, approved: 0, called: false, childVersions: 0 });
    mocks.create.mockResolvedValue({ id: "entry", manufacturer: "OpenAI", kind: "series" });
    mocks.edit.mockResolvedValue({ id: "entry", manufacturer: "OpenAI", kind: "series" });
});

it("allows billing administrators to read catalog names but not change catalog entries", async () => {
    mocks.user.mockResolvedValue(admin(["billing.manage"]));
    expect((await GET(new Request("http://localhost/api/admin/model-pricing/catalog?manufacturer=OpenAI"))).status).toBe(200);
    expect((await POST(post({ manufacturer: "OpenAI", kind: "series" }))).status).toBe(403);
    expect((await PATCH(request("PATCH", { id: "entry" }))).status).toBe(403);
    expect((await DELETE(request("DELETE", { id: "entry" }))).status).toBe(403);
    expect(mocks.list).toHaveBeenCalledWith("OpenAI");
    expect(mocks.create).not.toHaveBeenCalled();
});

it("audits catalog edits and deletions separately", async () => {
    const input = { id: "entry", manufacturer: "OpenAI", kind: "series", expected: { id: "entry" } };
    expect((await PATCH(request("PATCH", input))).status).toBe(200);
    expect(mocks.edit).toHaveBeenCalledWith(input, "admin");
    expect((await DELETE(request("DELETE", input))).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(input);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.catalog-update" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.catalog-delete" }));
});

it("creates only an independent catalog entry and audits it", async () => {
    const input = { manufacturer: "OpenAI", kind: "series", name: "GPT", capability: "text", sourceUrl: "https://example.com/pricing", evidence: "官网" };
    expect((await GET(new Request("http://localhost/api/admin/model-pricing/catalog?manufacturer=OpenAI"))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("OpenAI");
    expect((await POST(post(input))).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(input, "admin");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.catalog-create", target: { type: "official_price_catalog", id: "entry" } }));
});

it("returns a read-only reference preview for a selected catalog item", async () => {
    const response = await GET(new Request("http://localhost/api/admin/model-pricing/catalog?manufacturer=OpenAI&impactId=version"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ pending: 1, approved: 0 });
    expect(mocks.impact).toHaveBeenCalledWith("OpenAI", "version");
});
