import Fraction from "fraction.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dataAdapter from "./data-adapter";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { saveModelPriceBinding } from "./model-price-binding-store";
import { mutatePricingState } from "./model-pricing-store";
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
    getModelPriceReservation,
    reviewModelPriceSubmission,
} from "./model-pricing-wallet-service";
import type { AudioWalletRequest } from "./model-pricing-audio-wallet-request";
import { inspectAudioUsage } from "./model-pricing-audio-usage";
import { geminiAudioRequest, geminiAudioResult } from "./gemini-audio-provider";
import * as ffmpeg from "./ffmpeg";
import { savePricedAudioResponse, recoverPricedAudioResponse } from "./model-pricing-audio-response";
import { readAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";
import { ModelPricingAudioResponseRepository } from "./database/model-pricing-audio-response-repository";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { consumePoints, getPointsWalletSnapshot } from "./points-wallet-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const now = new Date("2026-10-02T08:00:00+08:00");
describe.each(providers)("synchronous TTS wallet transactions (%s)", (provider) => {
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

    const models = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"] as const;
    function audioInput(model: (typeof models)[number] = models[0], declaredProtocol: "gemini" | "dataeyes-gemini" = "gemini") {
        const base = input();
        const version = {
            ...base.version,
            manufacturer: "Fixture",
            series: "TTS",
            sku: model,
            items: [
                { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "20", currency: "USD" },
            ],
        };
        const request = geminiAudioRequest("PRIVATE_PROMPT", "Kore");
        const audioRequest: AudioWalletRequest = {
            channelId: "audio-channel",
            requestedModel: model,
            declaredProtocol,
            payload: { ...request, generationConfig: { ...request.generationConfig, maxOutputTokens: 100 } },
            contract: {
                id: "audio-contract",
                officialVersionId: version.id,
                channelId: "audio-channel",
                requestedModel: model,
                reportedModel: model,
                modelIdentity: "response-required",
                protocol: "gemini-tts",
                declaredProtocol,
                scope: "global-standard-gemini-tts",
                inputTextItem: "input",
                outputAudioItem: "output",
                evidence: "Synthetic normal rates, not official publication",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
        };
        return { userId, requestId: base.requestId, requestFingerprint: base.requestFingerprint, modelId: base.modelId, usageKind: "audio" as const, units: 1, version, policy: base.policy, now, audioRequest };
    }
    const response = (model: string = models[0], input = 10, output = 20) => ({
        modelVersion: model,
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "PRIVATE_AUDIO" } }] } }],
        usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output, promptTokensDetails: [{ modality: "TEXT", tokenCount: input }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: output }] },
    });
    async function submit(request = audioInput()) {
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const record = (payload = response(request.audioRequest.requestedModel)) => recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectAudioUsage("gemini-tts", payload), responseComplete: true });
        return { request, claimId, record };
    }
    it.skipIf(provider !== "file")("settles the frozen independent audio price after its reviewed binding changes", async () => {
        const base = audioInput();
        const version = { ...base.version, logicalModelId: "", capability: "audio" as const, processingTier: "standard" as const };
        const binding = {
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId: base.modelId,
            capability: "audio" as const,
            operation: "generateContent" as const,
            processingMode: "standard" as const,
            scope: "audio:generateContent:standard",
            officialVersionId: version.id,
            status: "active" as const,
            current: true,
            evidence: "original Gemini audio selection",
            reviewedBy: "admin",
            reviewedAt: version.publishedAt,
        };
        const priceSelection = { logicalModelId: base.modelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: version.id };
        const policy = { ...base.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId: base.modelId, coefficient: "2" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "audio-channel", name: "Gemini fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "gemini", models: [base.audioRequest.requestedModel], enabled: true }];
        db.settings.logicalModels = [
            {
                id: base.modelId,
                name: "Gemini audio fixture",
                manufacturer: "Fixture",
                capability: "audio",
                enabled: true,
                bindings: [{ id: "audio-binding", channelId: "audio-channel", upstreamModel: base.audioRequest.requestedModel, enabled: true, priority: 0 }],
            },
        ];
        await writeAuthDb(db);
        await mutatePricingState((state) => ({ next: { ...state, officialVersions: [version], salesVersions: [policy], priceBindings: [binding] }, result: undefined }));
        const request = { ...base, version, policy, priceSelection };
        const { record } = await submit(request);
        await saveModelPriceBinding({ ...binding, evidence: "replacement Gemini audio selection" }, binding.revision);
        await record();
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation).toMatchObject({ status: "settled", frozen: { priceSelection }, settlement: { chargedPoints: "0.57" } });
        await expect(reserveModelPricePoints({ ...request, requestId: randomUUID() })).rejects.toThrow("独立选价绑定或售价已变化");
    });
    it.each(models)("reserves and settles %s through both transports at original normal rates", async (model) => {
        for (const protocol of ["gemini", "dataeyes-gemini"] as const) {
            const request = audioInput(model, protocol);
            const holds = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
            expect(holds.filter((item) => item.applied)).toHaveLength(1);
            expect(holds[0].reservation.allocation).toMatchObject({ heldPoints: "7.14", dailyHeld: "5.00", permanentHeld: "2.14" });
            expect(holds[0].reservation.frozen.maximumUsage).toEqual({ input: "8192", output: "100" });
            const claims = await Promise.all([claimModelPriceSubmission(request), claimModelPriceSubmission(request)]);
            expect(claims.filter((item) => item.claimed)).toHaveLength(1);
            const claimId = claims[0].reservation.submission!.id;
            const view = await getPricingWalletView(userId, { now });
            expect(view.items.find((item) => item.id === request.requestId)).toMatchObject({ stage: "submitting", status: "reserved" });
            expect(JSON.stringify(view)).not.toMatch(/audio-contract|PRIVATE_|payloadFingerprint/);
            request.version.items[0].price = "99";
            request.policy.conversion!.cnyPerUsd = "9";
            request.policy.userPriceRules = [{ scope: "default", coefficient: "9" }];
            request.audioRequest.contract.evidence = "later approval";
            expect((await reserveModelPricePoints(request)).reservation.allocation.heldPoints).toBe("7.14");
            const observation = inspectAudioUsage("gemini-tts", response(model));
            const outcome = { ...request, claimId, kind: "response" as const, observation, responseComplete: true as const };
            const recorded = await Promise.all([recordModelPriceSubmissionOutcome(outcome), recordModelPriceSubmissionOutcome(outcome)]);
            expect(recorded.filter((item) => item.applied)).toHaveLength(1);
            // JSONB key order does not alter receipt identity.
            await recordModelPriceSubmissionOutcome({ ...outcome, observation: { ...observation, quantities: Object.fromEntries(Object.entries(observation.quantities).reverse()) } });
            const settled = await Promise.all([settleModelPricePoints({ ...request, resume: true }), settleModelPricePoints({ ...request, resume: true })]);
            expect(settled.filter((item) => item.applied)).toHaveLength(1);
            expect(settled[0].reservation.settlement).toMatchObject({ actualExactPoints: "287/1000", chargedPoints: "0.29" });
            expect(settled[0].reservation.settledUsage).toEqual({ input: "10", output: "20" });
            expect(settled[0].reservation.settledAudioUsageFacts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ meter: "inputTextTokens", value: "10", status: "reported", sourcePaths: ["usageMetadata.promptTokensDetails[0].tokenCount"] }),
                    expect.objectContaining({ meter: "outputAudioTokens", value: "20", status: "reported", sourcePaths: ["usageMetadata.candidatesTokensDetails[0].tokenCount"] }),
                ]),
            );
            expect(settled[0].reservation.settledAudioQuote).toMatchObject({
                purpose: "settlement",
                contractId: "audio-contract",
                attemptId: claimId,
                exactPoints: "287/1000",
                lines: [expect.objectContaining({ consumedFactIds: [expect.any(String)] }), expect.objectContaining({ consumedFactIds: [expect.any(String)] })],
            });
            expect(JSON.stringify((await getPricingWalletView(userId, { now })).items.find((item) => item.id === request.requestId))).not.toMatch(/sourcePaths|consumedFactIds/);
            expect(settled[0].snapshot.totalPoints).toBe(24.71);
            expect(JSON.stringify(await getModelPriceReservation(request))).not.toMatch(/PRIVATE_/);
            const refund = { ...request, refundId: "cancel-original", usage: settled[0].reservation.settledUsage!, units: 1, evidence: "original paid audio cancelled" };
            const refunded = await Promise.all([refundModelPricePoints(refund), refundModelPricePoints(refund)]);
            expect(refunded.filter((item) => item.applied)).toHaveLength(1);
            expect(refunded[0].snapshot.totalPoints).toBe(25);
            expect((await state(request.requestId)).exact).toBe("0");
        }
        expect((await state("none")).records).toHaveLength(4);
    });
    it("derives candidate totals from the actual request and rejects insufficient funds before claiming", async () => {
        const request = audioInput();
        const payload = request.audioRequest.payload as { generationConfig: Record<string, unknown> };
        payload.generationConfig.candidateCount = 3;
        const held = await reserveModelPricePoints(request);
        expect(held.reservation.frozen.maximumUsage).toEqual({ input: "8192", output: "300" });
        expect(held.reservation.allocation.heldPoints).toBe("9.94");
        await expect(settleModelPricePoints({ ...request, observation: inspectAudioUsage("gemini-tts", response()), responseComplete: true })).rejects.toThrow("原提交");
        await releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "cancelled before claim" });
        const large = audioInput();
        delete (large.audioRequest.payload as { generationConfig: Record<string, unknown> }).generationConfig.maxOutputTokens;
        await expect(reserveModelPricePoints(large)).rejects.toThrow();
        expect((await state(large.requestId)).reservation).toBeUndefined();
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(25);
        await expect(reserveModelPricePoints({ ...audioInput(), usageKind: "video" })).rejects.toThrow("类型或准备身份不匹配");
    });
    it("refunds individual audio price items at the original rates without exceeding usage or duplicating quota", async () => {
        const { request, record } = await submit();
        await record();
        await settleModelPricePoints({ ...request, resume: true });
        request.version.items[0].price = "99";
        request.policy.userPriceRules = [{ scope: "default", coefficient: "9" }];
        const partial = { ...request, refundId: "text-only", usage: { input: "10", output: "0" }, units: 0, evidence: "original input refund proof" };
        const first = await refundModelPricePoints(partial);
        expect(first.snapshot.totalPoints).toBe(24.72);
        expect(first.reservation.refundedUnits).toBe(0);
        expect((await refundModelPricePoints(partial)).applied).toBe(false);
        await expect(refundModelPricePoints({ ...partial, usage: { input: "1", output: "0" } })).rejects.toThrow("重复退款");
        await expect(refundModelPricePoints({ ...partial, refundId: "excess", usage: { input: "1", output: "0" } })).rejects.toThrow("超过原结算");
        const rest = await refundModelPricePoints({ ...request, refundId: "remaining-audio", usage: { input: "0", output: "20" }, units: 1, evidence: "original output refund proof" });
        expect(rest.snapshot.totalPoints).toBe(25);
        expect(rest.reservation.refundedUsage).toEqual({ input: "10", output: "20" });
        expect((await state(request.requestId)).quota.every((item) => item.units === 0 && item.pointsSpent === 0)).toBe(true);
        expect((await state(request.requestId)).exact).toBe("0");
    });
    it("keeps submission identity and audio response facts immutable", async () => {
        const { request, claimId, record } = await submit();
        const observation = inspectAudioUsage("gemini-tts", response());
        const outcome = { ...request, claimId, kind: "response" as const, observation, responseComplete: true as const };
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, claimId: "another" })).rejects.toThrow("预留");
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: inspectProviderTokenUsage("gemini-generate", {}) })).rejects.toThrow("能力不匹配");
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: inspectAudioUsage("openai-chat-audio", {}) })).rejects.toThrow("能力不匹配");
        await expect(settleModelPricePoints({ ...request, observation, responseComplete: true })).rejects.toThrow("已保存的完整响应");
        await record();
        for (const patch of [{ reportedModel: "another" }, { serviceTier: "priority" }, { hasAudio: false }, { quantities: { ...observation.quantities, outputAudioTokens: "21" } }])
            await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: { ...observation, ...patch } })).rejects.toThrow("不能改写");
        expect((await state(request.requestId)).records).toHaveLength(0);
    });
    it("keeps unknown submissions held without another permission or guessed refund", async () => {
        const { request, claimId, record } = await submit();
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "transport_error" });
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        for (const reason of ["not-submitted", "confirmed-no-charge"] as const) await expect(releaseModelPricePoints({ ...request, reason, evidence: "timeout" })).rejects.toThrow("已认领提交");
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("完整响应");
        await record();
        expect((await settleModelPricePoints({ ...request, resume: true })).reservation.settlement?.chargedPoints).toBe("0.29");
    });
    it.each(["missing", "excess", "model", "tier", "no-audio", "contradictory", "extra-modality"])("retains %s audio evidence without settling or releasing", async (mode) => {
        const { request, claimId, record } = await submit();
        const payload = response();
        if (mode === "missing") payload.usageMetadata.candidatesTokensDetails = [];
        if (mode === "excess") Object.assign(payload.usageMetadata, response(models[0], 10, 101).usageMetadata);
        if (mode === "model") payload.modelVersion = "alias";
        if (mode === "tier") Object.assign(payload.usageMetadata, { serviceTier: "priority" });
        if (mode === "no-audio") payload.candidates = [];
        if (mode === "contradictory") payload.usageMetadata.totalTokenCount = 99;
        if (mode === "extra-modality") payload.usageMetadata.promptTokensDetails = [{ modality: "AUDIO", tokenCount: 10 }];
        await record(payload);
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow();
        const saved = await state(request.requestId);
        expect(saved.reservation?.status).toBe("reserved");
        expect(saved.records).toHaveLength(0);
        expect(saved.reservation?.submission?.response?.observation).toEqual(inspectAudioUsage("gemini-tts", payload));
        await expect(reviewModelPriceSubmission({ ...request, review: { id: "unsafe-review", claimId, reviewedBy: "admin", reviewedAt: now.toISOString(), evidence: "not a task review", outcome: { kind: "not_charged" } } })).rejects.toThrow(
            "专用任务凭据",
        );
    });
    it("refuses free, missing and changed pricing requests before deduction", async () => {
        for (const mode of ["free", "missing", "extra", "tools", "protocol"] as const) {
            const request = audioInput();
            if (mode === "free") request.version.items[0].price = "0";
            if (mode === "missing") request.version.items.pop();
            if (mode === "extra") request.version.items.push({ ...request.version.items[0], key: "cache" });
            if (mode === "tools") request.audioRequest.payload = { ...(request.audioRequest.payload as object), tools: [{}] };
            if (mode === "protocol") request.audioRequest.declaredProtocol = "openai";
            await expect(reserveModelPricePoints(request)).rejects.toThrow();
            expect((await state(request.requestId)).reservation).toBeUndefined();
        }
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(25);
        const request = audioInput();
        await reserveModelPricePoints(request);
        for (const patch of [{ channelId: "other" }, { requestedModel: "other" }, { declaredProtocol: "dataeyes-gemini" }, { payload: {} }])
            await expect(reserveModelPricePoints({ ...request, audioRequest: { ...request.audioRequest, ...patch } })).rejects.toThrow("音频请求已变化");
        expect((await releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "cancelled before claim" })).snapshot.totalPoints).toBe(25);
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        const submitted = await submit();
        const evidence = "supplier confirmed original audio request was not charged";
        await recordModelPriceSubmissionOutcome({ ...submitted.request, claimId: submitted.claimId, kind: "not_charged", evidence });
        expect((await releaseModelPricePoints({ ...submitted.request, reason: "confirmed-no-charge", evidence })).snapshot.totalPoints).toBe(25);
    });
    it("rolls back receipt and settlement failures and preserves daily and permanent sources across midnight", async () => {
        const { request, record } = await submit();
        const failWrite = () => (provider === "postgres" ? vi.spyOn(ModelPricingWalletRepository.prototype, "save") : vi.spyOn(dataAdapter, "writeJsonDataFile"));
        let failure = failWrite().mockRejectedValueOnce(new Error("fixture write failure"));
        await expect(record()).rejects.toThrow("fixture write failure");
        failure.mockRestore();
        expect((await getModelPriceReservation(request))?.submission?.response).toBeUndefined();
        await record();
        failure = failWrite().mockRejectedValueOnce(new Error("fixture write failure"));
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("fixture write failure");
        failure.mockRestore();
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(17.86);
        await consumePoints({ userId, usageKind: "text", model: "fixed-text", units: 1, amount: 0.25, idempotencyKey: randomUUID(), description: "concurrent fixed request", now });
        const nextDay = new Date("2026-10-03T08:00:00+08:00");
        const settled = await settleModelPricePoints({ ...request, now: nextDay, resume: true });
        expect(settled.reservation.settlement).toMatchObject({ chargedPoints: "0.29", release: { dailyRestored: "0.00", dailyExpired: "4.71", permanentRestored: "2.14" } });
        expect(settled.snapshot.totalPoints).toBe(24.75);
    });
    it("accumulates concurrent sub-cent audio charges and original refunds exactly", async () => {
        await consumePoints({ userId, usageKind: "text", model: "fixed-text", units: 1, amount: 5, idempotencyKey: randomUUID(), description: "use daily grant before permanent holds", now });
        const tasks = [await submit(), await submit()];
        await Promise.all(tasks.map((task) => task.record(response(models[0], 4, 0))));
        const results = await Promise.all(tasks.map(({ request }) => settleModelPricePoints({ ...request, resume: true })));
        expect(results.map((item) => item.reservation.settlement!.chargedPoints).sort()).toEqual(["0.00", "0.01"]);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(19.99);
        expect((await state(tasks[0].request.requestId)).exact).toBe("7/1250");
        for (const result of results) {
            const r = result.reservation;
            await refundModelPricePoints({ userId, requestId: r.requestId, requestFingerprint: r.requestFingerprint, refundId: "original-audio-refund", usage: r.settledUsage!, units: 1, evidence: "original audio unavailable", now });
        }
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(20);
        expect((await state(tasks[0].request.requestId)).exact).toBe("0");
    });
    it.each(["gemini", "dataeyes-gemini"] as const)("settles original %s TCP audio usage without issuing a second submission", async (protocol) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("fixture bind failed");
            const request = audioInput(models[1], protocol);
            if (request.audioRequest.contract.protocol !== "gemini-tts") throw new Error("expected Gemini contract");
            request.audioRequest.contract.modelIdentity = "reviewed-request";
            const { claimId } = await submit(request);
            const result = await fetch(`http://127.0.0.1:${address.port}/models/${request.audioRequest.requestedModel}:generateContent`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(protocol === "gemini" ? { "x-goog-api-key": "fixture-only" } : { Authorization: "Bearer fixture-only" }) },
                body: JSON.stringify(request.audioRequest.payload),
            });
            expect(result.ok).toBe(true);
            const payload = await result.json();
            expect(payload.candidates[0].content.parts[0].inlineData.data).toBeTruthy();
            await savePricedAudioResponse({ ...request, claimId, payload, responseComplete: true });
            const settled = (await recoverPricedAudioResponse({ ...request, claimId }))!;
            expect(settled.reservation.settlement).toMatchObject({ actualExactPoints: "217/1250", chargedPoints: "0.17" });
            const recoveredMedia = await geminiAudioResult({ candidates: [{ content: { parts: settled.receipt.audio.map((inlineData) => ({ inlineData })) } }] }, "wav");
            expect(recoveredMedia.bytes.subarray(0, 4).toString()).toBe("RIFF");
            await recoverPricedAudioResponse({ ...request, claimId });
            expect((await state(request.requestId)).records).toHaveLength(1);
            expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(1);
            expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    function rawResponse() {
        const payload = response();
        payload.candidates[0].content.parts[0].inlineData = { mimeType: "audio/L16; rate=24000; channels=1", data: Buffer.alloc(4800).toString("base64") };
        return payload;
    }
    it("durably preserves all original audio parts and recovers once at frozen prices", async () => {
        const { request, claimId } = await submit();
        const payload = rawResponse();
        payload.candidates.push({ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from("RIFF-second-result").toString("base64") } }] } });
        Object.assign(payload, { prompt: "PRIVATE_PROMPT", apiKey: "PRIVATE_KEY", unexpected: "PRIVATE_TEXT" });
        const input = { ...request, claimId, payload, responseComplete: true as const };
        const writes = await Promise.all([savePricedAudioResponse(input), savePricedAudioResponse(input)]);
        expect(writes.filter((item) => item.applied)).toHaveLength(1);
        expect(writes[0].receipt.audio).toHaveLength(2);
        expect(JSON.stringify(writes[0].receipt)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_KEY|PRIVATE_TEXT/);
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await getModelPriceReservation(request))?.submission?.response).toBeUndefined();
        request.version.items[0].price = "99";
        request.policy.userPriceRules = [{ scope: "default", coefficient: "9" }];
        const results = await Promise.all([recoverPricedAudioResponse({ ...request, claimId }), recoverPricedAudioResponse({ ...request, claimId })]);
        expect(results.filter((item) => item?.applied)).toHaveLength(1);
        expect(results[0]?.reservation.settlement?.chargedPoints).toBe("0.29");
        expect((await state(request.requestId)).records).toHaveLength(1);
        expect((await savePricedAudioResponse(input)).applied).toBe(false);
        expect(JSON.stringify(await getPricingWalletView(userId, { now }))).not.toContain(payload.candidates[0].content.parts[0].inlineData.data);
    });
    it.skipIf(!process.env.FFMPEG_PATH)("recovers PCM conversion failure from private bytes without another charge", async () => {
        const { request, claimId } = await submit();
        await savePricedAudioResponse({ ...request, claimId, payload: rawResponse(), responseComplete: true });
        const first = (await recoverPricedAudioResponse({ ...request, claimId }))!;
        const payload = { candidates: [{ content: { parts: first.receipt.audio.map((inlineData) => ({ inlineData })) } }] };
        const failure = vi.spyOn(ffmpeg, "runFfmpeg").mockRejectedValueOnce(new Error("fixture conversion interrupted"));
        await expect(geminiAudioResult(payload, "wav")).rejects.toThrow("fixture conversion interrupted");
        failure.mockRestore();
        const recovered = (await recoverPricedAudioResponse({ ...request, claimId }))!;
        const converted = await geminiAudioResult({ candidates: [{ content: { parts: recovered.receipt.audio.map((inlineData) => ({ inlineData })) } }] }, "wav");
        expect(converted.bytes.subarray(0, 4).toString()).toBe("RIFF");
        expect(converted.mimeType).toBe("audio/wav");
        expect(recovered.receipt).toEqual(first.receipt);
        expect((await state(request.requestId)).records).toHaveLength(1);
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
    });
    it("rejects changed bytes, MIME, metering and identities while retaining the first response", async () => {
        const { request, claimId } = await submit();
        const input = { ...request, claimId, payload: rawResponse(), responseComplete: true as const };
        const first = await savePricedAudioResponse(input);
        for (const patch of ["data", "mime", "usage"] as const) {
            const changed = rawResponse();
            if (patch === "data") changed.candidates[0].content.parts[0].inlineData.data = Buffer.from("other").toString("base64");
            if (patch === "mime") changed.candidates[0].content.parts[0].inlineData.mimeType = "audio/wav";
            if (patch === "usage") changed.usageMetadata.totalTokenCount = 999;
            await expect(savePricedAudioResponse({ ...input, payload: changed })).rejects.toThrow("不能改写");
        }
        for (const patch of [{ claimId: "other" }, { requestFingerprint: "b".repeat(64) }, { requestId: "other" }]) {
            await expect(savePricedAudioResponse({ ...input, ...patch })).rejects.toThrow();
            await expect(recoverPricedAudioResponse({ ...input, ...patch })).rejects.toThrow();
        }
        expect(await readAudioPriceResponseReceipt("other-user", request.requestId)).toBeUndefined();
        expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toEqual(first.receipt);
        // Object order can change in JSONB; immutable meaning must not.
        const reordered = Object.fromEntries(Object.entries(input.payload).reverse());
        expect((await savePricedAudioResponse({ ...input, payload: reordered })).applied).toBe(false);
    });
    it.each(["empty", "malformed-base64", "missing-audio", "incomplete"])("does not create a receipt for %s results or unlock another submission", async (mode) => {
        const { request, claimId } = await submit();
        const payload = rawResponse();
        if (mode === "empty") payload.candidates[0].content.parts[0].inlineData.data = "";
        if (mode === "malformed-base64") payload.candidates[0].content.parts[0].inlineData.data = "AA$A=";
        if (mode === "missing-audio") payload.candidates = [];
        await expect(savePricedAudioResponse({ ...request, claimId, payload, responseComplete: (mode !== "incomplete") as true })).rejects.toThrow();
        expect(await recoverPricedAudioResponse({ ...request, claimId })).toBeUndefined();
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
    });
    it("keeps original bytes and held funds when complete metering cannot be priced", async () => {
        const { request, claimId } = await submit();
        const payload = rawResponse();
        payload.usageMetadata.candidatesTokensDetails = [];
        const first = await savePricedAudioResponse({ ...request, claimId, payload, responseComplete: true });
        await expect(recoverPricedAudioResponse({ ...request, claimId })).rejects.toThrow();
        expect((await state(request.requestId)).reservation?.status).toBe("reserved");
        expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toEqual(first.receipt);
        await expect(recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "not_charged", evidence: "cannot infer free from missing meters" })).rejects.toThrow();
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "timeout" })).rejects.toThrow();
    });
    it("serializes raw receipt and no-charge decisions under the same wallet lock", async () => {
        const { request, claimId } = await submit();
        const outcomes = await Promise.allSettled([
            savePricedAudioResponse({ ...request, claimId, payload: rawResponse(), responseComplete: true }),
            recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "not_charged", evidence: "explicit upstream no-charge proof" }),
        ]);
        expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        const raw = await readAudioPriceResponseReceipt(userId, request.requestId);
        expect((await getModelPriceReservation(request))?.submission?.phase === "not_charged").toBe(!raw);
    });
    it("retains the submission claim on raw persistence failure and retries only local storage", async () => {
        const { request, claimId } = await submit();
        const input = { ...request, claimId, payload: rawResponse(), responseComplete: true as const };
        const failure =
            provider === "postgres"
                ? vi.spyOn(ModelPricingAudioResponseRepository.prototype, "insert").mockRejectedValueOnce(new Error("raw write interrupted"))
                : vi.spyOn(dataAdapter, "writeJsonDataFile").mockRejectedValueOnce(new Error("raw write interrupted"));
        await expect(savePricedAudioResponse(input)).rejects.toThrow("raw write interrupted");
        failure.mockRestore();
        expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toBeUndefined();
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        expect((await state(request.requestId)).records).toHaveLength(0);
        await savePricedAudioResponse(input);
        expect((await recoverPricedAudioResponse(input))?.reservation.status).toBe("settled");
    });
    it("recovers metadata and settlement write interruptions solely from the saved raw receipt", async () => {
        const { request, claimId } = await submit();
        const input = { ...request, claimId };
        await savePricedAudioResponse({ ...input, payload: rawResponse(), responseComplete: true });
        const failWrite = () => (provider === "postgres" ? vi.spyOn(ModelPricingWalletRepository.prototype, "save") : vi.spyOn(dataAdapter, "writeJsonDataFile"));
        let failure = failWrite().mockRejectedValueOnce(new Error("metadata interrupted"));
        await expect(recoverPricedAudioResponse(input)).rejects.toThrow("metadata interrupted");
        failure.mockRestore();
        const raw = (await readAudioPriceResponseReceipt(userId, request.requestId))!;
        await recordModelPriceSubmissionOutcome({ ...input, kind: "response", observation: raw.observation, responseComplete: true });
        if (provider === "postgres") failure = failWrite().mockRejectedValueOnce(new Error("settlement interrupted"));
        else {
            const write = dataAdapter.writeJsonDataFile;
            let count = 0;
            failure = vi.spyOn(dataAdapter, "writeJsonDataFile").mockImplementation(async (...args) => {
                if (++count === 2) throw new Error("settlement interrupted");
                return write(...args);
            });
        }
        await expect(recoverPricedAudioResponse(input)).rejects.toThrow("settlement interrupted");
        failure.mockRestore();
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await getModelPriceReservation(request))?.status).toBe("reserved");
        expect((await recoverPricedAudioResponse(input))?.reservation.settlement?.chargedPoints).toBe("0.29");
    });
    it("detects stored raw corruption before any metering settlement", async () => {
        const { request, claimId } = await submit();
        const { receipt } = await savePricedAudioResponse({ ...request, claimId, payload: rawResponse(), responseComplete: true });
        receipt.audio[0].data = Buffer.from("corruption").toString("base64");
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_audio_responses SET data = $3::jsonb WHERE user_id = $1 AND request_id = $2", [userId, request.requestId, JSON.stringify(receipt)]);
        else {
            const [owner] = await readdir(join(directory, "pricing-audio-responses"));
            const [name] = await readdir(join(directory, "pricing-audio-responses", owner));
            await dataAdapter.writeJsonDataFile(`pricing-audio-responses/${owner}/${name}`, receipt);
        }
        await expect(recoverPricedAudioResponse({ ...request, claimId })).rejects.toThrow("内容校验失败");
        expect((await state(request.requestId)).records).toHaveLength(0);
    });
    it("preserves safe recovery when the outer transaction fails after the raw write", async () => {
        const { request, claimId } = await submit();
        const input = { ...request, claimId, payload: rawResponse(), responseComplete: true as const };
        if (provider === "postgres") {
            const insert = ModelPricingAudioResponseRepository.prototype.insert;
            const failure = vi.spyOn(ModelPricingAudioResponseRepository.prototype, "insert").mockImplementationOnce(async function (this: ModelPricingAudioResponseRepository, receipt) {
                await insert.call(this, receipt);
                throw new Error("outer transaction interrupted");
            });
            await expect(savePricedAudioResponse(input)).rejects.toThrow("outer transaction interrupted");
            failure.mockRestore();
            expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toBeUndefined();
            await savePricedAudioResponse(input);
        } else {
            const write = dataAdapter.writeJsonDataFile;
            const failure = vi.spyOn(dataAdapter, "writeJsonDataFile").mockImplementation(async (name, value) => {
                if (name === "auth.json") throw new Error("outer transaction interrupted");
                await write(name, value);
            });
            await expect(savePricedAudioResponse(input)).rejects.toThrow("outer transaction interrupted");
            failure.mockRestore();
            expect(await readAudioPriceResponseReceipt(userId, request.requestId)).toBeDefined();
            expect((await savePricedAudioResponse(input)).applied).toBe(false);
        }
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await recoverPricedAudioResponse(input))?.reservation.status).toBe("settled");
    });
});
