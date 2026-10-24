import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ links: vi.fn(), versions: vi.fn(), pending: vi.fn(), active: vi.fn(), insert: vi.fn(), get: vi.fn(), bind: vi.fn(), invalidate: vi.fn(), remove: vi.fn(), amend: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("./model-pricing-store", () => ({ listOfficialPriceReviewLinks: mocks.links, listPriceReviewVersions: mocks.versions, listPriceReviewCandidates: mocks.pending }));
vi.mock("./model-pricing-observation-store", () => ({
    insertOfficialPriceObservation: mocks.insert,
    appendOfficialPriceObservationAmendment: mocks.amend,
    getOfficialPriceObservation: mocks.get,
    setOfficialPriceObservationLink: mocks.bind,
    invalidateOfficialPriceObservation: mocks.invalidate,
    deletePendingOfficialPriceObservation: mocks.remove,
    listActiveObservationModelIds: mocks.active,
    listOfficialPriceObservations: vi.fn(),
    reviewOfficialPriceObservation: vi.fn(),
}));

import { amendOfficialPriceObservationEvidence, bindOfficialPriceObservation, invalidateOfficialPriceObservationEvidence, saveOfficialPriceObservation } from "./model-pricing-observation-service";

const manufacturer = "ByteDance / Volcengine";
const sourceUrl = "https://docs.byteplus.com/en/docs/ModelArk/1544106";
const evidence = "seedream-5-0-pro-260628 output 0.05 USD / image";
const input = {
    manufacturer,
    officialModelId: "seedream-5-0-pro-260628",
    sourceUrl,
    sourceDigest: "a".repeat(64),
    sourceMode: "website",
    observedAt: "2026-10-01T00:00:00Z",
    evidence,
    sourceRowIds: ["t1r2"],
    conditions: "标准图片",
    items: [{ key: "output", unit: "image", per: "1", price: "0.05", currency: "USD" }],
};

