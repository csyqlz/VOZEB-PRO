import { randomUUID } from "node:crypto";

import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import { readJsonDataFile, withJsonDataFileLock, withJsonDataFileLocks, writeJsonDataFile } from "@/lib/server/data-adapter";
import {
    DEFAULT_OFFICIAL_PRICE_SOURCES,
    EMPTY_PRICING_STATE,
    PricingConflictError,
    PricingInputError,
    type BusinessExchangeRate,
    type ModelPriceBinding,
    type ModelPriceLifecycleMark,
    type OfficialPriceSource,
    type OfficialPriceVersion,
    type PriceCandidate,
    type PricingState,
    type SalesVersion,
} from "@/lib/model-pricing";

const FILE = "model-pricing.json";
export const PRICING_PAGE_SIZE = 20;

export function pricingUsesPostgres() {
    return getDatabaseProvider() === "postgres";
}

export async function readPricingState(): Promise<PricingState> {
    return readJsonDataFile(FILE, EMPTY_PRICING_STATE);
}

export async function mutatePricingState<T>(mutate: (current: PricingState) => { next: PricingState; result: T } | Promise<{ next: PricingState; result: T }>): Promise<T> {
    return withJsonDataFileLock(FILE, async () => {
        const current = await readPricingState();
        const { next, result } = await mutate(current);
        await writeJsonDataFile(FILE, next);
        return result;
    });
}

export async function getCurrentSalesVersion(): Promise<SalesVersion | undefined> {
    if (!pricingUsesPostgres()) return (await readPricingState()).salesVersions.at(-1);
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: SalesVersion }>("SELECT v.data FROM model_pricing_state s JOIN model_sales_price_versions v ON v.id = s.current_sales_version_id WHERE s.id = 'default'");
    return result.rows[0]?.data;
}

export async function getBusinessExchangeRate(): Promise<BusinessExchangeRate | undefined> {
    if (!pricingUsesPostgres()) return (await readPricingState()).exchangeRate;
    await ensurePostgresSchema();
    const result = await postgresQuery<{ exchange_rate: BusinessExchangeRate | null }>("SELECT exchange_rate FROM model_pricing_state WHERE id = 'default'");
    return result.rows[0]?.exchange_rate || undefined;
}

export async function listOfficialPriceSources(): Promise<OfficialPriceSource[]> {
    const stored = pricingUsesPostgres()
        ? await (async () => {
              await ensurePostgresSchema();
              const result = await postgresQuery<{ manufacturer: string; url: string; updated_at: Date; updated_by: string }>("SELECT manufacturer, url, updated_at, updated_by FROM model_official_price_sources ORDER BY manufacturer");
              return result.rows.map((row) => ({ manufacturer: row.manufacturer, url: row.url, updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by }));
          })()
        : (await readPricingState()).officialSources || [];
    const overrides = new Map(stored.map((item) => [item.manufacturer, item]));
    return [...DEFAULT_OFFICIAL_PRICE_SOURCES.map((item) => overrides.get(item.manufacturer) || item), ...stored.filter((item) => !DEFAULT_OFFICIAL_PRICE_SOURCES.some((defaultItem) => defaultItem.manufacturer === item.manufacturer))];
}

export async function listOfficialPriceReviewLinks(manufacturer: string): Promise<Array<{ url: string; label: string }>> {
    const primary = (await listOfficialPriceSources()).find((item) => item.manufacturer === manufacturer);
    if (!primary) return [];
    const historical = pricingUsesPostgres()
        ? await (async () => {
              await ensurePostgresSchema();
              const result = await postgresQuery<{ url: string; series: string }>(
                  "SELECT DISTINCT data->>'sourceUrl' AS url, data->>'series' AS series FROM model_official_price_versions WHERE data->>'manufacturer' = $1 UNION SELECT DISTINCT data->>'sourceUrl' AS url, data->>'series' AS series FROM model_price_candidates WHERE status IN ('pending', 'approved') AND data->>'manufacturer' = $1",
                  [manufacturer],
              );
              return result.rows;
          })()
        : await (async () => {
              const state = await readPricingState();
              return [...state.officialVersions, ...state.candidates.filter((item) => item.status === "pending" || item.status === "approved")]
                  .filter((item) => item.manufacturer === manufacturer)
                  .map((item) => ({ url: item.sourceUrl, series: item.series }));
          })();
    const links = new Map<string, string>([[primary.url, "当前厂商官网链接"]]);
    if (manufacturer === "ByteDance / Volcengine") links.set("https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing", "BytePlus ModelArk 国际区价目");
    for (const item of historical) {
        try {
            const url = new URL(item.url);
            if (url.protocol === "https:" && !url.username && !url.password && !links.has(url.toString())) links.set(url.toString(), item.series || "历史价目证据");
        } catch {
            /* Historical evidence may contain invalid URLs. */
        }
    }
    return [...links].map(([url, label]) => ({ url, label }));
}

export async function saveOfficialPriceSource(manufacturer: string, url: string, actorId: string, expectedUpdatedAt: string | null): Promise<OfficialPriceSource> {
    const updatedAt = new Date().toISOString();
    const source = { manufacturer, url, updatedAt, updatedBy: actorId };
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const current = state.officialSources?.find((item) => item.manufacturer === manufacturer);
            if ((current?.updatedAt || null) !== expectedUpdatedAt) throw new PricingConflictError("官网链接已变化，请刷新后重试");
            return { next: { ...state, officialSources: [...(state.officialSources || []).filter((item) => item.manufacturer !== manufacturer), source] }, result: source };
        });
    await ensurePostgresSchema();
    const result = expectedUpdatedAt
        ? await postgresQuery("UPDATE model_official_price_sources SET url = $2, updated_at = $3::timestamptz, updated_by = $4 WHERE manufacturer = $1 AND updated_at = $5::timestamptz RETURNING manufacturer", [
              manufacturer,
              url,
              updatedAt,
              actorId,
              expectedUpdatedAt,
          ])
        : await postgresQuery("INSERT INTO model_official_price_sources (manufacturer, url, updated_at, updated_by) VALUES ($1, $2, $3::timestamptz, $4) ON CONFLICT (manufacturer) DO NOTHING RETURNING manufacturer", [
              manufacturer,
              url,
              updatedAt,
              actorId,
          ]);
    if (!result.rows.length) throw new PricingConflictError("官网链接已变化，请刷新后重试");
    return source;
}

