import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    admission: vi.fn(),
    versions: vi.fn(),
    latest: vi.fn(),
    activations: vi.fn(),
    currentRules: vi.fn(),
    frozenRules: vi.fn(),
    text: vi.fn(),
    image: vi.fn(),
    video: vi.fn(),
    audio: vi.fn(),
    priceBindings: vi.fn(),
}));
vi.mock("./model-pricing-admission", () => ({ admissionKey: (...parts: string[]) => JSON.stringify(parts), getModelPricingAdmission: mocks.admission }));
vi.mock("./model-pricing-store", () => ({ getOfficialVersionsByIds: mocks.versions, getLatestOfficialVersionsForModels: mocks.latest }));
vi.mock("./model-pricing-activation-store", () => ({ activationKey: (modelId: string, scope?: string) => (scope ? JSON.stringify([modelId, scope]) : modelId), getModelPricingActivations: mocks.activations }));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBindings: mocks.priceBindings }));
vi.mock("./model-pricing-text-usage-rule-store", () => ({ getCurrentTextUsageRules: mocks.currentRules, getTextUsageRulesByIds: mocks.frozenRules }));
vi.mock("./model-pricing-token-contract-store", () => ({ listCurrentFlatTextPriceContracts: mocks.text }));
vi.mock("./model-pricing-image-contract-store", () => ({ listCurrentImagePriceContracts: mocks.image }));
vi.mock("./model-pricing-video-contract-store", () => ({ listCurrentVideoPriceContracts: mocks.video }));
vi.mock("./model-pricing-audio-contract-store", () => ({ listCurrentAudioPriceContracts: mocks.audio }));

import { getModelPricingBatchStates } from "./model-pricing-admission-batch";

