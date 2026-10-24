import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextPriceScheduleError, TextPriceSelectionError } from "@/lib/model-pricing";

const mocks = vi.hoisted(() => ({
    user: vi.fn(),
    overview: vi.fn(),
    admission: vi.fn(),
    activationStatus: vi.fn(),
    directedEvidence: vi.fn(),
    revalue: vi.fn(),
    activate: vi.fn(),
    references: vi.fn(),
    structureReferences: vi.fn(),
    reviewLinks: vi.fn(),
    sources: vi.fn(),
    candidate: vi.fn(),
    editCandidate: vi.fn(),
    deleteCandidate: vi.fn(),
    review: vi.fn(),
    link: vi.fn(),
    selected: vi.fn(),
    selectionOptions: vi.fn(),
    selectionHistory: vi.fn(),
    selectionPreview: vi.fn(),
    select: vi.fn(),
    revokeSelection: vi.fn(),
    preview: vi.fn(),
    publish: vi.fn(),
    unbind: vi.fn(),
    exchangeRate: vi.fn(),
    officialSource: vi.fn(),
    audit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-admission", () => ({ getModelPricingAdmission: mocks.admission }));
vi.mock("@/lib/server/model-pricing-activation-service", () => ({ getModelPricingActivationStatus: mocks.activationStatus, setModelPricingActivation: mocks.activate }));
vi.mock("@/lib/server/model-price-binding-service", () => ({
    getCurrentModelPriceSelection: mocks.selected,
    listModelPriceBindingHistory: mocks.selectionHistory,
    previewSelectedOfficialPrice: mocks.selectionPreview,
    bindSelectedOfficialPrice: mocks.select,
    revokeSelectedOfficialPrice: mocks.revokeSelection,
}));
vi.mock("@/lib/server/model-pricing-shadow-evidence", () => ({ getDirectedPricingEvidence: mocks.directedEvidence, getModelPricingSampleUsage: vi.fn(), revalueSavedImageEvidence: mocks.revalue }));
vi.mock("@/lib/server/model-pricing-service", () => ({
    getModelPricingOverview: mocks.overview,
    getIndependentOfficialPriceOptions: mocks.selectionOptions,
    getOfficialPriceReferences: mocks.references,
    getOfficialPriceStructureReferences: mocks.structureReferences,
    getOfficialPriceReviewLinks: mocks.reviewLinks,
    getOfficialPriceSources: mocks.sources,
    createOfficialPriceCandidate: mocks.candidate,
    editOfficialPriceCandidate: mocks.editCandidate,
    removeOfficialPriceCandidate: mocks.deleteCandidate,
    reviewOfficialPriceCandidate: mocks.review,
    linkReviewedOfficialPrice: mocks.link,
    previewSalesPricing: mocks.preview,
    publishSalesPricing: mocks.publish,
    unbindModelSalesPrice: mocks.unbind,
    updateBusinessExchangeRate: mocks.exchangeRate,
    updateOfficialPriceSource: mocks.officialSource,
}));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { GET, PATCH, POST } from "./route";

const request = (method: "POST" | "PATCH", body: unknown) => new Request("http://localhost/api/admin/model-pricing", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const admin = (permissions: string[]) => ({ id: "admin", role: "admin", status: "active", adminPermissions: permissions });
const defaultWorkbenchFilter = { enabled: undefined, manufacturer: undefined, capability: undefined, name: undefined, status: undefined };

describe("model pricing admin authorization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue(admin(["upstream.manage", "billing.manage"]));
        mocks.selectionOptions.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
        mocks.overview.mockResolvedValue({ candidates: [], officialVersions: [], salesVersions: [] });
        mocks.admission.mockResolvedValue({ modelId: "flash", structuralComplete: false, blockers: ["缺少售价"], billingMode: "fixed-points" });
        mocks.activationStatus.mockResolvedValue({ admission: { modelId: "flash" }, activation: null, active: false });
        mocks.activate.mockResolvedValue({ admission: { modelId: "flash" }, activation: { revision: "revision", fingerprint: "fingerprint" }, active: true });
        mocks.directedEvidence.mockResolvedValue({ taskId: "task-1", usageFields: { input_tokens: "1" } });
        mocks.revalue.mockResolvedValue({ revalued: 1, status: { ready: true } });
        mocks.references.mockResolvedValue({ series: ["Gemini 2.5"], versions: ["gemini-2.5-flash"], approved: [], pending: [] });
        mocks.structureReferences.mockResolvedValue([{ id: "reviewed-text" }]);
        mocks.reviewLinks.mockResolvedValue([{ url: "https://ai.google.dev/gemini-api/docs/pricing", label: "当前厂商官网链接" }]);
        mocks.sources.mockResolvedValue([{ manufacturer: "Google", url: "https://ai.google.dev/gemini-api/docs/pricing" }]);
        mocks.candidate.mockResolvedValue({ id: "candidate-one", logicalModelId: "flash" });
        mocks.editCandidate.mockResolvedValue({ id: "candidate-one", revision: "new-revision" });
        mocks.deleteCandidate.mockResolvedValue({ candidateId: "candidate-one", deleted: true });
        mocks.review.mockResolvedValue({ candidateId: "candidate-one", approved: true, versionId: "price-one" });
        mocks.link.mockResolvedValue({ id: "linked-price", logicalModelId: "flash" });
        mocks.selected.mockResolvedValue({ id: "selection-1", revision: "revision-1", status: "active" });
        mocks.selectionHistory.mockResolvedValue([{ id: "selection-1" }]);
        mocks.selectionPreview.mockResolvedValue({ bindingId: "selection-1", previewOnly: true, quote: { points: "700.00" } });
        mocks.select.mockResolvedValue({ id: "selection-1", scope: "text:generation:standard", officialVersionId: "price-one", status: "active" });
        mocks.revokeSelection.mockResolvedValue({ id: "selection-2", scope: "text:generation:standard", officialVersionId: null, status: "revoked" });
        mocks.preview.mockResolvedValue({ quote: { points: "8.00" } });
        mocks.publish.mockResolvedValue({ id: "sales-one" });
        mocks.unbind.mockResolvedValue({ id: "sales-two" });
        mocks.exchangeRate.mockResolvedValue({ cnyPerUsd: "7", observedAt: "2026-09-27T00:00:00Z", evidence: "业务汇率" });
        mocks.officialSource.mockResolvedValue({ manufacturer: "Google", url: "https://ai.google.dev/gemini-api/docs/pricing", updatedAt: "2026-09-27T00:00:00Z" });
    });

    it("limits approved structure references to upstream administrators", async () => {
        const url = "http://localhost/api/admin/model-pricing?action=structure-references&modelId=flash";
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await GET(new Request(url))).status).toBe(403);
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=selection-options&modelId=flash"))).status).toBe(200);
        expect(mocks.structureReferences).not.toHaveBeenCalled();
        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        const response = await GET(new Request(url));
        expect(response.status).toBe(200);
        expect((await response.json()).data).toEqual([{ id: "reviewed-text" }]);
        expect(mocks.structureReferences).toHaveBeenCalledWith("flash", undefined, undefined);
    });

    it("protects and audits reference-based selection independently from live sales publishing", async () => {
        const url = "http://localhost/api/admin/model-pricing?action=selection-binding&modelId=flash&scope=text:generation:standard";
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await GET(new Request(url))).status).toBe(200);
        expect((await PATCH(request("PATCH", { action: "selection-bind", versionId: "price-one", logicalModelId: "flash", operation: "generation", evidence: "review" }))).status).toBe(403);
        expect(mocks.selected).toHaveBeenCalledWith("flash", "text:generation:standard");
        expect(mocks.select).not.toHaveBeenCalled();

        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        expect((await (await GET(new Request(url))).json()).data).toMatchObject({ id: "selection-1" });
        expect(mocks.selected).toHaveBeenCalledWith("flash", "text:generation:standard");
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=selection-options&modelId=flash&page=2&sku=gpt"))).status).toBe(200);
        expect(mocks.selectionOptions).toHaveBeenCalledWith("flash", 2, "gpt");
        expect((await (await GET(new Request("http://localhost/api/admin/model-pricing?action=selection-history&modelId=flash&scope=text:generation:standard&page=2"))).json()).data).toEqual([{ id: "selection-1" }]);
        expect(mocks.selectionHistory).toHaveBeenCalledWith("flash", "text:generation:standard", 2);
        expect((await PATCH(request("PATCH", { action: "selection-bind", versionId: "price-one", logicalModelId: "flash", operation: "generation", evidence: "review", expectedRevision: null }))).status).toBe(200);
        expect(mocks.select).toHaveBeenCalledWith("price-one", "flash", "generation", "review", null, "admin");
        expect((await PATCH(request("PATCH", { action: "selection-revoke", logicalModelId: "flash", scope: "text:generation:standard", evidence: "retired", expectedRevision: "revision-1" }))).status).toBe(200);
        expect(mocks.revokeSelection).toHaveBeenCalledWith("flash", "text:generation:standard", "retired", "revision-1", "admin");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.selection-binding", target: { type: "model_price_binding", id: "selection-2" } }));
        expect(mocks.publish).not.toHaveBeenCalled();
        expect((await POST(request("POST", { action: "selection-preview", modelId: "flash", scope: "text:generation:standard", usage: { inputTokens: "1000000" } }))).status).toBe(403);
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        const preview = await POST(request("POST", { action: "selection-preview", modelId: "flash", scope: "text:generation:standard", usage: { inputTokens: "1000000" }, facts: { inputTotalTokens: 128001 } }));
        expect((await preview.json()).data).toMatchObject({ previewOnly: true, quote: { points: "700.00" } });
        expect(mocks.selectionPreview).toHaveBeenCalledWith("flash", "text:generation:standard", { inputTokens: "1000000" }, { inputTotalTokens: 128001 });
        expect(mocks.publish).not.toHaveBeenCalled();
    });

    it("returns structured Standard tier validation and missing selector facts", async () => {
        mocks.candidate.mockRejectedValueOnce(new TextPriceScheduleError([{ code: "coverage_gap", groupId: "long" }]));
        const candidate = await POST(request("POST", { action: "candidate", price: {} }));
        expect(candidate.status).toBe(400);
        expect((await candidate.json()).data).toEqual({ issues: [{ code: "coverage_gap", groupId: "long" }] });
        mocks.selectionPreview.mockRejectedValueOnce(new TextPriceSelectionError("usage_missing"));
        const preview = await POST(request("POST", { action: "selection-preview", modelId: "flash", scope: "text:generation:standard" }));
        expect(preview.status).toBe(400);
        expect((await preview.json()).data).toEqual({ reason: "usage_missing" });
    });

    it("requires billing permission and audits explicit historical image evidence revaluation", async () => {
        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        expect((await PATCH(request("PATCH", { action: "revalue-image-evidence", modelId: "image", bindingKey: "channel/image" }))).status).toBe(403);
        expect(mocks.revalue).not.toHaveBeenCalled();
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await PATCH(request("PATCH", { action: "revalue-image-evidence", modelId: "image", bindingKey: "channel/image", imageOperation: "edits" }))).status).toBe(200);
        expect(mocks.revalue).toHaveBeenCalledWith("image", "channel/image", "edits");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.image-evidence-revalue", metadata: { modelId: "image", imageOperation: "edits", revalued: 1 } }));
        expect((await PATCH(request("PATCH", { action: "revalue-image-evidence", modelId: "image", bindingKey: "channel/image", imageOperation: "invalid" }))).status).toBe(400);
    });

    it("separates official price review from sales publication", async () => {
        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?modelId=flash&candidatePage=2&officialPage=3"))).status).toBe(200);
        expect(mocks.overview).toHaveBeenCalledWith(
            "flash",
            2,
            3,
            { modelId: undefined, manufacturer: undefined, status: undefined },
            1,
            { manufacturer: undefined, series: undefined, capability: undefined, name: undefined, status: undefined },
            1,
            defaultWorkbenchFilter,
        );
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=admission&modelId=flash"))).status).toBe(200);
        expect(mocks.admission).toHaveBeenCalledWith("flash");
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?candidateModelId=flash&manufacturer=Google&candidateStatus=pending"))).status).toBe(200);
        expect(mocks.overview).toHaveBeenCalledWith(
            undefined,
            1,
            1,
            { modelId: "flash", manufacturer: "Google", status: "pending" },
            1,
            { manufacturer: undefined, series: undefined, capability: undefined, name: undefined, status: undefined },
            1,
            defaultWorkbenchFilter,
        );
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?unpricedPage=2&unpricedManufacturer=Google&unpricedSeries=Gemini&unpricedCapability=text&unpricedName=flash&unpricedStatus=pending-review"))).status).toBe(200);
        expect(mocks.overview).toHaveBeenLastCalledWith(
            undefined,
            1,
            1,
            { modelId: undefined, manufacturer: undefined, status: undefined },
            2,
            { manufacturer: "Google", series: "Gemini", capability: "text", name: "flash", status: "pending-review" },
            1,
            defaultWorkbenchFilter,
        );
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?workbenchPage=2&workbenchStatus=channel-pending"))).status).toBe(200);
        expect(mocks.overview).toHaveBeenLastCalledWith(undefined, 1, 1, { modelId: undefined, manufacturer: undefined, status: undefined }, 1, { manufacturer: undefined, series: undefined, capability: undefined, name: undefined, status: undefined }, 2, {
            ...defaultWorkbenchFilter,
            status: "channel-pending",
        });
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=references&manufacturer=Google&series=Gemini%202.5&officialVersion=gemini-2.5-flash"))).status).toBe(200);
        expect(mocks.references).toHaveBeenCalledWith("Google", "Gemini 2.5", "gemini-2.5-flash");
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=review-links&manufacturer=Google"))).status).toBe(200);
        expect(mocks.reviewLinks).toHaveBeenCalledWith("Google");
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=official-sources"))).status).toBe(200);
        expect(mocks.sources).toHaveBeenCalledOnce();
        expect((await POST(request("POST", { action: "candidate", price: {} }))).status).toBe(200);
        expect((await PATCH(request("PATCH", { action: "review", candidateId: "candidate-one", approved: true }))).status).toBe(200);
        expect((await PATCH(request("PATCH", { action: "price-link", versionId: "price-one", logicalModelId: "flash" }))).status).toBe(200);
        expect(mocks.link).toHaveBeenCalledWith("price-one", "flash", "admin");
        expect((await PATCH(request("PATCH", { action: "candidate-edit", candidateId: "candidate-one", expectedRevision: "old", price: { items: [] } }))).status).toBe(200);
        expect(mocks.editCandidate).toHaveBeenCalledWith("candidate-one", { items: [] }, "old", "admin");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.price-candidate-edit" }));
        expect((await PATCH(request("PATCH", { action: "candidate-delete", candidateId: "candidate-one", expectedRevision: "new-revision" }))).status).toBe(200);
        expect(mocks.deleteCandidate).toHaveBeenCalledWith("candidate-one", "new-revision");
        expect((await PATCH(request("PATCH", { action: "official-source", manufacturer: "Google", url: "https://ai.google.dev/gemini-api/docs/pricing", expectedUpdatedAt: null }))).status).toBe(200);
        expect(mocks.officialSource).toHaveBeenCalledWith("Google", "https://ai.google.dev/gemini-api/docs/pricing", null, "admin", false);
        expect((await PATCH(request("PATCH", { action: "official-source", manufacturer: "Qwen", url: "https://example.com/pricing", create: true }))).status).toBe(200);
        expect(mocks.officialSource).toHaveBeenCalledWith("Qwen", "https://example.com/pricing", null, "admin", true);
        expect((await PATCH(request("PATCH", { action: "publish", policy: {}, previewToken: "x" }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "unbind", modelId: "flash", currentSalesVersionId: "sales-one" }))).status).toBe(403);
        expect(mocks.publish).not.toHaveBeenCalled();
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await POST(request("POST", { action: "candidate", price: {} }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "review", candidateId: "candidate-one", approved: true }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "price-link", versionId: "price-one", logicalModelId: "flash" }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "candidate-edit", candidateId: "candidate-one", expectedRevision: "old", price: {} }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "candidate-delete", candidateId: "candidate-one", expectedRevision: "old" }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { action: "official-source", manufacturer: "Google", url: "https://ai.google.dev/gemini-api/docs/pricing" }))).status).toBe(403);
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=review-links&manufacturer=Google"))).status).toBe(403);
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=official-sources"))).status).toBe(403);
        expect((await POST(request("POST", { action: "preview", policy: {}, modelId: "flash", usage: {} }))).status).toBe(200);
        expect(mocks.preview).toHaveBeenCalledWith({}, "flash", {}, undefined);
        expect((await POST(request("POST", { action: "preview", policy: {}, modelId: "flash", scope: "text:generation:standard", usage: { inputTotalTokens: 128001 } }))).status).toBe(200);
        expect(mocks.preview).toHaveBeenCalledWith({}, "flash", { inputTotalTokens: 128001 }, "text:generation:standard");
        expect((await PATCH(request("PATCH", { action: "publish", policy: {}, previewToken: "x" }))).status).toBe(200);
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.sales-publish" }));
        expect((await PATCH(request("PATCH", { action: "unbind", modelId: "flash", currentSalesVersionId: "sales-one" }))).status).toBe(200);
        expect(mocks.unbind).toHaveBeenCalledWith("flash", "sales-one", "admin", undefined);
        expect((await PATCH(request("PATCH", { action: "unbind", modelId: "flash", scope: "text:generation:standard", currentSalesVersionId: "sales-one" }))).status).toBe(200);
        expect(mocks.unbind).toHaveBeenCalledWith("flash", "sales-one", "admin", "text:generation:standard");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.sales-unbind" }));
        expect((await PATCH(request("PATCH", { action: "exchange-rate", exchangeRate: { cnyPerUsd: "7" }, expectedObservedAt: null }))).status).toBe(200);
        expect(mocks.exchangeRate).toHaveBeenCalledWith({ cnyPerUsd: "7" }, null);
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.exchange-rate-update" }));
    });

    it("rejects unauthenticated access", async () => {
        mocks.user.mockResolvedValue(null);
        expect((await GET(new Request("http://localhost/api/admin/model-pricing"))).status).toBe(401);
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=admission&modelId=flash"))).status).toBe(401);
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=references&manufacturer=Google"))).status).toBe(401);
        expect((await POST(request("POST", { action: "preview", policy: {} }))).status).toBe(401);
        expect(mocks.preview).not.toHaveBeenCalled();
    });

    it("requires billing permission and audits the model-level switch without recording raw evidence", async () => {
        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        expect((await PATCH(request("PATCH", { action: "activation", modelId: "flash", enabled: true, expectedRevision: null }))).status).toBe(403);
        expect(mocks.activate).not.toHaveBeenCalled();
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=activation&modelId=flash"))).status).toBe(200);
        expect((await PATCH(request("PATCH", { action: "activation", modelId: "flash", enabled: true, expectedRevision: null }))).status).toBe(200);
        expect(mocks.activate).toHaveBeenCalledWith({ modelId: "flash", enabled: true, expectedRevision: null, actorId: "admin" });
        expect(mocks.audit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "admin.model-pricing.activation", target: { type: "model_pricing_activation", id: "flash" }, metadata: { enabled: true, scope: null, revision: "revision", fingerprint: "fingerprint", bindingKey: null } }),
        );
    });

    it("passes image operation scope through status and activation with an auditable scope", async () => {
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        mocks.activate.mockResolvedValue({ admission: { modelId: "image" }, activation: { revision: "revision", fingerprint: "fingerprint", scope: "image:edits:standard" }, active: true });
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=activation&modelId=image&imageOperation=edits"))).status).toBe(200);
        expect(mocks.activationStatus).toHaveBeenCalledWith("image", "edits", undefined);
        expect((await PATCH(request("PATCH", { action: "activation", modelId: "image", imageOperation: "edits", enabled: true, expectedRevision: null }))).status).toBe(200);
        expect(mocks.activate).toHaveBeenCalledWith({ modelId: "image", imageOperation: "edits", enabled: true, expectedRevision: null, actorId: "admin" });
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.activation", metadata: expect.objectContaining({ scope: "image:edits:standard" }) }));
        expect((await PATCH(request("PATCH", { action: "activation", modelId: "image", imageOperation: "other", enabled: true, expectedRevision: null }))).status).toBe(400);
    });

    it("passes native audio operation through status and activation", async () => {
        mocks.activate.mockResolvedValue({ admission: { modelId: "audio" }, activation: { revision: "revision", fingerprint: "fingerprint", scope: "audio:chat/completions:standard" }, active: true });
        expect((await GET(new Request("http://localhost/api/admin/model-pricing?action=activation&modelId=audio&audioOperation=chat%2Fcompletions"))).status).toBe(200);
        expect(mocks.activationStatus).toHaveBeenCalledWith("audio", undefined, "chat/completions");
        expect((await PATCH(request("PATCH", { action: "activation", modelId: "audio", audioOperation: "chat/completions", enabled: true, expectedRevision: null }))).status).toBe(200);
        expect(mocks.activate).toHaveBeenCalledWith({ modelId: "audio", audioOperation: "chat/completions", enabled: true, expectedRevision: null, actorId: "admin" });
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-pricing.activation", metadata: expect.objectContaining({ scope: "audio:chat/completions:standard" }) }));
        expect((await PATCH(request("PATCH", { action: "activation", modelId: "audio", audioOperation: "other", enabled: true, expectedRevision: null }))).status).toBe(400);
    });

    it("keeps directed usage evidence private to billing administrators", async () => {
        const url = "http://localhost/api/admin/model-pricing?action=directed-evidence&capability=image&taskId=task-1";
        mocks.user.mockResolvedValue(admin(["upstream.manage"]));
        expect((await GET(new Request(url))).status).toBe(403);
        expect(mocks.directedEvidence).not.toHaveBeenCalled();
        mocks.user.mockResolvedValue(admin(["billing.manage"]));
        expect((await GET(new Request(url))).status).toBe(200);
        expect(mocks.directedEvidence).toHaveBeenCalledWith("admin", "task-1", "image");
    });
});
