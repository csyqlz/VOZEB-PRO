import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fraction from "fraction.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import * as dataAdapter from "./data-adapter";
import { ModelPricingShadowRepository } from "./database/model-pricing-shadow-repository";
import { saveImagePriceContract } from "./model-pricing-image-contract-store";
import { getModelPricingAdmission } from "./model-pricing-admission";
import { setModelPricingActivation } from "./model-pricing-activation-service";
import { beginShadowImageCall, finishShadowImageCall, revalueShadowImageCall } from "./model-pricing-shadow-image-call";
import { beginShadowTextCall, finishShadowTextCall } from "./model-pricing-shadow-call";
import { getShadowImageCall, getShadowPriceExactTotal, getUnpricedImageShadowCalls, mutateShadowImageCall } from "./model-pricing-shadow-store";
import { inspectOpenAiImageUsage } from "./model-pricing-image-usage";
import { getModelPricingShadowEvidence, revalueSavedImageEvidence } from "./model-pricing-shadow-evidence";
import { getShadowBillingSource } from "./model-pricing-shadow-refund";
import { mutatePricingState } from "./model-pricing-store";
import { reverseShadowPrice } from "./model-pricing-shadow-service";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const payload = {
    data: [{ b64_json: "PRIVATE_IMAGE", revised_prompt: "PRIVATE_REPLY" }],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 0 } },
};
const publishedAt = "2026-10-01T00:00:00Z";
describe.each(providers)("image shadow lifecycle (%s)", (provider) => {
    let directory: string;
    let userId: string;
    let authFixture = false;
    const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-image-shadow-"));
        process.env.VOZEB_PRO_DATA_DIR = directory;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
        userId = randomUUID();
        authFixture = false;
        if (provider === "postgres") {
            await initializePostgresSchema();
            const settings = await getFreshAuthSettings();
            const now = new Date().toISOString();
            await createPostgresRepositories().users.createWithNextAccountId({
                id: userId,
                username: `shadow_${userId}`,
                displayName: "图片影子测试",
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
        vi.unstubAllEnvs();
        if (provider === "postgres") {
            expect((await createPostgresRepositories().users.getById(userId))?.pointsBalance).toBe(0.25);
            expect((await postgresQuery("SELECT id FROM point_records WHERE user_id = $1", [userId])).rows).toEqual([]);
            await createPostgresRepositories().users.delete(userId);
        } else {
            const files = await readdir(directory);
            if (!authFixture) expect(files).not.toContain("auth.json");
        }
        if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
        if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = original.directory;
        await rm(directory, { recursive: true, force: true });
    });
    const input = (operation = "generations") => ({
        userId,
        requestId: randomUUID(),
        requestFingerprint: "server-owned-digest",
        modelId: "image-model",
        channelId: "channel",
        requestedModel: "image",
        path: ["v1", "images", operation],
        payload: { model: "image", prompt: "PRIVATE_PROMPT", image: "PRIVATE_REFERENCE" },
    });
    async function publish(coefficient = "1", operation: "generations" | "edits" = "generations", perImage = false) {
        const version: OfficialPriceVersion = {
            id: randomUUID(),
            candidateId: "fixture",
            logicalModelId: "image-model",
            manufacturer: "Fixture",
            series: "Image",
            officialVersion: "image",
            sku: perImage ? "flux-kontext-pro" : "image",
            tier: "paid",
            conditions: "Synthetic global standard direct image tokens",
            sourceKind: "manual",
            sourceUrl: "https://example.com/fixture",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "fixture-admin",
            items: perImage
                ? [{ key: "image", unit: "image", per: "1", price: "0.04", currency: "USD" }]
                : [
                      { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                      { key: "output", unit: "token", per: "1000000", price: "1", currency: "USD" },
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
        const contract = await saveImagePriceContract(
            {
                officialVersionId: version.id,
                channelId: "channel",
                requestedModel: "image",
                reportedModel: "image",
                modelIdentity: "reviewed-request",
                protocol: "openai-images",
                operation,
                scope: "global-standard-direct-image-tokens",
                region: "global",
                itemMeters: { input: ["inputTextTokens", "inputImageTokens"], output: ["outputImageTokens"] },
                zeroMeters: ["outputTextTokens"],
                holdEstimate: { meterQuantities: { inputTextTokens: "1", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-estimate", evidence: "fixture reviewed estimate" },
                evidence: "Synthetic native channel proof",
                reviewedAt: publishedAt,
                reviewedBy: "fixture-admin",
            },
            null,
        );
        if (perImage)
            return {
                version,
                policy,
                contract: await saveImagePriceContract(
                    {
                        ...contract,
                        requestedModel: "flux-kontext-pro",
                        reportedModel: "flux-kontext-pro",
                        scope: "global-standard-dataeyes-flux-image",
                        itemMeters: {},
                        zeroMeters: [],
                        holdEstimate: undefined,
                        imageLimit: { maxImages: 1, sourceUrl: "https://example.com/fixture", evidence: "single image fixture" },
                    },
                    null,
                ),
            };
        return { version, policy, contract };
    }
    it.skipIf(provider !== "file").each(["generations", "edits"] as const)("prices an ownerless selected %s call and leaves the original receipt frozen after rebinding", async (operation) => {
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        const first = await publish("1", operation);
        const modelId = "image";
        authFixture = true;
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "channel", name: "Fixture", baseUrl: "https://example.com", apiKey: "fixture-key", apiFormat: "openai", models: [modelId], enabled: true }];
        db.settings.logicalModels = [{ id: modelId, name: "Shared image", manufacturer: "Fixture", capability: "image", enabled: true, bindings: [{ id: "channel:image", channelId: "channel", upstreamModel: modelId, enabled: true, priority: 0 }] }];
        await writeAuthDb(db);
        const version = { ...first.version, logicalModelId: "", capability: "image" as const };
        const priceSelection = { logicalModelId: modelId, scope: `image:${operation}:standard`, bindingId: "image-binding", bindingRevision: "first-revision", officialVersionId: version.id };
        const policy = { ...first.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId, coefficient: "2" }] };
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
                        operation,
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
        const request = { ...input(operation), modelId };
        const call = await beginShadowImageCall(request);
        expect(call).toMatchObject({ reasons: [], frozen: { priceSelection } });
        expect(await getModelPricingShadowEvidence(modelId, version.id, [first.contract.id], "channel")).toMatchObject({ ready: false, missingCount: 1, sample: null });
        const finished = await finishShadowImageCall(call, { payload });
        expect(finished.result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/5000");
        expect(await getModelPricingShadowEvidence(modelId, version.id, [first.contract.id], "channel")).toMatchObject({ ready: true, missingCount: 0 });
        const historical = await beginShadowImageCall({ ...request, requestId: `system-ai:${randomUUID()}`, requestFingerprint: "a".repeat(64) });
        const observed = inspectOpenAiImageUsage({
            ...payload,
            usage: { ...payload.usage, input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 0 }, output_tokens_details: { ...payload.usage.output_tokens_details, reasoning_tokens: 0 } },
        });
        const unknown = ["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"];
        await mutateShadowImageCall(historical.userId, historical.requestId, (saved) => ({
            call: {
                ...saved!,
                result: {
                    status: "unpriced",
                    reasons: [`上游用量无效：未解释的图片用量字段：${unknown.join("、")}`],
                    completedAt: new Date().toISOString(),
                    observation: { ...observed, invalid: [`未解释的图片用量字段：${unknown.join("、")}`], unmappedUsageFields: unknown },
                },
            },
        }));
        const billed = await readAuthDb();
        billed.pointRecords.push({
            id: randomUUID(),
            userId,
            type: "consume",
            amount: -1,
            balanceAfter: 9,
            permanentAmount: -1,
            dailyAmount: 0,
            permanentBalanceAfter: 9,
            dailyBalanceAfter: 0,
            description: "fixture",
            model: modelId,
            idempotencyKey: historical.requestId,
            requestFingerprint: historical.requestFingerprint,
            createdAt: new Date().toISOString(),
        });
        await writeAuthDb(billed);
        expect((await getModelPricingAdmission(modelId, undefined, undefined, operation)).blockers).toEqual([]);
        expect(await getUnpricedImageShadowCalls(modelId, [first.contract.id], "channel")).toHaveLength(1);
        expect(await getShadowBillingSource({ requestId: historical.requestId })).toMatchObject({ type: "consume", userId, model: modelId, requestFingerprint: historical.requestFingerprint });
        expect((await revalueSavedImageEvidence(modelId, "channel/image", operation)).revalued).toBe(1);
        expect((await revalueSavedImageEvidence(modelId, "channel/image", operation)).revalued).toBe(0);
        expect(await getShadowPriceExactTotal(userId)).toBe("7/2500");
        const stale = await beginShadowImageCall({ ...request, requestId: `system-ai:${randomUUID()}`, requestFingerprint: "b".repeat(64) });
        const originalResult = (await getShadowImageCall(userId, historical.requestId))?.result;
        await mutateShadowImageCall(stale.userId, stale.requestId, (saved) => ({ call: { ...saved!, result: originalResult } }));
        const billedAgain = await readAuthDb();
        billedAgain.pointRecords.push({ ...billed.pointRecords.at(-1)!, id: randomUUID(), idempotencyKey: stale.requestId, requestFingerprint: stale.requestFingerprint });
        await writeAuthDb(billedAgain);
        await mutatePricingState((state) => ({
            next: { ...state, salesVersions: [...state.salesVersions, { ...policy, id: randomUUID(), userPriceRules: [{ scope: "model", modelId, coefficient: "3" }] }] },
            result: undefined,
        }));
        expect((await getModelPricingAdmission(modelId, undefined, undefined, operation)).blockers).toEqual([]);
        expect(await getUnpricedImageShadowCalls(modelId, [first.contract.id], "channel")).toHaveLength(1);
        expect((await revalueSavedImageEvidence(modelId, "channel/image", operation)).revalued).toBe(0);
        expect((await getShadowImageCall(userId, stale.requestId))?.revaluation).toBeUndefined();
        expect(await getShadowPriceExactTotal(userId)).toBe("7/2500");
        await mutatePricingState((state) => ({ next: { ...state, priceBindings: state.priceBindings?.map((binding) => ({ ...binding, revision: "changed" })) }, result: undefined }));
        expect((await beginShadowImageCall({ ...request, requestId: randomUUID() })).reasons).toContain("该图片逻辑模型尚无已发布的官方价与用户售价");
        expect((await finishShadowImageCall(call, { payload })).result).toEqual(finished.result);
        expect(await getShadowPriceExactTotal(userId)).toBe("7/2500");
    });
    it.skipIf(provider !== "file")("keeps shared image price shadow receipts separate for two logical models", async () => {
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        const first = await publish();
        const modelIds = ["image-standard", "image-premium"];
        authFixture = true;
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "channel", name: "Fixture", baseUrl: "https://example.com", apiKey: "fixture-key", apiFormat: "openai", models: ["image"], enabled: true }];
        db.settings.logicalModels = modelIds.map((id) => ({ id, name: id, manufacturer: "Fixture", capability: "image", enabled: true, bindings: [{ id: `${id}-channel`, channelId: "channel", upstreamModel: "image", enabled: true, priority: 0 }] }));
        await writeAuthDb(db);
        const version = { ...first.version, logicalModelId: "", capability: "image" as const };
        const scope = "image:generations:standard";
        const bindings = modelIds.map((logicalModelId) => ({
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId,
            capability: "image" as const,
            operation: "generations" as const,
            processingMode: "standard" as const,
            scope,
            officialVersionId: version.id,
            status: "active" as const,
            current: true,
            evidence: "shared price fixture",
            reviewedAt: publishedAt,
            reviewedBy: "fixture-admin",
        }));
        const policy = {
            ...first.policy,
            priceVersionIds: {},
            selectedPriceBindings: bindings.map((binding) => ({ logicalModelId: binding.logicalModelId, scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: version.id })),
            userPriceRules: [{ scope: "model" as const, modelId: modelIds[1], coefficient: "2" }],
        };
        await mutatePricingState((state) => ({ next: { ...state, officialVersions: [version], salesVersions: [policy], priceBindings: bindings }, result: undefined }));
        expect((await getModelPricingAdmission(modelIds[0], undefined, undefined, "generations")).structuralComplete).toBe(true);
        expect((await getModelPricingAdmission(modelIds[1], undefined, undefined, "generations")).structuralComplete).toBe(true);
        const firstCall = await beginShadowImageCall({ ...input(), modelId: modelIds[0] });
        expect((await finishShadowImageCall(firstCall, { payload })).result?.status).toBe("priced");
        expect(await getModelPricingShadowEvidence(modelIds[0], version.id, [first.contract.id], "channel")).toMatchObject({ ready: true, missingCount: 0 });
        expect(await getModelPricingShadowEvidence(modelIds[1], version.id, [first.contract.id], "channel")).toMatchObject({ ready: false, missingCount: 1 });
        expect((await setModelPricingActivation({ modelId: modelIds[0], enabled: true, expectedRevision: null, actorId: "fixture-admin", imageOperation: "generations" })).active).toBe(true);
        await expect(setModelPricingActivation({ modelId: modelIds[1], enabled: true, expectedRevision: null, actorId: "fixture-admin", imageOperation: "generations" })).rejects.toThrow("等待真实调用");
        const secondCall = await beginShadowImageCall({ ...input(), modelId: modelIds[1] });
        expect((await finishShadowImageCall(secondCall, { payload })).result?.status).toBe("priced");
        expect((await setModelPricingActivation({ modelId: modelIds[1], enabled: true, expectedRevision: null, actorId: "fixture-admin", imageOperation: "generations" })).active).toBe(true);
        expect(await getShadowPriceExactTotal(userId)).toBe("21/10000");
    });
    it.each([false, true])("retains the original free exclusion while later evidence changes (per-image=%s)", async (perImage) => {
        const { version, policy } = await publish("1", "generations", perImage);
        const request = perImage ? { ...input(), requestedModel: "flux-kontext-pro", declaredProtocol: "dataeyes-flux", payload: { model: "flux-kontext-pro" } } : input();
        const original = await beginShadowImageCall(request);
        const zero = { ...version, items: version.items.map((item) => ({ ...item, price: "0" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [version.id, JSON.stringify(zero)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [zero], salesVersions: [policy] });
        const next = { ...request, requestId: randomUUID() };
        const excluded = await beginShadowImageCall(next);
        expect(excluded.reasons).toContainEqual(expect.stringContaining("固定积分"));
        await publish("1", "generations", perImage);
        expect(await beginShadowImageCall(next)).toEqual(excluded);
        const result = perImage ? { data: [{ url: "https://example.com/original.png" }] } : payload;
        expect((await finishShadowImageCall(excluded, { payload: result })).result?.status).toBe("unpriced");
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        expect((await finishShadowImageCall(original, { payload: result })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe(perImage ? "28" : "7/10000");
    });

    it.each(["generations", "edits"] as const)("freezes %s before a price or contract update and uses the saved snapshot", async (operation) => {
        const first = await publish("1", operation);
        const request = input(operation);
        const [call, concurrent] = await Promise.all([beginShadowImageCall(request), beginShadowImageCall(request)]);
        expect(call).toEqual(concurrent);
        await saveImagePriceContract({ ...first.contract, evidence: "later contract", modelIdentity: "response-required" }, first.contract.id);
        await publish("2", operation);
        expect(await beginShadowImageCall(request)).toEqual(call);
        call.frozen!.version.items[0].price = "999";
        const finished = await finishShadowImageCall(call, { payload });
        expect(finished.result).toMatchObject({ status: "priced", receiptId: expect.any(String) });
        expect(finished.frozen?.version.items[0].price).toBe("1");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        const next = await beginShadowImageCall(input(operation));
        await finishShadowImageCall(next, { payload });
        expect(await getShadowPriceExactTotal(userId)).toBe("21/10000");
        await Promise.all([finishShadowImageCall(call, { payload }), finishShadowImageCall(call, { failure: "late failure" })]);
        expect((await getShadowImageCall(userId, request.requestId))?.result).toEqual(finished.result);
        expect(await getShadowPriceExactTotal(userId)).toBe("21/10000");
        const content =
            provider === "postgres"
                ? JSON.stringify((await postgresQuery("SELECT data FROM model_pricing_shadow_calls WHERE user_id = $1", [userId])).rows)
                : await readFile(join(directory, "model-pricing-shadow", (await readdir(join(directory, "model-pricing-shadow")))[0]), "utf8");
        for (const secret of ["PRIVATE_PROMPT", "PRIVATE_REFERENCE", "PRIVATE_IMAGE", "PRIVATE_REPLY"]) expect(content).not.toContain(secret);
    });
    it("revalues only saved zero-only metadata with an append-only receipt and leaves the original result intact", async () => {
        const { version, contract } = await publish();
        const call = await beginShadowImageCall(input());
        const observed = inspectOpenAiImageUsage({
            ...payload,
            usage: { ...payload.usage, input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 0 }, output_tokens_details: { ...payload.usage.output_tokens_details, reasoning_tokens: 0 } },
        });
        const oldUnknown = ["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"];
        const original = {
            status: "unpriced" as const,
            reasons: [`上游用量无效：未解释的图片用量字段：${oldUnknown.join("、")}`],
            completedAt: new Date().toISOString(),
            observation: { ...observed, invalid: [`未解释的图片用量字段：${oldUnknown.join("、")}`], unmappedUsageFields: oldUnknown },
        };
        await mutateShadowImageCall(call.userId, call.requestId, (saved) => ({ call: { ...saved!, result: original } }));
        expect(await getUnpricedImageShadowCalls(call.modelId, [contract.id], call.channelId)).toHaveLength(1);
        const revalued = await revalueShadowImageCall(call);
        expect(revalued.result).toEqual(original);
        expect(revalued.revaluation).toMatchObject({ receiptId: expect.any(String), rule: "direct-images-zero-metadata-v1" });
        expect(await getModelPricingShadowEvidence(call.modelId, version.id, [contract.id], call.channelId)).toMatchObject({ ready: true, missingCount: 0, receiptIds: { [contract.id]: revalued.revaluation!.receiptId } });
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        expect((await revalueShadowImageCall(call)).revaluation?.receiptId).toBe(revalued.revaluation?.receiptId);
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        expect(await getUnpricedImageShadowCalls(call.modelId, [contract.id], call.channelId)).toHaveLength(0);
    });
    it("persists reference dimensions without reference bytes and reuses them on the same request", async () => {
        const request = { ...input("edits"), referenceImages: [{ width: 13, height: 17 }, null] };
        const call = await beginShadowImageCall(request);
        expect((await getShadowImageCall(userId, request.requestId))?.referenceImages).toEqual(request.referenceImages);
        expect((await beginShadowImageCall({ ...request, referenceImages: [] })).referenceImages).toEqual(request.referenceImages);
        const content =
            provider === "postgres"
                ? JSON.stringify((await postgresQuery("SELECT data FROM model_pricing_shadow_calls WHERE user_id = $1", [userId])).rows)
                : await readFile(join(directory, "model-pricing-shadow", (await readdir(join(directory, "model-pricing-shadow")))[0]), "utf8");
        expect(content).toMatch(/"width"\s*:\s*13/);
        expect(content).not.toContain("PRIVATE_REFERENCE");
    });
    it("commits concurrent tiny calls and their reversals exactly once without wallet writes", async () => {
        await publish();
        const count = Math.ceil(0.01 / 0.0007);
        const calls = await Promise.all(Array.from({ length: count }, () => beginShadowImageCall(input())));
        const results = await Promise.all(calls.flatMap((call) => [finishShadowImageCall(call, { payload }), finishShadowImageCall(call, { payload })]));
        expect(new Set(results.map((call) => call.result?.receiptId)).size).toBe(count);
        expect(await getShadowPriceExactTotal(userId)).toBe(new Fraction("7/10000").mul(count).toFraction());
        await publish("9");
        const reversal = await reverseShadowPrice(userId, calls[0].requestId);
        expect(reversal.changeExactPoints).toBe("-7/10000");
        expect(await reverseShadowPrice(userId, calls[0].requestId)).toEqual(reversal);
        expect(await getShadowPriceExactTotal(userId)).toBe(new Fraction("7/10000").mul(count - 1).toFraction());
    });
    it("rolls back a failed result commit and recovers with the same frozen call", async () => {
        await publish();
        const call = await beginShadowImageCall(input());
        const failure = provider === "postgres" ? vi.spyOn(ModelPricingShadowRepository.prototype, "saveCall") : vi.spyOn(dataAdapter, "writeJsonDataFile");
        failure.mockRejectedValueOnce(new Error("fixture commit failure"));
        try {
            await expect(finishShadowImageCall(call, { payload })).rejects.toThrow("fixture commit failure");
        } finally {
            failure.mockRestore();
        }
        expect(await getShadowImageCall(userId, call.requestId)).toEqual(call);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        if (provider === "postgres") expect((await postgresQuery("SELECT kind FROM model_pricing_shadow_receipts WHERE user_id = $1 AND request_id = $2", [userId, call.requestId])).rows).toEqual([]);
        expect((await finishShadowImageCall(call, { payload })).result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
        const text = await beginShadowTextCall({ ...input(), path: ["chat", "completions"], payload: { model: "image", messages: [{ role: "user", content: "PRIVATE_TEXT" }] } });
        await finishShadowTextCall(text, { failure: "fixture unpriced text" });
        expect((await getShadowImageCall(userId, call.requestId))?.result?.status).toBe("priced");
        expect(await getShadowPriceExactTotal(userId)).toBe("7/10000");
    });
    it("never retroactively prices an attempt missing its original contract or operation coverage", async () => {
        await publish("1", "edits");
        const request = input();
        const call = await beginShadowImageCall(request);
        expect(call.reasons).toContain("当前渠道、型号和图片操作尚无已审核契约");
        await publish();
        expect(await beginShadowImageCall(request)).toEqual(call);
        expect((await finishShadowImageCall(call, { payload })).result?.status).toBe("unpriced");
        for (const path of [["responses"], ["models", "image:generateContent"], ["custom", "images"]]) {
            const other = await beginShadowImageCall({ ...input(), path });
            expect((await finishShadowImageCall(other, { payload })).result?.status).toBe("unpriced");
        }
        const custom = await beginShadowImageCall({ ...input(), adapted: true });
        expect((await finishShadowImageCall(custom, { payload })).result?.status).toBe("unpriced");
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("keeps incomplete, conflicting, failed and unsupported usage unpriced", async () => {
        await publish();
        const outcomes = [{ payload: {} }, { payload: { ...payload, usage: { ...payload.usage, total_tokens: 2 } } }, { payload: { ...payload, data: [], task_id: "async-id" } }, { failure: "connection failure" }, { unavailable: "unsupported stream" }];
        for (const outcome of outcomes) {
            const call = await beginShadowImageCall(input());
            expect((await finishShadowImageCall(call, outcome)).result?.status).not.toBe("priced");
        }
        for (const extra of [{ stream: true }, { stream: "true" }, { inference_geo: "us" }, { inference_geo: 42 }, { batch: true }, { background: true }, { service_tier: "priority" }, { tools: [{}] }, { prompt_cache_key: "unknown-cache" }]) {
            const call = await beginShadowImageCall({ ...input(), payload: { model: "image", ...extra } });
            expect((await finishShadowImageCall(call, { payload })).result?.status).toBe("unpriced");
        }
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
    it("rejects changed request identity and cross-capability reuse before overwriting the original", async () => {
        await publish();
        const request = input();
        const call = await beginShadowImageCall(request);
        for (const patch of [{ requestFingerprint: "changed" }, { channelId: "fallback" }, { requestedModel: "other" }, { path: ["images", "edits"] }]) await expect(beginShadowImageCall({ ...request, ...patch })).rejects.toThrow("不同请求");
        await expect(beginShadowTextCall({ ...request, path: ["chat", "completions"] })).rejects.toThrow("不同请求");
        await expect(finishShadowImageCall({ ...call, requestFingerprint: "changed" }, { payload })).rejects.toThrow("不同请求");
        expect(await getShadowImageCall(userId, request.requestId)).toEqual(call);
    });
    it.each(["generations", "edits"] as const)("freezes reviewed per-image %s and counts actual results independently from n", async (operation) => {
        const first = await publish("1", operation, true);
        const request = { ...input(operation), requestedModel: "flux-kontext-pro", declaredProtocol: "dataeyes-flux", payload: { model: "flux-kontext-pro", n: 9 } };
        const [call, same] = await Promise.all([beginShadowImageCall(request), beginShadowImageCall(request)]);
        expect(same).toEqual(call);
        expect(call.frozen?.contract.imageLimit?.maxImages).toBe(1);
        await publish("2", operation, true);
        const result = { data: [{ url: "https://example.com/PRIVATE_MEDIA" }] };
        await Promise.all([finishShadowImageCall(call, { payload: result }), finishShadowImageCall(call, { payload: result })]);
        const saved = await getShadowImageCall(userId, request.requestId);
        expect(saved).toMatchObject({ frozen: { policy: { id: first.policy.id } }, result: { status: "priced", observation: { quantities: { images: "1" } } } });
        expect(JSON.stringify(saved)).not.toContain("PRIVATE_MEDIA");
        expect(await getShadowPriceExactTotal(userId)).toBe("28");
        await expect(beginShadowImageCall({ ...request, declaredProtocol: "openai" })).rejects.toThrow("不同请求");
        expect((await reverseShadowPrice(userId, request.requestId)).changeExactPoints).toBe("-28");
        await reverseShadowPrice(userId, request.requestId);
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
        for (const outcome of [{ payload: { data: [...result.data, ...result.data] } }, { payload: {} }, { failure: "unknown upstream outcome" }]) {
            const next = await beginShadowImageCall({ ...request, requestId: randomUUID() });
            expect((await finishShadowImageCall(next, outcome)).result?.status).not.toBe("priced");
        }
        const changed = await beginShadowImageCall({ ...request, requestId: randomUUID(), declaredProtocol: "openai" });
        expect((await finishShadowImageCall(changed, { payload: result })).result?.status).toBe("unpriced");
        expect(await getShadowPriceExactTotal(userId)).toBe("0");
    });
});
