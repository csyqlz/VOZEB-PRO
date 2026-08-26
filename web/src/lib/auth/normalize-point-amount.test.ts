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

import { consumeUserPoints, createFirstAdmin, createUser, listPublicUsersPage, refundUserPoints, setAuthSettings, updateUserByAdmin } from "./store";

const INSTALL_TOKEN = "install-token-".padEnd(48, "x");

describe("normalizePointAmount allows negative values", () => {
    beforeEach(() => {
        memory.value = undefined;
        vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", INSTALL_TOKEN);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    const createAdmin = () => createFirstAdmin({ username: "admin", password: "password123", installToken: INSTALL_TOKEN });

    it("creates new users without permanent signup points", async () => {
        await createAdmin();
        const user = await createUser({ username: "new-user", password: "password123", policyAccepted: true });

        expect(user.permanentPointsBalance).toBe(0);
        expect(user.pointsBalance).toBe(0);
    });

    it("persists a negative balance set by admin", async () => {
        const admin = await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });

        await updateUserByAdmin(admin.id, user.id, { pointsBalance: -50 });

        const users = (await listPublicUsersPage({ pageSize: 100 })).users;
        expect(users.find((u) => u.id === user.id)?.pointsBalance).toBe(0);
        expect(users.find((u) => u.id === user.id)?.permanentPointsBalance).toBe(-50);
    });

    it("rejects refunds without an original consumption record", async () => {
        await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });

        await expect(refundUserPoints(user.id, "test-model", 10, "api", 1)).rejects.toThrow("退款缺少原消费流水");
    });

    it("keeps a manually adjusted balance at 0", async () => {
        const admin = await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });

        await updateUserByAdmin(admin.id, user.id, { pointsBalance: 0 });

        const users = (await listPublicUsersPage({ pageSize: 100 })).users;
        expect(users.find((u) => u.id === user.id)?.pointsBalance).toBe(0);
    });

    it("correctly adds refund to zero balance", async () => {
        const admin = await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });

        await updateUserByAdmin(admin.id, user.id, { pointsBalance: 50 });
        const consumption = await consumeUserPoints(user.id, "test-model", 50, "api", "zero-balance:consume");
        await refundUserPoints(user.id, "test-model", 50, "api", 50, "zero-balance:refund", consumption.recordId);

        const users = (await listPublicUsersPage({ pageSize: 100 })).users;
        expect(users.find((u) => u.id === user.id)?.pointsBalance).toBe(50);
    });

    it("charges a logical text model using its configured upstream alias price", async () => {
        const admin = await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });
        await updateUserByAdmin(admin.id, user.id, { pointsBalance: 10 });
        await setAuthSettings({
            systemChannels: [{ id: "text-channel", name: "文本渠道", baseUrl: "https://api.example.com/v1", apiKey: "", apiFormat: "openai", models: ["vendor-text"], enabled: true }],
            logicalModels: [{ id: "writer", name: "写作模型", capability: "text", enabled: true, bindings: [{ id: "writer-binding", channelId: "text-channel", upstreamModel: "vendor-text", enabled: true, priority: 1 }] }],
            modelPointCosts: { "vendor-text": 2.5 },
        });

        const consumption = await consumeUserPoints(user.id, "writer", 1, "text", "text-logical-price");

        expect(consumption).toMatchObject({ model: "writer", multiplier: 2.5, cost: 2.5, remaining: 7.5 });
    });

    it("allows a text model configured with zero points", async () => {
        await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });
        await setAuthSettings({ modelPointCosts: { "free-text": 0 } });

        const consumption = await consumeUserPoints(user.id, "free-text", 1, "text", "free-text-call");

        expect(consumption).toMatchObject({ cost: 0, remaining: 0 });
        expect(consumption.recordId).not.toBe("");
    });

    it("charges second-priced video using its requested duration", async () => {
        const admin = await createAdmin();
        const user = await createUser({ username: "tester", password: "password123", policyAccepted: true });
        await updateUserByAdmin(admin.id, user.id, { pointsBalance: 10 });
        await setAuthSettings({
            systemChannels: [{ id: "video-channel", name: "视频渠道", baseUrl: "https://api.example.com/v1", apiKey: "", apiFormat: "openai", models: ["vendor-video"], enabled: true }],
            logicalModels: [
                {
                    id: "video-per-second",
                    name: "按秒视频模型",
                    capability: "video",
                    enabled: true,
                    bindings: [
                        { id: "video-binding", channelId: "video-channel", upstreamModel: "vendor-video", enabled: true, priority: 1, capabilityProfile: { pricing: { currency: "CNY", billingUnit: "per_second", costPrice: 0.23, salePrice: 0.46 } } },
                    ],
                },
            ],
        });

        const consumption = await consumeUserPoints(user.id, "video-per-second", 6, "video", "video-per-second-charge");

        expect(consumption).toMatchObject({ model: "video-per-second", units: 6, multiplier: 0.46, cost: 2.76, remaining: 7.24 });
    });
});
