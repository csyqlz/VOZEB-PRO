import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => false),
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));

vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (_fileName: string, fallback: unknown) => memory.value ?? fallback),
    writeJsonDataFile: vi.fn(async (_fileName: string, value: unknown) => {
        memory.value = structuredClone(value);
    }),
}));

import { createFirstAdmin, createUserByAdmin, listPointRecordsPage, setAuthSettings, settleUserTokenCharge, consumeUserPoints } from "./store";

const INSTALL_TOKEN = "install-token-".padEnd(48, "x");

describe("token settlement consumption details", () => {
    beforeEach(() => {
        memory.value = undefined;
        vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", INSTALL_TOKEN);
    });

    afterEach(() => vi.unstubAllEnvs());

    it("stores actual token usage and hides the settled reservation from consumption view", async () => {
        const admin = await createFirstAdmin({ username: "admin", password: "password123", installToken: INSTALL_TOKEN });
        const user = await createUserByAdmin({ actorId: admin.id, username: "tester", password: "password123", pointsBalance: 5 });
        await setAuthSettings({
            systemChannels: [{ id: "text-channel", name: "文本渠道", baseUrl: "https://api.example.com/v1", apiKey: "", apiFormat: "openai", models: ["writer-upstream"], enabled: true }],
            logicalModels: [
                {
                    id: "writer",
                    name: "文本模型",
                    capability: "text",
                    enabled: true,
                    bindings: [
                        {
                            id: "writer-binding",
                            channelId: "text-channel",
                            upstreamModel: "writer-upstream",
                            enabled: true,
                            priority: 1,
                            capabilityProfile: {
                                pricing: {
                                    currency: "CNY",
                                    billingUnit: "per_1m_tokens",
                                    inputSalePrice: 2,
                                    outputSalePrice: 8,
                                },
                            },
                        },
                    ],
                },
            ],
        });

        const reservation = await consumeUserPoints(user.id, "writer", 0.5, "text", "token-reservation");
        const settled = await settleUserTokenCharge({
            userId: user.id,
            model: "writer",
            reservedCost: 0.5,
            actualCost: 0.00001,
            sourceRecordId: reservation.recordId,
            businessRequestId: "token-request",
            usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            saleRates: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
        });

        const consumption = await listPointRecordsPage(user.id, { direction: "debit", view: "consumption", page: 1, pageSize: 10 });
        expect(settled).toMatchObject({ adjusted: true, cost: 0.00001 });
        expect(consumption).toMatchObject({ total: 1, records: [{ amount: -0.00001, usageKind: "text", units: 1 }] });
        expect(consumption.records[0].billingDetail).toMatchObject({ billingUnit: "per_1m_tokens", inputTokens: 2, outputTokens: 1, inputRate: 2, outputRate: 8, settlementStatus: "settled" });
    });
});
