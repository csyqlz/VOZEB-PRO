import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), sales: vi.fn(), versions: vi.fn(), latest: vi.fn(), videos: vi.fn(), images: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("@/lib/channel-protocol-registry", () => ({ channelConnectionReady: () => true, resolveChannelModelConfig: () => undefined }));
vi.mock("./generation-channel", () => ({ channelSupportsModel: () => true }));
vi.mock("./model-pricing-store", () => ({ getCurrentSalesVersion: mocks.sales, getOfficialVersionsByIds: mocks.versions, getLatestOfficialVersionForModel: mocks.latest }));
vi.mock("./model-pricing-video-contract-store", () => ({ listVideoPriceContracts: mocks.videos }));
vi.mock("./model-pricing-image-contract-store", () => ({ listImagePriceContracts: mocks.images }));

import { admissionKey, getModelPricingAdmission, type ModelPricingAdmissionReadContext } from "./model-pricing-admission";
import { modelPricingEffectiveTerms } from "./model-pricing-effective-terms";

const sku = "MiniMax-Hailuo-2.3";
const at = "2026-10-09T00:00:00.000Z";
const version = {
    id: "official",
    logicalModelId: "hailuo",
    manufacturer: "MiniMax",
    series: "Hailuo",
    officialVersion: "2.3",
    sku,
    tier: "paid",
    conditions: "global",
    sourceKind: "manual",
    sourceUrl: "https://platform.minimax.io/docs/guides/pricing-paygo",
    evidence: "官网逐档核对",
    observedAt: at,
    candidateId: "candidate",
    publishedAt: at,
    reviewedBy: "admin",
    items: [
        { key: "768P-6", unit: "video", per: "1", price: "0.28", currency: "USD" },
        { key: "768P-10", unit: "video", per: "1", price: "0.56", currency: "USD" },
        { key: "1080P-6", unit: "video", per: "1", price: "0.49", currency: "USD" },
    ],
};
const contract = (channelId: string) => ({
    id: `contract-${channelId}`,
    current: true,
    officialVersionId: "official",
    channelId,
    requestedModel: sku,
    protocol: "minimax-hailuo-v1",
    scope: "global-standard-minimax-hailuo-generation",
    tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
    evidence: "完整三档",
    reviewedBy: "admin",
    reviewedAt: at,
});

