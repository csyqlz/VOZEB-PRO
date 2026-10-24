import type { AudioPriceReview } from "../model-pricing-audio-review";
import type { AudioPriceResponseReceipt } from "../model-pricing-audio-response";
import type { QueryExecutor } from "./postgres";

/** Private media is only read by exact owning wallet request; never joined into task lists. */
export class ModelPricingAudioResponseRepository {
    constructor(private readonly db: QueryExecutor) {}

    async get(userId: string, requestId: string) {
        const result = await this.db.query<{ data: AudioPriceResponseReceipt }>("SELECT data FROM model_pricing_audio_responses WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
        return result.rows[0]?.data;
    }

    async exists(userId: string, requestId: string) {
        const result = await this.db.query("SELECT 1 FROM model_pricing_audio_responses WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
        return result.rows.length > 0;
    }

    /** The owning user's wallet lock serializes insertion and no-charge decisions. */
    async insert(receipt: AudioPriceResponseReceipt) {
        await this.db.query("INSERT INTO model_pricing_audio_responses (user_id, request_id, data) VALUES ($1, $2, $3::jsonb)", [receipt.userId, receipt.requestId, JSON.stringify(receipt)]);
    }
    async getReview(userId: string, requestId: string) {
        const result = await this.db.query<{ data: AudioPriceReview }>("SELECT data FROM model_pricing_audio_reviews WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
        return result.rows[0]?.data;
    }

    async insertReview(review: AudioPriceReview) {
        await this.db.query("INSERT INTO model_pricing_audio_reviews (user_id, request_id, data) VALUES ($1, $2, $3::jsonb)", [review.userId, review.requestId, JSON.stringify(review)]);
    }

    /** Return keys only; expired-but-not-deleted tasks still keep their media. */
    async listArchiveCandidates(limit: number) {
        const result = await this.db.query<{ userId: string; requestId: string }>(
            `SELECT wallet.user_id AS "userId", wallet.request_id AS "requestId" FROM model_pricing_wallet_reservations wallet
             WHERE wallet.status <> 'reserved' AND wallet.data->'preparation'->>'taskType' = 'audio'
               AND wallet.data->'preparation'->>'taskId' IS NOT NULL AND NOT wallet.data ? 'audioMediaPurgedAt'
               AND NOT EXISTS (SELECT 1 FROM generation_tasks task WHERE task.id = wallet.data->'preparation'->>'taskId')
             ORDER BY wallet.user_id, wallet.request_id LIMIT $1`,
            [limit],
        );
        return result.rows;
    }

    async hasTask(taskId: string) {
        return (await this.db.query("SELECT 1 FROM generation_tasks WHERE id = $1", [taskId])).rows.length > 0;
    }

    /** Preserve meters, original hashes, MIME and positions; erase only recoverable media bytes. */
    async purgeMedia(userId: string, requestId: string, now: string) {
        await this.db.query(
            `UPDATE model_pricing_audio_responses SET data = jsonb_set(data, '{audio}',
                (SELECT jsonb_agg(part || '{"data":""}'::jsonb ORDER BY position) FROM jsonb_array_elements(data->'audio') WITH ORDINALITY AS parts(part, position)))
                || jsonb_build_object('mediaPurgedAt', $3::text)
             WHERE user_id = $1 AND request_id = $2 AND NOT data ? 'mediaPurgedAt'`,
            [userId, requestId, now],
        );
        await this.db.query(
            `UPDATE model_pricing_audio_reviews SET data = jsonb_set(data, '{response}',
                jsonb_set(data->'response', '{audio}',
                    (SELECT jsonb_agg(part || '{"data":""}'::jsonb ORDER BY position) FROM jsonb_array_elements(data->'response'->'audio') WITH ORDINALITY AS parts(part, position)))
                || jsonb_build_object('mediaPurgedAt', $3::text))
             WHERE user_id = $1 AND request_id = $2 AND data ? 'response' AND NOT (data->'response') ? 'mediaPurgedAt'`,
            [userId, requestId, now],
        );
    }
}
