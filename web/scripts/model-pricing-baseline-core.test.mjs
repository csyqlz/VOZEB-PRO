import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { isAttentionReservation, summarizePricingBaseline } from "./model-pricing-baseline-core.mjs";

it("ignores zero unpaid settlement and retains positive debt or warnings", () => {
    expect(isAttentionReservation({ status: "settled", unpaidAtSettlement: "0" })).toBe(false);
    expect(isAttentionReservation({ status: "settled", unpaidAtSettlement: "0.0000", billingWarnings: [] })).toBe(false);
    expect(isAttentionReservation({ status: "settled", unpaidAtSettlement: "0.00001" })).toBe(true);
    expect(isAttentionReservation({ status: "settled", billingWarnings: ["unverified-usage"] })).toBe(true);
    expect(isAttentionReservation({ status: "reserved" })).toBe(true);
});

it("identifies missing historical references in attention reservations without exposing user IDs", () => {
    const result = summarizePricingBaseline({
        pricing: { currentSales: null, officialVersions: [], activations: {} },
        models: [],
        frozenReferenceCatalog: { officialVersionIds: ["price-present"], salesVersionIds: ["sale-present"], contractIds: ["contract-present"] },
        reservations: [
            { status: "reserved", userId: "private-user", modelId: "model", usageKind: "image", frozen: { version: { id: "price-missing" }, policy: { id: "sale-present" }, contractId: "contract-present" }, count: 2 },
            { status: "settled", modelId: "model", usageKind: "video", frozen: { version: { id: "price-present" }, policy: { id: "sale-missing" }, contractId: "contract-present" }, count: 1 },
            { status: "reserved", modelId: "model", usageKind: "audio", frozen: { version: { id: "price-present" }, policy: { id: "sale-present" }, contractId: "contract-missing" }, count: 1 },
        ],
    });
    expect(result.frozenReferenceIssues).toEqual([
        { status: "reserved", modelId: "model", usageKind: "image", officialVersionId: "price-missing", salesVersionId: "sale-present", contractId: "contract-present", missing: ["official-price-version"], count: 2 },
        { status: "settled", modelId: "model", usageKind: "video", officialVersionId: "price-present", salesVersionId: "sale-missing", contractId: "contract-present", missing: ["sales-version"], count: 1 },
        { status: "reserved", modelId: "model", usageKind: "audio", officialVersionId: "price-present", salesVersionId: "sale-present", contractId: "contract-missing", missing: ["metering-contract"], count: 1 },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-user");
});

it("keeps raw fixed-point settings separate from published usage prices", () => {
    const modelPointCosts = { __default__: 2, "channel::sku": 3.5 };
    const generationPointMultipliers = { imageQuality: { high: 1.4 }, videoQuality: {}, videoSeconds: {} };
    const result = summarizePricingBaseline({
        pricing: { currentSales: null, officialVersions: [], activations: {} },
        models: [],
        modelPointCosts,
        generationPointMultipliers,
        reservations: [],
    });
    expect(result.fixedPointConfiguration).toEqual({ modelPointCosts, generationPointMultipliers });
    expect(result.publishedBindings).toEqual([]);
    expect(summarizePricingBaseline({ pricing: { currentSales: null, officialVersions: [], activations: {} }, models: [], reservations: [] }).fixedPointConfiguration).toEqual({
        modelPointCosts: null,
        generationPointMultipliers: null,
    });
});

it("lists the published model price, actual coefficient precedence and unsettled frozen references", () => {
    const result = summarizePricingBaseline({
        pricing: {
            currentSales: {
                id: "sales-1",
                priceVersionIds: { a: "official-1", b: "official-1" },
                userPriceRules: [
                    { scope: "default", coefficient: "1" },
                    { scope: "series", manufacturer: "Vendor", series: "Family", coefficient: "1.2" },
                    { scope: "model", modelId: "b", coefficient: "1.5" },
                ],
            },
            officialVersions: [{ id: "official-1", linkedFromVersionId: "source-1", manufacturer: "Vendor", series: "Family", sku: "sku" }],
            activations: { a: { enabled: true, officialVersionId: "official-1", salesVersionId: "sales-1", bindings: { "channel/sku": {} } }, b: { enabled: false } },
        },
        models: [
            { id: "a", bindings: [{ enabled: true, channelId: "channel", upstreamModel: "sku" }] },
            { id: "b", bindings: [] },
        ],
        reservations: [
            {
                status: "reserved",
                modelId: "a",
                usageKind: "image",
                frozen: {
                    version: { id: "official-old" },
                    policy: { id: "sales-old" },
                    contractId: "contract-old",
                    priceSelection: { scope: "image:generations:standard", bindingId: "binding-old", bindingRevision: "revision-old" },
                    image: { call: { channelId: "channel", requestedModel: "sku", operation: "generations" } },
                },
                submission: { phase: "submitted" },
                preparation: { taskType: "image" },
                count: 2,
            },
            { status: "settled", modelId: "b", usageKind: "text", frozen: { version: { id: "official-1" }, policy: { id: "sales-1" } }, count: 1 },
        ],
    });
    expect(result.publishedBindings.map((binding) => [binding.modelId, binding.officialVersionId, binding.coefficientScope, binding.coefficient])).toEqual([
        ["a", "official-1", "series", "1.2"],
        ["b", "official-1", "model", "1.5"],
    ]);
    expect(result.publishedBindings[0].sourceVersionId).toBe("source-1");
    expect(result.seriesRuleImpacts).toEqual([
        {
            manufacturer: "Vendor",
            series: "Family",
            coefficient: "1.2",
            effectivePublishedReferences: [{ modelId: "a", officialVersionId: "official-1", withoutSeriesCoefficient: "1", withoutSeriesScope: "default", oneUsdPointsWithSeries: null, oneUsdPointsWithoutSeries: null }],
        },
    ]);
    expect(result.activeUsageModels).toEqual([{ modelId: "a", officialVersionId: "official-1", salesVersionId: "sales-1", bindingKeys: ["channel/sku"], shadowContractIds: [], bindingEvidenceKnown: true }]);
    expect(result.openReservationCount).toBe(2);
    expect(result.settledExceptions).toHaveLength(1);
    expect(result.openReservations[0]).toMatchObject({
        channelId: "channel",
        requestedModel: "sku",
        operation: "generations",
        officialVersionId: "official-old",
        salesVersionId: "sales-old",
        contractId: "contract-old",
        priceScope: "image:generations:standard",
        priceBindingId: "binding-old",
        priceBindingRevision: "revision-old",
        submissionPhase: "submitted",
    });
    expect(JSON.stringify(result)).not.toContain("userId");
});

it("projects the current series-rule impact against manufacturer or default rules without changing sales", () => {
    const sales = {
        id: "published-sale",
        priceVersionIds: { a: "family", b: "family", c: "other-family" },
        selectedPriceBindings: [{ logicalModelId: "d", scope: "image:generations:standard", bindingId: "binding-d", bindingRevision: "1", officialVersionId: "other-brand" }],
        conversion: { cnyPerUsd: "7.25", pointsPerCny: "100" },
        userPriceRules: [
            { scope: "default", coefficient: "1.1" },
            { scope: "manufacturer", manufacturer: "Vendor", coefficient: "1.5" },
            { scope: "series", manufacturer: "Vendor", series: "Family", coefficient: "2" },
            { scope: "series", manufacturer: "Vendor", series: "Other", coefficient: "3" },
            { scope: "series", manufacturer: "Another", series: "Family", coefficient: "1.3" },
            { scope: "model", modelId: "b", coefficient: "4" },
        ],
    };
    const result = summarizePricingBaseline({
        pricing: {
            currentSales: sales,
            officialVersions: [
                { id: "family", manufacturer: "Vendor", series: "Family" },
                { id: "other-family", manufacturer: "Vendor", series: "Other" },
                { id: "other-brand", manufacturer: "Another", series: "Family" },
            ],
            activations: {},
        },
        models: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
        reservations: [],
    });
    expect(result.seriesRuleImpacts).toMatchObject([
        { effectivePublishedReferences: [{ modelId: "a", withoutSeriesCoefficient: "1.5", withoutSeriesScope: "manufacturer", oneUsdPointsWithSeries: "1450.00", oneUsdPointsWithoutSeries: "1087.50" }] },
        { effectivePublishedReferences: [{ modelId: "c", withoutSeriesCoefficient: "1.5", withoutSeriesScope: "manufacturer", oneUsdPointsWithSeries: "2175.00", oneUsdPointsWithoutSeries: "1087.50" }] },
        { effectivePublishedReferences: [{ modelId: "d", scope: "image:generations:standard", withoutSeriesCoefficient: "1.1", withoutSeriesScope: "default", oneUsdPointsWithSeries: "942.50", oneUsdPointsWithoutSeries: "797.50" }] },
    ]);
    expect(result.publishedBindings.find((binding) => binding.modelId === "b")).toMatchObject({ coefficient: "4", coefficientScope: "model" });
    expect(sales.userPriceRules).toHaveLength(6);
});

it("includes independent sales references, checks their current revision and labels scoped activations", () => {
    const result = summarizePricingBaseline({
        pricing: {
            currentSales: {
                id: "sale",
                priceVersionIds: {},
                selectedPriceBindings: [
                    { logicalModelId: "image-a", scope: "image:generations:standard", bindingId: "binding-a", bindingRevision: "first", officialVersionId: "shared" },
                    { logicalModelId: "image-b", scope: "image:edits:standard", bindingId: "binding-b", bindingRevision: "first", officialVersionId: "shared" },
                    { logicalModelId: "image-c", scope: "image:generations:standard", bindingId: "binding-c", bindingRevision: "first", officialVersionId: "shared" },
                ],
                userPriceRules: [
                    { scope: "model", modelId: "image-a", coefficient: "0.25" },
                    { scope: "default", coefficient: "1" },
                ],
            },
            officialVersions: [{ id: "shared", manufacturer: "Vendor", series: "Image", sku: "sku" }],
            priceBindings: [
                { id: "binding-a", logicalModelId: "image-a", scope: "image:generations:standard", revision: "first", officialVersionId: "shared", status: "active", current: true },
                { id: "binding-b", logicalModelId: "image-b", scope: "image:edits:standard", revision: "changed", officialVersionId: "shared", status: "active", current: true },
            ],
            activations: { '["image-a","image:generations:standard"]': { modelId: "image-a", scope: "image:generations:standard", enabled: true, officialVersionId: "shared", salesVersionId: "sale", bindings: { channel: {} } } },
        },
        models: [
            { id: "image-a", bindings: [] },
            { id: "image-b", bindings: [] },
            { id: "image-c", bindings: [] },
        ],
        reservations: [],
        officialInventory: { total: 1 },
        candidateStatuses: {},
    });
    expect(result.publishedBindings).toEqual([
        expect.objectContaining({
            modelId: "image-a",
            kind: "selected",
            scope: "image:generations:standard",
            bindingId: "binding-a",
            bindingRevision: "first",
            officialVersionId: "shared",
            currentBindingMatchesPublished: true,
            currentBindingIssue: null,
            coefficient: "0.25",
        }),
        expect.objectContaining({ modelId: "image-b", kind: "selected", scope: "image:edits:standard", officialVersionId: "shared", currentBindingMatchesPublished: false, currentBindingIssue: "revision-changed", currentBindingRevision: "changed" }),
        expect.objectContaining({ modelId: "image-c", kind: "selected", scope: "image:generations:standard", currentBindingMatchesPublished: false, currentBindingIssue: "missing-current-binding" }),
    ]);
    expect(result.publishedSelectionIssues.map((item) => [item.modelId, item.currentBindingIssue])).toEqual([
        ["image-b", "revision-changed"],
        ["image-c", "missing-current-binding"],
    ]);
    expect(result.missingPublishedPriceVersionIds).toEqual([]);
    expect(result.activeUsageModels).toEqual([{ modelId: "image-a", scope: "image:generations:standard", officialVersionId: "shared", salesVersionId: "sale", bindingKeys: ["channel"], shadowContractIds: [], bindingEvidenceKnown: true }]);
});

it("does not mistake legacy shadow contract IDs for activated routing bindings", () => {
    const result = summarizePricingBaseline({
        pricing: { currentSales: null, officialVersions: [], activations: { legacy: { modelId: "image", enabled: true, evidence: { shadowReceiptIds: { "channel/image-sku": "receipt" } } } } },
        models: [{ id: "image", capability: "image", enabled: true, bindings: [{ id: "route", enabled: true, channelId: "channel", upstreamModel: "image-sku" }] }],
        channels: [{ id: "channel", enabled: true, apiFormat: "openai", advancedConfig: { protocol: "openai" } }],
        reservations: [],
    });
    expect(result.activeUsageModels).toEqual([{ modelId: "image", officialVersionId: null, salesVersionId: null, bindingKeys: [], shadowContractIds: ["channel/image-sku"], bindingEvidenceKnown: false }]);
    expect(result.routingReviewRows).toEqual([expect.objectContaining({ scope: "image:generations:standard", recordedBindingApproval: null }), expect.objectContaining({ scope: "image:edits:standard", recordedBindingApproval: null })]);
});

it("lists every configured binding and candidate operation without exposing channel secrets or claiming support", () => {
    const result = summarizePricingBaseline({
        pricing: {
            currentSales: { id: "sale", priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "image", scope: "image:generations:standard", bindingId: "selection", bindingRevision: "revision", officialVersionId: "price" }] },
            officialVersions: [{ id: "price", manufacturer: "Fixture", sku: "image-sku" }],
            priceBindings: [{ id: "selection", logicalModelId: "image", scope: "image:generations:standard", revision: "revision", officialVersionId: "price", status: "active", current: true }],
            activations: { "image-activation": { modelId: "image", scope: "image:generations:standard", enabled: true, bindings: { "channel/image-sku": {} } } },
        },
        models: [{ id: "image", capability: "image", enabled: true, bindings: [{ id: "route", enabled: true, acceptanceOnly: false, priority: 1, channelId: "channel", upstreamModel: "image-sku" }] }],
        channels: [{ id: "channel", enabled: true, apiFormat: "openai", apiKey: "private-key", baseUrl: "https://private.example", advancedConfig: { protocol: "openai", channelAuthHeader: "private-header" } }],
        reservations: [],
    });
    expect(result.routingReviewRows).toEqual([
        expect.objectContaining({
            modelId: "image",
            scope: "image:generations:standard",
            channelId: "channel",
            channelProtocol: "openai",
            operationSupport: "requires-protocol-verification",
            publishedReferenceKind: "selected",
            publishedOfficialVersionId: "price",
            recordedBindingApproval: true,
            runtimeMeteredEligibility: "requires-runtime-admission-verification",
        }),
        expect.objectContaining({ modelId: "image", scope: "image:edits:standard", channelId: "channel", operationSupport: "requires-protocol-verification", publishedReferenceKind: null, recordedBindingApproval: false }),
    ]);
    expect(JSON.stringify(result)).not.toContain("bindingActivated");
    expect(JSON.stringify(result)).not.toMatch(/private-key|private-header|private\.example/);
});

