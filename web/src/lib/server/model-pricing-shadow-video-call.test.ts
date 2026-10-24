import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fraction from "fraction.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import * as dataAdapter from "./data-adapter";
import { ModelPricingShadowRepository } from "./database/model-pricing-shadow-repository";
import { saveVideoPriceContract } from "./model-pricing-video-contract-store";
import { beginShadowVideoCall, acknowledgeShadowVideoCall, finishShadowVideoCall } from "./model-pricing-shadow-video-call";
import { beginShadowTextCall } from "./model-pricing-shadow-call";
import { getShadowVideoCall, getShadowPriceExactTotal } from "./model-pricing-shadow-store";
import { reverseShadowPrice } from "./model-pricing-shadow-service";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const payload = {
    task: {
        id: "original",
        model: "MiniMax-H3",
        resolution: "768P",
        status: "succeeded",
        task_type: "generation",
        modality: "video",
        content: { url: "https://fixture.example.com/PRIVATE_MEDIA" },
        usage: { total_seconds: 6.5, input_seconds: 1.25, output_seconds: 5.25, input_image_count: 2, input_audio_seconds: 0 },
    },
};
const publishedAt = "2026-10-01T00:00:00Z";
describe.each(providers)("video shadow lifecycle (%s)", (provider) => {
    let directory: string;
    let userId: string;
    const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-video-shadow-"));
        process.env.VOZEB_PRO_DATA_DIR = directory;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
        userId = randomUUID();
        if (provider === "postgres") {
            await initializePostgresSchema();
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
            const settings = await getFreshAuthSettings();
            const now = new Date().toISOString();
            await createPostgresRepositories().users.createWithNextAccountId({
                id: userId,
                username: `shadow_${userId}`,
                displayName: "视频影子测试",
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
        if (provider === "postgres") {
            expect((await createPostgresRepositories().users.getById(userId))?.pointsBalance).toBe(0.25);
            expect((await postgresQuery("SELECT id FROM point_records WHERE user_id = $1", [userId])).rows).toEqual([]);
            await createPostgresRepositories().users.delete(userId);
        } else {
            const files = await readdir(directory);
            expect(files).not.toContain("auth.json");
        }
        if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
        if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = original.directory;
        await rm(directory, { recursive: true, force: true });
    });
    const input = () => ({
        userId,
        requestId: randomUUID(),
        requestFingerprint: "server-owned-digest",
        modelId: "video-model",
        channelId: "channel",
        requestedModel: "MiniMax-H3",
        declaredProtocol: "minimax",
        path: ["v2", "video_generation"],
        payload: {
            model: "MiniMax-H3",
            resolution: "768P",
            duration: 5,
            content: [
                { type: "text", text: "PRIVATE_PROMPT" },
                { type: "video_url", video_url: { url: "https://fixture.example.com/PRIVATE_REFERENCE" }, role: "reference_video" },
                ...Array.from({ length: 2 }, () => ({ type: "image_url", image_url: { url: "https://fixture.example.com/PRIVATE_IMAGE" }, role: "reference_image" })),
            ],
        },
    });
    async function publish(coefficient = "1") {
        const version: OfficialPriceVersion = {
            id: randomUUID(),
            candidateId: "fixture",
            logicalModelId: "video-model",
            manufacturer: "MiniMax",
            series: "H3",
            officialVersion: "MiniMax-H3",
            sku: "MiniMax-H3",
            tier: "paid",
            conditions: "Synthetic global standard generation",
            sourceKind: "manual",
            sourceUrl: "https://example.com/fixture",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "fixture-admin",
            items: [
                ...["768P", "2K"].flatMap((resolution) => ["input", "output"].map((kind) => ({ key: `${resolution}-${kind}`, unit: "second", per: "1", price: "0.08", currency: "USD" }))),
                { key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" },
                { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
            ],
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
        } else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        const contract = await saveVideoPriceContract(
            {
                officialVersionId: version.id,
                channelId: "channel",
                requestedModel: "MiniMax-H3",
                protocol: "minimax-video-v2",
                scope: "global-standard-minimax-h3-generation",
                resolutionItems: Object.fromEntries(["768P", "2K"].map((resolution) => [resolution, { inputSeconds: `${resolution}-input`, outputSeconds: `${resolution}-output` }])),
                inputImageItem: "images",
                inputImagePricing: "all-at-standard-rate",
                inputAudioItem: "inputAudioSeconds",
                evidence: "Synthetic channel proof",
                reviewedAt: publishedAt,
                reviewedBy: "fixture-admin",
            },
            null,
        );
        return { version, policy, contract };
    }
    const acknowledge = (call: Awaited<ReturnType<typeof beginShadowVideoCall>>) => acknowledgeShadowVideoCall(call, { payload: { task_id: "original" } });
    it("freezes prices before submission, binds the original task and preserves distinct terminal observations", async () => {
        const first = await publish();
        const request = input();
        const [call, duplicate] = await Promise.all([beginShadowVideoCall(request), beginShadowVideoCall(request)]);
        expect(duplicate).toEqual(call);
        await acknowledge(call);
        await publish("9");
        call.frozen!.version.items[0].price = "999";
        const completed = await finishShadowVideoCall(call, "original", payload);
        expect(completed).toMatchObject({ frozen: { policy: { id: first.policy.id } }, result: { status: "priced" }, observations: [{ quantities: { inputImageCount: "2", outputSeconds: "5.25" } }] });
        expect(await getShadowPriceExactTotal(userId)).toBe("420");
        await Promise.all([finishShadowVideoCall(call, "original", payload), finishShadowVideoCall(call, "original", { task: { ...payload.task, usage: { ...payload.task.usage, output_seconds: 10 } } })]);
        const saved = await getShadowVideoCall(userId, call.requestId);
        expect(saved?.observations).toHaveLength(2);
        expect(saved?.result).toEqual(completed.result);
        expect(await getShadowPriceExactTotal(userId)).toBe("420");
        const content =
            provider === "postgres"
                ? JSON.stringify((await postgresQuery("SELECT data FROM model_pricing_shadow_calls WHERE user_id = $1", [userId])).rows)
                : await readFile(join(directory, "model-pricing-shadow", (await readdir(join(directory, "model-pricing-shadow")))[0]), "utf8");
        for (const secret of ["PRIVATE_PROMPT", "PRIVATE_REFERENCE", "PRIVATE_IMAGE", "PRIVATE_MEDIA"]) expect(content).not.toContain(secret);
        expect((await reverseShadowPrice(userId, call.requestId)).changeExactPoints).toBe("-420");
        await finishShadowVideoCall(call, "original", payload);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("rejects different request, owner, channel, model and acknowledgement identities", async () => {
        await publish();
        const request = input();
        const call = await beginShadowVideoCall(request);
        for (const patch of [{ requestFingerprint: "other" }, { channelId: "other" }, { requestedModel: "other" }, { declaredProtocol: "custom" }]) await expect(beginShadowVideoCall({ ...request, ...patch })).rejects.toThrow("不同请求");
        await expect(beginShadowTextCall({ ...request, path: ["chat", "completions"] })).rejects.toThrow("不同请求");
        await expect(finishShadowVideoCall(call, "original", payload)).rejects.toThrow("原创建任务");
        await acknowledge(call);
        await expect(acknowledgeShadowVideoCall(call, { payload: { task_id: "other" } })).rejects.toThrow("不同上游任务");
        await expect(finishShadowVideoCall({ ...call, userId: randomUUID() }, "original", payload)).rejects.toThrow();
        await expect(finishShadowVideoCall(call, "other", { task: { ...payload.task, id: "other" } })).rejects.toThrow("原创建任务");
        expect((await finishShadowVideoCall(call, "original", { task: { ...payload.task, model: "other" } })).result?.status).toBe("unpriced");
        expect((await finishShadowVideoCall(call, "original", payload)).result?.status).toBe("priced");
    });
    it("prices standing-free audio but rejects missing tariffs and unsupported protocols", async () => {
        const missing = await beginShadowVideoCall(input());
        await acknowledge(missing);
        await publish();
        expect((await finishShadowVideoCall(missing, "original", payload)).result?.status).toBe("unpriced");
        const request = input();
        for (const patch of [{ adapted: true }, { declaredProtocol: "custom" }]) {
            const call = await beginShadowVideoCall({ ...input(), ...patch });
            await acknowledge(call);
            expect((await finishShadowVideoCall(call, "original", payload)).result?.status).toBe("unpriced");
        }
        const audio = await beginShadowVideoCall({ ...input(), payload: { ...request.payload, content: [...request.payload.content, { type: "audio_url", audio_url: { url: "https://fixture.example.com/audio" }, role: "reference_audio" }] } });
        await acknowledge(audio);
        expect((await finishShadowVideoCall(audio, "original", { task: { ...payload.task, usage: { ...payload.task.usage, input_audio_seconds: 3.5 } } })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("420");
    });
    it("allows complete evidence after missing usage but never prices failed or cancelled attempts", async () => {
        await publish();
        for (const status of ["failed", "cancelled"]) {
            const call = await beginShadowVideoCall(input());
            await acknowledge(call);
            expect((await finishShadowVideoCall(call, "original", { task: { ...payload.task, status } })).result?.status).toBe("failed");
            expect((await finishShadowVideoCall(call, "original", payload)).result?.status).toBe("failed");
        }
        const call = await beginShadowVideoCall(input());
        await acknowledge(call);
        expect((await finishShadowVideoCall(call, "original", { task: { ...payload.task, usage: {} } })).result?.status).toBe("unpriced");
        await publish("9");
        expect((await finishShadowVideoCall(call, "original", payload)).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("420");
    });
    it("rolls back failed commits and accumulates fractional concurrent receipts exactly once", async () => {
        await publish();
        const call = await beginShadowVideoCall(input());
        const original = await acknowledge(call);
        const failure = provider === "postgres" ? vi.spyOn(ModelPricingShadowRepository.prototype, "saveCall") : vi.spyOn(dataAdapter, "writeJsonDataFile");
        failure.mockRejectedValueOnce(new Error("fixture commit failure"));
        try {
            await expect(finishShadowVideoCall(call, "original", payload)).rejects.toThrow("fixture commit failure");
        } finally {
            failure.mockRestore();
        }
        expect(await getShadowVideoCall(userId, call.requestId)).toEqual(original);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        const tiny = { task: { ...payload.task, usage: { total_seconds: 1e-7, input_seconds: 0, output_seconds: 1e-7, input_image_count: 0, input_audio_seconds: 0 } } };
        const calls = await Promise.all([beginShadowVideoCall(input()), beginShadowVideoCall(input())]);
        await Promise.all(calls.map(acknowledge));
        await Promise.all(calls.flatMap((item) => [finishShadowVideoCall(item, "original", tiny), finishShadowVideoCall(item, "original", tiny)]));
        expect(await getShadowPriceExactTotal(userId)).toBe(new Fraction("7/1250000").mul(calls.length).toFraction());
    });
});
