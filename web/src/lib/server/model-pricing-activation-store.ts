import { PricingConflictError, type ModelPricingActivation } from "@/lib/model-pricing";
import { ensurePostgresSchema, postgresQuery, withPostgresTransaction } from "./database";
import { mutatePricingState, pricingUsesPostgres, readPricingState } from "./model-pricing-store";

export const activationKey = (modelId: string, scope?: string) => (scope ? JSON.stringify([modelId, scope]) : modelId);

export async function getModelPricingActivation(modelId: string, scope?: string): Promise<ModelPricingActivation | undefined> {
    const key = activationKey(modelId, scope);
    if (!pricingUsesPostgres()) return (await readPricingState()).billingActivations?.[key];
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: ModelPricingActivation | null }>("SELECT billing_activations -> $1::text AS data FROM model_pricing_state WHERE id = 'default'", [key]);
    return result.rows[0]?.data || undefined;
}

export async function getModelPricingActivations(modelIds: string[]): Promise<Map<string, ModelPricingActivation>> {
    const activations = new Map<string, ModelPricingActivation>();
    if (!modelIds.length) return activations;
    if (!pricingUsesPostgres()) {
        const stored = (await readPricingState()).billingActivations || {};
        for (const modelId of modelIds) if (stored[modelId]) activations.set(modelId, stored[modelId]);
        return activations;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ key: string; data: ModelPricingActivation }>(
        "SELECT ids.model_id AS key, s.billing_activations -> ids.model_id AS data FROM model_pricing_state s CROSS JOIN unnest($1::text[]) AS ids(model_id) WHERE s.id = 'default' AND s.billing_activations ? ids.model_id",
        [modelIds],
    );
    for (const row of result.rows) activations.set(row.key, row.data);
    return activations;
}

export async function saveModelPricingActivation(next: ModelPricingActivation, expectedRevision: string | null) {
    const key = activationKey(next.modelId, next.scope);
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const previous = state.billingActivations?.[key];
            if ((previous?.revision || null) !== expectedRevision) throw new PricingConflictError("计费启用状态已变化，请刷新后重新核对");
            return { next: { ...state, billingActivations: { ...state.billingActivations, [key]: next } }, result: next };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const current = await client.query<{ data: ModelPricingActivation | null }>("SELECT billing_activations -> $1::text AS data FROM model_pricing_state WHERE id = 'default' FOR UPDATE", [key]);
        if ((current.rows[0]?.data?.revision || null) !== expectedRevision) throw new PricingConflictError("计费启用状态已变化，请刷新后重新核对");
        await client.query("UPDATE model_pricing_state SET billing_activations = jsonb_set(billing_activations, ARRAY[$1::text], $2::jsonb, true), updated_at = now() WHERE id = 'default'", [key, JSON.stringify(next)]);
        return next;
    });
}
