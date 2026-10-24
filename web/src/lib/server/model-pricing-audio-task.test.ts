vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: async () => ({ ready: true, missingCount: 0, receiptIds: { fixture: "receipt" }, sample: null }) }));
import { saveAudioPriceReview } from "./model-pricing-audio-review";
import { cleanupAudioPriceMedia } from "./model-pricing-audio-lifecycle";
import { ModelPricingWalletRepository } from "./database/model-pricing-wallet-repository";
import * as dataAdapter from "./data-adapter";
import { assertAudioPriceResponseReceipt, recoverPricedAudioResponse, savePricedAudioResponse } from "./model-pricing-audio-response";
import * as audioResponses from "./model-pricing-audio-response-store";
import { getPricingTaskReview, reviewPricingTask } from "./model-pricing-task-review-service";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import * as pointsWallet from "./points-wallet-service";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import { POST as publicCreateAudio } from "@/app/api/audio-tasks/route";
import { GET as audioGet, POST as audioRecover } from "@/app/api/audio-tasks/[id]/route";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import * as pricedAudio from "./model-pricing-audio-task";
import { listAudioPriceContracts, saveAudioPriceContract } from "./model-pricing-audio-contract-store";
import { createAudioTask, getAudioTask, transitionAudioTask, type AudioTask } from "./audio-task-store";
import { createAudioTaskUpstreamStep } from "./audio-task-runtime";
import { refundPricedAudioTask } from "./model-pricing-audio-task";
import * as wallet from "./model-pricing-wallet-service";
import * as internal from "./internal-origin";
import * as media from "./reference-asset-store";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { setModelPricingActivation } from "./model-pricing-activation-service";
import { getCurrentSalesVersion, getOfficialVersionsByIds, readPricingState } from "./model-pricing-store";
import { readAudioPriceResponseReceipt } from "./model-pricing-audio-response-store";
import { cleanupExpiredStoredGenerationTasks, getStoredGenerationTaskRecord, linkStoredGenerationTask, withGenerationTaskFileMutation } from "./generation-task-store";
import { createConversationForUser } from "./creative-runtime-service";
import { deleteCreativeConversationAggregates } from "./creative-entity-deletion-store";
import * as audioStore from "./audio-task-store";
import { reviewGenerationTask } from "./generation-task-review-service";
import { consumePoints, getPointsWalletSnapshot } from "./points-wallet-service";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const calls = (["gemini", "dataeyes-gemini"] as const).flatMap((protocol) => (["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"] as const).map((model) => ({ protocol, model })));
describe.each(providers.flatMap((provider) => calls.map((call) => ({ provider, ...call }))))("priced audio original-task execution ($provider $protocol $model)", ({ provider, protocol, model }) => {
    let directory: string;
    let task: AudioTask;
    let deletedTask: AudioTask | undefined;
    let userId: string;
    let versionId: string;
    let policyId: string;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let origin: string;
    let fixtureOptions: { failGeminiAudio?: boolean; geminiAudioResponse?: Record<string, unknown> };
    beforeEach(async () => {
        deletedTask = undefined;
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-audio-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-that-is-long-enough");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixtureOptions = {};
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
            logicalModelId: "priced-audio",
            manufacturer: "Fixture",
            series: "Audio",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "local single-audio fixture",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [
                { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "20", currency: "USD" },
            ],
        };
        const policy: SalesVersion = {
            id: policyId,
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "priced-audio": versionId },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        const user = {
            id: userId,
            username: `fixture_${userId}`,
            displayName: "音频计费夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 300,
            passwordHash: "fixture-only",
            createdAt: publishedAt,
            updatedAt: publishedAt,
        };
        const db = emptyDb();
        db.settings = structuredClone(db.settings);
        db.settings.freeDailyPointsEnabled = false;
        db.settings.entitlements.enabled = false;
        const channel = applyChannelProtocol({ id: "channel", name: "fixture", baseUrl: origin, apiKey: "fixture-key", apiFormat: "gemini", models: [model], enabled: true }, protocol);
        db.settings.systemChannels = [channel];
        db.settings.logicalModels = [{ id: "priced-audio", name: "priced-audio", manufacturer: "Google", capability: "audio", enabled: true, bindings: [{ id: "fixture-binding", channelId: channel.id, upstreamModel: model, enabled: true, priority: 0 }] }];
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
        await saveAudioPriceContract(
            {
                officialVersionId: versionId,
                channelId: channel.id,
                requestedModel: model,
                reportedModel: model,
                modelIdentity: "reviewed-request",
                protocol: "gemini-tts",
                declaredProtocol: protocol,
                scope: "global-standard-gemini-tts",
                inputTextItem: "input",
                outputAudioItem: "output",
                evidence: "local fixture, synthetic prices",
                reviewedBy: "admin",
                reviewedAt: publishedAt,
            },
            null,
        );
        const conversation = await createConversationForUser(userId, { surface: "chat", source: "video-workbench", title: "音频计费夹具" });
        task = await createAudioTask({
            userId,
            conversationId: conversation.id,
            clientRequestId: `request-${userId}`,
            billingMode: "official-usage",
            source: "video-workbench",
            config: { baseUrl: "/api/ai/system/channel", apiKey: "", model, logicalModel: "priced-audio", channelId: "channel", apiFormat: "gemini", advancedConfig: channel.advancedConfig, voice: "Kore", format: "wav" },
            prompt: "private audio prompt",
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
        const completed = task?.userId === userId ? (await getAudioTask(task.id)) || deletedTask : undefined;
        const token = completed?.result?.url.split("/api/reference-assets/")[1];
        const artifact = token ? await media.readReferenceAsset(token) : undefined;
        if (artifact?.registration?.ownerUserId === userId) await rm(artifact.filePath, { force: true });
        vi.restoreAllMocks();
        fixture?.server.closeAllConnections();
        if (fixture) await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        if (provider === "postgres") {
            await createPostgresRepositories().users.delete(userId);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
            await postgresQuery("DELETE FROM model_sales_price_versions WHERE id = $1", [policyId]);
            await postgresQuery("DELETE FROM model_audio_price_contracts WHERE official_version_id = $1", [versionId]);
            await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [versionId]);
        }
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    const current = async () => (await getAudioTask(task.id))!;
    const run = async () => createAudioTaskUpstreamStep(await current(), "http://internal");
    const upstreamCalls = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && /:generateContent$/.test(item.path));
    const key = async () => ({ userId, ...(await current()).billingRequests![0] });

    it.skipIf(provider !== "file" || protocol !== "gemini" || model !== "gemini-2.5-flash-preview-tts")("settles an independently selected Gemini audio price", async () => {
        const state = await readPricingState();
        const scope = "audio:generateContent:standard";
        const binding = {
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId: "priced-audio",
            capability: "audio" as const,
            operation: "generateContent" as const,
            processingMode: "standard" as const,
            scope,
            officialVersionId: versionId,
            status: "active" as const,
            current: true,
            evidence: "local Gemini audio fixture",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "admin",
        };
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: state.officialVersions.map((version) => (version.id === versionId ? { ...version, logicalModelId: "", capability: "audio", manufacturer: "Google", processingTier: "standard" } : version)),
            priceBindings: [binding],
            salesVersions: state.salesVersions.map((sale) => ({ ...sale, priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "priced-audio", scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: versionId }] })),
        });
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, audio: 2 } });
        const activated = await setModelPricingActivation({ modelId: "priced-audio", enabled: true, expectedRevision: null, actorId: "fixture-admin", audioOperation: "generateContent" });
        expect(activated.active).toBe(true);
        const request = (requestId: string) =>
            new Request("http://internal/api/audio-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ config: { model: "priced-audio", voice: "Kore", format: "wav" }, prompt: "selected Gemini audio", context: { clientRequestId: requestId } }),
            });
        const created = await publicCreateAudio(request("selected-gemini-audio"));
        expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
        task = (await getAudioTask((await created.json()).task.id))!;
        expect(task).toMatchObject({ billingMode: "official-usage", billingApproval: { scope }, pricingSnapshot: { officialVersionId: versionId, priceSelection: { bindingRevision: binding.revision } } });
        expect(await run()).toEqual({ state: "completed" });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled", frozen: { priceSelection: { bindingRevision: binding.revision } } });
        await writeJsonDataFile("model-pricing.json", { ...(await readPricingState()), priceBindings: [{ ...binding, revision: randomUUID() }] });
        expect((await publicCreateAudio(request("stale-selected-gemini-audio"))).status).toBe(409);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.skipIf(provider !== "file" || protocol !== "gemini" || model !== "gemini-2.5-flash-preview-tts")("starts an Agent audio task when the Agent attempt number exists before any upstream attempt", async () => {
        await linkStoredGenerationTask("audio", task.id, { runId: "agent-run", attemptNo: 2 });
        const created = await current();
        expect(created.attemptNo).toBe(2);
        expect(created.attempts).toBeUndefined();
        expect(await pricedAudio.recoverPricedAudioTask(created)).toBeNull();
        expect(await pricedAudio.recoverPricedAudioTask({ ...created, attempts: [{ attemptNo: 2, model: "priced-audio", status: "failed", startedAt: Date.now() }] })).toMatchObject({ state: "needs_review" });

        expect(await run()).toMatchObject({ state: "completed" });
        expect((await current()).attempts).toHaveLength(1);
        expect((await current()).attemptNo).toBe(1);
        expect(upstreamCalls()).toHaveLength(1);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled" });
    });
    it.skipIf(provider !== "file" || model !== "gemini-2.5-flash-preview-tts")("replays one public metered Gemini audio creation and settles its frozen price", async () => {
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, audio: 2 } });
        const activated = await setModelPricingActivation({
            modelId: "priced-audio",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Local Gemini audio proxy and wallet fixture",
                realChannels: { [`channel/${model}`]: "Local channel fixture only" },
                entrypoints: "Public audio creation fixture",
                recovery: "Original request replay and media fixture",
            },
        });
        const request = (requestId = `public-${protocol}-audio`) =>
            new Request("http://internal/api/audio-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ config: { model: "priced-audio", voice: "Kore", format: "wav" }, prompt: "public Gemini speech request", context: { clientRequestId: requestId } }),
            });
        const [created, concurrent] = await Promise.all([publicCreateAudio(request()), publicCreateAudio(request())]);
        expect(created.status).toBe(200);
        const first = (await created.json()).task;
        expect(concurrent.status).toBe(200);
        expect((await concurrent.json()).task.id).toBe(first.id);
        task = (await getAudioTask(first.id))!;
        expect(task).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId } });
        await setModelPricingActivation({ modelId: "priced-audio", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        expect(await run()).toEqual({ state: "completed" });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled", settlement: { chargedPoints: "0.17" } });
        expect((await current()).result?.mimeType).toBe("audio/wav");
        expect(upstreamCalls()).toHaveLength(1);
        const fixed = await publicCreateAudio(request(`after-deactivation-${protocol}`));
        expect(fixed.status).toBe(200);
        task = (await getAudioTask((await fixed.json()).task.id))!;
        expect(task.billingMode).toBeUndefined();
        expect(await run()).toEqual({ state: "completed" });
        const fixedCost = (await current()).billing!.pointsCost;
        expect(fixedCost).toBeGreaterThan(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(299.83 - fixedCost));
    });
    async function refreshSessionFromWallet() {
        const actor = await mocks.user();
        mocks.user.mockImplementation(async () => {
            const snapshot = await getPointsWalletSnapshot(userId);
            return { ...actor, pointsBalance: snapshot.totalPoints, permanentPointsBalance: snapshot.permanentPoints, dailyPointsBalance: snapshot.dailyPoints };
        });
    }

    async function deleteOriginalTask() {
        deletedTask = await current();
        await deleteCreativeConversationAggregates(userId, [task.conversationId!]);
    }
    async function financialState() {
        if (provider === "postgres")
            return Promise.all(
                ["users", "point_records", "model_pricing_wallet_accounts", "model_pricing_wallet_refunds", "daily_plan_point_wallets"].map((table) =>
                    postgresQuery(`SELECT * FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = $1`, [userId]).then((result) => result.rows),
                ),
            );
        const db = await readAuthDb();
        return [db.users, db.pointRecords, db.pricingAccruals, db.pricingRefunds, db.dailyPlanPointWallets, db.quotaUsage];
    }
    it("archives private bytes only after physical task deletion while retaining audit and wallet facts", async () => {
        expect(await run()).toMatchObject({ state: "completed" });
        const reference = await key();
        const raw = (await readAudioPriceResponseReceipt(userId, reference.requestId))!;
        const reservation = (await wallet.getModelPriceReservation(reference))!;
        deletedTask = await current();
        if (provider === "postgres") await postgresQuery("UPDATE generation_tasks SET expires_at = now() - interval '1 second' WHERE id = $1", [task.id]);
        else await withGenerationTaskFileMutation(async (rows) => ({ tasks: rows.map((item) => (item.id === task.id ? { ...item, expiresAt: Date.now() - 1 } : item)), result: undefined }));
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 0, archived: 0 });
        expect(await readAudioPriceResponseReceipt(userId, reference.requestId)).toEqual(raw);
        expect(await cleanupExpiredStoredGenerationTasks({ limit: 1 })).toBe(1);
        const finances = await financialState();
        expect(await cleanupAudioPriceMedia(1)).toEqual({ checked: 1, archived: 1, failed: 0, orphanFilesDeleted: 0 });
        const cleared = (await readAudioPriceResponseReceipt(userId, reference.requestId))!;
        expect(cleared).toEqual({ ...raw, mediaPurgedAt: expect.any(String), audio: raw.audio.map((part) => ({ ...part, data: "" })) });
        expect(() => assertAudioPriceResponseReceipt(cleared, raw)).toThrow("生命周期清理");
        expect(await financialState()).toEqual(finances);
        expect(await wallet.getModelPriceReservation(reference)).toEqual({ ...reservation, audioMediaPurgedAt: expect.any(String) });
        await expect(savePricedAudioResponse({ ...raw, payload: await supplierResponse(), responseComplete: true })).rejects.toThrow("生命周期清理");
        await expect(recoverPricedAudioResponse(raw)).rejects.toThrow("生命周期清理");
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 0, archived: 0 });
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("clears all manually supplied audio parts and preserves the immutable review", async () => {
        await unknownSubmission();
        const payload = await supplierResponse();
        payload.candidates[0].content.parts.push(structuredClone(payload.candidates[0].content.parts[0]));
        expect(await review(provide(payload))).toMatchObject({ executionPhase: "completed" });
        const reference = await key();
        const original = (await audioResponses.readAudioPriceReview(userId, reference.requestId))!;
        const finances = await financialState();
        await deleteOriginalTask();
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 1, failed: 0 });
        expect(await audioResponses.readAudioPriceReview(userId, reference.requestId)).toEqual({ ...original, response: { ...original.response, mediaPurgedAt: expect.any(String), audio: original.response!.audio.map((part) => ({ ...part, data: "" })) } });
        expect(await financialState()).toEqual(finances);
        expect(await readAudioPriceResponseReceipt(userId, reference.requestId)).toBeUndefined();
    });
    it("recovers cleanup interruptions without altering the financial ledger", async () => {
        await run();
        const reference = await key();
        const raw = (await readAudioPriceResponseReceipt(userId, reference.requestId))!;
        await deleteOriginalTask();
        const finances = await financialState();
        const write = dataAdapter.writeJsonDataFile;
        const failure =
            provider === "postgres"
                ? vi.spyOn(ModelPricingWalletRepository.prototype, "save").mockRejectedValueOnce(new Error("fixture cleanup commit interrupted"))
                : vi.spyOn(dataAdapter, "writeJsonDataFile").mockImplementationOnce(write).mockRejectedValueOnce(new Error("fixture cleanup commit interrupted"));
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 0, failed: 1 });
        failure.mockRestore();
        expect(await financialState()).toEqual(finances);
        expect((await wallet.getModelPriceReservation(reference))?.audioMediaPurgedAt).toBeUndefined();
        const intermediate = (await readAudioPriceResponseReceipt(userId, reference.requestId))!;
        expect(intermediate.mediaPurgedAt).toEqual(provider === "postgres" ? undefined : expect.any(String));
        if (provider === "postgres") expect(intermediate).toEqual(raw);
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 1, failed: 0 });
        expect((await readAudioPriceResponseReceipt(userId, reference.requestId))?.audio[0].data).toBe("");
        expect(await financialState()).toEqual(finances);
    });
    it("serializes competing archive runs on the original wallet lock", async () => {
        await run();
        await deleteOriginalTask();
        const results = await Promise.all([cleanupAudioPriceMedia(1), cleanupAudioPriceMedia(1)]);
        expect(results.reduce((sum, result) => sum + result.archived, 0)).toBe(1);
        expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 0 });
    });
    it("retains reserved media even when its task record is missing", async () => {
        fixtureOptions.geminiAudioResponse = { ...(await supplierResponse()), usageMetadata: {} };
        await run();
        const reference = await key();
        const receipt = await readAudioPriceResponseReceipt(userId, reference.requestId);
        expect((await wallet.getModelPriceReservation(reference))?.status).toBe("reserved");
        if (provider === "postgres") await postgresQuery("DELETE FROM generation_tasks WHERE id = $1", [task.id]);
        else await withGenerationTaskFileMutation(async (rows) => ({ tasks: rows.filter((item) => item.id !== task.id), result: undefined }));
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 0, archived: 0 });
        expect(await readAudioPriceResponseReceipt(userId, reference.requestId)).toEqual(receipt);
    });

    async function addBackup(rejectPrimary = true) {
        const settings = await mocks.settings();
        const backupProtocol = protocol === "gemini" ? "dataeyes-gemini" : "gemini";
        const channel = applyChannelProtocol({ ...settings.systemChannels[0], id: "backup", name: "backup" }, backupProtocol);
        settings.systemChannels.push(channel);
        settings.logicalModels[0].bindings.push({ id: "backup-binding", channelId: channel.id, upstreamModel: model, enabled: true, priority: 1 });
        const original = (await listAudioPriceContracts(versionId, "channel", model))[0];
        if (original.protocol !== "gemini-tts") throw new Error("Expected Gemini fixture contract");
        const contract = await saveAudioPriceContract({ ...original, channelId: channel.id, declaredProtocol: backupProtocol }, null);
        if (rejectPrimary) {
            if (provider === "postgres") await postgresQuery("UPDATE model_audio_price_contracts SET current = false WHERE id = $1", [original.id]);
            else {
                const path = join(directory, "model-pricing-audio-contracts.json");
                const data = JSON.parse(await readFile(path, "utf8"));
                data.contracts = data.contracts.map((item: { id: string }) => (item.id === original.id ? { ...item, current: false } : item));
                await writeJsonDataFile("model-pricing-audio-contracts.json", data);
            }
        }
        const config = { ...task.config, baseUrl: "/api/ai/system/backup", channelId: "backup", advancedConfig: channel.advancedConfig };
        await audioStore.updateAudioTask(task.id, { candidateConfigs: [config] });
        return { config, contract };
    }
    it("advances a rejected preflight to its separately frozen native audio backup", async () => {
        const { contract } = await addBackup();
        expect(await run()).toMatchObject({ state: "completed" });
        const saved = await current();
        expect(saved).toMatchObject({ status: "success", attemptNo: 2, config: { channelId: "backup" }, billingPending: false });
        expect(saved.candidateConfigs).toHaveLength(0);
        expect(saved.attempts?.map((item) => item.status)).toEqual(["failed", "succeeded"]);
        expect(saved.billingRequests).toHaveLength(2);
        expect(saved.billingRequests![0].requestId).not.toBe(saved.billingRequests![1].requestId);
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        const charged = await wallet.getModelPriceReservation({ userId, ...saved.billingRequests![1] });
        expect(charged).toMatchObject({ status: "settled", frozen: { audio: { contract: { id: contract.id }, call: { channelId: "backup" } } } });
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
        expect(await run()).toMatchObject({ state: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("recovers preflight rejection after its failed-attempt write was interrupted", async () => {
        await addBackup();
        const update = audioStore.updateAudioTask;
        vi.spyOn(audioStore, "updateAudioTask").mockImplementation(async (...args) => {
            if (args[1].attempts?.at(-1)?.status === "failed") {
                vi.mocked(audioStore.updateAudioTask).mockImplementation(update);
                throw new Error("fixture failed-attempt write interrupted");
            }
            return update(...args);
        });
        await expect(run()).rejects.toThrow("failed-attempt write interrupted");
        expect((await current()).attempts?.at(-1)?.status).toBe("running");
        expect(await run()).toMatchObject({ state: "completed" });
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("resumes an interrupted candidate switch without reusing the old identity", async () => {
        await addBackup();
        vi.spyOn(pricedAudio, "advancePricedAudioTask").mockRejectedValueOnce(new Error("fixture before switch"));
        await expect(run()).rejects.toThrow("before switch");
        const first = await key();
        expect((await current()).attemptNo).toBe(1);
        expect(upstreamCalls()).toHaveLength(0);
        expect(await run()).toMatchObject({ state: "completed" });
        expect(await key()).toEqual(first);
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("recovers after candidate commit and gives concurrent runtimes one new submission", async () => {
        await addBackup();
        const advance = pricedAudio.advancePricedAudioTask;
        vi.spyOn(pricedAudio, "advancePricedAudioTask").mockImplementationOnce(async (...args) => {
            await advance(...args);
            throw new Error("fixture after switch");
        });
        await expect(run()).rejects.toThrow("after switch");
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(0);
        const results = await Promise.all([run(), run()]);
        expect(results.some((item) => item.state === "completed")).toBe(true);
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
    });
    it("does not consume the backup twice when initial runtimes race", async () => {
        await addBackup();
        const outcomes = await Promise.allSettled([run(), run()]);
        expect(outcomes.some((item) => item.status === "fulfilled" && item.value.state === "completed")).toBe(true);
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
    });
    it("ends exhausted unreviewed candidates without fixed billing or an upstream call", async () => {
        const { contract } = await addBackup();
        if (provider === "postgres") await postgresQuery("UPDATE model_audio_price_contracts SET current = false WHERE id = $1", [contract.id]);
        else await writeJsonDataFile("model-pricing-audio-contracts.json", { contracts: [] });
        expect(await run()).toMatchObject({ state: "failed", status: "not_submitted" });
        expect(await run()).toMatchObject({ state: "failed" });
        expect((await current()).attemptNo).toBe(2);
        expect((await current()).billingPending).toBe(false);
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
    });
    it("skips a locally unsupported protocol while keeping the backup native and metered", async () => {
        await addBackup(false);
        await audioStore.updateAudioTask(task.id, { config: { ...task.config, model: "unsupported-audio" } });
        expect(await run()).toMatchObject({ state: "completed" });
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await current()).billingRequests).toHaveLength(1);
    });
    it("retains the original unknown submission and untouched backup", async () => {
        await addBackup(false);
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
        await expect(pricedAudio.advancePricedAudioTask(task.id, 1)).rejects.toThrow();
    });
    it("recovers saved original audio instead of selecting a backup after media failure", async () => {
        await addBackup(false);
        vi.spyOn(media, "writePersistentMediaDataUrl").mockRejectedValueOnce(new Error("fixture media interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        await expect(pricedAudio.advancePricedAudioTask(task.id, 1)).rejects.toThrow();
        expect(await run()).toMatchObject({ state: "completed" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).attempts).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("keeps a manual no-charge decision on its original attempt with a saved backup", async () => {
        await addBackup(false);
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        expect(await review({ action: "confirm_no_charge", attemptNo: 1, evidence: "supplier original request charged zero" })).toMatchObject({ executionPhase: "completed" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).status).toBe("error");
        expect((await current()).attempts).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
        await expect(pricedAudio.advancePricedAudioTask(task.id, 1)).rejects.toThrow();
    });
    it("does not replace an explicitly withdrawn preparation with a backup", async () => {
        await addBackup(false);
        await interruptPreparation();
        expect(await review(withdraw)).toMatchObject({ executionPhase: "completed" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).attempts).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("does not switch or submit when cancellation wins the candidate transition", async () => {
        await addBackup();
        const advance = pricedAudio.advancePricedAudioTask;
        vi.spyOn(pricedAudio, "advancePricedAudioTask").mockImplementationOnce(async (...args) => {
            await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
            return advance(...args);
        });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await run()).toMatchObject({ state: "failed", status: "cancelled" });
        expect((await current()).attemptNo).toBe(1);
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
    });

    it("releases a proven no-charge submission before switching and fences its late response", async () => {
        await addBackup(false);
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        const first = await key();
        const reservation = (await wallet.getModelPriceReservation(first))!;
        await wallet.recordModelPriceSubmissionOutcome({ ...first, claimId: reservation.submission!.id, kind: "not_charged", evidence: "verified supplier no-charge fixture" });
        vi.spyOn(wallet, "releaseModelPricePoints").mockRejectedValueOnce(new Error("fixture release interrupted"));
        await expect(run()).rejects.toThrow("release interrupted");
        expect((await current()).attemptNo).toBe(1);
        expect((await wallet.getModelPriceReservation(first))?.status).toBe("reserved");
        fixtureOptions.failGeminiAudio = false;
        expect(await run()).toMatchObject({ state: "completed" });
        expect((await wallet.getModelPriceReservation(first))?.status).toBe("released");
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(2);
        await expect(savePricedAudioResponse({ ...first, claimId: reservation.submission!.id, payload: await supplierResponse(), responseComplete: true })).rejects.toThrow();
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
    });
    it("recovers file candidate durability and PostgreSQL rollback after an outer wallet abort", async () => {
        await addBackup();
        vi.spyOn(pricedAudio, "advancePricedAudioTask").mockRejectedValueOnce(new Error("fixture before switch"));
        await expect(run()).rejects.toThrow("before switch");
        const mutate = pointsWallet.mutatePricingWallet;
        vi.spyOn(pointsWallet, "mutatePricingWallet").mockImplementationOnce((owner, clock, action) =>
            mutate(owner, clock, async (tx) => {
                await action(tx);
                throw new Error("fixture outer switch transaction aborted");
            }),
        );
        await expect(run()).rejects.toThrow("outer switch transaction aborted");
        expect((await current()).attemptNo).toBe(provider === "file" ? 2 : 1);
        expect(upstreamCalls()).toHaveLength(0);
        expect(await run()).toMatchObject({ state: "completed" });
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("rejects stale preparation and task writes after the next candidate is committed", async () => {
        await addBackup();
        const advance = pricedAudio.advancePricedAudioTask;
        vi.spyOn(pricedAudio, "advancePricedAudioTask").mockImplementationOnce(async (...args) => {
            await advance(...args);
            throw new Error("fixture after switch");
        });
        await expect(run()).rejects.toThrow("after switch");
        const first = await key();
        await expect(audioStore.bindAudioTaskBillingRequest({ ...first, taskId: task.id })).rejects.toThrow();
        await expect(audioStore.claimAudioTaskBillingPreparation({ ...first, taskId: task.id })).rejects.toThrow();
        await expect(audioStore.updateAudioTask(task.id, { attempts: [] }, 1)).rejects.toThrow();
        await expect(pricedAudio.advancePricedAudioTask(task.id, 1)).rejects.toThrow();
        expect(await run()).toMatchObject({ state: "completed" });
        expect((await current()).attemptNo).toBe(2);
        expect(upstreamCalls()).toHaveLength(1);
    });

    const waitForReview = async () => scheduleGenerationTask("audio", task.id, { executionPhase: "needs_review", nextPollAt: undefined }, { cancellation: true });
    const review = (input: Parameters<typeof reviewPricingTask>[1]) => reviewPricingTask(task.id, input, "fixture-reviewer", "audio", "http://internal");
    const withdraw = { action: "stop_preparation", attemptNo: 1, evidence: "Preparation interrupted before original submission claim" };
    async function interruptPreparation() {
        vi.spyOn(audioStore, "finishAudioTaskBillingPreparation").mockRejectedValueOnce(new Error("fixture preparation interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
    }
    it("withdraws preparation with no reservation and fences the late preflight", async () => {
        const reserve = wallet.reserveModelPricePoints;
        let attempted: Parameters<typeof reserve>[0] | undefined;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementationOnce(async (input) => {
            attempted = input;
            throw new Error("fixture interrupted before reservation");
        });
        expect(await run()).toMatchObject({ state: "needs_review" });
        await expect(review(withdraw)).rejects.toThrow("不等待账务核对");
        await waitForReview();
        expect(await getPricingTaskReview(task.id, "audio")).toMatchObject({ canStopPreparation: true, canReviewSubmission: false, canProvideResult: false, canCorrectUsage: false, canResumeBilling: false });
        await expect(review({ ...withdraw, attemptNo: 2 })).rejects.toThrow("尝试已变化");
        await expect(review({ ...withdraw, evidence: "" })).rejects.toThrow();
        expect(await review(withdraw)).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        await expect(reserve(attempted!)).rejects.toThrow("已撤销");
        await expect(audioStore.claimAudioTaskBillingPreparation({ ...(await key()), taskId: task.id })).rejects.toThrow();
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        expect(await current()).toMatchObject({ status: "error", billingPending: false, attemptNo: 1 });
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
    });
    it("releases a reserved preparation once and rejects changed withdrawal evidence", async () => {
        await interruptPreparation();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        const first = await review(withdraw);
        expect(await review(withdraw)).toEqual(first);
        await expect(review({ ...withdraw, evidence: "different proof" })).rejects.toThrow("不能改写");
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "released" });
        expect((await wallet.getModelPriceReservation(await key()))?.submission).toBeUndefined();
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        const reference = await key();
        await audioStore.finishAudioTaskBillingPreparation({ ...reference, taskId: task.id, claimId: reference.preparation!.id });
        expect(await wallet.claimModelPriceSubmission(reference)).toMatchObject({ claimed: false });
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
    });
    it("recovers a committed withdrawal after the wallet release is interrupted", async () => {
        await interruptPreparation();
        const mutate = pointsWallet.mutatePricingWallet;
        vi.spyOn(pointsWallet, "mutatePricingWallet").mockImplementationOnce(mutate).mockRejectedValueOnce(new Error("fixture release interrupted"));
        await expect(review(withdraw)).rejects.toThrow("release interrupted");
        expect((await current()).billingRequests![0].preparationStop).toMatchObject({ evidence: withdraw.evidence });
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        await expect(wallet.claimModelPriceSubmission(await key())).rejects.toThrow();
        expect(await getPricingTaskReview(task.id, "audio")).toMatchObject({ reviewed: true, canStopPreparation: false, canResumeBilling: true });
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("serializes withdrawal against the original submission claim", async () => {
        vi.spyOn(wallet, "claimModelPriceSubmission").mockRejectedValueOnce(new Error("fixture pause before submission claim"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        const reference = await key();
        const results = await Promise.allSettled([
            wallet.stopModelPricePreparation({ ...reference, taskId: task.id, taskType: "audio", attemptNo: 1, reviewedBy: "fixture-reviewer", evidence: withdraw.evidence }),
            wallet.claimModelPriceSubmission(reference),
        ]);
        const saved = (await wallet.getModelPriceReservation(reference))!;
        if (saved.submission) {
            expect(results[0].status).toBe("rejected");
            expect(results[1]).toMatchObject({ status: "fulfilled", value: { claimed: true } });
            expect((await current()).billingRequests![0].preparationStop).toBeUndefined();
            expect(saved.status).toBe("reserved");
        } else {
            expect(results[0].status).toBe("fulfilled");
            if (results[1].status === "fulfilled") expect(results[1].value).toMatchObject({ claimed: false });
            expect(saved.status).toBe("released");
            expect((await current()).billingRequests![0].preparationStop).toBeDefined();
        }
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("retains the first concurrent withdrawal decision", async () => {
        await interruptPreparation();
        const results = await Promise.allSettled([review(withdraw), review({ ...withdraw, evidence: "other decision" })]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("withdraws cancelled preparation while keeping cancellation and its original attempt", async () => {
        await interruptPreparation();
        await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
        expect(await review(withdraw)).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, attemptNo: 1 });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("rejects withdrawal and incomplete supplier decisions after submission", async () => {
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        expect(await getPricingTaskReview(task.id, "audio")).toMatchObject({ canStopPreparation: false, canReviewSubmission: true, canResumeBilling: false });
        await expect(review(withdraw)).rejects.toThrow("已认领上游提交");
        for (const action of ["confirm_no_charge", "provide_metered_result", "correct_metered_result"]) await expect(review({ ...withdraw, action, evidence: "", response: "{}" })).rejects.toThrow("计费依据");
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "needs_review" });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved" });
        expect((await current()).billingPending).toBe(true);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("restores original audio media through admin recovery without exposing raw bytes", async () => {
        vi.spyOn(media, "writePersistentMediaDataUrl").mockRejectedValueOnce(new Error("fixture media interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        const view = await getPricingTaskReview(task.id, "audio");
        expect(view).toMatchObject({ hasSavedResponse: true, canResumeBilling: true, canStopPreparation: false });
        expect(JSON.stringify(view)).not.toMatch(/private audio prompt|base64|claimId|preparation|fixture-key/);
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "success", billingPending: false, attemptNo: 1, billing: { pointsCost: 0.17 } });
        expect(upstreamCalls()).toHaveLength(1);
    });

    async function supplierResponse() {
        const bytes = await (await fetch(`${origin}/media/fixture.wav`)).arrayBuffer();
        return {
            modelVersion: model,
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from(bytes).toString("base64") } }] } }],
            usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 12,
                totalTokenCount: 20,
                thoughtsTokenCount: 0,
                cachedContentTokenCount: 0,
                toolUsePromptTokenCount: 0,
                promptTokensDetails: [{ modality: "TEXT", tokenCount: 8 }],
                candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 12 }],
            },
        };
    }
    const provide = (response: unknown, action = "provide_metered_result") => ({ action, attemptNo: 1, evidence: "Supplier original request receipt fixture-audio-123", response: JSON.stringify(response) });
    const noCharge = { action: "confirm_no_charge", attemptNo: 1, evidence: "Supplier billing ticket fixture-audio-no-charge confirms no charge for original request" };
    const unknownSubmission = async () => {
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
    };
    const privateInput = async (input: { action: "confirm_no_charge" | "provide_metered_result" | "correct_metered_result"; evidence: string; response?: string }) => ({
        ...(await key()),
        taskId: task.id,
        attemptNo: 1,
        reviewedBy: "fixture-reviewer",
        ...input,
    });
    it("releases an unknown submitted request only with immutable supplier no-charge proof", async () => {
        await unknownSubmission();
        await expect(review({ ...noCharge, attemptNo: 2 })).rejects.toThrow("尝试已变化");
        const result = await review(noCharge);
        expect(result).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await review(noCharge)).toEqual(result);
        await expect(review({ ...noCharge, evidence: "different proof" })).rejects.toThrow("不能改写");
        expect(await current()).toMatchObject({ status: "error", billingPending: false, attemptNo: 1 });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("delivers all supplemented audio privately at the frozen price without another upstream request", async () => {
        await unknownSubmission();
        const payload = await supplierResponse();
        payload.candidates[0].content.parts.push(structuredClone(payload.candidates[0].content.parts[0]));
        const original = (await getOfficialVersionsByIds([versionId]))[0];
        const changed = { ...original, items: original.items.map((item) => ({ ...item, price: "99" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [versionId, JSON.stringify(changed)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [changed], salesVersions: [await getCurrentSalesVersion()] });
        expect(await review(provide(payload))).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "success", billingPending: false, billing: { pointsCost: 0.17 } });
        const saved = (await audioResponses.readAudioPriceReview(userId, (await key()).requestId))!;
        expect(saved.response?.audio).toHaveLength(2);
        expect(await readAudioPriceResponseReceipt(userId, saved.requestId)).toBeUndefined();
        expect(JSON.stringify(await getPricingTaskReview(task.id, "audio"))).not.toMatch(/base64|private audio prompt|fixture-audio-123|claimId/);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
    });
    it("supplements missing meters while retaining every original byte and known meter", async () => {
        const complete = await supplierResponse();
        const incomplete = structuredClone(complete) as Record<string, unknown>;
        incomplete.usageMetadata = { promptTokenCount: 8, promptTokensDetails: [{ modality: "TEXT", tokenCount: 8 }] };
        fixtureOptions.geminiAudioResponse = incomplete;
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        const before = await readAudioPriceResponseReceipt(userId, (await key()).requestId);
        expect(await getPricingTaskReview(task.id, "audio")).toMatchObject({ canProvideResult: true, canConfirmNoCharge: false });
        await expect(review(noCharge)).rejects.toThrow("已有原音频");
        const wrong = structuredClone(complete);
        wrong.usageMetadata.promptTokenCount = 9;
        wrong.usageMetadata.promptTokensDetails[0].tokenCount = 9;
        wrong.usageMetadata.totalTokenCount = 21;
        await expect(review(provide(wrong))).rejects.toThrow("冲突");
        expect(await review(provide(complete))).toMatchObject({ executionPhase: "completed" });
        expect(await readAudioPriceResponseReceipt(userId, (await key()).requestId)).toEqual(before);
        expect((await audioResponses.readAudioPriceReview(userId, (await key()).requestId))?.response).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("corrects invalid metering without changing original media, model or scope", async () => {
        const complete = await supplierResponse();
        fixtureOptions.geminiAudioResponse = { ...complete, usageMetadata: { ...complete.usageMetadata, totalTokenCount: 21 } };
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        const before = await readAudioPriceResponseReceipt(userId, (await key()).requestId);
        expect(await getPricingTaskReview(task.id, "audio")).toMatchObject({ canCorrectUsage: true, canProvideResult: false, canConfirmNoCharge: false });
        await expect(review(provide(complete))).rejects.toThrow();
        for (const change of [
            (payload: typeof complete) => {
                payload.modelVersion = "another-model" as typeof model;
            },
            (payload: typeof complete) => {
                payload.candidates[0].content.parts[0].inlineData.data = Buffer.from("changed bytes").toString("base64");
            },
            (payload: typeof complete) => {
                payload.candidates[0].content.parts[0].inlineData.mimeType = "audio/L16; rate=24000";
            },
            (payload: typeof complete) => {
                payload.candidates[0].content.parts.unshift({ inlineData: { mimeType: "audio/wav", data: Buffer.from("new part").toString("base64") } });
            },
        ]) {
            const wrong = structuredClone(complete);
            change(wrong);
            await expect(review(provide(wrong, "correct_metered_result"))).rejects.toThrow();
        }
        expect(await review(provide(complete, "correct_metered_result"))).toMatchObject({ executionPhase: "completed" });
        expect(await readAudioPriceResponseReceipt(userId, (await key()).requestId)).toEqual(before);
        expect((await wallet.getModelPriceReservation(await key()))?.submission?.review?.outcome).toMatchObject({ kind: "response", correctedObservation: before!.observation });
        expect(upstreamCalls()).toHaveLength(1);
        const reference = await key();
        const audit = await audioResponses.readAudioPriceReview(userId, reference.requestId);
        await deleteOriginalTask();
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 1, failed: 0 });
        expect(await audioResponses.readAudioPriceReview(userId, reference.requestId)).toEqual(audit);
        expect(await readAudioPriceResponseReceipt(userId, reference.requestId)).toEqual({ ...before, mediaPurgedAt: expect.any(String), audio: before!.audio.map((part) => ({ ...part, data: "" })) });
    });
    it("corrects the immutable raw observation even when its wallet metadata write was interrupted", async () => {
        const complete = await supplierResponse();
        fixtureOptions.geminiAudioResponse = { ...complete, usageMetadata: { ...complete.usageMetadata, totalTokenCount: 21 } };
        const record = wallet.recordModelPriceSubmissionOutcome;
        vi.spyOn(wallet, "recordModelPriceSubmissionOutcome").mockImplementationOnce(async (input) => {
            if (input.kind === "response") throw new Error("fixture metadata interrupted");
            return record(input);
        });
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        expect((await wallet.getModelPriceReservation(await key()))?.submission?.response).toBeUndefined();
        expect(await review(provide(complete, "correct_metered_result"))).toMatchObject({ executionPhase: "completed" });
        expect((await current()).billing?.pointsCost).toBe(0.17);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("does not replace a complete original receipt with an administrator supplement", async () => {
        vi.spyOn(media, "writePersistentMediaDataUrl").mockRejectedValueOnce(new Error("fixture media interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        await waitForReview();
        expect(await getPricingTaskReview(task.id, "audio")).toMatchObject({ canProvideResult: false, canCorrectUsage: false, canConfirmNoCharge: false });
        await expect(review(provide(await supplierResponse()))).rejects.toThrow("直接恢复");
        await expect(review(noCharge)).rejects.toThrow("已有原音频");
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("serializes late original audio and a no-charge review under the same wallet lock", async () => {
        await unknownSubmission();
        const reference = await key();
        const saved = (await wallet.getModelPriceReservation(reference))!;
        const outcomes = await Promise.allSettled([
            saveAudioPriceReview(await privateInput({ action: "confirm_no_charge", evidence: noCharge.evidence })),
            savePricedAudioResponse({ ...reference, claimId: saved.submission!.id, payload: await supplierResponse(), responseComplete: true }),
        ]);
        expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        const original = await readAudioPriceResponseReceipt(userId, reference.requestId);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(original ? "299.83" : "300");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("rejects forged wallet-only reviews and corrupted private supplier media before settlement", async () => {
        await unknownSubmission();
        const input = await privateInput({ action: "provide_metered_result", evidence: "fixture corruption audit", response: JSON.stringify(await supplierResponse()) });
        const saved = (await wallet.getModelPriceReservation(input))!;
        await expect(
            wallet.reviewModelPriceSubmission({
                ...input,
                review: { id: randomUUID(), claimId: saved.submission!.id, reviewedBy: "fixture-reviewer", reviewedAt: new Date().toISOString(), evidence: "forged without private task record", outcome: { kind: "not_charged" } },
            }),
        ).rejects.toThrow("专用任务凭据");
        const reviewRecord = await saveAudioPriceReview(input);
        reviewRecord.response!.audio[0].data = Buffer.from("corrupted supplier media").toString("base64");
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_audio_reviews SET data = $3::jsonb WHERE user_id = $1 AND request_id = $2", [userId, input.requestId, JSON.stringify(reviewRecord)]);
        else {
            const [owner] = await readdir(join(directory, "pricing-audio-reviews"));
            const [name] = await readdir(join(directory, "pricing-audio-reviews", owner));
            await writeJsonDataFile(`pricing-audio-reviews/${owner}/${name}`, reviewRecord);
        }
        await expect(wallet.reviewModelPriceSubmission({ ...input, review: reviewRecord.decision })).rejects.toThrow("内容校验失败");
        expect((await wallet.getModelPriceReservation(input))?.status).toBe("reserved");
        expect((await current()).billingPending).toBe(true);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("keeps holds and submission identity when a dedicated review write fails", async () => {
        await unknownSubmission();
        vi.spyOn(audioResponses, "insertAudioPriceReview").mockRejectedValueOnce(new Error("fixture review write interrupted"));
        await expect(review(noCharge)).rejects.toThrow("review write interrupted");
        expect(await audioResponses.readAudioPriceReview(userId, (await key()).requestId)).toBeUndefined();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect((await wallet.claimModelPriceSubmission(await key())).claimed).toBe(false);
        expect(await review(noCharge)).toMatchObject({ executionPhase: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("recovers file review durability and PostgreSQL rollback when the outer wallet transaction aborts", async () => {
        await unknownSubmission();
        const mutate = pointsWallet.mutatePricingWallet;
        vi.spyOn(pointsWallet, "mutatePricingWallet").mockImplementationOnce((owner, clock, action) =>
            mutate(owner, clock, async (tx) => {
                await action(tx);
                throw new Error("fixture outer review transaction aborted");
            }),
        );
        await expect(review(noCharge)).rejects.toThrow("outer review transaction aborted");
        const stored = await audioResponses.readAudioPriceReview(userId, (await key()).requestId);
        expect(Boolean(stored)).toBe(provider === "file");
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        if (stored) {
            await expect(savePricedAudioResponse({ ...(await key()), claimId: stored.decision.claimId, payload: await supplierResponse(), responseComplete: true })).rejects.toThrow("人工决定");
            expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        } else expect(await review(noCharge)).toMatchObject({ executionPhase: "completed" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("recovers a durable supplement after interrupted settlement and rejects late original writes", async () => {
        await unknownSubmission();
        const payload = await supplierResponse();
        const saved = await saveAudioPriceReview(await privateInput({ action: "provide_metered_result", evidence: "fixture stored supplement", response: JSON.stringify(payload) }));
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture reviewed settlement interrupted"));
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "needs_review" });
        await expect(savePricedAudioResponse({ ...(await key()), claimId: saved.decision.claimId, payload, responseComplete: true })).rejects.toThrow();
        expect((await current()).billingPending).toBe(true);
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("preserves one concurrent supplier decision and rejects a different review", async () => {
        await unknownSubmission();
        const payload = await supplierResponse();
        const outcomes = await Promise.allSettled([review(provide(payload)), review({ ...provide(payload), evidence: "other supplier conclusion" })]);
        expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("settles and refunds a cancelled task using the reviewed original audio once", async () => {
        await unknownSubmission();
        await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
        expect(await review(provide(await supplierResponse()))).toMatchObject({ executionPhase: "completed" });
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, billing: { pointsCost: 0.17, refunded: true } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("releases a cancelled submitted task on original supplier no-charge proof", async () => {
        await unknownSubmission();
        await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
        expect(await review(noCharge)).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, attemptNo: 1 });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("uses one signed upstream request, settles normal usage and delivers durable media", async () => {
        expect(await run()).toEqual({ state: "completed" });
        const saved = await current();
        expect(saved).toMatchObject({ status: "success", billingPending: false, attemptNo: 1, billing: { pointsCost: 0.17, refunded: false } });
        expect(saved.result?.mimeType).toBe("audio/wav");
        expect(saved.result?.url).toContain("/api/reference-assets/");
        const stored = await media.readReferenceAsset(saved.result!.url.split("/api/reference-assets/")[1]);
        expect((await readFile(stored!.filePath)).subarray(0, 4).toString()).toBe("RIFF");
        const reservation = await wallet.getModelPriceReservation(await key());
        expect(reservation).toMatchObject({ status: "settled", preparation: { taskId: task.id, taskType: "audio" }, settledUsage: { input: "8", output: "12" } });
        expect(await readAudioPriceResponseReceipt(userId, reservation!.requestId)).toBeDefined();
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
        expect(await run()).toEqual({ state: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
        const response = await audioGet(new Request("http://internal/api/audio-tasks/" + task.id), { params: Promise.resolve({ id: task.id }) });
        expect(await response.text()).not.toMatch(/billingRequests|billingMode|billingPending|preparation|claimId|candidates|base64/);
    });
    it("recovers media failure through the user's original task check without resubmission", async () => {
        const fail = vi.spyOn(media, "writePersistentMediaDataUrl").mockRejectedValueOnce(new Error("fixture local storage interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        fail.mockRestore();
        expect(await current()).toMatchObject({ status: "running", billingPending: true });
        const response = await audioRecover(new Request("http://internal/api/audio-tasks/" + task.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ task: { id: task.id, status: "success" } });
        expect(await current()).toMatchObject({ billingPending: false, attemptNo: 1 });
        expect(upstreamCalls()).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
    });
    it("keeps unknown submissions held and pinned through cancellation and expiry", async () => {
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await run()).toMatchObject({ state: "needs_review" });
        await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
        expect(await refundPricedAudioTask(await current())).toBe(false);
        if (provider === "postgres") await postgresQuery("UPDATE generation_tasks SET expires_at = now() - interval '1 second' WHERE id = $1", [task.id]);
        else await withGenerationTaskFileMutation(async (rows) => ({ tasks: rows.map((item) => (item.id === task.id ? { ...item, expiresAt: Date.now() - 1 } : item)), result: undefined }));
        await cleanupExpiredStoredGenerationTasks({ limit: 1 });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: true });
        expect(await getStoredGenerationTaskRecord("audio", task.id)).toBeTruthy();
        expect(upstreamCalls()).toHaveLength(1);
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        await expect(deleteCreativeConversationAggregates(userId, [task.conversationId!])).rejects.toThrow();
        await expect(reviewGenerationTask("audio", task.id, { action: "confirm_failed" })).rejects.toThrow("原计费凭据");
    });
    it("does not reserve or send when approved normal prices become zero", async () => {
        const original = (await getOfficialVersionsByIds([versionId]))[0];
        const version = { ...original, items: original.items.map((item) => ({ ...item, price: "0" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [versionId, JSON.stringify(version)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [await getCurrentSalesVersion()] });
        expect(await run()).toMatchObject({ state: "failed", status: "not_submitted" });
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        expect((await current()).billingPending).toBe(false);
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
    });
    it("settles and refunds the original response once when cancellation races settlement", async () => {
        const record = wallet.recordModelPriceSubmissionOutcome;
        vi.spyOn(wallet, "recordModelPriceSubmissionOutcome").mockImplementationOnce(async (input) => {
            await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
            return record(input);
        });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, billing: { refunded: true, pointsCost: 0.17 } });
        expect(await Promise.all([refundPricedAudioTask(await current()), refundPricedAudioTask(await current())])).toEqual([true, true]);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(1);
        expect((await wallet.getModelPriceReservation(await key()))?.refundedUsage).toEqual({ input: "8", output: "12" });
        const finances = await financialState();
        await deleteOriginalTask();
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 1, failed: 0 });
        expect(await financialState()).toEqual(finances);
    });
    it("releases cancellation before the submission claim without contacting upstream", async () => {
        const claim = wallet.claimModelPriceSubmission;
        vi.spyOn(wallet, "claimModelPriceSubmission").mockImplementationOnce(async (input) => {
            await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
            return claim(input);
        });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await refundPricedAudioTask(await current())).toBe(true);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "released" });
        expect((await wallet.getModelPriceReservation(await key()))?.submission).toBeUndefined();
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("recovers settlement interruption from raw bytes at the original price", async () => {
        const failure = vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture settlement interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        failure.mockRestore();
        expect(await readAudioPriceResponseReceipt(userId, (await key()).requestId)).toBeDefined();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        const original = (await getOfficialVersionsByIds([versionId]))[0];
        const changed = { ...original, items: original.items.map((item) => ({ ...item, price: "99" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [versionId, JSON.stringify(changed)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [changed], salesVersions: [await getCurrentSalesVersion()] });
        await refreshSessionFromWallet();
        const response = await audioRecover(new Request("http://internal/api/audio-tasks/" + task.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-vozeb-pro-points-remaining")).toBe("299.83");
        expect(response.headers.get("x-vozeb-pro-points-permanent")).toBe("299.83");
        expect(await current()).toMatchObject({ status: "success", billing: { pointsCost: 0.17 } });
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("keeps an interrupted preparation pinned and rejects a changed task identity", async () => {
        const finish = vi.spyOn(audioStore, "finishAudioTaskBillingPreparation").mockRejectedValueOnce(new Error("fixture preparation interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        finish.mockRestore();
        const reference = await key();
        await expect(wallet.claimModelPriceSubmission(reference)).rejects.toThrow();
        await expect(audioStore.bindAudioTaskBillingRequest({ ...reference, taskId: task.id, channelId: "wrong-channel" })).rejects.toThrow();
        await expect(audioStore.updateAudioTask(task.id, { config: { ...task.config, model: "wrong-model" } }, 1)).rejects.toThrow();
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect((await current()).billingPending).toBe(true);
        expect(upstreamCalls()).toHaveLength(0);
    });
    it("allows only one submitter when two runtimes start the same attempt", async () => {
        const results = await Promise.all([run(), run()]);
        expect(results.some((result) => result.state === "completed")).toBe(true);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await current()).attemptNo).toBe(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("299.83");
    });
    it("keeps complete audio with missing metering held without falling back", async () => {
        fixtureOptions.geminiAudioResponse = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16; rate=24000; channels=1", data: Buffer.alloc(4800).toString("base64") } }] } }] };
        await audioStore.updateAudioTask(task.id, { candidateConfigs: [{ ...task.config, model: "fallback-must-not-run" }] });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect(await run()).toMatchObject({ state: "needs_review" });
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect(await readAudioPriceResponseReceipt(userId, (await key()).requestId)).toBeDefined();
        expect((await current()).result).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("lets a cancelled user's one-shot check finish the original pending refund", async () => {
        const failure = vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture settlement interrupted"));
        expect(await run()).toMatchObject({ state: "needs_review" });
        failure.mockRestore();
        await transitionAudioTask(await current(), ["running"], { status: "cancelled" });
        await refreshSessionFromWallet();
        const response = await audioRecover(new Request("http://internal/api/audio-tasks/" + task.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-vozeb-pro-points-remaining")).toBe("300");
        expect(response.headers.get("x-vozeb-pro-points-permanent")).toBe("300");
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, billing: { refunded: true } });
        expect((await getStoredGenerationTaskRecord("audio", task.id))?.executionPhase).toBe("completed");
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("300");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("returns to a recoverable state after each unsuccessful user check without automatic polling", async () => {
        fixtureOptions.failGeminiAudio = true;
        expect(await run()).toMatchObject({ state: "needs_review" });
        for (const status of ["running", "cancelled"] as const) {
            if (status === "cancelled") await transitionAudioTask(await current(), ["running"], { status });
            const response = await audioRecover(new Request("http://internal/api/audio-tasks/" + task.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
                params: Promise.resolve({ id: task.id }),
            });
            expect(response.status).toBe(200);
            const schedule = await getStoredGenerationTaskRecord("audio", task.id);
            expect(schedule?.executionPhase).toBe("needs_review");
            expect(schedule?.nextPollAt).toBeUndefined();
            expect((await current()).billingPending).toBe(true);
        }
        expect(upstreamCalls()).toHaveLength(1);
    });
    it("finishes an insufficient-balance preflight without submitting or pinning an unknown charge", async () => {
        await consumePoints({ userId, usageKind: "text", model: "fixture", units: 1, amount: 299, idempotencyKey: randomUUID(), description: "fixture spends available funds" });
        expect(await run()).toMatchObject({ state: "failed", status: "not_submitted" });
        expect((await current()).billingPending).toBe(false);
        expect(await wallet.getModelPriceReservation(await key())).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(0);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("1");
    });
    it.skipIf(!process.env.FFMPEG_PATH)("converts the original PCM response after real proxy settlement", async () => {
        fixtureOptions.geminiAudioResponse = {
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16; rate=24000; channels=1", data: Buffer.alloc(4800).toString("base64") } }] } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20, promptTokensDetails: [{ modality: "TEXT", tokenCount: 8 }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 12 }] },
        };
        expect(await run()).toEqual({ state: "completed" });
        const saved = await current();
        expect(saved.billing?.pointsCost).toBe(0.17);
        const stored = await media.readReferenceAsset(saved.result!.url.split("/api/reference-assets/")[1]);
        expect((await readFile(stored!.filePath)).subarray(0, 4).toString()).toBe("RIFF");
        expect((await readAudioPriceResponseReceipt(userId, (await key()).requestId))?.audio[0].mimeType).toBe("audio/L16; rate=24000; channels=1");
        expect(upstreamCalls()).toHaveLength(1);
    });
});
