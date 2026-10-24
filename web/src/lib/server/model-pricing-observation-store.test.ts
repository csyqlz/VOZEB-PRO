import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PricingState, OfficialPriceObservation } from "@/lib/model-pricing";

const mocks = vi.hoisted(() => ({ state: { candidates: [], officialVersions: [], salesVersions: [] } as PricingState }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: () => "file" }));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: async () => mocks.state,
    withJsonDataFileLock: async (_file: string, run: () => Promise<unknown>) => run(),
    writeJsonDataFile: async (_file: string, next: PricingState) => {
        mocks.state = next;
    },
}));

import {
    appendOfficialPriceObservationAmendment,
    deletePendingOfficialPriceObservation,
    getOfficialPriceObservation,
    insertOfficialPriceObservation,
    invalidateOfficialPriceObservation,
    listActiveObservationModelIds,
    listOfficialPriceObservations,
    reviewOfficialPriceObservation,
    setOfficialPriceObservationLink,
} from "./model-pricing-observation-store";

const observation: OfficialPriceObservation = {
    id: "a".repeat(64),
    manufacturer: "ByteDance / Volcengine",
    officialModelId: "seedream-5-0-pro-260628",
    sourceUrl: "https://docs.byteplus.com/en/docs/ModelArk/1544106",
    sourceDigest: "b".repeat(64),
    sourceMode: "website",
    observedAt: "2026-10-01T00:00:00Z",
    evidence: "seedream-5-0-pro-260628 output 0.05 USD / image",
    sourceRowIds: ["t1r2"],
    conditions: "标准图片",
    items: [{ key: "output", unit: "image", per: "1", price: "0.05", currency: "USD" }],
    createdAt: "2026-10-01T00:00:00Z",
    createdBy: "admin",
    reviewStatus: "pending",
};

describe("official price observation file persistence", () => {
    beforeEach(() => {
        mocks.state = { candidates: [], officialVersions: [], salesVersions: [] };
    });
    it("keeps observations separate from price candidates and requires confirmation before linking", async () => {
        await insertOfficialPriceObservation(observation);
        await insertOfficialPriceObservation(observation);
        expect((await listOfficialPriceObservations(1)).total).toBe(1);
        expect(mocks.state.candidates).toEqual([]);
        await expect(setOfficialPriceObservationLink(observation.id, "logical", "admin")).rejects.toThrow("先审核");
        await reviewOfficialPriceObservation(observation.id, "confirmed", "证据一致", "admin");
        await expect(reviewOfficialPriceObservation(observation.id, "rejected", "", "admin")).rejects.toThrow("已审核");
        await setOfficialPriceObservationLink(observation.id, "logical", "admin");
        expect((await listOfficialPriceObservations(1)).links).toMatchObject([{ logicalModelId: "logical" }]);
        await setOfficialPriceObservationLink(observation.id, null, "admin");
        expect((await listOfficialPriceObservations(1)).links).toEqual([]);
        expect((await getOfficialPriceObservation(observation.id))?.reviewStatus).toBe("confirmed");
        expect(mocks.state.candidates).toEqual([]);
    });
    it("invalidates a test confirmation and removes its logical-model link", async () => {
        await insertOfficialPriceObservation(observation);
        await reviewOfficialPriceObservation(observation.id, "confirmed", "测试", "admin");
        await setOfficialPriceObservationLink(observation.id, "logical", "admin");
        await expect(invalidateOfficialPriceObservation(observation.id, "", "admin")).rejects.toThrow("原因");
        const result = await invalidateOfficialPriceObservation(observation.id, "测试确认，价目不完整", "admin");
        expect(result).toMatchObject({ reviewStatus: "rejected", reviewNote: "撤销确认：测试确认，价目不完整" });
        expect((await listOfficialPriceObservations(1)).links).toEqual([]);
        expect((await listOfficialPriceObservations(1, "", "open")).total).toBe(0);
        expect((await listOfficialPriceObservations(1, "", "rejected")).total).toBe(1);
        expect(mocks.state.candidates).toEqual([]);
    });
    it("moves confirmed discoveries out of the pending list and only deletes pending records", async () => {
        await insertOfficialPriceObservation(observation);
        await expect(insertOfficialPriceObservation({ ...observation, id: "d".repeat(64) }, true)).rejects.toThrow("已有发现记录");
        expect(await listActiveObservationModelIds(observation.manufacturer, [observation.officialModelId.toUpperCase()])).toEqual([observation.officialModelId]);
        expect((await listOfficialPriceObservations(1, "", "pending")).total).toBe(1);
        await reviewOfficialPriceObservation(observation.id, "confirmed", "证据一致", "admin");
        expect((await listOfficialPriceObservations(1, "", "pending")).total).toBe(0);
        expect((await listOfficialPriceObservations(1, "", "confirmed")).total).toBe(1);
        await expect(deletePendingOfficialPriceObservation(observation.id)).rejects.toThrow("仅可删除待确认");
        await insertOfficialPriceObservation({ ...observation, id: "c".repeat(64), officialModelId: "seedream-5-0-lite-260628" });
        await deletePendingOfficialPriceObservation("c".repeat(64));
        expect(await getOfficialPriceObservation("c".repeat(64))).toBeNull();
        expect((await listOfficialPriceObservations(1, "", "confirmed")).total).toBe(1);
    });
    it("revisions only pending discoveries and keeps the original snapshot intact", async () => {
        await insertOfficialPriceObservation(observation);
        const amendment = {
            variantIndex: 0,
            items: [{ ...observation.items[0], price: "0.05", condition: "标准图片" }],
            itemEvidence: [observation.evidence],
            conditions: "标准图片",
            reason: "补齐条件",
            editedAt: "2026-10-17T00:00:00Z",
            editedBy: "admin",
        };
        await appendOfficialPriceObservationAmendment(observation.id, amendment, 0);
        await expect(appendOfficialPriceObservationAmendment(observation.id, amendment, 0)).rejects.toThrow("刷新");
        expect(mocks.state.observations?.[0].items[0].condition).toBeUndefined();
        expect((await listOfficialPriceObservations(1)).observations[0].amendments).toMatchObject([{ revision: 1, reason: "补齐条件" }]);
        await expect(reviewOfficialPriceObservation(observation.id, "confirmed", "", "admin", 0)).rejects.toThrow("已修订");
        await reviewOfficialPriceObservation(observation.id, "confirmed", "", "admin", 1);
        await expect(appendOfficialPriceObservationAmendment(observation.id, amendment, 1)).rejects.toThrow("仅可修订待确认");
        expect((await listOfficialPriceObservations(1, "", "confirmed")).observations[0].amendments).toHaveLength(1);
    });
});