export async function saveBusinessExchangeRate(rate: BusinessExchangeRate, expectedObservedAt: string | null) {
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            if ((state.exchangeRate?.observedAt || null) !== expectedObservedAt) throw new PricingConflictError("汇率已变化，请刷新后重试");
            return { next: { ...state, exchangeRate: rate }, result: rate };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ exchange_rate: BusinessExchangeRate | null }>("SELECT exchange_rate FROM model_pricing_state WHERE id = 'default' FOR UPDATE");
        if ((row.rows[0]?.exchange_rate?.observedAt || null) !== expectedObservedAt) throw new PricingConflictError("汇率已变化，请刷新后重试");
        await client.query("UPDATE model_pricing_state SET exchange_rate = $1::jsonb, updated_at = now() WHERE id = 'default'", [JSON.stringify(rate)]);
        return rate;
    });
}

export async function getOfficialVersionsByIds(ids: string[]): Promise<OfficialPriceVersion[]> {
    if (!ids.length) return [];
    if (!pricingUsesPostgres()) return (await readPricingState()).officialVersions.filter((item) => ids.includes(item.id));
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: OfficialPriceVersion }>("SELECT data FROM model_official_price_versions WHERE id = ANY($1::text[])", [ids]);
    return result.rows.map((row) => row.data);
}

export async function bindReviewedPriceVersion(source: OfficialPriceVersion, logicalModelId: string, actorId: string): Promise<OfficialPriceVersion> {
    if (source.textPriceSchedule) throw new PricingInputError("文本分档价不能复制为旧式平价版本");
    const makeVersion = (): OfficialPriceVersion => ({ ...source, id: randomUUID(), logicalModelId, linkedFromVersionId: source.id, linkedBy: actorId, publishedAt: new Date().toISOString() });
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            if (!state.officialVersions.some((item) => item.id === source.id && !item.logicalModelId)) throw new PricingConflictError("官网价目已变化，请刷新后重试");
            if (state.officialVersions.some((item) => item.linkedFromVersionId === source.id && item.logicalModelId === logicalModelId)) throw new PricingConflictError("该逻辑模型已关联此官网价目");
            const version = makeVersion();
            return { next: { ...state, officialVersions: [...state.officialVersions, version] }, result: version };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const current = await client.query<{ data: OfficialPriceVersion }>("SELECT data FROM model_official_price_versions WHERE id = $1 FOR UPDATE", [source.id]);
        if (!current.rows[0] || current.rows[0].data.logicalModelId) throw new PricingConflictError("官网价目已变化，请刷新后重试");
        const duplicate = await client.query("SELECT id FROM model_official_price_versions WHERE data->>'linkedFromVersionId' = $1 AND logical_model_id = $2 LIMIT 1", [source.id, logicalModelId]);
        if (duplicate.rows.length) throw new PricingConflictError("该逻辑模型已关联此官网价目");
        const version = makeVersion();
        await client.query("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [version.id, logicalModelId, version.publishedAt, JSON.stringify(version)]);
        return version;
    });
}

export async function getLatestOfficialVersionForModel(modelId: string): Promise<OfficialPriceVersion | undefined> {
    if (!pricingUsesPostgres()) return (await readPricingState()).officialVersions.filter((item) => item.logicalModelId === modelId).at(-1);
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: OfficialPriceVersion }>("SELECT data FROM model_official_price_versions WHERE logical_model_id = $1 ORDER BY published_at DESC, id DESC LIMIT 1", [modelId]);
    return result.rows[0]?.data;
}

export async function getLatestOfficialVersionsForModels(modelIds: string[]): Promise<Map<string, OfficialPriceVersion>> {
    const versions = new Map<string, OfficialPriceVersion>();
    if (!modelIds.length) return versions;
    if (!pricingUsesPostgres()) {
        const wanted = new Set(modelIds);
        for (const version of (await readPricingState()).officialVersions) if (wanted.has(version.logicalModelId)) versions.set(version.logicalModelId, version);
        return versions;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: OfficialPriceVersion }>("SELECT DISTINCT ON (logical_model_id) data FROM model_official_price_versions WHERE logical_model_id = ANY($1::text[]) ORDER BY logical_model_id, published_at DESC, id DESC", [
        modelIds,
    ]);
    for (const row of result.rows) versions.set(row.data.logicalModelId, row.data);
    return versions;
}

export async function listPriceReviewVersions(modelIds: string[]): Promise<OfficialPriceVersion[]> {
    if (!modelIds.length) return [];
    if (!pricingUsesPostgres()) return (await readPricingState()).officialVersions.filter((item) => modelIds.includes(item.logicalModelId));
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: OfficialPriceVersion }>("SELECT data FROM model_official_price_versions WHERE logical_model_id = ANY($1::text[]) ORDER BY logical_model_id, published_at DESC", [modelIds]);
    return result.rows.map((row) => row.data);
}

export async function listPriceReviewCandidates(modelIds: string[]): Promise<PriceCandidate[]> {
    if (!modelIds.length) return [];
    if (!pricingUsesPostgres()) return (await readPricingState()).candidates.filter((item) => item.status === "pending" && modelIds.includes(item.logicalModelId));
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: PriceCandidate }>("SELECT data FROM model_price_candidates WHERE status = 'pending' AND logical_model_id = ANY($1::text[]) ORDER BY created_at DESC", [modelIds]);
    return result.rows.map((row) => row.data);
}

