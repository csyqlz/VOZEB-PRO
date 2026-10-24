import { expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queries: [] as string[], rate: { cnyPerUsd: "8", observedAt: "2026-10-20T00:00:00Z", evidence: "reviewed" } }));
vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: () => "postgres",
    ensurePostgresSchema: vi.fn(),
    withPostgresTransaction: async (callback: (client: { query: typeof query }) => unknown) => callback({ query }),
}));

async function query(sql: string) {
    db.queries.push(sql);
    if (sql.startsWith("SELECT current_sales_version_id, exchange_rate")) return { rows: [{ current_sales_version_id: null, exchange_rate: db.rate }] };
    if (sql.startsWith("INSERT INTO model_sales_price_versions") || sql.startsWith("UPDATE model_pricing_state")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
}

import { insertSalesVersion } from "./model-pricing-store";

it("rejects a stale reviewed rate inside the PostgreSQL publication transaction", async () => {
    const sale = {
        id: "sale",
        publishedAt: "2026-10-20T00:00:00Z",
        publishedBy: "admin",
        priceVersionIds: {},
        userPriceRules: [],
        conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: db.rate.observedAt, evidence: db.rate.evidence },
        usdPerCurrency: { USD: "1" },
        pointsPerCurrency: { USD: "700" },
        rateEvidence: { USD: db.rate.evidence },
    };
    await expect(insertSalesVersion(sale, null, true)).rejects.toThrow("汇率已变化");
    expect(db.queries).toEqual(["SELECT current_sales_version_id, exchange_rate FROM model_pricing_state WHERE id = 'default' FOR UPDATE"]);
    db.queries = [];
    await expect(insertSalesVersion({ ...sale, conversion: { ...sale.conversion, cnyPerUsd: db.rate.cnyPerUsd } }, null, true)).resolves.toMatchObject({ id: sale.id });
    expect(db.queries.filter((sql) => sql.startsWith("INSERT") || sql.startsWith("UPDATE"))).toHaveLength(2);
});
