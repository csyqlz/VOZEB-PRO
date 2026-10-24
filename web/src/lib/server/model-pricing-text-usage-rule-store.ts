import { randomUUID } from "node:crypto";
import { PricingConflictError, PricingInputError, type TextUsageRule } from "@/lib/model-pricing";
import { ensurePostgresSchema, postgresQuery, withPostgresTransaction } from "./database";
import { mutatePricingState, PRICING_PAGE_SIZE, pricingUsesPostgres, readPricingState } from "./model-pricing-store";

const key = (modelId: string, officialVersionId: string) => `${modelId}/${officialVersionId}`;

export async function listTextUsageRules(modelId: string, officialVersionId: string): Promise<TextUsageRule[]> {
    if (!pricingUsesPostgres()) return ((await readPricingState()).textUsageRules?.[key(modelId, officialVersionId)] || []).slice(-PRICING_PAGE_SIZE).reverse();
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: TextUsageRule }>("SELECT data FROM model_text_usage_rules WHERE model_id = $1 AND official_version_id = $2 ORDER BY current DESC, reviewed_at DESC, id DESC LIMIT $3", [
        modelId,
        officialVersionId,
        PRICING_PAGE_SIZE,
    ]);
    return result.rows.map((row) => row.data);
}

export async function getTextUsageRuleById(id: string): Promise<TextUsageRule | undefined> {
    if (!id) return undefined;
    if (!pricingUsesPostgres())
        return Object.values((await readPricingState()).textUsageRules || {})
            .flat()
            .find((rule) => rule.id === id);
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: TextUsageRule }>("SELECT data FROM model_text_usage_rules WHERE id = $1", [id]);
    return result.rows[0]?.data;
}

export async function getLatestTextUsageRule(modelId: string, officialVersionId: string): Promise<TextUsageRule | undefined> {
    return (await listTextUsageRules(modelId, officialVersionId))[0];
}

export async function getCurrentTextUsageRules(officialVersionIds: string[]): Promise<Map<string, TextUsageRule>> {
    const rules = new Map<string, TextUsageRule>();
    if (!officialVersionIds.length) return rules;
    if (!pricingUsesPostgres()) {
        const wanted = new Set(officialVersionIds);
        for (const group of Object.values((await readPricingState()).textUsageRules || {})) {
            const rule = group.at(-1);
            if (rule && wanted.has(rule.officialVersionId)) rules.set(`${rule.modelId}/${rule.officialVersionId}`, rule);
        }
        return rules;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: TextUsageRule }>("SELECT data FROM model_text_usage_rules WHERE current AND official_version_id = ANY($1::text[])", [officialVersionIds]);
    for (const row of result.rows) rules.set(`${row.data.modelId}/${row.data.officialVersionId}`, row.data);
    return rules;
}

export async function getTextUsageRulesByIds(ids: string[]): Promise<Map<string, TextUsageRule>> {
    const rules = new Map<string, TextUsageRule>();
    if (!ids.length) return rules;
    if (!pricingUsesPostgres()) {
        const wanted = new Set(ids);
        for (const group of Object.values((await readPricingState()).textUsageRules || {})) for (const rule of group) if (wanted.has(rule.id)) rules.set(rule.id, rule);
        return rules;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: TextUsageRule }>("SELECT data FROM model_text_usage_rules WHERE id = ANY($1::text[])", [ids]);
    for (const row of result.rows) rules.set(row.data.id, row.data);
    return rules;
}

export async function reviewTextUsageRule(input: {
    modelId: string;
    officialVersionId: string;
    cacheReadMissingAsZero: boolean;
    cacheWriteMissingAsZero: boolean;
    evidence: string;
    expectedCurrentId: string | null;
    actorId: string;
}): Promise<TextUsageRule> {
    if (!input.modelId || !input.officialVersionId || typeof input.cacheReadMissingAsZero !== "boolean" || typeof input.cacheWriteMissingAsZero !== "boolean" || !input.actorId || typeof input.evidence !== "string" || !input.evidence.trim())
        throw new PricingInputError("请核对缓存缺失规则、适用模型和依据");
    const rule: TextUsageRule = {
        id: randomUUID(),
        modelId: input.modelId,
        officialVersionId: input.officialVersionId,
        cacheReadMissingAsZero: input.cacheReadMissingAsZero,
        cacheWriteMissingAsZero: input.cacheWriteMissingAsZero,
        evidence: input.evidence.trim(),
        reviewedAt: new Date().toISOString(),
        reviewedBy: input.actorId,
    };
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            if (!state.officialVersions.some((price) => price.id === input.officialVersionId)) throw new PricingConflictError("官方价版本已变化，请刷新后重新核对");
            const current = state.textUsageRules?.[key(input.modelId, input.officialVersionId)] || [];
            if ((current.at(-1)?.id || null) !== input.expectedCurrentId) throw new PricingConflictError("缓存缺失规则已变化，请刷新后重新核对");
            return { next: { ...state, textUsageRules: { ...state.textUsageRules, [key(input.modelId, input.officialVersionId)]: [...current, rule] } }, result: rule };
        });
    await ensurePostgresSchema();
    try {
        return await withPostgresTransaction(async (client) => {
            const price = await client.query("SELECT id FROM model_official_price_versions WHERE id = $1 FOR KEY SHARE", [input.officialVersionId]);
            if (!price.rows.length) throw new PricingConflictError("官方价版本已变化，请刷新后重新核对");
            const current = await client.query<{ id: string }>("SELECT id FROM model_text_usage_rules WHERE model_id = $1 AND official_version_id = $2 AND current FOR UPDATE", [input.modelId, input.officialVersionId]);
            if ((current.rows[0]?.id || null) !== input.expectedCurrentId) throw new PricingConflictError("缓存缺失规则已变化，请刷新后重新核对");
            if (current.rows[0]) await client.query("UPDATE model_text_usage_rules SET current = false WHERE id = $1", [current.rows[0].id]);
            await client.query("INSERT INTO model_text_usage_rules (id, model_id, official_version_id, reviewed_at, current, data) VALUES ($1, $2, $3, $4::timestamptz, true, $5::jsonb)", [
                rule.id,
                rule.modelId,
                rule.officialVersionId,
                rule.reviewedAt,
                JSON.stringify(rule),
            ]);
            return rule;
        });
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new PricingConflictError("缓存缺失规则已变化，请刷新后重新核对");
        throw error;
    }
}