export async function listPriceLifecycleMarks(modelIds: string[]): Promise<ModelPriceLifecycleMark[]> {
    if (!modelIds.length) return [];
    if (!pricingUsesPostgres()) return (await readPricingState()).lifecycleMarks?.filter((item) => modelIds.includes(item.logicalModelId)) || [];
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: ModelPriceLifecycleMark }>("SELECT data FROM model_price_lifecycle_marks WHERE logical_model_id = ANY($1::text[])", [modelIds]);
    return result.rows.map((row) => row.data);
}

export async function savePriceLifecycleMark(mark: ModelPriceLifecycleMark) {
    if (!pricingUsesPostgres()) return mutatePricingState((state) => ({ next: { ...state, lifecycleMarks: [...(state.lifecycleMarks || []).filter((item) => item.logicalModelId !== mark.logicalModelId), mark] }, result: mark }));
    await ensurePostgresSchema();
    await postgresQuery("INSERT INTO model_price_lifecycle_marks (logical_model_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (logical_model_id) DO UPDATE SET data = EXCLUDED.data", [mark.logicalModelId, JSON.stringify(mark)]);
    return mark;
}

export async function clearPriceLifecycleMark(modelId: string) {
    if (!pricingUsesPostgres()) return mutatePricingState((state) => ({ next: { ...state, lifecycleMarks: (state.lifecycleMarks || []).filter((item) => item.logicalModelId !== modelId) }, result: null }));
    await ensurePostgresSchema();
    await postgresQuery("DELETE FROM model_price_lifecycle_marks WHERE logical_model_id = $1", [modelId]);
}

export async function getModelPricingCoverage(modelIds: string[]): Promise<Map<string, { pending: boolean; approved: boolean }>> {
    const coverage = new Map<string, { pending: boolean; approved: boolean }>();
    if (!modelIds.length) return coverage;
    if (!pricingUsesPostgres()) {
        const state = await readPricingState();
        const wanted = new Set(modelIds);
        for (const candidate of state.candidates) {
            if (!wanted.has(candidate.logicalModelId)) continue;
            const entry = coverage.get(candidate.logicalModelId) || { pending: false, approved: false };
            if (candidate.status === "pending") entry.pending = true;
            coverage.set(candidate.logicalModelId, entry);
        }
        for (const version of state.officialVersions) {
            if (!wanted.has(version.logicalModelId)) continue;
            const entry = coverage.get(version.logicalModelId) || { pending: false, approved: false };
            entry.approved = true;
            coverage.set(version.logicalModelId, entry);
        }
        return coverage;
    }
    await ensurePostgresSchema();
    const [candidates, versions] = await Promise.all([
        postgresQuery<{ logical_model_id: string }>("SELECT DISTINCT logical_model_id FROM model_price_candidates WHERE status = 'pending' AND logical_model_id = ANY($1::text[])", [modelIds]),
        postgresQuery<{ logical_model_id: string }>("SELECT DISTINCT logical_model_id FROM model_official_price_versions WHERE logical_model_id = ANY($1::text[])", [modelIds]),
    ]);
    for (const row of candidates.rows) coverage.set(row.logical_model_id, { pending: true, approved: false });
    for (const row of versions.rows) coverage.set(row.logical_model_id, { pending: coverage.get(row.logical_model_id)?.pending || false, approved: true });
    return coverage;
}

export type PriceCandidateFilter = { modelId?: string; manufacturer?: string; status?: PriceCandidate["status"] };

