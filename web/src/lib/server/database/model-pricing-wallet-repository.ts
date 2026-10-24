import type { PricingWalletReservation, PricingWalletRefund } from "../model-pricing-wallet-service";
import type { QueryExecutor } from "./postgres";

/** All mutations run under the owning user's wallet transaction and row lock. */
export class ModelPricingWalletRepository {
    constructor(private readonly db: QueryExecutor) {}

    /** Call while holding the user's wallet lock, so balances and holds share one state. */
    async page(userId: string, input: { page: number; pageSize: number; status?: PricingWalletReservation["status"] }, dailySource: PricingWalletReservation["allocation"]["dailySource"]) {
        const summary = await this.db.query<{ pendingPoints: string; pendingCount: string; inactiveDailyPoints: string }>(
            `SELECT COALESCE(sum((data->'allocation'->>'heldPoints')::numeric), 0)::text AS "pendingPoints", count(*)::text AS "pendingCount",
                COALESCE(sum(CASE WHEN data->'allocation'->'dailySource' IS DISTINCT FROM $2::jsonb THEN (data->'allocation'->>'dailyHeld')::numeric ELSE 0 END), 0)::text AS "inactiveDailyPoints"
             FROM model_pricing_wallet_reservations WHERE user_id = $1 AND status = 'reserved'`,
            [userId, dailySource ? JSON.stringify(dailySource) : null],
        );
        const count = await this.db.query<{ total: string }>("SELECT count(*)::text AS total FROM model_pricing_wallet_reservations WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)", [userId, input.status || null]);
        const rows = await this.db.query<{ data: PricingWalletReservation; refundedPoints: string; expiredRefundPoints: string }>(
            `WITH selected AS MATERIALIZED (
                SELECT request_id, data FROM model_pricing_wallet_reservations
                WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
                ORDER BY data->>'createdAt' DESC, request_id DESC LIMIT $3 OFFSET $4
             ) SELECT selected.data,
                 COALESCE(refunds.restored, 0)::text AS "refundedPoints", COALESCE(refunds.expired, 0)::text AS "expiredRefundPoints"
             FROM selected LEFT JOIN LATERAL (
                 SELECT sum((data->'calculation'->'release'->>'permanentRestored')::numeric + (data->'calculation'->'release'->>'dailyRestored')::numeric) AS restored,
                     sum((data->'calculation'->'release'->>'dailyExpired')::numeric) AS expired
                 FROM model_pricing_wallet_refunds WHERE user_id = $1 AND request_id = selected.request_id
             ) refunds ON true ORDER BY selected.data->>'createdAt' DESC, selected.request_id DESC`,
            [userId, input.status || null, input.pageSize, (input.page - 1) * input.pageSize],
        );
        return { summary: { ...summary.rows[0], pendingCount: Number(summary.rows[0].pendingCount) }, items: rows.rows, total: Number(count.rows[0].total), ...input };
    }

    async get(userId: string, requestId: string) {
        const result = await this.db.query<{ data: PricingWalletReservation }>("SELECT data FROM model_pricing_wallet_reservations WHERE user_id = $1 AND request_id = $2", [userId, requestId]);
        return result.rows[0]?.data;
    }

    async save(reservation: PricingWalletReservation) {
        await this.db.query(
            "INSERT INTO model_pricing_wallet_reservations (user_id, request_id, status, charge_record_id, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, request_id) DO UPDATE SET status = EXCLUDED.status, charge_record_id = EXCLUDED.charge_record_id, data = EXCLUDED.data",
            [reservation.userId, reservation.requestId, reservation.status, reservation.chargeRecordId || null, JSON.stringify(reservation)],
        );
    }

    async getExact(userId: string, sourceKey: string) {
        const result = await this.db.query<{ exact_points: string }>("SELECT exact_points FROM model_pricing_wallet_accounts WHERE user_id = $1 AND source_key = $2", [userId, sourceKey]);
        return result.rows[0]?.exact_points || "0";
    }

    async setExact(userId: string, sourceKey: string, exactPoints: string) {
        await this.db.query("INSERT INTO model_pricing_wallet_accounts (user_id, source_key, exact_points) VALUES ($1, $2, $3) ON CONFLICT (user_id, source_key) DO UPDATE SET exact_points = EXCLUDED.exact_points", [userId, sourceKey, exactPoints]);
    }

    async getRefund(userId: string, requestId: string, refundId: string) {
        const result = await this.db.query<{ data: PricingWalletRefund }>("SELECT data FROM model_pricing_wallet_refunds WHERE user_id = $1 AND request_id = $2 AND refund_id = $3", [userId, requestId, refundId]);
        return result.rows[0]?.data;
    }

    async saveRefund(value: PricingWalletRefund) {
        await this.db.query("INSERT INTO model_pricing_wallet_refunds (user_id, request_id, refund_id, record_id, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [value.userId, value.requestId, value.refundId, value.recordId, JSON.stringify(value)]);
    }

    async ownsCharge(userId: string, recordId: string) {
        const result = await this.db.query("SELECT request_id FROM model_pricing_wallet_reservations WHERE user_id = $1 AND charge_record_id = $2", [userId, recordId]);
        return result.rows.length > 0;
    }
}
