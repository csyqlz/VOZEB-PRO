import { ensurePostgresSchema, postgresQuery } from "@/lib/server/database";
import { listDataDirectory, readJsonDataFile } from "./data-adapter";
import { PricingConflictError, type OfficialPriceCatalogEntry } from "@/lib/model-pricing";

import { mutatePricingState, pricingUsesPostgres, readPricingState } from "./model-pricing-store";

export async function getOfficialPriceCatalogUsage(entry: OfficialPriceCatalogEntry): Promise<{ pending: number; approved: number; called: boolean }> {
    if (entry.kind !== "version") return { pending: 0, approved: 0, called: false };
    if (!pricingUsesPostgres()) {
        const state = await readPricingState();
        return {
            pending: state.candidates.filter((item) => item.status === "pending" && item.manufacturer === entry.manufacturer && (item.catalogVersionId === entry.id || item.sku === entry.sku)).length,
            approved: state.officialVersions.filter((item) => item.manufacturer === entry.manufacturer && (item.catalogVersionId === entry.id || item.sku === entry.sku)).length,
            called: await hasCallHistory(entry),
        };
    }
    await ensurePostgresSchema();
    const [pending, approved, called] = await Promise.all([
        postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_price_candidates WHERE status = 'pending' AND data->>'manufacturer' = $1 AND (data->>'catalogVersionId' = $2 OR data->>'sku' = $3)", [
            entry.manufacturer,
            entry.id,
            entry.sku,
        ]),
        postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_official_price_versions WHERE data->>'manufacturer' = $1 AND (data->>'catalogVersionId' = $2 OR data->>'sku' = $3)", [entry.manufacturer, entry.id, entry.sku]),
        hasCallHistory(entry),
    ]);
    return { pending: Number(pending.rows[0]?.count || 0), approved: Number(approved.rows[0]?.count || 0), called };
}

async function hasCallHistory(entry: OfficialPriceCatalogEntry): Promise<boolean> {
    if (entry.kind !== "version" || !entry.sku) return false;
    if (pricingUsesPostgres()) {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ used: boolean }>(
            `
            SELECT EXISTS (
                SELECT 1 FROM model_official_price_versions v
                WHERE v.data->>'manufacturer' = $1 AND v.data->>'sku' = $2
                  AND (
                    EXISTS (SELECT 1 FROM model_pricing_wallet_reservations r WHERE r.data #>> '{frozen,version,id}' = v.id)
                    OR EXISTS (SELECT 1 FROM generation_tasks t WHERE t.status IN ('running', 'success', 'error', 'paused', 'cancelled') AND (t.payload #>> '{pricingSnapshot,officialVersionId}' = v.id OR t.payload #>> '{billingApproval,officialVersionId}' = v.id OR t.payload #>> '{config,logicalModel}' = v.logical_model_id OR t.payload #>> '{config,model}' = v.logical_model_id))
                    OR EXISTS (SELECT 1 FROM model_pricing_shadow_calls c WHERE c.data #>> '{frozen,version,id}' = v.id)
                  )
            ) OR EXISTS (
                SELECT 1 FROM generation_tasks t WHERE t.status IN ('running', 'success', 'error', 'paused', 'cancelled')
                  AND (t.payload #>> '{config,model}' = $2 OR t.payload #>> '{config,upstreamModel}' = $2)
            ) AS used`,
            [entry.manufacturer, entry.sku],
        );
        return Boolean(result.rows[0]?.used);
    }
    const versions = (await readPricingState()).officialVersions.filter((version) => version.manufacturer === entry.manufacturer && version.sku === entry.sku);
    const versionIds = new Set(versions.map((version) => version.id));
    const modelIds = new Set(versions.map((version) => version.logicalModelId));
    const [auth, tasks] = await Promise.all([
        readJsonDataFile<{ pricingReservations?: Array<{ frozen?: { version?: { id?: string } } }> }>("auth.json", {}),
        readJsonDataFile<Array<{ status?: string; payload?: { pricingSnapshot?: { officialVersionId?: string }; billingApproval?: { officialVersionId?: string }; config?: { logicalModel?: string; model?: string; upstreamModel?: string } } }>>(
            "generation-tasks.json",
            [],
        ),
    ]);
    if (
        auth.pricingReservations?.some((item) => versionIds.has(item.frozen?.version?.id || "")) ||
        (Array.isArray(tasks) &&
            tasks.some(
                (item) =>
                    ["running", "success", "error", "paused", "cancelled"].includes(item.status || "") &&
                    (versionIds.has(item.payload?.pricingSnapshot?.officialVersionId || "") ||
                        versionIds.has(item.payload?.billingApproval?.officialVersionId || "") ||
                        modelIds.has(item.payload?.config?.logicalModel || "") ||
                        modelIds.has(item.payload?.config?.model || "") ||
                        item.payload?.config?.model === entry.sku ||
                        item.payload?.config?.upstreamModel === entry.sku),
            ))
    )
        return true;
    try {
        for (const file of await listDataDirectory("model-pricing-shadow")) {
            if (!file.isFile() || !file.name.endsWith(".json")) continue;
            const account = await readJsonDataFile<{ calls?: Array<{ frozen?: { version?: { id?: string } } }> }>(`model-pricing-shadow/${file.name}`, {});
            if (account.calls?.some((call) => versionIds.has(call.frozen?.version?.id || ""))) return true;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return false;
}

export async function listOfficialPriceCatalog(manufacturer: string): Promise<OfficialPriceCatalogEntry[]> {
    if (!pricingUsesPostgres()) return (await readPricingState()).officialCatalog?.filter((entry) => entry.manufacturer === manufacturer) || [];
    await ensurePostgresSchema();
    const result = await postgresQuery<{ data: OfficialPriceCatalogEntry }>("SELECT data FROM model_official_price_catalog WHERE manufacturer = $1 ORDER BY kind, name, id", [manufacturer]);
    return result.rows.map((row) => row.data);
}

export async function insertOfficialPriceCatalog(entry: OfficialPriceCatalogEntry): Promise<OfficialPriceCatalogEntry> {
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const existing = state.officialCatalog || [];
            const duplicate = existing.some(
                (item) =>
                    item.manufacturer === entry.manufacturer &&
                    item.kind === entry.kind &&
                    (entry.kind === "series"
                        ? item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()
                        : (item.parentId === entry.parentId && item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()) || item.sku?.toLocaleLowerCase() === entry.sku?.toLocaleLowerCase()),
            );
            if (duplicate) throw new PricingConflictError("该厂商已有同名系列、型号或模型 ID");
            return { next: { ...state, officialCatalog: [...existing, entry] }, result: entry };
        });
    await ensurePostgresSchema();
    try {
        await postgresQuery("INSERT INTO model_official_price_catalog (id, manufacturer, kind, parent_id, name, sku, created_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)", [
            entry.id,
            entry.manufacturer,
            entry.kind,
            entry.parentId,
            entry.name,
            entry.sku,
            entry.createdAt,
            JSON.stringify(entry),
        ]);
    } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new PricingConflictError("该厂商已有同名系列、型号或模型 ID");
        throw error;
    }
    return entry;
}