export async function listApprovedPriceVersionsPage(page: number, filter: Pick<PriceCandidateFilter, "modelId" | "manufacturer"> & { ownerless?: boolean; capability?: string; skuQuery?: string } = {}) {
    if (!Number.isSafeInteger(page) || page < 1) throw new PricingInputError("页码无效");
    if (!pricingUsesPostgres()) {
        const all = (await readPricingState()).officialVersions
            .filter(
                (item) =>
                    (!filter.modelId || item.logicalModelId === filter.modelId) &&
                    (!filter.ownerless || !item.logicalModelId) &&
                    (!filter.manufacturer || item.manufacturer === filter.manufacturer) &&
                    (!filter.capability || item.capability === filter.capability) &&
                    (!filter.skuQuery || item.sku.toLocaleLowerCase().includes(filter.skuQuery.toLocaleLowerCase())),
            )
            .toReversed();
        return { items: all.slice((page - 1) * PRICING_PAGE_SIZE, page * PRICING_PAGE_SIZE), total: all.length };
    }
    await ensurePostgresSchema();
    const params: string[] = [];
    const clauses: string[] = [];
    if (filter.modelId) {
        params.push(filter.modelId);
        clauses.push(`logical_model_id = $${params.length}`);
    }
    if (filter.ownerless) clauses.push("logical_model_id = ''");
    if (filter.manufacturer) {
        params.push(filter.manufacturer);
        clauses.push(`data->>'manufacturer' = $${params.length}`);
    }
    if (filter.capability) {
        params.push(filter.capability);
        clauses.push(`data->>'capability' = $${params.length}`);
    }
    if (filter.skuQuery) {
        params.push(`%${filter.skuQuery.replace(/[\\%_]/g, "\\$&")}%`);
        clauses.push(`data->>'sku' ILIKE $${params.length} ESCAPE '\\'`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const [rows, count] = await Promise.all([
        postgresQuery<{ data: OfficialPriceVersion }>(`SELECT data FROM model_official_price_versions${where} ORDER BY published_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
            ...params,
            PRICING_PAGE_SIZE,
            (page - 1) * PRICING_PAGE_SIZE,
        ]),
        postgresQuery<{ count: string }>(`SELECT count(*)::text AS count FROM model_official_price_versions${where}`, params),
    ]);
    return { items: rows.rows.map((row) => row.data), total: Number(count.rows[0]?.count || 0) };
}

export async function listOfficialPriceReferences(manufacturer: string, series?: string, officialVersion?: string) {
    if (!manufacturer) return { series: [], versions: [], approved: [], pending: [] };
    if (!pricingUsesPostgres()) {
        const state = await readPricingState();
        const prices = [...state.officialVersions, ...state.candidates.filter((item) => item.status === "pending")].filter((item) => item.manufacturer === manufacturer);
        return {
            series: [...new Set(prices.map((item) => item.series))].sort(),
            versions: [...new Set(prices.filter((item) => item.series === series).map((item) => item.officialVersion))].sort(),
            approved: state.officialVersions
                .filter((item) => item.manufacturer === manufacturer && item.series === series && item.officialVersion === officialVersion)
                .slice(-PRICING_PAGE_SIZE)
                .toReversed(),
            pending: state.candidates
                .filter((item) => item.status === "pending" && item.manufacturer === manufacturer && item.series === series && item.officialVersion === officialVersion)
                .slice(-PRICING_PAGE_SIZE)
                .toReversed(),
        };
    }
    await ensurePostgresSchema();
    const [seriesRows, versionRows, approvedRows, pendingRows] = await Promise.all([
        postgresQuery<{ value: string }>(
            "SELECT DISTINCT data->>'series' AS value FROM model_price_candidates WHERE status IN ('pending', 'approved') AND data->>'manufacturer' = $1 UNION SELECT DISTINCT data->>'series' AS value FROM model_official_price_versions WHERE data->>'manufacturer' = $1 ORDER BY value",
            [manufacturer],
        ),
        series
            ? postgresQuery<{ value: string }>(
                  "SELECT DISTINCT data->>'officialVersion' AS value FROM model_price_candidates WHERE status IN ('pending', 'approved') AND data->>'manufacturer' = $1 AND data->>'series' = $2 UNION SELECT DISTINCT data->>'officialVersion' AS value FROM model_official_price_versions WHERE data->>'manufacturer' = $1 AND data->>'series' = $2 ORDER BY value",
                  [manufacturer, series],
              )
            : Promise.resolve({ rows: [] }),
        series && officialVersion
            ? postgresQuery<{ data: OfficialPriceVersion }>("SELECT data FROM model_official_price_versions WHERE data->>'manufacturer' = $1 AND data->>'series' = $2 AND data->>'officialVersion' = $3 ORDER BY published_at DESC LIMIT $4", [
                  manufacturer,
                  series,
                  officialVersion,
                  PRICING_PAGE_SIZE,
              ])
            : Promise.resolve({ rows: [] }),
        series && officialVersion
            ? postgresQuery<{ data: PriceCandidate }>("SELECT data FROM model_price_candidates WHERE status = 'pending' AND data->>'manufacturer' = $1 AND data->>'series' = $2 AND data->>'officialVersion' = $3 ORDER BY created_at DESC LIMIT $4", [
                  manufacturer,
                  series,
                  officialVersion,
                  PRICING_PAGE_SIZE,
              ])
            : Promise.resolve({ rows: [] }),
    ]);
    return { series: seriesRows.rows.map((row) => row.value), versions: versionRows.rows.map((row) => row.value), approved: approvedRows.rows.map((row) => row.data), pending: pendingRows.rows.map((row) => row.data) };
}

export async function listPricingPage(modelId: string, candidatePage: number, officialPage: number, candidateFilter: PriceCandidateFilter = {}) {
    if (!pricingUsesPostgres()) {
        const state = await readPricingState();
        const versions = state.officialVersions.filter((item) => item.logicalModelId === modelId).toReversed();
        const filteredCandidates = state.candidates.filter(
            (item) =>
                (!candidateFilter.modelId || item.logicalModelId === candidateFilter.modelId) && (!candidateFilter.manufacturer || item.manufacturer === candidateFilter.manufacturer) && (!candidateFilter.status || item.status === candidateFilter.status),
        );
        return {
            candidates: filteredCandidates.toReversed().slice((candidatePage - 1) * PRICING_PAGE_SIZE, candidatePage * PRICING_PAGE_SIZE),
            candidateTotal: filteredCandidates.length,
            candidateAllTotal: state.candidates.length,
            manufacturers: [...new Set(state.candidates.map((item) => item.manufacturer))].sort(),
            candidateModelIds: [...new Set(state.candidates.filter((item) => !candidateFilter.manufacturer || item.manufacturer === candidateFilter.manufacturer).map((item) => item.logicalModelId))],
            officialVersions: versions.slice((officialPage - 1) * PRICING_PAGE_SIZE, officialPage * PRICING_PAGE_SIZE),
            officialTotal: versions.length,
            salesVersions: state.salesVersions.slice(-1),
        };
    }
    await ensurePostgresSchema();
    const clauses: string[] = [];
    const params: string[] = [];
    if (candidateFilter.modelId) {
        params.push(candidateFilter.modelId);
        clauses.push(`logical_model_id = $${params.length}`);
    }
    if (candidateFilter.manufacturer) {
        params.push(candidateFilter.manufacturer);
        clauses.push(`data->>'manufacturer' = $${params.length}`);
    }
    if (candidateFilter.status) {
        params.push(candidateFilter.status);
        clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const [candidates, candidateCount, candidateFacets, versions, versionCount, current] = await Promise.all([
        postgresQuery<{ data: PriceCandidate }>(`SELECT data FROM model_price_candidates${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
            ...params,
            PRICING_PAGE_SIZE,
            (candidatePage - 1) * PRICING_PAGE_SIZE,
        ]),
        postgresQuery<{ count: string }>(`SELECT count(*)::text AS count FROM model_price_candidates${where}`, params),
        postgresQuery<{ manufacturer: string; logical_model_id: string; count: string }>(
            "SELECT data->>'manufacturer' AS manufacturer, logical_model_id, count(*)::text AS count FROM model_price_candidates GROUP BY data->>'manufacturer', logical_model_id ORDER BY manufacturer, logical_model_id",
        ),
        postgresQuery<{ data: OfficialPriceVersion }>("SELECT data FROM model_official_price_versions WHERE logical_model_id = $1 ORDER BY published_at DESC, id DESC LIMIT $2 OFFSET $3", [
            modelId,
            PRICING_PAGE_SIZE,
            (officialPage - 1) * PRICING_PAGE_SIZE,
        ]),
        postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_official_price_versions WHERE logical_model_id = $1", [modelId]),
        getCurrentSalesVersion(),
    ]);
    return {
        candidates: candidates.rows.map((row) => row.data),
        candidateTotal: Number(candidateCount.rows[0]?.count || 0),
        candidateAllTotal: candidateFacets.rows.reduce((sum, row) => sum + Number(row.count), 0),
        manufacturers: [...new Set(candidateFacets.rows.map((row) => row.manufacturer))],
        candidateModelIds: [...new Set(candidateFacets.rows.filter((row) => !candidateFilter.manufacturer || row.manufacturer === candidateFilter.manufacturer).map((row) => row.logical_model_id))],
        officialVersions: versions.rows.map((row) => row.data),
        officialTotal: Number(versionCount.rows[0]?.count || 0),
        salesVersions: current ? [current] : [],
    };
}

export async function insertPriceCandidate(candidate: PriceCandidate) {
    if (!pricingUsesPostgres()) {
        await mutatePricingState((state) => {
            if (
                state.candidates.some(
                    (item) =>
                        item.status === "pending" &&
                        item.logicalModelId === candidate.logicalModelId &&
                        item.manufacturer === candidate.manufacturer &&
                        (candidate.logicalModelId !== "" || item.capability === candidate.capability) &&
                        item.sku === candidate.sku &&
                        item.tier === candidate.tier &&
                        item.processingTier === candidate.processingTier &&
                        item.conditions === candidate.conditions,
                )
            )
                throw new PricingConflictError("相同模型与档位已有待审核价目，请先核对现有候选");
            return { next: { ...state, candidates: [...state.candidates, candidate] }, result: candidate };
        });
        return;
    }
    await ensurePostgresSchema();
    await withPostgresTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [JSON.stringify([candidate.logicalModelId, candidate.manufacturer, candidate.capability, candidate.sku])]);
        const existing = await client.query(
            "SELECT id FROM model_price_candidates WHERE logical_model_id = $1 AND data->>'manufacturer' = $2 AND ($1 <> '' OR COALESCE(data->>'capability', '') = $3) AND status = 'pending' AND data->>'sku' = $4 AND data->>'tier' = $5 AND data->>'conditions' = $6 AND COALESCE(data->>'processingTier', '') = $7 LIMIT 1",
            [candidate.logicalModelId, candidate.manufacturer, candidate.capability || "", candidate.sku, candidate.tier, candidate.conditions, candidate.processingTier || ""],
        );
        if (existing.rows.length) throw new PricingConflictError("相同模型与档位已有待审核价目，请先核对现有候选");
        await client.query("INSERT INTO model_price_candidates (id, logical_model_id, status, created_at, data) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)", [
            candidate.id,
            candidate.logicalModelId,
            candidate.status,
            candidate.createdAt,
            JSON.stringify(candidate),
        ]);
    });
}

