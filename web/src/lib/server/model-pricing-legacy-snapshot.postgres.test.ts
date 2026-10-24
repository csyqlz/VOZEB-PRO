import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { initializePostgresSchema, postgresQuery } from "./database";
import { getModelPricingActivations } from "./model-pricing-activation-store";
import { getCurrentSalesVersion } from "./model-pricing-store";

describe.skipIf(process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION !== "1")("legacy pricing snapshot on PostgreSQL", () => {
    it("reads 24 legacy sale references and 21 model approvals without rewriting a frozen task", async () => {
        const originalProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = "postgres";
        await initializePostgresSchema();
        const nonce = randomUUID();
        const models = Array.from({ length: 24 }, (_, index) => `${nonce}-model-${index}`);
        const versions = models.map(() => randomUUID());
        const saleId = randomUUID();
        const userId = randomUUID();
        const taskId = randomUUID();
        const requestId = randomUUID();
        const sale = { id: saleId, priceVersionIds: Object.fromEntries(models.map((model, index) => [model, versions[index]])), selectedPriceBindings: [] };
        const approvals = Object.fromEntries(
            models.slice(0, 21).map((model, index) => [model, { modelId: model, enabled: true, revision: randomUUID(), officialVersionId: versions[index], salesVersionId: saleId, bindings: { "channel/sku": { fingerprint: "reviewed" } } }]),
        );
        const frozen = { modelId: models[0], usageKind: "image", frozen: { version: { id: versions[0] }, policy: { id: saleId }, contractId: "legacy-contract" }, preparation: { taskId } };
        const original = await postgresQuery<{ current_sales_version_id: string | null; billing_activations: unknown }>("SELECT current_sales_version_id, billing_activations FROM model_pricing_state WHERE id = 'default'");
        try {
            for (const [index, id] of versions.entries())
                await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, now(), $3::jsonb)", [id, models[index], JSON.stringify({ id, logicalModelId: models[index], sku: `sku-${index}` })]);
            await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, now(), $2::jsonb)", [saleId, JSON.stringify(sale)]);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1, billing_activations = $2::jsonb WHERE id = 'default'", [saleId, JSON.stringify(approvals)]);
            await postgresQuery("INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $1, 'fixture', 'fixture')", [userId]);
            await postgresQuery("INSERT INTO generation_tasks (id, user_id, task_type, status, expires_at) VALUES ($1, $2, 'image', 'running', now() + interval '1 hour')", [taskId, userId]);
            await postgresQuery("INSERT INTO model_pricing_wallet_reservations (user_id, request_id, status, data) VALUES ($1, $2, 'reserved', $3::jsonb)", [userId, requestId, JSON.stringify(frozen)]);

            expect((await getCurrentSalesVersion())?.priceVersionIds).toEqual(sale.priceVersionIds);
            expect((await getModelPricingActivations(models)).size).toBe(21);
            const stored = await postgresQuery<{ data: typeof frozen }>("SELECT data FROM model_pricing_wallet_reservations WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
            expect(stored.rows[0]?.data).toEqual(frozen);
            expect((await postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_price_bindings WHERE logical_model_id = ANY($1::text[])", [models])).rows[0]?.count).toBe("0");
        } finally {
            await postgresQuery("DELETE FROM model_pricing_wallet_reservations WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
            await postgresQuery("DELETE FROM generation_tasks WHERE id = $1", [taskId]);
            await postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1, billing_activations = $2::jsonb WHERE id = 'default'", [
                original.rows[0]?.current_sales_version_id || null,
                JSON.stringify(original.rows[0]?.billing_activations || {}),
            ]);
            await postgresQuery("DELETE FROM model_sales_price_versions WHERE id = $1", [saleId]);
            await postgresQuery("DELETE FROM model_official_price_versions WHERE id = ANY($1::text[])", [versions]);
            if (originalProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
            else process.env.VOZEB_PRO_DATABASE_PROVIDER = originalProvider;
        }
    });
});
