vi.mock("./model-pricing-shadow-evidence", () => ({ getModelPricingShadowEvidence: async () => ({ ready: true, missingCount: 0, receiptIds: { fixture: "receipt" }, sample: null }) }));
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
import { writeAuthDb } from "@/lib/auth/store-repository";
import { resolveModelAdvancedConfig } from "./generation-channel";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { GET as proxyGet, POST as proxyPost } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { POST as publicCreateVideo } from "@/app/api/video-generation-tasks/route";
import { POST as recoverVideo } from "@/app/api/video-tasks/[id]/route";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import { saveVideoPriceContract } from "./model-pricing-video-contract-store";
import { saveModelPriceBinding } from "./model-price-binding-store";
import { createVideoTask, getVideoTask, transitionVideoTask, type VideoTask } from "./video-task-store";
import { queryVideoTaskUpstream, persistVideoTaskResult } from "./video-task-runtime";
import { createUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import { runGenerationTaskRecoveryBatch } from "./generation-task-recovery-service";
import { recoverPricedVideoTask, refundPricedVideoTask } from "./model-pricing-video-task";
import { getPricingTaskReview, reviewPricingTask } from "./model-pricing-task-review-service";
import * as wallet from "./model-pricing-wallet-service";
import * as internal from "./internal-origin";
import { scheduleGenerationTask } from "./generation-task-scheduler";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { createConversationForUser, listAssetsForUser } from "./creative-runtime-service";
import { cleanupExpiredStoredGenerationTasks, getStoredGenerationTaskRecord, withGenerationTaskFileMutation } from "./generation-task-store";
import { deleteCreativeConversationAggregates } from "./creative-entity-deletion-store";
import { HAILUO_PRICE_MODELS } from "./model-pricing-hailuo-contract";
import { setModelPricingActivation } from "./model-pricing-activation-service";
import { readPricingState } from "./model-pricing-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers.flatMap((provider) => HAILUO_PRICE_MODELS.map((model) => [provider, model] as const)))("priced Hailuo through real proxy (%s, %s)", (provider, model) => {
    let directory: string;
    let task: VideoTask;
    let userId: string;
    let versionId: string;
    let policyId: string;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let origin: string;
    let fixtureOptions: { hailuoCreateResponse?: Record<string, unknown> };

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-video-"));
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
            items: ["768P-6", "768P-10", "1080P-6"].map((key, i) => ({ key, unit: "video", per: "1", price: ["0.0105", "0.0205", "0.0305"][i], currency: "CNY" })),
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
                protocol: "minimax-hailuo-v1",
                scope: "global-standard-minimax-hailuo-generation",
                tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
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
            prompt: "private Hailuo video prompt",
            requestedDurationSeconds: 6,
            upstream: { id: "", model, provider: "generation", pollPath: "/v1/video_generation" },
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
    const run = async (duration = 6, resolution = "768P") =>
        createUpstream(
            userId,
            "http://internal",
            "",
            task.config,
            task.prompt!,
            { videoSeconds: duration, size: "16:9", vquality: resolution },
            model.endsWith("Fast") ? [{ type: "image", role: "first_frame", url: `${origin}/media/fixture.png` }] : [],
            (await mocks.settings()).generationPointMultipliers,
            task.clientRequestId!,
            await current(),
        );
    const query = async () => queryVideoTaskUpstream(await current(), "http://internal", "", userId);
    const upstreamCalls = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path === "/v1/video_generation");
    const queries = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "GET" && item.path.startsWith("/v1/query/video_generation"));
    const key = async () => ({ userId, ...(await current()).billingRequests!.at(-1)! });
    const providerTask = () => fixture.tasks.get(task.upstream.id) as Record<string, unknown>;
    const waitForReview = () => scheduleGenerationTask("video", task.id, { executionPhase: "needs_review", nextPollAt: undefined }, { cancellation: true });
    const review = (input: Parameters<typeof reviewPricingTask>[1]) => reviewPricingTask(task.id, input, "fixture-reviewer", "video", "http://internal");
    const receipt = () => ({ task_id: task.upstream.id, status: "Success", file_id: providerTask().fileId, video_width: 1920, video_height: 1080, base_resp: { status_code: 0 }, download_url: `${origin}/media/hailuo.mp4` });
    const provide = (payload: unknown = receipt(), action = "provide_metered_result") => ({ action, attemptNo: 1, evidence: "Supplier original task receipt fixture", response: JSON.stringify(payload) });
    const recover = () => recoverVideo(new Request("http://internal/api/video-tasks/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), { params: Promise.resolve({ id: task.id }) });
    it.skipIf(provider !== "file" || model !== "MiniMax-Hailuo-2.3")("settles an independently selected Hailuo price", async () => {
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
            evidence: "local Hailuo selection fixture",
            reviewedAt: new Date().toISOString(),
            reviewedBy: "admin",
        };
        await writeJsonDataFile("model-pricing.json", {
            ...state,
            officialVersions: state.officialVersions.map((version) =>
                version.id === versionId ? { ...version, logicalModelId: "", capability: "video", manufacturer: "MiniMax", processingTier: "standard", items: version.items.map((item) => ({ ...item, currency: "USD" })) } : version,
            ),
            priceBindings: [binding],
            salesVersions: state.salesVersions.map((sale) => ({ ...sale, priceVersionIds: {}, selectedPriceBindings: [{ logicalModelId: "priced-video", scope, bindingId: binding.id, bindingRevision: binding.revision, officialVersionId: versionId }] })),
        });
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, video: 2 } });
        const activated = await setModelPricingActivation({ modelId: "priced-video", enabled: true, expectedRevision: null, actorId: "fixture-admin" });
        expect(activated.active).toBe(true);
        const request = (requestId: string) =>
            new Request("http://internal/api/video-generation-tasks", {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": requestId },
                body: JSON.stringify({ config: { model: "priced-video", videoSeconds: 6, vquality: "768P", size: "16:9" }, prompt: "selected Hailuo video" }),
            });
        const created = await publicCreateVideo(request("selected-hailuo"));
        expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
        task = (await getVideoTask((await created.json()).task.id))!;
        expect(task).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId, priceSelection: { bindingRevision: binding.revision } } });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved", frozen: { priceSelection: { bindingRevision: binding.revision } } });
        await saveModelPriceBinding({ ...binding, evidence: "new Hailuo price selection review" }, binding.revision);
        const step = await query();
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled", frozen: { priceSelection: { bindingRevision: binding.revision } } });
        expect((await publicCreateVideo(request("stale-selected-hailuo"))).status).toBe(409);
        expect(upstreamCalls()).toHaveLength(1);
    });
    it.skipIf(provider !== "file")("settles a publicly created metered task through the real local proxy and replays its request", async () => {
        const settings = await getFreshAuthSettings();
        mocks.settings.mockResolvedValue({ ...settings, generationConcurrency: { ...settings.generationConcurrency, video: 2 } });
        const activated = await setModelPricingActivation({
            modelId: "priced-video",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Local TCP task, wallet and delivery fixture",
                realChannels: { [`channel/${model}`]: "Local channel fixture only" },
                entrypoints: "Public video creation fixture",
                recovery: "Original task query and idempotent replay fixture",
            },
        });
        const request = (requestId = "public-priced-hailuo") =>
            new Request("http://internal/api/video-generation-tasks", {
                method: "POST",
                headers: { "content-type": "application/json", "x-vozeb-pro-client-request-id": requestId },
                body: JSON.stringify({
                    config: { model: "priced-video", videoSeconds: 6, vquality: "768P", size: "16:9" },
                    prompt: "public Hailuo request",
                    references: model.endsWith("Fast") ? [{ type: "image", role: "first_frame", url: `${origin}/media/fixture.png` }] : [],
                }),
            });
        const [created, concurrent] = await Promise.all([publicCreateVideo(request()), publicCreateVideo(request())]);
        expect(created.status).toBe(200);
        const first = (await created.json()).task;
        expect(concurrent.status).toBe(200);
        expect((await concurrent.json()).task.id).toBe(first.id);
        const publicTask = (await getVideoTask(first.id))!;
        expect(publicTask).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId }, upstream: { id: expect.any(String) } });
        const reference = publicTask.billingRequests!.at(-1)!;
        expect(await wallet.getModelPriceReservation({ userId, ...reference })).toMatchObject({ status: "reserved", allocation: { heldPoints: "1.05" } });
        const replay = await publicCreateVideo(request());
        expect((await replay.json()).task.id).toBe(first.id);
        expect(upstreamCalls()).toHaveLength(1);
        await setModelPricingActivation({ modelId: "priced-video", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        const step = await queryVideoTaskUpstream(publicTask, "http://internal", "", userId);
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        expect(await persistVideoTaskResult((await getVideoTask(first.id))!, step.resultUrl, "http://internal", "", userId)).toMatchObject({ status: "success", billingPending: false, result: { mimeType: "video/mp4" } });
        expect(await wallet.getModelPriceReservation({ userId, ...reference })).toMatchObject({ status: "settled", settlement: { chargedPoints: "1.05" } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("98.95");
        const fixed = await publicCreateVideo(request("after-deactivation"));
        expect(fixed.status).toBe(200);
        expect((await getVideoTask((await fixed.json()).task.id))?.billingMode).toBeUndefined();
        expect(upstreamCalls()).toHaveLength(2);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("97.95");
    });
    it.each([
        [6, "768P", "1.05"],
        [10, "768P", "2.05"],
        [6, "1080P", "3.05"],
    ] as const)("creates one %ss %s task, freezes %s points and delivers real media", async (duration, resolution, points) => {
        const created = await run(duration, resolution);
        task = await current();
        expect(task.pricedSubmissions).toEqual([{ requestId: (await key()).requestId, upstreamTaskId: created.id, businessStatus: 0 }]);
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "reserved", allocation: { heldPoints: points }, submission: { phase: "submitted", upstreamTaskId: created.id } });
        const step = await query();
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        expect(await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId)).toMatchObject({ status: "success", billingPending: false, result: { mimeType: "video/mp4" } });
        expect(await wallet.getModelPriceReservation(await key())).toMatchObject({ status: "settled", settlement: { chargedPoints: points }, settledObservation: { protocol: "minimax-hailuo-v1", fileId: providerTask().fileId } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe((100 - Number(points)).toFixed(2));
        expect(await listAssetsForUser(userId, task.conversationId!)).toHaveLength(1);
        expect((await query()).state).toBe("result_ready");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
        expect(JSON.stringify(await wallet.getModelPriceReservation(await key()))).not.toMatch(/private Hailuo|download_url|\/media\/hailuo/);
    });
    it("restores the original business-success acknowledgement after a wallet interruption", async () => {
        vi.spyOn(wallet, "acknowledgeModelPriceVideoSubmission").mockRejectedValueOnce(new Error("fixture interrupted ack"));
        await expect(run()).rejects.toThrow("待核对");
        task = await current();
        expect(task.pricedSubmissions?.[0].businessStatus).toBe(0);
        await expect(run()).rejects.toThrow("待核对");
        expect((await recoverPricedVideoTask(await current()))?.state).toBe("pending");
        expect((await query()).state).toBe("result_ready");
        expect(upstreamCalls()).toHaveLength(1);
    });
    it.each([undefined, { status_code: 1000 }])("never invents a successful creation receipt from %j", async (base_resp) => {
        fixtureOptions.hailuoCreateResponse = { base_resp };
        await expect(run()).rejects.toThrow("待核对");
        expect((await current()).pricedSubmissions).toBeUndefined();
        expect((await wallet.getModelPriceReservation(await key()))?.submission?.phase).toBe("outcome_unknown");
        await expect(run()).rejects.toThrow("待核对");
        expect((await recoverPricedVideoTask(await current()))?.state).toBe("needs_review");
        expect(upstreamCalls()).toHaveLength(1);
        await waitForReview();
        await expect(review(provide({ task_id: "guessed" }))).rejects.toThrow("缺少原创建确认");
    });
    it("keeps an unavailable original file held and checks the same task once when it becomes available", async () => {
        await run();
        task = await current();
        providerTask().fileUnavailable = true;
        await expect(query()).rejects.toThrow();
        await waitForReview();
        expect((await current()).pricedResponses).toBeUndefined();
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        providerTask().fileUnavailable = false;
        const result = await recover();
        expect(result.status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect(queries()).toHaveLength(2);
        expect(upstreamCalls()).toHaveLength(1);
        expect(JSON.stringify(await result.json())).not.toMatch(/businessStatus|pricedResponses|billingRequests|requestFingerprint/);
    });
    it("recovers saved file facts after settlement interruption without another query or current prices", async () => {
        await run();
        task = await current();
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture settlement interruption"));
        expect((await query()).state).toBe("needs_review");
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        expect((await recover()).status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
    });
    it("rechecks the original Hailuo file facts and settles the frozen tier from a later complete response", async () => {
        await run();
        task = await current();
        delete providerTask().videoWidth;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        const first = (await current()).pricedResponses![0];
        providerTask().videoWidth = 1920;
        const result = await recover();
        expect(result.status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect((await current()).pricedResponses![0]).toMatchObject({ observation: first.observation, resultUrl: first.resultUrl, recovered: { observation: { width: 1920, fileId: providerTask().fileId } } });
        const saved = await wallet.getModelPriceReservation(await key());
        expect(saved).toMatchObject({ status: "settled", settlement: { chargedPoints: "1.05" }, settledObservation: { width: 1920 } });
        expect(saved?.submission?.response?.observation).toEqual(first.observation);
        expect(saved?.settledVideoQuote?.evidenceId).not.toBe(saved?.submission?.response?.fingerprint);
        expect(saved?.settledVideoUsageFacts).toEqual(expect.arrayContaining([expect.objectContaining({ value: "1", evidenceId: saved?.settledVideoQuote?.evidenceId, sourcePaths: expect.arrayContaining(["file_id", "bound.tier"]) })]));
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(2);
        expect(JSON.stringify(await result.json())).not.toMatch(/pricedResponses|billingRequests|requestFingerprint|recovered/);
    });
    it("keeps conflicting later Hailuo file facts held for review", async () => {
        await run();
        task = await current();
        delete providerTask().videoWidth;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        const first = (await current()).pricedResponses![0];
        Object.assign(providerTask(), { videoWidth: 1920, fileId: "different-file" });
        expect((await query()).state).toBe("needs_review");
        expect((await current()).pricedResponses![0]).toEqual(first);
        expect((await wallet.getModelPriceReservation(await key()))?.status).toBe("reserved");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(2);
    });
    it("resumes a saved Hailuo supplement after wallet interruption without querying or repricing", async () => {
        await run();
        task = await current();
        delete providerTask().videoWidth;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        providerTask().videoWidth = 1920;
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture original settlement interruption")).mockRejectedValueOnce(new Error("fixture recovered settlement interruption"));
        expect((await query()).state).toBe("needs_review");
        expect((await current()).pricedResponses![0].recovered?.observation).toMatchObject({ width: 1920 });
        expect(await getPricingTaskReview(task.id, "video")).toMatchObject({ canReviewSubmission: false, canProvideResult: false, canResumeBilling: true });
        if (provider === "postgres") await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [], salesVersions: [] });
        const result = await recover();
        expect(result.status).toBe(200);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect((await wallet.getModelPriceReservation(await key()))?.settlement?.chargedPoints).toBe("1.05");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(2);
    });
    it("settles and refunds a cancelled original video exactly once", async () => {
        await run();
        task = await current();
        await transitionVideoTask(task, { status: "cancelled" }, { executionPhase: "cancel_requested", nextPollAt: Date.now() });
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).completed).toBe(1);
        expect(await refundPricedVideoTask(await current())).toBe(true);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect((await getPricingWalletView(userId)).items[0]).toMatchObject({ refundedPoints: "1.05" });
        expect(upstreamCalls()).toHaveLength(1);
    });
    it.each(["missing", "invalid", "both"])("reviews original missing/invalid file facts (%s), preserves receipts and forbids substituted media", async (kind) => {
        const invalid = kind !== "missing";
        await run();
        task = await current();
        if (invalid) providerTask().error = "contradictory success";
        if (kind !== "invalid") delete providerTask().videoWidth;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        const original = (await current()).pricedResponses![0];
        expect(await getPricingTaskReview(task.id, "video")).toMatchObject({ canReviewSubmission: true, canCorrectUsage: invalid });
        const action = invalid ? "correct_metered_result" : "provide_metered_result";
        await expect(review(provide({ ...receipt(), download_url: `${origin}/media/another.mp4` }, action))).rejects.toThrow("结果地址");
        await expect(review(provide({ ...receipt(), file_id: "other-file" }, action))).rejects.toThrow();
        await expect(review({ action: "confirm_no_charge", attemptNo: 1, evidence: "failure is not free evidence" })).rejects.toThrow("已有视频响应");
        expect(await review(provide(receipt(), action))).toMatchObject({ executionPhase: "completed" });
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
        expect((await current()).pricedResponses![0]).toEqual(original);
        expect((await wallet.getModelPriceReservation(await key()))?.submission?.response?.observation).toEqual(original.observation);
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
    });
    it("verifies an uncaptured file through the original task before accepting a manual result", async () => {
        await run();
        task = await current();
        providerTask().fileUnavailable = true;
        await expect(query()).rejects.toThrow();
        await waitForReview();
        providerTask().fileUnavailable = false;
        await expect(review(provide({ ...receipt(), file_id: "other-file" }))).rejects.toThrow();
        await expect(review(provide({ ...receipt(), video_width: 999 }))).rejects.toThrow();
        expect((await current()).billingRequests![0].review).toBeUndefined();
        expect(await review(provide())).toMatchObject({ executionPhase: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(4);
        expect(await current()).toMatchObject({ status: "success", billingPending: false });
    });
    it("replays a durable file review after a wallet interruption", async () => {
        await run();
        task = await current();
        delete providerTask().videoWidth;
        expect((await query()).state).toBe("needs_review");
        await waitForReview();
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("interrupted review"));
        await expect(review(provide())).rejects.toThrow("interrupted review");
        expect((await current()).billingRequests![0].review?.resultUrl).toBe(`${origin}/media/hailuo.mp4`);
        expect(await review({ action: "resume_billing", attemptNo: 1 })).toMatchObject({ executionPhase: "completed" });
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(1);
    });
    it("uses a reviewed backup only after an unsubmitted preflight and freezes a distinct request", async () => {
        const settings = await mocks.settings();
        const channel = settings.systemChannels[0];
        mocks.settings.mockResolvedValue({
            ...settings,
            systemChannels: [{ ...channel, id: "unreviewed" }, channel],
            logicalModels: settings.logicalModels.map((row: { bindings: unknown[] }) => ({ ...row, bindings: [{ id: "backup", channelId: "unreviewed", upstreamModel: model, enabled: true, priority: 0 }, ...row.bindings] })),
        });
        task = await createVideoTask({
            ...task,
            clientRequestId: `fallback-${userId}`,
            config: { ...task.config, channelId: "unreviewed", baseUrl: "/api/ai/system/unreviewed" },
            candidateConfigs: [task.config],
            attempts: [{ attemptNo: 1, channelId: "unreviewed", model: "priced-video", status: "running", startedAt: Date.now() }],
        });
        await run();
        task = await current();
        const step = await query();
        if (step.state !== "result_ready") throw new Error(JSON.stringify(step));
        await persistVideoTaskResult(await current(), step.resultUrl, "http://internal", "", userId);
        expect((await current()).attempts?.map((row) => row.status)).toEqual(["failed", "succeeded"]);
        expect(new Set((await current()).billingRequests!.map((row) => row.requestId)).size).toBe(2);
        expect(await wallet.getModelPriceReservation({ userId, ...(await current()).billingRequests![0] })).toBeUndefined();
        expect((await wallet.getModelPriceReservation(await key()))?.settlement?.chargedPoints).toBe("1.05");
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

    it("checks a still-running original task once and permits later cancellation recovery", async () => {
        await run();
        task = await current();
        providerTask().status = "Processing";
        const recover = () =>
            recoverVideo(new Request("http://internal/api/video-tasks/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "recover" }) }), { params: Promise.resolve({ id: task.id }) });
        expect((await recover()).status).toBe(200);
        expect(queries()).toHaveLength(1);
        expect((await getStoredGenerationTaskRecord("video", task.id))?.executionPhase).toBe("needs_review");
        expect((await getStoredGenerationTaskRecord("video", task.id))?.nextPollAt).toBeUndefined();
        await transitionVideoTask(await current(), { status: "cancelled" }, { executionPhase: "cancel_requested", nextPollAt: Date.now() });
        expect((await runGenerationTaskRecoveryBatch({ origin: "http://internal", taskIds: [task.id], limit: 1 })).needsReview).toBe(1);
        expect((await current()).billingPending).toBe(true);
        providerTask().status = "Success";
        expect((await recover()).status).toBe(200);
        expect(await current()).toMatchObject({ status: "cancelled", billingPending: false, upstream: { refunded: true } });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("100");
        expect(upstreamCalls()).toHaveLength(1);
        expect(queries()).toHaveLength(3);
    });
});