describe("independent official price observation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.links.mockResolvedValue([{ url: sourceUrl }]);
        mocks.insert.mockImplementation(async (value) => value);
        mocks.versions.mockResolvedValue([]);
        mocks.pending.mockResolvedValue([]);
        mocks.active.mockResolvedValue([]);
        mocks.settings.mockResolvedValue({ logicalModels: [{ id: "ByteDance-Seedream-5.0-pro", manufacturer, bindings: [] }] });
        mocks.get.mockResolvedValue({ ...input, id: "b".repeat(64), reviewStatus: "confirmed" });
        mocks.amend.mockImplementation(async (_id, value) => value);
    });

    it("archives price evidence without a platform logical model and produces a stable identity", async () => {
        const first = await saveOfficialPriceObservation(input, "admin");
        const second = await saveOfficialPriceObservation(input, "admin");
        expect(first).toMatchObject({ officialModelId: input.officialModelId, items: input.items, reviewStatus: "pending" });
        expect(first).not.toHaveProperty("logicalModelId");
        expect(first.id).toBe(second.id);
    });

    it("keeps a model-only discovery when official price items are incomplete", async () => {
        const result = await saveOfficialPriceObservation({ ...input, items: [], conditions: "", extractionIssue: "AI 未提取可校验的价格分项" }, "admin");
        expect(result.items).toEqual([]);
        expect(result.conditions).toBe("");
        expect(result.extractionIssue).toContain("未提取");
    });

    it("archives verified price items with missing conditions without making an importable candidate", async () => {
        const result = await saveOfficialPriceObservation({ ...input, conditions: "" }, "admin");
        expect(result.items).toEqual(input.items);
        expect(result.conditions).toBe("");
    });

    it("retains sourced AI suggestions without turning missing candidate fields into defaults", async () => {
        const result = await saveOfficialPriceObservation({ ...input, suggestedSeries: "Seedream", suggestedVersion: "Seedream 5", suggestedTier: "paid", headerEvidence: "USD / image" }, "admin");
        expect(result).toMatchObject({ suggestedSeries: "Seedream", suggestedVersion: "Seedream 5", suggestedTier: "paid", headerEvidence: "USD / image" });
        expect(result).not.toHaveProperty("tier");
        expect(result).not.toHaveProperty("officialVersion");
    });

    it("archives separate price variants for one discovered model without merging their item rates", async () => {
        const secondEvidence = `${input.officialModelId} batch output 0.02 USD / image`;
        const result = await saveOfficialPriceObservation(
            {
                ...input,
                evidence: `${evidence}\n${secondEvidence}`,
                priceVariants: [
                    { evidence, conditions: "Standard", items: input.items },
                    { evidence: secondEvidence, conditions: "Batch", items: [{ ...input.items[0], price: "0.02" }] },
                ],
            },
            "admin",
        );
        expect(result.priceVariants?.map((variant) => variant.items[0].price)).toEqual(["0.05", "0.02"]);
        await expect(saveOfficialPriceObservation({ ...input, evidence: `${evidence}\n${secondEvidence}`, priceVariants: [{ evidence, conditions: "Batch", items: [{ ...input.items[0], price: "0.02" }] }] }, "admin")).rejects.toThrow(
            "档位证据未包含全部价格",
        );
    });

    it("checks only the selected vendor before saving a new discovery", async () => {
        await saveOfficialPriceObservation({ ...input, newOnly: true }, "admin");
        expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ officialModelId: input.officialModelId }), true);
        mocks.active.mockResolvedValue([input.officialModelId]);
        await expect(saveOfficialPriceObservation({ ...input, newOnly: true }, "admin")).rejects.toThrow("已存在或已归档");
        mocks.active.mockResolvedValue([]);
        mocks.settings.mockResolvedValue({ logicalModels: [{ id: input.officialModelId, manufacturer: "OpenAI", bindings: [] }] });
        await saveOfficialPriceObservation({ ...input, newOnly: true }, "admin");
    });

    it("rejects invented prices and unrelated source links", async () => {
        await expect(saveOfficialPriceObservation({ ...input, items: [{ ...input.items[0], price: "9.99" }] }, "admin")).rejects.toThrow("全部价格");
        mocks.links.mockResolvedValue([]);
        await expect(saveOfficialPriceObservation(input, "admin")).rejects.toThrow("不属于该厂商");
    });

    it("only binds a discovered model to a logical model of the same manufacturer", async () => {
        await bindOfficialPriceObservation("b".repeat(64), "ByteDance-Seedream-5.0-pro", "admin");
        expect(mocks.bind).toHaveBeenCalledWith("b".repeat(64), "ByteDance-Seedream-5.0-pro", "admin");
        mocks.settings.mockResolvedValue({ logicalModels: [{ id: "other", manufacturer: "OpenAI" }] });
        await expect(bindOfficialPriceObservation("b".repeat(64), "other", "admin")).rejects.toThrow("厂商");
    });

    it("rejects standard-to-Fast binding and allows audited confirmation invalidation", async () => {
        mocks.get.mockResolvedValue({ ...input, officialModelId: "dreamina-seedance-2-0-260128", id: "b".repeat(64), reviewStatus: "confirmed" });
        mocks.settings.mockResolvedValue({ logicalModels: [{ id: "ByteDance-Seedance-2.0-Fast", manufacturer }] });
        await expect(bindOfficialPriceObservation("b".repeat(64), "ByteDance-Seedance-2.0-Fast", "admin")).rejects.toThrow("型号");
        await invalidateOfficialPriceObservationEvidence("b".repeat(64), "测试性确认，价格提取不完整", "admin");
        expect(mocks.invalidate).toHaveBeenCalledWith("b".repeat(64), "测试性确认，价格提取不完整", "admin");
    });

    it("rejects a Seedance 2.5 discovery bound to the existing Seedance 2.0 model", async () => {
        mocks.get.mockResolvedValue({ ...input, officialModelId: "dreamina-seedance-2-5-260628", id: "b".repeat(64), reviewStatus: "confirmed" });
        mocks.settings.mockResolvedValue({ logicalModels: [{ id: "doubao-seedance-2-0-260128", manufacturer }] });
        await expect(bindOfficialPriceObservation("b".repeat(64), "doubao-seedance-2-0-260128", "admin")).rejects.toThrow("版本");
        expect(mocks.bind).not.toHaveBeenCalled();
    });

    it("allows a sourced edit before confirmation and rejects unsourced or confirmed edits", async () => {
        mocks.get.mockResolvedValue({ ...input, id: "b".repeat(64), reviewStatus: "pending" });
        const draft = { variantIndex: 0, items: [{ ...input.items[0], condition: "标准图片" }], itemEvidence: [evidence], conditions: "标准图片", reason: "补齐官网条件", expectedRevision: 0 };
        await amendOfficialPriceObservationEvidence("b".repeat(64), draft, "admin");
        expect(mocks.amend).toHaveBeenCalledWith("b".repeat(64), expect.objectContaining({ reason: "补齐官网条件", items: draft.items }), 0);
        await expect(amendOfficialPriceObservationEvidence("b".repeat(64), { ...draft, items: [{ ...draft.items[0], price: "9.99" }] }, "admin")).rejects.toThrow("缺少对应官网原文");
        mocks.get.mockResolvedValue({ ...input, id: "b".repeat(64), reviewStatus: "confirmed" });
        await expect(amendOfficialPriceObservationEvidence("b".repeat(64), draft, "admin")).rejects.toThrow("仅可修订待确认");
        expect(mocks.amend).toHaveBeenCalledTimes(1);
    });
});
