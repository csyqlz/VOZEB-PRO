import { inspectOpenAiImageCount, inspectOpenAiImageUsage } from "./model-pricing-image-usage";
import type { ImageWalletRequest } from "./model-pricing-image-request";
import Fraction from "fraction.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dataAdapter from "./data-adapter";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb, mutateAuthDb } from "@/lib/auth/store-repository";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { ModelPricingWalletRepository } from "./database/model-pricing-wallet-repository";
import {
    reserveModelPricePoints,
    settleModelPricePoints,
    releaseModelPricePoints,
    refundModelPricePoints,
    pricingDailySourceKey,
    claimModelPriceSubmission,
    recordModelPriceSubmissionOutcome,
    reviewModelPriceSubmission,
} from "./model-pricing-wallet-service";
import type { FlatTextPriceContract } from "./model-pricing-token-contract";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { consumePoints, creditPermanentPoints, getPointsWalletSnapshot, refundPoints } from "./points-wallet-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { mutatePricingState, readPricingState } from "./model-pricing-store";
import { resolvePublishedModelPrice } from "./model-pricing-published-price";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { getModelPricingAdmission } from "./model-pricing-admission";
import { saveImagePriceContract } from "./model-pricing-image-contract-store";
import { saveFlatTextPriceContract } from "./model-pricing-token-contract-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const now = new Date("2026-10-02T08:00:00+08:00");
describe.each(providers)("priced wallet transactions (%s)", (provider) => {
    let userId: string;
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-wallet-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        userId = randomUUID();
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            const planId = settings.settings!.defaultPlanId;
            await postgresQuery("UPDATE app_settings SET free_daily_points_enabled = true, free_daily_points = 5, entitlements_enabled = true WHERE id = 'default'");
            await repos.users.createWithNextAccountId({
                id: userId,
                username: `price_${userId}`,
                displayName: "计费事务夹具",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId,
                pointsBalance: 20,
                passwordHash: "fixture-only",
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });
        } else {
            const db = emptyDb();
            db.settings = structuredClone(db.settings);
            db.settings.freeDailyPoints = 5;
            db.settings.freeDailyPointsEnabled = true;
            db.settings.entitlements.enabled = true;
            db.users.push({
                id: userId,
                accountId: "0001",
                username: "pricing_fixture",
                displayName: "计费事务夹具",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId: db.settings.entitlements.defaultPlanId,
                pointsBalance: 20,
                passwordHash: "fixture-only",
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });
            await writeAuthDb(db);
        }
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") await createPostgresRepositories().users.delete(userId);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    function input(maximum = "8.75") {
        const publishedAt = "2026-10-01T00:00:00Z";
        const version: OfficialPriceVersion = {
            id: "official",
            candidateId: "fixture",
            logicalModelId: "priced-model",
            manufacturer: "Fixture",
            series: "Text",
            officialVersion: "v1",
            sku: "model",
            tier: "paid",
            conditions: "fixture",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [{ key: "units", unit: "second", per: "1", price: "0.01", currency: "CNY" }],
        };
        const policy: SalesVersion = {
            id: "sales",
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "priced-model": "official" },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        return {
            userId,
            requestId: randomUUID(),
            requestFingerprint: "a".repeat(64),
            modelId: "priced-model",
            usageKind: "audio" as const,
            units: 1,
            version,
            policy,
            maximumUsage: { units: maximum },
            contractId: "reviewed-fixture",
            upperBoundEvidence: "verified fixture duration",
            now,
        };
    }
    async function state(requestId: string) {
        if (provider === "file") {
            const db = await readAuthDb();
            return {
                reservation: db.pricingReservations.find((item) => item.userId === userId && item.requestId === requestId),
                exact: db.pricingAccruals
                    .filter((item) => item.userId === userId)
                    .reduce((sum, item) => sum.add(item.exactPoints), new Fraction(0))
                    .toFraction(),
                records: db.pointRecords.filter((item) => item.userId === userId),
                quota: db.quotaUsage.filter((item) => item.userId === userId),
            };
        }
        const repo = new ModelPricingWalletRepository({ query: postgresQuery });
        const records = await createPostgresRepositories().points.listRecords(userId);
        const quota = await postgresQuery('SELECT units, points_spent AS "pointsSpent" FROM quota_usage WHERE user_id = $1 AND date = $2', [userId, "2026-10-02"]);
        const reservation = await repo.get(userId, requestId);
        const dailyKey = reservation && pricingDailySourceKey(reservation.allocation);
        const exact = new Fraction(await repo.getExact(userId, "permanent")).add(dailyKey ? await repo.getExact(userId, dailyKey) : "0").toFraction();
        return { reservation, exact, records: records.items, quota: quota.rows.map((row) => ({ units: Number(row.units), pointsSpent: Number(row.pointsSpent) })) };
    }

    function imageInput() {
        const base = input();
        const version = { ...base.version, sku: "flux-kontext-pro", items: [{ key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" }] };
        const policy = { ...base.policy, userPriceRules: [{ scope: "default" as const, coefficient: "0.5" }] };
        const imageRequest: ImageWalletRequest = {
            channelId: "flux",
            requestedModel: version.sku,
            declaredProtocol: "dataeyes-flux",
            operation: "generations",
            payload: { model: version.sku, prompt: "private image prompt", n: 9 },
            contract: {
                id: "image-contract",
                officialVersionId: version.id,
                channelId: "flux",
                requestedModel: version.sku,
                reportedModel: version.sku,
                modelIdentity: "reviewed-request",
                protocol: "openai-images",
                operation: "generations",
                scope: "global-standard-dataeyes-flux-image",
                region: "global",
                itemMeters: {},
                zeroMeters: [],
                imageLimit: { maxImages: 1, sourceUrl: "https://example.com/one-image", evidence: "one URL image per request; n ignored" },
                evidence: "reviewed request identity",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
        };
        return { userId, requestId: base.requestId, requestFingerprint: base.requestFingerprint, modelId: base.modelId, usageKind: "image" as const, units: 1, version, policy, now, imageRequest };
    }
    const imageObservation = () => inspectOpenAiImageCount({ data: [{ url: "https://example.com/result.png" }] });

    it("rejects a new hold with mixed legacy and independent sales references before changing the wallet", async () => {
        const base = input();
        const before = await getPointsWalletSnapshot(userId, { now });
        const mixed = {
            ...base,
            policy: {
                ...base.policy,
                selectedPriceBindings: [{ logicalModelId: base.modelId, scope: "audio:chat/completions:standard", bindingId: "other-binding", bindingRevision: "revision", officialVersionId: base.version.id }],
            },
        };
        await expect(reserveModelPricePoints(mixed)).rejects.toThrow("同一模型的销售版本同时含旧式映射和独立选价");
        expect((await state(mixed.requestId)).reservation).toBeUndefined();
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(before.totalPoints);
    });

    it.skipIf(provider !== "file")("freezes an independently selected image price for settlement after its binding changes", async () => {
        const base = imageInput();
        const modelId = "flux-kontext-pro";
        const version = { ...base.version, logicalModelId: "", capability: "image" as const };
        const priceSelection = { logicalModelId: modelId, scope: "image:generations:standard", bindingId: "image-binding", bindingRevision: "first-revision", officialVersionId: version.id };
        const policy = { ...base.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId, coefficient: "0.25" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "flux", name: "Fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "openai", models: [modelId], enabled: true }];
        db.settings.logicalModels = [{ id: modelId, name: "Shared image", manufacturer: "Fixture", capability: "image", enabled: true, bindings: [{ id: "flux:flux-kontext-pro", channelId: "flux", upstreamModel: modelId, enabled: true, priority: 0 }] }];
        await writeAuthDb(db);
        await mutatePricingState((state) => ({
            next: {
                ...state,
                officialVersions: [version],
                salesVersions: [policy],
                priceBindings: [
                    {
                        id: priceSelection.bindingId,
                        logicalModelId: modelId,
                        capability: "image",
                        operation: "generations",
                        processingMode: "standard",
                        scope: priceSelection.scope,
                        officialVersionId: version.id,
                        status: "active",
                        revision: priceSelection.bindingRevision,
                        current: true,
                        evidence: "fixture",
                        reviewedAt: version.publishedAt,
                        reviewedBy: "admin",
                    },
                ],
            },
            result: undefined,
        }));
        const request = { ...base, modelId, version, policy, priceSelection };
        const held = await reserveModelPricePoints(request);
        expect(held.reservation.frozen).toMatchObject({ priceSelection, image: { call: { logicalModelId: modelId, priceSelection } } });
        await mutatePricingState((state) => ({ next: { ...state, priceBindings: state.priceBindings?.map((binding) => ({ ...binding, revision: "changed" })) }, result: undefined }));
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID() })).rejects.toThrow("独立选价绑定或售价已变化");
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: imageObservation(), responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation.settlement?.chargedPoints).toBe("7.00");
        expect(settled.reservation.frozen.priceSelection).toEqual(priceSelection);
        expect(settled.reservation.settledImageQuote).toMatchObject({ modelId, contractId: "image-contract", exactPoints: "7", lines: [{ consumedFactIds: [expect.any(String)] }] });
        const view = await getPricingWalletView(userId, { now });
        expect(view.items[0].calculation?.coefficient).toBe("0.25");
        expect(view.items[0].calculation?.exactPoints).toBe("7");
        expect(JSON.stringify(view.items[0])).not.toContain("sourcePaths");
        expect(JSON.stringify(view.items[0])).not.toContain("consumedFactIds");
        const refunded = await refundModelPricePoints({ ...request, refundId: "original-image", usage: settled.reservation.settledUsage!, units: 1, evidence: "fixture refund" });
        expect(refunded.reservation.frozen.priceSelection).toEqual(priceSelection);
    });

    function tokenImageInput() {
        const base = input();
        const version: OfficialPriceVersion = {
            ...base.version,
            manufacturer: "OpenAI",
            series: "GPT Image 2",
            sku: "gpt-image-2",
            items: [
                { key: "inputTextTokens", unit: "token", per: "1000000", price: "5", currency: "USD" },
                { key: "inputImageTokens", unit: "token", per: "1000000", price: "8", currency: "USD" },
                { key: "outputImageTokens", unit: "token", per: "1000000", price: "30", currency: "USD" },
            ],
        };
        const imageRequest: ImageWalletRequest = {
            channelId: "openai",
            requestedModel: version.sku,
            declaredProtocol: "openai-images",
            operation: "generations",
            payload: { model: version.sku, prompt: "private image prompt" },
            contract: {
                id: "token-image-contract",
                officialVersionId: version.id,
                channelId: "openai",
                requestedModel: version.sku,
                reportedModel: version.sku,
                modelIdentity: "reviewed-request",
                protocol: "openai-images",
                operation: "generations",
                scope: "global-standard-direct-image-tokens",
                region: "global",
                itemMeters: { inputTextTokens: ["inputTextTokens"], inputImageTokens: ["inputImageTokens"], outputImageTokens: ["outputImageTokens"] },
                zeroMeters: ["outputTextTokens"],
                holdEstimate: { meterQuantities: { inputTextTokens: "285", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-token-estimate", evidence: "fixture reviewed modal estimate" },
                evidence: "direct Images standard usage fixture",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
        };
        return { ...base, usageKind: "image" as const, version, imageRequest, maximumUsage: undefined, contractId: undefined, upperBoundEvidence: undefined };
    }

    it("derives image Token holds from reviewed usage, official rates and the published sale coefficient", async () => {
        const first = tokenImageInput();
        expect((await reserveModelPricePoints(first)).reservation).toMatchObject({ frozen: { estimatedHoldPoints: "399/400" }, allocation: { heldPoints: "1.00" } });
        const changedSale = tokenImageInput();
        changedSale.policy.userPriceRules = [{ scope: "model", modelId: changedSale.modelId, coefficient: "2" }];
        expect((await reserveModelPricePoints(changedSale)).reservation).toMatchObject({ frozen: { estimatedHoldPoints: "399/200" }, allocation: { heldPoints: "2.00" } });
        const missing = tokenImageInput();
        delete missing.imageRequest.contract.holdEstimate;
        await expect(reserveModelPricePoints(missing)).rejects.toThrow("独立预留估算");
    });

    it("freezes an image estimate scaled from the reviewed request-size baseline", async () => {
        const request = tokenImageInput();
        const estimate = request.imageRequest.contract.holdEstimate!;
        delete request.imageRequest.contract.holdEstimate;
        request.imageRequest.contract.holdEstimates = [{ ...estimate, quality: "low", size: "1024x1024" }];
        request.imageRequest.payload = { model: request.version.sku, prompt: "private image prompt", quality: "low", size: "1024x1024", n: 1 };
        expect((await reserveModelPricePoints(request)).reservation).toMatchObject({ frozen: { estimatedHoldPoints: "427/400" }, allocation: { heldPoints: "1.07" } });
        const unreviewed = tokenImageInput();
        delete unreviewed.imageRequest.contract.holdEstimate;
        unreviewed.imageRequest.contract.holdEstimates = request.imageRequest.contract.holdEstimates;
        unreviewed.imageRequest.payload = { ...(request.imageRequest.payload as Record<string, unknown>), size: "2048x2048" };
        unreviewed.requestId = randomUUID();
        expect((await reserveModelPricePoints(unreviewed)).reservation).toMatchObject({ frozen: { upperBoundEvidence: expect.stringContaining("requestedSize=2048x2048; sampleSize=1024x1024") } });
    });

    it.skipIf(provider !== "file")("preserves the old fixed-point image Token hold only for the saved matching approval", async () => {
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        const request = tokenImageInput();
        delete request.imageRequest.contract.holdEstimate;
        const db = await readAuthDb();
        db.settings.systemChannels = [applyChannelProtocol({ id: "openai", name: "OpenAI", baseUrl: "https://example.com", apiKey: "fixture-key", apiFormat: "openai", models: [request.version.sku], enabled: true }, "openai")];
        db.settings.logicalModels = [
            { id: request.modelId, name: request.modelId, manufacturer: "OpenAI", capability: "image", enabled: true, bindings: [{ id: "image-binding", channelId: "openai", upstreamModel: request.version.sku, enabled: true, priority: 0 }] },
        ];
        db.settings.modelPointCosts = { [request.modelId]: 3.5 };
        await writeAuthDb(db);
        await mutatePricingState((state) => ({ next: { ...state, officialVersions: [request.version], salesVersions: [request.policy] }, result: null }));
        const generation = await saveImagePriceContract(request.imageRequest.contract, null);
        const edits = await saveImagePriceContract({ ...request.imageRequest.contract, operation: "edits" }, null);
        const admission = await getModelPricingAdmission(request.modelId, null, undefined, undefined, undefined, true);
        expect(admission.structuralComplete).toBe(true);
        const key = `openai/${request.version.sku}`;
        await mutatePricingState((state) => ({
            next: {
                ...state,
                billingActivations: {
                    ...state.billingActivations,
                    [request.modelId]: {
                        modelId: request.modelId,
                        enabled: true,
                        revision: "legacy-revision",
                        fingerprint: admission.fingerprint!,
                        salesVersionId: request.policy.id,
                        officialVersionId: request.version.id,
                        evidence: { shadowReceiptIds: { [generation.id]: "generation-receipt", [edits.id]: "edits-receipt" } },
                        bindings: { [key]: { fingerprint: admission.bindings[0].fingerprint!, contractIds: [generation.id, edits.id], shadowReceiptIds: { [generation.id]: "generation-receipt", [edits.id]: "edits-receipt" } } },
                        changedAt: now.toISOString(),
                        changedBy: "fixture-admin",
                    },
                },
            },
            result: null,
        }));
        const held = await reserveModelPricePoints({ ...request, imageRequest: { ...request.imageRequest, contract: generation } });
        expect(held.reservation.allocation.heldPoints).toBe("3.50");
        const changed = await readAuthDb();
        changed.settings.modelPointCosts = { [request.modelId]: 4.5 };
        await writeAuthDb(changed);
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID(), imageRequest: { ...request.imageRequest, contract: generation } })).resolves.toMatchObject({ reservation: { allocation: { heldPoints: "4.50" } } });
        await mutatePricingState((state) => {
            const activation = state.billingActivations?.[request.modelId];
            if (!activation?.bindings?.[key]) throw new Error("legacy fixture approval is missing");
            return { next: { ...state, billingActivations: { ...state.billingActivations, [request.modelId]: { ...activation, bindings: { [key]: { ...activation.bindings[key], fingerprint: "stale" } } } } }, result: null };
        });
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID(), imageRequest: { ...request.imageRequest, contract: generation } })).rejects.toThrow("独立预留估算");
    });

    it("preholds the reviewed image estimate, settles real image tokens, records debt, blocks paid calls and offsets a top-up", async () => {
        const request = tokenImageInput();
        const held = await reserveModelPricePoints(request);
        expect(held.reservation.allocation.heldPoints).toBe("1.00");
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const observation = inspectOpenAiImageUsage({
            data: [{ b64_json: "fixture" }],
            usage: { input_tokens: 1000, output_tokens: 10000, total_tokens: 11000, input_tokens_details: { text_tokens: 1000, image_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 10000 } },
        });
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation, responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation.settlement?.chargedPoints).toBe("213.50");
        expect(settled.reservation.settledImageUsageFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "inputTextTokens", value: "1000", status: "reported", sourcePaths: ["usage.input_tokens_details.text_tokens"] }),
                expect.objectContaining({ meter: "outputImageTokens", value: "10000", status: "reported", sourcePaths: ["usage.output_tokens_details.image_tokens"] }),
                expect.objectContaining({ meter: "outputTextTokens", value: "0", status: "reported", sourcePaths: ["usage.output_tokens_details.text_tokens"] }),
            ]),
        );
        expect(settled.reservation.settledImageQuote).toMatchObject({ purpose: "settlement", contractId: "token-image-contract", attemptId: claimId, exactPoints: "427/2" });
        expect(settled.reservation.settledImageQuote?.lines.find((line) => line.key === "outputImageTokens")?.consumedFactIds).toEqual([settled.reservation.settledImageUsageFacts?.find((fact) => fact.meter === "outputImageTokens")?.factId]);
        expect(settled.reservation.estimatedHold?.heldPoints).toBe("1.00");
        expect(settled.snapshot.permanentPoints).toBe(-188.5);
        await expect(reserveModelPricePoints(tokenImageInput())).rejects.toThrow("待补扣");
        await expect(consumePoints({ userId, amount: 0.01, units: 1, usageKind: "text", model: "fixed", description: "blocked", idempotencyKey: randomUUID(), now })).rejects.toThrow("待补扣");
        await creditPermanentPoints({ userId, amount: 200, description: "top-up", idempotencyKey: randomUUID(), now });
        expect((await getPointsWalletSnapshot(userId, { now })).permanentPoints).toBe(11.5);
        await expect(consumePoints({ userId, amount: 0.01, units: 1, usageKind: "text", model: "fixed", description: "after top-up", idempotencyKey: randomUUID(), now })).resolves.toMatchObject({ applied: true });
        const refunded = await refundModelPricePoints({ ...request, refundId: "image-invalid", usage: settled.reservation.settledUsage!, units: 1, evidence: "original media failed validation" });
        expect(refunded.snapshot.totalPoints).toBe(224.99);
    });

    it("releases an earlier unsubmitted hold while debt remains and permits refunding the original charge", async () => {
        const chargedRequest = tokenImageInput();
        const pendingRequest = tokenImageInput();
        await reserveModelPricePoints(chargedRequest);
        await reserveModelPricePoints(pendingRequest);
        const claimId = (await claimModelPriceSubmission(chargedRequest)).reservation.submission!.id;
        const observation = inspectOpenAiImageUsage({
            data: [{ b64_json: "fixture" }],
            usage: { input_tokens: 1000, output_tokens: 10000, total_tokens: 11000, input_tokens_details: { text_tokens: 1000, image_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 10000 } },
        });
        await recordModelPriceSubmissionOutcome({ ...chargedRequest, claimId, kind: "response", observation, responseComplete: true });
        const charged = await settleModelPricePoints({ ...chargedRequest, resume: true });
        expect(charged.snapshot.debtPoints).toBeGreaterThan(0);
        const blocked = await claimModelPriceSubmission(pendingRequest);
        expect(blocked).toMatchObject({ claimed: false, reservation: { status: "released" } });
        expect(blocked.reservation.release?.releasedPoints).toBe("1.00");
        expect((await getPointsWalletSnapshot(userId, { now })).debtPoints).toBeGreaterThan(0);
        const refund = await refundModelPricePoints({ ...chargedRequest, refundId: "failed-media", usage: charged.reservation.settledUsage!, units: 1, evidence: "failed media persistence" });
        expect(refund.snapshot.debtPoints).toBe(0);
        expect(refund.snapshot.totalPoints).toBe(25);
    });

    it("returns the unused image estimate and refunds the original usage without a second upstream claim", async () => {
        const request = tokenImageInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const observation = inspectOpenAiImageUsage({
            data: [{ b64_json: "fixture" }],
            usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10, input_tokens_details: { text_tokens: 0, image_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 10 } },
        });
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation, responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation).toMatchObject({ settlement: { chargedPoints: "0.21" }, release: { dailyRestored: "0.79", dailyExpired: "0" } });
        expect(settled.snapshot.totalPoints).toBe(24.79);
        expect((await settleModelPricePoints({ ...request, resume: true })).applied).toBe(false);
        const refund = await refundModelPricePoints({ ...request, refundId: "failed-media", usage: settled.reservation.settledUsage!, units: 1, evidence: "failed media persistence" });
        expect(refund.snapshot.totalPoints).toBe(25);
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
    });

    it.each(["0", "8.75"])("refuses a generic zero-rate reservation even with upper bound %s", async (maximum) => {
        const request = input(maximum);
        request.version.items[0].price = "0";
        await expect(reserveModelPricePoints(request)).rejects.toThrow("固定积分");
        const saved = await state(request.requestId);
        expect(saved.reservation).toBeUndefined();
        expect(saved.records).toEqual([]);
        expect(saved.exact).toBe("0");
    });

    it("reserves an audited image count, claims once, freezes all prices and settles and refunds once", async () => {
        const request = imageInput();
        const holds = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
        expect(holds.filter((hold) => hold.applied)).toHaveLength(1);
        expect(holds[0].reservation.allocation).toMatchObject({ maximumExactPoints: "14", heldPoints: "14.00" });
        expect(holds[0].reservation.frozen.maximumUsage).toEqual({ images: "1" });
        expect(JSON.stringify(holds[0].reservation)).not.toContain("private image prompt");
        request.policy.userPriceRules[0].coefficient = "2";
        request.version.items[0].price = "1";
        expect((await reserveModelPricePoints(request)).reservation.allocation.heldPoints).toBe("14.00");
        const claims = await Promise.all([claimModelPriceSubmission(request), claimModelPriceSubmission(request)]);
        expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
        const outcome = { ...request, claimId: claims[0].reservation.submission!.id, kind: "response" as const, observation: imageObservation(), responseComplete: true as const };
        const recorded = await Promise.all([recordModelPriceSubmissionOutcome(outcome), recordModelPriceSubmissionOutcome(outcome)]);
        expect(recorded.filter((record) => record.applied)).toHaveLength(1);
        const settlements = await Promise.all([settleModelPricePoints({ ...request, resume: true }), settleModelPricePoints({ ...request, resume: true })]);
        expect(settlements.filter((result) => result.applied)).toHaveLength(1);
        expect(settlements[0].reservation.settledImageUsageFacts).toEqual([expect.objectContaining({ meter: "images", value: "1", unit: "image", status: "derived", sourcePaths: ["data.length"], formula: "count complete image results" })]);
        expect(settlements[0].reservation.settledImageQuote).toMatchObject({ purpose: "settlement", contractId: "image-contract", attemptId: claims[0].reservation.submission!.id, exactPoints: "14" });
        expect(settlements[0].snapshot.totalPoints).toBe(11);
        expect((await state(request.requestId)).records).toHaveLength(1);
        const refund = { ...request, refundId: "media-failed", usage: { images: "1" }, units: 1, evidence: "original media failed validation" };
        const refunded = await Promise.all([refundModelPricePoints(refund), refundModelPricePoints(refund)]);
        expect(refunded.filter((result) => result.applied)).toHaveLength(1);
        expect(refunded[0].snapshot.totalPoints).toBe(25);
        const saved = await state(request.requestId);
        expect(saved.records).toHaveLength(2);
        expect(saved.exact).toBe("0");
    });

    it("keeps an unknown image submission held and resumes the original durable result after a wallet write failure", async () => {
        const request = imageInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "transport_error" });
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "timeout" })).rejects.toThrow("已认领提交");
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("完整响应");
        await expect(settleModelPricePoints({ ...request, usage: { images: "0" } })).rejects.toThrow("已保存的完整响应");
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: imageObservation(), responseComplete: true });
        if (provider === "postgres") vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("image fixture write failure"));
        else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("image fixture write failure"));
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("image fixture write failure");
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(11);
        expect((await settleModelPricePoints({ ...request, resume: true })).reservation.settlement?.chargedPoints).toBe("14.00");
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
    });

    it("rejects changed image request identity and unrelated text metering", async () => {
        const request = imageInput();
        await reserveModelPricePoints(request);
        for (const patch of [{ operation: "edits" as const }, { declaredProtocol: "openai" }, { channelId: "other" }, { requestedModel: "flux-kontext-max" }, { payload: { model: "flux-kontext-pro", prompt: "changed" } }]) {
            await expect(reserveModelPricePoints({ ...request, imageRequest: { ...request.imageRequest, ...patch } })).rejects.toThrow("图片请求已变化");
        }
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: true })).rejects.toThrow("能力不匹配");
        const observation = imageObservation();
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation, responseComplete: true });
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: { ...observation, hasResults: false }, responseComplete: true })).rejects.toThrow("不能改写");
        expect((await state(request.requestId)).records).toHaveLength(0);
    });

    it.each([
        {},
        { data: [] },
        { data: [{ url: "https://example.com/one.png" }, { url: "https://example.com/two.png" }] },
        { data: [{ url: "https://example.com/one.png" }, {}] },
        { error: "failure", data: [{ url: "https://example.com/one.png" }] },
        { model: "other", data: [{ url: "https://example.com/one.png" }] },
    ])("does not settle or erase an incomplete or contradictory image response: %j", async (payload) => {
        const request = imageInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectOpenAiImageCount(payload), responseComplete: true });
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow();
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: imageObservation(), responseComplete: true })).rejects.toThrow("不能改写");
        expect((await state(request.requestId)).reservation?.status).toBe("reserved");
        expect((await state(request.requestId)).records).toHaveLength(0);
    });

    it("rejects unsupported image requests before a hold and releases only proven unsubmitted or uncharged requests", async () => {
        for (const patch of [
            { declaredProtocol: "openai" },
            { operation: "edits" as const },
            { payload: { model: "other" } },
            { payload: { model: "flux-kontext-pro", tools: [{}] } },
            { payload: { model: "flux-kontext-pro", service_tier: "flex" } },
            { payload: { model: "flux-kontext-pro", response_format: "b64_json" } },
        ]) {
            const request = imageInput();
            await expect(reserveModelPricePoints({ ...request, imageRequest: { ...request.imageRequest, ...patch } })).rejects.toThrow();
            expect((await state(request.requestId)).reservation).toBeUndefined();
        }
        const unsubmitted = imageInput();
        await reserveModelPricePoints(unsubmitted);
        await releaseModelPricePoints({ ...unsubmitted, reason: "not-submitted", evidence: "cancelled before claim" });
        expect((await claimModelPriceSubmission(unsubmitted)).claimed).toBe(false);
        const request = imageInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const evidence = "provider evidence for this exact uncharged request";
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "not_charged", evidence });
        expect((await releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence })).snapshot.totalPoints).toBe(25);
    });

    it("shows coherent holds, frozen calculations and actual refunds without exposing internal evidence", async () => {
        const request = input("7.25");
        await reserveModelPricePoints(request);
        const held = await getPricingWalletView(userId, { now });
        expect(held.summary).toMatchObject({ availablePoints: "17.75", pendingCount: 1 });
        expect(Number(held.summary.pendingPoints)).toBe(7.25);
        expect(held.items[0]).toMatchObject({ modelId: request.modelId, status: "reserved", heldPoints: "7.25" });
        expect(held.items[0].calculation).toBeUndefined();
        request.policy.conversion!.cnyPerUsd = "9";
        request.policy.userPriceRules = [{ scope: "default", coefficient: "2" }];
        await settleModelPricePoints({ ...request, usage: { units: "6.15" } });
        const settled = await getPricingWalletView(userId, { now, status: "settled" });
        expect(settled.summary).toMatchObject({ availablePoints: "18.85", pendingCount: 0 });
        expect(settled.items[0]).toMatchObject({ chargedPoints: "6.15", restoredPoints: "1.1", calculation: { cnyPerUsd: "7", coefficient: "1", calculatedPoints: "6.15", lines: [{ quantity: "6.15", officialAmount: "0.0615" }] } });
        expect(JSON.stringify(settled)).not.toMatch(/requestFingerprint|upperBoundEvidence|reviewedBy|frozen|quotaTracked/);
        await refundModelPricePoints({ ...request, refundId: "partial", usage: { units: "2.15" }, units: 0, evidence: "internal refund evidence" });
        const refunded = await getPricingWalletView(userId, { now });
        expect(Number(refunded.items[0].refundedPoints)).toBe(2.15);
        expect(refunded.summary.availablePoints).toBe("21");
        expect(JSON.stringify(refunded)).not.toContain("internal refund evidence");
    });

    it("reports expired daily holds separately and never adds them to available points", async () => {
        const request = input("7.25");
        await reserveModelPricePoints(request);
        const tomorrow = new Date("2026-10-03T08:00:00+08:00");
        const held = await getPricingWalletView(userId, { now: tomorrow });
        expect(held.summary.availablePoints).toBe("22.75");
        expect(Number(held.summary.inactiveDailyPoints)).toBe(5);
        await releaseModelPricePoints({ ...request, now: tomorrow, reason: "not-submitted", evidence: "fixture" });
        const released = await getPricingWalletView(userId, { now: tomorrow, status: "released" });
        expect(released.summary).toMatchObject({ availablePoints: "25", pendingCount: 0 });
        expect(released.items[0]).toMatchObject({ status: "released", restoredPoints: "2.25", expiredPoints: "5.00" });
    });

    it("paginates and filters only the owning user's records and keeps zero and tiny settlements visible", async () => {
        const requests = [input("0.004"), input("0.004"), input("0")];
        for (const request of requests) {
            await reserveModelPricePoints(request);
            await settleModelPricePoints({ ...request, usage: request.maximumUsage });
        }
        const first = await getPricingWalletView(userId, { now, page: 1, pageSize: 2, status: "settled" });
        const second = await getPricingWalletView(userId, { now, page: 2, pageSize: 2, status: "settled" });
        expect(first.total).toBe(3);
        expect(first.items).toHaveLength(2);
        expect(second.items).toHaveLength(1);
        expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
        expect([...first.items, ...second.items].map((item) => item.chargedPoints).sort()).toEqual(["0.00", "0.00", "0.01"]);
        expect((await getPricingWalletView(userId, { now, status: "reserved" })).total).toBe(0);
        const otherId = randomUUID();
        try {
            if (provider === "postgres") {
                const repos = createPostgresRepositories();
                const owner = (await repos.users.getById(userId))!;
                await repos.users.createWithNextAccountId({ ...owner, id: otherId, username: `other_${otherId}`, pointsBalance: 0 });
            } else
                await mutateAuthDb((db) => {
                    db.users.push({ ...db.users.find((item) => item.id === userId)!, id: otherId, username: "other_user", accountId: "0002", pointsBalance: 0 });
                });
            const other = await getPricingWalletView(otherId, { now });
            expect(other.items).toEqual([]);
            expect(other.total).toBe(0);
            expect(other.summary.pendingCount).toBe(0);
        } finally {
            if (provider === "postgres") await createPostgresRepositories().users.delete(otherId);
        }
    });

    it("reads the available balance and pending total atomically with concurrent settlement", async () => {
        const request = input("8.75");
        await reserveModelPricePoints(request);
        const [view] = await Promise.all([getPricingWalletView(userId, { now }), settleModelPricePoints({ ...request, usage: { units: "2.25" } })]);
        const pair = [view.summary.availablePoints, Number(view.summary.pendingPoints), view.items[0].status];
        expect([
            ["16.25", 8.75, "reserved"],
            ["22.75", 0, "settled"],
        ]).toContainEqual(pair);
        await expect(getPricingWalletView(userId, { status: "other", now })).rejects.toThrow("状态");
    });

    function textInput() {
        const base = input();
        const version: OfficialPriceVersion = {
            ...base.version,
            items: [
                { key: "input", unit: "token", per: "1", price: "0.01", currency: "CNY" },
                { key: "cache", unit: "token", per: "1", price: "0.001", currency: "CNY" },
                { key: "output", unit: "token", per: "1", price: "0.02", currency: "CNY" },
            ],
        };
        const contract: FlatTextPriceContract & { id: string } = {
            id: "audited-text-contract",
            officialVersionId: version.id,
            channelId: "text-channel",
            protocol: "openai-responses",
            requestedModel: "text",
            reportedModel: "text-v1",
            scope: "global-standard-text-flat",
            region: "global",
            serviceTier: "default",
            itemMeters: { input: ["inputTokens", "cacheWriteTokens"], cache: ["cachedInputTokens"], output: ["outputTokens"] },
            reviewedAt: version.publishedAt,
            reviewedBy: "admin",
            evidence: "fixture meters checked",
            requestLimits: { maxInputTokens: 8, maxOutputTokens: 4, maxCandidates: 2, sourceUrl: "https://example.com/limits", evidence: "fixture input includes cache and output includes reasoning", includesReasoning: true },
            reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://example.com/text-estimate", evidence: "fixture request sizes, recent output and settlement difference reviewed" },
        };
        return {
            userId,
            requestId: base.requestId,
            requestFingerprint: base.requestFingerprint,
            modelId: base.modelId,
            units: 1,
            usageKind: "text" as const,
            version,
            policy: base.policy,
            now,
            textRequest: { contract, channelId: contract.channelId, requestedModel: contract.requestedModel, protocol: contract.protocol, payload: { model: "text", input: "private request contents", max_output_tokens: 4 } },
        };
    }
    const observedText = (input = 8, cached = 6, output = 1) =>
        inspectProviderTokenUsage("openai-responses", { model: "text-v1", service_tier: "default", usage: { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 } } });

    it.skipIf(provider !== "file")("reserves the frozen text estimate without using the unrelated fixed-mode point price", async () => {
        const request = textInput();
        const db = await readAuthDb();
        db.settings.modelPointCosts[request.modelId] = 100;
        await writeAuthDb(db);
        const held = await reserveModelPricePoints(request);
        expect(held.reservation).toMatchObject({ frozen: { estimatedHoldPoints: "16" }, allocation: { heldPoints: "16.00" } });
        expect(held.snapshot.totalPoints).toBe(9);
        const missing = textInput();
        delete missing.textRequest.contract.reservationEstimate;
        await expect(reserveModelPricePoints(missing)).rejects.toThrow("独立预留估算");
    });

    it.skipIf(provider !== "file")("keeps the old text hold floor only for a previously approved channel", async () => {
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        const request = textInput();
        request.version.sku = "text";
        delete request.textRequest.contract.reservationEstimate;
        const db = await readAuthDb();
        const channel = applyChannelProtocol({ id: "text-channel", name: "Text", baseUrl: "https://example.com", apiKey: "fixture-key", apiFormat: "openai", models: ["text"], enabled: true }, "openai");
        db.settings.systemChannels = [{ ...channel, advancedConfig: { ...channel.advancedConfig!, protocol: "auto", createPath: "/responses", modelConfigs: {}, operationConfigs: {} } }];
        db.settings.logicalModels = [{ id: request.modelId, name: "Text", manufacturer: "OpenAI", capability: "text", enabled: true, bindings: [{ id: "text-binding", channelId: "text-channel", upstreamModel: "text", enabled: true, priority: 0 }] }];
        db.settings.modelPointCosts = { [request.modelId]: 20 };
        await writeAuthDb(db);
        await mutatePricingState((state) => ({ next: { ...state, officialVersions: [request.version], salesVersions: [request.policy] }, result: null }));
        const contract = await saveFlatTextPriceContract(request.textRequest.contract, null);
        const admission = await getModelPricingAdmission(request.modelId, null, undefined, undefined, undefined, true);
        expect(admission.blockers).toEqual([]);
        expect(admission.structuralComplete).toBe(true);
        const key = "text-channel/text";
        await mutatePricingState((state) => ({
            next: {
                ...state,
                billingActivations: {
                    ...state.billingActivations,
                    [request.modelId]: {
                        modelId: request.modelId,
                        enabled: true,
                        revision: "legacy-revision",
                        fingerprint: admission.fingerprint!,
                        salesVersionId: request.policy.id,
                        officialVersionId: request.version.id,
                        evidence: { shadowReceiptIds: { [contract.id]: "text-receipt" } },
                        bindings: { [key]: { fingerprint: admission.bindings[0].fingerprint!, contractIds: [contract.id], shadowReceiptIds: { [contract.id]: "text-receipt" } } },
                        changedAt: now.toISOString(),
                        changedBy: "fixture-admin",
                    },
                },
            },
            result: null,
        }));
        const held = await reserveModelPricePoints({ ...request, textRequest: { ...request.textRequest, contract } });
        expect(held.reservation).toMatchObject({ frozen: { estimatedHoldPoints: "20" }, allocation: { heldPoints: "20.00" } });
    });

    it.skipIf(provider !== "file")("settles an older frozen text reservation without the new estimate review field", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const db = await readAuthDb();
        const saved = db.pricingReservations.find((item) => item.requestId === request.requestId)!;
        delete saved.frozen.text!.contract.reservationEstimate;
        await writeAuthDb(db);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: true });
        expect((await settleModelPricePoints({ ...request, resume: true })).reservation.settlement?.chargedPoints).toBe("4.60");
    });

    it.skipIf(provider !== "file")("freezes a shared text price through settlement and refund after the binding changes", async () => {
        const base = textInput();
        const version = { ...base.version, logicalModelId: "", capability: "text" as const, manufacturer: "OpenAI", sku: "text", items: base.version.items.map((item) => ({ ...item, currency: "USD", price: String(Number(item.price) / 1000) })) };
        const scope = "text:generation:standard";
        const priceSelection = { logicalModelId: base.modelId, scope, bindingId: "binding", bindingRevision: "revision", officialVersionId: version.id };
        const policy = { ...base.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId: base.modelId, coefficient: "2" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "text-channel", name: "Fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "openai", models: ["text"], enabled: true }];
        db.settings.logicalModels = [
            { id: base.modelId, name: "Shared text", manufacturer: "OpenAI", capability: "text", enabled: true, bindings: [{ id: "text-channel:text", channelId: "text-channel", upstreamModel: "text", enabled: true, priority: 0 }] },
        ];
        await writeAuthDb(db);
        await mutatePricingState((state) => ({
            next: {
                ...state,
                officialVersions: [version],
                salesVersions: [policy],
                priceBindings: [
                    {
                        id: priceSelection.bindingId,
                        logicalModelId: base.modelId,
                        capability: "text",
                        operation: "generation",
                        processingMode: "standard",
                        scope,
                        officialVersionId: version.id,
                        status: "active",
                        revision: priceSelection.bindingRevision,
                        current: true,
                        evidence: "fixture",
                        reviewedAt: version.publishedAt,
                        reviewedBy: "admin",
                    },
                ],
            },
            result: undefined,
        }));
        expect((await getFreshAuthSettings()).logicalModels.find((item) => item.id === base.modelId)).toMatchObject({ manufacturer: "OpenAI", capability: "text" });
        expect(await resolvePublishedModelPrice(base.modelId, "text", "generation", (await readPricingState()).salesVersions.at(-1))).toMatchObject({ version, selection: priceSelection });
        const request = { ...base, version, policy, priceSelection };
        const held = await reserveModelPricePoints(request);
        expect(held.reservation.frozen).toMatchObject({ priceSelection, text: { call: { modelId: base.modelId, priceSelection } } });
        await mutatePricingState((state) => ({ next: { ...state, priceBindings: state.priceBindings?.map((binding) => ({ ...binding, revision: "changed" })) }, result: undefined }));
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID() })).rejects.toThrow("独立选价绑定或售价已变化");
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation.settledQuote).toMatchObject({ modelId: base.modelId, exactPoints: "161/2500" });
        expect((await settleModelPricePoints({ ...request, resume: true })).applied).toBe(false);
        const refunded = await refundModelPricePoints({ ...request, refundId: "shared-refund", usage: settled.reservation.settledUsage!, units: 1, evidence: "fixture cancellation" });
        expect(refunded.reservation.frozen.priceSelection).toEqual(priceSelection);
    });

    it.skipIf(provider !== "file")("settles and refunds a published Standard text group from the original response facts", async () => {
        const base = textInput();
        const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token" as const, per: "1000", price, currency: "USD" as const, evidence: "fixture official row" });
        const version = {
            ...base.version,
            logicalModelId: "",
            capability: "text" as const,
            manufacturer: "OpenAI",
            sku: "text",
            items: [],
            textPriceSchedule: {
                declaredRange: { minInclusive: 0, maxInclusive: 8 },
                meters: [
                    { meter: "input", unit: "token" as const },
                    { meter: "cache", unit: "token" as const },
                    { meter: "output", unit: "token" as const },
                ],
                groups: [
                    {
                        id: "short",
                        scopeKind: "generation" as const,
                        selector: { processingMode: "standard" as const, inputTotalTokens: { minInclusive: 0, maxInclusive: 4 } },
                        lines: [line("short-input", "input", "0.01"), line("short-cache", "cache", "0.001"), line("short-output", "output", "0.02")],
                    },
                    {
                        id: "long",
                        scopeKind: "generation" as const,
                        selector: { processingMode: "standard" as const, inputTotalTokens: { minInclusive: 5, maxInclusive: 8 } },
                        lines: [line("long-input", "input", "0.02"), line("long-cache", "cache", "0.001"), line("long-output", "output", "0.02")],
                    },
                ],
            },
        };
        const scope = "text:generation:standard";
        const priceSelection = { logicalModelId: base.modelId, scope, bindingId: "binding", bindingRevision: "revision", officialVersionId: version.id };
        const policy = { ...base.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId: base.modelId, coefficient: "2" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "text-channel", name: "Fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "openai", models: ["text"], enabled: true }];
        db.settings.logicalModels = [
            { id: base.modelId, name: "Scheduled text", manufacturer: "OpenAI", capability: "text", enabled: true, bindings: [{ id: "text-channel:text", channelId: "text-channel", upstreamModel: "text", enabled: true, priority: 0 }] },
        ];
        await writeAuthDb(db);
        await mutatePricingState((state) => ({
            next: {
                ...state,
                officialVersions: [version],
                salesVersions: [policy],
                priceBindings: [
                    {
                        id: priceSelection.bindingId,
                        logicalModelId: base.modelId,
                        capability: "text",
                        operation: "generation",
                        processingMode: "standard",
                        scope,
                        officialVersionId: version.id,
                        status: "active",
                        revision: priceSelection.bindingRevision,
                        current: true,
                        evidence: "fixture",
                        reviewedAt: version.publishedAt,
                        reviewedBy: "admin",
                    },
                ],
            },
            result: undefined,
        }));
        const request = { ...base, version, policy, priceSelection, textRequest: { ...base.textRequest, contract: { ...base.textRequest.contract, scope: "global-standard-text-tiered" as const } } };
        const held = await reserveModelPricePoints(request);
        expect(held.reservation.frozen).toMatchObject({ priceSelection, text: { bound: { maximumGroupId: "long" } } });
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation.settledQuote).toMatchObject({
            selectedGroupId: "long",
            exactPoints: "231/2500",
            lines: expect.arrayContaining([expect.objectContaining({ lineId: "long-input", conditionFactIds: [`${claimId}:${settled.reservation.submission?.response?.fingerprint}:inputTotalTokens`] })]),
        });
        const refund = await refundModelPricePoints({ ...request, refundId: "scheduled-refund", usage: settled.reservation.settledUsage!, units: 1, evidence: "fixture cancellation" });
        expect(refund.reservation.refundedExactPoints).toBe("231/2500");
    });

    it("claims a text submission once and keeps the durable claim across concurrent workers", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const claims = await Promise.all([claimModelPriceSubmission(request), claimModelPriceSubmission(request)]);
        expect(claims.filter((item) => item.claimed)).toHaveLength(1);
        const submission = claims[0].reservation.submission!;
        expect((await state(request.requestId)).reservation?.submission).toEqual(submission);
        expect(await claimModelPriceSubmission(request)).toMatchObject({ claimed: false, reservation: { submission } });
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "caller timeout" })).rejects.toThrow("已认领提交");
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "premature guess" })).rejects.toThrow("已认领提交");
        await expect(settleModelPricePoints({ ...request, observation: observedText(), responseComplete: true })).rejects.toThrow("已保存的完整响应");
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("尚无可恢复");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(9);
    });

    it("keeps uncertain submissions reserved until uncharged evidence explicitly releases them", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const claimed = await claimModelPriceSubmission(request);
        const claimId = claimed.reservation.submission!.id;
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId: "other", kind: "unknown", reason: "transport_error" })).rejects.toThrow("不属于");
        const outcome = { ...request, claimId, kind: "unknown" as const, reason: "transport_error" as const };
        expect((await recordModelPriceSubmissionOutcome(outcome)).applied).toBe(true);
        expect((await recordModelPriceSubmissionOutcome(outcome)).applied).toBe(false);
        expect((await state(request.requestId)).reservation?.submission?.phase).toBe("outcome_unknown");
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "unknown is not unsubmitted" })).rejects.toThrow("已认领提交");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(9);
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "fixture provider confirms no charge" })).rejects.toThrow("已认领提交");
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "not_charged", evidence: "fixture provider confirms no charge" });
        expect((await releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "fixture provider confirms no charge" })).snapshot.totalPoints).toBe(25);
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: true })).rejects.toThrow("已结束");
    });

    it("records an explicitly uncharged rejection without inventing an unknown outcome", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const outcome = { ...request, claimId, kind: "not_charged" as const, evidence: "fixture verified rejection before execution" };
        expect((await recordModelPriceSubmissionOutcome(outcome)).reservation.submission?.phase).toBe("not_charged");
        expect((await recordModelPriceSubmissionOutcome(outcome)).applied).toBe(false);
        expect((await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "transport_error" })).applied).toBe(false);
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, evidence: "changed evidence" })).rejects.toThrow("不能改写");
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "changed evidence" })).rejects.toThrow("已认领提交");
        expect((await releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: outcome.evidence })).snapshot.totalPoints).toBe(25);
    });

    it("persists final metering before settlement and resumes without another submission after a write failure", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "result_unknown" });
        const response = { ...request, claimId, kind: "response" as const, observation: observedText(), responseComplete: true as const };
        if (provider === "postgres") vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("receipt write failure"));
        else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("receipt write failure"));
        await expect(recordModelPriceSubmissionOutcome(response)).rejects.toThrow("receipt write failure");
        expect((await state(request.requestId)).reservation?.submission?.phase).toBe("outcome_unknown");
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await recordModelPriceSubmissionOutcome(response);
        expect((await state(request.requestId)).reservation?.submission).toMatchObject({ phase: "response_received", response: { observation: observedText() } });
        if (provider === "postgres") vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("receipt settlement write failure"));
        else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("receipt settlement write failure"));
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("receipt settlement write failure");
        expect((await state(request.requestId)).reservation?.submission?.phase).toBe("response_received");
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        const results = await Promise.all([settleModelPricePoints({ ...request, resume: true }), settleModelPricePoints({ ...request, resume: true })]);
        expect(results.filter((item) => item.applied)).toHaveLength(1);
        expect(results[0].snapshot.totalPoints).toBe(20.4);
        expect((await recordModelPriceSubmissionOutcome(response)).applied).toBe(false);
        expect((await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "transport_error" })).applied).toBe(false);
        const saved = await state(request.requestId);
        expect(saved.reservation?.status).toBe("settled");
        expect(saved.reservation?.submission?.phase).toBe("response_received");
        expect(saved.reservation?.settledUsageFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "inputTokens", value: "2", status: "derived", scope: { kind: "attempt", scopeId: claimId }, evidenceId: saved.reservation?.submission?.response?.fingerprint }),
                expect.objectContaining({ meter: "cachedInputTokens", value: "6", status: "reported", sourcePath: "usage.input_tokens_details.cached_tokens" }),
            ]),
        );
        expect(saved.reservation?.settledQuote).toMatchObject({
            purpose: "settlement",
            attemptId: claimId,
            exactPoints: "23/5",
            lines: expect.arrayContaining([
                expect.objectContaining({ key: "input", consumedFactIds: [`${claimId}:${saved.reservation?.submission?.response?.fingerprint}:inputTokens`, `${claimId}:${saved.reservation?.submission?.response?.fingerprint}:cacheWriteTokens`] }),
            ]),
        });
        const replay = await settleModelPricePoints({ ...request, resume: true });
        expect(replay.applied).toBe(false);
        expect(replay.reservation.settledUsageFacts).toEqual(saved.reservation?.settledUsageFacts);
        expect(replay.reservation.settledQuote).toEqual(saved.reservation?.settledQuote);
        const publicQuote = (await getPricingWalletView(userId, { now, status: "settled" })).items[0].calculation;
        expect(publicQuote).toMatchObject({ exactPoints: "23/5", lines: expect.arrayContaining([expect.objectContaining({ key: "input", quantity: "2" })]) });
        expect(JSON.stringify(publicQuote)).not.toContain("consumedFactIds");
        expect(saved.records).toHaveLength(1);
        expect(saved.exact).toBe("23/5");
    });

    it("preserves original upstream meter provenance when manual review fills missing text usage", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const original = inspectProviderTokenUsage("openai-responses", { model: "text-v1", service_tier: "default", usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 6 } } });
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: original, responseComplete: true });
        const responseFingerprint = (await state(request.requestId)).reservation!.submission!.response!.fingerprint;
        const supplemented = { ...original, quantities: { ...original.quantities, cacheWriteTokens: "0", inputTokens: "2" } };
        await reviewModelPriceSubmission({
            ...request,
            review: { id: "review-1", claimId, reviewedBy: "reviewer", reviewedAt: now.toISOString(), evidence: "Original response omitted cache write tokens; supplier confirmed zero", outcome: { kind: "response", observation: supplemented } },
        });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation.status).toBe("settled");
        expect(settled.reservation.settledUsageFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "cachedInputTokens", status: "reported", sourcePath: "usage.input_tokens_details.cached_tokens", sourceEvidenceId: responseFingerprint }),
                expect.objectContaining({ meter: "outputTokens", status: "reported", sourcePath: "usage.output_tokens", sourceEvidenceId: responseFingerprint }),
                expect.objectContaining({ meter: "cacheWriteTokens", status: "reviewed", sourcePath: "review:review-1", evidenceId: "review-1" }),
            ]),
        );
        expect(settled.reservation.settledUsageFacts?.find((fact) => fact.meter === "cacheWriteTokens")).not.toHaveProperty("sourceEvidenceId");
        expect(settled.reservation.submission?.response?.observation).toEqual(original);
        expect(JSON.stringify((await getPricingWalletView(userId, { now, status: "settled" })).items[0])).not.toMatch(/sourceEvidenceId|review-1|settledUsageFacts/);
        expect((await settleModelPricePoints({ ...request, resume: true })).applied).toBe(false);
    });

    it("does not overwrite recorded metering or settle incomplete response evidence", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: false as true })).rejects.toThrow("完整结束");
        expect((await state(request.requestId)).reservation?.submission?.response).toBeUndefined();
        const observation = { ...observedText(), quantities: {} };
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation, responseComplete: true });
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("真实用量");
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: observedText(), responseComplete: true })).rejects.toThrow("不能改写");
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "usage missing is not free" })).rejects.toThrow("已认领提交");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(9);
        expect((await state(request.requestId)).records).toHaveLength(0);
    });

    it("does not grant submission permission when claim persistence fails", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        if (provider === "postgres") vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("claim write failure"));
        else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("claim write failure"));
        await expect(claimModelPriceSubmission(request)).rejects.toThrow("claim write failure");
        expect((await state(request.requestId)).reservation?.submission).toBeUndefined();
        expect((await claimModelPriceSubmission(request)).claimed).toBe(true);
    });

    it("reserves the feasible text maximum once and settles against its frozen audited request", async () => {
        const request = textInput();
        const held = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
        expect(held.filter((item) => item.applied)).toHaveLength(1);
        expect(held[0].reservation.allocation.heldPoints).toBe("16.00");
        expect(held[0].snapshot).toMatchObject({ dailyPoints: 0, permanentPoints: 9 });
        const frozen = (await state(request.requestId)).reservation!.frozen;
        expect(frozen.maximumUsage).toEqual({ input: "8", cache: "8", output: "4" });
        expect(frozen.maximumQuoteUsage).toEqual({ input: "8", cache: "0", output: "4" });
        expect(JSON.stringify(frozen)).not.toContain("private request contents");
        request.policy.userPriceRules = [{ scope: "default", coefficient: "2" }];
        request.textRequest.contract.requestLimits!.maxInputTokens = 100;
        expect((await reserveModelPricePoints(request)).reservation.frozen).toEqual(frozen);
        const results = await Promise.all([1, 2].map(() => settleModelPricePoints({ ...request, observation: observedText(), responseComplete: true })));
        expect(results.filter((item) => item.applied)).toHaveLength(1);
        expect(results[0].snapshot).toMatchObject({ dailyPoints: 0.4, permanentPoints: 20 });
        const saved = await state(request.requestId);
        expect(saved.exact).toBe("23/5");
        expect(saved.reservation?.settledUsage).toEqual({ input: "2", cache: "6", output: "1" });
        expect(saved.reservation?.settledObservation).toEqual(observedText());
        expect(saved.records).toHaveLength(1);
        expect(saved.records[0].amount).toBe(-4.6);
        expect(saved.quota).toMatchObject([{ units: 1, pointsSpent: 4.6 }]);
        await expect(settleModelPricePoints({ ...request, observation: observedText(8, 5), responseComplete: true })).rejects.toThrow("用量已变化");
        await refundModelPricePoints({ ...request, refundId: "cache-refund", usage: { input: "0", cache: "6", output: "0" }, units: 0, evidence: "fixture partial cancellation" });
        const refund = await refundModelPricePoints({ ...request, refundId: "remaining-refund", usage: { input: "2", cache: "0", output: "1" }, units: 1, evidence: "fixture remaining cancellation" });
        expect(refund.snapshot).toMatchObject({ dailyPoints: 5, permanentPoints: 20 });
        expect((await state(request.requestId)).exact).toBe("0");
    });

    it("estimates a short text request instead of holding the model-wide ceiling, then settles actual usage and blocks debt", async () => {
        const request = textInput();
        request.version.items = request.version.items.map((item) => ({ ...item, price: String(Number(item.price) / 10) }));
        request.textRequest.payload = { model: "text", input: "1+1?", max_output_tokens: 100 };
        request.textRequest.contract.requestLimits = { ...request.textRequest.contract.requestLimits!, maxInputTokens: 922000, maxOutputTokens: 128000 };
        const held = await reserveModelPricePoints(request);
        expect(Number(held.reservation.allocation.heldPoints)).toBeLessThan(25);
        expect(held.reservation.frozen.text?.bound.inputTokens).toBe("922000");
        const settled = await settleModelPricePoints({ ...request, observation: observedText(100, 0, 100), responseComplete: true });
        expect(settled.reservation).toMatchObject({ status: "settled", estimatedHold: { heldPoints: held.reservation.allocation.heldPoints }, settlement: { chargedPoints: "30.00" } });
        expect(settled.reservation.unpaidAtSettlement).not.toBe("0.00");
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID() })).rejects.toThrow("待补扣");
    });

    it("uses the latest settled output from the same binding when estimating a later request", async () => {
        const first = textInput();
        first.version.items = first.version.items.map((item) => ({ ...item, price: String(Number(item.price) / 10) }));
        first.textRequest.payload = { model: "text", input: "hello", max_output_tokens: 100 };
        first.textRequest.contract.requestLimits = { ...first.textRequest.contract.requestLimits!, maxInputTokens: 1000, maxOutputTokens: 100 };
        const initial = await reserveModelPricePoints(first);
        await settleModelPricePoints({ ...first, observation: observedText(10, 0, 5), responseComplete: true });
        const next = { ...first, requestId: randomUUID() };
        const held = await reserveModelPricePoints(next);
        expect(held.reservation.frozen.text?.bound.outputTokens).toBe("100");
        expect(Number(held.reservation.allocation.heldPoints)).toBeLessThan(25);
        expect(Number(held.reservation.allocation.heldPoints)).toBeLessThan(Number(initial.reservation.allocation.heldPoints));
        expect(held.reservation.frozen.estimatedHoldPoints).toBeDefined();
    });

    it.each(["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"])("keeps an unexpected %s cache-write response reserved and settles a valid request", async (model) => {
        const kimiRequest = () => {
            const base = textInput();
            return {
                ...base,
                version: {
                    ...base.version,
                    manufacturer: "Moonshot",
                    sku: model,
                    items: [
                        { key: "input", unit: "token", per: "1000000", price: model.endsWith("highspeed") ? "1.90" : "0.95", currency: "USD" },
                        { key: "cache", unit: "token", per: "1000000", price: model === "kimi-k2.6" ? "0.16" : model.endsWith("highspeed") ? "0.38" : "0.19", currency: "USD" },
                        { key: "output", unit: "token", per: "1000000", price: model.endsWith("highspeed") ? "8" : "4", currency: "USD" },
                    ],
                },
                textRequest: {
                    ...base.textRequest,
                    protocol: "openai-chat" as const,
                    requestedModel: model,
                    payload: {
                        model,
                        messages: [{ role: "user", content: "fixture" }],
                        max_tokens: 100,
                    },
                    contract: {
                        ...base.textRequest.contract,
                        protocol: "openai-chat" as const,
                        requestedModel: model,
                        reportedModel: model,
                        itemMeters: { input: ["uncachedInputTokens" as const], cache: ["cachedInputTokens" as const], output: ["outputTokens" as const] },
                        requestLimits: { ...base.textRequest.contract.requestLimits!, maxInputTokens: 1000, maxOutputTokens: 100 },
                    },
                },
            };
        };
        const observation = (write?: number) =>
            inspectProviderTokenUsage("openai-chat", {
                model,
                service_tier: "default",
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 90,
                    prompt_tokens_details: { cached_tokens: 300, ...(write === undefined ? {} : { cache_write_tokens: write }) },
                },
            });
        const abnormal = kimiRequest();
        await reserveModelPricePoints(abnormal);
        const claimId = (await claimModelPriceSubmission(abnormal)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...abnormal, claimId, kind: "response", observation: observation(200), responseComplete: true });
        await expect(settleModelPricePoints({ ...abnormal, resume: true })).rejects.toThrow(model === "kimi-k2.6" ? "Kimi K2.6 不支持缓存写入" : "Kimi K2.7 Code 缓存写入分项未核实");
        expect((await state(abnormal.requestId)).reservation).toMatchObject({ status: "reserved", submission: { phase: "response_received" } });
        expect((await state(abnormal.requestId)).records).toHaveLength(0);
        await expect(releaseModelPricePoints({ ...abnormal, reason: "confirmed-no-charge", evidence: "unexpected metering is not free" })).rejects.toThrow("已认领提交");

        const valid = kimiRequest();
        await reserveModelPricePoints(valid);
        const validClaimId = (await claimModelPriceSubmission(valid)).reservation.submission!.id;
        await recordModelPriceSubmissionOutcome({ ...valid, claimId: validClaimId, kind: "response", observation: observation(), responseComplete: true });
        const settled = await settleModelPricePoints({ ...valid, resume: true });
        expect(settled.reservation).toMatchObject({ status: "settled", settledUsage: { input: "700", cache: "300", output: "90" }, settlement: { chargedPoints: model === "kimi-k2.6" ? "0.75" : model.endsWith("highspeed") ? "1.51" : "0.76" } });
    });

    it("reserves one context tier and settles the actual tier under frozen prices", async () => {
        const request = textInput();
        const prices = { input: ["0.004", "0.008"], cache: ["0.002", "0.004"], write: ["0.004", "0.008"], output: ["0.01", "0.02"] } as const;
        request.version.items = (["short", "long"] as const).flatMap((tier, index) => Object.entries(prices).map(([meter, rates]) => ({ key: `${tier}-${meter}`, unit: "token", per: "1", price: rates[index], currency: "CNY" })));
        request.textRequest.contract.scope = "global-standard-text-tiered";
        request.textRequest.contract.itemMeters = Object.fromEntries(
            request.version.items.map((item) => [item.key, [item.key.split("-")[1] === "input" ? "inputTokens" : item.key.split("-")[1] === "cache" ? "cachedInputTokens" : item.key.split("-")[1] === "write" ? "cacheWriteTokens" : "outputTokens"]]),
        );
        request.textRequest.contract.contextTiers = {
            thresholdInputTokens: 4,
            shortItemKeys: request.version.items.slice(0, 4).map((item) => item.key),
            longItemKeys: request.version.items.slice(4).map((item) => item.key),
            sourceUrl: "https://example.com/context-tiers",
            evidence: "Synthetic full-request tier fixture",
        };
        const reserved = await reserveModelPricePoints(request);
        expect(reserved.reservation.frozen.maximumQuoteUsage).toMatchObject({ "short-input": "0", "long-input": "8", "long-output": "4" });
        expect(reserved.reservation.allocation.heldPoints).toBe("14.40");
        request.version.items[4].price = "1";
        const settled = await settleModelPricePoints({ ...request, observation: observedText(), responseComplete: true });
        expect(settled.reservation.settledUsage).toMatchObject({ "short-input": "0", "long-input": "2", "long-cache": "6", "long-output": "1" });
        expect(settled.reservation.settlement?.chargedPoints).toBe("6.00");
        expect((await state(request.requestId)).exact).toBe("6");
    });

    it("rejects text input sums above the cap even when each item and total price fit", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        await expect(settleModelPricePoints({ ...request, observation: observedText(9, 8, 0), responseComplete: true })).rejects.toThrow("请求上界");
        await expect(settleModelPricePoints({ ...request, observation: observedText(8, 6, 5), responseComplete: true })).rejects.toThrow("请求上界");
        await expect(settleModelPricePoints({ ...request, usage: { input: "2", cache: "6", output: "1" } })).rejects.toThrow("规范化用量");
        await expect(settleModelPricePoints({ ...request, observation: observedText(), responseComplete: false })).rejects.toThrow("完整结束");
        await expect(settleModelPricePoints({ ...request, observation: { ...observedText(), quantities: {} }, responseComplete: true })).rejects.toThrow("真实用量");
        expect((await state(request.requestId)).reservation?.status).toBe("reserved");
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(9);
    });

    it("settles a complete response against the frozen sale price and records explicit identity anomalies", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        const settled = await settleModelPricePoints({ ...request, observation: { ...observedText(), reportedModel: "other", serviceTier: "priority" }, responseComplete: true });
        expect(settled.reservation).toMatchObject({ status: "settled", billingWarnings: [expect.stringContaining("响应型号"), expect.stringContaining("非 Standard")] });
        expect(settled.reservation.frozen.policy.id).toBe(request.policy.id);
    });

    it("rejects changed payload or channel under the same text reservation identity", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        await expect(reserveModelPricePoints({ ...request, textRequest: { ...request.textRequest, payload: { ...request.textRequest.payload, max_output_tokens: 3 } } })).rejects.toThrow("文本请求已变化");
        await expect(reserveModelPricePoints({ ...request, textRequest: { ...request.textRequest, channelId: "other" } })).rejects.toThrow("文本请求已变化");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(9);
    });

    it("does not reserve text points without complete applicable audit evidence", async () => {
        const request = textInput();
        await expect(reserveModelPricePoints({ ...request, textRequest: { ...request.textRequest, contract: { ...request.textRequest.contract, requestLimits: undefined } } })).rejects.toThrow("已审核请求上界");
        await expect(reserveModelPricePoints({ ...request, textRequest: { ...request.textRequest, protocol: "openai-chat" } })).rejects.toThrow("渠道契约");
        await expect(reserveModelPricePoints({ ...request, textRequest: { ...request.textRequest, payload: { ...request.textRequest.payload, tools: [{ type: "web_search" }] } } })).rejects.toThrow("额外计费能力");
        await expect(reserveModelPricePoints({ ...request, units: 2 })).rejects.toThrow("渠道契约");
        expect((await state(request.requestId)).reservation).toBeUndefined();
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(25);
    });

    it("rolls back a text settlement and can resume using the same frozen evidence", async () => {
        const request = textInput();
        await reserveModelPricePoints(request);
        if (provider === "postgres") vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("text fixture write failure"));
        else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("text fixture write failure"));
        await expect(settleModelPricePoints({ ...request, observation: observedText(), responseComplete: true })).rejects.toThrow("text fixture write failure");
        const saved = await state(request.requestId);
        expect(saved.records).toHaveLength(0);
        expect(saved.exact).toBe("0");
        expect(saved.reservation?.status).toBe("reserved");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(9);
        expect((await settleModelPricePoints({ ...request, observation: observedText(), responseComplete: true })).snapshot.totalPoints).toBe(20.4);
    });

    it("holds once, freezes price, settles once and writes the actual ledger in the same transaction", async () => {
        const request = input();
        const reserves = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
        expect(reserves.filter((result) => result.applied)).toHaveLength(1);
        expect(reserves[0].snapshot).toMatchObject({ dailyPoints: 0, permanentPoints: 16.25 });
        expect((await state(request.requestId)).records).toHaveLength(0);
        request.policy.userPriceRules = [{ scope: "default", coefficient: "2" }];
        expect((await reserveModelPricePoints(request)).reservation.frozen.policy.userPriceRules).toEqual([]);
        const settled = await Promise.all([settleModelPricePoints({ ...request, usage: { units: "3.25" } }), settleModelPricePoints({ ...request, usage: { units: "3.250" } })]);
        expect(settled.filter((result) => result.applied)).toHaveLength(1);
        expect(settled[0].snapshot).toMatchObject({ dailyPoints: 1.75, permanentPoints: 20 });
        const saved = await state(request.requestId);
        expect(saved.reservation?.status).toBe("settled");
        expect(saved.exact).toBe("13/4");
        expect(saved.records).toHaveLength(1);
        expect(saved.records[0]).toMatchObject({ amount: -3.25, dailyAmount: -3.25, permanentAmount: 0 });
        expect(saved.quota).toMatchObject([{ units: 1, pointsSpent: 3.25 }]);
        await expect(refundPoints({ userId, sourceRecordId: saved.records[0].id, idempotencyKey: randomUUID(), usageKind: "audio", units: 1, description: "wrong refund path", now })).rejects.toThrow("专用退款");
    });

    it("serializes reservations against legacy debits and rejects overspending without partial writes", async () => {
        const request = input("20");
        await reserveModelPricePoints(request);
        await expect(consumePoints({ userId, amount: 6, units: 1, usageKind: "text", model: "legacy", description: "fixture", idempotencyKey: randomUUID(), now })).rejects.toThrow("积分不足");
        const attempts = await Promise.allSettled([reserveModelPricePoints(input("4")), reserveModelPricePoints(input("4"))]);
        expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(1);
        expect((await state(request.requestId)).records).toHaveLength(0);
    });

    it("releases only a confirmed uncharged call and keeps expired daily points out of the new grant", async () => {
        const request = input();
        await reserveModelPricePoints(request);
        await expect(releaseModelPricePoints({ ...request, reason: "unknown" as "not-submitted", evidence: "timeout" })).rejects.toThrow("明确未计费");
        const release = { ...request, now: new Date("2026-10-03T08:00:00+08:00"), reason: "confirmed-no-charge" as const, evidence: "fixture terminal failure" };
        const results = await Promise.all([releaseModelPricePoints(release), releaseModelPricePoints(release)]);
        expect(results.filter((result) => result.applied)).toHaveLength(1);
        expect(results[0].snapshot).toMatchObject({ dailyPoints: 5, permanentPoints: 20 });
        expect(results[0].reservation.release).toMatchObject({ dailyRestored: "0.00", dailyExpired: "5.00", permanentRestored: "3.75" });
        expect((await state(request.requestId)).quota).toMatchObject([{ units: 0, pointsSpent: 0 }]);
        await expect(settleModelPricePoints({ ...request, usage: { units: "1" } })).rejects.toThrow("已释放");
    });

    it("preserves holds on conflicting requests, unknown usage and an exceeded bound", async () => {
        const request = input();
        await reserveModelPricePoints(request);
        await expect(reserveModelPricePoints({ ...request, requestFingerprint: "b".repeat(64) })).rejects.toThrow("不同请求");
        await expect(settleModelPricePoints({ ...request, usage: {} })).rejects.toThrow("缺少");
        await expect(settleModelPricePoints({ ...request, usage: { units: "9" } })).rejects.toThrow("上界");
        expect((await state(request.requestId)).reservation?.status).toBe("reserved");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(16.25);
        await settleModelPricePoints({ ...request, usage: { units: "1" } });
        await expect(settleModelPricePoints({ ...request, usage: { units: "2" } })).rejects.toThrow("用量已变化");
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "wrong" })).rejects.toThrow("退款流程");
    });

    it("rolls back balance, quota, exact total and ledger when persistence fails", async () => {
        const request = input();
        await reserveModelPricePoints(request);
        if (provider === "postgres") {
            vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("fixture write failure"));
        } else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("fixture write failure"));
        await expect(settleModelPricePoints({ ...request, usage: { units: "3.25" } })).rejects.toThrow("fixture write failure");
        const saved = await state(request.requestId);
        expect(saved.reservation?.status).toBe("reserved");
        expect(saved.exact).toBe("0");
        expect(saved.records).toHaveLength(0);
        expect(saved.quota).toMatchObject([{ pointsSpent: 8.75 }]);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(16.25);
    });

    it("accumulates concurrent tiny settlements and keeps successful zero charges in the ledger", async () => {
        const requests = [input("0.004"), input("0.004"), input("0")];
        await Promise.all(requests.map(reserveModelPricePoints));
        await Promise.all(requests.map((request) => settleModelPricePoints({ ...request, usage: request.maximumUsage })));
        const saved = await state(requests[0].requestId);
        expect(saved.exact).toBe("1/125");
        expect(saved.records).toHaveLength(3);
        expect(saved.records.map((item) => item.amount).reduce((sum, amount) => sum + amount, 0)).toBe(-0.01);
        expect(saved.quota).toMatchObject([{ units: 3, pointsSpent: 0.01 }]);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(24.99);
    });

    it("refunds partial usage against the frozen price and caps cumulative quantities and counts", async () => {
        const request = { ...input(), units: 2 };
        await reserveModelPricePoints(request);
        await settleModelPricePoints({ ...request, usage: request.maximumUsage });
        request.policy.userPriceRules = [{ scope: "default", coefficient: "2" }];
        const partial = { ...request, refundId: "partial-one", usage: { units: "2" }, units: 1, evidence: "one failed output" };
        const results = await Promise.all([refundModelPricePoints(partial), refundModelPricePoints({ ...partial, usage: { units: "2.00" } })]);
        expect(results.filter((item) => item.applied)).toHaveLength(1);
        expect(results[0].snapshot).toMatchObject({ dailyPoints: 0, permanentPoints: 18.25 });
        expect(results[0].refund.calculation.release).toMatchObject({ permanentRestored: "2.00", dailyRestored: "0.00" });
        await expect(refundModelPricePoints({ ...partial, usage: { units: "3" } })).rejects.toThrow("重复退款");
        await expect(refundModelPricePoints({ ...partial, refundId: "excess", usage: { units: "6.76" } })).rejects.toThrow("超过原结算");
        await expect(refundModelPricePoints({ ...partial, refundId: "excess-count", units: 2 })).rejects.toThrow("次数超过");
        const final = await refundModelPricePoints({ ...partial, refundId: "partial-two", usage: { units: "6.75" } });
        expect(final.snapshot).toMatchObject({ dailyPoints: 5, permanentPoints: 20 });
        const saved = await state(request.requestId);
        expect(saved.exact).toBe("0");
        expect(saved.quota).toMatchObject([{ units: 0, pointsSpent: 0 }]);
        expect(saved.records.filter((item) => item.type === "refund")).toHaveLength(2);
        expect(final.reservation.refundedUsage).toEqual({ units: "8.75" });
        expect(final.refund.chargeRecordId).toBe(saved.reservation?.chargeRecordId);
    });

    it("returns a rounding adjustment only to its original pool even when the original call charged zero", async () => {
        const first = input("0.004");
        const second = input("0.004");
        for (const request of [first, second]) {
            await reserveModelPricePoints(request);
            await settleModelPricePoints({ ...request, usage: request.maximumUsage });
        }
        expect((await state(first.requestId)).reservation?.settlement?.chargedPoints).toBe("0.00");
        const restored = await refundModelPricePoints({ ...first, refundId: "first", usage: first.maximumUsage, units: 1, evidence: "fixture" });
        expect(restored.refund.calculation.release).toMatchObject({ dailyRestored: "0.01", permanentRestored: "0.00" });
        expect(restored.snapshot).toMatchObject({ dailyPoints: 5, permanentPoints: 20 });
        const secondRefund = await refundModelPricePoints({ ...second, refundId: "second", usage: second.maximumUsage, units: 1, evidence: "fixture" });
        expect(secondRefund.refund.calculation.release.releasedPoints).toBe("0.00");
        expect((await state(first.requestId)).exact).toBe("0");
        expect((await state(first.requestId)).quota).toMatchObject([{ units: 0, pointsSpent: 0 }]);
    });

    it("does not restore expired daily funds or apply a refund to the new day's quota", async () => {
        const request = input();
        await reserveModelPricePoints(request);
        await settleModelPricePoints({ ...request, usage: request.maximumUsage });
        const refunded = await refundModelPricePoints({ ...request, now: new Date("2026-10-03T08:00:00+08:00"), refundId: "next-day", usage: request.maximumUsage, units: 1, evidence: "confirmed refund" });
        expect(refunded.snapshot).toMatchObject({ dailyPoints: 5, permanentPoints: 20 });
        expect(refunded.refund.calculation.release).toMatchObject({ dailyExpired: "5.00", dailyRestored: "0.00", permanentRestored: "3.75" });
        const saved = await state(request.requestId);
        expect(saved.exact).toBe("0");
        expect(saved.quota).toMatchObject([{ units: 0, pointsSpent: 0 }]);
        expect(saved.records.find((item) => item.type === "refund")?.amount).toBe(3.75);
    });

    it("keeps expired daily, current daily and permanent sub-cent balances in separate pools", async () => {
        const first = input("0.004");
        const later = { ...input("0.004"), now: new Date("2026-10-03T08:00:00+08:00") };
        for (const request of [first, later]) {
            await reserveModelPricePoints(request);
            expect((await settleModelPricePoints({ ...request, usage: request.maximumUsage })).reservation.settlement?.chargedPoints).toBe("0.00");
        }
        if (provider === "postgres") await postgresQuery("UPDATE app_settings SET free_daily_points_enabled = false WHERE id = 'default'");
        else
            await mutateAuthDb((db) => {
                db.settings.freeDailyPointsEnabled = false;
            });
        const permanent = { ...input("0.004"), now: later.now };
        await reserveModelPricePoints(permanent);
        expect((await settleModelPricePoints({ ...permanent, usage: permanent.maximumUsage })).reservation.settlement?.chargedPoints).toBe("0.00");
        const refunded = await refundModelPricePoints({ ...first, now: later.now, refundId: "old-source", usage: first.maximumUsage, units: 1, evidence: "fixture" });
        expect(refunded.refund.calculation.release.permanentRestored).toBe("0.00");
        expect(refunded.snapshot.permanentPoints).toBe(20);
        const laterState = await state(later.requestId);
        expect(laterState.reservation?.settlement?.sourceExactPoints.daily).toBe("1/250");
        if (provider === "postgres") {
            const repo = new ModelPricingWalletRepository({ query: postgresQuery });
            expect(await repo.getExact(userId, pricingDailySourceKey(laterState.reservation!.allocation)!)).toBe("1/250");
            expect(await repo.getExact(userId, "permanent")).toBe("1/250");
        } else {
            const accounts = (await readAuthDb()).pricingAccruals.filter((item) => item.userId === userId);
            expect(accounts.find((item) => item.sourceKey === "permanent")?.exactPoints).toBe("1/250");
            expect(accounts.find((item) => item.sourceKey === pricingDailySourceKey(laterState.reservation!.allocation))?.exactPoints).toBe("1/250");
        }
    });

    it("rolls back refund balances, receipt, exact totals and usage together on write failure", async () => {
        const request = input();
        await reserveModelPricePoints(request);
        await settleModelPricePoints({ ...request, usage: request.maximumUsage });
        if (provider === "postgres") vi.spyOn(ModelPricingWalletRepository.prototype, "saveRefund").mockRejectedValueOnce(new Error("refund write failed"));
        else vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("refund write failed"));
        const refund = { ...request, refundId: "rollback", usage: request.maximumUsage, units: 1, evidence: "fixture" };
        await expect(refundModelPricePoints(refund)).rejects.toThrow("refund write failed");
        const saved = await state(request.requestId);
        expect(saved.exact).toBe("35/4");
        expect(saved.records).toHaveLength(1);
        expect(saved.quota).toMatchObject([{ units: 1, pointsSpent: 8.75 }]);
        expect(saved.reservation?.refundedUnits).toBeUndefined();
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(16.25);
        expect((await refundModelPricePoints(refund)).applied).toBe(true);
    });

    it("reverses zero-price usage and rejects unsettled, foreign or empty refunds", async () => {
        const request = input("0");
        const refund = { ...request, refundId: "zero", usage: { units: "0" }, units: 1, evidence: "zero-price failed call" };
        await reserveModelPricePoints(request);
        await expect(refundModelPricePoints(refund)).rejects.toThrow("已结算");
        await settleModelPricePoints({ ...request, usage: request.maximumUsage });
        await expect(refundModelPricePoints({ ...refund, requestFingerprint: "b".repeat(64) })).rejects.toThrow("不同请求");
        await expect(refundModelPricePoints({ ...refund, units: 0 })).rejects.toThrow("用量或调用次数");
        await refundModelPricePoints(refund);
        const saved = await state(request.requestId);
        expect(saved.records.filter((item) => item.type === "refund")).toHaveLength(1);
        expect(saved.quota).toMatchObject([{ units: 0, pointsSpent: 0 }]);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(25);
    });
});
