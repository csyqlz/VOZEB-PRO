import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";
import type { AuthSettings } from "@/lib/auth/store";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

const nextContext = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (nextContext.cookie ? { value: nextContext.cookie } : undefined) }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
const enabled = process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
const postgresDescribe = enabled ? describe : describe.skip;
type ProcessResult = { pid: number; outcome: { status?: number; body?: unknown }; run: AgentRun };
type HttpGate = { arrived: Promise<void>; release: () => void; wait: Promise<void>; arrive: () => void };

postgresDescribe("isolated PostgreSQL ecommerce confirmation and independent process recovery", () => {
    let directory: string;
    let originalSettings: AuthSettings;
    let userId: string;
    let otherUserId: string;
    let cookie: string;
    let otherCookie: string;
    let origin: string;
    let server: Server;
    let serverPort: number;
    let closingServer: Promise<void> | undefined;
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let source: Buffer;
    let sourcePath: string;
    let stores: typeof import("./agent-run-store");
    let runtime: typeof import("./creative-runtime-store");
    let auth: typeof import("@/lib/auth/store");
    let database: typeof import("./database");
    let scheduler: typeof import("./generation-task-scheduler");
    let images: typeof import("./image-task-store");
    const children = new Map<ChildProcess, Promise<void>>();
    const handlers = new Set<Promise<void>>();
    const handlerFailures: unknown[] = [];
    const ownedRuns = new Set<string>();
    const results = new Map<string, ProcessResult>();
    const imageRequests: Array<{ context: { runId: string; parentTaskId: string; attemptNo: number; clientRequestId: string } }> = [];
    let barrier: (HttpGate & { remaining: number }) | undefined;
    let imagePostBarrier: HttpGate | undefined;

    beforeAll(async () => {
        if (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || !process.env.DATABASE_URL) throw new Error("Explicit isolated PostgreSQL fixture authorization is required");
        directory = await mkdtemp(path.join(tmpdir(), "vozeb-ecommerce-process-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "off");
        [database, auth, stores, runtime, scheduler, images] = await Promise.all([
            import("./database"),
            import("@/lib/auth/store"),
            import("./agent-run-store"),
            import("./creative-runtime-store"),
            import("./generation-task-scheduler"),
            import("./image-task-store"),
        ]);
        await database.ensurePostgresSchema();
        originalSettings = await auth.getFreshAuthSettings();
        const repos = database.createPostgresRepositories();
        const settingsRows = await repos.settings.getSettings();
        const planId = settingsRows.settings?.defaultPlanId || settingsRows.plans[0]?.id;
        if (!planId) throw new Error("Fixture entitlement plan is missing");
        const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
        if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated fixture must use local media storage");
        for (const [index, id] of [`fixture-ecommerce-${randomUUID()}`, `fixture-ecommerce-${randomUUID()}`].entries()) {
            const now = new Date().toISOString();
            await repos.users.createWithNextAccountId({
                id,
                username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                displayName: "隔离回归用户",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId,
                pointsBalance: 1000,
                passwordHash: "fixture-only",
                createdAt: now,
                updatedAt: now,
            });
            if (index === 0) userId = id;
            else otherUserId = id;
        }
        cookie = await auth.createSession(userId);
        otherCookie = await auth.createSession(otherUserId);
        nextContext.cookie = cookie;
        source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "#987654" } })
            .png()
            .toBuffer();
        const imagePath = path.join(directory, "native.png");
        await writeFile(imagePath, source);
        fixture = createProtocolFixtureServer({ imagePath, ecommerceAsyncImage: true });
        await listen(fixture.server);
        const fixtureOrigin = serverOrigin(fixture.server);
        const imageRoute = await import("@/app/api/image-tasks/route");
        const imageDetail = await import("@/app/api/image-tasks/[id]/route");
        const proxy = await import("@/app/api/ai/system/[channelId]/[...path]/route");
        const references = await import("@/app/api/reference-assets/[...path]/route");
        const media = await import("@/app/api/generation-log-assets/[...path]/route");
        server = createServer((incoming, outgoing) => {
            const handler = (async () => {
                try {
                    const url = new URL(incoming.url || "/", origin);
                    const chunks: Buffer[] = [];
                    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
                    const bytes = Buffer.concat(chunks);
                    if (url.pathname.startsWith("/_process-result/")) {
                        results.set(url.pathname.split("/").at(-1)!, JSON.parse(bytes.toString("utf8")));
                        outgoing.end("ok");
                        return;
                    }
                    const bodyGate = incoming.method === "POST" && url.pathname === "/api/image-tasks" ? imagePostBarrier : undefined;
                    const body = bodyGate
                        ? new ReadableStream<Uint8Array>(
                              {
                                  async pull(controller) {
                                      // The real POST has authenticated and is now reading its body.
                                      bodyGate.arrive();
                                      await bodyGate.wait;
                                      controller.enqueue(bytes);
                                      controller.close();
                                  },
                              },
                              { highWaterMark: 0 },
                          )
                        : bytes;
                    const request = new Request(url, { method: incoming.method, headers: incoming.headers as HeadersInit, ...(bytes.length ? { body } : {}), ...(bodyGate ? { duplex: "half" } : {}) });
                    let response: Response;
                    const childId = url.pathname.match(/^\/api\/image-tasks\/(.+)$/)?.[1];
                    const proxyPath = url.pathname.match(/^\/api\/ai\/system\/fixture\/(.+)$/)?.[1];
                    const referencePath = url.pathname.match(/^\/api\/reference-assets\/(.+)$/)?.[1];
                    const mediaPath = url.pathname.match(/^\/api\/generation-log-assets\/(.+)$/)?.[1];
                    if (referencePath && barrier && url.pathname === sourcePath) {
                        const gate = barrier;
                        gate.remaining--;
                        if (!gate.remaining) gate.arrive();
                        await gate.wait;
                    }
                    if (incoming.method === "POST" && url.pathname === "/api/image-tasks") {
                        imageRequests.push(JSON.parse(bytes.toString("utf8")));
                        response = await imageRoute.POST(request);
                    }
                    // A transport outage ends this executor turn at a real persisted child.
                    else if (childId && (await images.getImageTask(childId))?.status !== "success") response = new Response("fixture child read interrupted", { status: 503 });
                    else if (childId) response = await imageDetail.GET(request, { params: Promise.resolve({ id: childId }) });
                    else if (proxyPath) response = await proxy[incoming.method === "POST" ? "POST" : "GET"](request, { params: Promise.resolve({ channelId: "fixture", path: proxyPath.split("/") }) });
                    else if (referencePath) response = await references.GET(request, { params: Promise.resolve({ path: referencePath.split("/") }) });
                    else if (mediaPath) response = await media.GET(request, { params: Promise.resolve({ path: mediaPath.split("/") }) });
                    else response = new Response("fixture route missing", { status: 404 });
                    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                    outgoing.end(Buffer.from(await response.arrayBuffer()));
                } catch (error) {
                    outgoing.statusCode = 500;
                    outgoing.end(error instanceof Error ? error.message : "fixture route failed");
                }
            })();
            handlers.add(handler);
            void handler.then(
                () => handlers.delete(handler),
                (error) => {
                    handlers.delete(handler);
                    handlerFailures.push(error);
                },
            );
        });
        await listen(server);
        origin = serverOrigin(server);
        serverPort = Number(new URL(origin).port);
        vi.stubEnv("VOZEB_PRO_INTERNAL_ORIGIN", origin);
        await auth.setAuthSettings({
            ecommerceGenerationEnabled: true,
            systemChannels: [
                {
                    id: "fixture",
                    name: "隔离协议夹具",
                    enabled: true,
                    baseUrl: `${fixtureOrigin}/v1`,
                    apiKey: "fixture-only",
                    apiFormat: "openai",
                    models: ["fixture-text", "gpt-image-2.5-flare"],
                    advancedConfig: {
                        protocol: "openai",
                        textModel: "",
                        imageModel: "",
                        videoModel: "",
                        createPath: "",
                        queryPath: "",
                        requestTemplate: "",
                        resultField: "",
                        statusField: "",
                        durationRange: "",
                        referenceRule: "",
                        supportsReferenceImage: true,
                        supportsReferenceVideo: false,
                        supportsReferenceAudio: false,
                        modelConfigs: {
                            "gpt-image-2.5-flare": { capability: "image", protocol: "openai", apiFormat: "openai", createPath: "/images/generations", editPath: "/images/edits", queryPath: "/images/tasks/:task_id", supportsReferenceImage: true },
                        },
                    },
                },
            ],
            logicalModels: [
                { id: "fixture-text", name: "夹具文本", capability: "text", enabled: true, bindings: [{ id: "fixture-text-binding", channelId: "fixture", upstreamModel: "fixture-text", enabled: true, priority: 1 }] },
                { id: "fixture-image", name: "夹具图片", capability: "image", enabled: true, bindings: [{ id: "fixture-image-binding", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", enabled: true, priority: 1 }] },
            ],
            defaultModels: { textModel: "fixture-text", imageModel: "fixture-image", videoModel: "", audioModel: "" },
            modelPointCosts: { "fixture-text": 0, "fixture-image": 0 },
        });
    }, 120_000);

    beforeEach(async () => {
        if (!server.listening) {
            await closingServer;
            await listen(server, serverPort);
            closingServer = undefined;
        }
    }, 120_000);

    afterAll(async () => {
        const failures: unknown[] = [];
        const settle = async (cleanup: () => Promise<unknown>) => {
            try {
                await cleanup();
            } catch (error) {
                failures.push(error);
            }
        };
        try {
            await settle(stopCommands);
            await settle(drainHandlers);
            if (server) await settle(sealAdmission);
            // server.close only closes transport; also drain any final accepted handler.
            await settle(drainHandlers);
            if (fixture) await settle(() => close(fixture.server));
            if (originalSettings) await settle(() => auth.setAuthSettings(originalSettings));
            if (database) {
                const users = await Promise.allSettled([userId, otherUserId].filter(Boolean).map((id) => database.createPostgresRepositories().users.delete(id)));
                failures.push(...users.filter((result) => result.status === "rejected").map((result) => result.reason));
            }
            if (directory) await settle(() => rm(directory, { recursive: true, force: true }));
            failures.push(...handlerFailures.splice(0));
        } finally {
            vi.unstubAllEnvs();
        }
        if (failures.length) throw new AggregateError(failures, "Isolated fixture cleanup failed");
    }, 120_000);

    afterEach(cleanupOwnedCase, 120_000);

    async function cleanupOwnedCase() {
        await stopCommands();
        await drainHandlers();
        await sealAdmission();
        await drainHandlers();
        const { listStoredGenerationTaskRecordsByRunIds } = await import("./generation-task-store");
        const records = await listStoredGenerationTaskRecordsByRunIds([...ownedRuns], [userId]);
        for (const record of records)
            if (record.type === "image" && ["pending", "running", "paused"].includes(record.status)) {
                const image = await images.getImageTask(record.id);
                if (image) await images.transitionImageTask(image, ["pending", "running"], { status: "cancelled" }, { executionPhase: "completed", nextPollAt: undefined });
            }
        for (const id of ownedRuns) {
            const run = await stores.getAgentRun(id);
            if (run && ["planning", "running", "paused"].includes(run.status)) await stores.setAgentRunStatus(run, "cancelled");
        }
        ownedRuns.clear();
        if (handlerFailures.length) throw new AggregateError(handlerFailures.splice(0), "Isolated HTTP handler failed");
    }

    async function sealAdmission() {
        if (!closingServer) {
            closingServer = close(server);
            // First drain kept Route self-requests available; now reject new
            // admission and end accepted sockets that have not sent HTTP yet.
            server.closeAllConnections();
        }
        await closingServer;
    }

    async function stopCommands() {
        barrier?.release();
        barrier = undefined;
        imagePostBarrier?.release();
        imagePostBarrier = undefined;
        const pending = [...children.entries()];
        for (const [child] of pending) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        // close follows process exit and drainage of all inherited stdio pipes.
        await Promise.all(pending.map(([, settled]) => settled));
    }

    async function drainHandlers() {
        // Route work can outlive its client and create further internal requests.
        while (handlers.size) await Promise.allSettled([...handlers]);
    }

    async function paused(version: EcommerceEditPlan["planVersion"] = "ecommerce-edit.v5", parent?: AgentRun) {
        const conversation = parent ? { id: parent.conversationId } : await runtime.createCreativeConversation(userId, { surface: "chat" });
        const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
        const stored = await writeReferenceImageDataUrl(`data:image/png;base64,${source.toString("base64")}`, { ownerUserId: userId, conversationId: conversation.id, source: "fixture", originalName: "source.png" });
        sourcePath = `/api/reference-assets/${stored.token}`;
        const asset = parent
            ? (await runtime.getCreativeAsset(parent.assetIds[0], userId))!
            : (await runtime.registerCreativeAssets([{ id: `fixture-source-${randomUUID()}`, userId, conversationId: conversation.id, ordinal: 0, type: "image", title: "scene", serverUrl: sourcePath, width: 6, height: 4, metadata: {} }]))[0];
        sourcePath = asset.serverUrl!;
        const plan: EcommerceEditPlan = {
            planVersion: version,
            operation: "scene_edit",
            source: { productAnchorId: null, currentSceneBaselineId: asset.id, sceneReferenceIds: [] },
            baseline: { productFacts: null, sceneFacts: { space: "room", composition: "front", lighting: "existing soft light" } },
            canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
            protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
            delta: { requestedChanges: ["三层抽屉柜只加柜面花瓶"], targetObjects: ["vase"], targetRegions: ["cabinet top"] },
            preserve: { productCore: [], sceneElements: ["cabinet", "room"] },
            strategy: "integrated_scene",
            modelRoles: { visionAnalysis: "fixture-text", editPlanning: "fixture-text", generation: "fixture-image", qualityCheck: "fixture-text" },
            continuity: { branchId: `fixture-branch-${randomUUID()}`, parentResultId: parent?.assetIds[0] || null },
            validation: { requiredChecks: ["outside_mask"] },
        };
        if (version === "ecommerce-edit.v1") {
            delete plan.canvas;
            delete plan.protection;
        }
        if (["ecommerce-edit.v4", "ecommerce-edit.v5"].includes(version)) plan.visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 6, height: 4 } }];
        if (version === "ecommerce-edit.v5")
            plan.photography = {
                materials: [],
                lighting: { keyLight: "existing soft light", fillLight: "existing fill", whiteBalance: "neutral", contactShadow: "local vase shadow" },
                composition: { focalSubject: "cabinet", depth: "existing depth", negativeSpace: "existing space" },
            };
        const { compileEcommerceImageRequest } = await import("./ecommerce-image-compiler");
        const compiled = compileEcommerceImageRequest(plan, {
            profileId: "gpt-image-2.5-flare",
            compilerFamily: "openai-image-2.5",
            supportsIndependentMask: true,
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "fixture-image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
        });
        const run = (await stores.createAgentRun(userId, { clientRequestId: randomUUID(), conversationId: conversation.id, surface: "chat", prompt: "只加柜面花瓶", assetIds: [asset.id], skillIds: [], modelIds: [] })).run;
        ownedRuns.add(run.id);
        const task = {
            id: "fixture-scene-task",
            title: "生成图片",
            type: "image" as const,
            model: "fixture-image",
            prompt: compiled.prompt,
            count: 1,
            dependencies: [],
            status: "needs_review" as const,
            attempts: 0,
            ecommerceExecution: compiled,
            references: [{ assetId: asset.id, type: "image" as const, title: "scene", url: sourcePath, width: 6, height: 4, ecommerceRole: "scene" as const }],
        };
        const saved = await stores.updateAgentRunById(
            run.id,
            {
                status: "paused",
                reviewed: true,
                tasks: [task],
                ecommerceSnapshot: {
                    version: "ecommerce-generation.v1",
                    runId: run.id,
                    userId,
                    mode: "active",
                    input: { userRequest: run.prompt, assetIds: [asset.id], conversationId: conversation.id, surface: "chat" },
                    plan,
                    continuity: {
                        parentResultId: plan.continuity.parentResultId,
                        branchId: plan.continuity.branchId,
                        ...(version !== "ecommerce-edit.v1" ? { sceneRootAssetId: parent?.ecommerceSnapshot?.continuity?.sceneRootAssetId || asset.id } : {}),
                        ...(parent?.ecommerceSnapshot?.qualityCheck ? { parentQualityCheck: parent.ecommerceSnapshot.qualityCheck } : {}),
                    },
                    fallback: { reason: "scene_selection_required" },
                    createdAt: Date.now(),
                },
            },
            undefined,
            ["planning"],
        );
        if (!saved) throw new Error("Fixture paused run was not persisted");
        return { run: saved, selection: { baselineAssetId: asset.id, region: { x: 2, y: 1, width: 2, height: 2 } } };
    }

    function holdSource(reads: number) {
        barrier = { ...createGate(), remaining: reads };
        return barrier;
    }

    function processCommand(run: AgentRun, command: "confirm" | "recover" | "read", extra: Record<string, unknown> = {}) {
        const resultKey = randomUUID();
        const input = { command, origin, cookie, resultKey, runId: run.id, conversationId: run.conversationId, ...extra };
        const child = spawn(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/server/ecommerce-process-fixture.test.ts", "--no-file-parallelism", "--reporter=dot"], {
            cwd: process.cwd(),
            env: { ...process.env, VOZEB_PRO_ECOMMERCE_PROCESS_INPUT: JSON.stringify(input) },
            stdio: ["ignore", "pipe", "pipe"],
        });
        children.set(
            child,
            new Promise<void>((resolve) =>
                child.once("close", () => {
                    children.delete(child);
                    resolve();
                }),
            ),
        );
        let output = "";
        child.stdout?.on("data", (data) => {
            output += data;
        });
        child.stderr?.on("data", (data) => {
            output += data;
        });
        const commandResult = new Promise<ProcessResult>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => {
                const result = results.get(resultKey);
                results.delete(resultKey);
                if (code !== 0 || !result) {
                    for (const secret of [cookie, otherCookie, process.env.DATABASE_URL, process.env.VOZEB_PRO_ENCRYPTION_KEY].filter((value): value is string => Boolean(value))) output = output.replaceAll(secret, "[redacted]");
                    reject(new Error(`Independent fixture process failed (${code}): ${output}`));
                } else resolve(result);
            });
        });
        // Teardown can terminate an unawaited command after the parent fails.
        // The original Promise still reports failures to every normal caller.
        void commandResult.catch(() => {});
        return commandResult;
    }

    it("seals HTTP-silent accepted sockets before owned cleanup can admit a late result POST", async () => {
        const { run } = await paused();
        const resultKey = randomUUID();
        const accepted = once(server, "connection");
        const client = createConnection({ host: "127.0.0.1", port: Number(new URL(origin).port) });
        const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
        // A sealed raw connection may close while its late write is in flight.
        client.on("error", () => {});
        client.resume();
        const [serverSocket] = (await accepted) as [Socket];
        try {
            await cleanupOwnedCase();
            const cleanedRun = await stores.getAgentRun(run.id);
            const cleanedEvents = await runtime.listCreativeRunEvents(run.id);
            if (!client.destroyed) {
                const payload = JSON.stringify({ pid: 0, outcome: { status: 200 }, run });
                client.write(`POST /_process-result/${resultKey} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
            }
            await closed;
            await drainHandlers();
            expect(results.has(resultKey)).toBe(false);
            expect(server.listening).toBe(false);
            expect(serverSocket.destroyed).toBe(true);
            expect(handlers.size).toBe(0);
            expect(children.size).toBe(0);
            expect(await stores.getAgentRun(run.id)).toEqual(cleanedRun);
            expect(await runtime.listCreativeRunEvents(run.id)).toEqual(cleanedEvents);
            expect(imageRequests.filter((request) => request.context.runId === run.id)).toEqual([]);
            const refused = createConnection({ host: "127.0.0.1", port: Number(new URL(origin).port) });
            try {
                const outcome = await new Promise<string>((resolve) => {
                    refused.once("error", (error: NodeJS.ErrnoException) => resolve(error.code || error.message));
                    refused.once("connect", () => resolve("unexpected connection"));
                });
                expect(outcome).toBe("ECONNREFUSED");
            } finally {
                refused.destroy();
            }
        } finally {
            client.destroy();
            serverSocket.destroy();
            results.delete(resultKey);
        }
    }, 120_000);

    it("stops barrier commands before owned cleanup after a simulated parent failure", async () => {
        const { run, selection } = await paused();
        const gate = holdSource(1);
        const command = processCommand(run, "confirm", { sceneSelection: selection });
        const settled = Promise.allSettled([command]);
        await Promise.race([
            gate.arrived,
            command.then(() => {
                throw new Error("Confirmation process exited before source barrier");
            }),
        ]);
        const parentFailure = new Error("simulated parent failure");
        await expect(
            (async () => {
                try {
                    throw parentFailure;
                } finally {
                    await cleanupOwnedCase();
                }
            })(),
        ).rejects.toBe(parentFailure);
        const survivors = children.size;
        const cleanedRun = await stores.getAgentRun(run.id);
        const cleanedEvents = await runtime.listCreativeRunEvents(run.id);
        await settled;
        expect(survivors).toBe(0);
        expect(children.size).toBe(0);
        expect(handlers.size).toBe(0);
        expect(await stores.getAgentRun(run.id)).toEqual(cleanedRun);
        expect(await runtime.listCreativeRunEvents(run.id)).toEqual(cleanedEvents);
        const { listStoredGenerationTaskRecordsByRunIds } = await import("./generation-task-store");
        expect(await listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toEqual([]);
        expect(cleanedRun?.status).toBe("cancelled");
        expect(imageRequests.filter((request) => request.context.runId === run.id)).toEqual([]);
    }, 120_000);

    it("drains an active image POST after a recovery parent fails before cleaning owned state", async () => {
        const { run } = await paused("ecommerce-edit.v1");
        const snapshot = structuredClone(run.ecommerceSnapshot!);
        delete snapshot.fallback;
        const started = (await stores.updateAgentRunById(run.id, { status: "running", tasks: [{ ...run.tasks[0], status: "ready" }], ecommerceSnapshot: snapshot }, undefined, ["paused"]))!;
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        const creations = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path.endsWith("/images/edits")).length;
        const initialCreations = creations();
        const gate = createGate();
        imagePostBarrier = gate;
        const command = processCommand(started, "recover");
        const settled = Promise.allSettled([command]);
        try {
            await Promise.race([
                gate.arrived,
                command.then(() => {
                    throw new Error("Recovery process exited before the image POST body gate");
                }),
            ]);
            expect(handlers.size).toBeGreaterThan(0);
            const parentFailure = new Error("simulated recovery parent failure");
            await expect(
                (async () => {
                    try {
                        throw parentFailure;
                    } finally {
                        await cleanupOwnedCase();
                    }
                })(),
            ).rejects.toBe(parentFailure);
            const unfinishedAtCleanup = handlers.size;
            const cleanedRun = await stores.getAgentRun(run.id);
            const cleanedEvents = await runtime.listCreativeRunEvents(run.id);
            const { listStoredGenerationTaskRecordsByRunIds } = await import("./generation-task-store");
            const cleanedRecords = await listStoredGenerationTaskRecordsByRunIds([run.id], [userId]);
            gate.release();
            await Promise.allSettled([...handlers]);
            await settled;
            const settledRun = await stores.getAgentRun(run.id);
            const settledEvents = await runtime.listCreativeRunEvents(run.id);
            const settledRecords = await listStoredGenerationTaskRecordsByRunIds([run.id], [userId]);
            expect(
                unfinishedAtCleanup,
                JSON.stringify({ recordsAtCleanup: cleanedRecords.length, recordsAfterHandlers: settledRecords.length, childStatuses: settledRecords.map((record) => record.status), upstreamCreations: creations() - initialCreations }),
            ).toBe(0);
            expect(handlers.size).toBe(0);
            expect(children.size).toBe(0);
            expect(handlerFailures).toEqual([]);
            expect(settledRun).toEqual(cleanedRun);
            expect(settledEvents).toEqual(cleanedEvents);
            expect(settledRecords).toEqual(cleanedRecords);
            expect(cleanedRun).toMatchObject({ id: run.id, status: "cancelled", tasks: [{ id: run.tasks[0].id, attempts: 1, count: 1 }] });
            expect(cleanedRun?.ecommerceSnapshot).toEqual(snapshot);
            expect(cleanedRun?.tasks[0].ecommerceExecution).toEqual(run.tasks[0].ecommerceExecution);
            expect(cleanedRecords).toMatchObject([{ type: "image", runId: run.id, status: "cancelled", attemptNo: 1, clientRequestId: `${run.clientRequestId}:${run.tasks[0].id}:1:1` }]);
            expect(imageRequests.filter((request) => request.context.runId === run.id)).toEqual([
                expect.objectContaining({ context: expect.objectContaining({ parentTaskId: run.tasks[0].id, attemptNo: 1, clientRequestId: `${run.clientRequestId}:${run.tasks[0].id}:1:1` }) }),
            ]);
            expect(creations()).toBe(initialCreations);
        } finally {
            imagePostBarrier = undefined;
            gate.release();
            await Promise.allSettled([...handlers]);
            await settled;
        }
    }, 120_000);

    it("rejects an untyped reference recovery in an independent process without mutating the original run", async () => {
        const { run } = await paused();
        await stores.updateAgentRunById(run.id, {
            tasks: run.tasks.map((task) => ({ ...task, ecommerceExecution: undefined })),
            ecommerceSnapshot: { ...run.ecommerceSnapshot!, plan: undefined, fallback: { reason: "reference_purpose_confirmation_required" } },
        });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "completed", nextPollAt: undefined, lastUpstreamStatus: "paused" });
        const frozen = (await stores.getAgentRun(run.id))!;
        const events = await runtime.listCreativeRunEvents(run.id);
        const { listCreativeMessages } = runtime;
        const messages = await listCreativeMessages(run.conversationId);
        const result = await processCommand(frozen, "confirm");

        expect(result.pid).not.toBe(process.pid);
        expect(result.outcome.status).toBe(409);
        expect(await stores.getAgentRun(run.id)).toEqual(frozen);
        expect(await runtime.listCreativeRunEvents(run.id)).toEqual(events);
        expect(await listCreativeMessages(run.conversationId)).toEqual(messages);
        expect(imageRequests.filter((request) => request.context.runId === run.id)).toEqual([]);
    }, 120_000);

    it("allows exactly one of two independent confirmation processes to mutate the original task", async () => {
        const { run, selection } = await paused();
        const gate = holdSource(2);
        const first = processCommand(run, "confirm", { sceneSelection: selection });
        const second = processCommand(run, "confirm", { sceneSelection: selection });
        await Promise.race([
            gate.arrived,
            ...[first, second].map((result) =>
                result.then(() => {
                    throw new Error("Confirmation process exited before source barrier");
                }),
            ),
        ]);
        barrier = undefined;
        gate.release();
        const outcomes = await Promise.all([first, second]);
        expect(new Set(outcomes.map((result) => result.pid)).size).toBe(2);
        expect(outcomes.map((result) => result.outcome.status).sort()).toEqual([200, 409]);
        const saved = (await stores.getAgentRun(run.id))!;
        expect(saved.tasks).toMatchObject([{ id: run.tasks[0].id, attempts: 0, status: "ready", count: 1, sceneProtection: { targetRegion: selection.region, confirmation: { actorUserId: userId } } }]);
        expect(saved.ecommerceSnapshot).toEqual(run.ecommerceSnapshot);
        expect(saved.tasks[0].taskIds).toBeUndefined();
        expect((await runtime.listCreativeRunEvents(run.id)).filter((event) => event.type === "run.resumed")).toHaveLength(1);
    }, 120_000);

    it("rejects a late confirmation after the task was submitted and paused again", async () => {
        const { run, selection } = await paused();
        const gate = holdSource(1);
        const stale = processCommand(run, "confirm", { sceneSelection: selection });
        await Promise.race([
            gate.arrived,
            stale.then(() => {
                throw new Error("Late confirmation process exited before source barrier");
            }),
        ]);
        const submittedTasks = [{ ...run.tasks[0], status: "running" as const, attempts: 1, taskId: "fixture-existing-child", taskIds: ["fixture-existing-child"], childTasks: [{ id: "fixture-existing-child", status: "pending" as const, attempt: 1 }] }];
        await stores.updateAgentRunById(run.id, { status: "running", tasks: submittedTasks }, undefined, ["paused"]);
        await stores.updateAgentRunById(run.id, { status: "paused" }, undefined, ["running"]);
        barrier = undefined;
        gate.release();
        expect((await stale).outcome.status).toBe(409);
        expect((await stores.getAgentRun(run.id))!.tasks).toEqual(submittedTasks);
    }, 120_000);

    it.each(["ecommerce-edit.v3", "ecommerce-edit.v4", "ecommerce-edit.v5"] as const)(
        "confirms and independently reads the immutable %s snapshot",
        async (version) => {
            const { run, selection } = await paused(version);
            const confirmed = await processCommand(run, "confirm", { sceneSelection: selection });
            expect(confirmed.outcome).toMatchObject({ status: 200, body: { code: 0 } });
            const restored = await processCommand(run, "read");
            expect(restored.pid).not.toBe(confirmed.pid);
            expect(restored.run.tasks[0]).toMatchObject({ id: run.tasks[0].id, status: "ready", attempts: 0, count: 1, ecommerceExecution: run.tasks[0].ecommerceExecution });
            expect(restored.run.ecommerceSnapshot).toEqual(run.ecommerceSnapshot);
            if (version !== "ecommerce-edit.v5") expect(restored.run.ecommerceSnapshot!.plan).not.toHaveProperty("photography");
        },
        120_000,
    );

    it("rejects unauthenticated, cross-user, cross-conversation, duplicate, old-version and QA-paused confirmations", async () => {
        const { run, selection } = await paused();
        expect((await processCommand(run, "confirm", { cookie: "", sceneSelection: selection })).outcome.status).toBe(401);
        expect((await processCommand(run, "confirm", { cookie: otherCookie, sceneSelection: selection })).outcome.status).toBe(404);
        expect((await processCommand(run, "confirm", { conversationId: "fixture-other-conversation", sceneSelection: selection })).outcome.status).toBe(409);
        expect((await processCommand(run, "confirm", { sceneSelection: { ...selection, baselineAssetId: "fixture-other-baseline" } })).outcome.status).toBe(409);
        expect((await processCommand(run, "confirm", { sceneSelection: selection })).outcome.status).toBe(200);
        expect((await processCommand(run, "confirm", { sceneSelection: selection })).outcome.status).toBe(409);
        for (const version of ["ecommerce-edit.v1", "ecommerce-edit.v2"] as const) {
            const old = await paused(version);
            expect((await processCommand(old.run, "confirm", { sceneSelection: old.selection })).outcome.status).toBe(409);
            expect((await stores.getAgentRun(old.run.id))!.ecommerceSnapshot).toEqual(old.run.ecommerceSnapshot);
        }
        const qa = await paused();
        await stores.updateAgentRunById(qa.run.id, {
            ecommerceSnapshot: {
                ...qa.run.ecommerceSnapshot!,
                qualityCheck: {
                    version: "ecommerce-quality.v2",
                    status: "blocked",
                    publicStatus: "needs_review",
                    modelRole: { logicalRole: "quality_check", capability: "text", logicalModelId: "fixture-text", channelId: "fixture", upstreamModel: "fixture-text", apiFormat: "openai" },
                    checks: [],
                    hardFailures: [],
                    internalReason: "fixture hard failure",
                    checkedAt: Date.now(),
                },
            },
        });
        expect((await processCommand(qa.run, "confirm", { sceneSelection: qa.selection })).outcome.status).toBe(409);
    }, 120_000);

    async function recoverStages(run: AgentRun) {
        const snapshot = structuredClone(run.ecommerceSnapshot);
        const pids: number[] = [];
        const creations = () => fixture.requests.filter((item: { method: string; path: string }) => item.method === "POST" && item.path.endsWith("/images/edits")).length;
        const initialCreations = creations();
        let originalChildId: string | undefined;
        let originalUpstreamId: string | undefined;
        for (const phase of ["created", "polling", "result_ready", "completed"] as const) {
            // Advance the explicitly owned child to its next due recovery turn;
            // production backoff remains intact and no timer/retry is added.
            if (originalChildId) await scheduler.scheduleGenerationTask("image", originalChildId, { nextPollAt: Date.now() });
            await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
            const result = await processCommand(run, "recover");
            pids.push(result.pid);
            const childId = result.run.tasks[0].taskIds?.[0];
            expect(
                childId,
                JSON.stringify({
                    outcome: result.outcome,
                    status: result.run.status,
                    tasks: result.run.tasks.map((task) => ({ id: task.id, status: task.status, attempts: task.attempts, error: task.error })),
                    fallback: result.run.ecommerceSnapshot?.fallback,
                }),
            ).toBeTruthy();
            originalChildId ||= childId;
            expect(childId).toBe(originalChildId);
            expect(result.run.tasks[0]).toMatchObject({ id: run.tasks[0].id, attempts: 1, count: 1, taskIds: [originalChildId], childTasks: [{ id: originalChildId, attempt: 1 }] });
            expect(result.run.tasks[0].ecommerceExecution).toEqual(run.tasks[0].ecommerceExecution);
            const { getStoredGenerationTaskRecord, listStoredGenerationTaskRecordsByRunIds } = await import("./generation-task-store");
            const record = await getStoredGenerationTaskRecord("image", childId!);
            expect(
                record?.executionPhase,
                JSON.stringify({
                    outcome: result.outcome,
                    phase: record?.executionPhase,
                    lastUpstreamStatus: record?.lastUpstreamStatus,
                    nextPollAt: record?.nextPollAt,
                    submittedAt: record?.submittedAt,
                    queryPath: record?.queryPath,
                    fixtureRequests: fixture.requests.map((request: { method: string; path: string }) => ({ method: request.method, path: request.path })),
                }),
            ).toBe(phase);
            // The scheduler parent is the owning Run. The HTTP context and
            // final trace independently retain the Agent task and copy identity.
            expect(record).toMatchObject({ runId: run.id, parentTaskId: run.id, attemptNo: 1, clientRequestId: `${run.clientRequestId}:${run.tasks[0].id}:1:1` });
            expect(imageRequests.filter((request) => request.context.runId === run.id)).toEqual([
                expect.objectContaining({ context: expect.objectContaining({ parentTaskId: run.tasks[0].id, attemptNo: 1, clientRequestId: `${run.clientRequestId}:${run.tasks[0].id}:1:1` }) }),
            ]);
            expect(await listStoredGenerationTaskRecordsByRunIds([run.id], [userId])).toHaveLength(1);
            expect(creations()).toBe(initialCreations + (phase === "created" ? 0 : 1));
            if (phase !== "created") {
                originalUpstreamId ||= record?.upstreamTaskId;
                expect(originalUpstreamId).toBeTruthy();
                expect(record?.upstreamTaskId).toBe(originalUpstreamId);
                expect(record?.submittedAt).toEqual(expect.any(Number));
                expect((await images.getImageTask(childId!))?.upstream).toMatchObject({ id: originalUpstreamId, pollBaseUrl: `${origin}/api/ai/system/fixture/images/edits` });
            }
            expect(result.run.ecommerceSnapshot!.plan).toEqual(snapshot!.plan);
            expect(result.run.ecommerceSnapshot!.continuity).toEqual(snapshot!.continuity);
        }
        expect(new Set(pids).size).toBe(4);
        const completed = (await stores.getAgentRun(run.id))!;
        expect(completed.status).toBe("completed");
        expect(completed.ecommerceSnapshot!.qualityCheck).toMatchObject({ version: ["ecommerce-edit.v4", "ecommerce-edit.v5"].includes(run.ecommerceSnapshot!.plan!.planVersion) ? "ecommerce-quality.v2" : "ecommerce-quality.v1", status: "passed" });
        expect((await images.getImageTask(originalChildId!))!.ecommerceTrace).toMatchObject({ runId: run.id, agentTaskId: run.tasks[0].id, imageTaskIds: [originalChildId] });
        await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
        const unchanged = await processCommand(run, "recover");
        expect(unchanged.run.assetIds).toEqual(completed.assetIds);
        expect(unchanged.run.tasks).toEqual(completed.tasks);
        expect(unchanged.run.ecommerceSnapshot).toEqual(completed.ecommerceSnapshot);
        expect(creations()).toBe(initialCreations + 1);
        return unchanged.run;
    }

    it("recovers confirmed, submitted, result-ready and persisted stages in new Worker processes without a second child or upstream create", async () => {
        const { run, selection } = await paused();
        const confirmation = await processCommand(run, "confirm", { sceneSelection: selection });
        expect(confirmation.outcome).toMatchObject({ status: 200, body: { code: 0 } });
        const completed = await recoverStages(confirmation.run);
        expect(completed.ecommerceSnapshot!.qualityCheck).toMatchObject({ sceneProtectionEvidence: [{ evidence: { compositeOutsideChangedPixels: 0 } }] });
    }, 120_000);

    it("recovers a started v1 plan and compiler in fresh processes without upgrading either immutable snapshot", async () => {
        const { run } = await paused("ecommerce-edit.v1");
        const legacySnapshot = structuredClone(run.ecommerceSnapshot!);
        delete legacySnapshot.fallback;
        const started = (await stores.updateAgentRunById(run.id, { status: "running", tasks: [{ ...run.tasks[0], status: "ready" }], ecommerceSnapshot: legacySnapshot }, undefined, ["paused"]))!;
        expect(started.tasks[0].ecommerceExecution).toMatchObject({ compilerVersion: "ecommerce-openai-image-2.5.v1" });
        const completed = await recoverStages(started);
        expect(completed.ecommerceSnapshot!.plan).toEqual(run.ecommerceSnapshot!.plan);
        expect(completed.ecommerceSnapshot!.plan).not.toHaveProperty("canvas");
        expect(completed.ecommerceSnapshot!.plan).not.toHaveProperty("protection");
        expect(completed.ecommerceSnapshot!.plan).not.toHaveProperty("photography");
        expect(completed.ecommerceSnapshot!.continuity).not.toHaveProperty("sceneRootAssetId");
        expect(completed.ecommerceSnapshot!.qualityCheck!.checks).toHaveLength(8);
        expect(completed.ecommerceSnapshot!.qualityCheck).not.toHaveProperty("observations");
    }, 120_000);

    it("recovers a historical branch with the same root, selected parent and parent QA while preserving the earlier result", async () => {
        const first = await paused();
        const firstConfirmation = await processCommand(first.run, "confirm", { sceneSelection: first.selection });
        expect(firstConfirmation.outcome).toMatchObject({ status: 200, body: { code: 0 } });
        const parent = await recoverStages(firstConfirmation.run);
        const originalParent = structuredClone(parent);
        const originalAsset = await runtime.getCreativeAsset(parent.assetIds[0], userId);
        const branch = await paused("ecommerce-edit.v5", parent);
        const branchConfirmation = await processCommand(branch.run, "confirm", { sceneSelection: branch.selection });
        expect(branchConfirmation.outcome).toMatchObject({ status: 200, body: { code: 0 } });
        const completed = await recoverStages(branchConfirmation.run);
        expect(completed.ecommerceSnapshot!.continuity).toMatchObject({
            sceneRootAssetId: parent.ecommerceSnapshot!.continuity!.sceneRootAssetId,
            parentResultId: parent.assetIds[0],
            parentQualityCheck: parent.ecommerceSnapshot!.qualityCheck,
            branchId: branch.run.ecommerceSnapshot!.plan!.continuity.branchId,
        });
        expect(completed.ecommerceSnapshot!.continuity!.branchId).not.toBe(parent.ecommerceSnapshot!.continuity!.branchId);
        expect(completed.assetIds[0]).not.toBe(parent.assetIds[0]);
        expect(await stores.getAgentRun(parent.id)).toEqual(originalParent);
        expect(await runtime.getCreativeAsset(parent.assetIds[0], userId)).toEqual(originalAsset);
        expect((await runtime.getCreativeAsset(completed.assetIds[0], userId))!.metadata).toMatchObject({
            ecommerceContinuity: { sceneRootAssetId: parent.ecommerceSnapshot!.continuity!.sceneRootAssetId, parentResultId: parent.assetIds[0], branchId: branch.run.ecommerceSnapshot!.continuity!.branchId },
        });
    }, 120_000);
});

function listen(server: Server, port = 0) {
    return new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
}
function serverOrigin(server: Server) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture TCP address missing");
    return `http://127.0.0.1:${address.port}`;
}
function close(server: Server) {
    return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
function createGate(): HttpGate {
    let arrive = () => {};
    let release = () => {};
    const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
    });
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { arrived, wait, arrive, release };
}
