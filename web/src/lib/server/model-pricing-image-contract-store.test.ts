import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { initializePostgresSchema, postgresQuery } from "./database";
import type { ImagePriceContract } from "./model-pricing-image-contract";
import { getImagePriceContractsByIds, listImagePriceContracts, saveImagePriceContract } from "./model-pricing-image-contract-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
for (const provider of ["file", "postgres"] as const)
    describe.skipIf(provider === "postgres" && process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION !== "1")(`image contract history on ${provider}`, () => {
        let directory: string;
        let contract: ImagePriceContract;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-image-contract-"));
            process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
            process.env.VOZEB_PRO_DATA_DIR = directory;
            contract = {
                officialVersionId: randomUUID(),
                channelId: "channel",
                requestedModel: "image",
                reportedModel: "image-v1",
                modelIdentity: "reviewed-request",
                protocol: "openai-images",
                operation: "generations",
                scope: "global-standard-direct-image-tokens",
                region: "global",
                itemMeters: { input: ["inputTextTokens", "inputImageTokens"], output: ["outputImageTokens"] },
                zeroMeters: ["outputTextTokens"],
                holdEstimate: { meterQuantities: { inputTextTokens: "1000", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-estimate", evidence: "fixture reviewed estimate" },
                evidence: "Fixture channel",
                reviewedBy: "admin",
                reviewedAt: new Date().toISOString(),
            };
            if (provider === "postgres") {
                await initializePostgresSchema();
                await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, now(), $3::jsonb)", [contract.officialVersionId, "fixture", JSON.stringify({ id: contract.officialVersionId })]);
            } else await writeJsonDataFile("model-pricing.json", { ...EMPTY_PRICING_STATE, officialVersions: [{ id: contract.officialVersionId }] });
        });
        afterEach(async () => {
            if (provider === "postgres") {
                await postgresQuery("DELETE FROM model_image_price_contracts WHERE official_version_id = $1", [contract.officialVersionId]);
                await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [contract.officialVersionId]);
            }
            if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
            else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
            if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
            else process.env.VOZEB_PRO_DATA_DIR = original.directory;
            await rm(directory, { force: true, recursive: true });
        });
        const list = () => listImagePriceContracts(contract.officialVersionId, contract.channelId, contract.requestedModel, "generations");
        it("keeps immutable evidence and one winner for both first and later concurrent reviews", async () => {
            await expect(saveImagePriceContract({ ...contract, officialVersionId: randomUUID() }, null)).rejects.toThrow("官方价版本已变化");
            const creation = await Promise.allSettled([saveImagePriceContract(contract, null), saveImagePriceContract({ ...contract, evidence: "alternative" }, null)]);
            expect(creation.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(creation.filter((item) => item.status === "rejected")).toHaveLength(1);
            const first = (await list())[0];
            const update = await Promise.allSettled([saveImagePriceContract({ ...contract, evidence: "second review" }, first.id), saveImagePriceContract({ ...contract, evidence: "other second review" }, first.id)]);
            expect(update.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(update.filter((item) => item.status === "rejected")).toHaveLength(1);
            const history = await list();
            expect(history).toHaveLength(2);
            expect(history.filter((item) => item.current)).toHaveLength(1);
            expect(history.find((item) => item.id === first.id)).toEqual({ ...first, current: false });
            expect(await getImagePriceContractsByIds([first.id, history[0].id])).toEqual(expect.arrayContaining(history));
            expect(history[0].holdEstimate).toEqual(contract.holdEstimate);
            await expect(saveImagePriceContract(contract, first.id)).rejects.toThrow("刷新");
        });
        it("isolates generation/edit, channel, requested model and official version identities", async () => {
            await saveImagePriceContract(contract, null);
            const edit = await saveImagePriceContract({ ...contract, operation: "edits" }, null);
            await saveImagePriceContract({ ...contract, channelId: "other" }, null);
            await saveImagePriceContract({ ...contract, requestedModel: "other" }, null);
            expect(await list()).toHaveLength(1);
            expect(await listImagePriceContracts(contract.officialVersionId, contract.channelId, contract.requestedModel, "edits")).toEqual([edit]);
            expect(await listImagePriceContracts("other", contract.channelId, contract.requestedModel, "generations")).toEqual([]);
        });
        it("round trips independently reviewed image limits without overwriting historical evidence", async () => {
            const unit = { ...contract, scope: "global-standard-dataeyes-flux-image" as const, itemMeters: {}, zeroMeters: [], imageLimit: { maxImages: 1 as const, sourceUrl: "https://example.com/first", evidence: "first count proof" } };
            const first = await saveImagePriceContract(unit, null);
            const second = await saveImagePriceContract({ ...unit, imageLimit: { ...unit.imageLimit, sourceUrl: "https://example.com/next", evidence: "next count proof" } }, first.id);
            expect(await list()).toEqual([second, { ...first, current: false }]);
            await expect(saveImagePriceContract(unit, first.id)).rejects.toThrow("刷新");
        });
    });
