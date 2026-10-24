import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { initializePostgresSchema, postgresQuery } from "./database";
import type { HailuoPriceContract } from "./model-pricing-hailuo-contract";
import type { VideoPriceContract } from "./model-pricing-video-contract";
import { listVideoPriceContracts, saveVideoPriceContract } from "./model-pricing-video-contract-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
for (const provider of ["file", "postgres"] as const)
    describe.skipIf(provider === "postgres" && process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION !== "1")(`video contract history on ${provider}`, () => {
        let directory: string;
        let contract: VideoPriceContract;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-video-contract-"));
            process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
            process.env.VOZEB_PRO_DATA_DIR = directory;
            contract = {
                officialVersionId: randomUUID(),
                channelId: "channel",
                requestedModel: "MiniMax-H3",
                protocol: "minimax-video-v2",
                scope: "global-standard-minimax-h3-generation",
                resolutionItems: { "768P": { inputSeconds: "input768", outputSeconds: "output768" }, "2K": { inputSeconds: "input2k", outputSeconds: "output2k" } },
                inputImageItem: "images",
                inputImagePricing: "all-at-standard-rate",
                inputAudioItem: "inputAudioSeconds",
                evidence: "Fixture video contract",
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
                await postgresQuery("DELETE FROM model_video_price_contracts WHERE official_version_id = $1", [contract.officialVersionId]);
                await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [contract.officialVersionId]);
            }
            if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
            else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
            if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
            else process.env.VOZEB_PRO_DATA_DIR = original.directory;
            await rm(directory, { force: true, recursive: true });
        });
        const list = () => listVideoPriceContracts(contract.officialVersionId, contract.channelId, contract.requestedModel);
        it("keeps immutable evidence and one winner for both first and later concurrent reviews", async () => {
            await expect(saveVideoPriceContract({ ...contract, officialVersionId: randomUUID() }, null)).rejects.toThrow("官方价版本已变化");
            const creation = await Promise.allSettled([saveVideoPriceContract(contract, null), saveVideoPriceContract({ ...contract, evidence: "alternative" }, null)]);
            expect(creation.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(creation.filter((item) => item.status === "rejected")).toHaveLength(1);
            const first = (await list())[0];
            const update = await Promise.allSettled([saveVideoPriceContract({ ...contract, evidence: "second review" }, first.id), saveVideoPriceContract({ ...contract, evidence: "other second review" }, first.id)]);
            expect(update.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(update.filter((item) => item.status === "rejected")).toHaveLength(1);
            const history = await list();
            expect(history).toHaveLength(2);
            expect(history.filter((item) => item.current)).toHaveLength(1);
            expect(history.find((item) => item.id === first.id)).toEqual({ ...first, current: false });
            await expect(saveVideoPriceContract(contract, first.id)).rejects.toThrow("刷新");
        });
        it("isolates channel, requested model and official version identities", async () => {
            await saveVideoPriceContract(contract, null);
            await saveVideoPriceContract({ ...contract, channelId: "other" }, null);
            await saveVideoPriceContract({ ...contract, requestedModel: "MiniMax-H3-Max" }, null);
            expect(await list()).toHaveLength(1);
            expect(await listVideoPriceContracts("other", contract.channelId, contract.requestedModel)).toEqual([]);
        });
        it("preserves each reviewed price mapping and normal charging rule on replacement", async () => {
            const first = await saveVideoPriceContract(contract, null);
            const next = await saveVideoPriceContract({ ...contract, evidence: "new proof", resolutionItems: { ...contract.resolutionItems, "768P": { inputSeconds: "new-input", outputSeconds: "new-output" } } }, first.id);
            expect(await list()).toEqual([next, { ...first, current: false }]);
            expect(next).toMatchObject({ inputImagePricing: "all-at-standard-rate", inputAudioItem: "inputAudioSeconds" });
            await expect(saveVideoPriceContract(contract, first.id)).rejects.toThrow("刷新");
        });
        it.each(["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"] as const)("persists %s independent tiers with concurrent version protection", async (requestedModel) => {
            const hailuo: HailuoPriceContract = {
                officialVersionId: contract.officialVersionId,
                channelId: contract.channelId,
                requestedModel,
                protocol: "minimax-hailuo-v1",
                scope: "global-standard-minimax-hailuo-generation",
                tierItems: { "768P-6": "small", "768P-10": "long", "1080P-6": "large" },
                evidence: "V1 original file proof",
                reviewedBy: "admin",
                reviewedAt: contract.reviewedAt,
            };
            const creation = await Promise.allSettled([saveVideoPriceContract(hailuo, null), saveVideoPriceContract({ ...hailuo, evidence: "alternative" }, null)]);
            expect(creation.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(creation.filter((item) => item.status === "rejected")).toHaveLength(1);
            const first = (await listVideoPriceContracts(hailuo.officialVersionId, hailuo.channelId, requestedModel))[0];
            expect(first).toMatchObject({ protocol: "minimax-hailuo-v1", tierItems: hailuo.tierItems });
            expect(first).not.toHaveProperty("resolutionItems");
            const next = await saveVideoPriceContract({ ...hailuo, evidence: "second", tierItems: { ...hailuo.tierItems, "768P-6": "new-small" } }, first.id);
            expect(await listVideoPriceContracts(hailuo.officialVersionId, hailuo.channelId, requestedModel)).toEqual([next, { ...first, current: false }]);
            await expect(saveVideoPriceContract(hailuo, first.id)).rejects.toThrow("刷新");
            await saveVideoPriceContract(contract, null);
            expect(await list()).toHaveLength(1);
            expect(await listVideoPriceContracts(hailuo.officialVersionId, "other", requestedModel)).toEqual([]);
        });
    });
