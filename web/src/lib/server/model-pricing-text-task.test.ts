import { getShadowTextCall } from "./model-pricing-shadow-store";
import { consumeUserPoints } from "@/lib/auth/store";
import { getCurrentSalesVersion, getOfficialVersionsByIds } from "./model-pricing-store";
import { createHash, randomUUID } from "node:crypto";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import * as internalOrigin from "./internal-origin";
import * as taskStore from "./text-task-store";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { writeJsonDataFile } from "./data-adapter";
import { listFlatTextPriceContracts, saveFlatTextPriceContract } from "./model-pricing-token-contract-store";
import type { TokenUsageProtocol } from "./model-pricing-token-usage";
import type { FlatTextPriceContract } from "./model-pricing-token-contract";
import { bindTextTaskBillingRequest, createTextTask, getTextTask, savePricedTextTaskResponse, transitionTextTask, type TextTask } from "./text-task-store";
import { executePricedTextTask, recoverPricedTextTask, refundPricedTextTask } from "./model-pricing-text-task";
import * as wallet from "./model-pricing-wallet-service";
import * as walletTransactions from "./points-wallet-service";
import { SYSTEM_AI_PRICING_STATE_HEADER, readVerifiedSystemAiBillingRequest, systemAiPointsIdempotencyKey, systemAiRequestFingerprint } from "./system-ai-billing";
import { cleanupExpiredStoredGenerationTasks, getStoredGenerationTaskRecord, getStoredGenerationTaskByRequest, listStoredGenerationTaskRecords, queryStoredGenerationTasks, withGenerationTaskFileMutation } from "./generation-task-store";
import { claimDueGenerationTasks, releaseGenerationTaskLease, scheduleGenerationTask } from "./generation-task-scheduler";
import { recoverPricedTextTaskStep, runTextTaskStep } from "./text-task-runtime";
import { getPricingTaskReview, reviewPricingTask } from "./model-pricing-task-review-service";
import { getPricingWalletView } from "./model-pricing-wallet-view";
import { deleteCreativeConversationAggregates } from "./creative-entity-deletion-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
const responsePayload = {
    model: "text-v1",
    status: "completed",
    service_tier: "default",
    output: [
        { type: "reasoning", summary: [{ text: "private reasoning" }] },
        { type: "message", content: [{ type: "output_text", text: "public reply" }] },
    ],
    usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 } },
};

const streamEvent = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function streamSample(protocol: TokenUsageProtocol, format: "sse" | "ndjson" = "sse") {
    const text = "公开 reply";
    const usage = { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 } };
    const samples = {
        "openai-chat": {
            path: ["v1", "chat", "completions"],
            payload: { model: "text", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hello" }] },
            events: [
                { model: "text-v1", service_tier: "default", choices: [{ index: 0, delta: { content: text, reasoning_content: "private reasoning" } }] },
                { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
                { choices: [], usage: { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 } } },
            ],
        },
        "openai-responses": {
            path: ["v1", "responses"],
            payload: { model: "text", stream: true, input: "hello", max_output_tokens: 4 },
            events: [
                { type: "response.created", response: { model: "text-v1", service_tier: "default" } },
                { type: "response.output_text.delta", delta: text },
                {
                    type: "response.completed",
                    response: {
                        ...responsePayload,
                        output: [
                            { type: "reasoning", summary: [{ text: "private reasoning" }] },
                            { type: "message", content: [{ type: "output_text", text }] },
                        ],
                        usage,
                    },
                },
            ],
        },
        "anthropic-messages": {
            path: ["v1", "messages"],
            payload: { model: "text", stream: true, max_tokens: 4, messages: [{ role: "user", content: "hello" }] },
            events: [
                { type: "message_start", message: { model: "text-v1", content: [], usage: { service_tier: "default", input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 6, cache_creation_input_tokens: 0 } } },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "公开 " } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reply" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                { type: "message_stop" },
            ],
        },
        "gemini-generate": {
            path: ["v1beta", "models", "text:streamGenerateContent"],
            payload: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
            events: [
                { modelVersion: "text-v1", candidates: [{ index: 0, content: { parts: [{ thought: true, text: "private reasoning" }, { text }] } }] },
                { candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { serviceTier: "default", promptTokenCount: 8, cachedContentTokenCount: 6, candidatesTokenCount: 1, thoughtsTokenCount: 0 } },
            ],
        },
    };
    const sample = samples[protocol];
    const raw = format === "ndjson" ? sample.events.map((event) => JSON.stringify(event)).join("\n") + "\n" : sample.events.map(streamEvent).join("") + (protocol === "openai-chat" ? "data: [DONE]\n\n" : "");
    return { ...sample, raw, text, mediaType: format === "ndjson" ? "application/x-ndjson" : "text/event-stream" };
}

