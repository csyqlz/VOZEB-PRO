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
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { POST as publicCreateText } from "@/app/api/text-tasks/route";
import { POST as proxyPost } from "@/app/api/ai/system/[channelId]/[...path]/route";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { writeJsonDataFile } from "./data-adapter";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { listFlatTextPriceContracts, saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import { setModelPricingActivation } from "./model-pricing-activation-service";
import { getCurrentSalesVersion, getOfficialVersionsByIds } from "./model-pricing-store";
import * as internal from "./internal-origin";
import { getTextTask } from "./text-task-store";
import { runTextTaskStep } from "./text-task-runtime";
import { getModelPriceReservation } from "./model-pricing-wallet-service";

const reservationEstimate = { method: "request-size-recent-output" as const, sourceUrl: "https://example.com/text-estimate", evidence: "fixture reviewed request-size and recent-output reservation estimate" };

describe("public text pricing and stable Agent child identity", () => {
    let directory: string;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let userId: string;
    let versionId: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-public-priced-text-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "fixture-worker-token-that-is-long-enough");
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind");
        const origin = `http://127.0.0.1:${address.port}`;
        userId = randomUUID();
        versionId = randomUUID();
        const publishedAt = new Date().toISOString();
        const modelId = "priced-text";
        const sku = "mock-text";
        const version: OfficialPriceVersion = {
            id: versionId,
            candidateId: "fixture",
            logicalModelId: modelId,
            manufacturer: "Fixture",
            series: "Text",
            officialVersion: sku,
            sku,
            tier: "paid",
            conditions: "local standard text fixture",
            sourceKind: "manual",
            sourceUrl: "https://example.com/pricing",
            evidence: "fixture",
            observedAt: publishedAt,
            publishedAt,
            reviewedBy: "admin",
            items: [
                { key: "input", unit: "token", per: "1", price: "0.01", currency: "CNY" },
                { key: "cache", unit: "token", per: "1", price: "0.001", currency: "CNY" },
                { key: "output", unit: "token", per: "1", price: "0.02", currency: "CNY" },
            ],
        };
        const policy: SalesVersion = {
            id: randomUUID(),
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { [modelId]: versionId },
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
        db.settings.systemChannels = [applyChannelProtocol({ id: "channel", name: "fixture", baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", models: [sku], enabled: true }, "openai")];
        db.settings.logicalModels = [{ id: modelId, name: modelId, manufacturer: "Fixture", capability: "text", enabled: true, bindings: [{ id: "fixture-binding", channelId: "channel", upstreamModel: sku, enabled: true, priority: 0 }] }];
        const user = {
            id: userId,
            accountId: "0001",
            username: `fixture_${userId}`,
            displayName: "文本计费夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 100,
            planId: db.settings.entitlements.defaultPlanId,
            passwordHash: "fixture-only",
            createdAt: publishedAt,
            updatedAt: publishedAt,
        };
        db.users.push(user);
        await writeAuthDb(db);
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        await saveFlatTextPriceContract(
            {
                officialVersionId: versionId,
                channelId: "channel",
                requestedModel: sku,
                reportedModel: sku,
                protocol: "openai-chat",
                scope: "global-standard-text-flat",
                region: "global",
                serviceTier: "default",
                itemMeters: { input: ["inputTokens", "cacheWriteTokens"], cache: ["cachedInputTokens"], output: ["outputTokens"] },
                evidence: "local fixture",
                reviewedBy: "admin",
                reviewedAt: publishedAt,
                requestLimits: { maxInputTokens: 16, maxOutputTokens: 16, maxCandidates: 1, sourceUrl: "https://example.com/limits", evidence: "fixture bound", includesReasoning: true },
                reservationEstimate,
            },
            null,
        );
        mocks.user.mockResolvedValue(user);
        mocks.settings.mockResolvedValue(await getFreshAuthSettings());
        vi.spyOn(internal, "fetchInternalApi").mockImplementation(async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const parts = new URL(request.url).pathname.split("/").filter(Boolean);
            if (parts.slice(0, 3).join("/") !== "api/ai/system" || request.method !== "POST") throw new Error("unexpected internal fixture path");
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

    it("replays one public child task and settles its frozen text price once after deactivation", async () => {
        const activated = await setModelPricingActivation({
            modelId: "priced-text",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Local text proxy and wallet fixture",
                realChannels: { "channel/mock-text": "Local channel fixture only" },
                entrypoints: "Public Agent text child fixture",
                recovery: "Original request replay fixture",
            },
        });
        const request = (requestId = "agent-run:child:1") =>
            new Request("http://internal/api/text-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    config: { model: "priced-text" },
                    messages: [{ role: "user", content: "public text request" }],
                    context: { runId: "run-one", parentTaskId: "child-one", attemptNo: 1, clientRequestId: requestId },
                }),
            });
        const [created, concurrent] = await Promise.all([publicCreateText(request()), publicCreateText(request())]);
        expect(created.status).toBe(200);
        const first = (await created.json()).task;
        expect(concurrent.status).toBe(200);
        expect((await concurrent.json()).task.id).toBe(first.id);
        expect(await getTextTask(first.id)).toMatchObject({ billingMode: "official-usage", pricingSnapshot: { officialVersionId: versionId }, clientRequestId: "agent-run:child:1", runId: "run-one" });
        expect((await (await publicCreateText(request())).json()).task.id).toBe(first.id);
        await setModelPricingActivation({ modelId: "priced-text", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        expect(await runTextTaskStep((await getTextTask(first.id))!, "http://internal", "")).toEqual({ state: "completed" });
        const completed = (await getTextTask(first.id))!;
        expect(completed).toMatchObject({ status: "success", billingPending: false, result: { content: "协议测试文本返回成功" } });
        expect(await getModelPriceReservation({ userId, ...completed.billingRequests![0] })).toMatchObject({ status: "settled", settlement: { chargedPoints: "22.20" } });
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toHaveLength(1);
        const fixed = await publicCreateText(request("agent-run:child:2"));
        expect(fixed.status).toBe(200);
        const fixedTask = (await getTextTask((await fixed.json()).task.id))!;
        expect(fixedTask.billingMode).toBeUndefined();
        expect(await runTextTaskStep(fixedTask, "http://internal", "")).toEqual({ state: "completed" });
        expect((await getTextTask(fixedTask.id))?.billing?.pointsCost).toBe(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("76.8");
    });

    it.each(["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"])("settles %s ordinary and cached input through one public Agent child request", async (sku) => {
        const version = (await getOfficialVersionsByIds([versionId]))[0];
        const policy = (await getCurrentSalesVersion())!;
        version.manufacturer = "Moonshot";
        version.series = sku === "kimi-k2.6" ? "Kimi K2.6" : sku === "kimi-k2.7-code" ? "Kimi K2.7 Code" : "Kimi K2.7 Code HighSpeed";
        version.officialVersion = sku;
        version.sku = sku;
        version.items = [
            { key: "input", unit: "token", per: "1000000", price: sku.endsWith("highspeed") ? "1.90" : "0.95", currency: "USD" },
            { key: "cache", unit: "token", per: "1000000", price: sku === "kimi-k2.6" ? "0.16" : sku.endsWith("highspeed") ? "0.38" : "0.19", currency: "USD" },
            { key: "output", unit: "token", per: "1000000", price: sku.endsWith("highspeed") ? "8" : "4", currency: "USD" },
        ];
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        const db = await readAuthDb();
        db.settings.systemChannels[0].models = [sku];
        db.settings.logicalModels[0].bindings[0].upstreamModel = sku;
        db.settings.logicalModels[0].manufacturer = "Moonshot";
        if (sku.endsWith("highspeed")) db.users[0].pointsBalance = 300;
        await writeAuthDb(db);
        mocks.settings.mockResolvedValue(await getFreshAuthSettings());
        await saveFlatTextPriceContract(
            {
                officialVersionId: versionId,
                channelId: "channel",
                requestedModel: sku,
                reportedModel: sku,
                protocol: "openai-chat",
                scope: "global-standard-text-flat",
                region: "global",
                serviceTier: "default",
                itemMeters: { input: ["uncachedInputTokens"], cache: ["cachedInputTokens"], output: ["outputTokens"] },
                evidence: "Local Kimi no-cache-write fixture",
                reviewedBy: "admin",
                reviewedAt: new Date().toISOString(),
                requestLimits: {
                    maxInputTokens: 16,
                    maxOutputTokens: 32768,
                    maxCandidates: 1,
                    sourceUrl: sku === "kimi-k2.6" ? "https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart" : sku.endsWith("highspeed") ? "https://platform.kimi.ai/docs/api/models-overview" : "https://platform.kimi.ai/docs/guide/use-thinking-models",
                    evidence: "Local text ceiling fixture; Kimi K2 default output includes reasoning",
                    includesReasoning: true,
                },
                reservationEstimate,
            },
            null,
        );
        const activated = await setModelPricingActivation({
            modelId: "priced-text",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Kimi local protocol and wallet fixture",
                realChannels: { [`channel/${sku}`]: "Local channel fixture only" },
                entrypoints: "Public Agent text child fixture",
                recovery: "Same task after activation is switched off",
            },
        });
        const request = () =>
            new Request("http://internal/api/text-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    config: { model: "priced-text" },
                    messages: [{ role: "user", content: "public Kimi text request" }],
                    context: { runId: "kimi-run", parentTaskId: "kimi-child", attemptNo: 1, clientRequestId: "kimi-run:child:1" },
                }),
            });
        const created = await publicCreateText(request());
        expect(created.status).toBe(200);
        const task = (await created.json()).task;
        expect((await (await publicCreateText(request())).json()).task.id).toBe(task.id);
        await setModelPricingActivation({ modelId: "priced-text", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        expect(await runTextTaskStep((await getTextTask(task.id))!, "http://internal", "")).toEqual({ state: "completed" });
        const completed = (await getTextTask(task.id))!;
        expect(completed).toMatchObject({ status: "success", billingPending: false, billingMode: "official-usage" });
        expect(await getModelPriceReservation({ userId, ...completed.billingRequests![0] })).toMatchObject({
            status: "settled",
            settledUsage: { input: "6", cache: "2", output: "8" },
            settlement: { chargedPoints: sku.endsWith("highspeed") ? "0.05" : "0.03" },
        });
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toHaveLength(1);
        if (sku !== "kimi-k2.6") {
            const fixed = await publicCreateText(
                new Request("http://internal/api/text-tasks", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        config: { model: "priced-text" },
                        messages: [{ role: "user", content: "next fixed-price request" }],
                        context: { runId: "kimi-run", parentTaskId: "kimi-child-2", attemptNo: 1, clientRequestId: "kimi-run:child:2" },
                    }),
                }),
            );
            expect(fixed.status).toBe(200);
            const fixedTask = (await getTextTask((await fixed.json()).task.id))!;
            expect(fixedTask.billingMode).toBeUndefined();
            expect(await runTextTaskStep(fixedTask, "http://internal", "")).toEqual({ state: "completed" });
            expect((await getTextTask(fixedTask.id))?.billing?.pointsCost).toBe(1);
        }
    });

    it("settles Kimi K3 cache-write TTL buckets through one public Agent child request", async () => {
        const sku = "kimi-k3";
        const version = (await getOfficialVersionsByIds([versionId]))[0];
        const policy = (await getCurrentSalesVersion())!;
        version.manufacturer = "Moonshot";
        version.series = "Kimi K3";
        version.officialVersion = sku;
        version.sku = sku;
        version.items = [
            { key: "input", unit: "token", per: "1000000", price: "3", currency: "USD" },
            { key: "cache", unit: "token", per: "1000000", price: "0.30", currency: "USD" },
            { key: "write5m", unit: "token", per: "1000000", price: "3", currency: "USD" },
            { key: "write1h", unit: "token", per: "1000000", price: "6", currency: "USD" },
            { key: "output", unit: "token", per: "1000000", price: "15", currency: "USD" },
        ];
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        const db = await readAuthDb();
        db.settings.systemChannels[0].models = [sku];
        db.settings.logicalModels[0].bindings[0].upstreamModel = sku;
        db.settings.logicalModels[0].manufacturer = "Moonshot";
        db.users[0].pointsBalance = 2000;
        await writeAuthDb(db);
        mocks.settings.mockResolvedValue(await getFreshAuthSettings());
        await saveFlatTextPriceContract(
            {
                officialVersionId: versionId,
                channelId: "channel",
                requestedModel: sku,
                reportedModel: sku,
                protocol: "openai-chat",
                scope: "global-standard-text-flat",
                region: "global",
                serviceTier: "default",
                itemMeters: { input: ["inputTokens"], cache: ["cachedInputTokens"], write5m: ["cacheWrite5mTokens"], write1h: ["cacheWrite1hTokens"], output: ["outputTokens"] },
                evidence: "Kimi K3 local TTL headers fixture",
                reviewedBy: "admin",
                reviewedAt: new Date().toISOString(),
                requestLimits: {
                    maxInputTokens: 16,
                    maxOutputTokens: 131072,
                    maxCandidates: 1,
                    sourceUrl: "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
                    evidence: "Local input ceiling fixture; official K3 default output",
                    includesReasoning: true,
                },
                reservationEstimate,
            },
            null,
        );
        const activated = await setModelPricingActivation({
            modelId: "priced-text",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Kimi K3 local header and wallet fixture",
                realChannels: { "channel/kimi-k3": "Local channel fixture only" },
                entrypoints: "Public Agent text child fixture",
                recovery: "Same task after activation is switched off",
            },
        });
        const request = (requestId = "k3-run:child:1") =>
            new Request("http://internal/api/text-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    config: { model: "priced-text" },
                    messages: [{ role: "user", content: "public Kimi K3 text request" }],
                    context: { runId: "k3-run", parentTaskId: "k3-child", attemptNo: 1, clientRequestId: requestId },
                }),
            });
        const created = await publicCreateText(request());
        expect(created.status).toBe(200);
        const task = (await created.json()).task;
        expect((await (await publicCreateText(request())).json()).task.id).toBe(task.id);
        await setModelPricingActivation({ modelId: "priced-text", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        expect(await runTextTaskStep((await getTextTask(task.id))!, "http://internal", "")).toEqual({ state: "completed" });
        const completed = (await getTextTask(task.id))!;
        expect(completed).toMatchObject({ status: "success", billingPending: false, billingMode: "official-usage", result: { content: "协议测试文本返回成功" } });
        expect(await getModelPriceReservation({ userId, ...completed.billingRequests![0] })).toMatchObject({ status: "settled", settledUsage: { input: "5", cache: "2", write5m: "1", write1h: "0", output: "8" }, settlement: { chargedPoints: "0.10" } });
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toHaveLength(1);
        const fixed = await publicCreateText(request("k3-run:child:2"));
        expect(fixed.status).toBe(200);
        const fixedTask = (await getTextTask((await fixed.json()).task.id))!;
        expect(fixedTask.billingMode).toBeUndefined();
        expect(await runTextTaskStep(fixedTask, "http://internal", "")).toEqual({ state: "completed" });
        expect((await getTextTask(fixedTask.id))?.billing?.pointsCost).toBe(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("1998.9");
    });

    it("settles one long-context tier through a public child task after deactivation", async () => {
        const version = (await getOfficialVersionsByIds([versionId]))[0];
        const policy = (await getCurrentSalesVersion())!;
        const rates = { input: ["0.01", "0.02"], cache: ["0.001", "0.002"], write: ["0.01", "0.02"], output: ["0.02", "0.03"] } as const;
        const meters = { input: "inputTokens", cache: "cachedInputTokens", write: "cacheWriteTokens", output: "outputTokens" } as const;
        version.items = (["short", "long"] as const).flatMap((tier, index) => Object.entries(rates).map(([meter, prices]) => ({ key: `${tier}-${meter}`, unit: "token", per: "1", price: prices[index], currency: "CNY" })));
        await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        const current = (await listFlatTextPriceContracts(versionId, "channel", "mock-text")).find((item) => item.current)!;
        await saveFlatTextPriceContract(
            {
                officialVersionId: versionId,
                channelId: "channel",
                requestedModel: "mock-text",
                reportedModel: "mock-text",
                protocol: "openai-chat",
                scope: "global-standard-text-tiered",
                region: "global",
                serviceTier: "default",
                itemMeters: Object.fromEntries(version.items.map((item) => [item.key, [meters[item.key.split("-")[1] as keyof typeof meters]]])),
                contextTiers: {
                    thresholdInputTokens: 7,
                    shortItemKeys: version.items.slice(0, 4).map((item) => item.key),
                    longItemKeys: version.items.slice(4).map((item) => item.key),
                    sourceUrl: "https://example.com/context-tiers",
                    evidence: "Synthetic full-request tier threshold",
                },
                evidence: "Local long-context response and complete meter fixture",
                reviewedBy: "admin",
                reviewedAt: new Date().toISOString(),
                requestLimits: { maxInputTokens: 16, maxOutputTokens: 16, maxCandidates: 1, sourceUrl: "https://example.com/limits", evidence: "Fixture inclusive hard cap", includesReasoning: true },
                reservationEstimate,
            },
            current.id,
        );
        const activated = await setModelPricingActivation({
            modelId: "priced-text",
            enabled: true,
            expectedRevision: null,
            actorId: "fixture-admin",
            evidence: {
                fixtures: "Local tiered text wallet fixture",
                realChannels: { "channel/mock-text": "Local channel fixture only" },
                entrypoints: "Public Agent text child fixture",
                recovery: "Original request replay fixture",
            },
        });
        const request = () =>
            new Request("http://internal/api/text-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    config: { model: "priced-text" },
                    messages: [{ role: "user", content: "public tiered text request" }],
                    context: { runId: "tiered-run", parentTaskId: "tiered-child", attemptNo: 1, clientRequestId: "tiered-run:child:1" },
                }),
            });
        const created = await publicCreateText(request());
        expect(created.status).toBe(200);
        const task = (await created.json()).task;
        expect((await (await publicCreateText(request())).json()).task.id).toBe(task.id);
        await setModelPricingActivation({ modelId: "priced-text", enabled: false, expectedRevision: activated.activation!.revision, actorId: "fixture-admin" });
        expect(await runTextTaskStep((await getTextTask(task.id))!, "http://internal", "")).toEqual({ state: "completed" });
        const completed = (await getTextTask(task.id))!;
        expect(completed).toMatchObject({ status: "success", billingPending: false });
        expect(await getModelPriceReservation({ userId, ...completed.billingRequests![0] })).toMatchObject({
            status: "settled",
            settledUsage: {
                "short-input": "0",
                "short-cache": "0",
                "short-write": "0",
                "short-output": "0",
                "long-input": "5",
                "long-cache": "2",
                "long-write": "1",
                "long-output": "8",
            },
            settlement: { chargedPoints: "36.40" },
        });
        expect(fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toHaveLength(1);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("63.6");
    });
});
