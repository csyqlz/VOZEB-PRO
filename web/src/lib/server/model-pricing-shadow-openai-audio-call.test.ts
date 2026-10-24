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
import { saveAudioPriceContract } from "./model-pricing-audio-contract-store";
import { beginShadowAudioCall, finishShadowAudioCall } from "./model-pricing-shadow-audio-call";
import { beginShadowTextCall, finishShadowTextCall } from "./model-pricing-shadow-call";
import { getShadowAudioCall, getShadowPriceExactTotal } from "./model-pricing-shadow-store";
import { reverseShadowPrice } from "./model-pricing-shadow-service";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const models = ["gpt-audio-1.5"] as const;
const response = (model: (typeof models)[number] = models[0], input = 1, output = 0, textOutput = 0) => ({
    model,
    service_tier: "default",
    choices: [{ message: { content: "PRIVATE_REPLY", audio: { data: "PRIVATE_AUDIO", transcript: "PRIVATE_TRANSCRIPT" } } }],
    usage: {
        prompt_tokens: input,
        completion_tokens: output + textOutput,
        total_tokens: input + output + textOutput,
        prompt_tokens_details: { text_tokens: input, audio_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { text_tokens: textOutput, audio_tokens: output },
    },
});
const payload = { model: models[0], messages: [{ role: "user", content: "PRIVATE_PROMPT" }], modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" } };
const publishedAt = "2026-10-01T00:00:00Z";
describe.each(providers)("OpenAI audio shadow lifecycle (%s)", (provider) => {
    let directory: string;
    let userId: string;
    const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-audio-shadow-"));
        process.env.VOZEB_PRO_DATA_DIR = directory;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
        userId = randomUUID();
        if (provider === "postgres") {
            await initializePostgresSchema();
            const settings = await getFreshAuthSettings();
            const now = new Date().toISOString();
            await createPostgresRepositories().users.createWithNextAccountId({
                id: userId,
                username: `shadow_${userId}`,
                displayName: "音频影子测试",
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
    const input = (model: (typeof models)[number] = models[0], declaredProtocol: "openai" = "openai") => ({
        userId,
        requestId: randomUUID(),
        requestFingerprint: "server-owned-digest",
        modelId: "audio-model",
        channelId: "channel",
        requestedModel: model,
        declaredProtocol,
        path: ["v1", "chat", "completions"],
        payload,
    });
    async function publish(coefficient = "1", model: (typeof models)[number] = models[0], declaredProtocol: "openai" = "openai") {
        const version: OfficialPriceVersion = {
            id: randomUUID(),
            candidateId: "fixture",
            logicalModelId: "audio-model",
            manufacturer: "Fixture",
            series: "TTS",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "Synthetic global standard text and audio tokens",
            sourceKind: "manual",
            sourceUrl: "https://example.com/fixture",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "fixture-admin",
            items: ["inputTextTokens", "inputAudioTokens", "outputTextTokens", "outputAudioTokens"].map((key, index) => ({ key, unit: "token", per: "1000000", price: String(index + 1), currency: "USD" })),
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
        const contract = await saveAudioPriceContract(
            {
                officialVersionId: version.id,
                channelId: "channel",
                requestedModel: model,
                reportedModel: model,
                protocol: "openai-chat-audio",
                declaredProtocol,
                scope: "global-standard-openai-chat-audio-uncached",
                itemKeys: { inputTextTokens: "inputTextTokens", inputAudioTokens: "inputAudioTokens", outputTextTokens: "outputTextTokens", outputAudioTokens: "outputAudioTokens" },
                evidence: "Synthetic channel proof",
                reviewedAt: publishedAt,
                reviewedBy: "fixture-admin",
            },
            null,
        );
        return { version, policy, contract };
    }
    it.each(models)("freezes %s ordinary prices, four-meter contract and shared bounds", async (model) => {
        for (const protocol of ["openai"] as const) {
            const first = await publish("1", model, protocol);
            const request = input(model, protocol);
            const [call, concurrent] = await Promise.all([beginShadowAudioCall(request), beginShadowAudioCall(request)]);
            expect(call).toEqual(concurrent);
            expect(call.reasons).toEqual([]);
            expect(call.frozen?.bound).toMatchObject({ maximumQuantities: { inputTextTokens: "128000", inputAudioTokens: "0", outputTextTokens: "16384", outputAudioTokens: "16384" } });
            await saveAudioPriceContract({ ...first.contract, evidence: "later proof" }, first.contract.id);
            await publish("2", model, protocol);
            expect(await beginShadowAudioCall(request)).toEqual(call);
            call.frozen!.version.items[0].price = "999";
            const finished = await finishShadowAudioCall(call, { payload: response(model) });
            expect(finished.result?.status).toBe("priced");
            expect(finished.frozen?.version.items[0].price).toBe("1");
            await Promise.all([finishShadowAudioCall(call, { payload: response(model, 2) }), finishShadowAudioCall(call, { failure: "late failure" })]);
            expect((await getShadowAudioCall(userId, call.requestId))?.result).toEqual(finished.result);
        }
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        const content =
            provider === "postgres"
                ? JSON.stringify((await postgresQuery("SELECT data FROM model_pricing_shadow_calls WHERE user_id = $1", [userId])).rows)
                : await readFile(join(directory, "model-pricing-shadow", (await readdir(join(directory, "model-pricing-shadow")))[0]), "utf8");
        for (const secret of ["PRIVATE_PROMPT", "PRIVATE_AUDIO", "PRIVATE_REPLY", "PRIVATE_TRANSCRIPT"]) expect(content).not.toContain(secret);
    });
    it("prices all four independent meters and refuses missing ordinary audio-input prices", async () => {
        const { version, policy } = await publish();
        const call = await beginShadowAudioCall(input());
        expect((await finishShadowAudioCall(call, { payload: response(models[0], 8, 10, 2) })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("189/5000");
        for (const items of [version.items.filter((item) => item.key !== "inputAudioTokens"), version.items.map((item) => (item.key === "inputAudioTokens" ? { ...item, price: "0" } : item))]) {
            const unpriced = { ...version, items };
            if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [version.id, JSON.stringify(unpriced)]);
            else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [unpriced], salesVersions: [policy] });
            const excluded = await beginShadowAudioCall(input());
            expect(excluded.reasons.length).toBeGreaterThan(0);
            expect((await finishShadowAudioCall(excluded, { payload: response() })).result?.status).toBe("unpriced");
        }
        expect(await getShadowPriceExactTotal(userId)).toBe("189/5000");
    });
    it("keeps a missing or free price on fixed billing even after later approvals", async () => {
        const request = input();
        const missing = await beginShadowAudioCall(request);
        const { version, policy } = await publish();
        expect(await beginShadowAudioCall(request)).toEqual(missing);
        expect((await finishShadowAudioCall(missing, { payload: response() })).result?.status).toBe("unpriced");
        const original = await beginShadowAudioCall(input());
        const free = { ...version, items: version.items.map((item) => ({ ...item, price: "0" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [version.id, JSON.stringify(free)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [free], salesVersions: [policy] });
        const excluded = await beginShadowAudioCall(input());
        expect(excluded.reasons).toContainEqual(expect.stringContaining("固定积分"));
        await publish("3");
        expect((await finishShadowAudioCall(excluded, { payload: response() })).result?.status).toBe("unpriced");
        expect((await finishShadowAudioCall(original, { payload: response() })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });
    it("commits concurrent sub-cent calls and original reversals exactly once", async () => {
        await publish();
        const count = Math.ceil(0.01 / 0.0007);
        const calls = await Promise.all(Array.from({ length: count }, () => beginShadowAudioCall(input())));
        const results = await Promise.all(calls.flatMap((call) => [finishShadowAudioCall(call, { payload: response() }), finishShadowAudioCall(call, { payload: response() })]));
        expect(new Set(results.map((call) => call.result?.receiptId)).size).toBe(count);
        expect(await getShadowPriceExactTotal(userId)).toBe(new Fraction("7/10000").mul(count).toFraction());
        await publish("9");
        const reversal = await reverseShadowPrice(userId, calls[0].requestId);
        expect(reversal.changeExactPoints).toBe("-7/10000");
        expect(await reverseShadowPrice(userId, calls[0].requestId)).toEqual(reversal);
        expect(await getShadowPriceExactTotal(userId)).toBe(new Fraction("7/10000").mul(count - 1).toFraction());
    });
    it("rolls back result and receipt together on persistence failure", async () => {
        await publish();
        const call = await beginShadowAudioCall(input());
        const failure = provider === "postgres" ? vi.spyOn(ModelPricingShadowRepository.prototype, "saveCall") : vi.spyOn(dataAdapter, "writeJsonDataFile");
        failure.mockRejectedValueOnce(new Error("fixture commit failure"));
        try {
            await expect(finishShadowAudioCall(call, { payload: response() })).rejects.toThrow("fixture commit failure");
        } finally {
            failure.mockRestore();
        }
        expect(await getShadowAudioCall(userId, call.requestId)).toEqual(call);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        if (provider === "postgres") expect((await postgresQuery("SELECT kind FROM model_pricing_shadow_receipts WHERE user_id = $1 AND request_id = $2", [userId, call.requestId])).rows).toEqual([]);
        expect((await finishShadowAudioCall(call, { payload: response() })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });
    it("preserves incomplete, failed or unsupported responses as immutable unpriced attempts", async () => {
        await publish();
        for (const outcome of [{ payload: {} }, { payload: { ...response(), usage: { ...response().usage, total_tokens: 2 } } }, { payload: { ...response(), choices: [] } }, { failure: "transport failure" }, { unavailable: "stream unsupported" }]) {
            const call = await beginShadowAudioCall(input());
            const completed = await finishShadowAudioCall(call, outcome);
            expect(completed.result?.status).not.toBe("priced");
            expect((await finishShadowAudioCall(call, { payload: response() })).result).toEqual(completed.result);
        }
        for (const patch of [{ path: ["audio", "speech"] }, { adapted: true }, { declaredProtocol: "gemini" as const }, { requestedModel: "unknown" }, { payload: { ...payload, tools: [{}] } }]) {
            const call = await beginShadowAudioCall({ ...input(), ...patch });
            expect((await finishShadowAudioCall(call, { payload: response() })).result?.status).toBe("unpriced");
        }
        const bounded = await beginShadowAudioCall({ ...input(), payload: { ...payload, max_completion_tokens: 1 } });
        expect((await finishShadowAudioCall(bounded, { payload: response(models[0], 1, 2) })).result?.status).toBe("unpriced");
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("rejects changed request identities and cross-capability reuse", async () => {
        await publish();
        const request = input();
        const call = await beginShadowAudioCall(request);
        for (const patch of [{ requestFingerprint: "changed" }, { channelId: "fallback" }, { requestedModel: "gpt-4o-audio-preview" }, { declaredProtocol: "dataeyes-gemini" as const }, { path: ["audio", "speech"] }])
            await expect(beginShadowAudioCall({ ...request, ...patch })).rejects.toThrow("不同请求");
        await expect(beginShadowTextCall({ ...request, path: ["chat", "completions"] })).rejects.toThrow("不同请求");
        await expect(finishShadowAudioCall({ ...call, requestFingerprint: "changed" }, { payload: response() })).rejects.toThrow("不同请求");
        expect(await getShadowAudioCall(userId, request.requestId)).toEqual(call);
        const text = await beginShadowTextCall({ ...request, requestId: randomUUID(), path: ["chat", "completions"] });
        await finishShadowTextCall(text, { failure: "fixture" });
        await expect(beginShadowAudioCall({ ...request, requestId: text.requestId })).rejects.toThrow("不同请求");
    });
});
