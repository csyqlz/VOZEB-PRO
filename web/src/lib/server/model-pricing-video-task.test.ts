import * as scheduler from "./generation-task-scheduler";
vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: async () => ({ ready: true, missingCount: 0, receiptIds: { fixture: "receipt" }, sample: null }) }));
import { PricingInputError } from "@/lib/model-pricing";
import { createPricedVideoUpstream } from "./video-task-submission";
import { getPricingTaskReview, reviewPricingTask } from "./model-pricing-task-review-service";
import { POST as recoverVideo } from "@/app/api/video-tasks/[id]/route";
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
import { writeAuthDb } from "@/lib/auth/store-repository";
import { resolveModelAdvancedConfig, toSystemGenerationChannel } from "./generation-channel";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { GET as proxyGet, POST as proxyPost } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { POST as publicCreateVideo } from "@/app/api/video-generation-tasks/route";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import { saveVideoPriceContract } from "./model-pricing-video-contract-store";
import { saveModelPriceBinding } from "./model-price-binding-store";
import { createVideoTask, getVideoTask, transitionVideoTask, type VideoTask } from "./video-task-store";
import { queryVideoTaskUpstream, persistVideoTaskResult } from "./video-task-runtime";
import { createUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import { runGenerationTaskRecoveryBatch } from "./generation-task-recovery-service";
import { systemAiBillingHeaders, SYSTEM_AI_VIDEO_TASK_HEADER } from "./system-ai-billing";
import { recoverPricedVideoTask, refundPricedVideoTask } from "./model-pricing-video-task";

import * as videoStore from "./video-task-store";

import * as wallet from "./model-pricing-wallet-service";
import * as internal from "./internal-origin";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { reviewGenerationTask } from "./generation-task-review-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { cleanupExpiredStoredGenerationTasks, getStoredGenerationTaskRecord, withGenerationTaskFileMutation } from "./generation-task-store";
import { publicModelPricingMode, setModelPricingActivation } from "./model-pricing-activation-service";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { readPricingState } from "./model-pricing-store";

import { createConversationForUser, listAssetsForUser } from "./creative-runtime-service";
import { deleteCreativeConversationAggregates } from "./creative-entity-deletion-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers)("priced video execution through the real proxy (%s)", (provider) => {
    const model = "MiniMax-H3";
    const resolutions = ["768P", "2K"];
    let directory: string;
    let task: VideoTask;
    let userId: string;
    let versionId: string;
    let policyId: string;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let origin: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-video-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-that-is-long-enough");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixture = createProtocolFixtureServer();
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
            logicalModelId: "priced-video",
            manufacturer: "Fixture",
            series: "Video",
            officialVersion: model,
            sku: model,
            tier: "paid",
            conditions: "local single-video fixture",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [
                ...resolutions.flatMap((r) => ["input", "output"].map((kind) => ({ key: `${r}-${kind}`, unit: "second", per: "1", price: kind === "input" ? "0.001" : "0.002", currency: "CNY" }))),
                { key: "images", unit: "image", per: "1", price: "0.003", currency: "CNY" },
                { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "CNY" },
            ],
        };
        const policy: SalesVersion = {
            id: policyId,
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "priced-video": versionId },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        const user = {
            id: userId,
            username: `fixture_${userId}`,
            displayName: "视频计费夹具",
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
        const channel = applyChannelProtocol({ id: "channel", name: "fixture", baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", models: [model], enabled: true }, "minimax");
        channel.advancedConfig = { ...channel.advancedConfig!, supportsReferenceImage: true, supportsReferenceAudio: true };
        db.settings.systemChannels = [channel];
        db.settings.logicalModels = [
            { id: "priced-video", name: "priced-video", manufacturer: "MiniMax", capability: "video", enabled: true, bindings: [{ id: "fixture-binding", channelId: channel.id, upstreamModel: model, enabled: true, priority: 0 }] },
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
        await saveVideoPriceContract(
            {
                officialVersionId: versionId,
                channelId: channel.id,
                requestedModel: model,
                protocol: "minimax-video-v2",
                scope: "global-standard-minimax-h3-generation",
                resolutionItems: Object.fromEntries(resolutions.map((r) => [r, { inputSeconds: `${r}-input`, outputSeconds: `${r}-output` }])),
                inputImageItem: "images",
                inputImagePricing: "all-at-standard-rate",
                inputAudioItem: "inputAudioSeconds",
                evidence: "local synthetic rates",
                reviewedBy: "admin",
                reviewedAt: publishedAt,
            },
            null,
        );
        const conversation = await createConversationForUser(userId, { surface: "chat", source: "video-workbench", title: "视频计费夹具" });
        task = await createVideoTask({
            userId,
            username: user.username,
            displayName: user.displayName,
            conversationId: conversation.id,
            clientRequestId: `request-${userId}`,
            billingMode: "official-usage",
            source: "video-workbench",
            config: { apiSource: "system", baseUrl: "/api/ai/system/channel", apiKey: "system", model, logicalModel: "priced-video", channelId: "channel", apiFormat: "openai", advancedConfig: resolveModelAdvancedConfig(channel.advancedConfig, model) },
            prompt: "fixture-h3-shadow private video prompt",
            requestedDurationSeconds: 5,
            upstream: { id: "", model, provider: "generation", pollPath: "/v2/video_generation" },
            attempts: [{ attemptNo: 1, channelId: "channel", model: "priced-video", status: "running", startedAt: Date.now() }],
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
            await postgresQuery("DELETE FROM model_video_price_contracts WHERE official_version_id = $1", [versionId]);
            await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [versionId]);
        }
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    const current = async () => (await getVideoTask(task.id))!;
    const run = async (references: Parameters<typeof createUpstream>[6] = []) =>
        createUpstream(userId, "http://internal", "", task.config, task.prompt!, { videoSeconds: 5, size: "16:9", vquality: "768P" }, references, (await mocks.settings()).generationPointMultipliers, task.clientRequestId!, await current());
    const query = async () => queryVideoTaskUpstream(await current(), "http://internal", "", userId);
    const upstreamCalls = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path === "/v2/video_generation");
    const queries = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "GET" && item.path.startsWith("/v2/query/video_generation/"));
    const key = async () => ({ userId, ...(await current()).billingRequests![0] });
    const providerTask = () => fixture.tasks.get(task.upstream.id) as Record<string, unknown>;
    const cancel = async () => {
        await transitionVideoTask(await current(), { status: "cancelled" }, { executionPhase: "cancel_requested", nextPollAt: Date.now() });
    };

    it.skipIf(provider !== "file")("settles a public H3 request with standing-free audio and normally priced images", async () => {
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, video: 2 } });
        const activated = await setModelPricingActivation({
            modelId: "priced-video",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Local H3 original task and wallet fixture",
                realChannels: { [`channel/${model}`]: "Local channel fixture only" },
                entrypoints: "Public H3 video creation with audio reference",
                recovery: "Original task query and frozen settlement fixture",
            },
        });
        expect(activated.active).toBe(true);
        const publicConfigs = resolveLogicalModelCandidates(await mocks.settings(), "video", "priced-video").map(toSystemGenerationChannel);
        const currentConfigs = resolveLogicalModelCandidates(await getFreshAuthSettings(), "video", "priced-video").map(toSystemGenerationChannel);
        expect(publicConfigs).toEqual(currentConfigs);
        expect(await publicModelPricingMode("priced-video", "video", publicConfigs)).toMatchObject({ billingMode: "official-usage" });
        const request = new Request("http://internal/api/video-generation-tasks", {
            method: "POST",
            headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": "public-h3-audio" },
            body: JSON.stringify({
                config: { model: "priced-video", videoSeconds: 5, vquality: "768P", size: "16:9" },
                prompt: "public H3 video with audio and image",
                references: [
                    { type: "image", url: `${origin}/media/fixture.png` },
                    { type: "audio", url: "https://example.com/reference.mp3" },
                ],
            }),
        });
        const created = await publicCreateVideo(request);
        expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
        task = (await getVideoTask((await created.json()).task.id))!;
        expect(task).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId } });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({
            status: "reserved",
            frozen: { maximumUsage: { inputAudioSeconds: "0", images: "1" }, video: { bound: { maximumQuantities: { inputAudioSeconds: "15", inputImageCount: "1" } } } },
        });
        await setModelPricingActivation({ modelId: "priced-video", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        providerTask().usage = { total_seconds: 5, input_seconds: 0, output_seconds: 5, input_image_count: 1, input_audio_seconds: 3.5 };
        const step = await query();
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({
            status: "settled",
            settledUsage: { inputAudioSeconds: "0", images: "1" },
            settlement: { chargedPoints: "1.30" },
            submission: { response: { observation: { quantities: { inputAudioSeconds: "3.5", inputImageCount: "1" } } } },
        });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.skipIf(provider !== "file")("settles a public video using an independent official price and blocks a stale selection", async () => {
        const state = await readPricingState();
        const scope = "video:generation:standard";
        const binding = {
            id: randomUUID(),
            revision: randomUUID(),
            logicalModelId: "priced-video",
            capability: "video" as const,
            operation: "generation" as const,
            processingMode: "standard" as const,
            scope,
            officialVersionId: versionId,
            status: "active" as const,
            current: true,
            evidence: "local H3 selected price fixture",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "admin",
        };
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: state.officialVersions.map((version) =>
                version.id === versionId ? { ...version, logicalModelId: "", capability: "video", manufacturer: "MiniMax", processingTier: "standard", items: version.items.map((item) => ({ ...item, currency: "USD" })) } : version,
            ),
            priceBindings: [binding],
            salesVersions: state.salesVersions.map((sale) => ({
                ...sale,
                priceVersionIds: {},
                selectedPriceBindings: [{ logicalModelId: "priced-video", scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: versionId }],
                userPriceRules: [{ scope: "model", modelId: "priced-video", coefficient: "2" }],
            })),
        });
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, video: 2 } });
        const activated = await setModelPricingActivation({ modelId: "priced-video", enabled: true, expectedRevision: null, actorId: "fixture-admin" });
        expect(activated.active).toBe(true);
        const request = (requestId: string) =>
            new Request("http://internal/api/video-generation-tasks", {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": requestId },
                body: JSON.stringify({ config: { model: "priced-video", videoSeconds: 5, vquality: "768P", size: "16:9" }, prompt: "selected H3 video" }),
            });
        const created = await publicCreateVideo(request("selected-h3"));
        expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
        task = (await getVideoTask((await created.json()).task.id))!;
        expect(task).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId, priceSelection: { bindingRevision: binding.revision } } });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved", frozen: { priceSelection: { bindingRevision: binding.revision }, video: { call: { logicalModelId: "priced-video" } } } });
        await saveModelPriceBinding({ ...binding, evidence: "new H3 price selection review" }, binding.revision);
        providerTask().usage = { total_seconds: 5, input_seconds: 0, output_seconds: 5, input_image_count: 0, input_audio_seconds: 0 };
        const step = await query();
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled", frozen: { priceSelection: { bindingRevision: binding.revision } } });
        expect((await publicCreateVideo(request("stale-selected-h3"))).status).toBe(409);
        expect(upstreamCalls()).toHaveLength(1);
    });

    async function videoFallback(unreviewed = ["unreviewed"]) {
        const settings = await mocks.settings();
        const channel = settings.systemChannels[0];
        const channels = unreviewed.map((id) => ({ ...channel, id }));
        mocks.settings.mockResolvedValue({
            ...settings,
            systemChannels: [...channels, channel],
            logicalModels: settings.logicalModels.map((item: { bindings: unknown[] }) => ({ ...item, bindings: [...unreviewed.map((channelId) => ({ id: channelId, channelId, upstreamModel: model, enabled: true, priority: 0 })), ...item.bindings] })),
        });
        const configs = [...unreviewed.map((channelId) => ({ ...task.config, channelId, baseUrl: `/api/ai/system/${channelId}` })), task.config];
        task = await createVideoTask({
            ...task,
            clientRequestId: `fallback-${userId}`,
            config: configs[0],
            candidateConfigs: configs.slice(1),
            attempts: [{ attemptNo: 1, channelId: configs[0].channelId!, model: "priced-video", status: "running", startedAt: Date.now() }],
        });
    }
    const resume = () => createPricedVideoUpstream(task.id, userId, "http://internal", "");

    it("freezes an independent video backup after rejected preflights and delivers one real result", async () => {
        await videoFallback(["unreviewed", "unreviewed-second"]);
        await run();
        task = await current();
        const step = await query();
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId);
        const saved = await current();
        expect(saved.attempts?.map((a) => a.status)).toEqual(["failed", "failed", "succeeded"]);
        expect(saved.billingRequests?.map((r) => r.channelId)).toEqual(["unreviewed", "unreviewed-second", "channel"]);
        const requests = saved.billingRequests!;
        expect(new Set(requests.map((r) => r.requestId)).size).toBe(3);
        for (const reference of requests.slice(0, 2)) expect(await wallet.getModelPriceReservation({ userId, ...reference })).toBeUndefined();
        expect(await wallet.getModelPriceReservation({ userId, ...requests[2] })).toMatchObject({ status: "settled", frozen: { video: { call: { channelId: "channel", requestedModel: model } } }, settlement: { chargedPoints: "1.05" } });
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "98.95", pendingCount: 0 });
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.each(["before", "after"])("recovers %s the failed video attempt commit without repeating a submission", async (when) => {
        await videoFallback();
        const update = videoStore.updateVideoTask;
        const pause = vi.spyOn(videoStore, "updateVideoTask").mockImplementation(async (...args) => {
            if (when === "before" && args[1].attempts?.at(-1)?.status === "failed") throw new Error("fixture interrupted failure commit");
            const result = await update(...args);
            if (when === "after" && args[1].attempts?.at(-1)?.status === "failed") throw new Error("fixture interrupted failure commit");
            return result;
        });
        await expect(run()).rejects.toThrow("interrupted failure commit");
        pause.mockRestore();
        expect((await current()).billingRequests![0].preparation?.phase).toBe("finished");
        expect(upstreamCalls()).toHaveLength(0);
        const results = await Promise.allSettled([resume(), resume()]);
        expect(results.some((r) => r.status === "fulfilled" && r.value.id)).toBe(true);
        expect((await current()).attempts?.map((a) => a.attemptNo)).toEqual([1, 2]);
        expect((await current()).billingRequests).toHaveLength(2);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("resumes a persisted candidate switch through the worker using the original request snapshot", async () => {
        await videoFallback();
        const advance = videoStore.advancePricedVideoTask;
        const pause = vi.spyOn(videoStore, "advancePricedVideoTask").mockImplementationOnce(async (...args) => {
            await advance(...args);
            throw new Error("fixture interrupted after switch");
        });
        await expect(run()).rejects.toThrow("after switch");
        pause.mockRestore();
        expect((await current()).attempts?.map((a) => a.status)).toEqual(["failed", "running"]);
        expect((await current()).creation?.prompt).toBe(task.prompt);
        await scheduleGenerationTask("video", task.id, { executionPhase: "submitting", nextPollAt: Date.now() });
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).resultReady).toBe(1);
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).completed).toBe(1);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("fences an older executor after advancing the video attempt", async () => {
        await videoFallback();
        const advance = videoStore.advancePricedVideoTask;
        const pause = vi.spyOn(videoStore, "advancePricedVideoTask").mockRejectedValueOnce(new Error("fixture stop before advance"));
        await expect(run()).rejects.toThrow("before advance");
        pause.mockRestore();
        const stale = await current();
        await advance(task.id, 1);
        await expect(videoStore.updateVideoTask(task.id, { attempts: stale.attempts, config: stale.config, upstream: stale.upstream }, 1)).rejects.toThrow("尝试已变化");
        await expect(videoStore.bindVideoTaskBillingRequest({ taskId: task.id, userId, ...stale.billingRequests![0] })).rejects.toThrow("调用状态");
        await expect(advance(task.id, 1)).rejects.toThrow("不能切换");
        await resume();
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("keeps an unknown video submission on its original attempt despite a saved backup", async () => {
        await videoStore.updateVideoTask(task.id, { candidateConfigs: [task.config] });
        vi.spyOn(wallet, "acknowledgeModelPriceVideoSubmission").mockRejectedValue(new Error("fixture acknowledgement unavailable"));
        await expect(run()).rejects.toThrow("待核对");
        await expect(resume()).rejects.toThrow("待核对");
        expect((await current()).attempts).toHaveLength(1);
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect((await current()).billingPending).toBe(true);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("keeps a preparing video claim and candidate after a preflight interruption", async () => {
        await videoFallback();
        vi.spyOn(videoStore, "finishVideoTaskBillingPreparation").mockRejectedValueOnce(new Error("fixture preparation interrupted"));
        await expect(run()).rejects.toThrow("preparation interrupted");
        await expect(resume()).rejects.toThrow("待核对");
        expect((await current()).billingRequests![0].preparation?.phase).toBe("preparing");
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("uses a saved supported video candidate after a locally unsupported pricing protocol", async () => {
        const supported = task.config;
        task = await createVideoTask({ ...task, clientRequestId: `unsupported-${userId}`, config: { ...supported, apiFormat: "gemini", advancedConfig: { ...supported.advancedConfig!, protocol: "gemini" } }, candidateConfigs: [supported] });
        await run();
        expect((await current()).attempts?.map((a) => a.status)).toEqual(["failed", "running"]);
        expect((await current()).billingRequests).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("honors cancellation before consuming the next video candidate", async () => {
        await videoFallback();
        const advance = videoStore.advancePricedVideoTask;
        vi.spyOn(videoStore, "advancePricedVideoTask").mockImplementationOnce(async (...args) => {
            await cancel();
            return advance(...args);
        });
        await expect(run()).rejects.toThrow("不能切换");
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect((await current()).status).toBe("cancelled");
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("keeps a preparation withdrawal authoritative when racing video failover", async () => {
        await videoFallback();
        const finish = videoStore.finishVideoTaskBilling;
        vi.spyOn(videoStore, "finishVideoTaskBilling").mockImplementationOnce(async (...args) => {
            await wallet.stopModelPricePreparation({ taskId: task.id, taskType: "video", ...(await key()), reviewedBy: "admin", evidence: "Stop original attempt before any backup" });
            return finish(...args);
        });
        await expect(run()).rejects.toThrow();
        expect((await current()).billingRequests![0].preparationStop).toBeTruthy();
        expect((await current()).candidateConfigs).toHaveLength(1);
        await expect(resume()).rejects.toThrow("已撤销");
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("ends exhausted video candidates without falling back to fixed billing", async () => {
        await videoFallback(["unreviewed", "unreviewed-second"]);
        await videoStore.updateVideoTask(task.id, { candidateConfigs: [] });
        await expect(run()).rejects.toThrow();
        expect((await current()).attempts?.map((a) => a.status)).toEqual(["failed"]);
        expect((await current()).candidateConfigs).toEqual([]);
        expect((await current()).billingPending).toBe(false);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("uses distinct billing identities even when the saved video candidate repeats a channel", async () => {
        await videoStore.updateVideoTask(task.id, { candidateConfigs: [task.config] });
        vi.spyOn(wallet, "reserveModelPricePoints").mockRejectedValueOnce(new PricingInputError("fixture preflight rejection before reservation"));
        await run();
        const requests = (await current()).billingRequests!;
        expect(requests).toHaveLength(2);
        expect(requests[0].requestId).not.toBe(requests[1].requestId);
        expect(requests.map((r) => r.attemptNo)).toEqual([1, 2]);
        expect(await wallet.getModelPriceReservation({ userId, ...requests[0] })).toBeUndefined();
        expect(await wallet.getModelPriceReservation({ userId, ...requests[1] })).toMatchObject({ status: "reserved", submission: { phase: "submitted" } });
        expect((await query()).state).toBe("result_ready");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("starts a fresh configured polling window when an interrupted backup is finally submitted", async () => {
        await videoFallback();
        const advance = videoStore.advancePricedVideoTask;
        const pause = vi.spyOn(videoStore, "advancePricedVideoTask").mockImplementationOnce(async (...args) => {
            await advance(...args);
            throw new Error("fixture interrupted switch");
        });
        await expect(run()).rejects.toThrow("interrupted switch");
        pause.mockRestore();
        await scheduleGenerationTask("video", task.id, { executionPhase: "submitting", submittedAt: 1, nextPollAt: Date.now() });
        const execute = internal.fetchInternalApi;
        const prior = vi.mocked(execute).getMockImplementation()!;
        vi.mocked(execute).mockImplementation(async (...args) => {
            const response = await prior(...args);
            for (const row of fixture.tasks.values()) (row as Record<string, unknown>).status = "processing";
            return response;
        });
        const started = Date.now();
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).pending).toBe(1);
        const record = await getStoredGenerationTaskRecord("video", task.id);
        expect(record?.submittedAt).toBeGreaterThanOrEqual(started);
        expect(record?.executionPhase).toBe("polling");
        expect(record?.channelId).toBe("channel");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
    });

    it("rechecks the original H3 task, preserves its first receipt and settles later completed meters once", async () => {
        await run();
        task = await current();
        delete (providerTask().usage as Record<string, number>).output_seconds;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        const first = (await current()).pricedResponses![0];
        (providerTask().usage as Record<string, number>).output_seconds = 5.25;
        const response = await recoverVideo(new Request("http://internal/api/video-tasks/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect((await current()).pricedResponses![0]).toMatchObject({ observation: first.observation, resultUrl: first.resultUrl, recovered: { observation: { quantities: { outputSeconds: "5.25" } } } });
        const saved = await wallet.getModelPriceReservation(await key());
        expect(saved).toMatchObject({ status: "settled", settlement: { chargedPoints: "1.05" }, settledObservation: { quantities: { outputSeconds: "5.25" } } });
        expect(saved?.submission?.response?.observation).toEqual(first.observation);
        expect(saved?.settledVideoQuote?.evidenceId).not.toBe(saved?.submission?.response?.fingerprint);
        expect(saved?.settledVideoUsageFacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ meter: "inputSeconds", sourceEvidenceId: saved?.submission?.response?.fingerprint }),
                expect.objectContaining({ meter: "outputSeconds", sourcePaths: ["task.usage.output_seconds"], evidenceId: saved?.settledVideoQuote?.evidenceId }),
            ]),
        );
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(2);
    });

    it("holds a later H3 receipt that changes a known meter, then accepts a consistent original-task requery", async () => {
        await run();
        task = await current();
        delete (providerTask().usage as Record<string, number>).output_seconds;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        const first = (await current()).pricedResponses![0];
        Object.assign(providerTask().usage as Record<string, number>, { output_seconds: 5.25, input_seconds: 1 });
        expect((await query()).state).toBe("needs_review");
        expect((await current()).pricedResponses![0]).toEqual(first);
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        (providerTask().usage as Record<string, number>).input_seconds = 0;
        expect((await query()).state).toBe("result_ready");
        expect((await current()).pricedResponses![0].recovered?.observation).toMatchObject({ quantities: { outputSeconds: "5.25" } });
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(3);
    });

    it("refunds a recovered H3 charge once when the original task is cancelled", async () => {
        await run();
        task = await current();
        delete (providerTask().usage as Record<string, number>).output_seconds;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        (providerTask().usage as Record<string, number>).output_seconds = 5.25;
        expect((await query()).state).toBe("result_ready");
        await cancel();
        expect(await refundPricedVideoTask(await current())).toBe(true);
        expect(await refundPricedVideoTask(await current())).toBe(true);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await getPricingWalletView(userId)).items[0]).toMatchObject({ refundedPoints: "1.05" });
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(2);
    });

    it("creates once, reserves before acknowledgement, settles terminal usage and persists real media", async () => {
        const created = await run();
        expect(created.id).toBeTruthy();
        task = await current();
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved", allocation: { heldPoints: "3.00" }, submission: { phase: "submitted", upstreamTaskId: created.id } });
        expect(task).toMatchObject({ billingPending: true, upstream: { id: created.id } });
        expect(task.upstream.pointsRecordId).toBeUndefined();
        const step = await query();
        expect(step.state).toBe("result_ready");
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        expect(await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId)).toMatchObject({ status: "success", billingPending: false, result: { mimeType: "video/mp4" } });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled", settlement: { chargedPoints: "1.05" } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("98.95");
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect(await query()).toMatchObject({ state: "result_ready" });
        expect(queries()).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
        expect(JSON.stringify(await wallet.getModelPriceReservation(await key()))).not.toMatch(/private video prompt|\/media\/hailuo/);
    });

    it("rejects duplicate create attempts and restores the original acknowledgement after wallet interruption", async () => {
        vi.spyOn(wallet, "acknowledgeModelPriceVideoSubmission").mockRejectedValueOnce(new Error("fixture interrupted ack"));
        await expect(run()).rejects.toThrow("待核对");
        expect((await current()).pricedSubmissions).toHaveLength(1);
        expect((await wallet.getModelPriceReservation(await key()))?.submission?.phase).toBe("outcome_unknown");
        await expect(run()).rejects.toThrow("待核对");
        expect((await recoverPricedVideoTask(await current()))?.state).toBe("pending");
        expect((await wallet.getModelPriceReservation(await key()))?.submission?.phase).toBe("submitted");
        expect((await query()).state).toBe("result_ready");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("replays saved metering and result after settlement interruption even with unpublished prices", async () => {
        await run();
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("interrupted settlement"));
        expect((await query()).state).toBe("needs_review");
        expect((await current()).pricedResponses).toHaveLength(1);
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        const response = await recoverVideo(new Request("http://internal/api/video-tasks/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), {
            params: Promise.resolve({ id: task.id }),
        });
        expect(response.status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
        expect(JSON.stringify(await response.json())).not.toMatch(/billingRequests|pricedResponses|creation|candidateConfigs|private video prompt|submission|requestFingerprint/);
    });

    it("keeps unknown creation pinned and never resubmits or releases its held points", async () => {
        vi.spyOn(videoStore, "savePricedVideoTaskSubmission").mockRejectedValueOnce(new Error("interrupted receipt"));
        await expect(run()).rejects.toThrow("待核对");
        expect((await recoverPricedVideoTask(await current()))?.state).toBe("needs_review");
        await cancel();
        expect(await refundPricedVideoTask(await current())).toBe(false);
        expect(await current()).toMatchObject({ billingPending: true });
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(0);
    });

    it.each(["cancelled", "failed", "missing", "audio", "excess"])("holds incomplete or unpriceable terminal usage (%s) without a fixed-price retry", async (kind) => {
        await run();
        task = await current();
        const remote = providerTask();
        if (kind === "cancelled" || kind === "failed") remote.status = kind;
        else if (kind === "missing") remote.usage = {};
        else if (kind === "audio") (remote.usage as Record<string, number>).input_audio_seconds = 1;
        else remote.usage = { total_seconds: 16, input_seconds: 0, output_seconds: 16, input_image_count: 0, input_audio_seconds: 0 };
        expect((await query()).state).toBe("needs_review");
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect((await current()).billingPending).toBe(true);
        expect((await query()).state).toBe("needs_review");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(kind === "missing" ? 2 : 1);
    });

    it("cancellation after acknowledgement settles original usage and refunds it exactly once", async () => {
        await run();
        await cancel();
        const result = await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 });
        expect(result.completed).toBe(1);
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, upstream: { refunded: true } });
        expect(await refundPricedVideoTask(await current())).toBe(true);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await getPricingWalletView(userId)).items[0]).toMatchObject({ refundedPoints: "1.05" });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("stops preparation before submission on cancellation without a late paid call", async () => {
        const reserve = wallet.reserveModelPricePoints;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementationOnce(async (input) => {
            const result = await reserve(input);
            await cancel();
            return result;
        });
        await expect(run()).rejects.toThrow();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("released");
        expect((await current()).billingPending).toBe(false);
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("accepts a standing-free audio reference with the reviewed video contract", async () => {
        await run([{ type: "audio", url: "https://example.com/reference.mp3" }]);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved", frozen: { maximumUsage: { inputAudioSeconds: "0" } } });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("retains an expired unresolved task and prevents deleting its conversation", async () => {
        await run();
        if (provider === "postgres") await postgresQuery("UPDATE generation_tasks SET expires_at = now() - interval '1 day' WHERE id = $1", [task.id]);
        else await withGenerationTaskFileMutation(async (rows) => ({ tasks: rows.map((item) => (item.id === task.id ? { ...item, expiresAt: Date.now() - 1 } : item)), result: undefined }));
        await cleanupExpiredStoredGenerationTasks({ limit: 100 });
        expect((await current()).billingPending).toBe(true);
        await expect(deleteCreativeConversationAggregates(userId, [task.conversationId!])).rejects.toThrow();
        expect((await getStoredGenerationTaskRecord("video", task.id))?.payload.billingPending).toBe(true);
    });

    it("checks a still-running original task once and permits later cancellation recovery", async () => {
        await run();
        task = await current();
        providerTask().status = "processing";
        const recover = () =>
            recoverVideo(new Request("http://internal/api/video-tasks/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), { params: Promise.resolve({ id: task.id }) });
        expect((await recover()).status).toBe(200);
        expect(queries()).toHaveLength(1);
        expect((await getStoredGenerationTaskRecord("video", task.id))?.executionPhase).toBe("needs_review");
        expect((await getStoredGenerationTaskRecord("video", task.id))?.nextPollAt).toBeUndefined();
        await cancel();
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).needsReview).toBe(1);
        expect((await current()).billingPending).toBe(true);
        providerTask().status = "completed";
        expect((await recover()).status).toBe(200);
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, upstream: { refunded: true } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(3);
    });

    it("recovers a durable creation interrupted before the scheduler identity was saved", async () => {
        const schedule = scheduler.scheduleGenerationTask;
        const pause = vi.spyOn(scheduler, "scheduleGenerationTask").mockImplementation(async (...args) => {
            if (args[2].upstreamTaskId) throw new Error("fixture interrupted schedule identity");
            return schedule(...args);
        });
        await expect(run()).rejects.toThrow("interrupted schedule identity");
        pause.mockRestore();
        expect((await getStoredGenerationTaskRecord("video", task.id))?.upstreamTaskId).toBeUndefined();
        await scheduleGenerationTask("video", task.id, { executionPhase: "submitting", nextPollAt: Date.now(), channelId: "channel" });
        await videoStore.updateVideoTask(task.id, { upstream: task.upstream }); // Replay a stale pre-create row; the immutable acknowledgement must win.
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).resultReady).toBe(1);
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).completed).toBe(1);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("cannot bypass a retained video bill with the generic operator task-review action", async () => {
        await run();
        await expect(reviewGenerationTask("video", task.id, { action: "confirm_failed" })).rejects.toThrow("原计费凭据");
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect((await current()).billingPending).toBe(true);
    });

    it("preserves original identities and rejects changed requests or another attempt's receipt", async () => {
        await run();
        const ref = await key();
        await expect(videoStore.savePricedVideoTaskSubmission({ taskId: task.id, ...ref, upstreamTaskId: "another-task" })).rejects.toThrow("不能改写");
        task.prompt = "a changed private request";
        await expect(run()).rejects.toThrow("待核对");
        expect(upstreamCalls()).toHaveLength(1);
        await videoStore.updateVideoTask(task.id, { attempts: [{ attemptNo: 2, channelId: "channel", model: "priced-video", status: "running", startedAt: Date.now() }] });
        await expect(videoStore.savePricedVideoTaskSubmission({ taskId: task.id, ...ref, upstreamTaskId: "another-task" })).rejects.toThrow("身份已变化");
    });

    it("serializes concurrent create submissions to one original upstream request", async () => {
        const results = await Promise.allSettled([run(), run()]);
        expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
        expect((await query()).state).toBe("result_ready");
        expect((await getPricingWalletView(userId)).items).toHaveLength(1);
    });

    it("honors a persisted preparation stop and forbids late reservation or submission", async () => {
        const reserve = wallet.reserveModelPricePoints;
        let attempted: Parameters<typeof reserve>[0] | undefined;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementationOnce(async (input) => {
            attempted = input;
            throw new Error("interrupted preparation");
        });
        await expect(run()).rejects.toThrow("待核对");
        await wallet.stopModelPricePreparation({ ...(await key()), taskId: task.id, taskType: "video", attemptNo: 1, reviewedBy: "fixture-admin", evidence: "Confirmed local preparation never acquired a submission claim" });
        expect((await recoverPricedVideoTask(await current()))?.state).toBe("failed");
        expect((await current()).billingPending).toBe(false);
        await expect(reserve(attempted!)).rejects.toThrow("已撤销");
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("rejects forged task signatures at the proxy before any wallet or upstream mutation", async () => {
        const headers = new Headers({ "content-type": "application/json", ...systemAiBillingHeaders("priced-video", "forged", model, undefined, undefined, { taskId: task.id, attemptNo: 1 }) });
        headers.set(SYSTEM_AI_VIDEO_TASK_HEADER, Buffer.from(JSON.stringify({ taskId: task.id, attemptNo: 2 })).toString("base64url"));
        const response = await proxyPost(
            new Request("http://internal/api/ai/system/channel/v2/video_generation", { method: "POST", headers, body: JSON.stringify({ model, duration: 5, resolution: "768P", content: [{ type: "text", text: "fixture" }] }) }),
            { params: Promise.resolve({ channelId: "channel", path: ["v2", "video_generation"] }) },
        );
        expect(response.status).toBe(403);
        expect(upstreamCalls()).toHaveLength(0);
        expect((await current()).billingRequests).toBeUndefined();
    });

    const waitForReview = async () => scheduleGenerationTask("video", task.id, { executionPhase: "needs_review", nextPollAt: undefined }, { cancellation: true });
    const review = async (input: Parameters<typeof reviewPricingTask>[1]) => reviewPricingTask(task.id, input, "fixture-reviewer", "video", "http://internal");
    const receipt = () => ({
        task: {
            id: task.upstream.id,
            model,
            status: "succeeded",
            resolution: "768P",
            task_type: "generation",
            modality: "video",
            content: { url: `${origin}/media/hailuo.mp4` },
            usage: { total_seconds: 5.25, input_seconds: 0, output_seconds: 5.25, input_image_count: 0, input_audio_seconds: 0 },
        },
    });
    const provide = (payload = receipt(), action = "provide_metered_result") => ({ action, attemptNo: 1, evidence: "Supplier original task receipt fixture-123", response: JSON.stringify(payload) });
    const incomplete = async (invalid = false) => {
        await run();
        task = await current();
        const usage = providerTask().usage as Record<string, number>;
        if (invalid) usage.output_seconds = -1;
        else delete usage.output_seconds;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
    };

    it("supplements missing original video usage, persists the media and keeps both receipts immutable", async () => {
        await incomplete();
        const original = (await current()).pricedResponses![0];
        expect(await getPricingTaskReview(task.id, "video")).toMatchObject({ canReviewSubmission: true, canCorrectUsage: false, pending: true });
        expect(await review(provide())).toMatchObject({ executionPhase: "completed" });
        const final = await current();
        expect(final).toMatchObject({ status: "success", billingPending: false });
        expect(final.pricedResponses![0]).toEqual(original);
        expect(final.billingRequests![0].review?.decision).toMatchObject({ reviewedBy: "fixture-reviewer", outcome: { kind: "response" } });
        const saved = await wallet.getModelPriceReservation(await key());
        expect(saved).toMatchObject({ status: "settled", settlement: { chargedPoints: "1.05" } });
        expect(saved?.submission?.response?.observation).toEqual(original.observation);
        expect(JSON.stringify(saved)).not.toMatch(/hailuo.mp4|private video prompt/);
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
    });

    it("corrects only an explicitly saved invalid receipt without changing video identity or media", async () => {
        await incomplete(true);
        const original = (await current()).pricedResponses![0];
        expect(await getPricingTaskReview(task.id, "video")).toMatchObject({ canCorrectUsage: true });
        await expect(review(provide())).rejects.toThrow();
        const changed = receipt();
        changed.task.content.url = `${origin}/media/another.mp4`;
        await expect(review(provide(changed, "correct_metered_result"))).rejects.toThrow("结果地址");
        expect(await review(provide(receipt(), "correct_metered_result"))).toMatchObject({ executionPhase: "completed" });
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await current()).billingRequests![0].review?.decision.outcome).toMatchObject({ kind: "response", correctedObservation: original.observation });
        expect((await wallet.getModelPriceReservation(await key()))?.settlement?.chargedPoints).toBe("1.05");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it.each(["task", "model", "resolution", "modality", "status", "bound", "audio"])("rejects reviewed responses outside the original video contract (%s)", async (field) => {
        await incomplete(true);
        const body = receipt();
        if (field === "task") body.task.id = "another-task";
        if (field === "model") body.task.model = "MiniMax-H3-Max";
        if (field === "resolution") body.task.resolution = "2K";
        if (field === "modality") body.task.modality = "audio";
        if (field === "status") body.task.status = "failed";
        if (field === "bound") body.task.usage.output_seconds = 16;
        if (field === "audio") body.task.usage.input_audio_seconds = 1;
        await expect(review(provide(body, "correct_metered_result"))).rejects.toThrow();
        expect((await current()).billingRequests![0].review).toBeUndefined();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
    });

    it("requires genuine missing facts for supplements and saved contradictions for corrections", async () => {
        await incomplete();
        const body = receipt();
        body.task.usage.total_seconds = 5.5;
        await expect(review(provide(body))).rejects.toThrow("事实冲突");
        await expect(review(provide(receipt(), "correct_metered_result"))).rejects.toThrow("矛盾计量");
        await expect(review({ action: "confirm_no_charge", attemptNo: 1, evidence: "Cancellation does not prove free usage" })).rejects.toThrow("已有视频响应");
        expect((await current()).billingPending).toBe(true);
    });

    it("replays a durable review after wallet interruption and ignores later price publication", async () => {
        await incomplete();
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture interrupted review"));
        await expect(review(provide())).rejects.toThrow("interrupted review");
        const decision = (await current()).billingRequests![0].review;
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        await expect(review({ ...provide(), evidence: "rewritten" })).rejects.toThrow("不能改写");
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await current()).billingRequests![0].review).toEqual(decision);
        expect((await wallet.getModelPriceReservation(await key()))?.settlement?.chargedPoints).toBe("1.05");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
    });

    it("reviews a cancelled video's original receipt and refunds only its original charge", async () => {
        await incomplete();
        await cancel();
        await waitForReview();
        expect(await review(provide())).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, upstream: { refunded: true } });
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await getPricingWalletView(userId)).items[0].refundedPoints).toBe("1.05");
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("persists explicit no-charge evidence, releases once and fences late metering", async () => {
        await videoStore.updateVideoTask(task.id, { candidateConfigs: [task.config] });
        await run();
        task = await current();
        await waitForReview();
        const input = { action: "confirm_no_charge", attemptNo: 1, evidence: "Supplier invoice proves this original request was not charged" };
        expect(await review(input)).toMatchObject({ executionPhase: "completed" });
        expect(await review(input)).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("released");
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        await expect(videoStore.savePricedVideoTaskSubmission({ taskId: task.id, ...(await key()), upstreamTaskId: "late-other" })).rejects.toThrow();
        expect((await query()).state).toBe("failed");
        expect(queries()).toHaveLength(0);
        await expect(resume()).rejects.toThrow("已结束");
        expect((await current()).candidateConfigs).toHaveLength(1);
        expect((await current()).attempts).toHaveLength(1);
        expect(upstreamCalls()).toHaveLength(1);
    });

    it("requires original create acknowledgement to supplement an unknown submission", async () => {
        vi.spyOn(videoStore, "savePricedVideoTaskSubmission").mockRejectedValueOnce(new Error("missing original ack"));
        await expect(run()).rejects.toThrow();
        await waitForReview();
        expect(await getPricingTaskReview(task.id, "video")).toMatchObject({ canProvideResult: false, canReviewSubmission: true });
        await expect(review(provide())).rejects.toThrow("原创建确认");
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect(await review({ action: "confirm_no_charge", attemptNo: 1, evidence: "Supplier located the original business request and confirmed no charge" })).toMatchObject({ executionPhase: "completed" });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
    });

    it("withdraws interrupted preparation through the review service and rejects stale attempts", async () => {
        vi.spyOn(wallet, "reserveModelPricePoints").mockRejectedValueOnce(new Error("interrupted preparation"));
        await expect(run()).rejects.toThrow();
        await waitForReview();
        expect(await getPricingTaskReview(task.id, "video")).toMatchObject({ canStopPreparation: true, canReviewSubmission: false, canResumeBilling: false });
        await expect(review({ action: "stop_preparation", attemptNo: 2, evidence: "stale" })).rejects.toThrow("尝试已变化");
        await expect(review({ action: "stop_preparation", attemptNo: 1, evidence: "" })).rejects.toThrow();
        expect(await review({ action: "stop_preparation", attemptNo: 1, evidence: "Confirmed no submission claim exists" })).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "error", billingPending: false });
        expect(upstreamCalls()).toHaveLength(0);
    });

    it("accepts one concurrent review and rejects changing the established supplier evidence", async () => {
        await incomplete();
        const results = await Promise.allSettled([review(provide()), review({ ...provide(), evidence: "another reviewer conclusion" })]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("98.95");
        expect(upstreamCalls()).toHaveLength(1);
    });
});