async function assertNoFilePriceContracts(versionIds: string[]) {
    if (!versionIds.length) return;
    for (const file of ["model-pricing-token-contracts.json", "model-pricing-video-contracts.json", "model-pricing-audio-contracts.json", "model-pricing-image-contracts.json"]) {
        const state = await readJsonDataFile<{ contracts: Array<{ officialVersionId: string }> }>(file, { contracts: [] });
        if (state.contracts?.some((contract) => versionIds.includes(contract.officialVersionId))) throw new PricingConflictError("该官方价已有计费契约，不能直接修改或删除");
    }
}

export async function revisePriceCandidate(id: string, expectedRevision: string | null, revise: (candidate: PriceCandidate) => PriceCandidate): Promise<PriceCandidate> {
    const apply = (existing: PriceCandidate) => {
        if ((existing.revision || null) !== expectedRevision) throw new PricingConflictError("价目已变化，请刷新后重试");
        const candidate = revise(existing);
        if (candidate.logicalModelId !== existing.logicalModelId) throw new PricingInputError("修订候选不能更换逻辑模型");
        return candidate;
    };
    if (!pricingUsesPostgres())
        return mutatePricingState(async (state) => {
            const existing = state.candidates.find((item) => item.id === id);
            if (!existing) throw new PricingInputError("价目候选不存在");
            const candidate = apply(existing);
            const version = state.officialVersions.find((item) => item.candidateId === id);
            if (state.officialVersions.some((item) => item.linkedFromVersionId && state.officialVersions.some((source) => source.id === item.linkedFromVersionId && source.candidateId === id)))
                throw new PricingConflictError("该官网价已关联逻辑模型，不能修改候选");
            if (version && (state.priceBindings?.some((binding) => binding.officialVersionId === version.id) || state.salesVersions.some((sales) => sales.selectedPriceBindings?.some((ref) => ref.officialVersionId === version.id))))
                throw new PricingConflictError("该官方价已有独立选价或销售引用，不能修改候选");
            if (version && state.salesVersions.some((sales) => Object.values(sales.priceVersionIds).includes(version.id))) throw new PricingConflictError("该官方价已被销售版本引用，不能直接修改或删除");
            if (version && Object.values(state.textUsageRules || {}).some((rules) => rules.some((rule) => rule.officialVersionId === version.id))) throw new PricingConflictError("该官方价已有文本用量规则，不能直接修改或删除");
            if (version) await assertNoFilePriceContracts([version.id]);
            if (
                state.candidates.some(
                    (item) =>
                        item.id !== id &&
                        item.status === "pending" &&
                        item.logicalModelId === candidate.logicalModelId &&
                        item.manufacturer === candidate.manufacturer &&
                        (candidate.logicalModelId !== "" || item.capability === candidate.capability) &&
                        item.sku === candidate.sku &&
                        item.tier === candidate.tier &&
                        item.processingTier === candidate.processingTier &&
                        item.conditions === candidate.conditions,
                )
            )
                throw new PricingConflictError("相同模型与档位已有待审核价目，请先核对现有候选");
            return { next: { ...state, candidates: state.candidates.map((item) => (item.id === id ? candidate : item)), officialVersions: state.officialVersions.filter((item) => item.candidateId !== id) }, result: candidate };
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ data: PriceCandidate }>("SELECT data FROM model_price_candidates WHERE id = $1 FOR UPDATE", [id]);
        const existing = row.rows[0]?.data;
        if (!existing) throw new PricingInputError("价目候选不存在");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [JSON.stringify([existing.logicalModelId, existing.manufacturer, existing.capability, existing.sku])]);
        await client.query("SELECT id FROM model_pricing_state WHERE id = 'default' FOR UPDATE");
        const candidate = apply(existing);
        const versions = await client.query<{ id: string }>("SELECT id FROM model_official_price_versions WHERE data->>'candidateId' = $1 FOR UPDATE", [id]);
        if (versions.rows.length) {
            const linked = await client.query("SELECT 1 FROM model_official_price_versions WHERE data->>'linkedFromVersionId' = ANY($1::text[]) LIMIT 1", [versions.rows.map((item) => item.id)]);
            if (linked.rows.length) throw new PricingConflictError("该官网价已关联逻辑模型，不能修改候选");
        }
        for (const version of versions.rows) {
            const selected = await client.query(
                "SELECT 1 FROM model_price_bindings WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_sales_price_versions WHERE data->'selectedPriceBindings' @> jsonb_build_array(jsonb_build_object('officialVersionId', $1::text)) LIMIT 1",
                [version.id],
            );
            if (selected.rows.length) throw new PricingConflictError("该官方价已有独立选价或销售引用，不能修改候选");
            const bound = await client.query("SELECT id FROM model_sales_price_versions WHERE data->'priceVersionIds'->>$1 = $2 LIMIT 1", [existing.logicalModelId, version.id]);
            if (bound.rows.length) throw new PricingConflictError("该官方价已被销售版本引用，不能直接修改或删除");
            const usageRules = await client.query("SELECT 1 FROM model_text_usage_rules WHERE official_version_id = $1 LIMIT 1", [version.id]);
            if (usageRules.rows.length) throw new PricingConflictError("该官方价已有文本用量规则，不能直接修改或删除");
            const contracts = await client.query(
                "SELECT 1 FROM model_flat_text_price_contracts WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_video_price_contracts WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_audio_price_contracts WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_image_price_contracts WHERE official_version_id = $1 LIMIT 1",
                [version.id],
            );
            if (contracts.rows.length) throw new PricingConflictError("该官方价已有计费契约，不能直接修改或删除");
        }
        const duplicate = await client.query(
            "SELECT id FROM model_price_candidates WHERE id <> $1 AND status = 'pending' AND logical_model_id = $2 AND data->>'manufacturer' = $3 AND ($2 <> '' OR COALESCE(data->>'capability', '') = $4) AND data->>'sku' = $5 AND data->>'tier' = $6 AND data->>'conditions' = $7 AND COALESCE(data->>'processingTier', '') = $8 LIMIT 1",
            [id, candidate.logicalModelId, candidate.manufacturer, candidate.capability || "", candidate.sku, candidate.tier, candidate.conditions, candidate.processingTier || ""],
        );
        if (duplicate.rows.length) throw new PricingConflictError("相同模型与档位已有待审核价目，请先核对现有候选");
        for (const version of versions.rows) await client.query("DELETE FROM model_official_price_versions WHERE id = $1", [version.id]);
        await client.query("UPDATE model_price_candidates SET status = $2, data = $3::jsonb WHERE id = $1", [id, candidate.status, JSON.stringify(candidate)]);
        return candidate;
    });
}

