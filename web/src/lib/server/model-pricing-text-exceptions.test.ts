import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: vi.fn(), users: vi.fn(), settings: vi.fn(), task: vi.fn() }));
vi.mock("./database", () => ({ getDatabaseProvider: () => "file" }));
vi.mock("@/lib/auth/store-repository", () => ({ readAuthDb: mocks.db }));
vi.mock("@/lib/auth/store", () => ({ getPublicUsersByIds: mocks.users, getFreshAuthSettings: mocks.settings }));
vi.mock("./text-task-store", () => ({ getTextTask: mocks.task }));

import { listTextPricingExceptions } from "./model-pricing-text-exceptions";

describe("redacted text pricing exceptions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.users.mockResolvedValue([{ id: "private-user", accountId: "12" }]);
        mocks.settings.mockResolvedValue({ systemChannels: [{ id: "channel", name: "测试渠道" }] });
        mocks.task.mockResolvedValue({ userId: "private-user", billingReviewReason: "缓存读取量未报告" });
        mocks.db.mockResolvedValue({
            pricingReservations: [
                {
                    userId: "private-user",
                    requestId: "pending",
                    modelId: "model",
                    usageKind: "text",
                    status: "reserved",
                    allocation: { heldPoints: "1.25" },
                    createdAt: "2026-10-02T00:00:00Z",
                    preparation: { taskId: "task" },
                    frozen: { version: { id: "official", items: [{ key: "inputTokens" }] }, policy: { id: "sale" }, contractId: "contract", text: { rules: { id: "rule" }, call: { channelId: "channel", requestedModel: "sku", serviceTier: "default" } } },
                    submission: { phase: "response_received", response: { observation: { reportedModel: "sku", usageFields: { prompt_tokens: "10" } } } },
                },
                {
                    userId: "private-user",
                    requestId: "settled",
                    modelId: "model",
                    usageKind: "text",
                    status: "settled",
                    allocation: { heldPoints: "2.00" },
                    createdAt: "2026-10-03T00:00:00Z",
                    frozen: {
                        version: { id: "official", items: [{ key: "inputTokens" }, { key: "cachedInputTokens" }, { key: "cacheWriteTokens" }] },
                        policy: { id: "sale" },
                        contractId: "contract",
                        text: { call: { channelId: "channel", requestedModel: "sku", serviceTier: "default" } },
                    },
                    billingWarnings: ["响应型号不同"],
                    settledUsage: { inputTokens: "10", cachedInputTokens: "0", cacheWriteTokens: "0" },
                    settledSources: { inputTokens: "reported", cachedInputTokens: "reported-zero", cacheWriteTokens: "defaulted-zero" },
                },
                {
                    userId: "private-user",
                    requestId: "other-model",
                    modelId: "other",
                    usageKind: "text",
                    status: "reserved",
                    allocation: { heldPoints: "100" },
                    createdAt: "2026-10-04T00:00:00Z",
                    frozen: { version: { id: "other-official" }, policy: { id: "other-sale" }, contractId: "other-contract", text: { call: { channelId: "other-channel", requestedModel: "other-sku" } } },
                    submission: { phase: "response_received" },
                },
            ],
        });
    });

    it("counts pending holds exactly and returns only model-scoped redacted rows", async () => {
        const result = await listTextPricingExceptions({ modelId: "model" });
        expect(result).toMatchObject({
            total: 2,
            heldPoints: "1.25",
            items: [
                { requestId: "settled", status: "settled-warning", channelName: "测试渠道", meterStates: { inputTokens: "reported-positive", cachedInputTokens: "reported-zero", cacheWriteTokens: "reviewed-zero" } },
                { requestId: "pending", status: "pending-review", accountId: "12", reasons: ["缓存读取量未报告"], usageFields: { prompt_tokens: "10" }, meterStates: { inputTokens: "pending-review" } },
            ],
        });
        expect(JSON.stringify(result)).not.toContain("private-user");
        expect((await listTextPricingExceptions({ modelId: "model", channelId: "unknown" })).total).toBe(0);
        expect((await listTextPricingExceptions({ status: "pending-review" })).items.map((item) => item.requestId)).toEqual(["other-model", "pending"]);
        expect((await listTextPricingExceptions({ status: "settled-warning" })).items.map((item) => item.requestId)).toEqual(["settled"]);
    });

    it("rejects invalid filters", async () => {
        const all = await listTextPricingExceptions({});
        expect(all.total).toBe(3);
        expect(all.heldPoints).toBe("101.25");
        expect(all.items.map((item) => item.modelId)).toContain("other");
        await expect(listTextPricingExceptions({ offset: -1 })).rejects.toThrow("查询参数");
        await expect(listTextPricingExceptions({ modelId: "model", from: "bad" })).rejects.toThrow("时间范围");
        await expect(listTextPricingExceptions({ status: "bad" as "pending-review" })).rejects.toThrow("状态无效");
    });
});
