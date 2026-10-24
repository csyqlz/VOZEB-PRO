import { ensurePostgresSchema, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import { PricingConflictError, PricingInputError, type OfficialPriceObservation, type OfficialPriceObservationAmendment, type OfficialPriceObservationLink } from "@/lib/model-pricing";
import { mutatePricingState, pricingUsesPostgres, PRICING_PAGE_SIZE, readPricingState } from "./model-pricing-store";

export async function listOfficialPriceObservations(page: number, manufacturer = "", status: "open" | "pending" | "confirmed" | "rejected" | "all" = "all") {
    if (!Number.isSafeInteger(page) || page < 1) throw new PricingInputError("页码无效");
    if (!["open", "pending", "confirmed", "rejected", "all"].includes(status)) throw new PricingInputError("官网发现状态筛选无效");
    if (!pricingUsesPostgres()) {
        const state = await readPricingState();
        const all = (state.observations || []).filter((item) => (!manufacturer || item.manufacturer === manufacturer) && (status === "all" || (status === "open" ? item.reviewStatus !== "rejected" : item.reviewStatus === status))).toReversed();
        const observations = all.slice((page - 1) * PRICING_PAGE_SIZE, page * PRICING_PAGE_SIZE).map((item) => ({ ...item, amendments: state.observationAmendments?.[item.id] || [] }));
        return { observations, links: (state.observationLinks || []).filter((link) => observations.some((item) => item.id === link.observationId)), total: all.length, page, pageSize: PRICING_PAGE_SIZE };
    }
    await ensurePostgresSchema();
    const [rows, count] = await Promise.all([
        postgresQuery<{
            data: OfficialPriceObservation;
            status: OfficialPriceObservation["reviewStatus"];
            reviewed_at: Date | null;
            reviewed_by: string | null;
            review_note: string | null;
            amendments: OfficialPriceObservationAmendment[];
            logical_model_id: string | null;
            linked_at: Date | null;
            linked_by: string | null;
        }>(
            "SELECT o.data, r.status, r.reviewed_at, r.reviewed_by, r.review_note, r.amendments, l.logical_model_id, l.linked_at, l.linked_by FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id LEFT JOIN model_official_price_observation_links l ON l.observation_id = o.id WHERE ($1::text = '' OR o.manufacturer = $1) AND ($2::text = 'all' OR ($2::text = 'open' AND r.status <> 'rejected') OR r.status = $2) ORDER BY o.created_at DESC, o.id DESC LIMIT $3 OFFSET $4",
            [manufacturer, status, PRICING_PAGE_SIZE, (page - 1) * PRICING_PAGE_SIZE],
        ),
        postgresQuery<{ count: string }>(
            "SELECT count(*)::text AS count FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE ($1::text = '' OR o.manufacturer = $1) AND ($2::text = 'all' OR ($2::text = 'open' AND r.status <> 'rejected') OR r.status = $2)",
            [manufacturer, status],
        ),
    ]);
    const observations = rows.rows.map((row) => ({
        ...row.data,
        reviewStatus: row.status,
        amendments: row.amendments || [],
        ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString(), reviewedBy: row.reviewed_by || "", reviewNote: row.review_note || "" } : {}),
    }));
    const links: OfficialPriceObservationLink[] = rows.rows.flatMap((row) =>
        row.logical_model_id && row.linked_at ? [{ observationId: row.data.id, logicalModelId: row.logical_model_id, linkedAt: row.linked_at.toISOString(), linkedBy: row.linked_by || "" }] : [],
    );
    return { observations, links, total: Number(count.rows[0]?.count || 0), page, pageSize: PRICING_PAGE_SIZE };
}

export async function getOfficialPriceObservation(id: string): Promise<OfficialPriceObservation | null> {
    if (!pricingUsesPostgres()) {
        const state = await readPricingState();
        const item = state.observations?.find((value) => value.id === id);
        return item ? { ...item, amendments: state.observationAmendments?.[id] || [] } : null;
    }
    await ensurePostgresSchema();
    const row = await postgresQuery<{ data: OfficialPriceObservation; status: OfficialPriceObservation["reviewStatus"]; amendments: OfficialPriceObservationAmendment[] }>(
        "SELECT o.data, r.status, r.amendments FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE o.id = $1",
        [id],
    );
    return row.rows[0] ? { ...row.rows[0].data, reviewStatus: row.rows[0].status, amendments: row.rows[0].amendments || [] } : null;
}

export async function listActiveObservationModelIds(manufacturer: string, modelIds: string[]): Promise<string[]> {
    if (!modelIds.length) return [];
    const ids = modelIds.map((id) => id.toLowerCase());
    if (!pricingUsesPostgres())
        return (await readPricingState()).observations?.filter((item) => item.manufacturer === manufacturer && item.reviewStatus !== "rejected" && ids.includes(item.officialModelId.toLowerCase())).map((item) => item.officialModelId) || [];
    await ensurePostgresSchema();
    const rows = await postgresQuery<{ official_model_id: string }>(
        "SELECT DISTINCT o.official_model_id FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE o.manufacturer = $1 AND lower(o.official_model_id) = ANY($2::text[]) AND r.status IN ('pending', 'confirmed')",
        [manufacturer, ids],
    );
    return rows.rows.map((row) => row.official_model_id);
}

