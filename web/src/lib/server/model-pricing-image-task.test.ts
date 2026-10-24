vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: async () => ({ ready: true, missingCount: 0, receiptIds: { fixture: "receipt" }, sample: null }) }));
import { getShadowImageCall } from "./model-pricing-shadow-store";
import { getCurrentSalesVersion, getOfficialVersionsByIds, readPricingState } from "./model-pricing-store";
import { POST as recoverImage } from "@/app/api/image-tasks/[id]/route";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), settings: vi.fn() }));
vi.mock("next/server", async (load) => ({ ...(await load<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/auth/store", async (load) => ({ ...(await load<typeof import("@/lib/auth/store")>()), getAuthSettings: mocks.settings }));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
import { emptyDb } from "@/lib/auth/store-normalizers";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { GET as proxyGet, POST as proxyPost } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { POST as publicCreateImage } from "@/app/api/image-tasks/route";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import { saveImagePriceContract } from "./model-pricing-image-contract-store";
import { createImageTask, getImageTask, transitionImageTask, type ImageTask } from "./image-task-store";
import { createImageTaskUpstreamStep, persistImageTaskResult, markImageTaskFailed } from "./image-task-runtime";
import { recoverPricedImageTask, refundPricedImageTask } from "./model-pricing-image-task";
import { getPricingTaskReview, reviewPricingTask } from "./model-pricing-task-review-service";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import * as imageStore from "./image-task-store";
import * as walletTransactions from "./points-wallet-service";
import * as wallet from "./model-pricing-wallet-service";
import * as internal from "./internal-origin";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { cleanupExpiredStoredGenerationTasks, getStoredGenerationTaskRecord, linkStoredGenerationTask, withGenerationTaskFileMutation } from "./generation-task-store";
import { reviewGenerationTask } from "./generation-task-review-service";
import { createConversationForUser, listAssetsForUser } from "./creative-runtime-service";
import { deleteCreativeConversationAggregates } from "./creative-entity-deletion-store";
import { setModelPricingActivation } from "./model-pricing-activation-service";
import { getGenerationRunBillingSummary } from "./generation-run-billing-service";
import { getGenerationProjectBillingSummary } from "./generation-project-billing-service";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const imageCalls = [
    { model: "flux-kontext-pro", operation: "generations", price: "0.04", points: 28 },
    { model: "flux-kontext-pro", operation: "edits", price: "0.04", points: 28 },
    { model: "flux-kontext-max", operation: "generations", price: "0.08", points: 56 },
    { model: "flux-kontext-max", operation: "edits", price: "0.08", points: 56 },
    { model: "flux-pro-1.1", operation: "generations", price: "0.04", points: 28 },
] as const;
const referenceDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
describe.each(providers.flatMap((provider) => imageCalls.map((call) => ({ provider, ...call }))))("priced image execution through the real proxy ($provider $model $operation)", ({ provider, model, operation, price, points }) => {
    let directory: string;
    let task: ImageTask;
    let userId: string;
    let versionId: string;
    let policyId: string;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let origin: string;
    let fixtureOptions: { failImage: boolean; imageResponse?: Record<string, unknown> };
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-image-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-that-is-long-enough");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixtureOptions = { failImage: false };
        fixture = createProtocolFixtureServer(fixtureOptions);
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind");
        origin = `http://127.0.0.1:${address.port}`;
        userId = randomUUID();
        versionId = randomUUID();
        policyId = randomUUID();
        const publishedAt = new Date().toISOString();
        const version: OfficialPriceVersion = {
            id: versionId,
            candidateId: "fixture",
            logicalModelId: "priced-image",
            manufacturer: "Fixture",
            series: "Image",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "local single-image fixture",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [{ key: "images", unit: "image", per: "1", price, currency: "USD" }],
        };
        const policy: SalesVersion = {
            id: policyId,
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "priced-image": versionId },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        const user = {
            id: userId,
            username: `fixture_${userId}`,
            displayName: "图片计费夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 100,
            passwordHash: "fixture-only",
            createdAt: publishedAt,
            updatedAt: publishedAt,
        };
        const db = emptyDb();
        db.settings = structuredClone(db.settings);
        db.settings.freeDailyPointsEnabled = false;
        db.settings.entitlements.enabled = false;
        const channel = applyChannelProtocol({ id: "channel", name: "fixture", baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", models: [model], enabled: true }, "dataeyes-flux");
        db.settings.systemChannels = [channel];
        db.settings.logicalModels = [
            { id: "priced-image", name: "priced-image", manufacturer: "Black Forest Labs", capability: "image", enabled: true, bindings: [{ id: "fixture-binding", channelId: channel.id, upstreamModel: model, enabled: true, priority: 0 }] },
        ];
        mocks.user.mockResolvedValue(user);
        mocks.settings.mockResolvedValue(db.settings);
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            await postgresQuery("UPDATE app_settings SET free_daily_points_enabled = false, entitlements_enabled = false WHERE id = 'default'");
            await repos.users.createWithNextAccountId({ ...user, planId: settings.settings!.defaultPlanId });
            await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [versionId, version.logicalModelId, publishedAt, JSON.stringify(version)]);
            await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [policyId, publishedAt, JSON.stringify(policy)]);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1 WHERE id = 'default'", [policyId]);
        } else {
            db.users.push({ ...user, accountId: "0001", planId: db.settings.entitlements.defaultPlanId });
            await writeAuthDb(db);
            await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        }
        await saveImagePriceContract(
            {
                officialVersionId: versionId,
                channelId: channel.id,
                requestedModel: model,
                reportedModel: model,
                modelIdentity: "reviewed-request",
                protocol: "openai-images",
                operation,
                scope: "global-standard-dataeyes-flux-image",
                region: "global",
                itemMeters: {},
                zeroMeters: [],
                imageLimit: { maxImages: 1, sourceUrl: "https://example.com/one-image", evidence: "local fixture one image" },
                evidence: "local fixture",
                reviewedBy: "admin",
                reviewedAt: publishedAt,
            },
            null,
        );
        const conversation = await createConversationForUser(userId, { surface: "chat", source: "image-workbench", title: "图片计费夹具" });
        task = await createImageTask({
            userId,
            username: user.username,
            displayName: user.displayName,
            conversationId: conversation.id,
            clientRequestId: `request-${userId}`,
            billingMode: "official-usage",
            kind: operation === "edits" ? "edit" : "generation",
            source: "image-workbench",
            config: { baseUrl: "/api/ai/system/channel", apiKey: "", model: model, logicalModel: "priced-image", channelId: "channel", apiFormat: "openai", advancedConfig: channel.advancedConfig, size: "64x64" },
            prompt: "private image prompt",
            references: operation === "edits" ? [{ dataUrl: referenceDataUrl, name: "reference.png" }] : [],
        });
        vi.spyOn(internal, "fetchInternalApi").mockImplementation(async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const parts = new URL(request.url).pathname.split("/").filter(Boolean);
            if (parts.slice(0, 3).join("/") !== "api/ai/system") throw new Error("unexpected internal fixture path");
            const context = { params: Promise.resolve({ channelId: parts[3], path: parts.slice(4) }) };
            return request.method === "POST" ? proxyPost(request, context) : proxyGet(request, context);
        });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        fixture?.server.closeAllConnections();
        if (fixture) await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        if (provider === "postgres") {
            await createPostgresRepositories().users.delete(userId);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
            await postgresQuery("DELETE FROM model_sales_price_versions WHERE id = $1", [policyId]);
            await postgresQuery("DELETE FROM model_image_price_contracts WHERE official_version_id = $1", [versionId]);
            await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [versionId]);
        }
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    const current = async () => (await getImageTask(task.id))!;
    const run = async () => createImageTaskUpstreamStep(await current(), "http://internal", "http://public");
    const upstreamCalls = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && /\/images\/(generations|edits)$/.test(item.path));
    const key = async () => ({ userId, ...(await current()).billingRequests![0] });

    it.skipIf(provider !== "file" || model !== "flux-kontext-pro" || operation !== "edits")("starts an Agent edit when the Agent attempt number exists before any upstream attempt", async () => {
        await linkStoredGenerationTask("image", task.id, { runId: "agent-run", attemptNo: 2 });
        const created = await current();
        expect(created.attemptNo).toBe(2);
        expect(created.attempts).toBeUndefined();
        expect(await recoverPricedImageTask(created)).toBeNull();
        expect(await recoverPricedImageTask({ ...created, attempts: [{ attemptNo: 2, model: "priced-image", status: "failed", startedAt: Date.now() }] })).toMatchObject({ state: "needs_review" });

        expect(await run()).toMatchObject({ state: "result_ready" });
        expect((await current()).attempts).toHaveLength(1);
        expect((await current()).attemptNo).toBe(1);
        expect(upstreamCalls()).toHaveLength(1);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled" });
    });

    async function zeroOfficialRate() {
        const version = (await getOfficialVersionsByIds([versionId]))[0];
        const zero = { ...version, items: version.items.map((item) => ({ ...item, price: "0" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [versionId, JSON.stringify(zero)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [zero], salesVersions: [await getCurrentSalesVersion()] });
    }

    it.skipIf(provider !== "file" || model !== "flux-kontext-pro")("settles a publicly created image and replays the original request", async () => {
        const siblingOperation = operation === "edits" ? "generations" : "edits";
        await saveImagePriceContract(
            {
                officialVersionId: versionId,
                channelId: "channel",
                requestedModel: model,
                reportedModel: model,
                modelIdentity: "reviewed-request",
                protocol: "openai-images",
                operation: siblingOperation,
                scope: "global-standard-dataeyes-flux-image",
                region: "global",
                itemMeters: {},
                zeroMeters: [],
                imageLimit: { maxImages: 1, sourceUrl: "https://example.com/one-image", evidence: "local fixture one image" },
                evidence: "local fixture",
                reviewedBy: "admin",
                reviewedAt: new Date().toISOString(),
            },
            null,
        );
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, image: 2 } });
        const activated = await setModelPricingActivation({
            modelId: "priced-image",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Local image proxy, wallet and media fixture",
                realChannels: { [`channel/${model}`]: "Local channel fixture only" },
                entrypoints: "Public image creation and edit fixture",
                recovery: "Original request replay and settlement fixture",
            },
        });
        const request = (requestId = `public-priced-image-${operation}`) =>
            new Request("http://internal/api/image-tasks", {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": requestId },
                body: JSON.stringify({
                    config: { model: "priced-image", size: "64x64" },
                    kind: operation === "edits" ? "edit" : "generation",
                    prompt: "public image request",
                    references: operation === "edits" ? [{ dataUrl: referenceDataUrl, name: "reference.png" }] : [],
                }),
            });
        const [created, concurrent] = await Promise.all([publicCreateImage(request()), publicCreateImage(request())]);
        expect(created.status).toBe(200);
        const first = (await created.json()).task;
        expect(concurrent.status).toBe(200);
        expect((await concurrent.json()).task.id).toBe(first.id);
        const publicTask = (await getImageTask(first.id))!;
        expect(publicTask).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId } });
        const replay = await publicCreateImage(request());
        expect((await replay.json()).task.id).toBe(first.id);
        await setModelPricingActivation({ modelId: "priced-image", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        const step = await createImageTaskUpstreamStep(publicTask, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        const reference = (await getImageTask(first.id))!.billingRequests![0];
        expect(await persistImageTaskResult((await getImageTask(first.id))!, "http://internal", step.resultUrl)).toMatchObject({ status: "success", billingPending: false });
        expect(await wallet.getModelPriceReservation({ userId, ...reference })).toMatchObject({ status: "settled", settlement: { chargedPoints: points.toFixed(2) } });
        expect(upstreamCalls()).toHaveLength(1);
        const fixed = await publicCreateImage(request(`after-deactivation-${operation}`));
        expect(fixed.status).toBe(200);
        const fixedTask = (await getImageTask((await fixed.json()).task.id))!;
        expect(fixedTask.billingMode).toBeUndefined();
        expect((await createImageTaskUpstreamStep(fixedTask, "http://internal", "http://public")).state).toBe("result_ready");
        expect(upstreamCalls()).toHaveLength(2);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points - (await getImageTask(fixedTask.id))!.billing!.pointsCost!));
    });

    it.skipIf(provider !== "file" || model !== "flux-kontext-pro")("settles an independently selected image operation through scoped activation", async () => {
        const logicalModelId = "priced-image-pro";
        const authDb = await readAuthDb();
        authDb.settings.logicalModels[0].id = logicalModelId;
        await writeAuthDb(authDb);
        mocks.settings.mockResolvedValue(authDb.settings);
        const state = await readPricingState();
        const scope = `image:${operation}:standard`;
        const binding = {
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId,
            capability: "image" as const,
            operation,
            processingMode: "standard" as const,
            scope,
            officialVersionId: versionId,
            status: "active" as const,
            current: true,
            evidence: "local image selection fixture",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "admin",
        };
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: state.officialVersions.map((version) => (version.id === versionId ? { ...version, logicalModelId: "", capability: "image", manufacturer: "Black Forest Labs", processingTier: "standard" } : version)),
            priceBindings: [binding],
            salesVersions: state.salesVersions.map((sale) => ({ ...sale, priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId, scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: versionId }] })),
        });
        const activated = await setModelPricingActivation({ modelId: logicalModelId, enabled: true, expectedRevision: null, actorId: "fixture-admin", imageOperation: operation });
        expect(activated.active).toBe(true);
        const request = (requestId: string) =>
            new Request("http://internal/api/image-tasks", {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": requestId },
                body: JSON.stringify({
                    config: { model: logicalModelId, size: "64x64" },
                    kind: operation === "edits" ? "edit" : "generation",
                    prompt: "selected image",
                    references: operation === "edits" ? [{ dataUrl: referenceDataUrl, name: "reference.png" }] : [],
                }),
            });
        const created = await publicCreateImage(request("selected-image"));
        expect(created.status).toBe(200);
        const publicTask = (await getImageTask((await created.json()).task.id))!;
        expect(publicTask).toMatchObject({ billingMode: "official-usage", billingApproval: { scope }, pricingSnapshot: { officialVersionId: versionId, priceSelection: { bindingRevision: binding.revision } } });
        const step = await createImageTaskUpstreamStep(publicTask, "http://internal", "http://public");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        expect(await persistImageTaskResult((await getImageTask(publicTask.id))!, "http://internal", step.resultUrl)).toMatchObject({ status: "success", billingPending: false });
        expect(await wallet.getModelPriceReservation({ userId, ...(await getImageTask(publicTask.id))!.billingRequests![0] })).toMatchObject({ status: "settled", settlement: { chargedPoints: "28.00" } });
        await writeJsonDataFile("model-pricing.json", { ...(await readPricingState()), priceBindings: [{ ...binding, revision: randomUUID() }] });
        expect((await publicCreateImage(request("stale-selected-image"))).status).toBe(409);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.skipIf(provider !== "file" || model !== "flux-kontext-pro" || operation !== "generations")("settles two logical models sharing one official image price with their own sales coefficients", async () => {
        const modelIds = ["image-standard", "image-premium"];
        const authDb = await readAuthDb();
        authDb.settings.logicalModels = modelIds.map((id) => ({
            id,
            name: id,
            manufacturer: "Black Forest Labs",
            capability: "image" as const,
            enabled: true,
            bindings: [{ id: `${id}-channel`, channelId: "channel", upstreamModel: model, enabled: true, priority: 0 }],
        }));
        await writeAuthDb(authDb);
        mocks.settings.mockResolvedValue(authDb.settings);
        const state = await readPricingState();
        const scope = "image:generations:standard";
        const bindings = modelIds.map((logicalModelId) => ({
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId,
            capability: "image" as const,
            operation: "generations" as const,
            processingMode: "standard" as const,
            scope,
            officialVersionId: versionId,
            status: "active" as const,
            current: true,
            evidence: "shared official price fixture",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "admin",
        }));
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: state.officialVersions.map((version) => (version.id === versionId ? { ...version, logicalModelId: "", capability: "image", manufacturer: "Black Forest Labs", processingTier: "standard" } : version)),
            priceBindings: bindings,
            salesVersions: state.salesVersions.map((sale) => ({
                ...sale,
                priceVersionIds: {},
                selectedPriceBindings: bindings.map((binding) => ({ logicalModelId: binding.logicalModelId, scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: versionId })),
                userPriceRules: [{ scope: "model", modelId: modelIds[1], coefficient: "2" }],
            })),
        });
        for (const logicalModelId of modelIds) {
            const activation = await setModelPricingActivation({ modelId: logicalModelId, enabled: true, expectedRevision: null, actorId: "fixture-admin", imageOperation: "generations" });
            expect(activation.active).toBe(true);
        }
        for (const [index, logicalModelId] of modelIds.entries()) {
            const created = await publicCreateImage(
                new Request("http://internal/api/image-tasks", {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": `shared-price-${index}` },
                    body: JSON.stringify({ config: { model: logicalModelId, size: "64x64" }, kind: "generation", prompt: "shared price fixture" }),
                }),
            );
            expect(created.status).toBe(200);
            const id = (await created.json()).task.id as string;
            await linkStoredGenerationTask("image", id, { runId: "shared-run", projectId: "shared-project" });
            const publicTask = (await getImageTask(id))!;
            expect(publicTask).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId, priceSelection: { bindingId: bindings[index].id } } });
            const step = await createImageTaskUpstreamStep(publicTask, "http://internal", "http://public");
            if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
            expect(await persistImageTaskResult((await getImageTask(id))!, "http://internal", step.resultUrl)).toMatchObject({ status: "success", billingPending: false });
            expect(await wallet.getModelPriceReservation({ userId, ...(await getImageTask(id))!.billingRequests![0] })).toMatchObject({ status: "settled", settlement: { chargedPoints: index ? "56.00" : "28.00" } });
        }
        const summary = await getGenerationRunBillingSummary(userId, "shared-run");
        expect(summary).toMatchObject({ chargedPoints: 84, refundedPoints: 0, actualPoints: 84, pendingHeldPoints: 0 });
        expect(summary.charges).toEqual([
            { type: "image", purpose: "generation", logicalModelId: modelIds[0], chargedPoints: 28, refundedPoints: 0, actualPoints: 28 },
            { type: "image", purpose: "generation", logicalModelId: modelIds[1], chargedPoints: 56, refundedPoints: 0, actualPoints: 56 },
        ]);
        expect(await getGenerationProjectBillingSummary(userId, "shared-project")).toMatchObject({ actualPoints: 84, pendingHeldPoints: 0, charges: summary.charges });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("16");
        expect(upstreamCalls()).toHaveLength(2);
    });

    it("rejects restored zero-price image evidence before reserving or calling the provider", async () => {
        await zeroOfficialRate();
        expect(await run()).toMatchObject({ state: "failed" });
        expect((await getShadowImageCall(userId, (await key()).requestId))?.reasons).toContainEqual(expect.stringContaining("固定积分"));
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "100", pendingCount: 0 });
    });

    it("keeps the existing fixed image charge when the official evidence becomes free", async () => {
        const template = task;
        task = await createImageTask({ ...template, billingMode: undefined, clientRequestId: `fixed-before-${userId}` });
        const first = await run();
        expect(first.state).toBe("result_ready");
        const normalCharge = (await current()).billing!.pointsCost!;
        expect(normalCharge).toBeGreaterThan(0);
        await zeroOfficialRate();
        task = await createImageTask({ ...template, billingMode: undefined, clientRequestId: `fixed-free-${userId}` });
        expect((await run()).state).toBe("result_ready");
        expect((await current()).billing?.pointsCost).toBe(normalCharge);
        expect(upstreamCalls()).toHaveLength(2);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - 2 * normalCharge));
    });

    it("persists a real image and settles once using the original signed request", async () => {
        if (provider === "postgres") {
            const index = await postgresQuery<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'generation_tasks_pending_billing_idx'");
            expect(index.rows[0].indexdef).toContain("'image'");
        }
        const step = await run();
        expect(step).toMatchObject({ state: "result_ready" });
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        expect(await persistImageTaskResult(await current(), "http://internal", step.resultUrl)).toMatchObject({ status: "success", billingPending: false, result: { width: 64, height: 64 } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
        await run();
        expect(upstreamCalls()).toHaveLength(1);
        const request = upstreamCalls()[0];
        expect(request.path).toBe(`/v1/images/${operation}`);
        if (operation === "edits") {
            expect(request.contentType).toMatch(/^multipart\/form-data; boundary=/);
            const form = await new Response(request.body, { headers: { "content-type": request.contentType } }).formData();
            expect(form.get("model")).toBe(model);
            expect(form.getAll("image")).toHaveLength(1);
            const image = form.get("image") as File;
            expect(image.type).toBe("image/png");
            expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(referenceDataUrl.split(",")[1], "base64"));
            expect(image.name).toBe("reference.png");
        } else {
            expect(JSON.parse(request.body.toString())).toMatchObject({ model, n: 1 });
        }
        const reservation = await wallet.getModelPriceReservation(await key());
        expect(reservation).toMatchObject({ status: "settled", settlement: { chargedPoints: points.toFixed(2) } });
        expect((await getPricingWalletView(userId)).items).toHaveLength(1);
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect(JSON.stringify(await wallet.getModelPriceReservation(await key()))).not.toMatch(/private image prompt|\/media\/fixture/);
    });

    it("restores the saved URL and metering after settlement interruption without another upstream request", async () => {
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture interrupted settlement"));
        await expect(run()).rejects.toThrow();
        expect((await current()).pricedResponses).toHaveLength(1);
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        // Recovery must use the frozen reservation even if the active price is unpublished.
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        const response = await recoverImage(new Request("http://internal/api/image-tasks/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect(upstreamCalls()).toHaveLength(1);
        expect((await wallet.getModelPriceReservation(await key()))?.settlement?.chargedPoints).toBe(points.toFixed(2));
    });

    it("refunds a charged image whose media bytes are invalid using the original amount", async () => {
        task = await createImageTask({ ...task, prompt: "fixture-invalid-image-after-usage", clientRequestId: `invalid-${userId}` });
        const step = await run();
        expect(step.state).toBe("failed");
        if (step.state !== "failed") throw new Error("expected invalid image");
        await markImageTaskFailed(await current(), step.error);
        await refundPricedImageTask(await current());
        expect(await current()).toMatchObject({ status: "error", billingPending: false, billing: { pointsCost: points, refunded: true } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await wallet.getModelPriceReservation(await key()))?.refundedExactPoints).toBe(String(points));
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("refunds cancellation after settlement and keeps a repeated cancellation idempotent", async () => {
        expect((await run()).state).toBe("result_ready");
        const cancelled = await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        expect(cancelled).not.toBeNull();
        await Promise.all([refundPricedImageTask(cancelled!), refundPricedImageTask(cancelled!)]);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await current()).billingPending).toBe(false);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("completes review of an already refunded cancellation from its saved response", async () => {
        expect((await run()).state).toBe("result_ready");
        const cancelled = await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        expect(cancelled).not.toBeNull();
        expect(await refundPricedImageTask(cancelled!)).toBe(true);
        await scheduleGenerationTask("image", task.id, { executionPhase: "needs_review", nextPollAt: undefined, lastUpstreamStatus: "cancelled_metering_unknown" }, { cancellation: true });
        const original = (await current()).pricedResponses;
        const refunded = (await wallet.getModelPriceReservation(await key()))?.refundedExactPoints;

        expect(await getPricingTaskReview(task.id, "image")).toMatchObject({ pending: false, stage: "settled", hasSavedResponse: true, canResumeBilling: true });
        expect(await reviewPricingTask(task.id, { action: "resume_billing", attemptNo: 1 }, "reviewer", "image", "http://internal")).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, billing: { refunded: true } });
        expect((await current()).pricedResponses).toEqual(original);
        expect((await wallet.getModelPriceReservation(await key()))?.refundedExactPoints).toBe(refunded);
        expect((await getStoredGenerationTaskRecord("image", task.id))?.executionPhase).toBe("completed");
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("refunds a cancellation that wins while the original response is being saved", async () => {
        const record = wallet.recordModelPriceSubmissionOutcome;
        vi.spyOn(wallet, "recordModelPriceSubmissionOutcome").mockImplementationOnce(async (input) => {
            await transitionImageTask(await current(), ["running"], { status: "cancelled" });
            return record(input);
        });
        await expect(run()).rejects.toThrow("计费结果待核对");
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, billing: { refunded: true } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("keeps an interrupted reservation acknowledgement recoverable and fences a cancelled preparation", async () => {
        const reserve = wallet.reserveModelPricePoints;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementationOnce(async (input) => {
            await reserve(input);
            throw new Error("fixture lost commit acknowledgement");
        });
        await expect(run()).rejects.toThrow("计费结果待核对");
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved" });
        expect(upstreamCalls()).toHaveLength(0);
        expect(await run()).toMatchObject({ state: "needs_review" });
        const cancelled = await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        expect(await refundPricedImageTask(cancelled!)).toBe(true);
        expect((await wallet.claimModelPriceSubmission(await key())).claimed).toBe(false);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
    });

    it("refuses a mismatched transport before any fixed or metered submission", async () => {
        task = await createImageTask({ ...task, clientRequestId: `wrong-transport-${userId}`, config: { ...task.config, apiFormat: "gemini" } });
        expect(await run()).toMatchObject({ state: "failed", status: "unsupported_pricing" });
        expect(upstreamCalls()).toHaveLength(0);
        expect((await current()).billingRequests).toBeUndefined();
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
    });

    const stopPreparation = { action: "stop_preparation", attemptNo: 1, evidence: "Fixture: withdraw interrupted image preparation" };
    const review = (input: unknown = stopPreparation, actor = "reviewer") => reviewPricingTask(task.id, input, actor, "image", "http://internal");
    const awaitReview = () => scheduleGenerationTask("image", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
    async function preparedWithoutSubmission() {
        vi.spyOn(wallet, "claimModelPriceSubmission").mockRejectedValueOnce(new Error("fixture interrupted before claim"));
        await expect(run()).rejects.toThrow();
        await awaitReview();
        return key();
    }

    it("withdraws a bound image before preparation and keeps the original decision immutable", async () => {
        vi.spyOn(imageStore, "claimImageTaskBillingPreparation").mockRejectedValueOnce(new Error("fixture preparation not started"));
        await expect(run()).rejects.toThrow();
        await awaitReview();
        await expect(review({ ...stopPreparation, evidence: " " })).rejects.toThrow("依据");
        await expect(review({ ...stopPreparation, attemptNo: 2 })).rejects.toThrow("尝试已变化");
        const completed = await review();
        expect(completed).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await review()).toEqual(completed);
        await expect(review({ ...stopPreparation, evidence: "changed" })).rejects.toThrow("不能改写");
        await expect(imageStore.claimImageTaskBillingPreparation({ taskId: task.id, ...(await key()) })).rejects.toThrow();
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(0);
    });

    it.each(["before-reserve", "after-reserve"])("withdraws a delayed image preparation %s before the executor can submit", async (stage) => {
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const continued = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const reserve = wallet.reserveModelPricePoints;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementation(async (input) => {
            if (stage === "before-reserve") {
                enter();
                await continued;
                return reserve(input);
            }
            const result = await reserve(input);
            enter();
            await continued;
            return result;
        });
        const execution = run().catch((error: unknown) => error);
        await entered;
        try {
            await awaitReview();
            expect(await getPricingTaskReview(task.id, "image")).toMatchObject({ canStopPreparation: true, canReviewSubmission: false, canResumeBilling: false });
            expect(await review()).toMatchObject({ executionPhase: "completed" });
        } finally {
            resume();
        }
        expect(await execution).toBeInstanceOf(Error);
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(0);
        const saved = await wallet.getModelPriceReservation(await key());
        if (stage === "after-reserve") expect(saved).toMatchObject({ status: "released" });
        else expect(saved).toBeUndefined();
        expect(saved?.submission).toBeUndefined();
    });

    it("retains the image withdrawal fence when release fails and resumes the original decision", async () => {
        const identity = await preparedWithoutSubmission();
        const mutate = walletTransactions.mutatePricingWallet;
        const persistence = vi.spyOn(walletTransactions, "mutatePricingWallet").mockImplementation((id, clock, action) =>
            mutate(id, clock, (tx) =>
                action({
                    ...tx,
                    saveReservation: async () => {
                        throw new Error("fixture release persistence failed");
                    },
                }),
            ),
        );
        await expect(review()).rejects.toThrow("persistence failed");
        const stopped = await current();
        expect(stopped.billingPending).toBe(true);
        expect(stopped.billingRequests![0].preparationStop?.reviewedBy).toBe("reviewer");
        expect(await wallet.getModelPriceReservation(identity)).toMatchObject({ status: "reserved" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
        await expect(wallet.claimModelPriceSubmission(identity)).rejects.toThrow("已撤销");
        persistence.mockRestore();
        expect(await review({ action: "resume_billing", attemptNo: 1 }, "other-reviewer")).toMatchObject({ executionPhase: "completed", reviewId: stopped.billingRequests![0].preparationStop!.id });
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("serializes image withdrawal and submission permission without releasing a claimed request", async () => {
        const identity = await preparedWithoutSubmission();
        const [claim, stop] = await Promise.allSettled([wallet.claimModelPriceSubmission(identity), review()]);
        const saved = await wallet.getModelPriceReservation(identity);
        if (claim.status === "fulfilled" && claim.value.claimed) {
            expect(stop.status).toBe("rejected");
            expect(saved).toMatchObject({ status: "reserved", submission: { phase: "submitting" } });
            expect((await current()).billingRequests![0].preparationStop).toBeUndefined();
        } else {
            expect(stop.status).toBe("fulfilled");
            expect(saved).toMatchObject({ status: "released" });
            expect(saved!.submission).toBeUndefined();
        }
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("rejects image preparation withdrawal after upstream submission", async () => {
        fixtureOptions.failImage = true;
        await expect(run()).rejects.toThrow();
        await awaitReview();
        expect(await getPricingTaskReview(task.id, "image")).toMatchObject({ canStopPreparation: false, canReviewSubmission: true, canResumeBilling: false });
        await expect(review()).rejects.toThrow("已认领");
        await expect(review({ ...stopPreparation, action: "correct_metered_result" })).rejects.toThrow("矛盾计量");
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved", submission: { phase: "outcome_unknown" } });
        expect((await current()).billingRequests![0].preparationStop).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("withdraws an ambiguous uncommitted image preparation after cancellation", async () => {
        vi.spyOn(wallet, "reserveModelPricePoints").mockRejectedValueOnce(new Error("fixture lost acknowledgement"));
        await expect(run()).rejects.toThrow();
        await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        await awaitReview();
        expect(await review()).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(0);
    });

    async function imageFallback(unreviewed = ["unreviewed"]) {
        const settings = await mocks.settings();
        const channel = settings.systemChannels[0];
        const channels = unreviewed.map((id) => ({ ...channel, id }));
        mocks.settings.mockResolvedValue({
            ...settings,
            systemChannels: [...channels, channel],
            logicalModels: settings.logicalModels.map((item: { bindings: unknown[] }) => ({ ...item, bindings: [...unreviewed.map((channelId) => ({ id: channelId, channelId, upstreamModel: model, enabled: true, priority: 0 })), ...item.bindings] })),
        });
        const configs = [...unreviewed.map((channelId) => ({ ...task.config, channelId, baseUrl: `/api/ai/system/${channelId}` })), task.config];
        task = await createImageTask({ ...task, clientRequestId: `fallback-${userId}`, config: configs[0], candidateConfigs: configs.slice(1) });
    }

    it("uses a separately frozen image backup after a rejected preflight and delivers only once", async () => {
        await imageFallback(["unreviewed", "unreviewed-second"]);
        const step = await run();
        expect(step.state).toBe("result_ready");
        if (step.state !== "result_ready") throw new Error("missing backup image");
        await persistImageTaskResult(await current(), "http://internal", step.resultUrl);
        const saved = await current();
        expect(saved.attempts?.map((a) => a.status)).toEqual(["failed", "failed", "succeeded"]);
        expect(saved.billingRequests?.map((r) => r.channelId)).toEqual(["unreviewed", "unreviewed-second", "channel"]);
        const requests = saved.billingRequests!;
        expect(new Set(requests.map((r) => r.requestId)).size).toBe(3);
        expect(await wallet.getModelPriceReservation({ userId, ...requests[0] })).toBeUndefined();
        expect(await wallet.getModelPriceReservation({ userId, ...requests[1] })).toBeUndefined();
        expect(await wallet.getModelPriceReservation({ userId, ...requests[2] })).toMatchObject({
            status: "settled",
            frozen: { image: { call: { channelId: "channel", requestedModel: model, operation } } },
            settlement: { chargedPoints: points.toFixed(2) },
        });
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: String(100 - points), pendingCount: 0 });
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect(await run()).toMatchObject({ state: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("recovers completed preflight rejection even when its failed-attempt write was interrupted", async () => {
        await imageFallback();
        const update = imageStore.updateImageTask;
        const pause = vi.spyOn(imageStore, "updateImageTask").mockImplementation(async (id, patch, expectedAttemptNo) => {
            if (patch.attempts?.at(-1)?.status === "failed") throw new Error("fixture interrupted before failed image commit");
            return update(id, patch, expectedAttemptNo);
        });
        await expect(run()).rejects.toThrow("before failed image commit");
        pause.mockRestore();
        expect((await current()).attempts?.[0].status).toBe("running");
        expect((await current()).billingRequests![0].preparation?.phase).toBe("finished");
        expect(await run()).toMatchObject({ state: "result_ready" });
        expect((await current()).attempts?.map((a) => a.status)).toEqual(["failed", "running"]);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("recovers a persisted failed image attempt and serializes concurrent backup advancement", async () => {
        await imageFallback();
        const update = imageStore.updateImageTask;
        const pause = vi.spyOn(imageStore, "updateImageTask").mockImplementation(async (id, patch, expectedAttemptNo) => {
            const result = await update(id, patch, expectedAttemptNo);
            if (patch.attempts?.at(-1)?.status === "failed") throw new Error("fixture interrupted failed image commit");
            return result;
        });
        await expect(run()).rejects.toThrow("interrupted failed image");
        pause.mockRestore();
        expect((await current()).attempts?.[0].status).toBe("failed");
        expect(upstreamCalls()).toHaveLength(0);
        const results = await Promise.allSettled([run(), run()]);
        expect(results.some((r) => r.status === "fulfilled" && r.value.state === "result_ready")).toBe(true);
        expect((await current()).attempts?.map((a) => a.attemptNo)).toEqual([1, 2]);
        expect((await current()).billingRequests).toHaveLength(2);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
    });

    it("fences a stale image executor before it can overwrite a newer backup attempt", async () => {
        await imageFallback();
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const update = imageStore.updateImageTask;
        let held = false;
        vi.spyOn(imageStore, "updateImageTask").mockImplementation(async (id, patch, expectedAttemptNo) => {
            if (!held && patch.config && patch.attemptNo === 1) {
                held = true;
                entered.resolve();
                await released.promise;
            }
            return update(id, patch, expectedAttemptNo);
        });
        const stale = run();
        await entered.promise;
        try {
            expect(await run()).toMatchObject({ state: "result_ready" });
        } finally {
            released.resolve();
        }
        expect(await stale).toMatchObject({ state: "needs_review", status: "attempt_conflict" });
        expect((await current()).attemptNo).toBe(2);
        expect((await current()).billingRequests?.map((r) => r.channelId)).toEqual(["unreviewed", "channel"]);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
    });

    it("resumes a newly advanced image attempt after interruption before its proxy binding", async () => {
        await imageFallback();
        const advance = imageStore.advancePricedImageTask;
        const pause = vi.spyOn(imageStore, "advancePricedImageTask").mockImplementationOnce(async (...args) => {
            await advance(...args);
            throw new Error("fixture interrupted advanced image commit");
        });
        await expect(run()).rejects.toThrow("interrupted advanced image");
        pause.mockRestore();
        expect((await current()).attemptNo).toBe(2);
        expect((await current()).billingRequests).toHaveLength(1);
        expect(await run()).toMatchObject({ state: "result_ready" });
        expect((await current()).attempts).toHaveLength(2);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.each(["running", "failed"] as const)("keeps an unknown %s image attempt and its saved backup", async (status) => {
        await imageStore.updateImageTask(task.id, { candidateConfigs: [task.config] });
        fixtureOptions.failImage = true;
        await expect(run()).rejects.toThrow();
        fixtureOptions.failImage = false;
        await imageStore.updateImageTask(task.id, { attempts: (await current()).attempts!.map((a) => ({ ...a, status })) });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.pendingCount).toBe(1);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("keeps an unfinished image preparation reserved even if its attempt is marked failed", async () => {
        await imageStore.updateImageTask(task.id, { candidateConfigs: [task.config] });
        const reserve = wallet.reserveModelPricePoints;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementationOnce(async (input) => {
            await reserve(input);
            throw new Error("fixture preparation acknowledgement lost");
        });
        await expect(run()).rejects.toThrow();
        await imageStore.updateImageTask(task.id, { attempts: (await current()).attempts!.map((a) => ({ ...a, status: "failed" })) });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved" });
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("skips an unsupported image transport without sending it or losing the reviewed backup", async () => {
        task = await createImageTask({ ...task, clientRequestId: `unsupported-fallback-${userId}`, config: { ...task.config, apiFormat: "gemini" }, candidateConfigs: [task.config] });
        expect(await run()).toMatchObject({ state: "result_ready" });
        expect((await current()).attempts?.map((a) => a.status)).toEqual(["failed", "running"]);
        expect((await current()).billingRequests).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("does not advance an image backup past a durable administrator decision", async () => {
        await imageStore.updateImageTask(task.id, { candidateConfigs: [task.config] });
        await unknownImage();
        await imageStore.updateImageTask(task.id, { attempts: (await current()).attempts!.map((a) => ({ ...a, status: "failed" })) });
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture interrupted image review"));
        await expect(review(noCharge)).rejects.toThrow("interrupted image review");
        expect(await run()).toMatchObject({ state: "failed" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).billingRequests![0].review).toBeDefined();
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("keeps a cancelled image from starting its saved backup", async () => {
        await imageFallback();
        const advance = imageStore.advancePricedImageTask;
        vi.spyOn(imageStore, "advancePricedImageTask").mockImplementationOnce(async (...args) => {
            await transitionImageTask(await current(), ["running"], { status: "cancelled" });
            return advance(...args);
        });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await run()).toMatchObject({ state: "failed", status: "cancelled" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(0);
    });

    const receipt = (suffix = "") => JSON.stringify({ model, data: [{ url: `${origin}/media/fixture.png${suffix}` }] });
    const supplement = (response = receipt()) => ({ action: "provide_metered_result", attemptNo: 1, evidence: "Fixture supplier original response receipt", response });
    const noCharge = { action: "confirm_no_charge", attemptNo: 1, evidence: "Fixture supplier ledger confirms this original request was not charged" };
    async function unknownImage() {
        fixtureOptions.failImage = true;
        await expect(run()).rejects.toThrow();
        fixtureOptions.failImage = false;
        await awaitReview();
        return key();
    }

    const correction = (response = receipt()) => ({ ...supplement(response), action: "correct_metered_result" });
    async function invalidImage(payload = { ...JSON.parse(receipt()), error: "fixture contradictory success and error" }) {
        fixtureOptions.imageResponse = payload;
        await expect(run()).rejects.toThrow();
        await awaitReview();
        return (await current()).pricedResponses![0];
    }

    it("corrects a saved invalid image receipt at its frozen price and preserves the original media", async () => {
        const original = await invalidImage();
        const identity = await key();
        const before = (await wallet.getModelPriceReservation(identity))!;
        expect(await getPricingTaskReview(task.id, "image")).toMatchObject({ canCorrectUsage: true });
        await expect(review(supplement())).rejects.toThrow("冲突");
        await expect(review(correction(receipt("?replacement=1")))).rejects.toThrow("原公开结果");
        await zeroOfficialRate();
        const result = await review(correction());
        expect(result).toMatchObject({ executionPhase: "completed" });
        expect(await review(correction())).toEqual(result);
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect(await current()).toMatchObject({ status: "success", billingPending: false, result: { width: 64, height: 64 } });
        expect((await current()).billingRequests![0].review?.decision.outcome).toMatchObject({ kind: "response", correctedObservation: original.observation });
        const saved = (await wallet.getModelPriceReservation(identity))!;
        expect(saved.submission!.response).toEqual(before.submission!.response);
        expect(saved.frozen).toEqual(before.frozen);
        expect(saved.settlement?.chargedPoints).toBe(points.toFixed(2));
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("rejects forged original receipts, changed models, missing proof and excessive results", async () => {
        const original = await invalidImage();
        const identity = await key();
        const saved = (await wallet.getModelPriceReservation(identity))!;
        await expect(review({ ...correction(), evidence: " " })).rejects.toThrow("依据");
        await expect(review({ ...correction(), attemptNo: 2 })).rejects.toThrow("尝试已变化");
        for (const payload of [
            {},
            { error: "still invalid", ...JSON.parse(receipt()) },
            { model: "other", data: JSON.parse(receipt()).data },
            { data: JSON.parse(receipt()).data },
            { model, data: [...JSON.parse(receipt()).data, { url: `${origin}/media/second.png` }] },
        ]) {
            await expect(review(correction(JSON.stringify(payload)))).rejects.toThrow();
        }
        const next = { ...original.observation, invalid: [] };
        expect(() => wallet.validateReviewedImageUsage(saved, next, { ...original.observation, missing: ["forged"] })).toThrow("原矛盾凭据");
        await expect(
            wallet.reviewModelPriceSubmission({
                ...identity,
                review: { id: "bypass-task", claimId: saved.submission!.id, reviewedBy: "reviewer", reviewedAt: new Date().toISOString(), evidence: "fixture", outcome: { kind: "response", observation: next, correctedObservation: original.observation } },
            }),
        ).rejects.toThrow("专用任务凭据");
        expect((await current()).billingRequests![0].review).toBeUndefined();
        expect((await wallet.getModelPriceReservation(identity))?.status).toBe("reserved");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("cannot correct an excessive original image count down to the request limit", async () => {
        const payload = JSON.parse(receipt());
        payload.data.push({ url: `${origin}/media/second.png` });
        const original = await invalidImage({ ...payload, error: "fixture invalid count" });
        await expect(review(correction())).rejects.toThrow("已确认张数");
        await expect(review(correction(JSON.stringify(payload)))).rejects.toThrow();
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("corrects malformed result evidence only after the supplier supplies a complete original result", async () => {
        const original = await invalidImage({ model, data: [{ url: "invalid-url" }] });
        expect(original.results).toEqual([]);
        expect(await review(correction())).toMatchObject({ executionPhase: "completed" });
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await current()).status).toBe("success");
        expect((await wallet.getModelPriceReservation(await key()))?.settlement?.chargedPoints).toBe(points.toFixed(2));
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("replays a missing original wallet receipt before enabling an image correction", async () => {
        vi.spyOn(wallet, "recordModelPriceSubmissionOutcome").mockImplementationOnce(async () => {
            throw new Error("fixture receipt interrupted");
        });
        const original = await invalidImage();
        expect(await getPricingTaskReview(task.id, "image")).toMatchObject({ canCorrectUsage: false });
        await expect(review(correction())).rejects.toThrow("原矛盾凭据");
        expect(await recoverPricedImageTask(await current())).toMatchObject({ state: "needs_review" });
        expect(await getPricingTaskReview(task.id, "image")).toMatchObject({ canCorrectUsage: true });
        expect(await review(correction())).toMatchObject({ executionPhase: "completed" });
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("resumes a durable correction after its wallet write stops and rejects late responses", async () => {
        const original = await invalidImage();
        const identity = await key();
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture image correction interrupted"));
        await expect(review(correction())).rejects.toThrow("correction interrupted");
        expect((await current()).billingRequests![0].review?.decision.outcome).toMatchObject({ kind: "response", correctedObservation: original.observation });
        await expect(imageStore.savePricedImageTaskResponse({ taskId: task.id, ...identity, results: original.results, observation: { ...original.observation, invalid: [] } })).rejects.toThrow("人工核对凭据");
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await wallet.getModelPriceReservation(identity))?.settlement?.chargedPoints).toBe(points.toFixed(2));
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("accepts only one competing image correction and settles only once", async () => {
        await invalidImage();
        const results = await Promise.allSettled([review(correction()), review({ ...correction(), evidence: "different supplier decision" })]);
        expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
        const saved = (await wallet.getModelPriceReservation(await key()))!;
        expect(saved.status).toBe("settled");
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("settles and refunds an already cancelled image from the same correction", async () => {
        const original = await invalidImage();
        await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        expect(await review(correction())).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, billing: { refunded: true } });
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(0);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("releases an unknown image only from an immutable reviewed no-charge decision", async () => {
        const identity = await unknownImage();
        await expect(review({ ...noCharge, evidence: " " })).rejects.toThrow("依据");
        await expect(review({ ...noCharge, attemptNo: 2 })).rejects.toThrow("尝试已变化");
        const completed = await review(noCharge);
        expect(completed).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await review(noCharge)).toEqual(completed);
        await expect(review({ ...noCharge, evidence: "changed" })).rejects.toThrow("不能改写");
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect(await wallet.getModelPriceReservation(identity)).toMatchObject({ status: "released", submission: { review: { reviewedBy: "reviewer", outcome: { kind: "not_charged" } } } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("persists a reviewed image through the original media path and charges the frozen price once", async () => {
        const identity = await unknownImage();
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        const input = supplement();
        const completed = await review(input);
        expect(completed).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await review(input)).toEqual(completed);
        expect(await current()).toMatchObject({ status: "success", billingPending: false, result: { width: 64, height: 64 } });
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
        const saved = await wallet.getModelPriceReservation(identity);
        expect(saved).toMatchObject({ status: "settled", submission: { review: { outcome: { kind: "response", observation: { quantities: { images: "1" } } } } } });
        expect(saved?.submission?.response).toBeUndefined();
        expect(JSON.stringify(saved)).not.toMatch(/private image prompt|\/media\/fixture/);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("rejects incomplete, mismatched and excessive reviewed image results without releasing the hold", async () => {
        const identity = await unknownImage();
        for (const payload of [
            {},
            { data: [] },
            { data: [{ b64_json: "placeholder" }] },
            { model: "other-model", data: [{ url: `${origin}/media/fixture.png` }] },
            { error: "failed", data: [{ url: `${origin}/media/fixture.png` }] },
            { data: [{ url: `${origin}/media/fixture.png` }, { url: `${origin}/media/fixture.png?other=1` }] },
        ]) {
            await expect(review(supplement(JSON.stringify(payload)))).rejects.toThrow();
        }
        expect((await current()).billingRequests![0].review).toBeUndefined();
        expect(await wallet.getModelPriceReservation(identity)).toMatchObject({ status: "reserved" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("supplements missing image results without rewriting the original response", async () => {
        fixtureOptions.imageResponse = {};
        await expect(run()).rejects.toThrow();
        await awaitReview();
        const original = (await current()).pricedResponses![0];
        const saved = (await wallet.getModelPriceReservation(await key()))!.submission!.response;
        expect(original).toMatchObject({ results: [], observation: { missing: ["data"] } });
        expect(await review(supplement())).toMatchObject({ executionPhase: "completed" });
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await wallet.getModelPriceReservation(await key()))!.submission!.response).toEqual(saved);
        expect((await current()).status).toBe("success");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("refuses to replace already confirmed image quantities or result identities", async () => {
        fixtureOptions.imageResponse = { model, data: [{ url: `${origin}/media/fixture.png` }, { url: `${origin}/media/fixture.png?second=1` }] };
        await expect(run()).rejects.toThrow();
        await awaitReview();
        const original = (await current()).pricedResponses![0];
        await expect(review(supplement())).rejects.toThrow("冲突");
        await expect(review(noCharge)).rejects.toThrow("已有响应凭据");
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await current()).billingRequests![0].review).toBeUndefined();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("uses the complete original image response instead of a new administrative supplement", async () => {
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture interrupted settlement"));
        await expect(run()).rejects.toThrow();
        await awaitReview();
        await expect(review(supplement())).rejects.toThrow("原图片响应完整");
        await expect(review(noCharge)).rejects.toThrow("已有响应凭据");
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await current()).status).toBe("success");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("retains an image review when wallet persistence fails and resumes it without a new submission", async () => {
        const identity = await unknownImage();
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture reviewed wallet write interrupted"));
        await expect(review(supplement())).rejects.toThrow("write interrupted");
        const saved = await current();
        expect(saved.billingPending).toBe(true);
        expect(saved.billingRequests![0].review?.decision.reviewedBy).toBe("reviewer");
        await expect(imageStore.savePricedImageTaskResponse({ taskId: task.id, ...identity, results: [], observation: { protocol: "openai-images", quantities: {}, hasResults: false, missing: ["data"], invalid: [] } })).rejects.toThrow("人工核对凭据");
        expect(await review({ action: "resume_billing", attemptNo: 1 }, "other-reviewer")).toMatchObject({ executionPhase: "completed", reviewId: saved.billingRequests![0].review!.decision.id });
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
    });

    it("rejects late wallet responses after a durable image review awaiting settlement", async () => {
        const identity = await unknownImage();
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture reviewed settlement interrupted"));
        expect(await review(supplement())).toMatchObject({ executionPhase: "needs_review" });
        const saved = (await wallet.getModelPriceReservation(identity))!;
        await expect(
            wallet.recordModelPriceSubmissionOutcome({
                ...identity,
                claimId: saved.submission!.id,
                kind: "response",
                responseComplete: true,
                observation: { protocol: "openai-images", quantities: { images: "1" }, hasResults: true, missing: [], invalid: [] },
            }),
        ).rejects.toThrow("人工决定");
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("keeps only one of conflicting concurrent image review decisions", async () => {
        const identity = await unknownImage();
        const results = await Promise.allSettled([review(supplement()), review(noCharge)]);
        expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
        const saved = (await wallet.getModelPriceReservation(identity))!;
        expect(["settled", "released"]).toContain(saved.status);
        expect((await current()).billingRequests![0].review?.decision.id).toBe(saved.submission?.review?.id);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.each(["confirm_no_charge", "provide_metered_result"])("reconciles a cancelled unknown image with %s without reviving it", async (action) => {
        await unknownImage();
        await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        expect(await review(action === "confirm_no_charge" ? noCharge : supplement())).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("refunds the original reviewed image charge if media decoding fails", async () => {
        await unknownImage();
        expect(await review(supplement(receipt("?invalid=1")))).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "error", billingPending: false, billing: { refunded: true } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await wallet.getModelPriceReservation(await key()))?.refundedExactPoints).toBe(String(points));
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("requires an independent reviewed contract for the other operation", async () => {
        task = await createImageTask({ ...task, clientRequestId: `other-operation-${userId}`, kind: operation === "edits" ? "generation" : "edit", references: operation === "edits" ? [] : [{ dataUrl: referenceDataUrl }] });
        expect(await run()).toMatchObject({ state: "failed" });
        expect(upstreamCalls()).toHaveLength(0);
        expect((await current()).billingPending).not.toBe(true);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
    });

    it("fails an unpriced request before submission without falling back to fixed points", async () => {
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        expect(await run()).toMatchObject({ state: "failed" });
        expect((await current()).billingPending).toBe(false);
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
    });

    it("does not release, retry or use fixed billing after an ambiguous HTTP failure", async () => {
        fixtureOptions.failImage = true;
        await expect(run()).rejects.toThrow("计费结果待核对");
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(upstreamCalls()).toHaveLength(1);
        const saved = await wallet.getModelPriceReservation(await key());
        expect(saved).toMatchObject({ status: "reserved", submission: { phase: "outcome_unknown" } });
        const cancelled = await transitionImageTask(await current(), ["running"], { status: "cancelled" });
        expect(await refundPricedImageTask(cancelled!)).toBe(false);
        expect((await current()).billingPending).toBe(true);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
    });

    it("releases only an original persisted no-charge receipt when recovering an unknown image", async () => {
        fixtureOptions.failImage = true;
        await expect(run()).rejects.toThrow();
        const identity = await key();
        const saved = (await wallet.getModelPriceReservation(identity))!;
        await wallet.recordModelPriceSubmissionOutcome({ ...identity, claimId: saved.submission!.id, kind: "not_charged", evidence: "fixture provider ledger confirms this exact request was not billed" });
        expect(await recoverPricedImageTask(await current())).toMatchObject({ state: "failed" });
        expect((await wallet.getModelPriceReservation(identity))?.status).toBe("released");
        expect((await current()).billingPending).toBe(false);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("allows only one submission when two task workers start concurrently", async () => {
        const results = await Promise.allSettled([run(), run()]);
        expect(results.some((item) => item.status === "fulfilled" && item.value.state === "result_ready")).toBe(true);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(100 - points));
        expect((await current()).billingRequests).toHaveLength(1);
    });

    it("keeps an unknown response pinned across expiry and rejects generic review or history deletion", async () => {
        vi.spyOn(wallet, "recordModelPriceSubmissionOutcome").mockImplementationOnce(async () => {
            throw new Error("fixture response receipt interrupted");
        });
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValue(new Error("fixture settlement unavailable"));
        await expect(run()).rejects.toThrow();
        expect((await recoverPricedImageTask(await current()))?.state).toBe("needs_review");
        if (provider === "postgres") await postgresQuery("UPDATE generation_tasks SET expires_at = now() - interval '1 day' WHERE id = $1", [task.id]);
        else await withGenerationTaskFileMutation(async (rows) => ({ tasks: rows.map((item) => (item.id === task.id ? { ...item, expiresAt: Date.now() - 1 } : item)), result: undefined }));
        await cleanupExpiredStoredGenerationTasks({ limit: 100 });
        expect((await getStoredGenerationTaskRecord("image", task.id))?.payload.billingPending).toBe(true);
        await expect(reviewGenerationTask("image", task.id, { action: "confirm_failed" })).rejects.toThrow("原计费凭据");
        await expect(deleteCreativeConversationAggregates(userId, [task.conversationId!])).rejects.toThrow("待结算");
        expect(upstreamCalls()).toHaveLength(1);
    });
});