export async function updateOfficialPriceCatalog(entry: OfficialPriceCatalogEntry, expected: OfficialPriceCatalogEntry): Promise<OfficialPriceCatalogEntry> {
    if (entry.kind === "version" && (entry.sku !== expected.sku || entry.parentId !== expected.parentId)) {
        const usage = await getOfficialPriceCatalogUsage(expected);
        if (usage.pending || usage.approved || usage.called) throw new PricingConflictError("该型号已有待审价目、已审核价目或真实调用，不能修改官方模型 ID 或所属系列");
    }
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const entries = state.officialCatalog || [];
            const current = entries.find((item) => item.id === entry.id);
            if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new PricingConflictError("目录项已变化，请刷新后重试");
            if (
                entries.some(
                    (item) =>
                        item.id !== entry.id &&
                        item.manufacturer === entry.manufacturer &&
                        item.kind === entry.kind &&
                        (entry.kind === "series"
                            ? item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()
                            : (item.parentId === entry.parentId && item.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()) || item.sku?.toLocaleLowerCase() === entry.sku?.toLocaleLowerCase()),
                )
            )
                throw new PricingConflictError("该厂商已有同名系列、型号或模型 ID");
            return { next: { ...state, officialCatalog: entries.map((item) => (item.id === entry.id ? entry : item)) }, result: entry };
        });
    await ensurePostgresSchema();
    try {
        const result = await postgresQuery(
            "UPDATE model_official_price_catalog SET parent_id = $5, name = $6, sku = $7, data = $8::jsonb WHERE id = $1 AND manufacturer = $2 AND kind = $3 AND data = $4::jsonb AND (($7::text IS NOT DISTINCT FROM $9::text AND $5::text IS NOT DISTINCT FROM $10::text) OR (NOT EXISTS (SELECT 1 FROM model_official_price_versions WHERE data->>'manufacturer' = $2 AND (data->>'sku' = $9 OR data->>'catalogVersionId' = $1)) AND NOT EXISTS (SELECT 1 FROM model_price_candidates WHERE status = 'pending' AND data->>'manufacturer' = $2 AND (data->>'sku' = $9 OR data->>'catalogVersionId' = $1)) AND NOT EXISTS (SELECT 1 FROM generation_tasks t WHERE t.status IN ('running', 'success', 'error', 'paused', 'cancelled') AND (t.payload #>> '{config,model}' = $9 OR t.payload #>> '{config,upstreamModel}' = $9)))) RETURNING id",
            [entry.id, entry.manufacturer, entry.kind, JSON.stringify(expected), entry.parentId, entry.name, entry.sku, JSON.stringify(entry), expected.sku, expected.parentId],
        );
        if (!result.rowCount) {
            if (entry.kind === "version" && (entry.sku !== expected.sku || entry.parentId !== expected.parentId)) {
                const usage = await getOfficialPriceCatalogUsage(expected);
                if (usage.pending || usage.approved || usage.called) throw new PricingConflictError("该型号已有待审价目、已审核价目或真实调用，不能修改官方模型 ID 或所属系列");
            }
            throw new PricingConflictError("目录项已变化，请刷新后重试");
        }
    } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new PricingConflictError("该厂商已有同名系列、型号或模型 ID");
        if ((error as { code?: string }).code === "23503") throw new PricingConflictError("所属系列已变化，请刷新后重试");
        throw error;
    }
    return entry;
}

