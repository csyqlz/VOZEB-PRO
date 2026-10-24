import type { ShadowPriceReceipt } from "../model-pricing-shadow-service";
import type { ShadowCall, ShadowPriceMutationState } from "../model-pricing-shadow-store";
import type { ShadowTextCall } from "../model-pricing-shadow-call";
import type { QueryExecutor } from "./postgres";

export class ModelPricingShadowRepository {
    constructor(private readonly db: QueryExecutor) {}

    async getExactTotal(userId: string) {
        const result = await this.db.query<{ exact_points: string }>("SELECT exact_points FROM model_pricing_shadow_accounts WHERE user_id = $1", [userId]);
        return result.rows[0]?.exact_points || "0";
    }

    async hasReversal(userId: string, requestId: string) {
        const result = await this.db.query("SELECT 1 FROM model_pricing_shadow_receipts WHERE user_id = $1 AND request_id = $2 AND kind = 'reversal'", [userId, requestId]);
        return result.rows.length > 0;
    }

    async listRefundedMediaCalls(limit: number) {
        const result = await this.db.query<{ user_id: string; request_id: string }>(
            `
            SELECT c.user_id, c.request_id FROM model_pricing_shadow_calls c
            JOIN point_records charge ON charge.user_id = c.user_id AND charge.idempotency_key = c.request_id AND charge.type = 'consume'
                AND charge.request_fingerprint = c.data->>'requestFingerprint' AND charge.model = c.logical_model_id
            JOIN point_records refund ON refund.source_record_id = charge.id AND refund.user_id = c.user_id AND refund.type = 'refund'
            WHERE (c.status = 'priced' OR c.data ? 'revaluation') AND ((c.data->>'protocol' = 'openai-images' AND c.data ? 'operation') OR (c.data->>'protocol' IN ('minimax-video-v2', 'minimax-hailuo-v1') AND c.data->>'kind' = 'video') OR (c.data->>'protocol' IN ('gemini-tts', 'openai-chat-audio') AND c.data->>'kind' = 'audio')) AND c.request_id LIKE 'system-ai:%'
                AND NOT EXISTS (SELECT 1 FROM model_pricing_shadow_receipts r WHERE r.user_id = c.user_id AND r.request_id = c.request_id AND r.kind = 'reversal')
            ORDER BY refund.created_at, refund.id LIMIT $1`,
            [limit],
        );
        return result.rows.map((row) => ({ userId: row.user_id, requestId: row.request_id }));
    }