export async function deletePriceCandidate(id: string, expectedRevision: string | null): Promise<void> {
    if (!pricingUsesPostgres()) {
        const contractFiles = ["model-pricing-token-contracts.json", "model-pricing-video-contracts.json", "model-pricing-audio-contracts.json", "model-pricing-image-contracts.json"];
        await withJsonDataFileLocks([FILE, "auth.json", "generation-tasks.json", ...contractFiles], async () => {
            const state = await readPricingState();
            const existing = state.candidates.find((item) => item.id === id);
            if (!existing) throw new PricingInputError("价目候选不存在");
            if ((existing.revision || null) !== expectedRevision) throw new PricingConflictError("价目已变化，请刷新后重试");
            const versions = state.officialVersions.filter((item) => item.candidateId === id);
            if (versions.some((item) => item.linkedFromVersionId)) throw new PricingConflictError("该官网价已关联逻辑模型，不能删除候选");
            const versionIds = new Set(versions.map((item) => item.id));
            if (state.priceBindings?.some((binding) => versionIds.has(binding.officialVersionId || "")) || state.salesVersions.some((sales) => sales.selectedPriceBindings?.some((ref) => versionIds.has(ref.officialVersionId))))
                throw new PricingConflictError("该官方价已有独立选价或销售引用，不能删除候选");
            if (state.salesVersions.some((sales) => Object.values(sales.priceVersionIds).some((versionId) => versionIds.has(versionId)))) throw new PricingConflictError("该官方价已被销售版本引用，不能删除候选");
            if (Object.values(state.textUsageRules || {}).some((rules) => rules.some((rule) => versionIds.has(rule.officialVersionId)))) throw new PricingConflictError("该官方价已有文本用量规则，不能删除候选");
            if (Object.values(state.billingActivations || {}).some((activation) => versionIds.has(activation.officialVersionId))) throw new PricingConflictError("该官方价已有按量激活记录，不能删除候选");
            const auth = await readJsonDataFile<{ pricingReservations?: Array<{ frozen?: { version?: { id?: string } } }> }>("auth.json", {});
            const tasks = await readJsonDataFile<Array<{ payload?: { billingMode?: string; pricingSnapshot?: { officialVersionId?: string }; billingApproval?: { officialVersionId?: string } } }>>("generation-tasks.json", []);
            if (
                auth.pricingReservations?.some((item) => versionIds.has(item.frozen?.version?.id || "")) ||
                (Array.isArray(tasks) &&
                    tasks.some((item) => item.payload?.billingMode === "official-usage" && (versionIds.has(item.payload.pricingSnapshot?.officialVersionId || "") || versionIds.has(item.payload.billingApproval?.officialVersionId || ""))))
            )
                throw new PricingConflictError("该官方价已有真实按量调用或预扣记录，不能删除");
            const contractStates = await Promise.all(contractFiles.map((file) => readJsonDataFile<{ contracts: Array<{ officialVersionId: string }> }>(file, { contracts: [] })));
            if (contractStates.some((contractState) => contractState.contracts?.some((contract) => versionIds.has(contract.officialVersionId)))) throw new PricingConflictError("该官方价已有计费契约，不能删除候选");
            await writeJsonDataFile(FILE, {
                ...state,
                candidates: state.candidates.filter((item) => item.id !== id),
                officialVersions: state.officialVersions.filter((item) => item.candidateId !== id),
            });
        });
        return;
    }
    await ensurePostgresSchema();
    await withPostgresTransaction(async (client) => {
        const row = await client.query<{ data: PriceCandidate }>("SELECT data FROM model_price_candidates WHERE id = $1 FOR UPDATE", [id]);
        const existing = row.rows[0]?.data;
        if (!existing) throw new PricingInputError("价目候选不存在");
        if ((existing.revision || null) !== expectedRevision) throw new PricingConflictError("价目已变化，请刷新后重试");
        await client.query("SELECT id FROM model_pricing_state WHERE id = 'default' FOR UPDATE");
        const versions = await client.query<{ id: string }>("SELECT id FROM model_official_price_versions WHERE data->>'candidateId' = $1 FOR UPDATE", [id]);
        if (versions.rows.length) {
            const linked = await client.query("SELECT 1 FROM model_official_price_versions WHERE data->>'linkedFromVersionId' = ANY($1::text[]) LIMIT 1", [versions.rows.map((item) => item.id)]);
            if (linked.rows.length) throw new PricingConflictError("该官网价已关联逻辑模型，不能删除候选");
        }
        for (const version of versions.rows) {
            const selected = await client.query(
                "SELECT 1 FROM model_price_bindings WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_sales_price_versions WHERE data->'selectedPriceBindings' @> jsonb_build_array(jsonb_build_object('officialVersionId', $1::text)) LIMIT 1",
                [version.id],
            );
            if (selected.rows.length) throw new PricingConflictError("该官方价已有独立选价或销售引用，不能删除候选");
            const bound = await client.query("SELECT 1 FROM model_sales_price_versions WHERE data->'priceVersionIds'->>$1 = $2 LIMIT 1", [existing.logicalModelId, version.id]);
            if (bound.rows.length) throw new PricingConflictError("该官方价已被销售版本引用，不能删除候选");
            const usageRules = await client.query("SELECT 1 FROM model_text_usage_rules WHERE official_version_id = $1 LIMIT 1", [version.id]);
            if (usageRules.rows.length) throw new PricingConflictError("该官方价已有文本用量规则，不能删除候选");
            const activated = await client.query("SELECT 1 FROM model_pricing_state s CROSS JOIN LATERAL jsonb_each(s.billing_activations) AS activation WHERE s.id = 'default' AND activation.value->>'officialVersionId' = $1 LIMIT 1", [version.id]);
            if (activated.rows.length) throw new PricingConflictError("该官方价已有按量激活记录，不能删除候选");
            const used = await client.query("SELECT 1 FROM model_pricing_wallet_reservations WHERE data #>> '{frozen,version,id}' = $1 LIMIT 1", [version.id]);
            const tasks = await client.query(
                "SELECT 1 FROM generation_tasks WHERE payload->>'billingMode' = 'official-usage' AND (payload #>> '{pricingSnapshot,officialVersionId}' = $1 OR payload #>> '{billingApproval,officialVersionId}' = $1) LIMIT 1",
                [version.id],
            );
            if (used.rows.length || tasks.rows.length) throw new PricingConflictError("该官方价已有真实按量调用或预扣记录，不能删除");
            const contracts = await client.query(
                "SELECT 1 FROM model_flat_text_price_contracts WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_video_price_contracts WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_audio_price_contracts WHERE official_version_id = $1 UNION ALL SELECT 1 FROM model_image_price_contracts WHERE official_version_id = $1 LIMIT 1",
                [version.id],
            );
            if (contracts.rows.length) throw new PricingConflictError("该官方价已有计费契约，不能删除候选");
            await client.query("DELETE FROM model_official_price_versions WHERE id = $1", [version.id]);
        }
        await client.query("DELETE FROM model_price_candidates WHERE id = $1", [id]);
    });
}

