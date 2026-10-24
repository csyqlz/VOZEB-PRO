vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: async () => ({ ready: true, missingCount: 0, receiptIds: { fixture: "receipt" }, sample: null }) }));
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { writeAuthDb } from "@/lib/auth/store-repository";
import { validateOfficialPriceInput } from "@/lib/model-pricing";
import { toSystemGenerationChannel } from "./generation-channel";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { getModelPricingAdmission } from "./model-pricing-admission";
import { getModelPricingActivationStatus, publicModelPricingMode, setModelPricingActivation } from "./model-pricing-activation-service";
import { createOfficialPriceCandidate, linkReviewedOfficialPrice, previewSalesPricing, publishSalesPricing, reviewOfficialPriceCandidate, updateBusinessExchangeRate } from "./model-pricing-service";
import { bindReviewedPriceVersion, getOfficialVersionsByIds, insertPriceCandidate, insertSalesVersion, mutatePricingState } from "./model-pricing-store";
import { reviewVideoPriceContract } from "./model-pricing-video-contract-service";
import { createVideoTask, getVideoTask } from "./video-task-store";

const modelId = "MiniMax-Hailuo-2.3";
const sku = modelId;
const sourceUrl = "https://platform.minimax.io/docs/guides/pricing-paygo";
const channels = ["primary", "backup"] as const;
const items = [
    { key: "768P-6", unit: "video", per: "1", price: "0.28", currency: "USD" },
    { key: "768P-10", unit: "video", per: "1", price: "0.56", currency: "USD" },
    { key: "1080P-6", unit: "video", per: "1", price: "0.49", currency: "USD" },
];

