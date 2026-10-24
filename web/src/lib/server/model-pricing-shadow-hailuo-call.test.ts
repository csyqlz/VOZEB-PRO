import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import * as dataAdapter from "./data-adapter";
import { ModelPricingShadowRepository } from "./database/model-pricing-shadow-repository";
import { HAILUO_PRICE_MODELS, HAILUO_PRICE_TIERS, type HailuoPriceContract } from "./model-pricing-hailuo-contract";
import { saveVideoPriceContract } from "./model-pricing-video-contract-store";
import { beginShadowVideoCall, acknowledgeShadowVideoCall, finishShadowVideoCall } from "./model-pricing-shadow-video-call";
import { getShadowVideoCall, getShadowPriceExactTotal } from "./model-pricing-shadow-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const publishedAt = "2026-10-01T00:00:00Z";
const response = { task_id: "original", status: "Success", file_id: "original-file", video_width: 1920, video_height: 1080, base_resp: { status_code: 0 }, prompt: "PRIVATE_PROMPT", download_url: "https://private.example/PRIVATE_MEDIA" };
describe.each(providers)("Hailuo original-call shadow (%s)", (provider) => {
    let directory: string;
    let userId: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-hailuo-shadow-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        userId = randomUUID();
        if (provider === "postgres") {
            await initializePostgresSchema();
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
            const settings = await getFreshAuthSettings();
            const now = new Date().toISOString();
            await createPostgresRepositories().users.createWithNextAccountId({
                id: userId,
                username: `hailuo_${userId}`,
                displayName: "影子夹具",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId: settings.entitlements.defaultPlanId,
                pointsBalance: 0.25,
                passwordHash: "fixture",
                createdAt: now,
                updatedAt: now,
            });
        }
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") {
            expect((await createPostgresRepositories().users.getById(userId))?.pointsBalance).toBe(0.25);
            expect((await postgresQuery("SELECT id FROM point_records WHERE user_id = $1", [userId])).rows).toEqual([]);
            await createPostgresRepositories().users.delete(userId);
        } else await expect(readFile(join(directory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    function input(model: HailuoPriceContract["requestedModel"] = "MiniMax-Hailuo-2.3", tier: (typeof HAILUO_PRICE_TIERS)[number] = "768P-6") {
        const [resolution, duration] = tier.split("-");
        return {
            userId,
            requestId: randomUUID(),
            requestFingerprint: "server-owned-digest",
            modelId: "hailuo-model",
            channelId: "channel",
            requestedModel: model,
            declaredProtocol: "minimax",
            path: ["v1", "video_generation"],
            payload: { model, prompt: "PRIVATE_PROMPT", resolution, duration: Number(duration), first_frame_image: "https://private.example/PRIVATE_REFERENCE" },
        };
    }
    async function publish(model: HailuoPriceContract["requestedModel"] = "MiniMax-Hailuo-2.3", coefficient = "1") {
        const version: OfficialPriceVersion = {
            id: randomUUID(),
            candidateId: "fixture",
            logicalModelId: "hailuo-model",
            manufacturer: "MiniMax",
            series: "Hailuo",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "Synthetic three-tier standard price",
            sourceKind: "manual",
            sourceUrl: "https://example.com/fixture",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "fixture-admin",
            items: HAILUO_PRICE_TIERS.map((key, i) => ({ key, unit: "video", per: "1", price: ["0.0015", "0.123", "0.789"][i], currency: "USD" })),
        };
        const policy: SalesVersion = {
            id: randomUUID(),
            publishedAt,
            publishedBy: "fixture-admin",
            priceVersionIds: { [version.logicalModelId]: version.id },
            userPriceRules: [{ scope: "default", coefficient }],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        if (provider === "postgres") {
            await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [version.id, version.logicalModelId, publishedAt, JSON.stringify(version)]);
            await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [policy.id, publishedAt, JSON.stringify(policy)]);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1 WHERE id = 'default'", [policy.id]);
        } else await dataAdapter.writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        const contract = await saveVideoPriceContract(
            {
                officialVersionId: version.id,
                channelId: "channel",
                requestedModel: model,
                protocol: "minimax-hailuo-v1",
                scope: "global-standard-minimax-hailuo-generation",
                tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
                evidence: "Synthetic channel proof",
                reviewedAt: publishedAt,
                reviewedBy: "fixture-admin",
            },
            null,
        );
        return { version, policy, contract };
    }
    const acknowledge = (call: Awaited<ReturnType<typeof beginShadowVideoCall>>) => acknowledgeShadowVideoCall(call, { payload: { task_id: "original", base_resp: { status_code: 0 } } });
    it.each(HAILUO_PRICE_MODELS.flatMap((model) => HAILUO_PRICE_TIERS.map((tier, i) => ({ model, tier, exact: ["21/20", "861/10", "5523/10"][i] }))))(
        "freezes $model $tier and counts one original file without changing a wallet",
        async ({ model, tier, exact }) => {
            const first = await publish(model);
            const request = input(model, tier);
            const [call, duplicate] = await Promise.all([beginShadowVideoCall(request), beginShadowVideoCall(request)]);
            expect(call).toEqual(duplicate);
            expect(call.frozen).toMatchObject({ protocol: "minimax-hailuo-v1", bound: { tier, maximumVideos: "1" } });
            await acknowledge(call);
            await publish(model, "9");
            call.frozen!.version.items[0].price = "999";
            await Promise.all([finishShadowVideoCall(call, "original", response), finishShadowVideoCall(call, "original", response)]);
            const saved = (await getShadowVideoCall(userId, call.requestId))!;
            expect(saved.frozen?.policy.id).toBe(first.policy.id);
            expect(saved.result?.status).toBe("priced");
            expect(saved.observations).toHaveLength(1);
            expect(await getShadowPriceExactTotal(userId)).toBe(exact);
            await finishShadowVideoCall(call, "original", { ...response, file_id: "changed-file", video_width: 1280 });
            expect((await getShadowVideoCall(userId, call.requestId))!.observations).toHaveLength(2);
            expect(await getShadowPriceExactTotal(userId)).toBe(exact);
            expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_|download_url|quantities|outputSeconds/);
        },
    );
    it("never reprices requests lacking a contract at submission or unsupported request features", async () => {
        const missing = await beginShadowVideoCall(input());
        await acknowledge(missing);
        await publish();
        expect((await finishShadowVideoCall(missing, "original", response)).result?.status).toBe("unpriced");
        for (const patch of [
            { adapted: true },
            { declaredProtocol: "custom" },
            { path: ["v2", "video_generation"] },
            { payload: { ...input().payload, last_frame_image: "PRIVATE_END" } },
            { payload: { ...input().payload, resolution: "1080P", duration: 10 } },
        ]) {
            const call = await beginShadowVideoCall({ ...input(), ...patch });
            await acknowledge(call);
            expect(call.reasons.length).toBeGreaterThan(0);
            await finishShadowVideoCall(call, "original", response);
        }
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("requires a successful original create acknowledgement and stable request/task identity", async () => {
        await publish();
        const request = input();
        const call = await beginShadowVideoCall(request);
        for (const patch of [{ requestFingerprint: "other" }, { channelId: "other" }, { requestedModel: "MiniMax-Hailuo-2.3-Fast" }, { path: ["v2", "video_generation"] }])
            await expect(beginShadowVideoCall({ ...request, ...patch })).rejects.toThrow("不同请求");
        await expect(finishShadowVideoCall(call, "original", response)).rejects.toThrow("原创建任务");
        for (const base_resp of [undefined, { status_code: 1000 }]) {
            const invalid = await beginShadowVideoCall(input());
            expect((await acknowledgeShadowVideoCall(invalid, { payload: { task_id: "original", base_resp } })).upstreamTaskId).toBeUndefined();
        }
        await acknowledge(call);
        await expect(acknowledgeShadowVideoCall(call, { payload: { task_id: "other", base_resp: { status_code: 0 } } })).rejects.toThrow("不同上游任务");
        await expect(finishShadowVideoCall(call, "original", { ...response, task_id: "other" })).rejects.toThrow("原创建任务");
        await expect(finishShadowVideoCall({ ...call, userId: randomUUID() }, "original", response)).rejects.toThrow();
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("retains incomplete observations and recovers complete evidence at the original frozen price", async () => {
        await publish();
        const call = await beginShadowVideoCall(input());
        await acknowledge(call);
        for (const patch of [{ file_id: undefined }, { video_width: 0 }, { base_resp: undefined }, { base_resp: { status_code: 1000 } }]) expect((await finishShadowVideoCall(call, "original", { ...response, ...patch })).result?.status).toBe("unpriced");
        await publish("MiniMax-Hailuo-2.3", "9");
        expect((await finishShadowVideoCall(call, "original", response)).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("21/20");
    });
    it("ignores running responses and never charges an acknowledged failed terminal task", async () => {
        await publish();
        const call = await beginShadowVideoCall(input());
        await acknowledge(call);
        await finishShadowVideoCall(call, "original", { ...response, status: "Processing" });
        expect((await getShadowVideoCall(userId, call.requestId))!.observations).toEqual([]);
        expect((await finishShadowVideoCall(call, "original", { task_id: "original", status: "Fail", base_resp: { status_code: 0 } })).result?.status).toBe("failed");
        expect((await finishShadowVideoCall(call, "original", response)).result?.status).toBe("failed");
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("rolls back a failed receipt commit and accumulates fractional concurrent calls once", async () => {
        await publish();
        const call = await beginShadowVideoCall(input());
        const original = await acknowledge(call);
        const failure = provider === "postgres" ? vi.spyOn(ModelPricingShadowRepository.prototype, "saveCall") : vi.spyOn(dataAdapter, "writeJsonDataFile");
        failure.mockRejectedValueOnce(new Error("fixture commit failure"));
        try {
            await expect(finishShadowVideoCall(call, "original", response)).rejects.toThrow("fixture commit failure");
        } finally {
            failure.mockRestore();
        }
        expect(await getShadowVideoCall(userId, call.requestId)).toEqual(original);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        const calls = [call, await beginShadowVideoCall(input())];
        await Promise.all(calls.map(acknowledge));
        await Promise.all(calls.flatMap((item) => [finishShadowVideoCall(item, "original", response), finishShadowVideoCall(item, "original", response)]));
        expect(await getShadowPriceExactTotal(userId)).toBe("21/10");
    });
});