    /** Must run inside the same transaction as append. Locks even a new account. */
    async lockRequest(userId: string, requestId: string): Promise<ShadowPriceMutationState> {
        await this.db.query("INSERT INTO model_pricing_shadow_accounts (user_id, exact_points) VALUES ($1, '0') ON CONFLICT (user_id) DO NOTHING", [userId]);
        const account = await this.db.query<{ exact_points: string }>("SELECT exact_points FROM model_pricing_shadow_accounts WHERE user_id = $1 FOR UPDATE", [userId]);
        const records = await this.db.query<{ data: ShadowPriceReceipt }>("SELECT data FROM model_pricing_shadow_receipts WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
        return { exactPoints: account.rows[0].exact_points, charge: records.rows.find((row) => row.data.kind === "charge")?.data, reversal: records.rows.find((row) => row.data.kind === "reversal")?.data };
    }

    async append(receipt: ShadowPriceReceipt) {
        await this.db.query("INSERT INTO model_pricing_shadow_receipts (user_id, request_id, kind, data) VALUES ($1, $2, $3, $4::jsonb)", [receipt.userId, receipt.requestId, receipt.kind, JSON.stringify(receipt)]);
        await this.db.query("UPDATE model_pricing_shadow_accounts SET exact_points = $2 WHERE user_id = $1", [receipt.userId, receipt.accrual.exactPoints]);
    }

    async getCall<T extends ShadowCall = ShadowTextCall>(userId: string, requestId: string) {
        const result = await this.db.query<{ data: T }>("SELECT data FROM model_pricing_shadow_calls WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
        return result.rows[0]?.data;
    }

    async getTaskEvidence(userId: string, taskId: string) {
        const result = await this.db.query<{ call: ShadowCall; receipt: ShadowPriceReceipt | null }>(
            `SELECT c.data AS call, r.data AS receipt
             FROM model_pricing_shadow_calls c
             LEFT JOIN model_pricing_shadow_receipts r ON r.user_id = c.user_id AND r.request_id = c.request_id AND r.kind = 'charge'
             WHERE c.user_id = $1 AND c.data->>'taskId' = $2
             ORDER BY c.started_at DESC LIMIT 1`,
            [userId, taskId],
        );
        return result.rows[0];
    }

    async getPointEvidence(userId: string, pointRecordId: string) {
        const result = await this.db.query<{ call: ShadowCall; receipt: ShadowPriceReceipt | null }>(
            `SELECT c.data AS call, r.data AS receipt
             FROM point_records p
             JOIN model_pricing_shadow_calls c ON c.user_id = p.user_id AND c.request_id = p.idempotency_key
             LEFT JOIN model_pricing_shadow_receipts r ON r.user_id = c.user_id AND r.request_id = c.request_id AND r.kind = 'charge'
             WHERE p.user_id = $1 AND p.id = $2 AND p.type = 'consume' LIMIT 1`,
            [userId, pointRecordId],
        );
        return result.rows[0];
    }

    async latestPricedByContract(modelId: string, contractIds: string[], channelId?: string, textUsageRuleId?: string | null) {
        if (!contractIds.length) return [];
        const result = await this.db.query<{ call: ShadowCall; receipt: ShadowPriceReceipt }>(
            `SELECT DISTINCT ON (c.data #>> '{frozen,contract,id}') c.data AS call, r.data AS receipt
             FROM model_pricing_shadow_calls c
             JOIN model_pricing_shadow_receipts r ON r.user_id = c.user_id AND r.request_id = c.request_id AND r.kind = 'charge'
             WHERE c.logical_model_id = $1 AND (c.status = 'priced' OR c.data #>> '{revaluation,receiptId}' = r.data->>'id') AND (c.data #>> '{frozen,contract,id}') = ANY($2::text[])
               AND ($3::text IS NULL OR c.channel_id = $3)
               AND ($4::boolean = false OR (r.data #>> '{snapshot,textUsageRuleId}') IS NOT DISTINCT FROM $5::text)
             ORDER BY (c.data #>> '{frozen,contract,id}'), c.started_at DESC`,
            [modelId, contractIds, channelId || null, textUsageRuleId !== undefined, textUsageRuleId ?? null],
        );
        return result.rows;
    }

    async latestUnpricedImageCalls(modelId: string, contractIds: string[], channelId: string) {
        if (!contractIds.length) return [];
        const result = await this.db.query<{ data: ShadowCall }>(
            `SELECT DISTINCT ON (c.data #>> '{frozen,contract,id}') c.data
             FROM model_pricing_shadow_calls c
             WHERE c.logical_model_id = $1 AND c.channel_id = $2 AND c.status = 'unpriced'
               AND c.data->>'protocol' = 'openai-images' AND c.data #>> '{frozen,contract,id}' = ANY($3::text[])
               AND ((c.data #> '{result,observation,usageFields}') ->> 'input_tokens_details.cached_tokens' = '0'
                 OR (c.data #> '{result,observation,usageFields}') ->> 'output_tokens_details.reasoning_tokens' = '0')
               AND c.data #> '{result,observation,unmappedUsageFields}' <@ '["input_tokens_details.cached_tokens","output_tokens_details.reasoning_tokens"]'::jsonb
               AND NOT c.data ? 'revaluation'
             ORDER BY (c.data #>> '{frozen,contract,id}'), c.started_at DESC`,
            [modelId, channelId, contractIds],
        );
        return result.rows.map((row) => row.data);
    }

    async latestObservedCall(modelId: string, channelId?: string) {
        const result = await this.db.query<{ data: ShadowCall }>(
            `SELECT data FROM model_pricing_shadow_calls
             WHERE logical_model_id = $1 AND ($2::text IS NULL OR channel_id = $2) AND status IN ('priced', 'unpriced')
               AND data #> '{result,observation,quantities}' IS NOT NULL
             ORDER BY started_at DESC LIMIT 1`,
            [modelId, channelId || null],
        );
        return result.rows[0]?.data;
    }

    async listTextEvidenceCandidates(modelId: string, contractIds: string[], channelId: string, cursor?: { startedAt: string; requestId: string }) {
        if (!contractIds.length) return [];
        const result = await this.db.query<{ data: ShadowTextCall }>(
            `SELECT c.data
             FROM model_pricing_shadow_calls c
             WHERE c.logical_model_id = $1 AND c.channel_id = $2
               AND c.data #>> '{frozen,contract,id}' = ANY($3::text[])
               AND c.data->>'protocol' IN ('openai-chat','openai-responses','anthropic-messages','gemini-generate')
               AND c.status IN ('priced','unpriced') AND c.data #> '{result,observation,quantities}' IS NOT NULL
               AND NOT c.request_id LIKE 'text-revaluation:%'
               AND ($4::timestamptz IS NULL OR (c.started_at, c.request_id) < ($4::timestamptz, $5::text))
             ORDER BY c.started_at DESC, c.request_id DESC LIMIT 20`,
            [modelId, channelId, contractIds, cursor?.startedAt || null, cursor?.requestId || null],
        );
        return result.rows.map((row) => row.data);
    }

    async saveCall(call: ShadowCall) {
        await this.db.query(
            "INSERT INTO model_pricing_shadow_calls (user_id, request_id, logical_model_id, channel_id, started_at, status, data) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::jsonb) ON CONFLICT (user_id, request_id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data",
            [call.userId, call.requestId, call.modelId, call.channelId, call.startedAt, call.result?.status || "pending", JSON.stringify(call)],
        );
    }
}
