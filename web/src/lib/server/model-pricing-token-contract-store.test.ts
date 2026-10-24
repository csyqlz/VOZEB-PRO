import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { listCurrentFlatTextPriceContracts, listFlatTextPriceContracts, saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import type { FlatTextPriceContract } from "./model-pricing-token-contract";

let directory: string;
const previousProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;
const previousDirectory = process.env.VOZEB_PRO_DATA_DIR;
const contract: FlatTextPriceContract = {
    officialVersionId: "approved-price",
    channelId: "channel",
    protocol: "openai-responses",
    requestedModel: "model",
    reportedModel: "model-v1",
    scope: "global-standard-text-flat",
    region: "global",
    serviceTier: "default",
    itemMeters: { input: ["inputTokens", "cachedInputTokens", "cacheWriteTokens"], output: ["outputTokens"] },
    evidence: "管理员已核对官网分项和真实渠道响应",
    reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://example.com/text-estimate", evidence: "管理员已核对预留估算样本" },
    reviewedAt: "2026-10-02T10:00:00Z",
    reviewedBy: "admin",
};

describe("flat text price contract file history", () => {
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-price-contract-"));
        process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
        process.env.VOZEB_PRO_DATA_DIR = directory;
        await writeJsonDataFile("model-pricing.json", { ...EMPTY_PRICING_STATE, officialVersions: [{ id: contract.officialVersionId }] });
    });
    afterEach(async () => {
        if (previousProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = previousProvider;
        if (previousDirectory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
    });

    it("keeps immutable history and rejects a stale concurrent review", async () => {
        await expect(saveFlatTextPriceContract({ ...contract, officialVersionId: "missing-price" }, null)).rejects.toThrow("官方价版本已变化");
        const first = await saveFlatTextPriceContract(contract, null);
        const next = { ...contract, reportedModel: "model-v2", reviewedAt: "2026-10-02T11:00:00Z" };
        const results = await Promise.allSettled([saveFlatTextPriceContract(next, first.id), saveFlatTextPriceContract({ ...next, reportedModel: "model-v3" }, first.id)]);
        expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
        const history = await listFlatTextPriceContracts(contract.officialVersionId, contract.channelId, contract.requestedModel);
        expect(history).toHaveLength(2);
        expect(history[0].current).toBe(true);
        expect(history[0].reservationEstimate).toEqual(contract.reservationEstimate);
        expect(history[1]).toMatchObject({ id: first.id, current: false, reportedModel: "model-v1" });
        expect((await listCurrentFlatTextPriceContracts([contract.officialVersionId])).map((item) => item.id)).toEqual([history[0].id]);
        expect(await listCurrentFlatTextPriceContracts(["another-version"])).toEqual([]);
        expect(JSON.parse(await readFile(join(directory, "model-pricing-token-contracts.json"), "utf8")).contracts).toHaveLength(2);
        expect(await listFlatTextPriceContracts("another-version", contract.channelId, contract.requestedModel)).toEqual([]);
    });
});
