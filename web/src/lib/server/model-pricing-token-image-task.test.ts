vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: async () => ({ ready: true, missingCount: 0, receiptIds: { fixture: "receipt" }, sample: null }) }));
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), user: vi.fn() }));
vi.mock("next/server", async (load) => ({ ...(await load<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/auth/store", async (load) => ({ ...(await load<typeof import("@/lib/auth/store")>()), getAuthSettings: mocks.settings }));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));

import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { POST as proxyPost } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { writeJsonDataFile } from "./data-adapter";
import { createImageTask, getImageTask } from "./image-task-store";
import { createImageTaskUpstreamStep, persistImageTaskResult } from "./image-task-runtime";
import { toSystemGenerationChannel } from "./generation-channel";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { listImagePriceContracts, saveImagePriceContract } from "./model-pricing-image-contract-store";
import { publicModelPricingMode, setModelPricingActivation } from "./model-pricing-activation-service";
import { readPricingState } from "./model-pricing-store";
import { getModelPriceReservation } from "./model-pricing-wallet-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { linkStoredGenerationTask, summarizeStoredGenerationTaskCosts } from "./generation-task-store";
import { getGenerationRunBillingSummary } from "./generation-run-billing-service";
import { summarizeGenerationRunChargeDetails } from "./generation-task-charge-attribution";
import * as internal from "./internal-origin";

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";

describe("direct Images Token billing through the task proxy", () => {
    let directory: string;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let fixtureOptions: { imageResponse: Record<string, unknown> };
    let userId: string;
    let taskId: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-token-image-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-that-is-long-enough");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixtureOptions = {
            imageResponse: {
                data: [{ b64_json: imageData }],
                usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, input_tokens_details: { text_tokens: 1000, image_tokens: 0, cached_tokens: 0 }, output_tokens_details: { text_tokens: 0, image_tokens: 1000, reasoning_tokens: 0 } },
            },
        };
        fixture = createProtocolFixtureServer(fixtureOptions);
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind");
        const origin = `http://127.0.0.1:${address.port}`;
        userId = randomUUID();
        const publishedAt = new Date(Date.now() - 60_000).toISOString();
        const version: OfficialPriceVersion = {
            id: randomUUID(),
            candidateId: "fixture",
            logicalModelId: "gpt-image-2",
            manufacturer: "OpenAI",
            series: "GPT Image 2",
            officialVersion: "gpt-image-2",
            sku: "gpt-image-2",
            tier: "paid",
            conditions: "OpenAI API Standard direct Images",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [
                { key: "inputTextTokens", unit: "token", per: "1000000", price: "5", currency: "USD" },
                { key: "inputImageTokens", unit: "token", per: "1000000", price: "8", currency: "USD" },
                { key: "outputImageTokens", unit: "token", per: "1000000", price: "30", currency: "USD" },
            ],
        };
        const policy: SalesVersion = {
            id: randomUUID(),
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "gpt-image-2": version.id },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        const db = emptyDb();
        db.settings = structuredClone(db.settings);
        db.settings.freeDailyPointsEnabled = false;
        db.settings.entitlements.enabled = false;
        db.settings.systemChannels = [{ id: "channel", name: "fixture", baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", models: ["gpt-image-2"], enabled: true }];
        db.settings.logicalModels = [{ id: "gpt-image-2", name: "gpt-image-2", manufacturer: "OpenAI", capability: "image", enabled: true, bindings: [{ id: "binding", channelId: "channel", upstreamModel: "gpt-image-2", enabled: true, priority: 0 }] }];
        db.users.push({
            id: userId,
            accountId: "0001",
            username: "fixture",
            displayName: "fixture",
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId: db.settings.entitlements.defaultPlanId,
            pointsBalance: 100,
            passwordHash: "fixture-only",
            createdAt: publishedAt,
            updatedAt: publishedAt,
        });
        mocks.user.mockResolvedValue(db.users[0]);
        mocks.settings.mockResolvedValue(db.settings);
        await writeAuthDb(db);
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        for (const operation of ["generations", "edits"] as const)
            await saveImagePriceContract(
                {
                    officialVersionId: version.id,
                    channelId: "channel",
                    requestedModel: "gpt-image-2",
                    reportedModel: "gpt-image-2",
                    modelIdentity: "reviewed-request",
                    protocol: "openai-images",
                    operation,
                    scope: "global-standard-direct-image-tokens",
                    region: "global",
                    itemMeters: { inputTextTokens: ["inputTextTokens"], inputImageTokens: ["inputImageTokens"], outputImageTokens: ["outputImageTokens"] },
                    zeroMeters: ["outputTextTokens"],
                    holdEstimate: { meterQuantities: { inputTextTokens: "285", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" }, sourceUrl: "https://example.com/image-token-estimate", evidence: "fixture reviewed modal estimate" },
                    evidence: "direct Images fixture",
                    reviewedBy: "admin",
                    reviewedAt: publishedAt,
                },
                null,
            );
        const activated = await setModelPricingActivation({
            modelId: "gpt-image-2",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: { fixtures: "Local direct Images proxy and wallet fixture", realChannels: { "channel/gpt-image-2": "Local channel fixture" }, entrypoints: "Generation task fixture", recovery: "Saved response fixture" },
        });
        const task = await createImageTask({
            userId,
            username: "fixture",
            displayName: "fixture",
            billingMode: "official-usage",
            billingApproval: { billingMode: "official-usage", fingerprint: activated.admission.fingerprint!, salesVersionId: policy.id, officialVersionId: version.id, bindingKeys: ["channel/gpt-image-2"] },
            kind: "generation",
            source: "image-workbench",
            config: { baseUrl: "/api/ai/system/channel", apiKey: "", model: "gpt-image-2", logicalModel: "gpt-image-2", channelId: "channel", apiFormat: "openai", size: "64x64" },
            prompt: "private prompt",
            references: [],
        });
        taskId = task.id;
        vi.spyOn(internal, "fetchInternalApi").mockImplementation(async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const parts = new URL(request.url).pathname.split("/").filter(Boolean);
            return proxyPost(request, { params: Promise.resolve({ channelId: parts[3], path: parts.slice(4) }) });
        });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        fixture?.server.closeAllConnections();
        if (fixture) await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("saves the image and settles the frozen Standard prices once", async () => {
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await linkStoredGenerationTask("image", taskId, { runId: "run-one", projectId: "project-one" });
        const task = (await getImageTask(taskId))!;
        expect(task.billingMode).toBe("official-usage");
        const step = await createImageTaskUpstreamStep(task, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        expect(await persistImageTaskResult((await getImageTask(taskId))!, "http://internal", step.resultUrl)).toMatchObject({ status: "success" });
        expect(warnings).toHaveBeenCalledWith("Image output pixels differ from request", expect.objectContaining({ taskId, requestedSize: "816x816", sourceSize: "2x2" }));
        const reference = (await getImageTask(taskId))!.billingRequests![0];
        expect(await getModelPriceReservation({ userId, ...reference })).toMatchObject({ status: "settled", estimatedHold: { heldPoints: "1.00" }, settlement: { chargedPoints: "24.50" } });
        expect((await getImageTask(taskId))!.usageObservations?.at(-1)?.observation).toMatchObject({ zeroOnlyUsageFields: ["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"] });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("75.5");
        const settledReservation = await getModelPriceReservation({ userId, ...reference });
        expect((await readAuthDb()).pointRecords.find((record) => record.id === settledReservation?.chargeRecordId)).toMatchObject({ amount: -24.5 });
        expect(await summarizeGenerationRunChargeDetails(userId, "run-one", ["image"])).toMatchObject([{ chargedPoints: 24.5, refundedPoints: 0, actualPoints: 24.5 }]);
        expect(await getGenerationRunBillingSummary(userId, "run-one")).toMatchObject({ chargedPoints: 24.5, refundedPoints: 0, actualPoints: 24.5, pendingHeldPoints: 0 });
        expect(await summarizeStoredGenerationTaskCosts({ userId, projectId: "project-one", types: ["image"] })).toMatchObject([{ actualPoints: 24.5 }]);
        await createImageTaskUpstreamStep((await getImageTask(taskId))!, "http://internal", "http://public");
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path === "/v1/images/generations")).toHaveLength(1);
    });

    it("omits auto size upstream, reserves its reviewed sample, and settles reported usage", async () => {
        const state = await readPricingState();
        const version = state.officialVersions[0];
        const previous = (await listImagePriceContracts(version.id, "channel", "gpt-image-2", "generations")).find((item) => item.current)!;
        const reviewed = await saveImagePriceContract(
            {
                ...previous,
                holdEstimate: undefined,
                holdEstimates: [
                    {
                        quality: "low",
                        size: "auto",
                        observedSize: "1536x1024",
                        meterQuantities: { inputTextTokens: "24", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "343" },
                        sourceUrl: "https://example.com/image-auto-sample",
                        evidence: "reviewed low-quality auto-size generation sample",
                    },
                ],
            },
            previous.id,
        );
        expect((await setModelPricingActivation({ modelId: "gpt-image-2", imageOperation: "generations", enabled: true, expectedRevision: null, actorId: "fixture-admin" })).active).toBe(true);
        const db = await readAuthDb();
        const config = { ...toSystemGenerationChannel(resolveLogicalModelCandidates(db.settings, "image", "gpt-image-2", "", true)[0]), quality: "low", size: "auto" };
        const approval = await publicModelPricingMode("gpt-image-2", "image", [config], "generations");
        if (!approval || approval.billingMode !== "official-usage") throw new Error("auto-size tier was not metered");
        const task = await createImageTask({ userId, username: "fixture", displayName: "fixture", billingMode: "official-usage", billingApproval: approval, kind: "generation", source: "image-workbench", config, prompt: "private prompt", references: [] });
        fixtureOptions.imageResponse.model = "gpt-image-2";
        const step = await createImageTaskUpstreamStep(task, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const completed = await persistImageTaskResult((await getImageTask(task.id))!, "http://internal", step.resultUrl);
        expect(completed).toMatchObject({ status: "success", billingPending: false });
        const reservation = await getModelPriceReservation({ userId, ...completed!.billingRequests![0] });
        expect(reservation).toMatchObject({ status: "settled", frozen: { contractId: reviewed.id, upperBoundEvidence: expect.stringContaining("requestedSize=auto; observedSampleSize=1536x1024") }, settlement: { chargedPoints: "24.50" } });
        expect(Number(reservation?.estimatedHold?.heldPoints)).toBeLessThan(24.5);
        const requests = fixture.requests.filter((request: { method: string; path: string }) => request.method === "POST" && request.path === "/v1/images/generations");
        expect(requests).toHaveLength(1);
        const payload = JSON.parse(Buffer.from(requests[0].body).toString("utf8"));
        expect(payload).toMatchObject({ model: "gpt-image-2", quality: "low", n: 1 });
        expect(payload).not.toHaveProperty("size");
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "75.5", pendingCount: 0 });
    });

    it.each(["generations", "edits"] as const)("settles an independently selected official SKU through a reviewed channel alias for %s", async (operation) => {
        const alias = "proxy-gpt-image-2";
        const db = await readAuthDb();
        db.settings.systemChannels[0].models = [alias];
        db.settings.logicalModels[0].bindings[0].upstreamModel = alias;
        await writeAuthDb(db);
        mocks.settings.mockResolvedValue(db.settings);
        const state = await readPricingState();
        const version = state.officialVersions[0];
        const scope = `image:${operation}:standard`;
        const binding = {
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId: "gpt-image-2",
            capability: "image" as const,
            operation,
            processingMode: "standard" as const,
            scope,
            officialVersionId: version.id,
            status: "active" as const,
            current: true,
            evidence: "independent fixture price",
            reviewedAt: version.publishedAt,
            reviewedBy: "admin",
        };
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: [{ ...version, logicalModelId: "", capability: "image" }],
            priceBindings: [binding],
            salesVersions: state.salesVersions.map((sale) => ({
                ...sale,
                priceVersionIds: {},
                selectedPriceBindings: [{ logicalModelId: "gpt-image-2", scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: version.id }],
            })),
        });
        const reviewed = await saveImagePriceContract(
            {
                officialVersionId: version.id,
                channelId: "channel",
                requestedModel: alias,
                reportedModel: version.sku,
                modelIdentity: "response-required",
                identity: { channelBindingId: "binding", officialSku: version.sku, operation, sourceUrl: "https://example.com/image-alias", evidence: "请求别名和响应型号已核对" },
                protocol: "openai-images",
                operation,
                scope: "global-standard-direct-image-tokens",
                region: "global",
                itemMeters: { inputTextTokens: ["inputTextTokens"], inputImageTokens: ["inputImageTokens"], outputImageTokens: ["outputImageTokens"] },
                zeroMeters: ["outputTextTokens"],
                holdEstimates: [
                    {
                        quality: "low",
                        size: "816x816",
                        ...(operation === "edits" ? { referenceSize: "2x2" } : {}),
                        meterQuantities: { inputTextTokens: "285", inputImageTokens: operation === "edits" ? "1024" : "0", outputTextTokens: "0", outputImageTokens: "1000" },
                        sourceUrl: "https://example.com/image-token-estimate",
                        evidence: "fixture quality, output size, and one reference size reviewed separately",
                    },
                ],
                evidence: "direct Images alias fixture",
                reviewedBy: "admin",
                reviewedAt: version.publishedAt,
            },
            null,
        );
        const activated = await setModelPricingActivation({ modelId: "gpt-image-2", imageOperation: operation, enabled: true, expectedRevision: null, actorId: "fixture-admin" });
        expect(activated.active).toBe(true);
        expect(activated.admission).toMatchObject({ imageOperation: operation, contractIds: [reviewed.id] });
        const config = { ...toSystemGenerationChannel(resolveLogicalModelCandidates(db.settings, "image", "gpt-image-2", "", true)[0]), quality: "low", size: "64x64" };
        const approval = await publicModelPricingMode("gpt-image-2", "image", [config], operation);
        if (approval?.billingMode === "blocked") throw new Error(approval.reason);
        expect(approval).toMatchObject({ billingMode: "official-usage", scope });
        if (!approval || approval.billingMode !== "official-usage") throw new Error("alias approval was not metered");
        const task = await createImageTask({
            userId,
            username: "fixture",
            displayName: "fixture",
            billingMode: "official-usage",
            billingApproval: approval,
            kind: operation === "edits" ? "edit" : "generation",
            source: "image-workbench",
            config,
            prompt: "private prompt",
            references: operation === "edits" ? [{ dataUrl: `data:image/png;base64,${imageData}`, name: "reference.png" }] : [],
        });
        fixtureOptions.imageResponse.model = version.sku;
        fixtureOptions.imageResponse.quality = "high";
        fixtureOptions.imageResponse.size = "9x9";
        const step = await createImageTaskUpstreamStep(task, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const completed = await persistImageTaskResult((await getImageTask(task.id))!, "http://internal", step.resultUrl);
        expect(completed).toMatchObject({ status: "success", billingPending: false, pricingSnapshot: { officialVersionId: version.id, priceSelection: { bindingId: binding.id } } });
        expect(completed?.pricedResponses?.[0]?.observation.requestMismatches).toEqual(
            expect.arrayContaining([
                { field: "quality", requested: "low", reported: "high", source: "response.quality" },
                { field: "size", requested: "816x816", reported: "9x9", source: "response.size" },
            ]),
        );
        const reservation = await getModelPriceReservation({ userId, ...completed!.billingRequests![0] });
        expect(reservation).toMatchObject({ status: "settled", settlement: { chargedPoints: "24.50" }, frozen: { upperBoundEvidence: expect.stringContaining(operation === "edits" ? "referenceSize=2x2" : "quality=low") } });
        expect(Number(reservation?.estimatedHold?.heldPoints)).toBeGreaterThan(operation === "edits" ? 22 : 0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("75.5");
        const requests = fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path === `/v1/images/${operation}`);
        expect(requests).toHaveLength(1);
        expect(Buffer.from(requests[0].body).toString("utf8")).toContain(alias);
    });

    it("scales the first reviewed edit baseline to the measured reference size", async () => {
        const db = await readAuthDb();
        db.settings.systemChannels.push({ ...db.settings.systemChannels[0], id: "backup" });
        db.settings.logicalModels[0].bindings.push({ ...db.settings.logicalModels[0].bindings[0], id: "backup-binding", channelId: "backup", priority: 1 });
        await writeAuthDb(db);
        mocks.settings.mockResolvedValue(db.settings);
        const version = (await readPricingState()).officialVersions[0];
        const current = (await listImagePriceContracts(version.id, "channel", version.sku, "edits")).find((item) => item.current)!;
        const { id, current: _current, holdEstimate: _holdEstimate, ...base } = current;
        const tier = {
            quality: "low",
            size: "816x816",
            referenceSize: "2x2",
            meterQuantities: { inputTextTokens: "285", inputImageTokens: "1024", outputTextTokens: "0", outputImageTokens: "1000" },
            sourceUrl: "https://example.com/image-edit-estimate",
            evidence: "reviewed exact reference size",
        };
        await saveImagePriceContract({ ...base, holdEstimates: [{ ...tier, referenceSize: "4x4" }] }, id);
        await saveImagePriceContract({ ...base, channelId: "backup", holdEstimates: [tier] }, null);
        const activated = await setModelPricingActivation({ modelId: version.logicalModelId, imageOperation: "edits", enabled: true, expectedRevision: null, actorId: "fixture-admin" });
        expect(activated.active).toBe(true);
        const candidates = resolveLogicalModelCandidates(db.settings, "image", version.logicalModelId, "", true);
        const configs = ["channel", "backup"].map((channelId) => ({ ...toSystemGenerationChannel(candidates.find((candidate) => candidate.channel.id === channelId)!), quality: "low", size: "64x64" }));
        expect(configs.map((config) => config.channelId)).toEqual(["channel", "backup"]);
        const approval = await publicModelPricingMode(version.logicalModelId, "image", configs, "edits");
        if (!approval || approval.billingMode !== "official-usage") throw new Error("edit backup was not metered");
        const task = await createImageTask({
            userId,
            username: "fixture",
            displayName: "fixture",
            billingMode: "official-usage",
            billingApproval: approval,
            kind: "edit",
            source: "image-workbench",
            config: configs[0],
            candidateConfigs: configs.slice(1),
            prompt: "private prompt",
            references: [{ dataUrl: `data:image/png;base64,${imageData}`, name: "reference.png" }],
        });
        const step = await createImageTaskUpstreamStep(task, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const completed = await persistImageTaskResult((await getImageTask(task.id))!, "http://internal", step.resultUrl);
        expect(completed).toMatchObject({ status: "success", billingPending: false });
        expect(completed!.attempts?.map((attempt) => attempt.status)).toEqual(["succeeded"]);
        expect(completed!.billingRequests?.map((request) => request.channelId)).toEqual(["channel"]);
        expect(await getModelPriceReservation({ userId, ...completed!.billingRequests![0] })).toMatchObject({ status: "settled", frozen: { upperBoundEvidence: expect.stringContaining("referenceSize=2x2; sampleReferenceSize=4x4") } });
        expect(fixture.requests.filter((request: { method: string; path: string }) => request.method === "POST" && request.path === "/v1/images/edits")).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "75.5", pendingCount: 0 });
    });

    it.each(["xhigh", "max"] as const)("sends GPT Image 2.5 %s unchanged and settles its exact reviewed tier", async (quality) => {
        const model = "gpt-image-2.5-flare";
        const db = await readAuthDb();
        db.settings.systemChannels[0].models.push(model);
        db.settings.logicalModels.push({ ...db.settings.logicalModels[0], id: model, name: model, bindings: [{ ...db.settings.logicalModels[0].bindings[0], id: "image-2.5-binding", upstreamModel: model }] });
        await writeAuthDb(db);
        mocks.settings.mockResolvedValue(db.settings);
        const state = await readPricingState();
        const source = state.officialVersions[0];
        const version = { ...source, id: randomUUID(), logicalModelId: model, officialVersion: model, sku: model };
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: [...state.officialVersions, version],
            salesVersions: state.salesVersions.map((sale) => ({ ...sale, priceVersionIds: { ...sale.priceVersionIds, [model]: version.id } })),
        });
        await saveImagePriceContract(
            {
                officialVersionId: version.id,
                channelId: "channel",
                requestedModel: model,
                reportedModel: model,
                modelIdentity: "response-required",
                protocol: "openai-images",
                operation: "generations",
                scope: "global-standard-direct-image-tokens",
                region: "global",
                itemMeters: { inputTextTokens: ["inputTextTokens"], inputImageTokens: ["inputImageTokens"], outputImageTokens: ["outputImageTokens"] },
                zeroMeters: ["outputTextTokens"],
                holdEstimates: [
                    {
                        quality,
                        size: "1024x1024",
                        meterQuantities: { inputTextTokens: "285", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "1000" },
                        sourceUrl: "https://example.com/image-2.5-estimate",
                        evidence: "fixture exact quality and size",
                    },
                ],
                evidence: "direct Images 2.5 fixture",
                reviewedBy: "admin",
                reviewedAt: source.publishedAt,
            },
            null,
        );
        expect((await setModelPricingActivation({ modelId: model, imageOperation: "generations", enabled: true, expectedRevision: null, actorId: "fixture-admin" })).active).toBe(true);
        const config = { ...toSystemGenerationChannel(resolveLogicalModelCandidates(db.settings, "image", model, "", true)[0]), quality, size: "1024x1024" };
        const approval = await publicModelPricingMode(model, "image", [config], "generations");
        if (!approval || approval.billingMode !== "official-usage") throw new Error("image 2.5 tier was not metered");
        const task = await createImageTask({ userId, username: "fixture", displayName: "fixture", billingMode: "official-usage", billingApproval: approval, kind: "generation", source: "image-workbench", config, prompt: "private prompt", references: [] });
        fixtureOptions.imageResponse.model = model;
        const step = await createImageTaskUpstreamStep(task, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const completed = await persistImageTaskResult((await getImageTask(task.id))!, "http://internal", step.resultUrl);
        expect(completed).toMatchObject({ status: "success", billingPending: false });
        const reservation = await getModelPriceReservation({ userId, ...completed!.billingRequests![0] });
        expect(reservation).toMatchObject({ status: "settled", settlement: { chargedPoints: "24.50" }, frozen: { upperBoundEvidence: expect.stringContaining(`quality=${quality}; requestedSize=1024x1024; sampleSize=1024x1024`) } });
        const requests = fixture.requests.filter((request: { method: string; path: string }) => request.method === "POST" && request.path === "/v1/images/generations");
        expect(requests).toHaveLength(1);
        expect(JSON.parse(Buffer.from(requests[0].body).toString("utf8"))).toMatchObject({ model, quality, size: "1024x1024", n: 1 });
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "75.5", pendingCount: 0 });
    });

    it("keeps every result from one Images response while settling its reported usage once", async () => {
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind");
        const mediaUrl = `http://127.0.0.1:${address.port}/media/fixture.png`;
        fixtureOptions.imageResponse = {
            ...fixtureOptions.imageResponse,
            data: [{ url: `${mediaUrl}?result=1` }, { url: `${mediaUrl}?result=2` }],
        };
        const step = await createImageTaskUpstreamStep((await getImageTask(taskId))!, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const completed = await persistImageTaskResult((await getImageTask(taskId))!, "http://internal", step.resultUrl);
        expect(completed?.result?.results).toHaveLength(2);
        const reference = completed!.billingRequests![0];
        expect(completed?.billingRequests).toHaveLength(1);
        expect(await getModelPriceReservation({ userId, ...reference })).toMatchObject({ status: "settled", settlement: { chargedPoints: "24.50" } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("75.5");
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path === "/v1/images/generations")).toHaveLength(1);
    });

    it("keeps separate base64 result entries even when their bytes are identical", async () => {
        fixtureOptions.imageResponse = { ...fixtureOptions.imageResponse, data: [{ b64_json: imageData }, { b64_json: imageData }] };
        const step = await createImageTaskUpstreamStep((await getImageTask(taskId))!, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const completed = await persistImageTaskResult((await getImageTask(taskId))!, "http://internal", step.resultUrl);
        expect(completed?.result?.results).toHaveLength(2);
        expect(completed?.billingRequests).toHaveLength(1);
        expect(await getModelPriceReservation({ userId, ...completed!.billingRequests![0] })).toMatchObject({ status: "settled", settlement: { chargedPoints: "24.50" } });
    });

    it("submits an Agent image edit despite a pre-existing Agent attempt number", async () => {
        const original = (await getImageTask(taskId))!;
        const edit = await createImageTask({
            userId,
            username: "fixture",
            displayName: "fixture",
            billingMode: "official-usage",
            billingApproval: original.billingApproval,
            kind: "edit",
            source: "agent",
            config: original.config,
            prompt: "edit the supplied image",
            references: [{ dataUrl: `data:image/png;base64,${imageData}`, name: "reference.png" }],
        });
        taskId = edit.id;
        await linkStoredGenerationTask("image", taskId, { runId: "agent-run", attemptNo: 1 });

        const step = await createImageTaskUpstreamStep((await getImageTask(taskId))!, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const reference = (await getImageTask(taskId))!.billingRequests![0];
        expect(await getModelPriceReservation({ userId, ...reference })).toMatchObject({ status: "settled", settlement: { chargedPoints: "24.50" } });
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path === "/v1/images/edits")).toHaveLength(1);
    });
});
