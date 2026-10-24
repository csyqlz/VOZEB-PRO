import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { sanitizeAdvancedConfig } from "@/app/api/image-tasks/image-task-support";
import { toSystemGenerationChannel } from "./generation-channel";

const mocks = vi.hoisted(() => ({ admission: vi.fn(), get: vi.fn(), save: vi.fn(), settings: vi.fn(), updateSettings: vi.fn(), candidates: vi.fn(), shadow: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings, updateAuthSettingsWith: mocks.updateSettings }));
vi.mock("./model-pricing-admission", () => ({ getModelPricingAdmission: mocks.admission }));
vi.mock("./model-pricing-activation-store", () => ({ getModelPricingActivation: mocks.get, saveModelPricingActivation: mocks.save }));
vi.mock("./logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.candidates }));
vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: mocks.shadow }));

import { getModelPricingActivationStatus, publicModelPricingMode, setModelPricingActivation } from "./model-pricing-activation-service";

const keys = ["backup/sku", "primary/sku"];
const admission = {
    modelId: "logical",
    capability: "video",
    structuralComplete: true,
    fingerprint: "current",
    legacyFingerprint: "legacy",
    salesVersionId: "sales",
    officialVersionId: "official",
    contractIds: ["first", "second"],
    bindingKeys: keys,
    blockers: [],
    bindings: [
        { key: "primary/sku", fingerprint: "primary-fingerprint", contractIds: ["first"], blockers: [] },
        { key: "backup/sku", fingerprint: "backup-fingerprint", contractIds: ["second"], blockers: [] },
    ],
};
const evidence = { fixtures: "fixture run", realChannels: { "backup/sku": "backup run", "primary/sku": "primary run" }, entrypoints: "all entrypoints", recovery: "refund and recovery" };
const candidates = ["primary", "backup"].map((channelId) => ({
    logicalModelId: "logical",
    channelId,
    upstreamModel: "sku",
    channel: applyChannelProtocol({ id: channelId, name: channelId, baseUrl: `https://${channelId}.example.com`, apiKey: "fixture-key", apiFormat: "openai", models: ["sku"], enabled: true }, "minimax"),
}));
const configs = candidates.map(toSystemGenerationChannel);

