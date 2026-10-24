import { randomUUID } from "node:crypto";

import { modelPriceBindingScope, PricingConflictError, PricingInputError, type ModelPriceBinding } from "@/lib/model-pricing";

import { ensurePostgresSchema, postgresQuery, withPostgresTransaction } from "./database";
import { mutatePricingState, pricingUsesPostgres, PRICING_PAGE_SIZE, readPricingState } from "./model-pricing-store";

export async function getCurrentModelPriceBinding(logicalModelId: string, scope: string): Promise<ModelPriceBinding | undefined> {
    if (!pricingUsesPostgres()) return (await readPricingState()).priceBindings?.find((item) => item.logicalModelId === logicalModelId && item.scope === scope && item.current);
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: ModelPriceBinding }>("SELECT data FROM model_price_bindings WHERE logical_model_id = $1 AND scope = $2 AND current", [logicalModelId, scope]);
    return result.rows[0]?.data;
}

export async function getCurrentModelPriceBindings(logicalModelIds: string[], scope: string): Promise<ModelPriceBinding[]> {
    if (!logicalModelIds.length) return [];
    if (!pricingUsesPostgres()) {
        const wanted = new Set(logicalModelIds);
        return (await readPricingState()).priceBindings?.filter((item) => wanted.has(item.logicalModelId) && item.scope === scope && item.current) || [];
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: ModelPriceBinding }>("SELECT data FROM model_price_bindings WHERE logical_model_id = ANY($1::text[]) AND scope = $2 AND current", [logicalModelIds, scope]);
    return result.rows.map((row) => row.data);
}

export async function listModelPriceBindingHistory(logicalModelId: string, scope: string, page: number): Promise<ModelPriceBinding[]> {
    if (!logicalModelId || !scope || !Number.isSafeInteger(page) || page < 1) return [];
    const offset = (page - 1) * PRICING_PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) return [];
    if (!pricingUsesPostgres())
        return (
            (await readPricingState()).priceBindings
                ?.filter((item) => item.logicalModelId === logicalModelId && item.scope === scope)
                .reverse()
                .slice(offset, offset + PRICING_PAGE_SIZE) || []
        );
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: ModelPriceBinding }>("SELECT data FROM model_price_bindings WHERE logical_model_id = $1 AND scope = $2 ORDER BY revision_order DESC LIMIT $3 OFFSET $4", [logicalModelId, scope, PRICING_PAGE_SIZE, offset]);
    return result.rows.map((row) => row.data);
}

export async function saveModelPriceBinding(
    input: Pick<ModelPriceBinding, "logicalModelId" | "capability" | "operation" | "processingMode" | "scope" | "officialVersionId" | "status" | "evidence" | "reviewedBy">,
    expectedRevision: string | null,
): Promise<ModelPriceBinding> {
    if (input.scope !== modelPriceBindingScope(input.capability, input.operation, input.processingMode)) throw new PricingInputError("选价范围与能力、操作或处理档位不一致");
    if (!input.logicalModelId.trim() || !input.reviewedBy.trim() || !input.evidence.trim() || !["active", "revoked"].includes(input.status) || (input.status === "active") !== Boolean(input.officialVersionId))
        throw new PricingInputError("选价绑定状态、价版本或审核依据无效");
    const binding: ModelPriceBinding = { ...input, id: randomUUID(), revision: randomUUID(), current: true, reviewedAt: new Date().toISOString() };
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const previous = state.priceBindings?.find((item) => item.logicalModelId === input.logicalModelId && item.scope === input.scope && item.current);
            if ((previous?.revision || null) !== expectedRevision) throw new PricingConflictError("选价绑定已变化，请刷新后重试");
            if (input.officialVersionId && !state.officialVersions.some((price) => price.id === input.officialVersionId)) throw new PricingConflictError("官方价版本已变化，请刷新后重新核对");
            const priceBindings = [...(state.priceBindings || []).map((item) => (item.id === previous?.id ? { ...item, current: false } : item)), binding];
            return { next: { ...state, priceBindings }, result: binding };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", [input.logicalModelId, input.scope]);
        const previous = await client.query<{ id: string; revision: string }>("SELECT id, revision FROM model_price_bindings WHERE logical_model_id = $1 AND scope = $2 AND current", [input.logicalModelId, input.scope]);
        if ((previous.rows[0]?.revision || null) !== expectedRevision) throw new PricingConflictError("选价绑定已变化，请刷新后重试");
        if (input.officialVersionId && !(await client.query("SELECT 1 FROM model_official_price_versions WHERE id = $1 FOR KEY SHARE", [input.officialVersionId])).rowCount) throw new PricingConflictError("官方价版本已变化，请刷新后重新核对");
        if (previous.rows[0]) {
            await client.query("UPDATE model_price_bindings SET current = false, data = jsonb_set(data, '{current}', 'false'::jsonb) WHERE id = $1", [previous.rows[0].id]);
        }
        await client.query("INSERT INTO model_price_bindings (id, logical_model_id, scope, official_version_id, revision, status, current, reviewed_at, data) VALUES ($1, $2, $3, $4, $5, $6, true, $7::timestamptz, $8::jsonb)", [
            binding.id,
            binding.logicalModelId,
            binding.scope,
            binding.officialVersionId,
            binding.revision,
            binding.status,
            binding.reviewedAt,
            JSON.stringify(binding),
        ]);
        return binding;
    });
}
