import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { initializePostgresSchema, postgresQuery } from "./database";
import { getLatestTextUsageRule, getTextUsageRuleById, listTextUsageRules, reviewTextUsageRule } from "./model-pricing-text-usage-rule-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
for (const provider of ["file", "postgres"] as const)
    describe.skipIf(provider === "postgres" && process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION !== "1")(`text usage rule history on ${provider}`, () => {
        let directory: string;
        let modelId: string;
        let officialVersionId: string;
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-text-rules-"));
            modelId = `text-${randomUUID()}`;
            officialVersionId = randomUUID();
            process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
            process.env.VOZEB_PRO_DATA_DIR = directory;
            if (provider === "postgres") {
                await initializePostgresSchema();
                await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, now(), $3::jsonb)", [officialVersionId, modelId, JSON.stringify({ id: officialVersionId })]);
            } else await writeJsonDataFile("model-pricing.json", { ...EMPTY_PRICING_STATE, officialVersions: [{ id: officialVersionId }] });
        });
        afterEach(async () => {
            if (provider === "postgres") {
                await postgresQuery("DELETE FROM model_text_usage_rules WHERE official_version_id = $1", [officialVersionId]);
                await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [officialVersionId]);
            }
            if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
            else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
            if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
            else process.env.VOZEB_PRO_DATA_DIR = original.directory;
            await rm(directory, { recursive: true, force: true });
        });

        it("keeps one winner for concurrent reviews and preserves frozen prior versions", async () => {
            const input = { modelId, officialVersionId, cacheReadMissingAsZero: true, cacheWriteMissingAsZero: false, evidence: "verified fixture", expectedCurrentId: null, actorId: "admin" };
            await expect(reviewTextUsageRule({ ...input, officialVersionId: randomUUID() })).rejects.toThrow("官方价版本已变化");
            const first = await Promise.allSettled([reviewTextUsageRule(input), reviewTextUsageRule({ ...input, evidence: "alternative fixture" })]);
            expect(first.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(first.filter((item) => item.status === "rejected")).toHaveLength(1);
            const current = await getLatestTextUsageRule(modelId, officialVersionId);
            expect(current).toMatchObject({ cacheReadMissingAsZero: true, cacheWriteMissingAsZero: false });
            const second = await reviewTextUsageRule({ ...input, expectedCurrentId: current!.id, cacheWriteMissingAsZero: true });
            expect(await getTextUsageRuleById(current!.id)).toEqual(current);
            expect(await listTextUsageRules(modelId, officialVersionId)).toEqual([second, current]);
            await expect(reviewTextUsageRule({ ...input, expectedCurrentId: current!.id })).rejects.toThrow("刷新");
            expect(await getLatestTextUsageRule("another-model", officialVersionId)).toBeUndefined();
        });
    });