describe("per-model pricing activation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.admission.mockResolvedValue(admission);
        mocks.settings.mockResolvedValue({});
        mocks.candidates.mockReturnValue(candidates);
        mocks.get.mockResolvedValue(undefined);
        mocks.shadow.mockImplementation(async (_modelId, _versionId, contractIds: string[]) => ({ ready: true, missingCount: 0, receiptIds: Object.fromEntries(contractIds.map((id) => [id, `receipt-${id}`])), sample: null }));
        mocks.save.mockImplementation(async (value) => {
            mocks.get.mockResolvedValue(value);
            return value;
        });
    });

    it("activates image generation and edits independently and blocks only a stale operation", async () => {
        const stored = new Map<string, typeof admission & { scope?: string }>();
        const scopedAdmission = (operation: "generations" | "edits") => ({
            ...admission,
            capability: "image",
            imageOperation: operation,
            fingerprint: `fingerprint-${operation}`,
            officialVersionId: `official-${operation}`,
            bindings: admission.bindings.map((binding) => ({ ...binding, fingerprint: `${binding.key}-${operation}` })),
        });
        mocks.admission.mockImplementation(async (_modelId: string, _ruleId: unknown, _read: unknown, operation?: "generations" | "edits") => scopedAdmission(operation!));
        mocks.get.mockImplementation(async (_modelId: string, scope?: string) => stored.get(scope || ""));
        mocks.save.mockImplementation(async (value) => {
            stored.set(value.scope || "", value);
            return value;
        });
        const generation = await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", imageOperation: "generations" });
        const edit = await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", imageOperation: "edits" });
        expect(generation.activation?.scope).toBe("image:generations:standard");
        expect(edit.activation?.scope).toBe("image:edits:standard");
        expect(generation.activation?.revision).not.toBe(edit.activation?.revision);
        expect(await publicModelPricingMode("logical", "image", configs, "generations")).toMatchObject({ billingMode: "official-usage", scope: "image:generations:standard", officialVersionId: "official-generations" });
        expect(await publicModelPricingMode("logical", "image", configs, "edits")).toMatchObject({ billingMode: "official-usage", scope: "image:edits:standard", officialVersionId: "official-edits" });
        mocks.admission.mockImplementation(async (_modelId: string, _ruleId: unknown, _read: unknown, operation?: "generations" | "edits") => ({
            ...scopedAdmission(operation!),
            fingerprint: operation === "edits" ? "changed-edit" : `fingerprint-${operation}`,
        }));
        expect(await publicModelPricingMode("logical", "image", configs, "generations")).toMatchObject({ billingMode: "official-usage" });
        expect(await publicModelPricingMode("logical", "image", configs, "edits")).toMatchObject({ billingMode: "blocked" });
    });

    it("keeps Gemini and OpenAI audio activations separate", async () => {
        const stored = new Map<string, typeof admission & { scope?: string }>();
        const scopedAdmission = (operation: "generateContent" | "chat/completions") => ({
            ...admission,
            capability: "audio",
            audioOperation: operation,
            fingerprint: `fingerprint-${operation}`,
            officialVersionId: `official-${operation}`,
            bindings: admission.bindings.map((binding) => ({ ...binding, fingerprint: `${binding.key}-${operation}` })),
        });
        mocks.admission.mockImplementation(async (_modelId: string, _ruleId: unknown, _read: unknown, _imageOperation: unknown, audioOperation?: "generateContent" | "chat/completions") => scopedAdmission(audioOperation!));
        mocks.get.mockImplementation(async (_modelId: string, scope?: string) => stored.get(scope || ""));
        mocks.save.mockImplementation(async (value) => {
            stored.set(value.scope || "", value);
            return value;
        });
        const gemini = await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", audioOperation: "generateContent" });
        const openai = await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", audioOperation: "chat/completions" });
        expect(gemini.activation?.scope).toBe("audio:generateContent:standard");
        expect(openai.activation?.scope).toBe("audio:chat/completions:standard");
        expect(await publicModelPricingMode("logical", "audio", configs, undefined, "generateContent")).toMatchObject({ billingMode: "official-usage", officialVersionId: "official-generateContent" });
        expect(await publicModelPricingMode("logical", "audio", configs, undefined, "chat/completions")).toMatchObject({ billingMode: "official-usage", officialVersionId: "official-chat/completions" });
        mocks.admission.mockImplementation(async (_modelId: string, _ruleId: unknown, _read: unknown, _imageOperation: unknown, audioOperation?: "generateContent" | "chat/completions") => ({
            ...scopedAdmission(audioOperation!),
            fingerprint: audioOperation === "chat/completions" ? "changed-openai" : `fingerprint-${audioOperation}`,
        }));
        expect(await publicModelPricingMode("logical", "audio", configs, undefined, "generateContent")).toMatchObject({ billingMode: "official-usage" });
        expect(await publicModelPricingMode("logical", "audio", configs, undefined, "chat/completions")).toMatchObject({ billingMode: "blocked" });
    });

    it("requires priced shadow receipts for every current contract before enabling", async () => {
        mocks.shadow.mockResolvedValueOnce({ ready: false, missingCount: 1, receiptIds: {}, sample: null });
        await expect(setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", bindingKey: "primary/sku" })).rejects.toThrow("缺少 1 份");
        expect(mocks.save).not.toHaveBeenCalled();
        const status = await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin" });
        expect(status.active).toBe(true);
        expect(mocks.shadow).toHaveBeenCalledWith("logical", "official", ["first"], "primary");
        expect(mocks.shadow).toHaveBeenCalledWith("logical", "official", ["second"], "backup");
        expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, fingerprint: "current", evidence: { shadowReceiptIds: { first: "receipt-first", second: "receipt-second" } } }), null);
        expect(await publicModelPricingMode("logical", "video", configs)).toEqual({ billingMode: "official-usage", fingerprint: "current", salesVersionId: "sales", officialVersionId: "official", bindingKeys: ["primary/sku", "backup/sku"] });
    });

    it("releases only the accepted binding from directed-only routing after shadow evidence is saved", async () => {
        const settings = {
            logicalModels: [
                {
                    id: "logical",
                    bindings: [
                        { channelId: "primary", upstreamModel: "sku", acceptanceOnly: true },
                        { channelId: "backup", upstreamModel: "sku", acceptanceOnly: true },
                    ],
                },
            ],
        };
        mocks.settings.mockResolvedValue(settings);
        let updated: typeof settings | undefined;
        mocks.updateSettings.mockImplementation(async (makePatch: (value: typeof settings) => typeof settings) => {
            updated = makePatch(settings);
            return updated;
        });
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", bindingKey: "primary/sku" });
        expect(updated?.logicalModels[0].bindings).toEqual([expect.objectContaining({ channelId: "primary", acceptanceOnly: false }), expect.objectContaining({ channelId: "backup", acceptanceOnly: true })]);
        await publicModelPricingMode("logical", "video", configs);
        expect(mocks.candidates).toHaveBeenCalledWith(expect.anything(), "video", "logical", "", true);
    });

    it("keeps activation when an unrelated model changes the global sale version", async () => {
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin" });
        mocks.admission.mockResolvedValue({ ...admission, salesVersionId: "another-global-version" });
        expect((await getModelPricingActivationStatus("logical")).active).toBe(true);
        expect(await publicModelPricingMode("logical", "video", configs)).toMatchObject({ salesVersionId: "another-global-version" });
    });

    it("keeps the old text rule active until every previously metered binding has new evidence", async () => {
        const oldAdmission = { ...admission, capability: "text", fingerprint: "old-rule", textUsageRuleId: "old-rule", bindings: admission.bindings.map((item) => ({ ...item, fingerprint: `${item.fingerprint}-old` })) };
        const newAdmission = { ...oldAdmission, fingerprint: "new-rule", textUsageRuleId: "new-rule", bindings: oldAdmission.bindings.map((item) => ({ ...item, fingerprint: item.fingerprint.replace("-old", "-new") })) };
        mocks.admission.mockResolvedValue(oldAdmission);
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin" });
        const original = await getModelPricingActivationStatus("logical");
        mocks.admission.mockImplementation(async (_modelId: string, ruleId?: string) => (ruleId === "old-rule" ? oldAdmission : newAdmission));
        mocks.shadow.mockImplementation(async (_modelId, _versionId, contractIds: string[], _channelId, ruleId) => ({
            ready: ruleId !== "new-rule" || contractIds[0] === "first",
            missingCount: 1,
            receiptIds: { [contractIds[0]]: `receipt-${contractIds[0]}` },
            sample: null,
        }));
        expect((await getModelPricingActivationStatus("logical")).active).toBe(true);
        await expect(setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: original.activation!.revision, actorId: "admin" })).rejects.toThrow("旧规则继续生效");
        expect((await getModelPricingActivationStatus("logical")).activation?.textUsageRuleId).toBe("old-rule");
        mocks.shadow.mockImplementation(async (_modelId, _versionId, contractIds: string[]) => ({ ready: true, missingCount: 0, receiptIds: { [contractIds[0]]: `receipt-${contractIds[0]}` }, sample: null }));
        const switched = await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: original.activation!.revision, actorId: "admin" });
        expect(switched.activation?.textUsageRuleId).toBe("new-rule");
        expect(switched.active).toBe(true);
    });

    it("blocks new tasks when an active model's price or capability changes", async () => {
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", evidence });
        mocks.admission.mockResolvedValue({ ...admission, fingerprint: "changed" });
        const status = await getModelPricingActivationStatus("logical");
        expect(status.active).toBe(false);
        expect(status.bindings[0].approvalBlocker).toBe("旧批准的模型计价条件已变更");
        expect(await publicModelPricingMode("logical", "video", configs)).toMatchObject({ billingMode: "blocked" });
        mocks.admission.mockResolvedValue(admission);
        expect(await publicModelPricingMode("logical", "image", configs)).toMatchObject({ billingMode: "blocked" });
        expect(await publicModelPricingMode("logical", "video", [...configs, { logicalModel: "logical", channelId: "unknown", model: "sku" }])).toMatchObject({ bindingKeys: ["primary/sku", "backup/sku"] });
        expect(await publicModelPricingMode("logical", "video", [{ ...configs[0], channelId: "" }])).toMatchObject({ billingMode: "blocked" });
        mocks.get.mockRejectedValue(new Error("pricing store unavailable"));
        expect(await publicModelPricingMode("logical", "video", configs)).toMatchObject({ billingMode: "blocked" });
    });

    it("distinguishes a stale old channel approval from the missing estimate required for a new approval", async () => {
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", evidence });
        mocks.admission.mockImplementation(async (_modelId, _ruleId, _read, _imageOperation, _audioOperation, preserveLegacyReservation) =>
            preserveLegacyReservation
                ? { ...admission, bindings: admission.bindings.map((binding) => (binding.key === "primary/sku" ? { ...binding, fingerprint: "changed-channel" } : binding)) }
                : { ...admission, structuralComplete: false, bindings: admission.bindings.map((binding) => ({ ...binding, fingerprint: null, blockers: ["缺少已审核的独立预留估算"] })) },
        );
        const status = await getModelPricingActivationStatus("logical");
        expect(status.bindings.find((binding) => binding.key === "primary/sku")).toMatchObject({ active: false, approvalBlocker: "旧批准的渠道指纹与当前配置不一致", blockers: ["缺少已审核的独立预留估算"] });
        expect(status.bindings.find((binding) => binding.key === "backup/sku")).toMatchObject({ active: true, approvalBlocker: null });
    });

    it("accepts the image route's trimmed config but rejects a changed upstream path", async () => {
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", evidence });
        mocks.admission.mockResolvedValue({ ...admission, capability: "image" });
        const imageConfigs = configs.map((config) => ({ ...config, advancedConfig: sanitizeAdvancedConfig(config.advancedConfig) }));
        expect(await publicModelPricingMode("logical", "image", imageConfigs)).toMatchObject({ billingMode: "official-usage" });
        imageConfigs[0].advancedConfig!.createPath = "/v1/unreviewed-path";
        expect(await publicModelPricingMode("logical", "image", imageConfigs)).toMatchObject({ bindingKeys: ["backup/sku"] });
    });

    it("keeps an existing channel metered when a new channel is added, then admits only that channel", async () => {
        const original = { ...admission, bindings: admission.bindings.slice(0, 1), bindingKeys: ["primary/sku"] };
        mocks.admission.mockResolvedValue(original);
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", bindingKey: "primary/sku" });
        const newBinding = { key: "new/sku", fingerprint: "new-fingerprint", contractIds: ["third"], blockers: [] };
        mocks.admission.mockResolvedValue({ ...original, bindings: [...original.bindings, newBinding], bindingKeys: ["primary/sku", "new/sku"] });
        const newCandidate = { ...candidates[0], channelId: "new", channel: { ...candidates[0].channel, id: "new" } };
        const newConfig = toSystemGenerationChannel(newCandidate);
        mocks.candidates.mockReturnValue([...candidates, newCandidate]);
        expect((await getModelPricingActivationStatus("logical")).bindings.map((item) => [item.key, item.active])).toEqual([
            ["primary/sku", true],
            ["new/sku", false],
        ]);
        expect(await publicModelPricingMode("logical", "video", [configs[0], newConfig])).toMatchObject({ bindingKeys: ["primary/sku"] });
        mocks.shadow.mockImplementation(async (_modelId, _versionId, contractIds: string[]) => ({ ready: contractIds[0] !== "third", missingCount: 1, receiptIds: {}, sample: null }));
        await expect(setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: (await getModelPricingActivationStatus("logical")).activation!.revision, actorId: "admin", bindingKey: "new/sku" })).rejects.toThrow("缺少 1 份");
        mocks.shadow.mockResolvedValue({ ready: true, missingCount: 0, receiptIds: { third: "receipt-third" }, sample: null });
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: (await getModelPricingActivationStatus("logical")).activation!.revision, actorId: "admin", bindingKey: "new/sku" });
        expect(await publicModelPricingMode("logical", "video", [configs[0], newConfig])).toMatchObject({ bindingKeys: ["primary/sku", "new/sku"] });
    });

    it("upgrades a live model-level activation only when its old fingerprint and exact per-channel receipts still match", async () => {
        const legacy = {
            modelId: "logical",
            enabled: true,
            revision: "old-revision",
            fingerprint: "legacy",
            salesVersionId: "sales",
            officialVersionId: "official",
            evidence: { shadowReceiptIds: { first: "receipt-first", second: "receipt-second" } },
            changedAt: "2026-10-01T00:00:00Z",
            changedBy: "admin",
        };
        mocks.get.mockResolvedValue(legacy);
        const status = await getModelPricingActivationStatus("logical");
        expect(status.active).toBe(true);
        expect(status.bindings.map((binding) => binding.active)).toEqual([true, true]);
        expect(mocks.save).toHaveBeenCalledWith(
            expect.objectContaining({
                fingerprint: "current",
                bindings: { "primary/sku": expect.objectContaining({ shadowReceiptIds: { first: "receipt-first" } }), "backup/sku": expect.objectContaining({ shadowReceiptIds: { second: "receipt-second" } }) },
            }),
            "old-revision",
        );
        mocks.get.mockResolvedValue({ ...legacy, fingerprint: "changed" });
        mocks.save.mockClear();
        expect(await publicModelPricingMode("logical", "video", configs)).toMatchObject({ billingMode: "blocked" });
        expect(mocks.save).not.toHaveBeenCalled();
        mocks.get.mockResolvedValue(legacy);
        mocks.shadow.mockImplementation(async (_modelId, _versionId, contractIds: string[]) => ({ ready: true, missingCount: 0, receiptIds: { [contractIds[0]]: "different-receipt" }, sample: null }));
        expect(await publicModelPricingMode("logical", "video", configs)).toMatchObject({ billingMode: "blocked" });
    });

    it("blocks a metered model before submission if no approved binding is usable", async () => {
        await setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", bindingKey: "primary/sku" });
        mocks.admission.mockResolvedValue({ ...admission, structuralComplete: false, bindings: admission.bindings.map((item) => ({ ...item, fingerprint: null })) });
        expect(await publicModelPricingMode("logical", "video", configs)).toMatchObject({ billingMode: "blocked", reason: expect.stringContaining("未向上游提交") });
    });

    it("leaves unreviewed models on fixed points", async () => {
        mocks.admission.mockResolvedValue({ ...admission, structuralComplete: false, fingerprint: null, blockers: ["缺少常规付费单价"] });
        await expect(setModelPricingActivation({ modelId: "logical", enabled: true, expectedRevision: null, actorId: "admin", evidence })).rejects.toThrow("缺少常规付费单价");
        expect(await publicModelPricingMode("logical", "video", configs)).toBeUndefined();
    });
});