export async function deletePendingOfficialPriceObservation(id: string) {
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const item = state.observations?.find((value) => value.id === id);
            if (!item) throw new PricingInputError("官网发现不存在");
            if (item.reviewStatus !== "pending") throw new PricingConflictError("仅可删除待确认的官网发现");
            const observationAmendments = { ...state.observationAmendments };
            delete observationAmendments[id];
            return { next: { ...state, observations: state.observations!.filter((value) => value.id !== id), observationLinks: (state.observationLinks || []).filter((value) => value.observationId !== id), observationAmendments }, result: item };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ data: OfficialPriceObservation; status: string }>(
            "SELECT o.data, r.status FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE o.id = $1 FOR UPDATE OF r",
            [id],
        );
        if (!row.rows.length) throw new PricingInputError("官网发现不存在");
        if (row.rows[0].status !== "pending") throw new PricingConflictError("仅可删除待确认的官网发现");
        await client.query("DELETE FROM model_official_price_observation_links WHERE observation_id = $1", [id]);
        await client.query("DELETE FROM model_official_price_observation_reviews WHERE observation_id = $1", [id]);
        await client.query("DELETE FROM model_official_price_observations WHERE id = $1", [id]);
        return row.rows[0].data;
    });
}

export async function insertOfficialPriceObservation(observation: OfficialPriceObservation, newOnly = false) {
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            if (newOnly && state.observations?.some((item) => item.manufacturer === observation.manufacturer && item.officialModelId.toLowerCase() === observation.officialModelId.toLowerCase() && item.reviewStatus !== "rejected"))
                throw new PricingConflictError("该厂商型号已有发现记录，请刷新");
            const existing = state.observations?.find((item) => item.id === observation.id);
            return { next: existing ? state : { ...state, observations: [...(state.observations || []), observation] }, result: existing || observation };
        });
    await ensurePostgresSchema();
    await withPostgresTransaction(async (client) => {
        if (newOnly) {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${observation.manufacturer}:${observation.officialModelId.toLowerCase()}`]);
            const active = await client.query(
                "SELECT 1 FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE o.manufacturer = $1 AND lower(o.official_model_id) = lower($2) AND r.status IN ('pending', 'confirmed') LIMIT 1",
                [observation.manufacturer, observation.officialModelId],
            );
            if (active.rows.length) throw new PricingConflictError("该厂商型号已有发现记录，请刷新");
        }
        await client.query("INSERT INTO model_official_price_observations (id, manufacturer, official_model_id, observed_at, created_at, data) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb) ON CONFLICT (id) DO NOTHING", [
            observation.id,
            observation.manufacturer,
            observation.officialModelId,
            observation.observedAt,
            observation.createdAt,
            JSON.stringify(observation),
        ]);
        await client.query("INSERT INTO model_official_price_observation_reviews (observation_id, status) VALUES ($1, 'pending') ON CONFLICT (observation_id) DO NOTHING", [observation.id]);
    });
    return (await getOfficialPriceObservation(observation.id)) || observation;
}

export async function appendOfficialPriceObservationAmendment(id: string, input: Omit<OfficialPriceObservationAmendment, "revision">, expectedRevision: number) {
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const item = state.observations?.find((value) => value.id === id);
            if (!item || item.reviewStatus !== "pending") throw new PricingConflictError("仅可修订待确认的官网发现");
            const current = state.observationAmendments?.[id] || [];
            if (current.length !== expectedRevision) throw new PricingConflictError("官网发现已由其他管理员修订，请刷新");
            const amendment = { ...input, revision: current.length + 1 };
            return { next: { ...state, observationAmendments: { ...state.observationAmendments, [id]: [...current, amendment] } }, result: amendment };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ status: string; amendments: OfficialPriceObservationAmendment[] }>("SELECT status, amendments FROM model_official_price_observation_reviews WHERE observation_id = $1 FOR UPDATE", [id]);
        if (!row.rows.length || row.rows[0].status !== "pending") throw new PricingConflictError("仅可修订待确认的官网发现");
        const current = row.rows[0].amendments || [];
        if (current.length !== expectedRevision) throw new PricingConflictError("官网发现已由其他管理员修订，请刷新");
        const amendment = { ...input, revision: current.length + 1 };
        await client.query("UPDATE model_official_price_observation_reviews SET amendments = $2::jsonb WHERE observation_id = $1", [id, JSON.stringify([...current, amendment])]);
        return amendment;
    });
}

export async function reviewOfficialPriceObservation(id: string, status: "confirmed" | "rejected", note: string, actorId: string, expectedRevision = 0) {
    const reviewedAt = new Date().toISOString();
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const item = state.observations?.find((value) => value.id === id);
            if (!item) throw new PricingInputError("官网发现不存在");
            if (item.reviewStatus !== "pending") throw new PricingConflictError("官网发现已审核，请刷新");
            if ((state.observationAmendments?.[id]?.length || 0) !== expectedRevision) throw new PricingConflictError("官网发现已修订，请刷新后确认");
            const reviewed = { ...item, reviewStatus: status, reviewedAt, reviewedBy: actorId, reviewNote: note };
            return { next: { ...state, observations: state.observations!.map((value) => (value.id === id ? reviewed : value)) }, result: reviewed };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ data: OfficialPriceObservation; status: string; amendments: OfficialPriceObservationAmendment[] }>(
            "SELECT o.data, r.status, r.amendments FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE o.id = $1 FOR UPDATE OF r",
            [id],
        );
        if (!row.rows.length) throw new PricingInputError("官网发现不存在");
        if (row.rows[0].status !== "pending") throw new PricingConflictError("官网发现已审核，请刷新");
        if ((row.rows[0].amendments || []).length !== expectedRevision) throw new PricingConflictError("官网发现已修订，请刷新后确认");
        await client.query("UPDATE model_official_price_observation_reviews SET status = $2, reviewed_at = $3::timestamptz, reviewed_by = $4, review_note = $5 WHERE observation_id = $1", [id, status, reviewedAt, actorId, note]);
        return { ...row.rows[0].data, reviewStatus: status, amendments: row.rows[0].amendments || [], reviewedAt, reviewedBy: actorId, reviewNote: note };
    });
}

export async function invalidateOfficialPriceObservation(id: string, reason: string, actorId: string) {
    if (!reason.trim()) throw new PricingInputError("请填写撤销确认的原因");
    const reviewedAt = new Date().toISOString();
    const reviewNote = `撤销确认：${reason.trim()}`;
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const item = state.observations?.find((value) => value.id === id);
            if (!item || item.reviewStatus !== "confirmed") throw new PricingConflictError("仅可撤销已确认的官网发现");
            const reviewed = { ...item, reviewStatus: "rejected" as const, reviewedAt, reviewedBy: actorId, reviewNote };
            return {
                next: { ...state, observations: state.observations!.map((value) => (value.id === id ? reviewed : value)), observationLinks: (state.observationLinks || []).filter((value) => value.observationId !== id) },
                result: reviewed,
            };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ data: OfficialPriceObservation; status: string }>(
            "SELECT o.data, r.status FROM model_official_price_observations o JOIN model_official_price_observation_reviews r ON r.observation_id = o.id WHERE o.id = $1 FOR UPDATE OF r",
            [id],
        );
        if (!row.rows.length || row.rows[0].status !== "confirmed") throw new PricingConflictError("仅可撤销已确认的官网发现");
        await client.query("UPDATE model_official_price_observation_reviews SET status = 'rejected', reviewed_at = $2::timestamptz, reviewed_by = $3, review_note = $4 WHERE observation_id = $1", [id, reviewedAt, actorId, reviewNote]);
        await client.query("DELETE FROM model_official_price_observation_links WHERE observation_id = $1", [id]);
        return { ...row.rows[0].data, reviewStatus: "rejected" as const, reviewedAt, reviewedBy: actorId, reviewNote };
    });
}

export async function setOfficialPriceObservationLink(id: string, logicalModelId: string | null, actorId: string) {
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const item = state.observations?.find((value) => value.id === id);
            if (!item) throw new PricingInputError("官网发现不存在");
            if (item.reviewStatus !== "confirmed") throw new PricingConflictError("请先审核确认官网发现");
            const link = logicalModelId ? { observationId: id, logicalModelId, linkedAt: new Date().toISOString(), linkedBy: actorId } : null;
            return { next: { ...state, observationLinks: [...(state.observationLinks || []).filter((value) => value.observationId !== id), ...(link ? [link] : [])] }, result: link };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ status: string }>("SELECT status FROM model_official_price_observation_reviews WHERE observation_id = $1 FOR UPDATE", [id]);
        if (!row.rows.length) throw new PricingInputError("官网发现不存在");
        if (row.rows[0].status !== "confirmed") throw new PricingConflictError("请先审核确认官网发现");
        if (!logicalModelId) {
            await client.query("DELETE FROM model_official_price_observation_links WHERE observation_id = $1", [id]);
            return null;
        }
        const link = { observationId: id, logicalModelId, linkedAt: new Date().toISOString(), linkedBy: actorId };
        await client.query(
            "INSERT INTO model_official_price_observation_links (observation_id, logical_model_id, linked_at, linked_by) VALUES ($1, $2, $3::timestamptz, $4) ON CONFLICT (observation_id) DO UPDATE SET logical_model_id = EXCLUDED.logical_model_id, linked_at = EXCLUDED.linked_at, linked_by = EXCLUDED.linked_by",
            [id, logicalModelId, link.linkedAt, actorId],
        );
        return link;
    });
}