describe.each(providers)("priced text execution and recovery (%s)", (provider) => {
    let directory: string;
    let task: TextTask;
    let userId: string;
    let versionId: string;
    let policyId: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-priced-text-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        userId = randomUUID();
        const publishedAt = new Date().toISOString();
        versionId = randomUUID();
        policyId = randomUUID();
        const version: OfficialPriceVersion = {
            id: versionId,
            candidateId: "fixture",
            logicalModelId: "priced-text",
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
            items: [
                { key: "input", unit: "token", per: "1", price: "0.01", currency: "CNY" },
                { key: "cache", unit: "token", per: "1", price: "0.001", currency: "CNY" },
                { key: "output", unit: "token", per: "1", price: "0.02", currency: "CNY" },
            ],
        };
        const policy: SalesVersion = {
            id: policyId,
            publishedAt,
            publishedBy: "admin",
            priceVersionIds: { "priced-text": versionId },
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: publishedAt, evidence: "fixture" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: { USD: "700", CNY: "100" },
            rateEvidence: { USD: "fixture" },
        };
        const contract: FlatTextPriceContract = {
            officialVersionId: versionId,
            channelId: "channel",
            protocol: "openai-responses",
            requestedModel: "text",
            reportedModel: "text-v1",
            scope: "global-standard-text-flat",
            region: "global",
            serviceTier: "default",
            itemMeters: { input: ["inputTokens", "cacheWriteTokens"], cache: ["cachedInputTokens"], output: ["outputTokens"] },
            reviewedAt: publishedAt,
            reviewedBy: "admin",
            evidence: "fixture meters checked",
            requestLimits: { maxInputTokens: 8, maxOutputTokens: 4, maxCandidates: 1, sourceUrl: "https://example.com/limits", evidence: "fixture includes cache and reasoning", includesReasoning: true },
            reservationEstimate: { method: "request-size-recent-output", sourceUrl: "https://example.com/text-estimate", evidence: "fixture request sizes, recent output and settlement difference reviewed" },
        };
        const user = {
            id: userId,
            username: `fixture_${userId}`,
            displayName: "本地计费夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 30,
            passwordHash: "fixture-only",
            createdAt: publishedAt,
            updatedAt: publishedAt,
        };
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            await postgresQuery("UPDATE app_settings SET free_daily_points_enabled = false, entitlements_enabled = false WHERE id = 'default'");
            await repos.users.createWithNextAccountId({ ...user, planId: settings.settings!.defaultPlanId });
            await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [version.id, version.logicalModelId, version.publishedAt, JSON.stringify(version)]);
            await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [policy.id, policy.publishedAt, JSON.stringify(policy)]);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = $1 WHERE id = 'default'", [policy.id]);
        } else {
            const db = emptyDb();
            db.settings = structuredClone(db.settings);
            db.settings.freeDailyPointsEnabled = false;
            db.settings.entitlements.enabled = false;
            db.users.push({ ...user, accountId: "0001", planId: db.settings.entitlements.defaultPlanId });
            await writeAuthDb(db);
            await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [policy] });
        }
        await saveFlatTextPriceContract(contract, null);
        const created = await createTextTask({
            ...{ clientRequestId: `request-${userId}`, conversationId: `conversation-${userId}` },
            userId,
            billingMode: "official-usage",
            config: { baseUrl: "/api/ai/system/channel", apiKey: "", model: "text", logicalModel: "priced-text", channelId: "channel", apiFormat: "openai" },
            messages: [],
            attemptNo: 1,
            attempts: [{ attemptNo: 1, channelId: "channel", model: "priced-text", capability: "text", status: "running", startedAt: Date.now() }],
        });
        await transitionTextTask(created, ["pending"], { status: "running" });
        task = await bindTextTaskBillingRequest({
            taskId: created.id,
            userId,
            attemptNo: 1,
            requestId: `system-ai:${"a".repeat(64)}`,
            requestFingerprint: "b".repeat(64),
            businessRequestId: `task:${created.id}:1`,
            channelId: "channel",
            logicalModel: "priced-text",
            upstreamModel: "text",
        });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") {
            await createPostgresRepositories().users.delete(userId);
            await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
            await postgresQuery("DELETE FROM model_sales_price_versions WHERE id = $1", [policyId]);
            await postgresQuery("DELETE FROM model_flat_text_price_contracts WHERE official_version_id = $1", [versionId]);
            await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [versionId]);
        }
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    function input(send = vi.fn(async () => Response.json(responsePayload))) {
        const reference = task.billingRequests![0];
        return {
            task,
            userId,
            requestId: reference.requestId,
            requestFingerprint: reference.requestFingerprint,
            modelId: "priced-text",
            channelId: "channel",
            requestedModel: "text",
            path: ["v1", "responses"],
            payload: { model: "text", input: "private prompt", max_output_tokens: 4 },
            signal: new AbortController().signal,
            send,
        };
    }
    const savedTask = async () => (await getTextTask(task.id))!;
    async function unknownSubmission() {
        const request = input(
            vi.fn(async () => {
                throw new Error("fixture ambiguous upstream");
            }),
        );
        await executePricedTextTask(request);
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        return request;
    }
    const noCharge = { action: "confirm_no_charge", attemptNo: 1, evidence: "Supplier ticket fixture-123 confirms request was never billed" };
    const metered = { action: "provide_metered_result", attemptNo: 1, evidence: "Supplier trace fixture-456 confirms complete usage", response: JSON.stringify(responsePayload) };

    async function zeroOfficialRate() {
        const version = (await getOfficialVersionsByIds([versionId]))[0];
        const zero = { ...version, items: version.items.map((item) => ({ ...item, price: "0" })) };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [versionId, JSON.stringify(zero)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [zero], salesVersions: [await getCurrentSalesVersion()] });
    }

    it.skipIf(provider !== "file")("submits and settles a shared ownerless text price with its frozen selection", async () => {
        const original = (await getOfficialVersionsByIds([versionId]))[0];
        const version = { ...original, logicalModelId: "", capability: "text" as const, manufacturer: "OpenAI", items: original.items.map((item) => ({ ...item, currency: "USD", price: String(Number(item.price) / 1000) })) };
        const selection = { logicalModelId: "priced-text", scope: "text:generation:standard", bindingId: "binding", bindingRevision: "revision", officialVersionId: version.id };
        const policy = { ...(await getCurrentSalesVersion())!, priceVersionIds: {}, selectedPriceBindings: [selection], userPriceRules: [{ scope: "model" as const, modelId: "priced-text", coefficient: "2" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "channel", name: "Fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "openai", models: ["text"], enabled: true }];
        db.settings.logicalModels = [{ id: "priced-text", name: "Shared text", manufacturer: "OpenAI", capability: "text", enabled: true, bindings: [{ id: "channel:text", channelId: "channel", upstreamModel: "text", enabled: true, priority: 0 }] }];
        await writeAuthDb(db);
        await writeJsonDataFile("model-pricing.json", {
            candidates: [],
            officialVersions: [version],
            salesVersions: [policy],
            priceBindings: [
                {
                    id: selection.bindingId,
                    logicalModelId: selection.logicalModelId,
                    capability: "text",
                    operation: "generation",
                    processingMode: "standard",
                    scope: selection.scope,
                    officialVersionId: version.id,
                    status: "active",
                    revision: selection.bindingRevision,
                    current: true,
                    evidence: "fixture",
                    reviewedAt: version.publishedAt,
                    reviewedBy: "admin",
                },
            ],
        });
        const previousContract = (await listFlatTextPriceContracts(version.id, "channel", "text"))[0];
        await saveFlatTextPriceContract(
            {
                ...previousContract,
                identity: { channelBindingId: "channel:text", officialSku: version.sku, operation: "generation", modelIdentity: "response-required", sourceUrl: "https://example.com/identity", evidence: "本地渠道请求 text 与官网 text-v1 已核对" },
            },
            previousContract.id,
        );
        const request = input();
        const response = await executePricedTextTask(request);
        expect(response.ok).toBe(true);
        expect(request.send).toHaveBeenCalledOnce();
        const reservation = await wallet.getModelPriceReservation(request);
        expect(reservation).toMatchObject({
            status: "settled",
            modelId: "priced-text",
            frozen: { priceSelection: selection, text: { call: { modelId: "priced-text", priceSelection: selection } } },
            settledQuote: { modelId: "priced-text", exactPoints: "161/2500" },
        });
        expect((await getShadowTextCall(userId, request.requestId))?.frozen?.priceSelection).toEqual(selection);
    });

    it.skipIf(provider !== "file")("submits one scheduled Standard text attempt and settles its response-selected group", async () => {
        const original = (await getOfficialVersionsByIds([versionId]))[0];
        const line = (lineId: string, meter: string, price: string) => ({ lineId, meter, unit: "token" as const, per: "1000", price, currency: "USD" as const, evidence: "fixture official row" });
        const version = {
            ...original,
            logicalModelId: "",
            capability: "text" as const,
            manufacturer: "OpenAI",
            sku: "text",
            items: [],
            textPriceSchedule: {
                declaredRange: { minInclusive: 0, maxInclusive: 8 },
                meters: [
                    { meter: "input", unit: "token" as const },
                    { meter: "cache", unit: "token" as const },
                    { meter: "output", unit: "token" as const },
                ],
                groups: [
                    {
                        id: "short",
                        scopeKind: "generation" as const,
                        selector: { processingMode: "standard" as const, inputTotalTokens: { minInclusive: 0, maxInclusive: 4 } },
                        lines: [line("short-input", "input", "0.01"), line("short-cache", "cache", "0.001"), line("short-output", "output", "0.02")],
                    },
                    {
                        id: "long",
                        scopeKind: "generation" as const,
                        selector: { processingMode: "standard" as const, inputTotalTokens: { minInclusive: 5, maxInclusive: 8 } },
                        lines: [line("long-input", "input", "0.02"), line("long-cache", "cache", "0.001"), line("long-output", "output", "0.02")],
                    },
                ],
            },
        };
        const selection = { logicalModelId: "priced-text", scope: "text:generation:standard", bindingId: "binding", bindingRevision: "revision", officialVersionId: version.id };
        const policy = { ...(await getCurrentSalesVersion())!, priceVersionIds: {}, selectedPriceBindings: [selection], userPriceRules: [{ scope: "model" as const, modelId: "priced-text", coefficient: "2" }] };
        const db = await readAuthDb();
        db.settings.systemChannels = [{ id: "channel", name: "Fixture", baseUrl: "https://example.com", apiKey: "", apiFormat: "openai", models: ["text"], enabled: true }];
        db.settings.logicalModels = [{ id: "priced-text", name: "Scheduled text", manufacturer: "OpenAI", capability: "text", enabled: true, bindings: [{ id: "channel:text", channelId: "channel", upstreamModel: "text", enabled: true, priority: 0 }] }];
        await writeAuthDb(db);
        await writeJsonDataFile("model-pricing.json", {
            candidates: [],
            officialVersions: [version],
            salesVersions: [policy],
            priceBindings: [
                {
                    id: selection.bindingId,
                    logicalModelId: selection.logicalModelId,
                    capability: "text",
                    operation: "generation",
                    processingMode: "standard",
                    scope: selection.scope,
                    officialVersionId: version.id,
                    status: "active",
                    revision: selection.bindingRevision,
                    current: true,
                    evidence: "fixture",
                    reviewedAt: version.publishedAt,
                    reviewedBy: "admin",
                },
            ],
        });
        const current = (await listFlatTextPriceContracts(version.id, "channel", "text"))[0];
        await saveFlatTextPriceContract({ ...current, scope: "global-standard-text-tiered", contextTiers: undefined }, current.id);
        const request = input();
        const response = await executePricedTextTask(request);
        expect(response.ok).toBe(true);
        expect(request.send).toHaveBeenCalledOnce();
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({
            status: "settled",
            frozen: { version: { textPriceSchedule: version.textPriceSchedule }, priceSelection: selection },
            settledQuote: { selectedGroupId: "long", exactPoints: "231/2500" },
        });
    });

    it("keeps the normal fixed text charge when the published official evidence becomes free", async () => {
        const before = await consumeUserPoints(userId, "priced-text", 1, "text");
        expect(before.cost).toBeGreaterThan(0);
        await zeroOfficialRate();
        const after = await consumeUserPoints(userId, "priced-text", 1, "text");
        expect(after.cost).toBe(before.cost);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe(String(30 - 2 * before.cost));
    });

    it("rejects restored zero-price text evidence before reserving or submitting", async () => {
        await zeroOfficialRate();
        const send = vi.fn(async () => Response.json(responsePayload));
        const request = input(send);
        const result = await executePricedTextTask(request);
        expect(result.headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("not-submitted");
        expect((await getShadowTextCall(userId, request.requestId))?.reasons).toContainEqual(expect.stringContaining("固定积分"));
        expect(send).not.toHaveBeenCalled();
        expect(await wallet.getModelPriceReservation(request)).toBeUndefined();
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "30", pendingCount: 0 });
    });

    it("settles a submitted text request against its positive frozen rate after current evidence becomes free", async () => {
        const request = input(
            vi.fn(async () => {
                await zeroOfficialRate();
                return Response.json(responsePayload);
            }),
        );
        const result = await executePricedTextTask(request);
        expect(result.ok).toBe(true);
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "settled" });
        expect((await wallet.getModelPriceReservation(request))?.frozen.version.items.every((item) => Number(item.price) > 0)).toBe(true);
    });

    it("records immutable no-charge provenance and releases the original hold exactly once", async () => {
        const request = await unknownSubmission();
        const before = await getPricingTaskReview(task.id);
        expect(before).toMatchObject({ pending: true, hasSavedResponse: false, attemptNo: 1 });
        expect(JSON.stringify(before)).not.toMatch(/requestFingerprint|apiKey|private prompt/);
        await expect(reviewPricingTask(task.id, noCharge, "reviewer")).resolves.toMatchObject({ executionPhase: "completed" });
        const first = await wallet.getModelPriceReservation(request);
        expect(first).toMatchObject({ status: "released", submission: { review: { reviewedBy: "reviewer", evidence: noCharge.evidence, outcome: { kind: "not_charged" } } } });
        expect(await savedTask()).toMatchObject({ status: "error", billingPending: false });
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "30", pendingCount: 0 });
        await reviewPricingTask(task.id, noCharge, "reviewer");
        expect(await wallet.getModelPriceReservation(request)).toEqual(first);
        await expect(reviewPricingTask(task.id, { ...noCharge, evidence: "different proof" }, "reviewer")).rejects.toThrow(/不能改写/);
        await expect(reviewPricingTask(task.id, metered, "reviewer")).rejects.toThrow(/不能改写/);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("settles an imported complete response with original pricing and retains only public content", async () => {
        const request = await unknownSubmission();
        const result = await reviewPricingTask(task.id, metered, "reviewer");
        expect(result).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await savedTask()).toMatchObject({ status: "success", billingPending: false, result: { content: "public reply" } });
        const reservation = await wallet.getModelPriceReservation(request);
        expect(reservation).toMatchObject({ status: "settled", settlement: { chargedPoints: "4.60" }, submission: { review: { outcome: { kind: "response" } } } });
        expect(JSON.stringify(reservation)).not.toMatch(/public reply|private reasoning/);
        expect(JSON.stringify(await savedTask())).not.toContain("private reasoning");
        await reviewPricingTask(task.id, metered, "reviewer");
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("25.4");
        expect((await getPricingWalletView(userId)).items).toHaveLength(1);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("supplements missing meters without rewriting the original response", async () => {
        const incomplete = { ...responsePayload, usage: { input_tokens: 8, output_tokens: 1 } };
        const request = input(vi.fn(async () => Response.json(incomplete)));
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("billing-pending");
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        const original = (await wallet.getModelPriceReservation(request))!.submission!.response;
        await expect(reviewPricingTask(task.id, noCharge, "reviewer")).rejects.toThrow(/已有响应/);
        const conflict = { ...responsePayload, usage: { ...responsePayload.usage, input_tokens: 7 } };
        await expect(reviewPricingTask(task.id, { ...metered, response: JSON.stringify(conflict) }, "reviewer")).rejects.toThrow(/冲突/);
        expect((await savedTask()).billingRequests![0].review).toBeUndefined();
        await reviewPricingTask(task.id, metered, "reviewer");
        const saved = await wallet.getModelPriceReservation(request);
        expect(saved!.submission!.response).toEqual(original);
        expect(saved!.settlement!.chargedPoints).toBe("4.60");
        expect(request.send).toHaveBeenCalledOnce();
    });

    async function contradictorySubmission() {
        const payload = { ...responsePayload, usage: { ...responsePayload.usage, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 0 } } };
        const request = input(vi.fn(async () => Response.json(payload)));
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("billing-pending");
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        return request;
    }
    const correction = { ...metered, action: "correct_metered_result", evidence: "Supplier ticket fixture-correction verifies original request cache count 6, not 9" };

    it("corrects contradictory usage with separate provenance and settles the original hold once", async () => {
        const request = await contradictorySubmission();
        const original = (await wallet.getModelPriceReservation(request))!.submission!.response;
        const publicResponse = (await savedTask()).pricedResponses;
        expect(await getPricingTaskReview(task.id)).toMatchObject({ canCorrectUsage: true, invalidUsage: expect.any(String) });
        await expect(reviewPricingTask(task.id, metered, "reviewer")).rejects.toThrow(/冲突/);
        await expect(reviewPricingTask(task.id, noCharge, "reviewer")).rejects.toThrow(/已有响应/);
        expect(await reviewPricingTask(task.id, correction, "reviewer")).toMatchObject({ executionPhase: "completed" });
        const saved = (await wallet.getModelPriceReservation(request))!;
        expect(saved.submission!.response).toEqual(original);
        expect(saved.submission!.review).toMatchObject({ evidence: correction.evidence, outcome: { kind: "response", correctedObservation: original!.observation, observation: { quantities: { cachedInputTokens: "6" } } } });
        expect(saved.settlement!.chargedPoints).toBe("4.60");
        expect((await savedTask()).pricedResponses).toEqual(publicResponse);
        expect(await getPricingTaskReview(task.id)).toMatchObject({ pending: false, canCorrectUsage: false, reviewed: true });
        await reviewPricingTask(task.id, correction, "reviewer");
        expect(await wallet.getModelPriceReservation(request)).toEqual(saved);
        expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "25.4", pendingCount: 0 });
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("requires an invalid original and rejects correction of identity, public result or request bounds", async () => {
        const request = await contradictorySubmission();
        await expect(reviewPricingTask(task.id, { ...correction, evidence: " " }, "reviewer")).rejects.toThrow(/依据/);
        for (const payload of [
            { ...responsePayload, model: "another-model" },
            { ...responsePayload, service_tier: "priority" },
            { ...responsePayload, usage: { ...responsePayload.usage, inference_geo: "us" } },
            { ...responsePayload, usage: { ...responsePayload.usage, output_tokens: 50 } },
            { ...responsePayload, output: [{ type: "message", content: [{ type: "output_text", text: "different public result" }] }] },
        ])
            await expect(reviewPricingTask(task.id, { ...correction, response: JSON.stringify(payload) }, "reviewer")).rejects.toThrow();
        expect((await savedTask()).billingRequests![0].review).toBeUndefined();
        expect((await wallet.getModelPriceReservation(request))!.status).toBe("reserved");
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("does not turn an unknown response into a correction of invented prior meters", async () => {
        const request = await unknownSubmission();
        await expect(reviewPricingTask(task.id, correction, "reviewer")).rejects.toThrow(/没有已保存/);
        expect((await wallet.getModelPriceReservation(request))!.submission!.review).toBeUndefined();
    });

    it("resumes a saved correction after wallet persistence fails without rewriting its original", async () => {
        const request = await contradictorySubmission();
        const original = (await wallet.getModelPriceReservation(request))!.submission!.response;
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture correction commit unavailable"));
        expect(await reviewPricingTask(task.id, correction, "reviewer")).toMatchObject({ executionPhase: "needs_review" });
        expect((await wallet.getModelPriceReservation(request))!.status).toBe("reserved");
        expect(await reviewPricingTask(task.id, { action: "resume_billing", attemptNo: 1 }, "other-reviewer")).toMatchObject({ executionPhase: "completed" });
        const saved = (await wallet.getModelPriceReservation(request))!;
        expect(saved.submission!.response).toEqual(original);
        expect(saved.submission!.review!.reviewedBy).toBe("reviewer");
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("serializes competing corrections before settling a single original request", async () => {
        const request = await contradictorySubmission();
        const alternative = { ...correction, response: JSON.stringify({ ...responsePayload, usage: { ...responsePayload.usage, output_tokens: 2 } }) };
        const results = await Promise.allSettled([reviewPricingTask(task.id, correction, "reviewer"), reviewPricingTask(task.id, alternative, "reviewer")]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        expect((await getPricingWalletView(userId)).items).toHaveLength(1);
        expect((await wallet.getModelPriceReservation(request))!.status).toBe("settled");
        expect(request.send).toHaveBeenCalledOnce();
    });

    it.each(["confirm_no_charge", "provide_metered_result"])("recovers %s after the decision is saved but wallet persistence fails", async (action) => {
        const request = await unknownSubmission();
        vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture persistence unavailable"));
        await expect(reviewPricingTask(task.id, action === "confirm_no_charge" ? noCharge : metered, "reviewer")).resolves.toMatchObject({ executionPhase: "needs_review" });
        expect((await savedTask()).billingRequests![0].review?.decision.reviewedBy).toBe("reviewer");
        expect((await savedTask()).billingPending).toBe(true);
        expect((await wallet.getModelPriceReservation(request))!.status).toBe("reserved");
        await expect(reviewPricingTask(task.id, { action: "resume_billing", attemptNo: 1 }, "another-reviewer")).resolves.toMatchObject({ executionPhase: "completed" });
        expect((await savedTask()).billingPending).toBe(false);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("serializes competing decisions and rejects a late original response", async () => {
        const request = await unknownSubmission();
        const results = await Promise.allSettled([reviewPricingTask(task.id, noCharge, "reviewer"), reviewPricingTask(task.id, metered, "reviewer")]);
        expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
        const saved = await savedTask();
        expect(saved.billingPending).toBe(false);
        await expect(savePricedTextTaskResponse({ taskId: task.id, ...request, content: "late reply", observation: { protocol: "openai-responses", quantities: {}, missing: [] } })).rejects.toThrow(/人工核对/);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("keeps reviewed accounting terminal when an older recovery releases its lease late", async () => {
        await unknownSubmission();
        await reviewPricingTask(task.id, noCharge, "reviewer");
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        expect((await getStoredGenerationTaskRecord("text", task.id))!.executionPhase).toBe("completed");
        if (provider === "postgres") await postgresQuery("UPDATE generation_tasks SET worker_id = 'stale-worker' WHERE id = $1", [task.id]);
        else await withGenerationTaskFileMutation(async (tasks) => ({ tasks: tasks.map((item) => (item.id === task.id ? { ...item, workerId: "stale-worker" } : item)), result: undefined }));
        const released = await releaseGenerationTaskLease("text", task.id, "stale-worker", { executionPhase: "needs_review", nextPollAt: undefined });
        expect(released).toMatchObject({ executionPhase: "completed", workerId: undefined });
        expect((await savedTask()).billingPending).toBe(false);
    });

    it("requires evidence, the current attempt and a complete matching bounded response", async () => {
        const request = await unknownSubmission();
        await expect(reviewPricingTask(task.id, { ...noCharge, evidence: " " }, "reviewer")).rejects.toThrow(/依据/);
        await expect(reviewPricingTask(task.id, { ...noCharge, attemptNo: 2 }, "reviewer")).rejects.toThrow(/尝试已变化/);
        for (const response of ["{", JSON.stringify({ ...responsePayload, status: "incomplete" }), JSON.stringify({ ...responsePayload, usage: { ...responsePayload.usage, output_tokens: 50 } })]) {
            await expect(reviewPricingTask(task.id, { ...metered, response }, "reviewer")).rejects.toThrow();
        }
        expect((await savedTask()).billingRequests![0].review).toBeUndefined();
        expect((await wallet.getModelPriceReservation(request))!.status).toBe("reserved");
    });

    it("reconciles a cancelled unknown request and keeps ordinary failures from releasing it", async () => {
        const request = await unknownSubmission();
        const cancelled = await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
        expect(await refundPricedTextTask(cancelled!)).toBe(false);
        expect((await wallet.getModelPriceReservation(request))!.status).toBe("reserved");
        await reviewPricingTask(task.id, noCharge, "reviewer");
        expect(await savedTask()).toMatchObject({ status: "cancelled", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("30");
    });

    const stopPreparation = { action: "stop_preparation", attemptNo: 1, evidence: "Fixture incident: stop the interrupted preflight" };
    async function preparedWithoutSubmission() {
        vi.spyOn(wallet, "claimModelPriceSubmission").mockRejectedValueOnce(new Error("fixture stopped before claim"));
        const request = input();
        await expect(executePricedTextTask(request)).rejects.toThrow("before claim");
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        return request;
    }

    it("fences a bound request before preparation starts and preserves the original stop decision", async () => {
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        await expect(reviewPricingTask(task.id, { ...stopPreparation, evidence: " " }, "reviewer")).rejects.toThrow(/依据/);
        const completed = await reviewPricingTask(task.id, stopPreparation, "reviewer");
        expect(completed).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await reviewPricingTask(task.id, stopPreparation, "reviewer")).toEqual(completed);
        await expect(reviewPricingTask(task.id, { ...stopPreparation, evidence: "different" }, "reviewer")).rejects.toThrow(/不能改写/);
        const request = input();
        expect((await executePricedTextTask(request)).status).toBe(409);
        expect(request.send).not.toHaveBeenCalled();
        expect(await wallet.getModelPriceReservation(request)).toBeUndefined();
        expect(await savedTask()).toMatchObject({ status: "error", billingPending: false });
    });

    it.each(["before-reserve", "after-reserve"])("fences a delayed preparation %s without letting it submit later", async (stage) => {
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const continued = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const reserve = wallet.reserveModelPricePoints;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementation(async (value) => {
            if (stage === "before-reserve") {
                enter();
                await continued;
                return reserve(value);
            }
            const result = await reserve(value);
            enter();
            await continued;
            return result;
        });
        const request = input();
        const execution = executePricedTextTask(request);
        await entered;
        try {
            await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
            expect(await getPricingTaskReview(task.id)).toMatchObject({ canStopPreparation: true });
            expect(await reviewPricingTask(task.id, stopPreparation, "reviewer")).toMatchObject({ executionPhase: "completed" });
        } finally {
            resume();
        }
        expect((await execution).status).toBe(409);
        expect(request.send).not.toHaveBeenCalled();
        expect(await savedTask()).toMatchObject({ status: "error", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("30");
        const reservation = await wallet.getModelPriceReservation(request);
        expect(reservation?.submission).toBeUndefined();
        if (stage === "after-reserve") expect(reservation).toMatchObject({ status: "released" });
        else expect(reservation).toBeUndefined();
    });

    it("recovers a stop persisted before the wallet release fails, retaining provenance and the hold until retry", async () => {
        const request = await preparedWithoutSubmission();
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
        await expect(reviewPricingTask(task.id, stopPreparation, "reviewer")).rejects.toThrow("persistence failed");
        const stopped = await savedTask();
        expect(stopped.billingPending).toBe(true);
        expect(stopped.billingRequests![0].preparationStop?.reviewedBy).toBe("reviewer");
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved" });
        expect((await wallet.getModelPriceReservation(request))!.submission).toBeUndefined();
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("14");
        await expect(wallet.claimModelPriceSubmission(request)).rejects.toThrow(/已撤销/);
        persistence.mockRestore();
        expect(await reviewPricingTask(task.id, { action: "resume_billing", attemptNo: 1 }, "another-reviewer")).toMatchObject({ executionPhase: "completed", reviewId: stopped.billingRequests![0].preparationStop!.id });
        expect((await savedTask()).billingPending).toBe(false);
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("30");
        expect(request.send).not.toHaveBeenCalled();
    });

    it("resolves ambiguous preparation persistence without inferring absence from a stale read", async () => {
        vi.spyOn(wallet, "reserveModelPricePoints").mockRejectedValueOnce(new Error("fixture commit acknowledgement missing"));
        const request = input();
        expect((await executePricedTextTask(request)).status).toBe(409);
        await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        await reviewPricingTask(task.id, stopPreparation, "reviewer");
        expect(await savedTask()).toMatchObject({ status: "cancelled", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("30");
        expect(request.send).not.toHaveBeenCalled();
    });

    it("serializes stopping against submission permission and never releases a claimed request", async () => {
        const request = await preparedWithoutSubmission();
        const [claim, stop] = await Promise.allSettled([wallet.claimModelPriceSubmission(request), reviewPricingTask(task.id, stopPreparation, "reviewer")]);
        const saved = await wallet.getModelPriceReservation(request);
        if (claim.status === "fulfilled" && claim.value.claimed) {
            expect(stop.status).toBe("rejected");
            expect(saved).toMatchObject({ status: "reserved", submission: { phase: "submitting" } });
            expect((await savedTask()).billingRequests![0].preparationStop).toBeUndefined();
        } else {
            expect(stop.status).toBe("fulfilled");
            expect(saved).toMatchObject({ status: "released" });
            expect(saved!.submission).toBeUndefined();
        }
        expect(request.send).not.toHaveBeenCalled();
    });

    it("rejects preparation cancellation once upstream submission is claimed", async () => {
        const request = await unknownSubmission();
        expect(await getPricingTaskReview(task.id)).toMatchObject({ canStopPreparation: false });
        await expect(reviewPricingTask(task.id, stopPreparation, "reviewer")).rejects.toThrow(/已认领/);
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved", submission: { phase: "outcome_unknown" } });
        expect((await savedTask()).billingRequests![0].preparationStop).toBeUndefined();
    });

    async function expireTask() {
        const expiredAt = Date.now() - 1;
        if (provider === "postgres") await postgresQuery("UPDATE generation_tasks SET expires_at = $3 WHERE id = $1 AND user_id = $2", [task.id, userId, new Date(expiredAt)]);
        else await withGenerationTaskFileMutation(async (tasks) => ({ tasks: tasks.map((item) => (item.id === task.id ? { ...item, expiresAt: expiredAt } : item)), result: undefined }));
    }

    it("keeps expired unresolved billing visible, idempotent and recoverable without scheduling endless checks", async () => {
        const request = input(
            vi.fn(async () => {
                throw new Error("fixture unknown submission");
            }),
        );
        expect((await executePricedTextTask(request)).status).toBe(409);
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        await expireTask();
        expect(await cleanupExpiredStoredGenerationTasks({ limit: 1 })).toBe(0);
        expect((await savedTask()).billingPending).toBe(true);
        expect((await getStoredGenerationTaskByRequest<TextTask>("text", userId, `request-${userId}`, 1))?.id).toBe(task.id);
        expect((await queryStoredGenerationTasks<TextTask>("text", { userId })).map((item) => item.id)).toContain(task.id);
        expect((await listStoredGenerationTaskRecords({ userId, includeAll: false })).items.map((item) => item.id)).toContain(task.id);
        expect(await claimDueGenerationTasks({ workerId: "fixture-worker", taskIds: [task.id] })).toEqual([]);
        expect((await recoverPricedTextTaskStep(await savedTask()))?.state).toBe("needs_review");
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("recovers an expired saved response, unpins only with the public result, then allows ordinary expiry", async () => {
        const request = input();
        expect((await executePricedTextTask(request)).status).toBe(200);
        expect((await savedTask()).billingPending).toBe(true);
        await scheduleGenerationTask("text", task.id, { executionPhase: "submitting", nextPollAt: Date.now() });
        await expireTask();
        expect(await cleanupExpiredStoredGenerationTasks({ limit: 1 })).toBe(0);
        expect((await claimDueGenerationTasks({ workerId: "fixture-worker", taskIds: [task.id] })).map((item) => item.id)).toEqual([task.id]);
        expect(await recoverPricedTextTaskStep(await savedTask())).toEqual({ state: "completed" });
        expect(await savedTask()).toMatchObject({ status: "success", billingPending: false, result: { content: "public reply" } });
        await expireTask();
        expect(await cleanupExpiredStoredGenerationTasks({ limit: 1 })).toBe(1);
        expect(await getTextTask(task.id)).toBeNull();
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "settled", settlement: { chargedPoints: "4.60" } });
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("does not unpin a cancelled preparation while the original owner can still reserve", async () => {
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const continued = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const reserve = wallet.reserveModelPricePoints;
        vi.spyOn(wallet, "reserveModelPricePoints").mockImplementation(async (value) => {
            enter();
            await continued;
            return reserve(value);
        });
        const request = input();
        const execution = executePricedTextTask(request);
        await entered;
        try {
            const cancelled = await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
            expect(await refundPricedTextTask(cancelled!)).toBe(false);
            await expireTask();
            expect(await cleanupExpiredStoredGenerationTasks({ limit: 1 })).toBe(0);
            expect((await savedTask()).billingPending).toBe(true);
        } finally {
            resume();
        }
        expect((await execution).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("not-submitted");
        expect(await savedTask()).toMatchObject({ status: "cancelled", billingPending: false });
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "released" });
        expect(request.send).not.toHaveBeenCalled();
    });

    it("keeps an interrupted preparation pinned even when no wallet record has been observed yet", async () => {
        vi.spyOn(wallet, "reserveModelPricePoints").mockRejectedValueOnce(new Error("fixture ambiguous persistence failure"));
        const request = input();
        expect((await executePricedTextTask(request)).status).toBe(409);
        expect(await wallet.getModelPriceReservation(request)).toBeUndefined();
        const cancelled = await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
        expect(await refundPricedTextTask(cancelled!)).toBe(false);
        await expireTask();
        expect(await cleanupExpiredStoredGenerationTasks({ limit: 1 })).toBe(0);
        expect((await recoverPricedTextTaskStep(await savedTask()))?.state).toBe("needs_review");
        expect(request.send).not.toHaveBeenCalled();
    });

    it("blocks deletion of a conversation with unresolved billing and permits it after result settlement", async () => {
        const conversationId = `conversation-${userId}`;
        if (provider === "postgres") await postgresQuery("INSERT INTO creative_conversations (id, user_id, surface) VALUES ($1, $2, 'chat')", [conversationId, userId]);
        else await writeJsonDataFile("creative-runtime.json", { version: 1, nextEventId: 1, conversations: [{ id: conversationId, userId, surface: "chat" }], messages: [], assets: [], events: [] });
        await expect(deleteCreativeConversationAggregates(userId, [conversationId])).rejects.toThrow("待结算");
        expect((await savedTask()).billingPending).toBe(true);
        const request = input();
        expect((await executePricedTextTask(request)).status).toBe(200);
        await expect(deleteCreativeConversationAggregates(userId, [conversationId])).rejects.toThrow("待结算");
        expect(await recoverPricedTextTaskStep(await savedTask())).toEqual({ state: "completed" });
        expect(await deleteCreativeConversationAggregates(userId, [conversationId])).toMatchObject({ deletedConversations: 1 });
        expect(await getTextTask(task.id)).toBeNull();
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "settled" });
    });

    it("reserves before network submission, settles real usage once, and recovers only the public answer", async () => {
        const request = input();
        request.send.mockImplementation(async () => {
            expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved", submission: { phase: "submitting" } });
            expect(Number((await wallet.getModelPriceReservation(request))!.allocation.heldPoints)).toBe(16);
            return Response.json(responsePayload);
        });
        const results = await Promise.all([executePricedTextTask(request), executePricedTextTask(request)]);
        expect(results.map((item) => item.status).sort()).toEqual([200, 409]);
        expect(request.send).toHaveBeenCalledOnce();
        const success = results.find((item) => item.status === 200)!;
        expect(Number(success.headers.get("x-vozeb-pro-points-cost"))).toBe(4.6);
        expect(success.headers.get("x-vozeb-pro-points-remaining")).toBe("25.4");
        expect((await savedTask()).pricedResponses).toEqual([expect.objectContaining({ content: "public reply" })]);
        expect(JSON.stringify(await savedTask())).not.toContain("private reasoning");
        const savedResponse = (await savedTask()).pricedResponses![0];
        await savePricedTextTaskResponse({ taskId: task.id, userId, requestId: request.requestId, requestFingerprint: request.requestFingerprint, content: savedResponse.content, observation: savedResponse.observation });
        await expect(savePricedTextTaskResponse({ taskId: task.id, userId, requestId: request.requestId, requestFingerprint: request.requestFingerprint, content: "changed answer", observation: savedResponse.observation })).rejects.toThrow("不能改写");
        expect(await recoverPricedTextTask(await savedTask())).toMatchObject({ state: "completed", content: "public reply", pointsCost: 4.6, pointsRemaining: 25.4 });
        expect((await executePricedTextTask(request)).status).toBe(409);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("recovers a saved answer after receipt persistence fails without a second supplier call", async () => {
        const save = vi.spyOn(wallet, "recordModelPriceSubmissionOutcome").mockRejectedValueOnce(new Error("fixture receipt commit failed"));
        const request = input();
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("billing-pending");
        save.mockRestore();
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved" });
        expect(await recoverPricedTextTask(await savedTask())).toMatchObject({ state: "completed", pointsCost: 4.6 });
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("recovers settlement after the complete response was already persisted", async () => {
        const settle = vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture wallet commit failed"));
        const request = input();
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("billing-pending");
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ submission: { phase: "response_received" } });
        settle.mockRestore();
        expect(await recoverPricedTextTask(await savedTask())).toMatchObject({ state: "completed", pointsCost: 4.6 });
        expect(request.send).toHaveBeenCalledOnce();
    });

    it.each(["transport", "invalid-json", "missing-usage", "http-error"])("keeps the original reservation for %s without another send or automatic refund", async (kind) => {
        const request = input(
            vi.fn(async () => {
                if (kind === "transport") throw new Error("fixture timeout");
                if (kind === "invalid-json") return new Response("broken");
                if (kind === "http-error") return Response.json({ error: "unknown" }, { status: 502 });
                return Response.json({ ...responsePayload, usage: undefined });
            }),
        );
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe(kind === "missing-usage" ? "billing-pending" : "pending");
        expect((await recoverPricedTextTask(await savedTask()))?.state).toBe(kind === "missing-usage" ? "completed" : "needs_review");
        const cancelled = await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
        expect(await refundPricedTextTask(cancelled!)).toBe(false);
        expect((await executePricedTextTask(request)).status).toBe(409);
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved" });
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("refunds a completed cancellation only once", async () => {
        const request = input();
        request.send.mockImplementation(async () => {
            await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
            return Response.json(responsePayload);
        });
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("refunded");
        expect(await refundPricedTextTask(await savedTask())).toBe(true);
        const saved = await wallet.getModelPriceReservation(request);
        expect(saved).toMatchObject({ status: "settled", refundedUsage: saved!.settledUsage, refundedUnits: 1 });
        expect((await wallet.settleModelPricePoints({ ...request, resume: true })).snapshot.totalPoints).toBe(30);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("never submits an aborted request and scopes reservation reads to the owner and fingerprint", async () => {
        const request = input();
        const result = await executePricedTextTask({ ...request, signal: AbortSignal.abort() });
        expect(result.headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("not-submitted");
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "released" });
        expect(request.send).not.toHaveBeenCalled();
        await expect(wallet.getModelPriceReservation({ ...request, requestFingerprint: "c".repeat(64) })).rejects.toThrow("不同请求");
        expect(await wallet.getModelPriceReservation({ ...request, userId: "other-user" })).toBeUndefined();
    });

    it("rejects an unverified adapted protocol before holding funds or sending", async () => {
        const request = input();
        expect((await executePricedTextTask({ ...request, adapted: true })).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("not-submitted");
        expect(await wallet.getModelPriceReservation(request)).toBeUndefined();
        expect(request.send).not.toHaveBeenCalled();
    });

    async function streamContract(protocol: TokenUsageProtocol) {
        const old = (await listFlatTextPriceContracts(versionId, "channel", "text"))[0];
        const itemMeters = {
            ...old.itemMeters,
            input: protocol === "anthropic-messages" ? ["inputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens"] : protocol === "gemini-generate" ? ["inputTokens"] : old.itemMeters.input,
        } as FlatTextPriceContract["itemMeters"];
        await saveFlatTextPriceContract({ ...old, protocol, itemMeters }, old.id);
    }

    async function k3Contract() {
        const original = (await getOfficialVersionsByIds([versionId]))[0];
        const version = {
            ...original,
            manufacturer: "Moonshot",
            series: "Kimi K3",
            officialVersion: "kimi-k3",
            sku: "kimi-k3",
            items: [
                { key: "ordinaryInput", unit: "token", per: "1000000", price: "3", currency: "USD" },
                { key: "cachedInput", unit: "token", per: "1000000", price: "0.30", currency: "USD" },
                { key: "cacheWrite5m", unit: "token", per: "1000000", price: "3", currency: "USD" },
                { key: "cacheWrite1h", unit: "token", per: "1000000", price: "6", currency: "USD" },
                { key: "output", unit: "token", per: "1000000", price: "15", currency: "USD" },
            ],
        };
        if (provider === "postgres") await postgresQuery("UPDATE model_official_price_versions SET data = $2::jsonb WHERE id = $1", [versionId, JSON.stringify(version)]);
        else await writeJsonDataFile("model-pricing.json", { candidates: [], officialVersions: [version], salesVersions: [await getCurrentSalesVersion()] });
        const old = (await listFlatTextPriceContracts(versionId, "channel", "text"))[0];
        await saveFlatTextPriceContract(
            {
                ...old,
                protocol: "openai-chat",
                reportedModel: "kimi-k3",
                itemMeters: {
                    ordinaryInput: ["inputTokens"],
                    cachedInput: ["cachedInputTokens"],
                    cacheWrite5m: ["cacheWrite5mTokens"],
                    cacheWrite1h: ["cacheWrite1hTokens"],
                    output: ["outputTokens"],
                },
                requestLimits: { ...old.requestLimits!, maxInputTokens: 1000, maxOutputTokens: 100 },
            },
            old.id,
        );
    }

    it.each(["json", "sse"] as const)("settles Kimi K3 %s only with verified cache-write TTL headers", async (format) => {
        await k3Contract();
        const usage = { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } };
        const json = { model: "kimi-k3", service_tier: "default", choices: [{ finish_reason: "stop", message: { content: "public reply" } }], usage };
        const raw =
            streamEvent({ model: "kimi-k3", service_tier: "default", choices: [{ index: 0, delta: { content: "public reply" } }] }) +
            streamEvent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            streamEvent({ choices: [], usage }) +
            "data: [DONE]\n\n";
        const server = createServer((_request, response) => {
            response.setHeader("content-type", format === "sse" ? "text/event-stream" : "application/json");
            response.setHeader("Msh-Usage-Cache-Write-Tokens-5m", "60");
            response.setHeader("Msh-Usage-Cache-Write-Tokens-1h", "40");
            response.end(format === "sse" ? raw : JSON.stringify(json));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("fixture did not bind");
            const request = {
                ...input(vi.fn(() => fetch(`http://127.0.0.1:${address.port}`))),
                path: ["v1", "chat", "completions"],
                payload: { model: "text", stream: format === "sse", stream_options: { include_usage: true }, messages: [{ role: "user", content: "hello" }], max_completion_tokens: 100 },
            };
            const result = await executePricedTextTask(request);
            expect(result.headers.get("Msh-Usage-Cache-Write-Tokens-5m")).toBeNull();
            if (format === "sse") expect(await result.text()).toBe(raw);
            else expect(result.ok).toBe(true);
            expect(await wallet.getModelPriceReservation(request)).toMatchObject({
                status: "settled",
                settledUsage: {
                    ordinaryInput: "700",
                    cachedInput: "200",
                    cacheWrite5m: "60",
                    cacheWrite1h: "40",
                    output: "90",
                },
                settlement: { chargedPoints: "2.75" },
            });
            expect(await recoverPricedTextTaskStep(await savedTask())).toEqual({ state: "completed" });
            expect((await savedTask()).result?.content).toBe("public reply");
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("keeps a submitted Kimi K3 response pending when the 1h TTL header is missing", async () => {
        await k3Contract();
        const payload = {
            model: "kimi-k3",
            service_tier: "default",
            choices: [{ finish_reason: "stop", message: { content: "public reply" } }],
            usage: {
                prompt_tokens: 1000,
                completion_tokens: 90,
                prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
            },
        };
        const send = vi.fn(async () => Response.json(payload, { headers: { "Msh-Usage-Cache-Write-Tokens-5m": "60" } }));
        const request = { ...input(send), path: ["v1", "chat", "completions"], payload: { model: "text", messages: [{ role: "user", content: "hello" }], max_completion_tokens: 100 } };
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("billing-pending");
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved", submission: { phase: "response_received" } });
        expect((await savedTask()).pricedResponses).toBeDefined();
        expect((await recoverPricedTextTaskStep(await savedTask()))?.state).toBe("completed");
        expect(await getPricingTaskReview(task.id)).toMatchObject({ usesCacheWriteTtl: true, pending: true, hasSavedResponse: true });
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        const review = { action: "provide_metered_result", attemptNo: 1, evidence: "Supplier trace confirms original TTL response headers", response: JSON.stringify(payload), cacheWrite5mTokens: "60", cacheWrite1hTokens: "40" };
        await expect(reviewPricingTask(task.id, { ...review, cacheWrite1hTokens: undefined }, "reviewer")).rejects.toThrow(/cacheWrite1hTokens/);
        await expect(reviewPricingTask(task.id, { ...review, cacheWrite5mTokens: "61", cacheWrite1hTokens: "39" }, "reviewer")).rejects.toThrow(/冲突/);
        await expect(reviewPricingTask(task.id, { ...review, cacheWrite1hTokens: "41" }, "reviewer")).rejects.toThrow(/不一致/);
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved" });
        expect(await reviewPricingTask(task.id, review, "reviewer")).toMatchObject({ executionPhase: "completed", reviewId: expect.any(String) });
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({
            status: "settled",
            settlement: { chargedPoints: "2.75" },
            settledUsage: {
                ordinaryInput: "700",
                cachedInput: "200",
                cacheWrite5m: "60",
                cacheWrite1h: "40",
                output: "90",
            },
        });
        expect((await savedTask()).pricedResponses?.[0].observation.quantities.cacheWrite1hTokens).toBeUndefined();
        expect((await savedTask()).result?.content).toBe("public reply");
        await reviewPricingTask(task.id, review, "reviewer");
        expect(send).toHaveBeenCalledOnce();
    });

    it("supplements only the missing Kimi K3 stream TTL from the saved original response", async () => {
        await k3Contract();
        const usage = { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } };
        const raw =
            streamEvent({ model: "kimi-k3", service_tier: "default", choices: [{ index: 0, delta: { content: "public reply" } }] }) +
            streamEvent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            streamEvent({ choices: [], usage }) +
            "data: [DONE]\n\n";
        const send = vi.fn(async () => new Response(raw, { headers: { "content-type": "text/event-stream", "Msh-Usage-Cache-Write-Tokens-5m": "60" } }));
        const request = { ...input(send), path: ["v1", "chat", "completions"], payload: { model: "text", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hello" }], max_completion_tokens: 100 } };
        expect(await (await executePricedTextTask(request)).text()).toBe(raw);
        expect((await recoverPricedTextTaskStep(await savedTask()))?.state).toBe("completed");
        await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
        expect(await getPricingTaskReview(task.id)).toMatchObject({ canSupplyCacheWriteTtl: true, knownCacheWrite5mTokens: "60" });
        const review = { action: "provide_metered_result", attemptNo: 1, evidence: "Supplier trace confirms the original TTL headers", response: "", cacheWrite5mTokens: "60", cacheWrite1hTokens: "40" };
        await expect(reviewPricingTask(task.id, { ...review, cacheWrite5mTokens: "61", cacheWrite1hTokens: "39" }, "reviewer")).rejects.toThrow(/冲突/);
        expect(await reviewPricingTask(task.id, review, "reviewer")).toMatchObject({ executionPhase: "completed" });
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "settled", settlement: { chargedPoints: "2.75" } });
        expect((await savedTask()).result?.content).toBe("public reply");
        expect(send).toHaveBeenCalledOnce();
    });

    it.each([
        ["openai-chat", "sse"],
        ["openai-responses", "sse"],
        ["anthropic-messages", "sse"],
        ["gemini-generate", "sse"],
        ["gemini-generate", "ndjson"],
    ] as [TokenUsageProtocol, "sse" | "ndjson"][])("settles real TCP %s %s bytes only after EOF and recovers the original public answer", async (protocol, format) => {
        await streamContract(protocol);
        const sample = streamSample(protocol, format);
        let calls = 0;
        const server = createServer((_request, response) => {
            calls += 1;
            response.setHeader("content-type", sample.mediaType);
            const bytes = new TextEncoder().encode(sample.raw);
            for (const byte of bytes) response.write(Uint8Array.of(byte));
            response.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("fixture did not bind");
            const request = { ...input(vi.fn(() => fetch(`http://127.0.0.1:${address.port}`))), path: sample.path, payload: sample.payload };
            const result = await executePricedTextTask(request);
            expect(result.headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("streaming");
            expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved" });
            expect(await result.text()).toBe(sample.raw);
            expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "settled", settlement: { chargedPoints: "4.60" } });
            expect(await recoverPricedTextTaskStep(await savedTask())).toEqual({ state: "completed" });
            expect((await savedTask()).result?.content).toBe(sample.text);
            expect(JSON.stringify(await savedTask())).not.toContain("private reasoning");
            expect(JSON.stringify(await wallet.getModelPriceReservation(request))).not.toContain(sample.text);
            expect((await executePricedTextTask(request)).status).toBe(409);
            expect(calls).toBe(1);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it.each(["missing-usage", "incomplete", "error-event", "over-bound"])("retains the original stream hold for %s without a new submission", async (fault) => {
        const sample = streamSample("openai-responses");
        const withoutUsage = sample.events.map((event) => {
            const value = JSON.parse(JSON.stringify(event));
            if (value.type === "response.completed") delete value.response.usage;
            return value;
        });
        const raw =
            fault === "missing-usage"
                ? withoutUsage.map(streamEvent).join("")
                : fault === "incomplete"
                  ? sample.events.slice(0, 2).map(streamEvent).join("")
                  : fault === "error-event"
                    ? sample.raw + streamEvent({ type: "error", error: { message: "private upstream error" } })
                    : sample.raw.replace('"output_tokens":1', '"output_tokens":5');
        const request = { ...input(vi.fn(async () => new Response(raw, { headers: { "content-type": sample.mediaType } }))), payload: sample.payload };
        await (await executePricedTextTask(request)).text();
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved" });
        expect((await recoverPricedTextTaskStep(await savedTask()))?.state).toBe(["missing-usage", "over-bound"].includes(fault) ? "completed" : "needs_review");
        expect((await savedTask()).billingPending).toBe(true);
        expect(request.send).toHaveBeenCalledOnce();
        expect(JSON.stringify(await savedTask())).not.toContain("private upstream error");
    });

    it("preserves a complete streamed receipt when settlement fails and resumes without resending", async () => {
        const sample = streamSample("openai-responses");
        const request = { ...input(vi.fn(async () => new Response(sample.raw, { headers: { "content-type": sample.mediaType } }))), payload: sample.payload };
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture stream settlement unavailable"));
        expect(await (await executePricedTextTask(request)).text()).toBe(sample.raw);
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved", submission: { phase: "response_received" } });
        expect(await recoverPricedTextTaskStep(await savedTask())).toEqual({ state: "completed" });
        expect((await savedTask()).result?.content).toBe(sample.text);
        expect(request.send).toHaveBeenCalledOnce();
    });

    it.each(["cancel", "transport-error"])("does not read ahead and retains unknown billing after stream %s", async (fault) => {
        const sample = streamSample("openai-responses");
        const cancel = vi.fn();
        let reads = 0;
        const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
            if (reads++ === 0) controller.enqueue(new TextEncoder().encode(streamEvent(sample.events[0])));
            else controller.error(new Error("fixture disconnected"));
        });
        const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
        const request = { ...input(vi.fn(async () => new Response(source, { headers: { "content-type": sample.mediaType } }))), payload: sample.payload };
        const response = await executePricedTextTask(request);
        expect(pull).not.toHaveBeenCalled();
        const reader = response.body!.getReader();
        await reader.read();
        if (fault === "cancel") {
            await reader.cancel();
            expect(cancel).toHaveBeenCalledOnce();
        } else await expect(reader.read()).rejects.toThrow("disconnected");
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "reserved", submission: { phase: "outcome_unknown" } });
        expect((await savedTask()).pricedResponses).toBeUndefined();
        expect((await recoverPricedTextTaskStep(await savedTask()))?.state).toBe("needs_review");
        expect(request.send).toHaveBeenCalledOnce();
    });

    it("refunds the original streamed bill after task cancellation once complete usage arrives", async () => {
        const sample = streamSample("openai-responses");
        const request = {
            ...input(
                vi.fn(async () => {
                    await transitionTextTask(await savedTask(), ["running"], { status: "cancelled" });
                    return new Response(sample.raw, { headers: { "content-type": sample.mediaType } });
                }),
            ),
            payload: sample.payload,
        };
        await (await executePricedTextTask(request)).text();
        expect(await savedTask()).toMatchObject({ status: "cancelled", billingPending: false });
        expect((await getPricingWalletView(userId)).summary.availablePoints).toBe("30");
        expect(await wallet.getModelPriceReservation(request)).toMatchObject({ status: "settled", refundedUnits: 1 });
        expect(request.send).toHaveBeenCalledOnce();
    });

    const recoveryIt = provider === "postgres" && process.env.VOZEB_PRO_RUN_PRICING_RECOVERY === "1" ? it : it.skip;
    recoveryIt("restores the real disaster archive with original holds, receipts, prices, fractions and refund identities", async () => {
        const database = new URL(process.env.DATABASE_URL!);
        expect(database.hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
        expect(database.pathname).toMatch(/^\/vozeb_pricing_recovery_[a-z0-9_]+$/);
        expect((await postgresQuery("SELECT id FROM users")).rows).toEqual([{ id: userId }]);
        await postgresQuery("UPDATE users SET points_balance = 100 WHERE id = $1", [userId]);
        await postgresQuery("UPDATE app_settings SET free_daily_points_enabled = true, free_daily_points = 5, entitlements_enabled = true WHERE id = 'default'");
        const request = input();
        vi.spyOn(wallet, "settleModelPricePoints").mockRejectedValueOnce(new Error("fixture interrupted settlement"));
        expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("billing-pending");
        vi.restoreAllMocks();
        const original = await savedTask();
        const second = await createTextTask({ userId, billingMode: "official-usage", config: original.config, messages: [], attemptNo: 1, attempts: original.attempts });
        await transitionTextTask(second, ["pending"], { status: "running" });
        task = await bindTextTaskBillingRequest({
            taskId: second.id,
            userId,
            attemptNo: 1,
            requestId: `system-ai:${"c".repeat(64)}`,
            requestFingerprint: "d".repeat(64),
            businessRequestId: `task:${second.id}:1`,
            channelId: "channel",
            logicalModel: "priced-text",
            upstreamModel: "text",
        });
        const unknown = await unknownSubmission();
        task = original;
        const held = (await wallet.getModelPriceReservation(request))!;
        const tinyVersion = { ...held.frozen.version, id: randomUUID(), logicalModelId: "tiny-text", items: [{ key: "tokens", unit: "token", per: "1", price: "0.00001", currency: "CNY" }] };
        const tinyPolicy = { ...held.frozen.policy, id: randomUUID(), priceVersionIds: { "tiny-text": tinyVersion.id } };
        await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)", [
            tinyVersion.id,
            tinyVersion.logicalModelId,
            tinyVersion.publishedAt,
            JSON.stringify(tinyVersion),
        ]);
        await postgresQuery("INSERT INTO model_sales_price_versions (id, published_at, data) VALUES ($1, $2::timestamptz, $3::jsonb)", [tinyPolicy.id, tinyPolicy.publishedAt, JSON.stringify(tinyPolicy)]);
        const tiny = {
            userId,
            requestId: randomUUID(),
            requestFingerprint: "e".repeat(64),
            modelId: "tiny-text",
            usageKind: "text" as const,
            units: 1,
            version: tinyVersion,
            policy: tinyPolicy,
            maximumUsage: { tokens: "4" },
            contractId: "fixture-tiny",
            upperBoundEvidence: "fixture maximum four tokens",
        };
        const tinySecond = { ...tiny, requestId: randomUUID() };
        for (const value of [tiny, tinySecond]) {
            await wallet.reserveModelPricePoints(value);
            await wallet.settleModelPricePoints({ ...value, usage: value.maximumUsage });
        }
        const refund = { ...tinySecond, refundId: "partial-before-backup", usage: { tokens: "2" }, units: 0, evidence: "fixture partial refund" };
        await wallet.refundModelPricePoints(refund);
        const snapshot = async () => {
            const tables = ["users", "point_records", "quota_usage", "daily_plan_point_wallets", "model_pricing_wallet_accounts", "model_pricing_wallet_reservations", "model_pricing_wallet_refunds", "generation_tasks"];
            const state: Record<string, unknown> = {};
            for (const table of tables) state[table] = (await postgresQuery(`SELECT row_to_json(t) AS data FROM ${table} t WHERE ${table === "users" ? "id" : "user_id"} = $1 ORDER BY row_to_json(t)::text`, [userId])).rows;
            state.versions = (await postgresQuery("SELECT data FROM model_official_price_versions WHERE id = ANY($1::text[]) ORDER BY id", [[versionId, tinyVersion.id]])).rows;
            state.policies = (await postgresQuery("SELECT data FROM model_sales_price_versions WHERE id = ANY($1::text[]) ORDER BY id", [[policyId, tinyPolicy.id]])).rows;
            state.contracts = await listFlatTextPriceContracts(versionId, "channel", "text");
            state.activePolicy = (await postgresQuery("SELECT current_sales_version_id FROM model_pricing_state WHERE id = 'default'")).rows;
            return state;
        };
        const before = await snapshot();
        expect(JSON.stringify(before.model_pricing_wallet_accounts)).toContain("3/500");
        const mediaDir = join(directory, "generation-assets");
        await mkdir(mediaDir);
        await writeFile(join(mediaDir, "fixture.txt"), "本地恢复媒体", "utf8");
        const archive = join(directory, "recovery-point");
        const cli = async (name: string, args: string[]) => promisify(execFile)(process.execPath, [`scripts/disaster-${name}.mjs`, ...args], { env: process.env });
        await cli("backup", ["--output", archive, "--confirm-offline"]);
        const manifest = JSON.parse(await readFile(join(archive, "recovery-point.json"), "utf8"));
        expect(JSON.stringify(manifest)).not.toContain(database.password);
        expect(manifest.objectStorage.enabled).toBe(false);
        // Simulate losing mutable business state after the offline recovery point.
        await postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
        await postgresQuery("DELETE FROM model_flat_text_price_contracts WHERE official_version_id = $1", [versionId]);
        await postgresQuery("UPDATE model_pricing_state SET current_sales_version_id = NULL WHERE id = 'default'");
        await postgresQuery("DELETE FROM model_sales_price_versions WHERE id = ANY($1::text[])", [[policyId, tinyPolicy.id]]);
        await postgresQuery("DELETE FROM model_official_price_versions WHERE id = ANY($1::text[])", [[versionId, tinyVersion.id]]);
        await writeFile(join(mediaDir, "fixture.txt"), "恢复前的不同内容", "utf8");
        const safety = join(directory, "safety");
        // Safety must be outside both the active data directory and archive.
        const restoredData = join(directory, "restored-data");
        vi.stubEnv("VOZEB_PRO_DATA_DIR", restoredData);
        await cli("restore", ["--input", archive, "--safety-dir", safety, "--confirm", manifest.recoveryPointId, "--confirm-offline"]);
        expect(await snapshot()).toEqual(before);
        expect(await readFile(join(restoredData, "generation-assets", "fixture.txt"), "utf8")).toBe("本地恢复媒体");
        expect(JSON.parse(await readFile(join(safety, "restore-report.json"), "utf8"))).toMatchObject({ recoveryPointId: manifest.recoveryPointId, verificationRequired: true });
        expect((await wallet.refundModelPricePoints(refund)).applied).toBe(false);
        expect(await recoverPricedTextTaskStep((await getTextTask(original.id))!)).toEqual({ state: "completed" });
        expect((await getTextTask(original.id))!.result?.content).toBe("public reply");
        const settled = await getPricingWalletView(userId);
        expect((await wallet.getModelPriceReservation(request))!.settlement?.chargedPoints).toBe("4.60");
        expect((await executePricedTextTask(request)).status).toBe(409);
        expect((await recoverPricedTextTaskStep((await getTextTask(second.id))!))?.state).toBe("needs_review");
        expect((await executePricedTextTask(unknown)).status).toBe(409);
        expect(await getPricingWalletView(userId)).toEqual(settled);
        expect(request.send).toHaveBeenCalledOnce();
        expect(unknown.send).toHaveBeenCalledOnce();
        await transitionTextTask((await getTextTask(original.id))!, ["success"], { status: "cancelled" });
        expect(await refundPricedTextTask((await getTextTask(original.id))!)).toBe(true);
        const refunded = await getPricingWalletView(userId);
        expect(await refundPricedTextTask((await getTextTask(original.id))!)).toBe(true);
        expect(await getPricingWalletView(userId)).toEqual(refunded);
        expect((await wallet.getModelPriceReservation(request))!.refundedUnits).toBe(1);
        await postgresQuery("DELETE FROM model_sales_price_versions WHERE id = $1", [tinyPolicy.id]);
        await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [tinyVersion.id]);
    });

    async function fallbackFixture(ambiguous = false) {
        const base = (await listFlatTextPriceContracts(versionId, "channel", "text"))[0];
        const { id, ...contract } = base;
        const backup = await saveFlatTextPriceContract({ ...contract, channelId: "backup", requestLimits: { ...contract.requestLimits!, maxInputTokens: 12 } }, null);
        expect(backup.id).not.toBe(id);
        const config = (channelId: string, path: string) => ({
            baseUrl: `/api/ai/system/${channelId}`,
            apiKey: "",
            channelId,
            model: "text",
            logicalModel: "priced-text",
            apiFormat: "openai" as const,
            advancedConfig: { ...emptyAdvancedConfig(), createPath: path },
        });
        task = await createTextTask({
            userId,
            billingMode: "official-usage",
            config: config("channel", ambiguous ? "/responses" : "/chat/completions"),
            candidateConfigs: [config("backup", "/responses")],
            messages: [{ role: "user", content: "public request" }],
        });
        const calls: string[] = [];
        const server = createServer((request, response) => {
            calls.push(request.url!);
            if (ambiguous && request.url === "/channel") {
                response.destroy();
                return;
            }
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(responsePayload));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind");
        // Bridge the signed internal request to real task/wallet services; only upstream transport uses TCP.
        const bridge = vi.spyOn(internalOrigin, "fetchInternalApi").mockImplementation(async (url, init) => {
            const path = new URL(String(url)).pathname.split("/").filter(Boolean);
            const channelId = path[3];
            const payload = JSON.parse(String(init?.body));
            const verified = readVerifiedSystemAiBillingRequest(new Headers(init?.headers), "priced-text", payload.model);
            expect(verified?.textTask?.taskId).toBe(task.id);
            const businessRequestId = verified!.businessRequestId;
            const requestId = systemAiPointsIdempotencyKey({ userId, businessRequestId, logicalModel: "priced-text", channelId, upstreamModel: payload.model, callType: "text" });
            const requestFingerprint = systemAiRequestFingerprint({
                method: "POST",
                callType: "text",
                logicalModel: "priced-text",
                channelId,
                upstreamModel: payload.model,
                usageKind: "text",
                amount: 1,
                bodyDigest: createHash("sha256").update(String(init?.body)).digest("hex"),
            });
            const bound = await bindTextTaskBillingRequest({ taskId: task.id, userId, attemptNo: verified!.textTask!.attemptNo, requestId, requestFingerprint, businessRequestId, channelId, logicalModel: "priced-text", upstreamModel: payload.model });
            return executePricedTextTask({
                task: bound,
                userId,
                requestId,
                requestFingerprint,
                modelId: "priced-text",
                channelId,
                requestedModel: payload.model,
                path: path.slice(4),
                payload,
                signal: new AbortController().signal,
                send: () => fetch(`http://127.0.0.1:${address.port}/${channelId}`, { method: "POST" }),
            });
        });
        return {
            calls,
            backup,
            bridge,
            close: async () => {
                bridge.mockRestore();
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            },
        };
    }

    it("switches a safely rejected priced attempt to its own frozen backup contract and charges once", async () => {
        const fixture = await fallbackFixture();
        try {
            expect(await runTextTaskStep(await savedTask(), "http://fixture.invalid", "")).toEqual({ state: "completed" });
            const saved = await savedTask();
            expect(saved.attempts?.map((a) => a.status)).toEqual(["failed", "succeeded"]);
            expect(saved.billingRequests?.map((r) => r.channelId)).toEqual(["channel", "backup"]);
            const [first, second] = saved.billingRequests!;
            expect(await wallet.getModelPriceReservation({ userId, ...first })).toBeUndefined();
            expect(await wallet.getModelPriceReservation({ userId, ...second })).toMatchObject({
                status: "settled",
                frozen: { contractId: fixture.backup.id, text: { call: { channelId: "backup" }, bound: { inputTokens: "12" } } },
                settlement: { chargedPoints: "4.60" },
            });
            expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "25.4", pendingCount: 0 });
            expect(await runTextTaskStep(saved, "http://fixture.invalid", "")).toEqual({ state: "completed" });
            expect(fixture.calls).toEqual(["/backup"]);
        } finally {
            await fixture.close();
        }
    });

    it("resumes a priced backup after interruption between failed-attempt persistence and channel advancement", async () => {
        const fixture = await fallbackFixture();
        const update = taskStore.updateTextTask;
        const pause = vi.spyOn(taskStore, "updateTextTask").mockImplementation(async (id, patch, expectedFailedAttempt) => {
            const saved = await update(id, patch, expectedFailedAttempt);
            if (!patch.config && patch.attemptNo === 1 && patch.attempts?.[0].status === "failed") throw new Error("fixture worker interrupted after failed attempt commit");
            return saved;
        });
        try {
            await expect(runTextTaskStep(await savedTask(), "http://fixture.invalid", "")).rejects.toThrow("fixture worker interrupted");
            pause.mockRestore();
            expect((await savedTask()).attempts?.[0].status).toBe("failed");
            expect(fixture.calls).toEqual([]);
            const persisted = await savedTask();
            const recovered = await Promise.all([runTextTaskStep(persisted, "http://fixture.invalid", ""), runTextTaskStep(persisted, "http://fixture.invalid", "")]);
            expect(recovered.some((result) => result.state === "completed")).toBe(true);
            expect(recovered.every((result) => ["completed", "needs_review"].includes(result.state))).toBe(true);
            expect((await savedTask()).attempts?.map((a) => a.status)).toEqual(["failed", "succeeded"]);
            expect((await savedTask()).billingRequests).toHaveLength(2);
            expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "25.4", pendingCount: 0 });
            expect(fixture.calls).toEqual(["/backup"]);
        } finally {
            pause.mockRestore();
            await fixture.close();
        }
    });

    it("finishes an administrator decision after interruption instead of starting a saved backup", async () => {
        const fixture = await fallbackFixture(true);
        try {
            await runTextTaskStep(await savedTask(), "http://fixture.invalid", "");
            await taskStore.updateTextTask(task.id, { attempts: (await savedTask()).attempts!.map((a) => ({ ...a, status: "failed" })) });
            await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
            vi.spyOn(wallet, "reviewModelPriceSubmission").mockRejectedValueOnce(new Error("fixture interrupted administrative release"));
            expect(await reviewPricingTask(task.id, noCharge, "reviewer")).toMatchObject({ executionPhase: "needs_review" });
            expect((await savedTask()).billingRequests![0].review).toBeDefined();
            expect(await runTextTaskStep(await savedTask(), "http://fixture.invalid", "")).toMatchObject({ state: "failed" });
            expect((await savedTask()).billingRequests).toHaveLength(1);
            expect((await savedTask()).status).toBe("error");
            expect((await getPricingWalletView(userId)).summary).toMatchObject({ availablePoints: "30", pendingCount: 0 });
            expect(fixture.calls).toEqual(["/channel"]);
        } finally {
            await fixture.close();
        }
    });

    it.each(["running", "failed"] as const)("does not switch a %s priced attempt while its original charge is unknown", async (status) => {
        const fixture = await fallbackFixture(true);
        try {
            expect(await runTextTaskStep(await savedTask(), "http://fixture.invalid", "")).toMatchObject({ state: "needs_review" });
            const saved = await savedTask();
            if (status === "failed") await taskStore.updateTextTask(task.id, { attempts: saved.attempts!.map((a) => ({ ...a, status })) });
            const original = await wallet.getModelPriceReservation({ userId, ...saved.billingRequests![0] });
            expect(original).toMatchObject({ status: "reserved", submission: { phase: "outcome_unknown" } });
            expect(await runTextTaskStep(await savedTask(), "http://fixture.invalid", "")).toMatchObject({ state: "needs_review" });
            expect((await savedTask()).attemptNo).toBe(1);
            expect((await savedTask()).billingRequests).toHaveLength(1);
            expect(await wallet.getModelPriceReservation({ userId, ...saved.billingRequests![0] })).toEqual(original);
            expect(fixture.calls).toEqual(["/channel"]);
        } finally {
            await fixture.close();
        }
    });

    it("settles a real local TCP response without resubmitting on replay", async () => {
        let calls = 0;
        const server = createServer((_request, response) => {
            calls += 1;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(responsePayload));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("fixture did not bind");
            const request = input(vi.fn(() => fetch(`http://127.0.0.1:${address.port}`)));
            expect((await executePricedTextTask(request)).headers.get(SYSTEM_AI_PRICING_STATE_HEADER)).toBe("settled");
            expect((await executePricedTextTask(request)).status).toBe(409);
            expect(calls).toBe(1);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it.each((["openai-chat", "anthropic-messages", "gemini-generate"] as TokenUsageProtocol[]).flatMap((protocol) => [false, true].map((manual) => ({ protocol, manual }))))(
        "settles $protocol with manual=$manual through reviewed meters and excludes private reasoning",
        async ({ protocol, manual }) => {
            const old = (await listFlatTextPriceContracts(versionId, "channel", "text"))[0];
            const itemMeters = {
                ...old.itemMeters,
                input: protocol === "anthropic-messages" ? ["inputTokens", "cacheWrite5mTokens", "cacheWrite1hTokens"] : protocol === "gemini-generate" ? ["inputTokens"] : old.itemMeters.input,
            } as FlatTextPriceContract["itemMeters"];
            await saveFlatTextPriceContract({ ...old, protocol, itemMeters }, old.id);
            const sample =
                protocol === "openai-chat"
                    ? {
                          path: ["v1", "chat", "completions"],
                          payload: { model: "text", messages: [{ role: "user", content: "hello" }] },
                          response: {
                              model: "text-v1",
                              service_tier: "default",
                              choices: [{ finish_reason: "stop", message: { content: "public reply", reasoning_content: "private reasoning" } }],
                              usage: { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 } },
                          },
                      }
                    : protocol === "anthropic-messages"
                      ? {
                            path: ["v1", "messages"],
                            payload: { model: "text", max_tokens: 4, messages: [{ role: "user", content: "hello" }] },
                            response: {
                                model: "text-v1",
                                stop_reason: "end_turn",
                                content: [{ type: "text", text: "public reply" }],
                                usage: { service_tier: "default", input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 6, cache_creation_input_tokens: 0 },
                            },
                        }
                      : {
                            path: ["v1beta", "models", "text:generateContent"],
                            payload: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
                            response: {
                                modelVersion: "text-v1",
                                candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private reasoning" }, { text: "public reply" }] } }],
                                usageMetadata: { serviceTier: "default", promptTokenCount: 8, cachedContentTokenCount: 6, candidatesTokenCount: 1, thoughtsTokenCount: 0 },
                            },
                        };
            const request = input(
                vi.fn(async () => {
                    if (manual) throw new Error("fixture lost response");
                    return Response.json(sample.response);
                }),
            );
            expect((await executePricedTextTask({ ...request, path: sample.path, payload: sample.payload })).status).toBe(manual ? 409 : 200);
            if (manual) {
                await scheduleGenerationTask("text", task.id, { executionPhase: "needs_review", nextPollAt: undefined });
                await reviewPricingTask(task.id, { ...metered, response: JSON.stringify(sample.response) }, "reviewer");
                expect(JSON.stringify((await savedTask()).billingRequests)).not.toContain("private reasoning");
            }
            expect(await recoverPricedTextTask(await savedTask())).toMatchObject({ state: "completed", content: "public reply", pointsCost: 4.6 });
            expect(JSON.stringify(await savedTask())).not.toContain("private reasoning");
        },
    );
});
