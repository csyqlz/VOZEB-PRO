import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fraction from "fraction.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getFreshAuthSettings } from "@/lib/auth/store";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { recordFlatTextShadowPrice, reverseShadowPrice } from "./model-pricing-shadow-service";
import { getShadowPriceExactTotal } from "./model-pricing-shadow-store";
import { getShadowTextCall } from "./model-pricing-shadow-store";
import { beginShadowTextCall, finishShadowTextCall } from "./model-pricing-shadow-call";
import { observeShadowTextStream } from "./model-pricing-shadow-stream";
import { writeJsonDataFile } from "./data-adapter";
import { saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import type { FlatTextRequestLimits } from "./model-pricing-token-contract";
import type { TokenUsageProtocol } from "./model-pricing-token-usage";

function fixture(userId: string, requestId = randomUUID()): Parameters<typeof recordFlatTextShadowPrice>[0] {
    const publishedAt = "2026-10-01T00:00:00Z";
    return {
        userId,
        requestId,
        requestFingerprint: "server-owned-request-digest",
        contractId: "contract-1",
        version: {
            id: "official-1",
            candidateId: "candidate-1",
            logicalModelId: "text-model",
            manufacturer: "Fixture",
            series: "Text",
            officialVersion: "text-v1",
            sku: "text-v1",
            tier: "paid",
            conditions: "global standard text",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
        },
        policy: {
            id: "sales-1",
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "text-model": "official-1" },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        },
        contract: {
            officialVersionId: "official-1",
            channelId: "channel",
            protocol: "openai-responses",
            requestedModel: "text",
            reportedModel: "text-v1",
            scope: "global-standard-text-flat",
            region: "global",
            serviceTier: "default",
            itemMeters: { tokens: ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"] },
            evidence: "fixture",
            reviewedAt: publishedAt,
            reviewedBy: "admin",
        },
        observation: { protocol: "openai-responses", reportedModel: "text-v1", serviceTier: "default", quantities: { inputTokens: "1", cachedInputTokens: "0", cacheWriteTokens: "0", outputTokens: "0" }, missing: [] },
        call: {
            channelId: "channel",
            salesVersionId: "sales-1",
            officialVersionId: "official-1",
            requestedModel: "text",
            region: "global",
            serviceTier: "default",
            billingMode: "standard",
            inputModalities: ["text"],
            outputModalities: ["text"],
            usesExternalTools: false,
            responseComplete: true,
            occurredAt: "2026-10-02T00:00:00Z",
        },
    };
}

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers)("exact shadow accrual (%s)", (provider) => {
    let directory: string;
    let userId: string;
    const previousProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;
    const previousDirectory = process.env.VOZEB_PRO_DATA_DIR;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-shadow-"));
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
                displayName: "影子计费测试",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId: settings.entitlements.defaultPlanId,
                pointsBalance: 0.25,
                passwordHash: "fixture-only",
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
        }
        if (previousProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = previousProvider;
        if (previousDirectory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
    });

    async function publishFixture(coefficient = "1", protocol: TokenUsageProtocol = "openai-responses", requestLimits?: FlatTextRequestLimits) {
        const input = fixture(userId);
        input.version.id = input.contract.officialVersionId = input.call.officialVersionId = randomUUID();
        input.policy.id = input.call.salesVersionId = randomUUID();
        input.policy.priceVersionIds[input.version.logicalModelId] = input.version.id;
        input.policy.userPriceRules = [{ scope: "default", coefficient }];
        input.contract.protocol = protocol;
        input.contract.requestLimits = requestLimits || {
            maxInputTokens: 100000,
            maxOutputTokens: 100000,
            maxCandidates: 1,
            includesReasoning: true,
            sourceUrl: "https://example.com/fixture-limits",
            evidence: "Synthetic upper bounds for this local fixture",
        };
        if (protocol === "anthropic-messages") input.contract.itemMeters.tokens = ["inputTokens", "cachedInputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"];
        if (protocol === "gemini-generate") input.contract.itemMeters.tokens = ["inputTokens", "cachedInputTokens", "outputTokens"];
        if (provider === "postgres") {
            await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [
                input.version.id,
                input.version.logicalModelId,
                input.version.publishedAt,
                JSON.stringify(input.version),
            ]);
            await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [input.policy.id, input.policy.publishedAt, JSON.stringify(input.policy)]);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1 WHERE id = 'default'", [input.policy.id]);
        } else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [input.version], salesVersions: [input.policy] });
        await saveFlatTextPriceContract(input.contract, null);
        return {
            userId,
            requestId: input.requestId,
            requestFingerprint: input.requestFingerprint,
            modelId: input.version.logicalModelId,
            channelId: input.call.channelId,
            requestedModel: input.call.requestedModel,
            path: ["v1", "responses"],
            payload: { model: "text", input: "private request text" },
        };
    }
    const response = {
        model: "text-v1",
        status: "completed",
        service_tier: "default",
        output: [{ type: "message", content: [{ type: "output_text", text: "private response text" }] }],
        usage: { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    };

    it("freezes zero-price exclusion before the call and never replaces it with a later paid price", async () => {
        const request = await publishFixture();
        const original = await beginShadowTextCall(request);
        const { version, policy } = original.frozen!;
        const zero = { ...version, items: version.items.map((item) => ({ ...item, price: "0" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [version.id, JSON.stringify(zero)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [zero], salesVersions: [policy] });
        const next = { ...request, requestId: randomUUID() };
        const excluded = await beginShadowTextCall(next);
        expect(excluded.reasons).toContainEqual(expect.stringContaining("固定积分"));
        await publishFixture();
        expect(await beginShadowTextCall(next)).toEqual(excluded);
        expect((await finishShadowTextCall(excluded, { payload: response })).result).toMatchObject({ status: "unpriced" });
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        expect((await finishShadowTextCall(original, { payload: response })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });

    it("freezes reviewed request bounds and persists overrun diagnostics without charging the wallet", async () => {
        const limits: FlatTextRequestLimits = { maxInputTokens: 10, maxOutputTokens: 10, maxCandidates: 1, sourceUrl: "https://example.com/limits", evidence: "Fixture total cache input and reasoning output checked", includesReasoning: true };
        const input = await publishFixture("1", "openai-responses", limits);
        const call = await beginShadowTextCall(input);
        expect(call.requestBound).toMatchObject({ ready: true, inputTokens: "10", outputTokens: "10", maximumExactPoints: "7/500" });
        expect((await getShadowTextCall(userId, input.requestId))?.requestBound).toEqual(call.requestBound);
        await saveFlatTextPriceContract({ ...call.frozen!.contract, requestLimits: { ...limits, maxInputTokens: 20 } }, call.frozen!.contract.id);
        expect((await beginShadowTextCall(input)).requestBound).toEqual(call.requestBound);
        const overrun = { ...response, usage: { ...response.usage, input_tokens: 11 } };
        const result = await finishShadowTextCall(call, { payload: overrun });
        expect(result.result).toMatchObject({ status: "unpriced", requestBoundCheck: { valid: false, reasons: ["实际用量超过调用开始时核实的请求上界"] } });
        expect((await getShadowTextCall(userId, input.requestId))?.result).toEqual(result.result);
        const next = await beginShadowTextCall({ ...input, requestId: randomUUID() });
        expect(next.requestBound).toMatchObject({ ready: true, inputTokens: "20" });
        expect((await finishShadowTextCall(next, { payload: overrun })).result?.requestBoundCheck).toEqual({ valid: true, reasons: [] });
        const mismatch = await beginShadowTextCall({ ...input, requestId: randomUUID(), path: ["v1", "chat", "completions"] });
        expect(mismatch.requestBound).toMatchObject({ ready: false });
        const noUsage = await beginShadowTextCall({ ...input, requestId: randomUUID() });
        expect((await finishShadowTextCall(noUsage, { failure: "fixture timeout" })).result?.requestBoundCheck?.valid).toBe(false);
    });

    it("uses inclusive input only after explicit review and preserves the earlier call's strict contract", async () => {
        const input = await publishFixture();
        const before = await beginShadowTextCall(input);
        const contract = before.frozen!.contract;
        await saveFlatTextPriceContract({ ...contract, itemMeters: { tokens: ["uncachedInputTokens", "cachedInputTokens", "outputTokens"] }, evidence: "官方写入按普通输入价；本地响应已核对" }, contract.id);
        const after = await beginShadowTextCall({ ...input, requestId: randomUUID() });
        const withoutWrite = { ...response, usage: { ...response.usage, input_tokens_details: { cached_tokens: 0 } } };
        expect((await finishShadowTextCall(before, { payload: withoutWrite })).result?.status).toBe("unpriced");
        expect((await finishShadowTextCall(after, { payload: withoutWrite })).result).toMatchObject({ status: "priced", observation: { missing: ["cache_write_tokens"] } });
        expect((await getShadowTextCall(userId, after.requestId))?.frozen?.contract.itemMeters.tokens).toEqual(["uncachedInputTokens", "cachedInputTokens", "outputTokens"]);
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });

    it("persists a complete stream using its frozen price and keeps interrupted streams unpriced", async () => {
        const input = await publishFixture();
        const call = await beginShadowTextCall(input);
        await publishFixture("2");
        const raw = `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
        const invoke = () => new Response(observeShadowTextStream(new Response(raw).body!, "openai-responses", (outcome) => finishShadowTextCall(call, outcome))).text();
        expect(await invoke()).toBe(raw);
        const saved = await getShadowTextCall(userId, input.requestId);
        expect(saved?.result?.status).toBe("priced");
        expect(JSON.stringify(saved)).not.toContain("private response text");
        await invoke();
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        const interrupted = await beginShadowTextCall({ ...input, requestId: randomUUID() });
        await new Response(observeShadowTextStream(new Response('data: {"type":"response.created"}\n\n').body!, "openai-responses", (outcome) => finishShadowTextCall(interrupted, outcome))).text();
        expect((await getShadowTextCall(userId, interrupted.requestId))?.result?.status).toBe("unpriced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });

    it("persists Gemini NDJSON only after EOF and rejects a truncated tail without changing the wallet", async () => {
        const input = await publishFixture("1", "gemini-generate");
        const callInput = { ...input, path: ["models", "text:streamGenerateContent"], payload: { contents: [{ parts: [{ text: "private request text" }] }] } };
        const call = await beginShadowTextCall(callInput);
        await publishFixture("2", "gemini-generate");
        const raw =
            JSON.stringify({ modelVersion: "text-v1", candidates: [{ index: 0, content: { parts: [{ text: "private response text" }] }, finishReason: "STOP" }] }) +
            "\n" +
            JSON.stringify({ usageMetadata: { serviceTier: "default", promptTokenCount: 1, cachedContentTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 } }) +
            "\n";
        const invoke = () => new Response(observeShadowTextStream(new Response(raw).body!, "gemini-generate", (outcome) => finishShadowTextCall(call, outcome), "ndjson")).text();
        expect(await invoke()).toBe(raw);
        expect((await getShadowTextCall(userId, call.requestId))?.result?.status).toBe("priced");
        await invoke();
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        expect(JSON.stringify(await getShadowTextCall(userId, call.requestId))).not.toContain("private response text");
        const broken = await beginShadowTextCall({ ...callInput, requestId: randomUUID() });
        const partial = raw + '{"usageMetadata":';
        expect(await new Response(observeShadowTextStream(new Response(partial).body!, "gemini-generate", (outcome) => finishShadowTextCall(broken, outcome), "ndjson")).text()).toBe(partial);
        expect((await getShadowTextCall(userId, broken.requestId))?.result).toMatchObject({ status: "unpriced", reasons: expect.arrayContaining(["NDJSON 响应未完整解析"]) });
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });

    it.each([
        {
            protocol: "openai-chat" as const,
            path: ["chat", "completions"],
            payload: { messages: [{ role: "user", content: "hello" }] },
            response: {
                model: "text-v1",
                service_tier: "default",
                choices: [{ finish_reason: "stop", message: { content: "reply" } }],
                usage: { prompt_tokens: 1, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
            },
        },
        {
            protocol: "anthropic-messages" as const,
            path: ["v1", "messages"],
            payload: { messages: [{ role: "user", content: "hello" }] },
            response: { model: "text-v1", stop_reason: "end_turn", content: [{ type: "text", text: "reply" }], usage: { service_tier: "default", input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        },
        {
            protocol: "gemini-generate" as const,
            path: ["v1beta", "models", "text:generateContent"],
            payload: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
            response: {
                modelVersion: "text-v1",
                candidates: [{ finishReason: "STOP", content: { parts: [{ text: "reply" }] } }],
                usageMetadata: { serviceTier: "default", promptTokenCount: 1, cachedContentTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
            },
        },
    ])("observes complete $protocol responses against their frozen contract", async (sample) => {
        const input = await publishFixture("1", sample.protocol);
        const call = await beginShadowTextCall({ ...input, path: sample.path, payload: sample.payload });
        expect((await finishShadowTextCall(call, { payload: sample.response })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });

    it("prices a complete Claude thinking response once and stores only response structure", async () => {
        const input = await publishFixture("1", "anthropic-messages");
        const call = await beginShadowTextCall({ ...input, path: ["v1", "messages"], payload: { messages: [{ role: "user", content: "private request text" }] } });
        const payload = {
            model: "text-v1",
            stop_reason: "end_turn",
            content: [
                { type: "thinking", thinking: "private thought", signature: "private signature" },
                { type: "text", text: "private response text" },
            ],
            usage: { service_tier: "default", input_tokens: 1, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 2 } },
        };
        const result = await finishShadowTextCall(call, { payload });
        expect(result.result).toMatchObject({ status: "priced", responseMeta: { stopReason: "end_turn", contentBlockTypes: ["thinking", "text"], terminalSeen: true, blocksClosed: true }, observation: { quantities: { outputTokens: "3" } } });
        expect(JSON.stringify(result)).not.toContain("private thought");
        expect(JSON.stringify(result)).not.toContain("private signature");
        expect(JSON.stringify(result)).not.toContain("private response text");
        const tool = await beginShadowTextCall({ ...input, requestId: randomUUID(), path: ["v1", "messages"], payload: { messages: [{ role: "user", content: "private request text" }] } });
        expect((await finishShadowTextCall(tool, { payload: { ...payload, stop_reason: "tool_use", content: [{ type: "tool_use", id: "private tool id" }] } })).result).toMatchObject({
            status: "unpriced",
            responseMeta: { stopReason: "tool_use", contentBlockTypes: ["tool_use"] },
            reasons: expect.arrayContaining(["上游响应尚未完整结束"]),
        });
    });

    it("freezes prices before a call and persists observations without storing the prompt or response text", async () => {
        const input = await publishFixture();
        const call = await beginShadowTextCall(input);
        await publishFixture("2");
        const restored = await beginShadowTextCall(input);
        expect(restored.frozen?.policy.id).toBe(call.frozen?.policy.id);
        const finished = await finishShadowTextCall(restored, { payload: response });
        expect(finished.result).toMatchObject({ status: "priced", receiptId: expect.any(String), observation: { quantities: { inputTokens: "1" } } });
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        expect(await getShadowTextCall(userId, input.requestId)).toEqual(finished);
        expect(JSON.stringify(finished)).not.toContain("private request text");
        expect(JSON.stringify(finished)).not.toContain("private response text");
    });

    it("atomically completes concurrent observations once and detects changed request identity", async () => {
        const input = await publishFixture();
        const calls = await Promise.all([beginShadowTextCall(input), beginShadowTextCall(input)]);
        expect(calls[0]).toEqual(calls[1]);
        const results = await Promise.all(calls.map((call) => finishShadowTextCall(call, { payload: response })));
        expect(results[0]).toEqual(results[1]);
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        await expect(beginShadowTextCall({ ...input, requestFingerprint: "changed" })).rejects.toThrow("不同请求");
        expect(await getShadowTextCall(userId, "unknown-request")).toBeUndefined();
    });

    it("records missing usage, non-text requests, failures and unsupported streams without accumulating zero charges", async () => {
        const input = await publishFixture();
        const missing = await finishShadowTextCall(await beginShadowTextCall(input), { payload: { ...response, usage: {} } });
        expect(missing.result).toMatchObject({ status: "unpriced", reasons: expect.arrayContaining(["缺少 inputTokens 的真实用量"]) });
        const image = await beginShadowTextCall({ ...input, requestId: randomUUID(), payload: { input: [{ role: "user", content: [{ type: "input_image", image_url: "private-image" }] }] } });
        expect((await finishShadowTextCall(image, { payload: response })).result).toMatchObject({ status: "unpriced", reasons: expect.arrayContaining(["调用包含未计价的模态或工具"]) });
        const failed = await beginShadowTextCall({ ...input, requestId: randomUUID() });
        expect((await finishShadowTextCall(failed, { failure: "请求已取消" })).result?.status).toBe("failed");
        const stream = await beginShadowTextCall({ ...input, requestId: randomUUID() });
        expect((await finishShadowTextCall(stream, { unavailable: "流式观察尚未接入" })).result).toMatchObject({ status: "unpriced", reasons: expect.arrayContaining(["流式观察尚未接入"]) });
        const unpriced = await beginShadowTextCall({ ...input, requestId: randomUUID(), modelId: "unpriced-model" });
        expect((await finishShadowTextCall(unpriced, { payload: response })).result).toMatchObject({ status: "unpriced", reasons: expect.arrayContaining(["该逻辑模型尚无已发布的官方价与用户售价"]) });
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });

    it("serializes concurrent tiny calls and keeps the persisted exact total", async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => recordFlatTextShadowPrice(fixture(userId))));
        let charged = new Fraction(0);
        for (const result of results) {
            expect(result.ready).toBe(true);
            if (result.ready) charged = charged.add(result.receipt.accrual.delta);
        }
        expect(charged.toFraction()).toBe("1/100");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/500");
        expect(await getShadowPriceExactTotal("another-user")).toBe("0");
        if (provider === "file") {
            const files = await readdir(join(directory, "model-pricing-shadow"));
            const saved = JSON.parse(await readFile(join(directory, "model-pricing-shadow", files[0]), "utf8"));
            expect(saved.exactPoints).toBe("7/500");
            expect(saved.receipts).toHaveLength(20);
            expect(saved.receipts[0].snapshot.conversion.cnyPerUsd).toBe("7");
        }
    });

    it("deduplicates concurrent retries and rejects changed billing evidence", async () => {
        const input = fixture(userId);
        const [first, second] = await Promise.all([recordFlatTextShadowPrice(input), recordFlatTextShadowPrice(input)]);
        expect(second).toEqual(first);
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        await expect(recordFlatTextShadowPrice({ ...input, requestFingerprint: "changed-body" })).rejects.toThrow("依据已变化");
        await expect(recordFlatTextShadowPrice({ ...input, observation: { ...input.observation, quantities: { ...input.observation.quantities, inputTokens: "2" } } })).rejects.toThrow("依据已变化");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });

    it("carries across sales versions and reverses each frozen amount only once", async () => {
        const first = fixture(userId);
        await recordFlatTextShadowPrice(first);
        const second = fixture(userId);
        second.policy.id = second.call.salesVersionId = "sales-2";
        second.policy.conversion!.cnyPerUsd = "10";
        second.policy.pointsPerCurrency.USD = "1000";
        await recordFlatTextShadowPrice(second);
        expect(await getShadowPriceExactTotal(userId)).toBe("17/10000");
        const [reversed, duplicate] = await Promise.all([reverseShadowPrice(userId, first.requestId), reverseShadowPrice(userId, first.requestId)]);
        expect(duplicate).toEqual(reversed);
        expect(reversed.changeExactPoints).toBe("-7/10000");
        expect(reversed.snapshot.salesVersionId).toBe("sales-1");
        expect(await getShadowPriceExactTotal(userId)).toBe("1/1000");
        await recordFlatTextShadowPrice(first);
        expect(await getShadowPriceExactTotal(userId)).toBe("1/1000");
        await reverseShadowPrice(userId, second.requestId);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });

    it("does not create a zero-price receipt for incomplete usage or a missing original", async () => {
        const input = fixture(userId);
        delete input.observation.quantities.cacheWriteTokens;
        expect(await recordFlatTextShadowPrice(input)).toMatchObject({ ready: false, reasons: expect.arrayContaining(["缺少 cacheWriteTokens 的真实用量"]) });
        await expect(reverseShadowPrice(userId, input.requestId)).rejects.toThrow("没有可撤销");
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        await expect(recordFlatTextShadowPrice({ ...input, requestId: "" })).rejects.toThrow("稳定请求");
    });
});
