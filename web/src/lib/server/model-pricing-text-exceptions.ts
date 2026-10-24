import { getFreshAuthSettings, getPublicUsersByIds } from "@/lib/auth/store";
import Decimal from "decimal.js";
import { readAuthDb } from "@/lib/auth/store-repository";
import { PricingInputError } from "@/lib/model-pricing";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "./database";
import type { PricingWalletReservation } from "./model-pricing-wallet-service";
import { getTextTask } from "./text-task-store";

type Filters = { modelId?: string; channelId?: string; status?: "pending-review" | "settled-warning"; requestId?: string; from?: string; to?: string; offset?: number };
const relevant = (item: PricingWalletReservation) =>
    item.usageKind === "text" && ((item.status === "reserved" && ["response_received", "outcome_unknown"].includes(item.submission?.phase || "")) || (item.status === "settled" && Boolean(item.billingWarnings?.length)));

/** Administrative, redacted view of delivered-but-unsettled responses and settled identity anomalies. */
export async function listTextPricingExceptions(filters: Filters) {
    if (filters.offset !== undefined && (!Number.isSafeInteger(filters.offset) || filters.offset < 0)) throw new PricingInputError("文本异常查询参数无效");
    if (filters.status && !["pending-review", "settled-warning"].includes(filters.status)) throw new PricingInputError("文本异常状态无效");
    const from = filters.from ? Date.parse(filters.from) : undefined;
    const to = filters.to ? Date.parse(filters.to) : undefined;
    if ((filters.from && !Number.isFinite(from)) || (filters.to && !Number.isFinite(to)) || (from !== undefined && to !== undefined && from > to)) throw new PricingInputError("文本异常时间范围无效");
    let matches: PricingWalletReservation[];
    let total: number;
    let heldPoints: string;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const params = [filters.modelId || null, filters.channelId || null, filters.requestId || null, filters.from || null, filters.to || null, filters.status || null];
        const where = `($1::text IS NULL OR data->>'modelId' = $1) AND data->>'usageKind' = 'text'
            AND ($2::text IS NULL OR data #>> '{frozen,text,call,channelId}' = $2)
            AND ($3::text IS NULL OR request_id = $3)
            AND ($4::timestamptz IS NULL OR (data->>'createdAt')::timestamptz >= $4::timestamptz)
            AND ($5::timestamptz IS NULL OR (data->>'createdAt')::timestamptz <= $5::timestamptz)
            AND ($6::text IS NULL OR ($6 = 'pending-review' AND status = 'reserved') OR ($6 = 'settled-warning' AND status = 'settled'))
            AND ((status = 'reserved' AND data #>> '{submission,phase}' IN ('response_received','outcome_unknown'))
              OR (status = 'settled' AND jsonb_array_length(COALESCE(data->'billingWarnings','[]'::jsonb)) > 0))`;
        const summary = await postgresQuery<{ total: string; held_points: string }>(
            `SELECT count(*)::text AS total, COALESCE(sum(CASE WHEN status = 'reserved' THEN (data #>> '{allocation,heldPoints}')::numeric ELSE 0 END),0)::text AS held_points FROM model_pricing_wallet_reservations WHERE ${where}`,
            params,
        );
        const page = await postgresQuery<{ data: PricingWalletReservation }>(`SELECT data FROM model_pricing_wallet_reservations WHERE ${where} ORDER BY data->>'createdAt' DESC, request_id DESC LIMIT 20 OFFSET $7`, [...params, filters.offset || 0]);
        matches = page.rows.map((row) => row.data);
        total = Number(summary.rows[0]?.total || 0);
        heldPoints = summary.rows[0]?.held_points || "0";
    } else {
        const reservations = (await readAuthDb()).pricingReservations.filter(
            (item) =>
                relevant(item) &&
                (!filters.status || (filters.status === "pending-review" ? item.status === "reserved" : item.status === "settled")) &&
                (!filters.modelId || item.modelId === filters.modelId) &&
                (!filters.channelId || item.frozen.text?.call.channelId === filters.channelId) &&
                (!filters.requestId || item.requestId === filters.requestId) &&
                (from === undefined || Date.parse(item.createdAt) >= from) &&
                (to === undefined || Date.parse(item.createdAt) <= to),
        );
        total = reservations.length;
        heldPoints = reservations
            .filter((item) => item.status === "reserved")
            .reduce((sum, item) => sum.add(item.allocation.heldPoints || 0), new Decimal(0))
            .toFixed();
        matches = reservations.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.requestId.localeCompare(a.requestId)).slice(filters.offset || 0, (filters.offset || 0) + 20);
    }
    const [publicUsers, settings] = await Promise.all([getPublicUsersByIds([...new Set(matches.map((item) => item.userId))]), getFreshAuthSettings()]);
    const users = new Map(publicUsers.map((user) => [user.id, user.accountId]));
    const channelNames = new Map(settings.systemChannels.map((channel) => [channel.id, channel.name]));
    const taskEvidence = new Map(
        await Promise.all(
            matches
                .filter((item) => item.preparation?.taskId)
                .map(async (item) => {
                    const task = await getTextTask(item.preparation!.taskId);
                    return [item.requestId, task?.userId === item.userId ? { reason: task.billingReviewReason, status: task.status, delivered: Boolean(task.result) } : undefined] as const;
                }),
        ),
    );
    return {
        total,
        heldPoints,
        offset: filters.offset || 0,
        items: matches.map((item) => ({
            taskId: item.preparation?.taskId,
            requestId: item.requestId,
            accountId: users.get(item.userId),
            modelId: item.modelId,
            channelId: item.frozen.text?.call.channelId,
            channelName: channelNames.get(item.frozen.text?.call.channelId || ""),
            taskStatus: taskEvidence.get(item.requestId)?.status,
            resultState: taskEvidence.get(item.requestId)?.delivered ? ("result-recorded" as const) : ("not-confirmed" as const),
            requestedModel: item.frozen.text?.call.requestedModel,
            reportedModel: item.submission?.response?.observation && "reportedModel" in item.submission.response.observation ? item.submission.response.observation.reportedModel : undefined,
            requestedTier: item.frozen.text?.call.serviceTier,
            reportedTier: item.submission?.response?.observation && "serviceTier" in item.submission.response.observation ? item.submission.response.observation.serviceTier : undefined,
            usageFields: item.submission?.response?.observation?.usageFields || {},
            usageSources: item.settledSources || {},
            meterStates: Object.fromEntries(
                (item.frozen.version.items || []).map((price) => {
                    const source = item.settledSources?.[price.key];
                    const amount = item.settledUsage?.[price.key];
                    return [
                        price.key,
                        source === "defaulted-zero"
                            ? "reviewed-zero"
                            : source === "reported-zero"
                              ? "reported-zero"
                              : source === "reported" && amount !== undefined
                                ? new Decimal(amount).isZero()
                                    ? "reported-zero"
                                    : "reported-positive"
                                : "pending-review",
                    ];
                }),
            ),
            officialVersionId: item.frozen.version.id,
            salesVersionId: item.frozen.policy.id,
            ruleId: item.frozen.text?.rules?.id,
            contractId: item.frozen.contractId,
            heldPoints: item.status === "reserved" ? item.allocation.heldPoints : undefined,
            status: item.status === "reserved" ? ("pending-review" as const) : ("settled-warning" as const),
            reasons: item.status === "settled" ? item.billingWarnings || [] : [taskEvidence.get(item.requestId)?.reason || item.submission?.reason || "结果待核对"],
            createdAt: item.createdAt,
        })),
    };
}