it("reports per-operation reservation evidence without exposing the underlying source or review text", () => {
    const result = summarizePricingBaseline({
        pricing: {
            currentSales: {
                selectedPriceBindings: [
                    { logicalModelId: "text", scope: "text:generation:standard", officialVersionId: "text-price" },
                    { logicalModelId: "image", scope: "image:generations:standard", officialVersionId: "image-price" },
                    { logicalModelId: "image", scope: "image:edits:standard", officialVersionId: "image-price" },
                ],
            },
            officialVersions: [{ id: "text-price" }, { id: "image-price" }],
            activations: {},
        },
        models: [
            { id: "text", capability: "text", bindings: [{ channelId: "channel", upstreamModel: "text-sku" }] },
            { id: "image", capability: "image", bindings: [{ channelId: "channel", upstreamModel: "image-sku" }] },
        ],
        currentContracts: [
            {
                id: "text-contract",
                current: true,
                officialVersionId: "text-price",
                channelId: "channel",
                requestedModel: "text-sku",
                scope: "global-standard-text-flat",
                requestLimits: {},
                reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://private.example/token", evidence: "private review notes" },
            },
            {
                id: "image-generations",
                current: true,
                officialVersionId: "image-price",
                channelId: "channel",
                requestedModel: "image-sku",
                operation: "generations",
                scope: "global-standard-direct-image-tokens",
                holdEstimate: { meterQuantities: {}, sourceUrl: "https://private.example/image", evidence: "private image notes" },
            },
            { id: "image-edits", current: true, officialVersionId: "image-price", channelId: "channel", requestedModel: "image-sku", operation: "edits", scope: "global-standard-direct-image-tokens" },
        ],
        reservations: [],
    });
    expect(result.routingReviewRows.map((row) => [row.scope, row.reservationReview])).toEqual([
        [
            "text:generation:standard",
            { contractId: "text-contract", contractScope: "global-standard-text-flat", strategy: "request-size-recent-output", sourceRecorded: true, evidenceRecorded: true, requestLimitsRecorded: true, status: "recorded-unverified" },
        ],
        [
            "image:generations:standard",
            {
                contractId: "image-generations",
                contractScope: "global-standard-direct-image-tokens",
                strategy: "token-meter-quantities",
                sourceRecorded: true,
                evidenceRecorded: true,
                meterQuantitiesRecorded: true,
                imageLimitRecorded: false,
                status: "recorded-unverified",
            },
        ],
        [
            "image:edits:standard",
            {
                contractId: "image-edits",
                contractScope: "global-standard-direct-image-tokens",
                strategy: null,
                sourceRecorded: false,
                evidenceRecorded: false,
                meterQuantitiesRecorded: false,
                imageLimitRecorded: false,
                status: "missing-reservation-estimate",
            },
        ],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private\.example|private review notes|private image notes/);
});

it("flags ownerless channel aliases without exposing their identity evidence", () => {
    const version = { id: "image-price", logicalModelId: "", sku: "official-image", capability: "image" };
    const binding = { id: "channel-binding", enabled: true, channelId: "channel", upstreamModel: "proxy-image" };
    const identity = { channelBindingId: binding.id, officialSku: version.sku, operation: "generations", sourceUrl: "https://private.example/alias", evidence: "private reviewed mapping" };
    const contract = { id: "contract", current: true, officialVersionId: version.id, channelId: binding.channelId, requestedModel: binding.upstreamModel, reportedModel: version.sku, modelIdentity: "response-required", operation: "generations", identity };
    const input = {
        pricing: { currentSales: { selectedPriceBindings: [{ logicalModelId: "image", scope: "image:generations:standard", officialVersionId: version.id }] }, officialVersions: [version] },
        models: [{ id: "image", capability: "image", bindings: [binding] }],
        currentContracts: [contract],
        reservations: [],
    };
    const inspect = () => summarizePricingBaseline(input).routingReviewRows[0].channelModelIdentityReview;
    expect(inspect()).toBe("recorded-unverified");
    expect(JSON.stringify(summarizePricingBaseline(input))).not.toMatch(/private\.example|private reviewed mapping/);
    input.currentContracts = [{ ...contract, identity: undefined }];
    expect(inspect()).toBe("missing-reviewed-identity");
    input.currentContracts = [{ ...contract, identity: { ...identity, channelBindingId: "stale-binding" } }];
    expect(inspect()).toBe("identity-mismatch");
    input.currentContracts = [{ ...contract, identity: { ...identity, sourceUrl: "http://private.example/alias" } }];
    expect(inspect()).toBe("incomplete-identity");
    input.currentContracts = [{ ...contract, reportedModel: "" }];
    expect(inspect()).toBe("incomplete-identity");
    input.currentContracts = [];
    expect(inspect()).toBe("missing-current-contract");
    input.currentContracts = [contract];
    input.models[0].bindings[0].upstreamModel = version.sku;
    expect(inspect()).toBe("exact-sku");
    input.models[0].bindings[0].upstreamModel = "proxy-image";
    input.pricing.officialVersions = [{ ...version, logicalModelId: "image" }];
    expect(inspect()).toBe("unsupported-alias");
    input.pricing.officialVersions = [{ ...version, capability: "text" }];
    input.pricing.currentSales.selectedPriceBindings[0].scope = "text:generation:standard";
    input.models[0].capability = "text";
    input.currentContracts = [{ ...contract, operation: "generation", identity: { ...identity, operation: "generation", modelIdentity: "reviewed-request" } }];
    expect(inspect()).toBe("recorded-unverified");
    input.currentContracts = [{ ...contract, operation: "generation", identity: { ...identity, operation: "generation" } }];
    expect(inspect()).toBe("incomplete-identity");
});

it("uses the reviewed image count limit for count contracts and flags incomplete historical data", () => {
    const input = {
        pricing: { currentSales: { priceVersionIds: { image: "price" } }, officialVersions: [{ id: "price" }], activations: {} },
        models: [{ id: "image", capability: "image", bindings: [{ channelId: "channel", upstreamModel: "flux-kontext-pro" }] }],
        reservations: [],
        currentContracts: [
            {
                id: "count",
                current: true,
                officialVersionId: "price",
                channelId: "channel",
                requestedModel: "flux-kontext-pro",
                operation: "generations",
                scope: "global-standard-dataeyes-flux-image",
                imageLimit: { maxImages: 1, sourceUrl: "https://private.example/count", evidence: "private count review" },
            },
            {
                id: "old-edit",
                current: false,
                officialVersionId: "price",
                channelId: "channel",
                requestedModel: "flux-kontext-pro",
                operation: "edits",
                scope: "global-standard-dataeyes-flux-image",
                imageLimit: { maxImages: 1, sourceUrl: "https://private.example/old", evidence: "old" },
            },
        ],
    };
    const rows = summarizePricingBaseline(input).routingReviewRows;
    expect(rows[0].reservationReview).toMatchObject({ contractId: "count", strategy: "image-count-limit", imageLimitRecorded: true, sourceRecorded: true, evidenceRecorded: true, status: "recorded-unverified" });
    expect(rows[1].reservationReview).toMatchObject({ contractId: null, status: "missing-current-contract" });
    expect(JSON.stringify(rows)).not.toContain("private.example");
    input.currentContracts[0].imageLimit = { maxImages: 1, sourceUrl: "", evidence: "private count review" };
    expect(summarizePricingBaseline(input).routingReviewRows[0].reservationReview.status).toBe("incomplete-reservation-basis");
});

it("audits video and audio request-bound contracts by their actual operation without claiming a contract source URL", () => {
    const result = summarizePricingBaseline({
        pricing: { currentSales: { priceVersionIds: { video: "video-price", gemini: "gemini-price", openai: "openai-price" } }, officialVersions: [], activations: {} },
        models: [
            { id: "video", capability: "video", bindings: [{ channelId: "channel", upstreamModel: "video-sku" }] },
            { id: "gemini", capability: "audio", bindings: [{ channelId: "channel", upstreamModel: "gemini-sku" }] },
            { id: "openai", capability: "audio", bindings: [{ channelId: "channel", upstreamModel: "openai-sku" }] },
        ],
        currentContracts: [
            {
                id: "video-contract",
                current: true,
                officialVersionId: "video-price",
                channelId: "channel",
                requestedModel: "video-sku",
                scope: "global-standard-minimax-h3-generation",
                resolutionItems: { "720P": { inputSeconds: "input", outputSeconds: "output" } },
                inputImageItem: "image",
                inputAudioItem: "audio",
                evidence: "private video review",
            },
            {
                id: "gemini-contract",
                current: true,
                officialVersionId: "gemini-price",
                channelId: "channel",
                requestedModel: "gemini-sku",
                scope: "global-standard-gemini-tts",
                inputTextItem: "text",
                outputAudioItem: "audio",
                evidence: "private TTS review",
            },
            {
                id: "openai-contract",
                current: true,
                officialVersionId: "openai-price",
                channelId: "channel",
                requestedModel: "openai-sku",
                scope: "global-standard-openai-chat-audio-uncached",
                itemKeys: { inputTextTokens: "input-text", inputAudioTokens: "input-audio", outputTextTokens: "output-text", outputAudioTokens: "output-audio" },
                evidence: "private chat audio review",
            },
        ],
        reservations: [],
    });
    const byModelScope = new Map(result.routingReviewRows.map((row) => [`${row.modelId}/${row.scope}`, row.reservationReview]));
    for (const key of ["video/video:generation:standard", "gemini/audio:generateContent:standard", "openai/audio:chat/completions:standard"])
        expect(byModelScope.get(key)).toMatchObject({ strategy: "request-upper-bound", sourceRecorded: null, evidenceRecorded: true, meteringItemsRecorded: true, status: "recorded-unverified" });
    expect(byModelScope.get("gemini/audio:chat/completions:standard")).toMatchObject({ contractId: null, status: "missing-current-contract" });
    expect(byModelScope.get("openai/audio:generateContent:standard")).toMatchObject({ contractId: null, status: "missing-current-contract" });
    expect(JSON.stringify(result)).not.toContain("private TTS review");
});

it("keeps the legacy raw-channel fallback visible when no logical models are configured", () => {
    const result = summarizePricingBaseline({
        pricing: { currentSales: null, officialVersions: [], activations: {} },
        models: [],
        channels: [{ id: "raw-channel", enabled: true, apiFormat: "openai", models: ["image-sku"], apiKey: "private-key", advancedConfig: { protocol: "openai", modelCapabilities: { "image-sku": "image" } } }],
        defaultModels: { imageModel: "image-sku" },
        reservations: [],
    });
    expect(result.routingReviewRows).toEqual([]);
    expect(result.legacyFallbackModels).toEqual([
        {
            channelId: "raw-channel",
            channelEnabled: true,
            upstreamModel: "image-sku",
            apiFormat: "openai",
            channelProtocol: "openai",
            configuredCapabilityHint: "image",
            configuredDefaultKeys: ["imageModel"],
            routeEligibility: "requires-runtime-verification",
        },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-key");
});

it("reads file-provider data without printing users or mutating the files", () => {
    const directory = mkdtempSync(join(tmpdir(), "pricing-baseline-"));
    try {
        const pricing = JSON.stringify({
            salesVersions: [{ id: "sale", priceVersionIds: { model: "price" }, userPriceRules: [] }],
            officialVersions: [
                { id: "price", sku: "sku" },
                { id: "copy", logicalModelId: "model", linkedFromVersionId: "price" },
            ],
            candidates: [{ status: "pending" }],
        });
        const auth = JSON.stringify({
            users: [{ id: "private-user" }],
            settings: {
                logicalModels: [{ id: "model", capability: "text", bindings: [{ id: "route", enabled: true, channelId: "channel", upstreamModel: "sku" }] }],
                systemChannels: [{ id: "channel", enabled: true, apiFormat: "openai", apiKey: "private-key", advancedConfig: { protocol: "openai" } }],
                modelPointCosts: { model: 2.5 },
                generationPointMultipliers: { imageQuality: { high: 1.4 } },
            },
            pricingReservations: [
                {
                    status: "reserved",
                    userId: "private-user",
                    modelId: "model",
                    usageKind: "text",
                    frozen: { version: { id: "old-price" }, policy: { id: "old-sale" }, contractId: "known-contract" },
                    preparation: { taskId: "private-task", taskType: "text" },
                },
            ],
        });
        const contracts = JSON.stringify({
            contracts: [
                {
                    id: "known-contract",
                    current: true,
                    officialVersionId: "price",
                    channelId: "channel",
                    requestedModel: "sku",
                    scope: "global-standard-text-flat",
                    requestLimits: {},
                    reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://private.example/text", evidence: "private review" },
                },
            ],
        });
        writeFileSync(join(directory, "model-pricing.json"), pricing);
        writeFileSync(join(directory, "auth.json"), auth);
        writeFileSync(join(directory, "model-pricing-token-contracts.json"), contracts);
        writeFileSync(join(directory, "generation-tasks.json"), JSON.stringify([{ id: "private-task", userId: "private-user", runId: "private-run" }]));
        const result = spawnSync(process.execPath, [join(import.meta.dirname, "model-pricing-baseline.mjs"), "file"], { env: { ...process.env, VOZEB_PRO_DATA_DIR: directory }, encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            provider: "file",
            currentSalesVersionId: "sale",
            openReservationCount: 1,
            frozenReferenceIssues: [expect.objectContaining({ modelId: "model", contractId: "known-contract", missing: ["official-price-version", "sales-version"] })],
            officialInventory: { total: 2, unbound: 1, copiedLinks: 1 },
            candidateStatuses: { pending: 1, approved: 0, rejected: 0 },
            fixedPointConfiguration: { modelPointCosts: { model: 2.5 }, generationPointMultipliers: { imageQuality: { high: 1.4 } } },
            reservationTaskLinkage: [{ status: "reserved", usageKind: "text", linkage: "run-linked", count: 1 }],
            routingReviewRows: [
                expect.objectContaining({
                    modelId: "model",
                    scope: "text:generation:standard",
                    channelId: "channel",
                    publishedReferenceKind: "legacy",
                    publishedOfficialVersionId: "price",
                    channelModelIdentityReview: "exact-sku",
                    reservationReview: expect.objectContaining({ contractId: "known-contract", status: "recorded-unverified" }),
                }),
            ],
        });
        expect(result.stdout).not.toContain("private-user");
        expect(result.stdout).not.toMatch(/private-task|private-run/);
        expect(result.stdout).not.toContain("private-key");
        expect(result.stdout).not.toContain("private.example");
        expect([join(directory, "model-pricing.json"), join(directory, "auth.json")].map((file) => readFileSync(file, "utf8"))).toEqual([pricing, auth]);
        expect(readFileSync(join(directory, "model-pricing-token-contracts.json"), "utf8")).toBe(contracts);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

it("reads legacy raw models through the file-provider CLI without leaking channel credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "pricing-baseline-legacy-"));
    try {
        const pricing = JSON.stringify({ salesVersions: [], officialVersions: [], candidates: [] });
        const auth = JSON.stringify({
            settings: {
                logicalModels: [],
                defaultModels: { imageModel: "image-sku" },
                systemChannels: [{ id: "raw-channel", enabled: true, apiFormat: "openai", models: ["image-sku"], apiKey: "private-key", advancedConfig: { protocol: "openai", modelCapabilities: { "image-sku": "image" } } }],
            },
        });
        writeFileSync(join(directory, "model-pricing.json"), pricing);
        writeFileSync(join(directory, "auth.json"), auth);
        const result = spawnSync(process.execPath, [join(import.meta.dirname, "model-pricing-baseline.mjs"), "file"], { env: { ...process.env, VOZEB_PRO_DATA_DIR: directory }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).legacyFallbackModels).toEqual([expect.objectContaining({ channelId: "raw-channel", upstreamModel: "image-sku", configuredCapabilityHint: "image", configuredDefaultKeys: ["imageModel"] })]);
        expect(result.stdout).not.toContain("private-key");
        expect([join(directory, "model-pricing.json"), join(directory, "auth.json")].map((file) => readFileSync(file, "utf8"))).toEqual([pricing, auth]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

it("marks a missing task catalog as unknown instead of treating referenced tasks as lost", () => {
    const directory = mkdtempSync(join(tmpdir(), "pricing-baseline-tasks-"));
    try {
        writeFileSync(join(directory, "model-pricing.json"), JSON.stringify({ salesVersions: [], officialVersions: [] }));
        writeFileSync(join(directory, "auth.json"), JSON.stringify({ settings: {}, pricingReservations: [{ status: "reserved", userId: "private-user", usageKind: "video", preparation: { taskId: "private-task", taskType: "video" } }] }));
        const result = spawnSync(process.execPath, [join(import.meta.dirname, "model-pricing-baseline.mjs"), "file"], { env: { ...process.env, VOZEB_PRO_DATA_DIR: directory }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).reservationTaskLinkage).toEqual([{ status: "reserved", usageKind: "video", linkage: "task-catalog-unavailable", count: 1 }]);
        expect(result.stdout).not.toMatch(/private-user|private-task/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

it("queries actual PostgreSQL tables in a read-only snapshot and loads selected official versions", async () => {
    const queries = [];
    const sale = { id: "sale", priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "image-a", scope: "image:generations:standard", bindingId: "binding-a", bindingRevision: "first", officialVersionId: "shared" }], userPriceRules: [] };
    vi.doMock("pg", () => ({
        default: {
            Client: class {
                async connect() {}
                async end() {}
                async query(sql, params = []) {
                    queries.push({ sql, params });
                    if (sql.startsWith("BEGIN") || sql === "COMMIT") return { rows: [] };
                    if (sql.includes("FROM vozeb_pro_model_pricing_state")) return { rows: [{ current_sales_version_id: "sale", billing_activations: {} }] };
                    if (sql.startsWith("SELECT id FROM vozeb_pro_model_sales_price_versions")) return { rows: [{ id: "sale" }] };
                    if (sql.includes("FROM vozeb_pro_model_sales_price_versions")) return { rows: [{ data: sale }] };
                    if (sql.includes("FROM vozeb_pro_model_price_bindings"))
                        return { rows: [{ data: { id: "binding-a", logicalModelId: "image-a", scope: "image:generations:standard", revision: "first", officialVersionId: "shared", status: "active", current: true } }] };
                    if (sql.startsWith("SELECT id FROM vozeb_pro_model_official_price_versions")) return { rows: [{ id: "shared" }] };
                    if (sql.includes("FROM vozeb_pro_model_official_price_versions") && sql.includes("WHERE id")) return { rows: [{ data: { id: "shared", manufacturer: "Vendor", sku: "sku" } }] };
                    if (sql.includes("FROM vozeb_pro_model_official_price_versions")) return { rows: [{ total: 1, unbound: 1, copiedLinks: 0 }] };
                    if (sql.startsWith("SELECT id, data FROM vozeb_pro_model_image_price_contracts"))
                        return {
                            rows: [
                                {
                                    id: "current-image-contract",
                                    data: {
                                        officialVersionId: "shared",
                                        channelId: "channel",
                                        requestedModel: "sku",
                                        operation: "generations",
                                        scope: "global-standard-direct-image-tokens",
                                        holdEstimate: { meterQuantities: {}, sourceUrl: "https://private.example/image", evidence: "private review" },
                                    },
                                },
                            ],
                        };
                    if (sql.includes("FROM vozeb_pro_model_flat_text_price_contracts")) return { rows: [{ id: "contract" }] };
                    if (sql.includes("FROM vozeb_pro_app_settings"))
                        return {
                            rows: [
                                {
                                    logical_models: [{ id: "image-a", capability: "image", bindings: [{ id: "route", enabled: true, channelId: "channel", upstreamModel: "sku" }] }],
                                    model_point_costs: { "image-a": 2.5 },
                                    generation_point_multipliers: { imageQuality: { high: 1.4 } },
                                },
                            ],
                        };
                    if (sql.includes("FROM vozeb_pro_system_model_channels")) return { rows: [{ id: "channel", name: "Fixture", enabled: true, api_format: "openai", protocol: "openai" }] };
                    if (sql.includes("FROM vozeb_pro_model_pricing_wallet_reservations"))
                        return {
                            rows: [
                                {
                                    status: "reserved",
                                    modelId: "image-a",
                                    usageKind: "image",
                                    channelId: "channel",
                                    requestedModel: "sku",
                                    operation: "generations",
                                    officialVersionId: "shared",
                                    salesVersionId: "sale",
                                    contractId: "contract",
                                    priceScope: "image:generations:standard",
                                    priceBindingId: "binding-a",
                                    priceBindingRevision: "first",
                                    submissionPhase: "submitted",
                                    taskType: "image",
                                    taskLinkage: "run-linked",
                                    count: 2,
                                },
                                {
                                    status: "reserved",
                                    modelId: "image-a",
                                    usageKind: "image",
                                    officialVersionId: "missing-price",
                                    salesVersionId: "missing-sale",
                                    contractId: "missing-contract",
                                    taskLinkage: "task-not-found",
                                    count: 1,
                                },
                            ],
                        };
                    if (sql.includes("FROM vozeb_pro_model_price_candidates")) return { rows: [] };
                    throw new Error(`Unexpected baseline SQL: ${sql}`);
                }
            },
        },
    }));
    const argv = [...process.argv];
    const previousUrl = process.env.DATABASE_URL;
    const output = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
    });
    try {
        process.argv[2] = "postgres";
        process.env.DATABASE_URL = "postgres://fixture";
        await import("./model-pricing-baseline.mjs?pg-fixture");
        const result = JSON.parse(output.join(""));
        expect(result.publishedBindings[0]).toMatchObject({ modelId: "image-a", officialVersionId: "shared", currentBindingMatchesPublished: true });
        expect(result.openReservations[0]).toMatchObject({ modelId: "image-a", priceScope: "image:generations:standard", priceBindingId: "binding-a", priceBindingRevision: "first", count: 2 });
        expect(result.reservationTaskLinkage).toEqual([
            { status: "reserved", usageKind: "image", linkage: "run-linked", count: 2 },
            { status: "reserved", usageKind: "image", linkage: "task-not-found", count: 1 },
        ]);
        expect(result.frozenReferenceIssues).toEqual([
            expect.objectContaining({ officialVersionId: "missing-price", salesVersionId: "missing-sale", contractId: "missing-contract", missing: ["official-price-version", "sales-version", "metering-contract"], count: 1 }),
        ]);
        expect(queries).toContainEqual({ sql: "SELECT id FROM vozeb_pro_model_official_price_versions WHERE id = ANY($1::text[])", params: [["shared", "missing-price"]] });
        expect(queries).toContainEqual({ sql: "SELECT id FROM vozeb_pro_model_sales_price_versions WHERE id = ANY($1::text[])", params: [["sale", "missing-sale"]] });
        expect(queries.some(({ sql, params }) => sql.includes("FROM vozeb_pro_model_flat_text_price_contracts") && params[0].join(",") === "contract,missing-contract")).toBe(true);
        expect(queries.some(({ sql }) => sql.includes("LEFT JOIN vozeb_pro_generation_tasks AS task") && sql.includes("task.user_id = reservation.user_id"))).toBe(true);
        expect(result.fixedPointConfiguration).toEqual({ modelPointCosts: { "image-a": 2.5 }, generationPointMultipliers: { imageQuality: { high: 1.4 } } });
        expect(result.routingReviewRows).toEqual([
            expect.objectContaining({
                scope: "image:generations:standard",
                channelId: "channel",
                channelProtocol: "openai",
                publishedOfficialVersionId: "shared",
                channelModelIdentityReview: "exact-sku",
                reservationReview: expect.objectContaining({ contractId: "current-image-contract", status: "recorded-unverified" }),
            }),
            expect.objectContaining({ scope: "image:edits:standard", channelId: "channel", publishedOfficialVersionId: null, reservationReview: expect.objectContaining({ status: "no-published-price" }) }),
        ]);
        expect(result.routingReviewRows.some((row) => row.reservationReview?.sourceRecorded)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("private.example");
        expect(queries.some(({ sql, params }) => sql.startsWith("SELECT id, data FROM vozeb_pro_model_image_price_contracts") && params[0][0] === "shared" && params[3][0] === "generations")).toBe(true);
        expect(queries[0].sql).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        expect(queries.at(-1).sql).toBe("COMMIT");
        expect(queries.some(({ sql, params }) => sql.includes("FROM vozeb_pro_model_official_price_versions WHERE id") && params[0].includes("shared"))).toBe(true);
        expect(queries.some(({ sql, params }) => sql.includes("FROM vozeb_pro_model_price_bindings WHERE current") && params[0][0] === "image-a" && params[1][0] === "image:generations:standard")).toBe(true);
        expect(queries.some(({ sql, params }) => sql.includes("FROM vozeb_pro_system_model_channels WHERE id = ANY") && params[0].join(",") === "channel")).toBe(true);
        expect(queries.some(({ sql }) => sql.includes("model_point_costs, generation_point_multipliers FROM vozeb_pro_app_settings"))).toBe(true);
        expect(queries.every(({ sql }) => !/\b(?:FROM|JOIN) (?!vozeb_pro_|unnest\()[a-z_]+/i.test(sql))).toBe(true);
    } finally {
        stdout.mockRestore();
        process.argv = argv;
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        vi.doUnmock("pg");
    }
});

it("targets current video and audio contracts for the published binding without reading their histories", async () => {
    const queries = [];
    vi.doMock("pg", () => ({
        default: {
            Client: class {
                async connect() {}
                async end() {}
                async query(sql, params = []) {
                    queries.push({ sql, params });
                    if (sql.startsWith("BEGIN") || sql === "COMMIT") return { rows: [] };
                    if (sql.includes("FROM vozeb_pro_model_pricing_state")) return { rows: [{ current_sales_version_id: "sale", billing_activations: {} }] };
                    if (sql.includes("FROM vozeb_pro_model_sales_price_versions")) return { rows: [{ data: { id: "sale", priceVersionIds: { video: "video-price", audio: "audio-price" } } }] };
                    if (sql.startsWith("SELECT data FROM vozeb_pro_model_official_price_versions")) return { rows: [{ data: { id: "video-price" } }, { data: { id: "audio-price" } }] };
                    if (sql.includes("FROM vozeb_pro_model_official_price_versions")) return { rows: [{ total: 2, unbound: 2, copiedLinks: 0 }] };
                    if (sql.includes("FROM vozeb_pro_app_settings"))
                        return {
                            rows: [
                                {
                                    logical_models: [
                                        { id: "video", capability: "video", bindings: [{ channelId: "channel", upstreamModel: "video-sku" }] },
                                        { id: "audio", capability: "audio", bindings: [{ channelId: "channel", upstreamModel: "audio-sku" }] },
                                    ],
                                },
                            ],
                        };
                    if (sql.startsWith("SELECT id, data FROM vozeb_pro_model_video_price_contracts"))
                        return {
                            rows: [
                                {
                                    id: "video-contract",
                                    data: { officialVersionId: "video-price", channelId: "channel", requestedModel: "video-sku", scope: "global-standard-minimax-hailuo-generation", tierItems: { "768P-6": "tier" }, evidence: "private video review" },
                                },
                            ],
                        };
                    if (sql.startsWith("SELECT id, data FROM vozeb_pro_model_audio_price_contracts"))
                        return {
                            rows: [
                                {
                                    id: "audio-contract",
                                    data: { officialVersionId: "audio-price", channelId: "channel", requestedModel: "audio-sku", scope: "global-standard-gemini-tts", inputTextItem: "text", outputAudioItem: "audio", evidence: "private audio review" },
                                },
                            ],
                        };
                    if (sql.includes("FROM vozeb_pro_system_model_channels") || sql.includes("FROM vozeb_pro_model_pricing_wallet_reservations") || sql.includes("FROM vozeb_pro_model_price_candidates")) return { rows: [] };
                    throw new Error(`Unexpected baseline SQL: ${sql}`);
                }
            },
        },
    }));
    const argv = [...process.argv];
    const previousUrl = process.env.DATABASE_URL;
    const output = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
    });
    try {
        process.argv[2] = "postgres";
        process.env.DATABASE_URL = "postgres://fixture";
        await import("./model-pricing-baseline.mjs?pg-video-audio-fixture");
        const rows = JSON.parse(output.join("")).routingReviewRows;
        expect(rows.find((row) => row.modelId === "video")?.reservationReview).toMatchObject({ contractId: "video-contract", strategy: "request-upper-bound", status: "recorded-unverified" });
        expect(rows.find((row) => row.scope === "audio:generateContent:standard")?.reservationReview).toMatchObject({ contractId: "audio-contract", strategy: "request-upper-bound", status: "recorded-unverified" });
        expect(rows.find((row) => row.scope === "audio:chat/completions:standard")?.reservationReview).toMatchObject({ contractId: null, status: "missing-current-contract" });
        expect(queries.some(({ sql, params }) => sql.startsWith("SELECT id, data FROM vozeb_pro_model_video_price_contracts WHERE current") && params[0].join() === "video-price")).toBe(true);
        expect(queries.some(({ sql, params }) => sql.startsWith("SELECT id, data FROM vozeb_pro_model_audio_price_contracts WHERE current") && params[0].length === 2 && params[0].every((id) => id === "audio-price"))).toBe(true);
        expect(queries.at(-1).sql).toBe("COMMIT");
        expect(output.join("")).not.toContain("private video review");
    } finally {
        stdout.mockRestore();
        process.argv = argv;
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        vi.doUnmock("pg");
    }
});

it("reads safe channel-directory fields when PostgreSQL uses legacy raw-model routing", async () => {
    const queries = [];
    vi.doMock("pg", () => ({
        default: {
            Client: class {
                async connect() {}
                async end() {}
                async query(sql, params = []) {
                    queries.push({ sql, params });
                    if (sql.startsWith("BEGIN") || sql === "COMMIT") return { rows: [] };
                    if (sql.includes("FROM vozeb_pro_model_pricing_state")) return { rows: [{ current_sales_version_id: null, billing_activations: {} }] };
                    if (sql.includes("FROM vozeb_pro_model_official_price_versions") && sql.includes("WHERE id")) return { rows: [] };
                    if (sql.includes("FROM vozeb_pro_model_official_price_versions")) return { rows: [{ total: 0, unbound: 0, copiedLinks: 0 }] };
                    if (sql.includes("FROM vozeb_pro_app_settings")) return { rows: [{ logical_models: [], default_models: { imageModel: "image-sku" } }] };
                    if (sql.includes("FROM vozeb_pro_system_model_channels"))
                        return { rows: [{ id: "raw-channel", name: "Fixture", enabled: true, api_format: "openai", models: ["image-sku"], protocol: "openai", model_capabilities: { "image-sku": "image" } }] };
                    if (sql.includes("FROM vozeb_pro_model_pricing_wallet_reservations") || sql.includes("FROM vozeb_pro_model_price_candidates")) return { rows: [] };
                    throw new Error(`Unexpected baseline SQL: ${sql}`);
                }
            },
        },
    }));
    const argv = [...process.argv];
    const previousUrl = process.env.DATABASE_URL;
    const output = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
    });
    try {
        process.argv[2] = "postgres";
        process.env.DATABASE_URL = "postgres://fixture";
        await import("./model-pricing-baseline.mjs?pg-legacy-fixture");
        const result = JSON.parse(output.join(""));
        expect(result.legacyFallbackModels).toEqual([expect.objectContaining({ channelId: "raw-channel", upstreamModel: "image-sku", configuredCapabilityHint: "image", configuredDefaultKeys: ["imageModel"] })]);
        expect(queries.some(({ sql, params }) => sql.includes("FROM vozeb_pro_system_model_channels") && !sql.includes("WHERE id") && params.length === 0)).toBe(true);
        expect(queries[0].sql).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        expect(queries.at(-1).sql).toBe("COMMIT");
        expect(queries.every(({ sql }) => !/\b(?:FROM|JOIN) (?!vozeb_pro_|unnest\()[a-z_]+/i.test(sql))).toBe(true);
    } finally {
        stdout.mockRestore();
        process.argv = argv;
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        vi.doUnmock("pg");
    }
});
