import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { initializePostgresSchema, postgresQuery } from "./database";
import { getCurrentModelPriceBinding, listModelPriceBindingHistory, saveModelPriceBinding } from "./model-price-binding-store";
import { readPricingState } from "./model-pricing-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
for (const provider of ["file", "postgres"] as const)
    describe.skipIf(provider === "postgres" && process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION !== "1")(`independent price selection on ${provider}`, () => {
        let directory: string;
        let modelId: string;
        let otherModelId: string;
        let versionIds: string[];
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), "vozeb-price-binding-"));
            process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
            process.env.VOZEB_PRO_DATA_DIR = directory;
            modelId = randomUUID();
            otherModelId = randomUUID();
            versionIds = [randomUUID(), randomUUID()];
            if (provider === "postgres") {
                await initializePostgresSchema();
                for (const id of versionIds) await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, '', now(), $2::jsonb)", [id, JSON.stringify({ id, logicalModelId: "" })]);
            } else await writeJsonDataFile("model-pricing.json", { ...EMPTY_PRICING_STATE, officialVersions: versionIds.map((id) => ({ id, logicalModelId: "" })) });
        });
        afterEach(async () => {
            if (provider === "postgres") {
                await postgresQuery("DELETE FROM model_price_bindings WHERE logical_model_id = ANY($1::text[])", [[modelId, otherModelId]]);
                await postgresQuery("DELETE FROM model_official_price_versions WHERE id = ANY($1::text[])", [versionIds]);
            }
            if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
            else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
            if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
            else process.env.VOZEB_PRO_DATA_DIR = original.directory;
            await rm(directory, { recursive: true, force: true });
        });

        it("keeps one current revision, immutable history and a revocation tombstone without copying prices", async () => {
            const base = {
                logicalModelId: modelId,
                capability: "text" as const,
                operation: "generation" as const,
                processingMode: "standard" as const,
                scope: "text:generation:standard",
                status: "active" as const,
                evidence: "Reviewed SKU",
                reviewedBy: "admin",
            };
            await expect(saveModelPriceBinding({ ...base, officialVersionId: randomUUID() }, null)).rejects.toThrow("官方价版本已变化");
            const first = await saveModelPriceBinding({ ...base, officialVersionId: versionIds[0] }, null);
            await expect(saveModelPriceBinding({ ...base, officialVersionId: randomUUID() }, first.revision)).rejects.toThrow("官方价版本已变化");
            expect(await getCurrentModelPriceBinding(modelId, base.scope)).toEqual(first);
            const competing = await Promise.allSettled([
                saveModelPriceBinding({ ...base, officialVersionId: versionIds[1], evidence: "new evidence" }, first.revision),
                saveModelPriceBinding({ ...base, officialVersionId: versionIds[0], evidence: "other evidence" }, first.revision),
            ]);
            expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
            const second = await getCurrentModelPriceBinding(modelId, base.scope);
            expect(second?.id).not.toBe(first.id);
            expect(versionIds).toContain(second?.officialVersionId);
            await expect(saveModelPriceBinding({ ...base, officialVersionId: versionIds[0] }, first.revision)).rejects.toThrow("刷新");
            const revoked = await saveModelPriceBinding({ ...base, status: "revoked", officialVersionId: null, evidence: "retired" }, second!.revision);
            expect(await getCurrentModelPriceBinding(modelId, base.scope)).toEqual(revoked);
            expect((await listModelPriceBindingHistory(modelId, base.scope, 1)).map((item) => item.id)).toEqual([revoked.id, second!.id, first.id]);
            expect(await listModelPriceBindingHistory(modelId, "image:generations:standard", 1)).toEqual([]);
            if (provider === "file") {
                const state = await readPricingState();
                expect(state.officialVersions.map((price) => price.id)).toEqual(versionIds);
                expect(state.priceBindings).toHaveLength(3);
                expect(state.priceBindings?.filter((item) => item.current)).toEqual([revoked]);
            } else {
                const rows = await postgresQuery<{ current: boolean; official_version_id: string | null }>("SELECT current, official_version_id FROM model_price_bindings WHERE logical_model_id = $1 ORDER BY reviewed_at, id", [modelId]);
                expect(rows.rows).toHaveLength(3);
                expect(rows.rows.filter((row) => row.current)).toHaveLength(1);
                expect((await postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_official_price_versions WHERE id = ANY($1::text[])", [versionIds])).rows[0]?.count).toBe("2");
            }
        });

        it("shares one official price between models while revoking only the selected model", async () => {
            const input = {
                capability: "text" as const,
                operation: "generation" as const,
                processingMode: "standard" as const,
                scope: "text:generation:standard",
                officialVersionId: versionIds[0],
                status: "active" as const,
                evidence: "same reviewed SKU",
                reviewedBy: "admin",
            };
            const first = await saveModelPriceBinding({ ...input, logicalModelId: modelId }, null);
            const other = await saveModelPriceBinding({ ...input, logicalModelId: otherModelId }, null);
            expect(first.officialVersionId).toBe(other.officialVersionId);
            await saveModelPriceBinding({ ...input, logicalModelId: modelId, officialVersionId: null, status: "revoked", evidence: "model retired" }, first.revision);
            expect(await getCurrentModelPriceBinding(modelId, input.scope)).toMatchObject({ status: "revoked", officialVersionId: null });
            expect(await getCurrentModelPriceBinding(otherModelId, input.scope)).toEqual(other);
        });

        it("isolates generation and edit selections on one image model", async () => {
            const base = { logicalModelId: modelId, capability: "image" as const, processingMode: "standard" as const, status: "active" as const, evidence: "reviewed operation", reviewedBy: "admin" };
            const generation = await saveModelPriceBinding({ ...base, operation: "generations", scope: "image:generations:standard", officialVersionId: versionIds[0] }, null);
            const edit = await saveModelPriceBinding({ ...base, operation: "edits", scope: "image:edits:standard", officialVersionId: versionIds[1] }, null);
            await saveModelPriceBinding({ ...base, operation: "generations", scope: generation.scope, status: "revoked", officialVersionId: null }, generation.revision);
            expect(await getCurrentModelPriceBinding(modelId, generation.scope)).toMatchObject({ status: "revoked" });
            expect(await getCurrentModelPriceBinding(modelId, edit.scope)).toEqual(edit);
            await expect(saveModelPriceBinding({ ...base, operation: "edits", scope: generation.scope, officialVersionId: versionIds[1] }, edit.revision)).rejects.toThrow("范围与能力");
            await expect(saveModelPriceBinding({ ...base, operation: "edits", scope: edit.scope, officialVersionId: null }, edit.revision)).rejects.toThrow("绑定状态");
        });
    });
