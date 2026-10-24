import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getFreshAuthSettings, setAuthSettings } from "@/lib/auth/store";
import { initializePostgresSchema, createPostgresRepositories, postgresQuery } from "@/lib/server/database";
import { createStoredGenerationTask, getStoredGenerationTask } from "./generation-task-store";
import { getCurrentModelPriceBinding, saveModelPriceBinding } from "./model-price-binding-store";
import { saveOfficialPriceObservation } from "./model-pricing-observation-service";
import { listOfficialPriceObservations, reviewOfficialPriceObservation, setOfficialPriceObservationLink } from "./model-pricing-observation-store";
import { createOfficialPriceCandidate, getModelPricingOverview, previewSalesPricing, publishSalesPricing, reviewOfficialPriceCandidate, unbindModelSalesPrice, updateBusinessExchangeRate, updateOfficialPriceSource } from "./model-pricing-service";
import { getCurrentSalesVersion, getOfficialVersionsByIds, listOfficialPriceSources, listPricingPage } from "./model-pricing-store";
import { listFlatTextPriceContracts, saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import { getModelPricingActivation, saveModelPricingActivation } from "./model-pricing-activation-store";

const postgresIt = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;

describe("model pricing publication on isolated PostgreSQL", () => {
    postgresIt("persists per-model activation with a row-locked revision check", async () => {
        await initializePostgresSchema();
        const modelId = `activation-${randomUUID()}`;
        const record = {
            modelId,
            enabled: true,
            revision: randomUUID(),
            fingerprint: "fixture-fingerprint",
            salesVersionId: "sales-fixture",
            officialVersionId: "official-fixture",
            evidence: { shadowReceiptIds: { "contract-fixture": "receipt-fixture" } },
            changedAt: new Date().toISOString(),
            changedBy: "fixture-admin",
        };
        try {
            expect(await getModelPricingActivation(modelId)).toBeUndefined();
            await saveModelPricingActivation(record, null);
            expect(await getModelPricingActivation(modelId)).toEqual(record);
            await expect(saveModelPricingActivation({ ...record, revision: randomUUID() }, null)).rejects.toThrow("刷新");
            const update = { ...record, enabled: false, revision: randomUUID() };
            await saveModelPricingActivation(update, record.revision);
            expect(await getModelPricingActivation(modelId)).toEqual(update);
        } finally {
            await postgresQuery("UPDATE model_pricing_state SET billing_activations = billing_activations - $1::text WHERE id = 'default'", [modelId]);
        }
    });
    postgresIt("keeps one current reviewed text contract and an immutable history", async () => {
        await initializePostgresSchema();
        const officialVersionId = randomUUID();
        await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, now(), $3::jsonb)", [officialVersionId, "fixture-text", JSON.stringify({ id: officialVersionId })]);
        const contract = {
            officialVersionId,
            channelId: "fixture-channel",
            protocol: "openai-responses" as const,
            requestedModel: "fixture-model",
            reportedModel: "fixture-v1",
            scope: "global-standard-text-flat" as const,
            region: "global" as const,
            serviceTier: "default",
            itemMeters: { input: ["inputTokens" as const] },
            evidence: "fixture evidence",
            reservationEstimate: { method: "request-size-recent-output" as const, sourceUrl: "https://example.com/fixture-estimate", evidence: "fixture reviewed estimate" },
            reviewedAt: new Date().toISOString(),
            reviewedBy: "fixture-admin",
        };
        try {
            const first = await saveFlatTextPriceContract(contract, null);
            const second = await saveFlatTextPriceContract({ ...contract, reportedModel: "fixture-v2" }, first.id);
            await expect(saveFlatTextPriceContract(contract, first.id)).rejects.toThrow("刷新");
            const history = await listFlatTextPriceContracts(officialVersionId, contract.channelId, contract.requestedModel);
            expect(history).toMatchObject([
                { id: second.id, current: true, reservationEstimate: contract.reservationEstimate },
                { id: first.id, current: false },
            ]);
        } finally {
            await postgresQuery("DELETE FROM model_flat_text_price_contracts WHERE official_version_id = $1", [officialVersionId]);
            await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [officialVersionId]);
        }
    });

    postgresIt("persists an unmatched official discovery through review and later manual linking", async () => {
        await initializePostgresSchema();
        const manufacturer = `Fixture-${randomUUID()}`;
        const officialModelId = `fixture-model-${randomUUID()}`;
        const sourceUrl = `https://example.com/official/${randomUUID()}`;
        const evidence = `${officialModelId} output 0.05 USD per image`;
        await updateOfficialPriceSource(manufacturer, sourceUrl, null, "reviewer", true);
        const input = {
            manufacturer,
            officialModelId,
            sourceUrl,
            sourceDigest: createHash("sha256").update(evidence).digest("hex"),
            sourceMode: "website",
            observedAt: new Date().toISOString(),
            evidence,
            sourceRowIds: ["fixture-row"],
            conditions: "standard image",
            items: [{ key: "output", unit: "image", per: "1", price: "0.05", currency: "USD" }],
        };
        const saved = await saveOfficialPriceObservation(input, "reviewer");
        expect((await saveOfficialPriceObservation(input, "reviewer")).id).toBe(saved.id);
        expect((await listOfficialPriceObservations(1, manufacturer)).observations).toMatchObject([{ id: saved.id, reviewStatus: "pending" }]);
        await expect(setOfficialPriceObservationLink(saved.id, "future-logical-model", "reviewer")).rejects.toThrow("先审核");
        await reviewOfficialPriceObservation(saved.id, "confirmed", "来源已核对", "reviewer");
        const confirmed = await listOfficialPriceObservations(1, manufacturer);
        expect(confirmed.observations).toMatchObject([{ id: saved.id, reviewStatus: "confirmed", items: [{ price: "0.05" }] }]);
        expect(confirmed.links).toEqual([]);
        await setOfficialPriceObservationLink(saved.id, "future-logical-model", "reviewer");
        expect((await listOfficialPriceObservations(1, manufacturer)).links).toMatchObject([{ observationId: saved.id, logicalModelId: "future-logical-model" }]);
        await setOfficialPriceObservationLink(saved.id, null, "reviewer");
        expect((await listOfficialPriceObservations(1, manufacturer)).links).toEqual([]);
    });

    postgresIt("keeps reviewed prices and published sales immutable while freezing new task identities", async () => {
        await initializePostgresSchema();
        const modelId = `pricing-${randomUUID()}`;
        await setAuthSettings({
            systemChannels: [{ id: "fixture-channel", name: "Fixture", baseUrl: "https://example.com/v1", apiKey: "fixture-key", apiFormat: "openai", models: ["gemini-2.5-flash"], enabled: true }],
            logicalModels: [
                {
                    id: modelId,
                    name: "Flash",
                    capability: "text",
                    manufacturer: "Google",
                    series: "Gemini 2.5",
                    enabled: true,
                    bindings: [{ id: "fixture-binding", channelId: "fixture-channel", upstreamModel: "gemini-2.5-flash", priority: 1, enabled: true }],
                },
            ],
        });
        const settings = await getFreshAuthSettings();
        const planId = settings.entitlements.defaultPlanId;
        const userId = `pricing-user-${randomUUID()}`;
        const now = new Date().toISOString();
        const repositories = createPostgresRepositories();
        await repositories.users.createWithNextAccountId({
            id: userId,
            username: `pricing_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
            displayName: "售价测试",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId,
            pointsBalance: 100,
            passwordHash: "fixture-only",
            createdAt: now,
            updatedAt: now,
        });
        try {
            const input = {
                logicalModelId: modelId,
                manufacturer: "Google",
                series: "Gemini 2.5",
                officialVersion: "gemini-2.5-flash-001",
                sku: "SKU-001",
                tier: "paid",
                conditions: "标准付费档",
                sourceKind: "manual",
                sourceUrl: "https://example.com/pricing",
                evidence: "官方页面截图",
                observedAt: now,
                items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
            };
            const candidate = await createOfficialPriceCandidate(input, "upstream-admin");
            await expect(createOfficialPriceCandidate(input, "upstream-admin")).rejects.toThrow("已有待审核价目");
            for (let index = 0; index < 20; index++) await createOfficialPriceCandidate({ ...input, sku: `SKU-PAGE-${index}` }, "upstream-admin");
            const firstPage = await listPricingPage(modelId, 1, 1);
            const secondPage = await listPricingPage(modelId, 2, 1);
            expect(firstPage.candidates).toHaveLength(20);
            expect(secondPage.candidates.length).toBeGreaterThan(0);
            expect(firstPage.candidateAllTotal).toBeGreaterThanOrEqual(21);
            expect(firstPage.candidateModelIds).toContain(modelId);
            expect(firstPage.manufacturers).toContain("Google");
            expect((await listPricingPage(modelId, 1, 1, { modelId, manufacturer: "Google", status: "pending" })).candidateTotal).toBeGreaterThanOrEqual(21);
            expect((await listPricingPage(modelId, 1, 1, { modelId, manufacturer: "Anthropic" })).candidateTotal).toBe(0);
            expect((await getModelPricingOverview()).officialVersions.some((version) => version.candidateId === candidate.id)).toBe(false);
            await reviewOfficialPriceCandidate(candidate.id, true, "已核对 SKU 与报价单位", "reviewer");
            expect((await listPricingPage(modelId, 1, 1, { status: "approved", modelId })).candidateTotal).toBeGreaterThanOrEqual(1);
            const source = (await listOfficialPriceSources()).find((item) => item.manufacturer === "Google")!;
            const updatedSource = await updateOfficialPriceSource("Google", "https://ai.google.dev/gemini-api/docs/pricing?review=1", source.updatedAt, "reviewer");
            expect((await listOfficialPriceSources()).find((item) => item.manufacturer === "Google")?.url).toBe(updatedSource.url);
            await expect(updateOfficialPriceSource("Google", "https://ai.google.dev/gemini-api/docs/pricing", source.updatedAt, "reviewer")).rejects.toThrow("刷新");
            const newManufacturer = `E2E-${randomUUID()}`;
            const createdSource = await updateOfficialPriceSource(newManufacturer, "https://example.com/official-pricing", null, "reviewer");
            expect((await listOfficialPriceSources()).find((item) => item.manufacturer === newManufacturer)?.url).toBe(createdSource.url);
            await expect(updateOfficialPriceSource(newManufacturer, "https://example.com/changed", null, "reviewer")).rejects.toThrow("刷新");
            await expect(updateOfficialPriceSource("ByteDance", "https://example.com/pricing", null, "reviewer")).rejects.toThrow("ByteDance / Volcengine");
            expect((await listPricingPage(modelId, 2, 1)).candidates.find((item) => item.id === candidate.id)?.sourceUrl).toBe(input.sourceUrl);
            const official = (await getModelPricingOverview(modelId)).officialVersions.find((version) => version.candidateId === candidate.id)!;
            const policy = {
                priceVersionIds: { [modelId]: official.id },
                userPriceRules: [{ scope: "default", coefficient: "0.8" }],
                conversion: { cnyPerUsd: "10", pointsPerCny: "100", observedAt: now, evidence: "测试汇率" },
                pointsPerCurrency: { USD: "1000", CNY: "100" },
                rateEvidence: { USD: "测试汇率", CNY: "测试汇率" },
            };
            await updateBusinessExchangeRate({ cnyPerUsd: "10", observedAt: now, evidence: "测试汇率" }, (await getModelPricingOverview()).exchangeRate?.observedAt || null);
            await expect(updateBusinessExchangeRate({ cnyPerUsd: "7", observedAt: new Date(Date.now() + 1000).toISOString(), evidence: "第二版测试汇率" }, null)).rejects.toThrow("刷新");
            const firstPreview = await previewSalesPricing(policy, modelId, { inputTokens: "100000" });
            expect(firstPreview.quote).toMatchObject({ points: "80.00", userCoefficient: { value: "0.8", scope: "default" } });
            const firstSales = await publishSalesPricing(policy, firstPreview.currentSalesVersionId, firstPreview.previewToken, "billing-admin");
            const firstTaskId = randomUUID();
            await createStoredGenerationTask("text", { id: firstTaskId, userId, status: "pending", config: { logicalModel: modelId }, createdAt: Date.now(), updatedAt: Date.now() }, 60_000);
            const firstTask = await getStoredGenerationTask<{ pricingSnapshot: { planId: string; salesVersionId: string; officialVersionId: string; userCoefficient: string } }>("text", firstTaskId);
            expect(firstTask?.pricingSnapshot).toMatchObject({ planId, salesVersionId: firstSales.id, officialVersionId: official.id, userCoefficient: "0.8" });
            const nextPolicy = { ...policy, userPriceRules: [{ scope: "model", modelId, coefficient: "2" }] };
            const nextPreview = await previewSalesPricing(nextPolicy, modelId, { inputTokens: "100000" });
            expect(nextPreview).toMatchObject({ quote: { points: "200.00" }, oldQuote: { points: "80.00" }, pointsDifference: "120.00" });
            const secondSales = await publishSalesPricing(nextPolicy, nextPreview.currentSalesVersionId, nextPreview.previewToken, "billing-admin");
            await expect(publishSalesPricing(policy, firstPreview.currentSalesVersionId, firstPreview.previewToken, "billing-admin")).rejects.toThrow("重新预览");
            const secondTaskId = randomUUID();
            await createStoredGenerationTask("text", { id: secondTaskId, userId, status: "pending", config: { logicalModel: modelId }, createdAt: Date.now(), updatedAt: Date.now() }, 60_000);
            const secondTask = await getStoredGenerationTask<{ pricingSnapshot: { salesVersionId: string; userCoefficient: string } }>("text", secondTaskId);
            expect(secondTask?.pricingSnapshot).toMatchObject({ salesVersionId: secondSales.id, userCoefficient: "2" });
            expect((await getStoredGenerationTask<{ pricingSnapshot: { salesVersionId: string } }>("text", firstTaskId))?.pricingSnapshot.salesVersionId).toBe(firstSales.id);
            expect((await getModelPricingOverview(modelId)).officialVersions.find((version) => version.id === official.id)).toEqual(official);
            const freeCandidate = await createOfficialPriceCandidate({ ...input, sku: "FREE-EVIDENCE", tier: "free", items: [{ ...input.items[0], price: "0" }] }, "upstream-admin");
            const freeReview = await reviewOfficialPriceCandidate(freeCandidate.id, true, "官方免费事实，无常规售价", "upstream-admin");
            const freePolicy = { ...policy, priceVersionIds: { [modelId]: freeReview.versionId! } };
            const freePreview = await previewSalesPricing(freePolicy, modelId, { inputTokens: "0" });
            await publishSalesPricing(freePolicy, freePreview.currentSalesVersionId, freePreview.previewToken, "billing-admin");
            await expect(previewSalesPricing(freePolicy, modelId, { inputTokens: "100000" })).rejects.toThrow("常规付费单价");
            const paidPreview = await previewSalesPricing(policy, modelId, { inputTokens: "100000" });
            expect(paidPreview).toMatchObject({ quote: { points: "80.00" }, oldQuote: null, pointsDifference: null });
            await publishSalesPricing(policy, paidPreview.currentSalesVersionId, paidPreview.previewToken, "billing-admin");
            expect((await getModelPricingOverview(modelId)).officialVersions.find((version) => version.id === freeReview.versionId)?.items[0].price).toBe("0");
        } finally {
            await repositories.users.delete(userId);
        }
    });

    postgresIt("publishes and releases one independent price without copying its source or changing legacy references", async () => {
        await initializePostgresSchema();
        const modelId = `fixture-price-${randomUUID()}`;
        const manufacturer = `Fixture-${randomUUID()}`;
        const sourceUrl = `https://example.com/pricing/${modelId}`;
        const now = new Date().toISOString();
        const beforeSettings = await getFreshAuthSettings();
        const beforeSales = await getCurrentSalesVersion();
        const channelId = `fixture-channel-${randomUUID()}`;
        await setAuthSettings({
            systemChannels: [...beforeSettings.systemChannels, { id: channelId, name: "Fixture", baseUrl: "https://example.com/v1", apiKey: "fixture-key", apiFormat: "openai", models: [modelId], enabled: true }],
            logicalModels: [
                ...beforeSettings.logicalModels,
                { id: modelId, name: "Independent fixture", capability: "text", manufacturer, series: "", enabled: true, bindings: [{ id: `fixture-binding-${randomUUID()}`, channelId, upstreamModel: modelId, priority: 1, enabled: true }] },
            ],
        });
        expect((await getFreshAuthSettings()).logicalModels.some((model) => model.id === modelId)).toBe(true);
        await updateOfficialPriceSource(manufacturer, sourceUrl, null, "fixture-admin");
        const candidate = await createOfficialPriceCandidate(
            {
                logicalModelId: "",
                capability: "text",
                manufacturer,
                series: "",
                officialVersion: "fixture-v1",
                sku: modelId,
                tier: "paid",
                conditions: "standard",
                sourceKind: "manual",
                sourceUrl,
                evidence: "synthetic reviewed fixture",
                observedAt: now,
                items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
            },
            "fixture-admin",
        );
        const reviewed = await reviewOfficialPriceCandidate(candidate.id, true, "fixture review", "fixture-admin");
        const officialVersionId = reviewed.versionId!;
        const binding = await saveModelPriceBinding(
            { logicalModelId: modelId, capability: "text", operation: "generation", processingMode: "standard", scope: "text:generation:standard", officialVersionId, status: "active", evidence: "fixture binding review", reviewedBy: "fixture-admin" },
            null,
        );
        const selection = { logicalModelId: modelId, scope: binding.scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId };
        const rate = await updateBusinessExchangeRate({ cnyPerUsd: "7", observedAt: now, evidence: "fixture exchange rate" }, (await getModelPricingOverview()).exchangeRate?.observedAt || null);
        const policy = {
            priceVersionIds: beforeSales?.priceVersionIds || {},
            selectedPriceBindings: [...(beforeSales?.selectedPriceBindings || []), selection],
            userPriceRules: [...(beforeSales?.userPriceRules || []), { scope: "model", modelId, coefficient: "1" }],
            conversion: { cnyPerUsd: rate.cnyPerUsd, pointsPerCny: "100", observedAt: rate.observedAt, evidence: rate.evidence },
            rateEvidence: { ...(beforeSales?.rateEvidence || {}), USD: "fixture exchange rate", CNY: "fixture exchange rate" },
        };
        const preview = await previewSalesPricing(policy, modelId, { inputTokens: "1000000" }, binding.scope);
        expect(preview).toMatchObject({ selectedBinding: selection, quote: { modelId, officialVersionId, points: "700.00" } });
        const published = await publishSalesPricing(policy, beforeSales?.id || null, preview.previewToken, "fixture-admin");
        expect((await getCurrentSalesVersion())?.selectedPriceBindings).toContainEqual(selection);
        expect(published.priceVersionIds).toEqual(beforeSales?.priceVersionIds || {});
        expect(await getCurrentModelPriceBinding(modelId, binding.scope)).toEqual(binding);
        expect(await getOfficialVersionsByIds([officialVersionId])).toMatchObject([{ id: officialVersionId, logicalModelId: "" }]);
        expect((await postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_official_price_versions WHERE data->>'candidateId' = $1", [candidate.id])).rows[0]?.count).toBe("1");

        await saveModelPriceBinding({ ...binding, status: "revoked", officialVersionId: null, evidence: "fixture release" }, binding.revision);
        await expect(previewSalesPricing(policy, modelId, { inputTokens: "1000000" }, binding.scope)).rejects.toThrow("已变化");
        const released = await unbindModelSalesPrice(modelId, published.id, "fixture-admin", binding.scope);
        expect(released.selectedPriceBindings?.some((item) => item.logicalModelId === modelId)).toBe(false);
        expect(released.priceVersionIds).toEqual(beforeSales?.priceVersionIds || {});
        expect(await getOfficialVersionsByIds([officialVersionId])).toHaveLength(1);
        expect((await postgresQuery<{ count: string }>("SELECT count(*)::text AS count FROM model_official_price_versions WHERE data->>'candidateId' = $1", [candidate.id])).rows[0]?.count).toBe("1");
    });
});