export async function deleteOfficialPriceCatalog(entry: OfficialPriceCatalogEntry): Promise<void> {
    const usage = await getOfficialPriceCatalogUsage(entry);
    if (usage.pending || usage.approved || usage.called) throw new PricingConflictError("该型号已有待审价目、已审核价目或真实调用，不能删除；请保留目录身份");
    if (!pricingUsesPostgres())
        return mutatePricingState((state) => {
            const entries = state.officialCatalog || [];
            const current = entries.find((item) => item.id === entry.id);
            if (!current || JSON.stringify(current) !== JSON.stringify(entry)) throw new PricingConflictError("目录项已变化，请刷新后重试");
            if (
                entry.kind === "version" &&
                [...state.officialVersions, ...state.candidates.filter((candidate) => candidate.status === "pending")].some((version) => version.manufacturer === entry.manufacturer && (version.sku === entry.sku || version.catalogVersionId === entry.id))
            )
                throw new PricingConflictError("该型号已有价目引用，不能删除");
            if (entries.some((item) => item.parentId === entry.id)) throw new PricingConflictError("请先删除或调整该系列下的型号");
            return { next: { ...state, officialCatalog: entries.filter((item) => item.id !== entry.id) }, result: undefined };
        });
    await ensurePostgresSchema();
    try {
        const result = await postgresQuery(
            `DELETE FROM model_official_price_catalog
            WHERE id = $1 AND manufacturer = $2 AND kind = $3 AND data = $4::jsonb
              AND NOT EXISTS (SELECT 1 FROM model_official_price_versions v WHERE v.data->>'manufacturer' = $2 AND (v.data->>'sku' = $5 OR v.data->>'catalogVersionId' = $1))
              AND NOT EXISTS (SELECT 1 FROM model_price_candidates c WHERE c.status = 'pending' AND c.data->>'manufacturer' = $2 AND (c.data->>'sku' = $5 OR c.data->>'catalogVersionId' = $1))
              AND NOT EXISTS (SELECT 1 FROM generation_tasks t WHERE t.status IN ('running', 'success', 'error', 'paused', 'cancelled') AND (t.payload #>> '{config,model}' = $5 OR t.payload #>> '{config,upstreamModel}' = $5))
              AND NOT EXISTS (
                SELECT 1 FROM model_official_price_versions v
                WHERE v.data->>'manufacturer' = $2 AND v.data->>'sku' = $5
                  AND (
                    EXISTS (SELECT 1 FROM model_pricing_wallet_reservations r WHERE r.data #>> '{frozen,version,id}' = v.id)
                    OR EXISTS (SELECT 1 FROM generation_tasks t WHERE t.status IN ('running', 'success', 'error', 'paused', 'cancelled') AND (t.payload #>> '{pricingSnapshot,officialVersionId}' = v.id OR t.payload #>> '{billingApproval,officialVersionId}' = v.id OR t.payload #>> '{config,logicalModel}' = v.logical_model_id OR t.payload #>> '{config,model}' = v.logical_model_id))
                    OR EXISTS (SELECT 1 FROM model_pricing_shadow_calls c WHERE c.data #>> '{frozen,version,id}' = v.id)
                  )
              ) RETURNING id`,
            [entry.id, entry.manufacturer, entry.kind, JSON.stringify(entry), entry.sku],
        );
        if (!result.rowCount) {
            const currentUsage = await getOfficialPriceCatalogUsage(entry);
            if (currentUsage.pending || currentUsage.approved || currentUsage.called) throw new PricingConflictError("该型号已有待审价目、已审核价目或真实调用，不能删除；请保留目录身份");
            throw new PricingConflictError("目录项已变化，请刷新后重试");
        }
    } catch (error) {
        if ((error as { code?: string }).code === "23503") throw new PricingConflictError("请先删除或调整该系列下的型号");
        throw error;
    }
}
