import Fraction from "fraction.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as dataAdapter from "./data-adapter";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
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
    acknowledgeModelPriceVideoSubmission,
    getModelPriceReservation,
    reviewModelPriceSubmission,
} from "./model-pricing-wallet-service";
import type { VideoWalletRequest } from "./model-pricing-video-wallet-request";
import { inspectMinimaxVideoUsage } from "./model-pricing-video-usage";
import { quoteVideoFacts } from "./model-pricing-video-facts";
import { HAILUO_PRICE_MODELS, HAILUO_PRICE_TIERS, inspectHailuoObservation } from "./model-pricing-hailuo-contract";
import type { MinimaxVideoModel } from "./model-pricing-video-request";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { inspectProviderTokenUsage } from "./model-pricing-token-usage";
import { consumePoints, getPointsWalletSnapshot } from "./points-wallet-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const now = new Date("2026-10-02T08:00:00+08:00");
describe.each(providers)("async video wallet transactions (%s)", (provider) => {
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

    function videoInput(model: MinimaxVideoModel = "MiniMax-H3", resolution = "768P") {
        const base = input();
        const resolutions = model === "MiniMax-H3" ? ["768P", "2K"] : ["480P", "768P"];
        const version = {
            ...base.version,
            manufacturer: "MiniMax",
            series: "H3",
            sku: model,
            items: [
                ...resolutions.flatMap((r) => ["input", "output"].map((k) => ({ key: `${r}-${k}`, unit: "second", per: "1", price: k === "input" ? "0.001" : "0.002", currency: "CNY" }))),
                { key: "images", unit: "image", per: "1", price: "0.003", currency: "CNY" },
                { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "CNY" },
            ],
        };
        const videoRequest: VideoWalletRequest = {
            channelId: "video-channel",
            requestedModel: model,
            declaredProtocol: "minimax",
            payload: {
                model,
                resolution,
                duration: 5,
                ratio: "16:9",
                content: [{ type: "text", text: "PRIVATE_PROMPT" }, ...["image", "image", "video"].map((type) => ({ type: `${type}_url`, [`${type}_url`]: { url: `https://example.com/PRIVATE_REFERENCE_${type}` }, role: `reference_${type}` }))],
            },
            contract: {
                id: "video-contract",
                officialVersionId: version.id,
                channelId: "video-channel",
                requestedModel: model,
                protocol: "minimax-video-v2",
                scope: "global-standard-minimax-h3-generation",
                resolutionItems: Object.fromEntries(resolutions.map((r) => [r, { inputSeconds: `${r}-input`, outputSeconds: `${r}-output` }])),
                inputImageItem: "images",
                inputImagePricing: "all-at-standard-rate",
                inputAudioItem: "inputAudioSeconds",
                evidence: "Synthetic normal rates, not official publication",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
        };
        return { userId, requestId: base.requestId, requestFingerprint: base.requestFingerprint, modelId: base.modelId, usageKind: "video" as const, units: 1, version, policy: base.policy, now, videoRequest };
    }
    const response = (model = "MiniMax-H3", resolution = "768P", id = "original") => ({
        task: {
            id,
            model,
            resolution,
            status: "succeeded",
            task_type: "generation",
            modality: "video",
            content: { url: "https://example.com/PRIVATE_RESULT.mp4" },
            usage: { total_seconds: 6.5, input_seconds: 1.25, output_seconds: 5.25, input_image_count: 2, input_audio_seconds: 0 },
        },
    });
    async function submit(request = videoInput()) {
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } });
        const record = (payload = response()) => recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectMinimaxVideoUsage(payload, "original", request.videoRequest.requestedModel), responseComplete: true });
        return { request, claimId, record };
    }
    it.each([
        ["MiniMax-H3", "768P"],
        ["MiniMax-H3", "2K"],
        ["MiniMax-H3-Max", "480P"],
        ["MiniMax-H3-Max", "768P"],
    ] as const)("reserves %s %s from real quantities and freezes normal customer rates", async (model, resolution) => {
        const request = videoInput(model, resolution);
        const holds = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
        expect(holds.filter((item) => item.applied)).toHaveLength(1);
        expect(holds[0].reservation.allocation).toMatchObject({ heldPoints: "5.10", dailyHeld: "5.00", permanentHeld: "0.10" });
        expect(holds[0].reservation.frozen.maximumUsage).toMatchObject({ [`${resolution}-input`]: "15", [`${resolution}-output`]: "15", images: "2" });
        const claims = await Promise.all([claimModelPriceSubmission(request), claimModelPriceSubmission(request)]);
        expect(claims.filter((item) => item.claimed)).toHaveLength(1);
        const claimId = claims[0].reservation.submission!.id;
        const acks = await Promise.all([acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } }), acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } })]);
        expect(acks.filter((item) => item.applied)).toHaveLength(1);
        expect(acks[0].reservation.submission).toMatchObject({ phase: "submitted", upstreamTaskId: "original" });
        const view = await getPricingWalletView(userId, { now });
        expect(view.items[0]).toMatchObject({ stage: "submitted", status: "reserved" });
        expect(JSON.stringify(view)).not.toMatch(/upstreamTaskId|video-contract|PRIVATE_/);
        request.version.items[0].price = "99";
        request.policy.conversion!.cnyPerUsd = "9";
        request.policy.userPriceRules = [{ scope: "default", coefficient: "9" }];
        expect((await reserveModelPricePoints(request)).reservation.allocation.heldPoints).toBe("5.10");
        const observation = inspectMinimaxVideoUsage(response(model, resolution), "original", model);
        const outcome = { ...request, claimId, kind: "response" as const, observation, responseComplete: true as const };
        await Promise.all([recordModelPriceSubmissionOutcome(outcome), recordModelPriceSubmissionOutcome(outcome)]);
        const settled = await Promise.all([settleModelPricePoints({ ...request, resume: true }), settleModelPricePoints({ ...request, resume: true })]);
        expect(settled.filter((item) => item.applied)).toHaveLength(1);
        expect(settled[0].reservation.settlement).toMatchObject({ actualExactPoints: "71/40", chargedPoints: "1.78" });
        expect(settled[0].reservation.settledUsage).toMatchObject({ images: "2", [`${resolution}-input`]: "1.25", [`${resolution}-output`]: "5.25" });
        expect(settled[0].reservation.settledVideoUsageFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "inputSeconds", value: "1.25", status: "reported", sourcePaths: ["task.usage.input_seconds"] }),
                expect.objectContaining({ meter: "outputSeconds", value: "5.25", status: "reported", sourcePaths: ["task.usage.output_seconds"] }),
                expect.objectContaining({ meter: "inputImageCount", value: "2", status: "reported", sourcePaths: ["task.usage.input_image_count"] }),
                expect.objectContaining({ meter: "item:inputAudioSeconds", value: "0", status: "derived", relation: { kind: "derived-from", inputFactIds: [expect.any(String)] } }),
            ]),
        );
        expect(settled[0].reservation.settledVideoQuote).toMatchObject({ purpose: "settlement", contractId: "video-contract", attemptId: claimId, exactPoints: "71/40" });
        expect(settled[0].reservation.settledVideoQuote?.lines.every((line) => line.consumedFactIds.length === 1)).toBe(true);
        const frozen = settled[0].reservation.frozen;
        const quoteFacts = (facts: NonNullable<(typeof settled)[0]["reservation"]["settledVideoUsageFacts"]>) =>
            quoteVideoFacts({ version: frozen.version, policy: frozen.policy, modelId: request.modelId, contract: frozen.video!.contract, bound: frozen.video!.bound, facts: facts! });
        expect(() => quoteFacts(settled[0].reservation.settledVideoUsageFacts!.map((fact) => (fact.meter === "item:inputAudioSeconds" ? { ...fact, value: "1" } : fact)))).toThrow("零量");
        expect(() => quoteFacts([...settled[0].reservation.settledVideoUsageFacts!, settled[0].reservation.settledVideoUsageFacts![0]])).toThrow("重复");
        expect(settled[0].snapshot.totalPoints).toBe(23.22);
        expect(JSON.stringify(await getModelPriceReservation(request))).not.toMatch(/PRIVATE_/);
        const refund = { ...request, refundId: "cancel-original", usage: settled[0].reservation.settledUsage!, units: 1, evidence: "original paid media was cancelled" };
        const refunded = await Promise.all([refundModelPricePoints(refund), refundModelPricePoints(refund)]);
        expect(refunded.filter((item) => item.applied)).toHaveLength(1);
        expect(refunded[0].snapshot.totalPoints).toBe(25);
        expect((await state(request.requestId)).exact).toBe("0");
        expect((await state(request.requestId)).records).toHaveLength(2);
    });
    it("never invents an upstream identity or accepts another call, model, protocol or running response", async () => {
        const request = videoInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const observation = inspectMinimaxVideoUsage(response(), "original", "MiniMax-H3");
        const outcome = { ...request, claimId, kind: "response" as const, observation, responseComplete: true as const };
        await expect(recordModelPriceSubmissionOutcome(outcome)).rejects.toThrow("原任务");
        for (const payload of [{}, { task_id: " " }, { task_id: "original", error: "failed" }]) await expect(acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload })).rejects.toThrow("原上游任务");
        await expect(acknowledgeModelPriceVideoSubmission({ ...request, claimId: "other", payload: { task_id: "original" } })).rejects.toThrow("原提交");
        await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } });
        await expect(acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "different" } })).rejects.toThrow("不能改写");
        for (const patch of [{ upstreamTaskId: "other" }, { reportedModel: "other" }, { status: "running" }]) await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: { ...observation, ...patch } })).rejects.toThrow("原任务");
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: inspectProviderTokenUsage("openai-chat", {}) })).rejects.toThrow("能力不匹配");
        await recordModelPriceSubmissionOutcome(outcome);
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: { ...observation, quantities: { ...observation.quantities, outputSeconds: "10" } } })).rejects.toThrow("不能改写");
        expect((await state(request.requestId)).records).toHaveLength(0);
    });
    it.each(["before", "after"])("keeps unknown outcomes held %s acknowledgement and resumes without permission to submit again", async (order) => {
        const request = videoInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const acknowledge = () => acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } });
        if (order === "after") await acknowledge();
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "transport_error" });
        if (order === "before") await acknowledge();
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "user cancelled or timed out" })).rejects.toThrow("已认领提交");
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "unverified timeout" })).rejects.toThrow("已认领提交");
        await expect(settleModelPricePoints({ ...request, usage: { images: "0" } })).rejects.toThrow("已保存的完整响应");
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectMinimaxVideoUsage(response(), "original", "MiniMax-H3"), responseComplete: true });
        expect((await settleModelPricePoints({ ...request, resume: true })).reservation.settlement?.chargedPoints).toBe("1.78");
    });
    it.each(["failed", "cancelled", "missing", "excess", "audio"])("retains %s evidence without charging, releasing or discarding the hold", async (mode) => {
        const { request, record } = await submit();
        const payload = response();
        if (mode === "failed" || mode === "cancelled") payload.task.status = mode;
        if (mode === "missing") delete (payload.task.usage as Partial<typeof payload.task.usage>).input_seconds;
        if (mode === "excess") payload.task.usage.output_seconds = 16;
        if (mode === "audio") payload.task.usage.input_audio_seconds = 1;
        await record(payload);
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow();
        const saved = await state(request.requestId);
        expect(saved.reservation?.status).toBe("reserved");
        expect(saved.records).toHaveLength(0);
        expect(saved.reservation?.submission?.response?.observation).toEqual(inspectMinimaxVideoUsage(payload, "original", "MiniMax-H3"));
        await expect(
            reviewModelPriceSubmission({ ...request, review: { id: "unsafe-review", claimId: saved.reservation!.submission!.id, reviewedBy: "admin", reviewedAt: now.toISOString(), evidence: "not a task review", outcome: { kind: "not_charged" } } }),
        ).rejects.toThrow("专用任务凭据");
    });
    it("settles standing-free audio at zero and rejects changed requests", async () => {
        const request = videoInput();
        const payload = request.videoRequest.payload as { content: unknown[] };
        payload.content.push({ type: "audio_url", audio_url: { url: "https://example.com/audio" }, role: "reference_audio" });
        const held = await reserveModelPricePoints(request);
        expect(held.reservation.frozen.maximumUsage).toMatchObject({ inputAudioSeconds: "0", images: "2" });
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } });
        const original = response();
        original.task.usage.input_audio_seconds = 3.5;
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectMinimaxVideoUsage(original, "original", "MiniMax-H3"), responseComplete: true });
        const settled = await settleModelPricePoints({ ...request, resume: true });
        expect(settled.reservation.settlement?.chargedPoints).toBe("1.78");
        expect(settled.reservation.settledUsage).toMatchObject({ inputAudioSeconds: "0", images: "2" });
        expect(settled.reservation.submission?.response?.observation).toMatchObject({ quantities: { inputAudioSeconds: "3.5" } });
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(23.22);
        await refundModelPricePoints({ ...request, refundId: "audio-video-refund", usage: settled.reservation.settledUsage!, units: 1, evidence: "original video refunded" });
        const valid = videoInput();
        await reserveModelPricePoints(valid);
        for (const patch of [{ channelId: "other" }, { requestedModel: "other" }, { declaredProtocol: "custom" }, { payload: {} }])
            await expect(reserveModelPricePoints({ ...valid, videoRequest: { ...valid.videoRequest, ...patch } })).rejects.toThrow("视频请求已变化");
        expect((await releaseModelPricePoints({ ...valid, reason: "not-submitted", evidence: "cancelled before claim" })).snapshot.totalPoints).toBe(25);
        expect((await claimModelPriceSubmission(valid)).claimed).toBe(false);
        const submitted = await submit();
        const evidence = "supplier confirmed this original request was not charged";
        await recordModelPriceSubmissionOutcome({ ...submitted.request, claimId: submitted.claimId, kind: "not_charged", evidence });
        expect((await releaseModelPricePoints({ ...submitted.request, reason: "confirmed-no-charge", evidence })).snapshot.totalPoints).toBe(25);
    });
    it("rolls back failed creation acknowledgement and settlement writes and preserves exact cross-day sources", async () => {
        const request = videoInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const failWrite = () => (provider === "postgres" ? vi.spyOn(ModelPricingWalletRepository.prototype, "save") : vi.spyOn(dataAdapter, "writeJsonDataFile"));
        let failure = failWrite().mockRejectedValueOnce(new Error("fixture write failure"));
        await expect(acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } })).rejects.toThrow("fixture write failure");
        failure.mockRestore();
        expect((await getModelPriceReservation(request))?.submission?.upstreamTaskId).toBeUndefined();
        await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "original" } });
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectMinimaxVideoUsage(response(), "original", "MiniMax-H3"), responseComplete: true });
        failure = failWrite().mockRejectedValueOnce(new Error("fixture write failure"));
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("fixture write failure");
        failure.mockRestore();
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(19.9);
        await consumePoints({ userId, usageKind: "text", model: "fixed-text", units: 1, amount: 0.25, idempotencyKey: randomUUID(), description: "concurrent fixed request", now });
        const nextDay = new Date("2026-10-03T08:00:00+08:00");
        const settled = await settleModelPricePoints({ ...request, now: nextDay, resume: true });
        expect(settled.reservation.settlement).toMatchObject({ chargedPoints: "1.78", release: { dailyRestored: "0.00", dailyExpired: "3.22", permanentRestored: "0.10" } });
        expect(settled.snapshot.totalPoints).toBe(24.75);
    });
    it("accumulates concurrent sub-cent video charges and refunds from the original funding source", async () => {
        await consumePoints({ userId, usageKind: "text", model: "fixed-text", units: 1, amount: 5, idempotencyKey: randomUUID(), description: "use daily grant before concurrent permanent video holds", now });
        const tasks = [await submit(), await submit()];
        const payload = response();
        payload.task.usage = { total_seconds: 0.02, input_seconds: 0, output_seconds: 0.02, input_image_count: 0, input_audio_seconds: 0 };
        await Promise.all(tasks.map((task) => task.record(payload)));
        const results = await Promise.all(tasks.map(({ request }) => settleModelPricePoints({ ...request, resume: true })));
        expect(results.map((item) => item.reservation.settlement!.chargedPoints).sort()).toEqual(["0.00", "0.01"]);
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(19.99);
        expect((await state(tasks[0].request.requestId)).exact).toBe("1/125");
        for (const result of results) {
            const reservation = result.reservation;
            await refundModelPricePoints({
                userId,
                requestId: reservation.requestId,
                requestFingerprint: reservation.requestFingerprint,
                refundId: "original-media-refund",
                usage: reservation.settledUsage!,
                units: 1,
                evidence: "original media unavailable",
                now,
            });
        }
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(20);
        expect((await state(tasks[0].request.requestId)).exact).toBe("0");
    });
    it("uses a real local create acknowledgement and terminal query to settle only the original wallet call", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("fixture bind failed");
            const origin = `http://127.0.0.1:${address.port}`;
            const request = videoInput();
            await reserveModelPricePoints(request);
            const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
            const created = await fetch(`${origin}/v2/video_generation`, { method: "POST", headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" }, body: JSON.stringify(request.videoRequest.payload) }).then((r) => r.json());
            await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: created });
            Object.assign(fixture.tasks.get(created.task_id)!, { usage: response().task.usage });
            const payload = await fetch(`${origin}/v2/query/video_generation/${created.task_id}`).then((r) => r.json());
            await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectMinimaxVideoUsage(payload, created.task_id, "MiniMax-H3"), responseComplete: true });
            await settleModelPricePoints({ ...request, resume: true });
            expect((await state(request.requestId)).records).toHaveLength(1);
            expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(1);
            expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
    function hailuoInput(model: (typeof HAILUO_PRICE_MODELS)[number] = "MiniMax-Hailuo-2.3", tier: (typeof HAILUO_PRICE_TIERS)[number] = "768P-6") {
        const base = input();
        const version = { ...base.version, manufacturer: "MiniMax", series: "Hailuo", sku: model, items: HAILUO_PRICE_TIERS.map((key, i) => ({ key, unit: "video", per: "1", price: ["0.01055", "0.02055", "0.06055"][i], currency: "CNY" })) };
        const [resolution, duration] = tier.split("-");
        const videoRequest: VideoWalletRequest = {
            channelId: "hailuo-channel",
            requestedModel: model,
            declaredProtocol: "minimax",
            payload: { model, prompt: "PRIVATE_PROMPT", resolution, duration: Number(duration), ...(model.endsWith("Fast") ? { first_frame_image: "https://example.com/PRIVATE_IMAGE" } : {}) },
            contract: {
                id: "hailuo-contract",
                officialVersionId: version.id,
                channelId: "hailuo-channel",
                requestedModel: model,
                protocol: "minimax-hailuo-v1",
                scope: "global-standard-minimax-hailuo-generation",
                tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
                evidence: "Synthetic normal tariffs, not official publication",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
        };
        return { userId, requestId: base.requestId, requestFingerprint: base.requestFingerprint, modelId: base.modelId, usageKind: "video" as const, units: 1, version, policy: base.policy, now, videoRequest };
    }
    const hailuoResponse = () => ({ task_id: "hailuo-original", status: "Success", file_id: "original-file", video_width: 1280, video_height: 720, base_resp: { status_code: 0 } });
    async function submitHailuo(request = hailuoInput()) {
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "hailuo-original", base_resp: { status_code: 0 } } });
        const record = (payload: unknown = hailuoResponse()) => recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectHailuoObservation(payload, "hailuo-original"), responseComplete: true });
        return { request, claimId, record };
    }
    it.each(HAILUO_PRICE_MODELS.flatMap((model) => HAILUO_PRICE_TIERS.map((tier) => [model, tier] as const)))("Hailuo %s %s freezes one video and settles/refunds exactly once", async (model, tier) => {
        const request = hailuoInput(model, tier);
        const holds = await Promise.all([reserveModelPricePoints(request), reserveModelPricePoints(request)]);
        expect(holds.filter((item) => item.applied)).toHaveLength(1);
        const held = holds[0].reservation;
        const expected = new Fraction(request.version.items.find((item) => item.key === tier)!.price).mul(100);
        expect(held.allocation.heldPoints).toBe(expected.ceil(2).toString(2));
        expect(held.frozen.video?.bound).toMatchObject({ protocol: "minimax-hailuo-v1", tier, maximumVideos: "1" });
        expect(held.frozen.maximumUsage).toEqual(Object.fromEntries(HAILUO_PRICE_TIERS.map((key) => [key, key === tier ? "1" : "0"])));
        const claims = await Promise.all([claimModelPriceSubmission(request), claimModelPriceSubmission(request)]);
        expect(claims.filter((item) => item.claimed)).toHaveLength(1);
        const claimId = claims[0].reservation.submission!.id;
        const acknowledge = { ...request, claimId, payload: { task_id: "hailuo-original", base_resp: { status_code: 0 } } };
        expect((await Promise.all([acknowledgeModelPriceVideoSubmission(acknowledge), acknowledgeModelPriceVideoSubmission(acknowledge)])).filter((item) => item.applied)).toHaveLength(1);
        request.version.items.forEach((item) => {
            item.price = "99";
        });
        request.policy.userPriceRules = [{ scope: "default", coefficient: "9" }];
        expect((await reserveModelPricePoints(request)).reservation.allocation).toEqual(held.allocation);
        const outcome = { ...request, claimId, kind: "response" as const, observation: inspectHailuoObservation(hailuoResponse(), "hailuo-original"), responseComplete: true as const };
        await Promise.all([recordModelPriceSubmissionOutcome(outcome), recordModelPriceSubmissionOutcome(outcome)]);
        const results = await Promise.all([settleModelPricePoints({ ...request, resume: true }), settleModelPricePoints({ ...request, resume: true })]);
        expect(results.filter((item) => item.applied)).toHaveLength(1);
        const settled = results[0].reservation;
        expect(settled.settlement?.actualExactPoints).toBe(expected.toFraction());
        expect(settled.settledUsage).toEqual(held.frozen.maximumUsage);
        expect(settled.settledVideoUsageFacts).toEqual(
            expect.arrayContaining([expect.objectContaining({ meter: `item:${tier}`, value: "1", unit: "video", status: "derived", sourcePaths: expect.arrayContaining(["file_id", "base_resp.status_code", "bound.tier"]) })]),
        );
        expect(settled.settledVideoQuote).toMatchObject({ purpose: "settlement", contractId: "hailuo-contract", attemptId: claimId, exactPoints: expected.toFraction() });
        expect(settled.settledVideoQuote?.lines.every((line) => line.consumedFactIds.length === 1)).toBe(true);
        expect(() =>
            quoteVideoFacts({
                version: settled.frozen.version,
                policy: settled.frozen.policy,
                modelId: request.modelId,
                contract: settled.frozen.video!.contract,
                bound: settled.frozen.video!.bound,
                facts: settled.settledVideoUsageFacts!.map((fact) => (fact.meter === `item:${tier}` ? { ...fact, value: "0" } : fact)),
            }),
        ).toThrow("冻结档位");
        expect((await state(request.requestId)).records).toHaveLength(1);
        expect(JSON.stringify(await getPricingWalletView(userId, { now }))).not.toMatch(/original-file|hailuo-original|hailuo-contract|PRIVATE_|consumedFactIds|sourcePaths/);
        const refund = { ...request, refundId: "original-video-refund", usage: settled.settledUsage!, units: 1, evidence: "original video unavailable" };
        for (const patch of [{ units: 0 }, { usage: { ...refund.usage, [tier]: "0.5" } }, { usage: { ...refund.usage, "768P-10": tier === "768P-10" ? "0" : "1" } }])
            await expect(refundModelPricePoints({ ...refund, ...patch })).rejects.toThrow("完整视频");
        const refunded = await Promise.all([refundModelPricePoints(refund), refundModelPricePoints(refund)]);
        expect(refunded.filter((item) => item.applied)).toHaveLength(1);
        expect(refunded[0].snapshot.totalPoints).toBe(25);
        expect((await state(request.requestId)).exact).toBe("0");
        await expect(refundModelPricePoints({ ...refund, refundId: "duplicate-video" })).rejects.toThrow("超过原调用");
    });
    it("Hailuo binds only a business-success acknowledgement and the original V1 terminal response", async () => {
        const request = hailuoInput();
        await reserveModelPricePoints(request);
        const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
        const outcome = { ...request, claimId, kind: "response" as const, observation: inspectHailuoObservation(hailuoResponse(), "hailuo-original"), responseComplete: true as const };
        await expect(recordModelPriceSubmissionOutcome(outcome)).rejects.toThrow("原任务");
        for (const base_resp of [undefined, { status_code: 1 }]) await expect(acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "hailuo-original", base_resp } })).rejects.toThrow("业务成功");
        await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: { task_id: "hailuo-original", base_resp: { status_code: 0 } } });
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: inspectMinimaxVideoUsage(response(), "original", "MiniMax-H3") })).rejects.toThrow("能力不匹配");
        for (const patch of [{ upstreamTaskId: "different" }, { status: "Processing" }]) await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: { ...outcome.observation, ...patch } })).rejects.toThrow("原任务");
        await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "unknown", reason: "transport_error" });
        expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        await expect(releaseModelPricePoints({ ...request, reason: "not-submitted", evidence: "timeout" })).rejects.toThrow("已认领提交");
        await expect(settleModelPricePoints({ ...request, usage: { "768P-6": "1" } })).rejects.toThrow("已保存的完整响应");
        await recordModelPriceSubmissionOutcome(outcome);
        await expect(recordModelPriceSubmissionOutcome({ ...outcome, observation: { ...outcome.observation, fileId: "different" } })).rejects.toThrow("不能改写");
        expect((await settleModelPricePoints({ ...request, resume: true })).reservation.settlement?.actualExactPoints).toBe("211/200");
    });
    it.each(["failed", "missing-file", "missing-dimensions", "business-error"])("Hailuo retains %s evidence without charging or releasing", async (mode) => {
        const { request, record, claimId } = await submitHailuo();
        const payload: Partial<ReturnType<typeof hailuoResponse>> = hailuoResponse();
        if (mode === "failed") payload.status = "Fail";
        if (mode === "missing-file") delete payload.file_id;
        if (mode === "missing-dimensions") delete payload.video_width;
        if (mode === "business-error") payload.base_resp = { status_code: 1000 };
        await record(payload);
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow();
        await expect(releaseModelPricePoints({ ...request, reason: "confirmed-no-charge", evidence: "assumed free" })).rejects.toThrow("已认领提交");
        await expect(reviewModelPriceSubmission({ ...request, review: { id: "not-hailuo-proof", claimId, reviewedBy: "admin", reviewedAt: now.toISOString(), evidence: "generic H3 review", outcome: { kind: "not_charged" } } })).rejects.toThrow(
            "专用任务凭据",
        );
        expect((await state(request.requestId)).records).toHaveLength(0);
        expect((await state(request.requestId)).reservation?.status).toBe("reserved");
    });
    it("Hailuo rejects unpriced, unsupported and changed requests before deduction", async () => {
        for (const mode of ["zero-price", "missing-price", "fast-without-image", "unsupported-tier", "unknown-option"]) {
            const request = hailuoInput("MiniMax-Hailuo-2.3-Fast");
            const payload = request.videoRequest.payload as Record<string, unknown>;
            if (mode === "zero-price") request.version.items[0].price = "0";
            if (mode === "missing-price") request.version.items.pop();
            if (mode === "fast-without-image") delete payload.first_frame_image;
            if (mode === "unsupported-tier") payload.resolution = "2K";
            if (mode === "unknown-option") payload.audio = true;
            await expect(reserveModelPricePoints(request)).rejects.toThrow();
            expect((await state(request.requestId)).reservation).toBeUndefined();
        }
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(25);
        const request = hailuoInput();
        await reserveModelPricePoints(request);
        request.videoRequest.payload = { ...(request.videoRequest.payload as object), duration: 10 };
        await expect(reserveModelPricePoints(request)).rejects.toThrow("视频请求已变化");
    });
    it("Hailuo resumes a failed wallet commit from the saved response and expires only the original daily refund", async () => {
        const { request, record } = await submitHailuo(hailuoInput("MiniMax-Hailuo-2.3", "1080P-6"));
        await record();
        const failure = (provider === "postgres" ? vi.spyOn(ModelPricingWalletRepository.prototype, "save") : vi.spyOn(dataAdapter, "writeJsonDataFile")).mockRejectedValueOnce(new Error("fixture commit failure"));
        await expect(settleModelPricePoints({ ...request, resume: true })).rejects.toThrow("fixture commit failure");
        failure.mockRestore();
        expect((await state(request.requestId)).records).toHaveLength(0);
        const result = await settleModelPricePoints({ ...request, resume: true });
        expect(result.reservation.settlement?.actualExactPoints).toBe("1211/200");
        const refunded = await refundModelPricePoints({ ...request, now: new Date("2026-10-03T08:00:00+08:00"), refundId: "expired-daily", usage: result.reservation.settledUsage!, units: 1, evidence: "original file unavailable" });
        expect(refunded.refund.calculation.release).toMatchObject({ dailyRestored: "0.00", dailyExpired: "5.00", permanentRestored: "1.06" });
        expect(refunded.snapshot.totalPoints).toBe(25);
        expect((await state(request.requestId)).exact).toBe("0");
    });
    it("Hailuo accumulates fractional whole-video prices across concurrent original calls", async () => {
        const tasks = [await submitHailuo(), await submitHailuo()];
        await Promise.all(tasks.map((task) => task.record()));
        const results = await Promise.all(tasks.map(({ request }) => settleModelPricePoints({ ...request, resume: true })));
        expect(results.map((item) => item.reservation.settlement!.chargedPoints).sort()).toEqual(["1.05", "1.06"]);
        expect((await state(tasks[0].request.requestId)).exact).toBe("211/100");
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(22.89);
        for (const result of results)
            await refundModelPricePoints({
                userId,
                requestId: result.reservation.requestId,
                requestFingerprint: result.reservation.requestFingerprint,
                refundId: "whole-original",
                usage: result.reservation.settledUsage!,
                units: 1,
                evidence: "original file unavailable",
                now,
            });
        expect((await getPointsWalletSnapshot(userId, { now })).totalPoints).toBe(25);
    });
    it.each(HAILUO_PRICE_MODELS)("Hailuo %s settles from the real local V1 create and original query", async (model) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("fixture bind failed");
            const origin = `http://127.0.0.1:${address.port}`;
            const request = hailuoInput(model);
            await reserveModelPricePoints(request);
            const claimId = (await claimModelPriceSubmission(request)).reservation.submission!.id;
            const created = await fetch(`${origin}/v1/video_generation`, { method: "POST", headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" }, body: JSON.stringify(request.videoRequest.payload) }).then((r) => r.json());
            await acknowledgeModelPriceVideoSubmission({ ...request, claimId, payload: created });
            const payload = await fetch(`${origin}/v1/query/video_generation?task_id=${encodeURIComponent(created.task_id)}`).then((r) => r.json());
            await recordModelPriceSubmissionOutcome({ ...request, claimId, kind: "response", observation: inspectHailuoObservation(payload, created.task_id), responseComplete: true });
            expect((await settleModelPricePoints({ ...request, resume: true })).reservation.settlement?.actualExactPoints).toBe("211/200");
            expect(fixture.requests.filter((item) => item.method === "POST")).toHaveLength(1);
            expect((await claimModelPriceSubmission(request)).claimed).toBe(false);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
