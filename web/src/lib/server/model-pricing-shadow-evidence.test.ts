import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonDataFile } from "./data-adapter";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { writeAuthDb } from "@/lib/auth/store-repository";
import { createImageTask } from "./image-task-store";
import { mutateStoredGenerationTask } from "./generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";

const mocks = vi.hoisted(() => ({ sales: vi.fn(), versions: vi.fn() }));
vi.mock("./model-pricing-store", () => ({ getCurrentSalesVersion: mocks.sales, getOfficialVersionsByIds: mocks.versions, PRICING_PAGE_SIZE: 100 }));
import { getDirectedPricingEvidence, getModelPricingSampleUsage, getModelPricingShadowEvidence } from "./model-pricing-shadow-evidence";

const version = { id: "official", logicalModelId: "image", manufacturer: "OpenAI", series: "Images", items: [{ key: "outputImageTokens", unit: "token", per: "1000000", price: "30", currency: "USD" }] };
const policy = { id: "sales-1", priceVersionIds: { image: "official" }, userPriceRules: [{ scope: "default", coefficient: "1" }], conversion: { cnyPerUsd: "7", pointsPerCny: "100" }, usdPerCurrency: { USD: "1" } };

describe("real shadow evidence for one model", () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-shadow-evidence-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        mocks.sales.mockResolvedValue(policy);
        mocks.versions.mockResolvedValue([version]);
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    it("requires a priced receipt for every contract and prefills only actual quoted quantities", async () => {
        await writeJsonDataFile("model-pricing-shadow/fixture.json", {
            calls: [
                {
                    userId: "user",
                    requestId: "request",
                    modelId: "image",
                    channelId: "primary",
                    startedAt: "2026-10-13T00:00:00Z",
                    frozen: { version, policy, contract: { id: "generations" } },
                    result: { status: "priced", completedAt: "2026-10-13T00:00:01Z", receiptId: "receipt", observation: { quantities: { outputImageTokens: "915", inputTextTokens: "669" } } },
                },
            ],
            receipts: [{ id: "receipt", userId: "user", requestId: "request", kind: "charge", snapshot: { contractId: "generations", quote: { officialVersionId: "official", modelId: "image", lines: [{ key: "outputImageTokens", quantity: "915" }] } } }],
        });
        const pending = await getModelPricingShadowEvidence("image", "official", ["generations", "edits"]);
        expect(pending).toMatchObject({ ready: false, missingCount: 1, receiptIds: { generations: "receipt" }, sample: { usage: { outputImageTokens: "915" }, channelId: "primary" } });
        expect(await getModelPricingSampleUsage("image", "official")).toMatchObject({ usage: { outputImageTokens: "915" }, complete: true });
        expect((await getModelPricingShadowEvidence("image", "official", ["generations"])).ready).toBe(true);
        expect(await getModelPricingShadowEvidence("image", "official", ["generations"], "new-channel")).toMatchObject({ ready: false, missingCount: 1, receiptIds: {} });
        mocks.sales.mockResolvedValue({ ...policy, id: "sales-2", priceVersionIds: { ...policy.priceVersionIds, other: "other-price" } });
        expect((await getModelPricingShadowEvidence("image", "official", ["generations"])).ready).toBe(true);
        mocks.sales.mockResolvedValue({ ...policy, userPriceRules: [{ scope: "model", modelId: "image", coefficient: "2" }] });
        expect((await getModelPricingShadowEvidence("image", "official", ["generations"])).ready).toBe(false);
    });

    it("carries a real image quote forward when only the reservation estimate changes", async () => {
        const previous = {
            id: "old-contract",
            current: false,
            officialVersionId: "official",
            channelId: "primary",
            requestedModel: "image",
            operation: "generations",
            scope: "global-standard-direct-image-tokens",
            region: "global",
            protocol: "openai-images",
            itemMeters: { outputImageTokens: ["outputImageTokens"] },
            holdEstimates: [{ quality: "low", size: "1024x1024", meterQuantities: { outputImageTokens: "343" } }],
            evidence: "original sample",
            reviewedAt: "2026-10-13T00:00:00Z",
            reviewedBy: "admin",
        };
        const revised = { ...previous, id: "new-contract", current: true, holdEstimates: [{ quality: "low", size: "1024x1024", meterQuantities: { outputImageTokens: "2000" } }], evidence: "2000 Token reserve", reviewedAt: "2026-10-14T00:00:00Z" };
        await writeJsonDataFile("model-pricing-image-contracts.json", { contracts: [previous, revised] });
        await writeJsonDataFile("model-pricing-shadow/fixture.json", {
            calls: [
                {
                    userId: "user",
                    requestId: "request",
                    modelId: "image",
                    channelId: "primary",
                    startedAt: "2026-10-13T00:00:00Z",
                    frozen: { version, policy, contract: previous },
                    result: { status: "priced", completedAt: "2026-10-13T00:00:01Z", receiptId: "receipt" },
                },
            ],
            receipts: [{ id: "receipt", userId: "user", requestId: "request", kind: "charge", snapshot: { contractId: previous.id, quote: { officialVersionId: "official", modelId: "image", lines: [{ key: "outputImageTokens", quantity: "343" }] } } }],
        });
        expect(await getModelPricingShadowEvidence("image", "official", [revised.id], "primary")).toMatchObject({ ready: true, receiptIds: { [revised.id]: "receipt" }, carriedFromContractIds: { [revised.id]: previous.id } });
        await writeJsonDataFile("model-pricing-image-contracts.json", { contracts: [previous, { ...revised, itemMeters: { outputImageTokens: ["inputImageTokens"] } }] });
        expect(await getModelPricingShadowEvidence("image", "official", [revised.id], "primary")).toMatchObject({ ready: false, missingCount: 1 });
    });

    it("prefills a pre-publication sample without inventing missing image meters", async () => {
        mocks.versions.mockResolvedValue([{ ...version, items: [...version.items, { key: "inputImageTokens", unit: "token", per: "1000000", price: "8", currency: "USD" }] }]);
        await writeJsonDataFile("model-pricing-shadow/fixture.json", {
            calls: [{ modelId: "image", channelId: "primary", startedAt: "2026-10-13T00:00:00Z", result: { status: "unpriced", completedAt: "2026-10-13T00:00:01Z", observation: { quantities: { outputImageTokens: "915" } } } }],
            receipts: [],
        });
        expect(await getModelPricingSampleUsage("image", "official")).toMatchObject({ usage: { outputImageTokens: "915" }, complete: false });
        expect((await getModelPricingShadowEvidence("image", "official", [])).ready).toBe(false);
    });

    it("preserves fractional usage in non-text price previews", async () => {
        mocks.versions.mockResolvedValue([{ ...version, logicalModelId: "video", items: [{ key: "outputSeconds" }] }]);
        await writeJsonDataFile("model-pricing-shadow/fixture.json", {
            calls: [{ modelId: "video", channelId: "primary", startedAt: "2026-10-13T00:00:00Z", result: { status: "priced", observation: { quantities: { outputSeconds: "5.25" } } } }],
            receipts: [],
        });
        expect(await getModelPricingSampleUsage("video", "official")).toMatchObject({ usage: { outputSeconds: "5.25" }, complete: true });
    });

    it("prefills Claude cache price items from the frozen meter mapping without inventing absent usage", async () => {
        const claude = { ...version, logicalModelId: "claude", capability: "text", items: [{ key: "inputTokens" }, { key: "cacheReadTokens" }, { key: "outputTokens" }] };
        mocks.versions.mockResolvedValue([claude]);
        await writeJsonDataFile("model-pricing-shadow/fixture.json", {
            calls: [
                {
                    modelId: "claude",
                    channelId: "anthropic",
                    startedAt: "2026-10-13T00:00:00Z",
                    frozen: { version: claude, contract: { itemMeters: { inputTokens: ["inputTokens"], cacheReadTokens: ["cachedInputTokens"], outputTokens: ["outputTokens"] } } },
                    result: { status: "priced", completedAt: "2026-10-13T00:00:01Z", observation: { quantities: { inputTokens: "10", cachedInputTokens: "63", outputTokens: "5" } } },
                },
            ],
            receipts: [],
        });
        expect(await getModelPricingSampleUsage("claude", "official")).toMatchObject({ usage: { inputTokens: "10", cacheReadTokens: "63", outputTokens: "5" }, complete: true });
    });

    it("returns only the current administrator's safe directed usage facts", async () => {
        const file = `model-pricing-shadow/${createHash("sha256").update("admin").digest("hex")}.json`;
        await writeJsonDataFile(file, {
            calls: [
                {
                    userId: "admin",
                    taskId: "task-1",
                    requestId: "request-1",
                    modelId: "image",
                    channelId: "primary",
                    requestedModel: "image-sku",
                    protocol: "openai-images",
                    operation: "generations",
                    requestPath: "/v1/images/generations",
                    startedAt: "2026-10-13T00:00:00Z",
                    reasons: [],
                    result: { status: "priced", completedAt: "2026-10-13T00:00:01Z", reasons: [], observation: { reportedModel: "image-sku", usageFields: { input_tokens: "669", output_tokens: "915" }, unmappedUsageFields: [], prompt: "private prompt" } },
                },
            ],
            receipts: [{ userId: "admin", requestId: "request-1", kind: "charge", snapshot: { contractId: "contract-1", quote: { points: "20" } } }],
        });
        const evidence = await getDirectedPricingEvidence("admin", "task-1", "image");
        expect(evidence).toMatchObject({ channelId: "primary", requestedModel: "image-sku", requestPath: "/v1/images/generations", usageFields: { input_tokens: "669", output_tokens: "915" }, quotedPoints: "20" });
        expect(JSON.stringify(evidence)).not.toContain("private prompt");
        expect(await getDirectedPricingEvidence("other-admin", "task-1", "image")).toBeNull();
    });

    it("links a fixed-points image task to its shadow call through the charged point record", async () => {
        const db = emptyDb();
        const now = new Date().toISOString();
        db.users.push({
            id: "admin",
            accountId: "0001",
            username: "admin",
            displayName: "Admin",
            bio: "",
            role: "admin",
            adminPermissions: [],
            status: "active",
            pointsBalance: 9,
            passwordHash: "fixture",
            planId: db.settings.entitlements.defaultPlanId,
            createdAt: now,
            updatedAt: now,
        });
        db.pointRecords.push({
            id: "point-1",
            userId: "admin",
            type: "consume",
            amount: -1,
            balanceAfter: 9,
            permanentAmount: -1,
            dailyAmount: 0,
            permanentBalanceAfter: 9,
            dailyBalanceAfter: 0,
            description: "fixture",
            model: "image",
            idempotencyKey: "request-1",
            createdAt: now,
        });
        await writeAuthDb(db);
        const task = await createImageTask({
            userId: "admin",
            username: "admin",
            displayName: "Admin",
            kind: "generation",
            source: "image-workbench",
            prompt: "private prompt",
            references: [],
            config: { baseUrl: "/api/ai/system/primary", apiKey: "", apiFormat: "openai", channelId: "primary", model: "image-sku", logicalModel: "image" },
        });
        await mutateStoredGenerationTask("image", task.id, GENERATION_TASK_RETENTION_MS, (current) => ({
            ...current,
            usageObservations: [
                {
                    id: "observation-1",
                    attemptNo: 1,
                    channelId: "primary",
                    requestedModel: "image-sku",
                    logicalModel: "image",
                    operation: "generations",
                    observedAt: now,
                    pointsRecordId: "point-1",
                    observation: { protocol: "openai-images", quantities: {}, missing: [], invalid: [], hasResults: true },
                },
            ],
        }));
        const file = `model-pricing-shadow/${createHash("sha256").update("admin").digest("hex")}.json`;
        await writeJsonDataFile(file, {
            calls: [
                {
                    userId: "admin",
                    requestId: "request-1",
                    modelId: "image",
                    channelId: "primary",
                    requestedModel: "image-sku",
                    protocol: "openai-images",
                    operation: "generations",
                    startedAt: now,
                    reasons: [],
                    result: { status: "unpriced", completedAt: now, reasons: ["用量分项待核对"], observation: { usageFields: { input_tokens: "8" }, unmappedUsageFields: [] } },
                },
            ],
            receipts: [],
        });
        expect(await getDirectedPricingEvidence("admin", task.id, "image")).toMatchObject({ status: "unpriced", reasons: ["用量分项待核对"], usageFields: { input_tokens: "8" } });
        expect(await getDirectedPricingEvidence("other-admin", task.id, "image")).toBeNull();
    });
});