export async function updatePriceCandidate<T>(id: string, update: (candidate: PriceCandidate) => { candidate: PriceCandidate; version?: OfficialPriceVersion; result: T }): Promise<T> {
    if (!pricingUsesPostgres()) {
        return mutatePricingState((state) => {
            const existing = state.candidates.find((item) => item.id === id);
            if (!existing) throw new PricingInputError("待审核价目不存在");
            if (existing.status !== "pending") throw new PricingConflictError("价目已审核，请刷新列表");
            const { candidate, version, result } = update(existing);
            return { next: { ...state, candidates: state.candidates.map((item) => (item.id === id ? candidate : item)), officialVersions: version ? [...state.officialVersions, version] : state.officialVersions }, result };
        });
    }
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const row = await client.query<{ data: PriceCandidate }>("SELECT data FROM model_price_candidates WHERE id = $1 FOR UPDATE", [id]);
        const existing = row.rows[0]?.data;
        if (!existing) throw new PricingInputError("待审核价目不存在");
        if (existing.status !== "pending") throw new PricingConflictError("价目已审核，请刷新列表");
        const { candidate, version, result } = update(existing);
        await client.query("UPDATE model_price_candidates SET status = $2, data = $3::jsonb WHERE id = $1", [id, candidate.status, JSON.stringify(candidate)]);
        if (version)
            await client.query("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [version.id, version.logicalModelId, version.publishedAt, JSON.stringify(version)]);
        return result;
    });
}