describe("read-only workbench admission summary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.versions.mockResolvedValue([]);
        mocks.latest.mockResolvedValue(new Map());
        mocks.currentRules.mockResolvedValue(new Map());
        mocks.frozenRules.mockResolvedValue(new Map());
        mocks.priceBindings.mockResolvedValue([]);
        for (const name of ["text", "image", "video", "audio"] as const) mocks[name].mockResolvedValue([]);
        mocks.admission.mockImplementation(async (id: string) => ({
            modelId: id,
            officialVersionId: "official",
            textUsageRuleId: null,
            fingerprint: "model-fingerprint",
            blockers: [],
            bindings: Array.from({ length: id === "four" ? 4 : 2 }, (_, index) => ({
                key: `channel-${index}/sku`,
                fingerprint: index === 3 ? null : `binding-${index}`,
                contractIds: index === 3 ? [] : [`contract-${index}`],
                blockers: [],
            })),
        }));
    });

    it("counts one accepted binding among four, keeps old records unknown, and excludes closed models", async () => {
        const models = ["four", "legacy", "closed"].map((id) => ({
            id,
            capability: "video",
            enabled: id !== "closed",
            bindings: Array.from({ length: id === "four" ? 4 : 2 }, (_, index) => ({ channelId: `channel-${index}`, upstreamModel: "sku", enabled: true })),
        }));
        const settings = { logicalModels: models, systemChannels: [] };
        const policy = { priceVersionIds: { four: "official", legacy: "official", closed: "official" } };
        mocks.activations.mockResolvedValue(
            new Map([
                ["four", { enabled: true, officialVersionId: "official", fingerprint: "model-fingerprint", bindings: { "channel-0/sku": { fingerprint: "binding-0" } } }],
                ["legacy", { enabled: true, officialVersionId: "official", fingerprint: "legacy-fingerprint" }],
            ]),
        );
        const states = await getModelPricingBatchStates(
            models.map((model) => model.id),
            settings as unknown as Parameters<typeof getModelPricingBatchStates>[1],
            policy as unknown as Parameters<typeof getModelPricingBatchStates>[2],
        );
        expect(states.get("four")).toMatchObject({ billingMode: "metered", qualifiedBindings: 3, activeBindings: 1, pendingBindings: 3 });
        expect(states.get("legacy")).toMatchObject({ billingMode: "review-needed", pendingBindings: null });
        expect(states.get("closed")).toMatchObject({ billingMode: "disabled", pendingBindings: null });
        expect(mocks.activations).toHaveBeenCalledOnce();
        expect(mocks.video).toHaveBeenCalledOnce();
        expect(mocks.admission).toHaveBeenCalledWith("four", undefined, expect.objectContaining({ settings, policy }));
    });

    it("keeps an already active text binding on its frozen cache rule", async () => {
        const settings = { logicalModels: [{ id: "text", capability: "text", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }], systemChannels: [] };
        const policy = { priceVersionIds: { text: "official" } };
        mocks.admission.mockImplementation(async (_id: string, ruleId?: string | null) => ({
            officialVersionId: "official",
            textUsageRuleId: ruleId || "new-rule",
            fingerprint: ruleId ? "old-model" : "new-model",
            blockers: [],
            bindings: [{ key: "channel/sku", fingerprint: ruleId ? "old-binding" : "new-binding", contractIds: ["contract"], blockers: [] }],
        }));
        mocks.activations.mockResolvedValue(new Map([["text", { enabled: true, officialVersionId: "official", textUsageRuleId: "old-rule", fingerprint: "old-model", bindings: { "channel/sku": { fingerprint: "old-binding" } } }]]));
        const states = await getModelPricingBatchStates(["text"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("text")).toMatchObject({ billingMode: "metered", qualifiedBindings: 1, activeBindings: 1, pendingBindings: 0 });
        expect(mocks.frozenRules).toHaveBeenCalledWith(["old-rule"]);
        expect(mocks.admission).toHaveBeenCalledWith("text", "old-rule", expect.any(Object), undefined, undefined, true);
    });

    it("counts a preserved old approval as qualified and exposes a stale channel fingerprint", async () => {
        const settings = { logicalModels: [{ id: "text", capability: "text", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }], systemChannels: [] };
        const policy = { priceVersionIds: { text: "official" } };
        mocks.admission.mockImplementation(async (_id: string, _rule: unknown, _read: unknown, _image: unknown, _audio: unknown, preserve: boolean) => ({
            officialVersionId: "official",
            reviewedOfficialVersionId: "official",
            textUsageRuleId: null,
            fingerprint: "model-fingerprint",
            blockers: preserve ? [] : ["channel/sku：文本契约缺少已审核的独立预留估算"],
            bindings: [{ key: "channel/sku", fingerprint: preserve ? "binding-fingerprint" : null, contractIds: ["contract"], blockers: preserve ? [] : ["文本契约缺少已审核的独立预留估算"] }],
        }));
        mocks.activations.mockResolvedValue(new Map([["text", { enabled: true, officialVersionId: "official", fingerprint: "model-fingerprint", bindings: { "channel/sku": { fingerprint: "binding-fingerprint" } } }]]));
        const active = await getModelPricingBatchStates(["text"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(active.get("text")).toMatchObject({ billingMode: "metered", qualifiedBindings: 1, activeBindings: 1, blocker: null });
        mocks.activations.mockResolvedValue(new Map([["text", { enabled: true, officialVersionId: "official", fingerprint: "model-fingerprint", bindings: { "channel/sku": { fingerprint: "stale" } } }]]));
        const stale = await getModelPricingBatchStates(["text"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(stale.get("text")).toMatchObject({ billingMode: "paused", qualifiedBindings: 0, activeBindings: 0, blocker: "已启用的渠道与当前价目或契约不一致" });
    });

    it("aggregates selected image operations and reads each scope's binding in one batch", async () => {
        const settings = { logicalModels: [{ id: "image", capability: "image", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }], systemChannels: [] };
        const policy = {
            priceVersionIds: {},
            selectedPriceBindings: [
                { logicalModelId: "image", scope: "image:generations:standard", officialVersionId: "price-generation" },
                { logicalModelId: "image", scope: "image:edits:standard", officialVersionId: "price-edit" },
            ],
        };
        mocks.versions.mockResolvedValue([{ id: "price-generation" }, { id: "price-edit" }]);
        mocks.priceBindings.mockImplementation(async (_ids: string[], scope: string) => (scope.startsWith("image:") ? [{ logicalModelId: "image", scope }] : []));
        mocks.admission.mockImplementation(async (_id: string, _ruleId: unknown, read: { priceBindings: Map<string, { scope: string }> }, operation: "generations" | "edits") => {
            expect(read.priceBindings.get(JSON.stringify(["image", `image:${operation}:standard`]))?.scope).toBe(`image:${operation}:standard`);
            return { officialVersionId: operation === "generations" ? "price-generation" : "price-edit", fingerprint: `fingerprint-${operation}`, bindings: [{ key: "channel/sku", fingerprint: `binding-${operation}` }], blockers: [] };
        });
        mocks.activations.mockResolvedValue(
            new Map([[JSON.stringify(["image", "image:generations:standard"]), { enabled: true, officialVersionId: "price-generation", fingerprint: "fingerprint-generations", bindings: { "channel/sku": { fingerprint: "binding-generations" } } }]]),
        );
        const states = await getModelPricingBatchStates(["image"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("image")).toMatchObject({ billingMode: "metered", qualifiedBindings: 2, activeBindings: 1, pendingBindings: 1, blocker: "仅部分图片操作或渠道已启用按量" });
        expect(mocks.versions).toHaveBeenCalledWith(["price-generation", "price-edit"]);
        expect(mocks.activations).toHaveBeenCalledWith(["image", JSON.stringify(["image", "image:generations:standard"]), JSON.stringify(["image", "image:edits:standard"])]);
    });

    it.each([
        { generation: "active", scopedEdit: true, expectedActive: 4 },
        { generation: "active", scopedEdit: false, expectedActive: 4 },
        { generation: "disabled", scopedEdit: false, expectedActive: 2 },
        { generation: "stale", scopedEdit: false, expectedActive: 2 },
    ])("summarizes legacy image prices with $generation generation approval and scopedEdit=$scopedEdit", async ({ generation, scopedEdit, expectedActive }) => {
        const settings = {
            logicalModels: [{ id: "image", capability: "image", enabled: true, bindings: [0, 1].map((index) => ({ channelId: `channel-${index}`, upstreamModel: "sku", enabled: true })) }],
            systemChannels: [],
        };
        const policy = { priceVersionIds: { image: "official" } };
        const approval = (scope: string) => ({
            enabled: true,
            officialVersionId: "official",
            fingerprint: `model-${scope}`,
            bindings: Object.fromEntries([0, 1].map((index) => [`channel-${index}/sku`, { fingerprint: `${scope}-${index}` }])),
        });
        const activations = new Map([
            ["image", approval("legacy")],
            [JSON.stringify(["image", "image:generations:standard"]), { ...approval(generation === "stale" ? "outdated" : "generations"), enabled: generation !== "disabled" }],
        ]);
        if (scopedEdit) activations.set(JSON.stringify(["image", "image:edits:standard"]), approval("edits"));
        mocks.activations.mockResolvedValue(activations);
        mocks.admission.mockImplementation(async (_id: string, _rule: unknown, _read: unknown, operation: string | undefined, _audio: unknown, preserve: boolean) => {
            const scope = operation || "legacy";
            const ready = Boolean(operation || preserve);
            return {
                officialVersionId: "official",
                fingerprint: `model-${scope}`,
                blockers: ready ? [] : ["缺少新批准需要的预留估算"],
                bindings: [0, 1].map((index) => ({ key: `channel-${index}/sku`, fingerprint: ready ? `${scope}-${index}` : null })),
            };
        });
        const states = await getModelPricingBatchStates(["image"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("image")).toMatchObject({ billingMode: "metered", billingBindingSlots: 4, qualifiedBindings: 4, activeBindings: expectedActive, pendingBindings: 4 - expectedActive });
        if (expectedActive === 4) expect(states.get("image")?.blocker).toBeNull();
    });

    it("does not count an unselected image edit operation as a pending billing slot", async () => {
        const settings = { logicalModels: [{ id: "image", capability: "image", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "flux-pro-1.1", enabled: true }] }], systemChannels: [] };
        const policy = { priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "image", scope: "image:generations:standard", officialVersionId: "price-generation" }] };
        mocks.versions.mockResolvedValue([{ id: "price-generation" }]);
        mocks.admission.mockResolvedValue({ officialVersionId: "price-generation", fingerprint: "fingerprint", bindings: [{ key: "channel/flux-pro-1.1", fingerprint: "binding" }], blockers: [] });
        mocks.activations.mockResolvedValue(
            new Map([[JSON.stringify(["image", "image:generations:standard"]), { enabled: true, officialVersionId: "price-generation", fingerprint: "fingerprint", bindings: { "channel/flux-pro-1.1": { fingerprint: "binding" } } }]]),
        );
        const states = await getModelPricingBatchStates(["image"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("image")).toMatchObject({ billingMode: "metered", billingBindingSlots: 1, qualifiedBindings: 1, activeBindings: 1, pendingBindings: 0, blocker: null });
        expect(mocks.admission).toHaveBeenCalledOnce();
        expect(mocks.admission.mock.calls[0][3]).toBe("generations");
    });

    it("reports a stale image activation as needing review while its selected price still exists", async () => {
        const settings = { logicalModels: [{ id: "image", capability: "image", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }], systemChannels: [] };
        const policy = { priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "image", scope: "image:generations:standard", officialVersionId: "price" }] };
        mocks.admission.mockResolvedValue({ officialVersionId: "price", fingerprint: "current", bindings: [{ key: "channel/sku", fingerprint: "current-binding" }], blockers: [] });
        mocks.activations.mockResolvedValue(new Map([[JSON.stringify(["image", "image:generations:standard"]), { enabled: true, officialVersionId: "price", fingerprint: "old", bindings: { "channel/sku": { fingerprint: "old-binding" } } }]]));
        const states = await getModelPricingBatchStates(["image"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("image")).toMatchObject({ billingMode: "paused", activeBindings: 0, pendingBindings: 1, blocker: "已启用的图片操作与当前价目或契约不一致" });
    });

    it("shows the affected image operation's concrete admission blocker", async () => {
        const settings = { logicalModels: [{ id: "image", capability: "image", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }], systemChannels: [] };
        const policy = { priceVersionIds: {}, selectedPriceBindings: ["generations", "edits"].map((operation) => ({ logicalModelId: "image", scope: `image:${operation}:standard`, officialVersionId: `price-${operation}` })) };
        mocks.admission.mockImplementation(async (_id: string, _rule: unknown, _read: unknown, operation: string) => ({
            officialVersionId: `price-${operation}`,
            fingerprint: `fingerprint-${operation}`,
            bindings: [{ key: "channel/sku", fingerprint: operation === "generations" ? "approved" : null }],
            blockers: operation === "edits" ? ["channel/sku：编辑计量契约缺失"] : [],
        }));
        mocks.activations.mockResolvedValue(
            new Map([[JSON.stringify(["image", "image:generations:standard"]), { enabled: true, officialVersionId: "price-generations", fingerprint: "fingerprint-generations", bindings: { "channel/sku": { fingerprint: "approved" } } }]]),
        );
        const states = await getModelPricingBatchStates(["image"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("image")).toMatchObject({ billingMode: "metered", activeBindings: 1, pendingBindings: 1, blocker: "图片编辑：channel/sku：编辑计量契约缺失" });
    });

    it("includes an independently selected video version and binding in model-level admission", async () => {
        const settings = { logicalModels: [{ id: "video", capability: "video", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }], systemChannels: [] };
        const policy = { priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "video", scope: "video:generation:standard", officialVersionId: "selected-video" }] };
        mocks.versions.mockResolvedValue([{ id: "selected-video" }]);
        mocks.priceBindings.mockImplementation(async (_ids: string[], scope: string) => (scope === "video:generation:standard" ? [{ logicalModelId: "video", scope }] : []));
        mocks.admission.mockImplementation(async (_id: string, _ruleId: unknown, read: { priceBindings: Map<string, { scope: string }> }) => {
            expect(read.priceBindings.get("video")?.scope).toBe("video:generation:standard");
            return { officialVersionId: "selected-video", fingerprint: "fingerprint", bindings: [{ key: "channel/sku", fingerprint: "binding" }], blockers: [] };
        });
        mocks.activations.mockResolvedValue(new Map([["video", { enabled: true, officialVersionId: "selected-video", fingerprint: "fingerprint", bindings: { "channel/sku": { fingerprint: "binding" } } }]]));
        const states = await getModelPricingBatchStates(["video"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("video")).toMatchObject({ billingMode: "metered", billingBindingSlots: 1, activeBindings: 1, pendingBindings: 0 });
        expect(mocks.versions).toHaveBeenCalledWith(["selected-video"]);
    });

    it("counts audio slots by protocol while reading both selected operation scopes", async () => {
        const settings = {
            logicalModels: [
                {
                    id: "audio",
                    capability: "audio",
                    enabled: true,
                    bindings: [
                        { channelId: "gemini", upstreamModel: "gemini-sku", enabled: true },
                        { channelId: "openai", upstreamModel: "openai-sku", enabled: true },
                    ],
                },
            ],
            systemChannels: [
                { id: "gemini", advancedConfig: { protocol: "gemini" } },
                { id: "openai", advancedConfig: { protocol: "openai" } },
            ],
        };
        const policy = {
            priceVersionIds: {},
            selectedPriceBindings: [
                { logicalModelId: "audio", scope: "audio:generateContent:standard", officialVersionId: "gemini-price" },
                { logicalModelId: "audio", scope: "audio:chat/completions:standard", officialVersionId: "openai-price" },
            ],
        };
        mocks.versions.mockResolvedValue([{ id: "gemini-price" }, { id: "openai-price" }]);
        mocks.priceBindings.mockImplementation(async (_ids: string[], scope: string) => (scope.startsWith("audio:") ? [{ logicalModelId: "audio", scope }] : []));
        mocks.admission.mockImplementation(async (_id: string, _ruleId: unknown, read: { priceBindings: Map<string, { scope: string }> }, _imageOperation: unknown, audioOperation: "generateContent" | "chat/completions") => {
            const scope = `audio:${audioOperation}:standard`;
            expect(read.priceBindings.get(JSON.stringify(["audio", scope]))?.scope).toBe(scope);
            const suffix = audioOperation === "generateContent" ? "gemini" : "openai";
            return { officialVersionId: `${suffix}-price`, fingerprint: `fingerprint-${suffix}`, bindings: [{ key: `${suffix}/${suffix}-sku`, fingerprint: `binding-${suffix}` }], blockers: [] };
        });
        mocks.activations.mockResolvedValue(
            new Map([[JSON.stringify(["audio", "audio:generateContent:standard"]), { enabled: true, officialVersionId: "gemini-price", fingerprint: "fingerprint-gemini", bindings: { "gemini/gemini-sku": { fingerprint: "binding-gemini" } } }]]),
        );
        const states = await getModelPricingBatchStates(["audio"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("audio")).toMatchObject({ billingMode: "metered", billingBindingSlots: 2, qualifiedBindings: 2, activeBindings: 1, pendingBindings: 1, blocker: "仅部分音频操作或渠道已启用按量" });
        expect(mocks.activations).toHaveBeenCalledWith(["audio", JSON.stringify(["audio", "audio:generateContent:standard"]), JSON.stringify(["audio", "audio:chat/completions:standard"])]);
    });

    it("reports a stale audio activation as needing review while its selected price still exists", async () => {
        const settings = {
            logicalModels: [{ id: "audio", capability: "audio", enabled: true, bindings: [{ channelId: "channel", upstreamModel: "sku", enabled: true }] }],
            systemChannels: [{ id: "channel", advancedConfig: { protocol: "gemini" } }],
        };
        const policy = { priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "audio", scope: "audio:generateContent:standard", officialVersionId: "price" }] };
        mocks.admission.mockResolvedValue({ officialVersionId: "price", fingerprint: "current", bindings: [{ key: "channel/sku", fingerprint: "current-binding" }], blockers: [] });
        mocks.activations.mockResolvedValue(new Map([[JSON.stringify(["audio", "audio:generateContent:standard"]), { enabled: true, officialVersionId: "price", fingerprint: "old", bindings: { "channel/sku": { fingerprint: "old-binding" } } }]]));
        const states = await getModelPricingBatchStates(["audio"], settings as unknown as Parameters<typeof getModelPricingBatchStates>[1], policy as unknown as Parameters<typeof getModelPricingBatchStates>[2]);
        expect(states.get("audio")).toMatchObject({ billingMode: "paused", activeBindings: 0, pendingBindings: 1, blocker: "已启用的音频操作与当前价目或契约不一致" });
    });
});
