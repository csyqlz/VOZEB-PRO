import { randomUUID } from "node:crypto";

import { PricingConflictError } from "@/lib/model-pricing";
import { readJsonDataFile, withJsonDataFileLocks, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import { PRICING_PAGE_SIZE, readPricingState } from "./model-pricing-store";
import type { HailuoPriceContract } from "./model-pricing-hailuo-contract";
import type { VideoPriceContract, VideoPriceContractInput } from "./model-pricing-video-contract";

const FILE = "model-pricing-video-contracts.json";
export type ReviewedVideoPriceContract = VideoPriceContract | HailuoPriceContract;
export type ReviewedVideoPriceContractInput = VideoPriceContractInput | Omit<HailuoPriceContract, "officialVersionId" | "reviewedBy" | "reviewedAt">;
type StoredContract = ReviewedVideoPriceContract & { id: string; current: boolean };
type FileState = { contracts: StoredContract[] };
const EMPTY_STATE: FileState = { contracts: [] };

export async function listVideoPriceContracts(officialVersionId: string, channelId: string, requestedModel: string): Promise<StoredContract[]> {
    if (getDatabaseProvider() !== "postgres") {
        const state = await readJsonDataFile(FILE, EMPTY_STATE);
        return state.contracts
            .filter((item) => item.officialVersionId === officialVersionId && item.channelId === channelId && item.requestedModel === requestedModel)
            .sort((a, b) => Number(b.current) - Number(a.current) || b.reviewedAt.localeCompare(a.reviewedAt) || b.id.localeCompare(a.id))
            .slice(0, PRICING_PAGE_SIZE);
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ id: string; current: boolean; data: ReviewedVideoPriceContract }>(
        "SELECT id, current, data FROM model_video_price_contracts WHERE official_version_id = $1 AND channel_id = $2 AND requested_model = $3 ORDER BY current DESC, reviewed_at DESC, id DESC LIMIT $4",
        [officialVersionId, channelId, requestedModel, PRICING_PAGE_SIZE],
    );
    return result.rows.map((row) => ({ ...row.data, id: row.id, current: row.current }));
}

export async function listCurrentVideoPriceContracts(officialVersionIds: string[]): Promise<StoredContract[]> {
    if (!officialVersionIds.length) return [];
    if (getDatabaseProvider() !== "postgres") {
        const wanted = new Set(officialVersionIds);
        return (await readJsonDataFile(FILE, EMPTY_STATE)).contracts.filter((item) => item.current && wanted.has(item.officialVersionId));
    }
    await ensurePostgresSchema();
    const result = await postgresQuery<{ id: string; data: ReviewedVideoPriceContract }>("SELECT id, data FROM model_video_price_contracts WHERE current AND official_version_id = ANY($1::text[])", [officialVersionIds]);
    return result.rows.map((row) => ({ ...row.data, id: row.id, current: true }));
}

export async function saveVideoPriceContract(contract: ReviewedVideoPriceContract, expectedCurrentId: string | null): Promise<StoredContract> {
    const next: StoredContract = { ...contract, id: randomUUID(), current: true };
    if (getDatabaseProvider() !== "postgres")
        return withJsonDataFileLocks(["model-pricing.json", FILE], async () => {
            if (!(await readPricingState()).officialVersions.some((price) => price.id === contract.officialVersionId)) throw new PricingConflictError("官方价版本已变化，请刷新后重新核对");
            const state = await readJsonDataFile(FILE, EMPTY_STATE);
            const current = state.contracts.find((item) => item.current && item.officialVersionId === contract.officialVersionId && item.channelId === contract.channelId && item.requestedModel === contract.requestedModel);
            if ((current?.id || null) !== expectedCurrentId) throw new PricingConflictError("计费契约已变化，请刷新后重新核对");
            await writeJsonDataFile(FILE, { contracts: [...state.contracts.map((item) => (item.id === current?.id ? { ...item, current: false } : item)), next] });
            return next;
        });
    await ensurePostgresSchema();
    try {
        return await withPostgresTransaction(async (client) => {
            const current = await client.query<{ id: string }>("SELECT id FROM model_video_price_contracts WHERE official_version_id = $1 AND channel_id = $2 AND requested_model = $3 AND current FOR UPDATE", [
                contract.officialVersionId,
                contract.channelId,
                contract.requestedModel,
            ]);
            if ((current.rows[0]?.id || null) !== expectedCurrentId) throw new PricingConflictError("计费契约已变化，请刷新后重新核对");
            if (current.rows[0]) await client.query("UPDATE model_video_price_contracts SET current = false WHERE id = $1", [current.rows[0].id]);
            await client.query("INSERT INTO model_video_price_contracts (id, official_version_id, channel_id, requested_model, reviewed_at, current, data) VALUES ($1, $2, $3, $4, $5::timestamptz, true, $6::jsonb)", [
                next.id,
                contract.officialVersionId,
                contract.channelId,
                contract.requestedModel,
                contract.reviewedAt,
                JSON.stringify(contract),
            ]);
            return next;
        });
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new PricingConflictError("计费契约已变化，请刷新后重新核对");
        throw error;
    }
}