describe("reviewed Hailuo price to public per-model activation", () => {
    let directory: string;
    let db: ReturnType<typeof emptyDb>;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-pricing-admission-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        db = emptyDb();
        db.settings.systemChannels = channels.map((id) => applyChannelProtocol({ id, name: id, baseUrl: `https://${id}.example.com`, apiKey: `${id}-fixture-key`, apiFormat: "openai", models: [sku], enabled: true }, "minimax"));
        db.settings.logicalModels = [
            { id: modelId, name: modelId, manufacturer: "MiniMax", capability: "video", enabled: true, bindings: channels.map((channelId, index) => ({ id: `binding-${channelId}`, channelId, upstreamModel: sku, enabled: true, priority: index })) },
        ];
        const createdAt = new Date().toISOString();
        db.users.push({
            id: "fixture-user",
            accountId: "0001",
            username: "pricing_fixture",
            displayName: "计费夹具",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            pointsBalance: 1000,
            planId: db.settings.entitlements.defaultPlanId,
            passwordHash: "fixture-only",
            createdAt,
            updatedAt: createdAt,
        });
        await writeAuthDb(db);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("reviews an unbound official model without a series or changing channel configuration", async () => {
        const channelsBefore = (await getFreshAuthSettings()).systemChannels;
        const candidate = await createOfficialPriceCandidate(
            {
                capability: "video",
                manufacturer: "MiniMax",
                officialVersion: sku,
                sku,
                tier: "paid",
                conditions: "Global standard V1 video generation",
                sourceKind: "manual",
                sourceUrl,
                evidence: "Local three-tier fixture",
                observedAt: new Date().toISOString(),
                items,
            },
            "price-editor",
        );
        expect(candidate).toMatchObject({ logicalModelId: "", series: "", capability: "video" });
        const reviewed = await reviewOfficialPriceCandidate(candidate.id, true, "Three tiers checked", "price-reviewer");
        expect(reviewed).toMatchObject({ approved: true, versionId: expect.any(String) });
        expect((await getOfficialVersionsByIds([reviewed.versionId!]))[0]).toMatchObject({ logicalModelId: "", series: "", sku });
        expect((await getFreshAuthSettings()).systemChannels).toEqual(channelsBefore);
    });

    it("rejects non-USD new candidates and legacy pending approval", async () => {
        const input = validateOfficialPriceInput({
            capability: "video",
            manufacturer: "MiniMax",
            officialVersion: sku,
            sku,
            tier: "paid",
            conditions: "Global standard V1 video generation",
            sourceKind: "manual",
            sourceUrl,
            evidence: "Local fixture",
            observedAt: new Date().toISOString(),
            items: [{ ...items[0], currency: "CNY" }],
        });
        await expect(createOfficialPriceCandidate(input, "price-editor")).rejects.toThrow("仅支持国际站 USD 官方价");
        await insertPriceCandidate({ ...input, id: "legacy-pending", status: "pending", createdAt: new Date().toISOString(), createdBy: "price-editor", revision: "legacy-r1" });
        await expect(reviewOfficialPriceCandidate("legacy-pending", true, "Legacy review", "price-reviewer")).rejects.toThrow("仅支持国际站 USD 官方价");
    });

    it("round trips reviewed Standard text groups without exposing them to legacy flat-price linking", async () => {
        const sku = "gpt-4o";
        const group = (id: string, minInclusive: number, maxInclusive: number, price: string) => ({
            id,
            scopeKind: "generation",
            selector: { processingMode: "standard", inputTotalTokens: { minInclusive, maxInclusive } },
            lines: [{ lineId: `${id}-input`, meter: "inputTokens", unit: "token", per: "1000000", price, currency: "USD", evidence: "official Standard row" }],
        });
        const schedule = { declaredRange: { minInclusive: 0, maxInclusive: 256000 }, meters: [{ meter: "inputTokens", unit: "token" }], groups: [group("short", 0, 128000, "1"), group("long", 128001, 256000, "2")] };
        const candidate = await createOfficialPriceCandidate(
            {
                capability: "text",
                manufacturer: "OpenAI",
                processingTier: "standard",
                officialVersion: sku,
                sku,
                tier: "paid",
                conditions: "Global Standard text",
                sourceKind: "manual",
                sourceUrl: "https://example.com/pricing",
                evidence: "official context tiers",
                observedAt: new Date().toISOString(),
                items: [],
                textPriceSchedule: schedule,
            },
            "price-editor",
        );
        expect(candidate.textPriceSchedule).toEqual(schedule);
        const reviewed = await reviewOfficialPriceCandidate(candidate.id, true, "two whole-request tiers checked", "reviewer");
        const [version] = await getOfficialVersionsByIds([reviewed.versionId!]);
        expect(version).toMatchObject({ logicalModelId: "", items: [], textPriceSchedule: schedule });
        await expect(linkReviewedOfficialPrice(version.id, modelId, "reviewer")).rejects.toThrow("独立选价绑定");
        await expect(bindReviewedPriceVersion(version, modelId, "reviewer")).rejects.toThrow("不能复制为旧式平价版本");
        const unsafeCopy = { ...version, id: `${version.id}-unsafe-copy`, logicalModelId: modelId };
        await mutatePricingState((state) => ({ next: { ...state, officialVersions: [...state.officialVersions, unsafeCopy] }, result: null }));
        await expect(
            insertSalesVersion({ id: "unsafe-sales", publishedAt: new Date().toISOString(), publishedBy: "reviewer", priceVersionIds: { [modelId]: unsafeCopy.id }, userPriceRules: [], usdPerCurrency: {}, pointsPerCurrency: {}, rateEvidence: {} }, null),
        ).rejects.toThrow("官方价版本已变化");
        const invalidSchedule = structuredClone(candidate.textPriceSchedule!);
        invalidSchedule.groups[1].selector.inputTotalTokens.minInclusive = 128002;
        await insertPriceCandidate({ ...candidate, id: `${candidate.id}-gap`, textPriceSchedule: invalidSchedule });
        await expect(reviewOfficialPriceCandidate(`${candidate.id}-gap`, true, "gap should not publish", "reviewer")).rejects.toThrow("coverage_gap");
    });

    it("previews H3 paid items without charging the standing-free audio row", async () => {
        const h3 = "MiniMax-H3";
        db.settings.logicalModels[0].bindings = db.settings.logicalModels[0].bindings.map((binding) => ({ ...binding, upstreamModel: h3 }));
        db.settings.systemChannels = db.settings.systemChannels.map((channel) => ({ ...channel, models: [h3] }));
        await writeAuthDb(db);
        const rows = [
            ...["768P", "2K"].flatMap((resolution) => ["input", "output"].map((kind) => ({ key: `${resolution}-${kind}`, unit: "second", per: "1", price: "0.08", currency: "USD" }))),
            { key: "inputImages", unit: "image", per: "1", price: "0.04", currency: "USD" },
            { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
        ];
        const candidate = await createOfficialPriceCandidate(
            {
                logicalModelId: modelId,
                manufacturer: "MiniMax",
                series: "H3",
                officialVersion: h3,
                sku: h3,
                tier: "paid",
                conditions: "Global standard V2 video generation; input audio is a standing free item",
                sourceKind: "manual",
                sourceUrl: "https://platform.minimax.io/docs/pricing/overview",
                evidence: "Official H3 standing-free audio and paid video/image rows",
                observedAt: new Date().toISOString(),
                items: rows,
            },
            "price-editor",
        );
        const reviewed = await reviewOfficialPriceCandidate(candidate.id, true, "H3 rows checked", "price-reviewer");
        const rate = await updateBusinessExchangeRate({ cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "Local business-rate fixture" }, null);
        const policy = {
            priceVersionIds: { [modelId]: reviewed.versionId! },
            userPriceRules: [{ scope: "default", coefficient: "1" }],
            conversion: { ...rate, pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: {},
            rateEvidence: { USD: "Local business-rate fixture" },
        };
        const preview = await previewSalesPricing(policy, modelId, { "768P-output": "5", inputImages: "2", inputAudioSeconds: "3.5" });
        expect(preview.quote).toMatchObject({ exactPoints: "336", lines: expect.arrayContaining([expect.objectContaining({ key: "inputAudioSeconds", quantity: "0", officialAmount: "0" })]) });
    });

    it("activates a model with its only enabled binding after that binding is reviewed", async () => {
        db.settings.systemChannels = db.settings.systemChannels.filter((channel) => channel.id === "primary");
        db.settings.logicalModels[0].bindings = db.settings.logicalModels[0].bindings.filter((binding) => binding.channelId === "primary");
        await writeAuthDb(db);

        const candidate = await createOfficialPriceCandidate(
            {
                logicalModelId: modelId,
                manufacturer: "MiniMax",
                series: "Hailuo",
                officialVersion: sku,
                sku,
                tier: "paid",
                conditions: "Global standard V1 video generation",
                sourceKind: "manual",
                sourceUrl,
                evidence: "Local three-tier fixture",
                observedAt: new Date().toISOString(),
                items,
            },
            "price-editor",
        );
        const reviewed = await reviewOfficialPriceCandidate(candidate.id, true, "Three tiers checked", "price-reviewer");
        const rate = await updateBusinessExchangeRate({ cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "Local business-rate fixture" }, null);
        const policy = {
            priceVersionIds: { [modelId]: reviewed.versionId! },
            userPriceRules: [{ scope: "default", coefficient: "1" }],
            conversion: { ...rate, pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: {},
            rateEvidence: { USD: "Local business-rate fixture" },
        };
        const preview = await previewSalesPricing(policy, modelId, { "768P-6": "1" });
        await publishSalesPricing(preview.policy, preview.currentSalesVersionId, preview.previewToken, "sales-reviewer");
        await reviewVideoPriceContract(
            reviewed.versionId!,
            { channelId: "primary", requestedModel: sku, protocol: "minimax-hailuo-v1", scope: "global-standard-minimax-hailuo-generation", tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" }, evidence: "Local V1 fixture" },
            null,
            "contract-reviewer",
        );

        const admission = await getModelPricingAdmission(modelId);
        expect(admission).toMatchObject({ structuralComplete: true, bindingKeys: [`primary/${sku}`] });
        const evidence = { fixtures: "Local fixture", realChannels: { [`primary/${sku}`]: "Single-channel fixture checked" }, entrypoints: "Video entrypoints fixture", recovery: "Original-task recovery fixture" };
        expect((await setModelPricingActivation({ modelId, enabled: true, expectedRevision: null, actorId: "billing-admin", evidence })).active).toBe(true);
        const configs = resolveLogicalModelCandidates(await getFreshAuthSettings(), "video", modelId).map(toSystemGenerationChannel);
        expect(await publicModelPricingMode(modelId, "video", configs)).toMatchObject({ billingMode: "official-usage", officialVersionId: reviewed.versionId });
    });

    it("requires the full reviewed price, sale, both contracts and human evidence before switching new tasks", async () => {
        const configs = resolveLogicalModelCandidates(await getFreshAuthSettings(), "video", modelId).map(toSystemGenerationChannel);
        expect((await getModelPricingAdmission(modelId)).blockers).toContain("缺少已发布且绑定该模型官方价的用户售价");
        expect(await publicModelPricingMode(modelId, "video", configs)).toBeUndefined();

        const candidate = await createOfficialPriceCandidate(
            {
                logicalModelId: modelId,
                manufacturer: "MiniMax",
                series: "Hailuo",
                officialVersion: sku,
                sku,
                tier: "paid",
                conditions: "Global standard V1 video generation",
                sourceKind: "manual",
                sourceUrl,
                evidence: "Local fixture review of three official tiers",
                observedAt: new Date().toISOString(),
                items,
            },
            "price-editor",
        );
        const reviewed = await reviewOfficialPriceCandidate(candidate.id, true, "Three tiers checked", "price-reviewer");
        const versionId = reviewed.versionId!;
        const rate = await updateBusinessExchangeRate({ cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "Local business-rate fixture" }, null);
        const policy = {
            priceVersionIds: { [modelId]: versionId },
            userPriceRules: [{ scope: "default", coefficient: "1" }],
            conversion: { ...rate, pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: {},
            rateEvidence: { USD: "Local business-rate fixture" },
        };
        const preview = await previewSalesPricing(policy, modelId, { "768P-6": "1", "768P-10": "0", "1080P-6": "0" });
        expect(preview.quote.exactPoints).toBe("196");
        await publishSalesPricing(preview.policy, preview.currentSalesVersionId, preview.previewToken, "sales-reviewer");
        expect((await getModelPricingAdmission(modelId)).blockers).toContain(`primary/${sku}：缺少当前视频计费契约`);

        const contract = {
            requestedModel: sku,
            protocol: "minimax-hailuo-v1",
            scope: "global-standard-minimax-hailuo-generation",
            tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
            evidence: "Local V1 task and refund fixture",
        };
        await reviewVideoPriceContract(versionId, { ...contract, channelId: "primary" }, null, "contract-reviewer");
        expect((await getModelPricingAdmission(modelId)).blockers).toContain(`backup/${sku}：缺少当前视频计费契约`);
        await reviewVideoPriceContract(versionId, { ...contract, channelId: "backup" }, null, "contract-reviewer");
        expect((await getModelPricingAdmission(modelId)).structuralComplete).toBe(true);
        expect(await publicModelPricingMode(modelId, "video", configs)).toBeUndefined();

        const evidence = {
            fixtures: "Local fixture results",
            realChannels: Object.fromEntries(channels.map((id) => [`${id}/${sku}`, `${id} real-channel evidence`])),
            entrypoints: "Text and image video creation entrypoints checked",
            recovery: "Original-task recovery and refund checked",
        };
        const status = await setModelPricingActivation({ modelId, enabled: true, expectedRevision: null, actorId: "billing-admin", evidence });
        expect(status.active).toBe(true);
        const approval = await publicModelPricingMode(modelId, "video", configs);
        expect(approval).toMatchObject({ billingMode: "official-usage", officialVersionId: versionId });
        if (approval?.billingMode !== "official-usage") throw new Error("fixture activation did not approve metered billing");
        const config = toSystemGenerationChannel(resolveLogicalModelCandidates(db.settings, "video", modelId)[0]);
        const create = (billingApproval: typeof approval) => createVideoTask({ userId: "fixture-user", config, upstream: { id: "", provider: "generation", model: sku }, billingMode: "official-usage", billingApproval });
        const first = await create(approval);
        expect(first).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { modelId, officialVersionId: versionId, userCoefficient: "1" } });

        const channel = db.settings.systemChannels[0];
        const advanced = channel.advancedConfig!;
        const modelConfigKey = Object.keys(advanced.modelConfigs || {})[0];
        const modelConfig = advanced.modelConfigs?.[modelConfigKey];
        if (!modelConfig) throw new Error("fixture model config missing");
        channel.advancedConfig = { ...advanced, modelConfigs: { ...advanced.modelConfigs, [modelConfigKey]: { ...modelConfig, createPath: "/v1/changed-after-review" } } };
        await writeAuthDb(db);
        const changedStatus = await getModelPricingActivationStatus(modelId);
        expect(changedStatus.active).toBe(true);
        expect(changedStatus.bindings.find((binding) => binding.key === `primary/${sku}`)?.active).toBe(false);
        expect(changedStatus.bindings.find((binding) => binding.key === `backup/${sku}`)?.active).toBe(true);
        const refreshed = await setModelPricingActivation({ modelId, enabled: true, expectedRevision: status.activation!.revision, actorId: "billing-admin", evidence });
        expect(refreshed.active).toBe(true);
        const currentConfigs = resolveLogicalModelCandidates(await getFreshAuthSettings(), "video", modelId).map(toSystemGenerationChannel);
        expect(await publicModelPricingMode(modelId, "video", configs)).toMatchObject({ billingMode: "official-usage", bindingKeys: [`backup/${sku}`] });
        expect(await publicModelPricingMode(modelId, "video", currentConfigs)).toMatchObject({ billingMode: "official-usage" });

        db.settings.systemChannels[0].apiKey = "rotated-fixture-key";
        await writeAuthDb(db);
        expect((await getModelPricingActivationStatus(modelId)).bindings.find((binding) => binding.key === `primary/${sku}`)?.active).toBe(false);
        expect(await publicModelPricingMode(modelId, "video", currentConfigs)).toMatchObject({ billingMode: "official-usage", bindingKeys: [`backup/${sku}`] });
        await expect(create(approval)).rejects.toThrow("按量计费准入已变化");
        expect((await getVideoTask(first.id))?.billingMode).toBe("official-usage");
    });
});