export async function insertSalesVersion(version: SalesVersion, expectedCurrentId: string | null, verifyCurrentExchangeRate = false) {
    if (version.selectedPriceBindings?.some((selection) => version.priceVersionIds[selection.logicalModelId])) throw new PricingConflictError("同一模型不能同时发布旧式价目映射和独立选价");
    if (!pricingUsesPostgres()) {
        return mutatePricingState((state) => {
            if ((state.salesVersions.at(-1)?.id || null) !== expectedCurrentId) throw new PricingConflictError("销售版本已变化，请重新预览");
            if (
                verifyCurrentExchangeRate &&
                (!version.conversion || !state.exchangeRate || version.conversion.cnyPerUsd !== state.exchangeRate.cnyPerUsd || version.conversion.observedAt !== state.exchangeRate.observedAt || version.conversion.evidence !== state.exchangeRate.evidence)
            )
                throw new PricingConflictError("汇率已变化，请重新预览");
            if (Object.entries(version.priceVersionIds).some(([modelId, id]) => !state.officialVersions.some((item) => item.id === id && item.logicalModelId === modelId && !item.textPriceSchedule)))
                throw new PricingConflictError("官方价版本已变化，请重新预览");
            if (
                version.selectedPriceBindings?.some(
                    (ref) =>
                        !state.priceBindings?.some(
                            (binding) =>
                                binding.id === ref.bindingId &&
                                binding.revision === ref.bindingRevision &&
                                binding.logicalModelId === ref.logicalModelId &&
                                binding.scope === ref.scope &&
                                binding.officialVersionId === ref.officialVersionId &&
                                binding.current &&
                                binding.status === "active",
                        ) || !state.officialVersions.some((price) => price.id === ref.officialVersionId && !price.logicalModelId),
                )
            )
                throw new PricingConflictError("独立选价绑定已变化，请重新预览");
            return { next: { ...state, salesVersions: [...state.salesVersions, version] }, result: version };
        });
    }
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const record = await client.query<{ current_sales_version_id: string | null; exchange_rate: BusinessExchangeRate | null }>("SELECT current_sales_version_id, exchange_rate FROM model_pricing_state WHERE id = 'default' FOR UPDATE");
        if ((record.rows[0]?.current_sales_version_id || null) !== expectedCurrentId) throw new PricingConflictError("销售版本已变化，请重新预览");
        const currentRate = record.rows[0]?.exchange_rate;
        if (verifyCurrentExchangeRate && (!version.conversion || !currentRate || version.conversion.cnyPerUsd !== currentRate.cnyPerUsd || version.conversion.observedAt !== currentRate.observedAt || version.conversion.evidence !== currentRate.evidence))
            throw new PricingConflictError("汇率已变化，请重新预览");
        const bindings = Object.entries(version.priceVersionIds);
        if (bindings.length) {
            const current = await client.query<{ id: string; logical_model_id: string; data: OfficialPriceVersion }>("SELECT id, logical_model_id, data FROM model_official_price_versions WHERE id = ANY($1::text[])", [bindings.map(([, id]) => id)]);
            if (bindings.some(([modelId, id]) => !current.rows.some((item) => item.id === id && item.logical_model_id === modelId && !item.data.textPriceSchedule))) throw new PricingConflictError("官方价版本已变化，请重新预览");
        }
        const selections = version.selectedPriceBindings || [];
        for (const ref of [...selections].sort((a, b) => a.logicalModelId.localeCompare(b.logicalModelId) || a.scope.localeCompare(b.scope)))
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", [ref.logicalModelId, ref.scope]);
        if (selections.length) {
            const selected = await client.query<{ data: ModelPriceBinding; current: boolean }>("SELECT data, current FROM model_price_bindings WHERE id = ANY($1::text[])", [selections.map((ref) => ref.bindingId)]);
            const prices = await client.query<{ id: string; data: OfficialPriceVersion }>("SELECT id, data FROM model_official_price_versions WHERE id = ANY($1::text[])", [selections.map((ref) => ref.officialVersionId)]);
            if (
                selections.some(
                    (ref) =>
                        !selected.rows.some(
                            ({ data, current }) =>
                                current &&
                                data.status === "active" &&
                                data.id === ref.bindingId &&
                                data.revision === ref.bindingRevision &&
                                data.logicalModelId === ref.logicalModelId &&
                                data.scope === ref.scope &&
                                data.officialVersionId === ref.officialVersionId,
                        ) || !prices.rows.some(({ id, data }) => id === ref.officialVersionId && !data.logicalModelId),
                )
            )
                throw new PricingConflictError("独立选价绑定已变化，请重新预览");
        }
        await client.query("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [version.id, version.publishedAt, JSON.stringify(version)]);
        await client.query("UPDATE model_pricing_state SET current_sales_version_id = $1, updated_at = now() WHERE id = 'default'", [version.id]);
        return version;
    });
}
