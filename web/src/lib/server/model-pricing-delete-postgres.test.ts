import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }>, historicalSale: true, usageRule: false, activation: false, contract: false }));
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: () => "postgres",
    ensurePostgresSchema: vi.fn(),
    withPostgresTransaction: async (callback: (client: { query: typeof query }) => unknown) => callback({ query }),
}));

async function query(sql: string, params: unknown[] = []) {
    db.queries.push({ sql, params });
    if (sql.startsWith("SELECT data FROM model_price_candidates")) return { rows: [{ data: { id: "candidate", logicalModelId: "logical" } }] };
    if (sql.startsWith("SELECT id FROM model_official_price_versions")) return { rows: [{ id: "official" }] };
    if (sql.startsWith("SELECT 1 FROM model_sales_price_versions")) return { rows: db.historicalSale ? [{ exists: true }] : [] };
    if (sql.startsWith("SELECT 1 FROM model_text_usage_rules")) return { rows: db.usageRule ? [{ exists: true }] : [] };
    if (sql.startsWith("SELECT 1 FROM model_pricing_state s")) return { rows: db.activation ? [{ exists: true }] : [] };
    if (sql.startsWith("SELECT 1 FROM model_flat_text_price_contracts")) return { rows: db.contract ? [{ exists: true }] : [] };
    if (sql.startsWith("SELECT") || sql.startsWith("DELETE")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
}

import { deletePriceCandidate } from "./model-pricing-store";

beforeEach(() => {
    db.queries = [];
    db.historicalSale = true;
    db.usageRule = false;
    db.activation = false;
    db.contract = false;
});

it("checks all PostgreSQL sales versions and leaves historical data untouched", async () => {
    await expect(deletePriceCandidate("candidate", null)).rejects.toThrow("销售版本引用");
    expect(db.queries).toContainEqual({ sql: "SELECT 1 FROM model_sales_price_versions WHERE data->'priceVersionIds'->>$1 = $2 LIMIT 1", params: ["logical", "official"] });
    expect(db.queries.some(({ sql }) => sql.startsWith("UPDATE") || sql.startsWith("DELETE"))).toBe(false);
});

it("blocks referenced activations and contracts before deleting an otherwise unused price", async () => {
    db.historicalSale = false;
    db.usageRule = true;
    await expect(deletePriceCandidate("candidate", null)).rejects.toThrow("文本用量规则");
    db.usageRule = false;
    db.activation = true;
    await expect(deletePriceCandidate("candidate", null)).rejects.toThrow("按量激活记录");
    db.activation = false;
    db.contract = true;
    await expect(deletePriceCandidate("candidate", null)).rejects.toThrow("计费契约");
    db.contract = false;
    await expect(deletePriceCandidate("candidate", null)).resolves.toBeUndefined();
    expect(db.queries.filter(({ sql }) => sql.startsWith("DELETE")).map(({ sql }) => sql)).toEqual(["DELETE FROM model_official_price_versions WHERE id = $1", "DELETE FROM model_price_candidates WHERE id = $1"]);
    expect(db.queries.some(({ sql }) => sql.startsWith("UPDATE"))).toBe(false);
});