describe("per-model pricing admission inspection", () => {
    it("admits a selected shared text price only with its current model binding and contract", async () => {
        const shared = {
            ...version,
            logicalModelId: "",
            capability: "text" as const,
            manufacturer: "OpenAI",
            sku: "gpt-test",
            items: [
                { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                { key: "cache", unit: "token", per: "1000000", price: "0.1", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "4", currency: "USD" },
            ],
        };
        const scope = "text:generation:standard";
        const selection = { logicalModelId: "gpt-test", scope, bindingId: "binding", bindingRevision: "revision", officialVersionId: shared.id };
        const settings = {
            logicalModels: [{ id: "gpt-test", manufacturer: "OpenAI", capability: "text", enabled: true, bindings: [{ channelId: "primary", upstreamModel: shared.sku, enabled: true }] }],
            systemChannels: [{ id: "primary", name: "Primary", enabled: true, models: [shared.sku], apiFormat: "openai", advancedConfig: { protocol: "openai" } }],
        };
        const policy = {
            id: "sale",
            publishedBy: "admin",
            publishedAt: at,
            priceVersionIds: {},
            selectedPriceBindings: [selection],
            userPriceRules: [{ scope: "model", modelId: "gpt-test", coefficient: "2" }],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
        };
        const binding = { ...selection, id: "binding", revision: "revision", officialVersionId: shared.id, capability: "text", operation: "generation", processingMode: "standard", status: "active", current: true };
        const contract = {
            id: "contract",
            current: true,
            officialVersionId: shared.id,
            channelId: "primary",
            requestedModel: shared.sku,
            reportedModel: shared.sku,
            protocol: "openai-chat",
            scope: "global-standard-text-flat",
            region: "global",
            serviceTier: "default",
            itemMeters: { input: ["inputTokens", "cacheWriteTokens"], cache: ["cachedInputTokens"], output: ["outputTokens"] },
            evidence: "fixture",
            reviewedBy: "admin",
            reviewedAt: at,
            requestLimits: { maxInputTokens: 1000, maxOutputTokens: 100, maxCandidates: 1, sourceUrl: "https://example.com/limits", evidence: "fixture", includesReasoning: true },
            reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://example.com/text-estimate", evidence: "fixture reviewed estimate" },
        };
        const read = {
            settings,
            policy,
            versionsById: new Map([[shared.id, shared]]),
            latestVersions: new Map(),
            priceBindings: new Map([["gpt-test", binding]]),
            currentTextRules: new Map(),
            rulesById: new Map(),
            contracts: { text: new Map([[admissionKey(shared.id, "primary", shared.sku), contract]]), image: new Map(), video: new Map(), audio: new Map() },
        } as unknown as ModelPricingAdmissionReadContext;
        const ready = await getModelPricingAdmission("gpt-test", undefined, read);
        expect(ready).toMatchObject({ officialVersionId: shared.id, reviewedOfficialVersionId: shared.id, structuralComplete: true, billingMode: "fixed-points" });
        read.contracts.text.set(admissionKey(shared.id, "primary", shared.sku), { ...contract, reservationEstimate: undefined } as never);
        expect((await getModelPricingAdmission("gpt-test", undefined, read)).bindings[0].blockers).toContain("文本契约缺少已审核的独立预留估算");
        read.policy = { ...policy, priceVersionIds: { "gpt-test": shared.id }, selectedPriceBindings: [] } as never;
        read.versionsById.set(shared.id, { ...shared, logicalModelId: "gpt-test" } as never);
        expect((await getModelPricingAdmission("gpt-test", undefined, read)).structuralComplete).toBe(false);
        expect((await getModelPricingAdmission("gpt-test", null, read, undefined, undefined, true)).structuralComplete).toBe(true);
        read.versionsById.set(shared.id, shared as never);
        read.policy = policy as never;
        read.contracts.text.set(admissionKey(shared.id, "primary", shared.sku), contract as never);
        read.policy = { ...policy, priceVersionIds: { "gpt-test": shared.id } } as never;
        const conflicted = await getModelPricingAdmission("gpt-test", undefined, read);
        expect(conflicted).toMatchObject({ officialVersionId: null, structuralComplete: false });
        expect(conflicted.blockers).toContain("同一模型的销售版本同时含旧式映射和独立选价，请重新发布");
        read.policy = policy as never;
        const exactSettings = read.settings;
        const exactContracts = read.contracts.text;
        const alias = "proxy-gpt-test";
        read.settings = {
            ...exactSettings,
            logicalModels: exactSettings.logicalModels.map((item) => ({ ...item, bindings: item.bindings.map((channelBinding) => ({ ...channelBinding, id: "channel-binding", upstreamModel: alias })) })),
        };
        const aliasContract = {
            ...contract,
            requestedModel: alias,
            identity: { channelBindingId: "channel-binding", officialSku: shared.sku, operation: "generation", modelIdentity: "response-required", sourceUrl: "https://example.com/alias", evidence: "渠道请求名与官网型号已审核" },
        };
        read.contracts.text = new Map([[admissionKey(shared.id, "primary", alias), aliasContract as never]]);
        expect(await getModelPricingAdmission("gpt-test", undefined, read)).toMatchObject({ structuralComplete: true, officialVersionId: shared.id });
        read.contracts.text.set(admissionKey(shared.id, "primary", alias), { ...aliasContract, identity: undefined } as never);
        expect((await getModelPricingAdmission("gpt-test", undefined, read)).bindings[0].blockers).toContainEqual(expect.stringContaining("渠道别名缺少"));
        read.contracts.text.set(admissionKey(shared.id, "primary", alias), { ...aliasContract, identity: { ...aliasContract.identity, channelBindingId: "old-binding" } } as never);
        expect((await getModelPricingAdmission("gpt-test", undefined, read)).bindings[0].blockers).toContainEqual(expect.stringContaining("渠道别名与当前绑定"));
        read.settings = exactSettings;
        read.contracts.text = exactContracts;
        const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token" as const, per: "1000000", price, currency: "USD" as const, evidence: "fixture" });
        read.versionsById.set(shared.id, {
            ...read.versionsById.get(shared.id)!,
            items: [],
            textPriceSchedule: {
                declaredRange: { minInclusive: 0, maxInclusive: 1000 },
                meters: [
                    { meter: "input", unit: "token" },
                    { meter: "cache", unit: "token" },
                    { meter: "output", unit: "token" },
                ],
                groups: [
                    {
                        id: "short",
                        scopeKind: "generation",
                        selector: { processingMode: "standard", inputTotalTokens: { minInclusive: 0, maxInclusive: 500 } },
                        lines: [line("short-input", "input", "1"), line("short-cache", "cache", "0.1"), line("short-output", "output", "4")],
                    },
                    {
                        id: "long",
                        scopeKind: "generation",
                        selector: { processingMode: "standard", inputTotalTokens: { minInclusive: 501, maxInclusive: 1000 } },
                        lines: [line("long-input", "input", "2"), line("long-cache", "cache", "0.2"), line("long-output", "output", "4")],
                    },
                ],
            },
        });
        const scheduledContract = { ...contract, scope: "global-standard-text-tiered", contextTiers: undefined };
        read.contracts.text.set(admissionKey(shared.id, "primary", shared.sku), scheduledContract as ModelPricingAdmissionReadContext["contracts"]["text"] extends Map<string, infer T> ? T : never);
        expect(await getModelPricingAdmission("gpt-test", undefined, read)).toMatchObject({ structuralComplete: true, officialVersionId: shared.id });
        read.priceBindings?.set("gpt-test", { ...read.priceBindings.get("gpt-test")!, revision: "changed" });
        const stale = await getModelPricingAdmission("gpt-test", undefined, read);
        expect(stale).toMatchObject({ officialVersionId: null, structuralComplete: false });
        expect(stale.blockers).toContain("缺少已发布且绑定该模型官方价的用户售价");
    });
    it("inspects selected image generation and edit prices with independent contracts and revisions", async () => {
        const modelId = "flux-kontext-pro";
        const price = (id: string, amount: string) => ({ ...version, id, logicalModelId: "", capability: "image" as const, manufacturer: "Fixture", sku: modelId, items: [{ key: "image", unit: "image", per: "1", price: amount, currency: "USD" }] });
        const generated = price("generate-price", "0.04");
        const edited = price("edit-price", "0.08");
        const selection = (operation: "generations" | "edits", officialVersionId: string) => ({
            logicalModelId: modelId,
            scope: `image:${operation}:standard`,
            bindingId: `${operation}-binding`,
            bindingRevision: `${operation}-revision`,
            officialVersionId,
        });
        const generation = selection("generations", generated.id);
        const edit = selection("edits", edited.id);
        const binding = (entry: typeof generation, operation: "generations" | "edits") => ({
            ...entry,
            id: entry.bindingId,
            revision: entry.bindingRevision,
            capability: "image" as const,
            operation,
            processingMode: "standard" as const,
            status: "active" as const,
            current: true,
        });
        const contract = (entry: typeof generation, operation: "generations" | "edits") => ({
            id: `${operation}-contract`,
            current: true,
            officialVersionId: entry.officialVersionId,
            channelId: "primary",
            requestedModel: modelId,
            reportedModel: modelId,
            modelIdentity: "reviewed-request",
            protocol: "openai-images",
            operation,
            scope: "global-standard-dataeyes-flux-image",
            imageLimit: { maxImages: 1, sourceUrl: "https://example.com/one-image", evidence: "单请求一张" },
            region: "global",
            itemMeters: {},
            zeroMeters: [],
            evidence: "已核对渠道计量",
            reviewedBy: "admin",
            reviewedAt: at,
        });
        const read = {
            settings: {
                logicalModels: [{ id: modelId, manufacturer: "Fixture", capability: "image", enabled: true, bindings: [{ channelId: "primary", upstreamModel: modelId, enabled: true }] }],
                systemChannels: [{ id: "primary", name: "Primary", enabled: true, models: [modelId], apiFormat: "openai", advancedConfig: { protocol: "dataeyes-flux" } }],
            },
            policy: { id: "sale", publishedBy: "admin", publishedAt: at, priceVersionIds: {}, selectedPriceBindings: [generation, edit], userPriceRules: [], conversion: { cnyPerUsd: "7", pointsPerCny: "100" }, usdPerCurrency: { USD: "1" } },
            versionsById: new Map([
                [generated.id, generated],
                [edited.id, edited],
            ]),
            latestVersions: new Map(),
            priceBindings: new Map([
                [admissionKey(modelId, generation.scope), binding(generation, "generations")],
                [admissionKey(modelId, edit.scope), binding(edit, "edits")],
            ]),
            currentTextRules: new Map(),
            rulesById: new Map(),
            contracts: {
                text: new Map(),
                image: new Map([
                    [admissionKey(generated.id, "primary", modelId, "generations"), contract(generation, "generations")],
                    [admissionKey(edited.id, "primary", modelId, "edits"), contract(edit, "edits")],
                ]),
                video: new Map(),
                audio: new Map(),
            },
        } as unknown as ModelPricingAdmissionReadContext;
        const generationAdmission = await getModelPricingAdmission(modelId, undefined, read, "generations");
        const editAdmission = await getModelPricingAdmission(modelId, undefined, read, "edits");
        expect(generationAdmission).toMatchObject({ imageOperation: "generations", officialVersionId: generated.id, structuralComplete: true, contractIds: ["generations-contract"] });
        expect(editAdmission).toMatchObject({ imageOperation: "edits", officialVersionId: edited.id, structuralComplete: true, contractIds: ["edits-contract"] });
        expect(generationAdmission.fingerprint).not.toBe(editAdmission.fingerprint);
        const validPolicy = read.policy;
        read.policy = { ...validPolicy, priceVersionIds: { [modelId]: generated.id } } as never;
        expect(await getModelPricingAdmission(modelId, undefined, read)).toMatchObject({ officialVersionId: null, structuralComplete: false });
        read.policy = validPolicy;
        const editBinding = read.priceBindings!.get(admissionKey(modelId, edit.scope))!;
        read.priceBindings?.set(admissionKey(modelId, edit.scope), { ...editBinding, scope: generation.scope });
        expect((await getModelPricingAdmission(modelId, undefined, read, "edits")).officialVersionId).toBeNull();
        read.priceBindings?.set(admissionKey(modelId, edit.scope), editBinding);
        read.contracts.image.delete(admissionKey(edited.id, "primary", modelId, "edits"));
        expect((await getModelPricingAdmission(modelId, undefined, read, "edits")).structuralComplete).toBe(false);
        expect((await getModelPricingAdmission(modelId, undefined, read, "generations")).structuralComplete).toBe(true);
        read.contracts.image.set(admissionKey(edited.id, "primary", modelId, "edits"), contract(edit, "edits") as ModelPricingAdmissionReadContext["contracts"]["image"] extends Map<string, infer T> ? T : never);
        read.priceBindings?.set(admissionKey(modelId, edit.scope), { ...read.priceBindings.get(admissionKey(modelId, edit.scope))!, revision: "changed" });
        expect((await getModelPricingAdmission(modelId, undefined, read, "edits")).officialVersionId).toBeNull();
        expect((await getModelPricingAdmission(modelId, undefined, read, "generations")).structuralComplete).toBe(true);
        expect((await getModelPricingAdmission(modelId, undefined, read)).structuralComplete).toBe(false);
    });
    it("revokes direct image Token alias admission when its reviewed channel binding changes", async () => {
        const modelId = "image-logical";
        const alias = "proxy-image";
        const shared = { ...version, id: "image-official", logicalModelId: "", capability: "image" as const, manufacturer: "Fixture", sku: "official-image", items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] };
        const selection = { logicalModelId: modelId, scope: "image:generations:standard", bindingId: "price-binding", bindingRevision: "revision", officialVersionId: shared.id };
        const contract = {
            id: "image-contract",
            current: true,
            officialVersionId: shared.id,
            channelId: "primary",
            requestedModel: alias,
            reportedModel: "official-image",
            modelIdentity: "response-required",
            identity: { channelBindingId: "channel-binding", officialSku: shared.sku, operation: "generations", sourceUrl: "https://example.com/image-identity", evidence: "请求名与官方 SKU 已核对" },
            protocol: "openai-images",
            operation: "generations",
            scope: "global-standard-direct-image-tokens",
            region: "global",
            itemMeters: { tokens: ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"] },
            zeroMeters: [],
            holdEstimate: { meterQuantities: { inputTextTokens: "1000", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-estimate", evidence: "fixture" },
            evidence: "全部用量已核对",
            reviewedBy: "admin",
            reviewedAt: at,
        };
        const read = {
            settings: {
                logicalModels: [{ id: modelId, manufacturer: "Fixture", capability: "image", enabled: true, bindings: [{ id: "channel-binding", channelId: "primary", upstreamModel: alias, enabled: true }] }],
                systemChannels: [{ id: "primary", enabled: true, models: [alias], apiFormat: "openai" }],
            },
            policy: { id: "sale", publishedBy: "admin", publishedAt: at, priceVersionIds: {}, selectedPriceBindings: [selection], userPriceRules: [], conversion: { cnyPerUsd: "7", pointsPerCny: "100" }, usdPerCurrency: { USD: "1" } },
            versionsById: new Map([[shared.id, shared]]),
            latestVersions: new Map(),
            priceBindings: new Map([
                [admissionKey(modelId, selection.scope), { ...selection, id: selection.bindingId, revision: selection.bindingRevision, capability: "image", operation: "generations", processingMode: "standard", status: "active", current: true }],
            ]),
            currentTextRules: new Map(),
            rulesById: new Map(),
            contracts: { text: new Map(), image: new Map([[admissionKey(shared.id, "primary", alias, "generations"), contract]]), video: new Map(), audio: new Map() },
        } as unknown as ModelPricingAdmissionReadContext;
        expect(await getModelPricingAdmission(modelId, undefined, read, "generations")).toMatchObject({ structuralComplete: true, contractIds: [contract.id] });
        read.settings.logicalModels[0].bindings[0].id = "replacement-binding";
        expect((await getModelPricingAdmission(modelId, undefined, read, "generations")).bindings[0].blockers).toContain("图片渠道别名与当前绑定的已审核型号身份不一致");
        read.settings.logicalModels[0].bindings[0].id = "channel-binding";
        read.contracts.image.set(admissionKey(shared.id, "primary", alias, "generations"), { ...contract, identity: undefined } as never);
        expect((await getModelPricingAdmission(modelId, undefined, read, "generations")).bindings[0].blockers).toContain("图片渠道别名缺少独立审核的型号身份");
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "hailuo", capability: "video", enabled: true, bindings: ["primary", "backup"].map((channelId) => ({ channelId, upstreamModel: sku, enabled: true })) }],
            systemChannels: ["primary", "backup"].map((id) => ({ id, enabled: true, models: [sku], apiFormat: "openai", advancedConfig: { protocol: "minimax" } })),
        });
        mocks.sales.mockResolvedValue({ id: "sales", publishedBy: "admin", publishedAt: at, priceVersionIds: { hailuo: "official" }, userPriceRules: [], conversion: { cnyPerUsd: "7", pointsPerCny: "100" }, usdPerCurrency: { USD: "1" } });
        mocks.versions.mockResolvedValue([version]);
        mocks.latest.mockResolvedValue(version);
        mocks.videos.mockImplementation(async (_versionId, channelId) => [contract(channelId)]);
    });

    it("keeps newly added models fixed until a reviewed price and published sale exist", async () => {
        mocks.sales.mockResolvedValue(undefined);
        const result = await getModelPricingAdmission("hailuo");
        expect(result).toMatchObject({ structuralComplete: false, billingMode: "fixed-points", requiresShadowQuote: true });
        expect(result).toMatchObject({ reviewedOfficialVersionId: "official", officialVersionId: null });
        expect(result.blockers).toContain("缺少已发布且绑定该模型官方价的用户售价");
        expect(mocks.videos).not.toHaveBeenCalled();
    });

    it("distinguishes a missing reviewed official price from a missing published sale", async () => {
        mocks.sales.mockResolvedValue(undefined);
        mocks.latest.mockResolvedValue(undefined);
        const result = await getModelPricingAdmission("hailuo");
        expect(result.blockers).toEqual(expect.arrayContaining(["缺少该模型已审核的官方价版本", "缺少已发布且绑定该模型官方价的用户售价"]));
        expect(result.reviewedOfficialVersionId).toBeNull();
    });

    it("keeps a reviewed binding ready when a new fallback binding lacks a contract", async () => {
        mocks.videos.mockImplementation(async (_versionId, channelId) => (channelId === "primary" ? [contract(channelId)] : []));
        const result = await getModelPricingAdmission("hailuo");
        expect(result.structuralComplete).toBe(true);
        expect(result.bindings.find((item) => item.key === `primary/${sku}`)?.fingerprint).toBeTruthy();
        expect(result.bindings.find((item) => item.key === `backup/${sku}`)?.fingerprint).toBeNull();
        expect(result.blockers).toContain("backup/MiniMax-Hailuo-2.3：缺少当前视频计费契约");
        mocks.videos.mockImplementation(async (_versionId, channelId) => [contract(channelId)]);
        expect(await getModelPricingAdmission("hailuo")).toMatchObject({ structuralComplete: true, billingMode: "fixed-points", requiresShadowQuote: true });
        mocks.videos.mockImplementation(async (_versionId, channelId) => [{ ...contract(channelId), reviewedAt: "invalid" }]);
        expect((await getModelPricingAdmission("hailuo")).blockers).toContain("primary/MiniMax-Hailuo-2.3：缺少当前视频计费契约");
    });

    it("gives the same result from batched read data without repeating per-binding reads", async () => {
        mocks.videos.mockImplementation(async (_versionId, channelId) => (channelId === "primary" ? [contract(channelId)] : []));
        const direct = await getModelPricingAdmission("hailuo");
        const calls = mocks.videos.mock.calls.length;
        const read = {
            settings: await mocks.settings(),
            policy: await mocks.sales(),
            versionsById: new Map([[version.id, version]]),
            latestVersions: new Map([["hailuo", version]]),
            currentTextRules: new Map(),
            rulesById: new Map(),
            contracts: { text: new Map(), image: new Map(), video: new Map([[admissionKey(version.id, "primary", sku), contract("primary")]]), audio: new Map() },
        } as ModelPricingAdmissionReadContext;
        expect(await getModelPricingAdmission("hailuo", undefined, read)).toEqual(direct);
        expect(mocks.videos).toHaveBeenCalledTimes(calls);
    });

    it("only changes the model fingerprint when its effective sale terms change", async () => {
        const before = await getModelPricingAdmission("hailuo");
        expect(before.structuralComplete).toBe(true);
        mocks.sales.mockResolvedValue({
            id: "sales-2",
            publishedBy: "admin",
            publishedAt: at,
            priceVersionIds: { hailuo: "official", other: "other-official" },
            userPriceRules: [{ scope: "model", modelId: "other", coefficient: "3" }],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
        });
        expect((await getModelPricingAdmission("hailuo")).fingerprint).toBe(before.fingerprint);
        mocks.sales.mockResolvedValue({
            id: "sales-3",
            publishedBy: "admin",
            publishedAt: at,
            priceVersionIds: { hailuo: "official" },
            userPriceRules: [{ scope: "model", modelId: "hailuo", coefficient: "2" }],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
        });
        expect((await getModelPricingAdmission("hailuo")).fingerprint).not.toBe(before.fingerprint);
    });

    it("recomputes the exact deployed model-level fingerprint before upgrading old activations", async () => {
        const settings = await mocks.settings();
        const policy = await mocks.sales();
        const before = await getModelPricingAdmission("hailuo");
        const expected = createHash("sha256")
            .update(
                JSON.stringify({
                    capability: "video",
                    salesTerms: modelPricingEffectiveTerms(version as Parameters<typeof modelPricingEffectiveTerms>[0], policy),
                    officialVersionId: "official",
                    contracts: ["contract-backup", "contract-primary"],
                    bindings: settings.logicalModels[0].bindings.map((binding: { channelId: string }) => {
                        const channel = settings.systemChannels.find((item: { id: string }) => item.id === binding.channelId);
                        return { binding, baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat, advancedConfig: channel.advancedConfig };
                    }),
                }),
            )
            .digest("hex");
        expect(before.legacyFingerprint).toBe(expected);
        mocks.settings.mockResolvedValue({
            ...settings,
            logicalModels: [{ ...settings.logicalModels[0], bindings: [...settings.logicalModels[0].bindings, { channelId: "new", upstreamModel: sku, enabled: true }] }],
            systemChannels: [...settings.systemChannels, { id: "new", enabled: true, models: [sku], apiFormat: "openai", advancedConfig: { protocol: "minimax" } }],
        });
        const after = await getModelPricingAdmission("hailuo");
        expect(after.fingerprint).toBe(before.fingerprint);
        expect(after.legacyFingerprint).not.toBe(before.legacyFingerprint);
    });

    it("blocks zero priced rows and incomplete H3 tariffs", async () => {
        mocks.versions.mockResolvedValue([{ ...version, items: [{ ...version.items[0], price: "0" }, ...version.items.slice(1)] }]);
        expect((await getModelPricingAdmission("hailuo")).blockers).toEqual(expect.arrayContaining([expect.stringContaining("缺少常规付费单价")]));
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "hailuo", capability: "video", enabled: true, bindings: [{ channelId: "primary", upstreamModel: "MiniMax-H3", enabled: true }] }],
            systemChannels: [{ id: "primary", enabled: true, models: ["MiniMax-H3"], apiFormat: "openai", advancedConfig: { protocol: "minimax" } }],
        });
        mocks.versions.mockResolvedValue([{ ...version, sku: "MiniMax-H3" }]);
        expect((await getModelPricingAdmission("hailuo")).structuralComplete).toBe(false);
    });

    it("admits reviewed H3 pricing with standing-free audio and paid video and images", async () => {
        const model = "MiniMax-H3";
        const items = [
            ...["768P", "2K"].flatMap((resolution) => ["input", "output"].map((kind) => ({ key: `${resolution}-${kind}`, unit: "second", per: "1", price: "0.08", currency: "USD" }))),
            { key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" },
            { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
        ];
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "hailuo", capability: "video", enabled: true, bindings: [{ channelId: "primary", upstreamModel: model, enabled: true }] }],
            systemChannels: [{ id: "primary", enabled: true, models: [model], apiFormat: "openai", advancedConfig: { protocol: "minimax" } }],
        });
        mocks.versions.mockResolvedValue([{ ...version, sku: model, items }]);
        mocks.videos.mockResolvedValue([
            {
                id: "h3-contract",
                current: true,
                officialVersionId: "official",
                channelId: "primary",
                requestedModel: model,
                protocol: "minimax-video-v2",
                scope: "global-standard-minimax-h3-generation",
                resolutionItems: Object.fromEntries(["768P", "2K"].map((resolution) => [resolution, { inputSeconds: `${resolution}-input`, outputSeconds: `${resolution}-output` }])),
                inputImageItem: "images",
                inputImagePricing: "all-at-standard-rate",
                inputAudioItem: "inputAudioSeconds",
                evidence: "已核对官方长期免费音频",
                reviewedBy: "admin",
                reviewedAt: at,
            },
        ]);
        expect(await getModelPricingAdmission("hailuo")).toMatchObject({ structuralComplete: true, billingMode: "fixed-points" });
        mocks.versions.mockResolvedValue([{ ...version, sku: model, items: items.filter((item) => item.key !== "inputAudioSeconds") }]);
        expect((await getModelPricingAdmission("hailuo")).structuralComplete).toBe(false);
    });

    it("admits direct image Token contracts only on an unadapted Images channel", async () => {
        const model = "flux-kontext-pro";
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "hailuo", capability: "image", enabled: true, bindings: [{ channelId: "primary", upstreamModel: model, enabled: true }] }],
            systemChannels: [{ id: "primary", name: "Primary image channel", enabled: true, models: [model], apiFormat: "openai", advancedConfig: { protocol: "dataeyes-flux" } }],
        });
        mocks.versions.mockResolvedValue([{ ...version, sku: model, items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }] }]);
        const token = {
            id: "image-token",
            current: true,
            officialVersionId: "official",
            channelId: "primary",
            requestedModel: model,
            reportedModel: model,
            modelIdentity: "reviewed-request",
            protocol: "openai-images",
            operation: "generations",
            scope: "global-standard-direct-image-tokens",
            region: "global",
            itemMeters: { tokens: ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"] },
            zeroMeters: [],
            holdEstimate: { meterQuantities: { inputTextTokens: "1000", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-estimate", evidence: "fixture reviewed estimate" },
            evidence: "全部分项",
            reviewedBy: "admin",
            reviewedAt: at,
        };
        mocks.images.mockImplementation(async (_versionId, _channelId, _model, operation) => [{ ...token, operation }]);
        const result = await getModelPricingAdmission("hailuo");
        expect(result).toMatchObject({ structuralComplete: false, billingMode: "fixed-points" });
        expect(result.bindings[0].channelName).toBe("Primary image channel");
        expect(result.bindings[0].operationContracts).toEqual([{ operation: "generations" }, { operation: "edits" }]);
        expect(result.bindings[0].fingerprint).toBeNull();
        expect(result.blockers).toContain(`primary/${model}：图片 Token 契约与当前渠道协议不匹配`);
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "hailuo", capability: "image", enabled: true, bindings: [{ channelId: "primary", upstreamModel: model, enabled: true }] }],
            systemChannels: [{ id: "primary", enabled: true, models: [model], apiFormat: "openai" }],
        });
        expect((await getModelPricingAdmission("hailuo")).structuralComplete).toBe(true);
        mocks.images.mockImplementation(async (_versionId, _channelId, _model, operation) => [{ ...token, holdEstimate: undefined, operation }]);
        expect((await getModelPricingAdmission("hailuo")).blockers).toContain(`primary/${model}：图片 Token 契约缺少已审核的独立预留估算`);
        mocks.images.mockImplementation(async (_versionId, _channelId, _model, operation) => (operation === "generations" ? [{ ...token, operation }] : []));
        expect((await getModelPricingAdmission("hailuo")).bindings[0].operationContracts).toEqual([{ operation: "generations", id: "image-token" }, { operation: "edits" }]);
        mocks.settings.mockResolvedValue({
            logicalModels: [{ id: "hailuo", capability: "image", enabled: true, bindings: [{ channelId: "primary", upstreamModel: model, enabled: true }] }],
            systemChannels: [{ id: "primary", enabled: true, models: [model], apiFormat: "openai", advancedConfig: { protocol: "dataeyes-flux" } }],
        });

        mocks.versions.mockResolvedValue([{ ...version, sku: model, items: [{ key: "image", unit: "image", per: "1", price: "0.1", currency: "USD" }] }]);
        mocks.images.mockImplementation(async (_versionId, _channelId, _model, operation) => [
            { ...token, operation, scope: "global-standard-dataeyes-flux-image", itemMeters: {}, imageLimit: { maxImages: 1, sourceUrl: "https://example.com/one-image", evidence: "单请求一张" } },
        ]);
        const direct = await getModelPricingAdmission("hailuo");
        expect(direct).toMatchObject({ structuralComplete: true, billingMode: "fixed-points", requiresShadowQuote: true });
        const imageVersion = (await mocks.versions())[0];
        const imageContracts = new Map(
            (await Promise.all(["generations", "edits"].map(async (operation) => [admissionKey("official", "primary", model, operation), (await mocks.images("official", "primary", model, operation))[0]]))) as Array<[string, unknown]>,
        );
        const read = {
            settings: await mocks.settings(),
            policy: await mocks.sales(),
            versionsById: new Map([["official", imageVersion]]),
            latestVersions: new Map([["hailuo", imageVersion]]),
            currentTextRules: new Map(),
            rulesById: new Map(),
            contracts: { text: new Map(), image: imageContracts, video: new Map(), audio: new Map() },
        } as ModelPricingAdmissionReadContext;
        const calls = mocks.images.mock.calls.length;
        expect(await getModelPricingAdmission("hailuo", undefined, read)).toEqual(direct);
        expect(mocks.images).toHaveBeenCalledTimes(calls);
    });
});
