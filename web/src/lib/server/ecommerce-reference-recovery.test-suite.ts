import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import type { AuthSettings } from "@/lib/auth/store";
import type { CreativeMessage, CreativeReferenceRecovery, CreativeRunEvent } from "@/lib/creative-runtime-contract";
import type { StoredGenerationTaskRecord } from "./generation-task-types";
import type { EcommerceReferenceDispatchFence } from "./ecommerce-reference-dispatch";
import { referenceSourceTuple, unsubmittedReferenceCheckpoint } from "./ecommerce-reference-recovery";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

const nextContext = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (nextContext.cookie ? { value: nextContext.cookie } : undefined) }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));

type Stage = { phase: string; pid: number; runId: string; backendPid?: number };
type ProcessResult = {
    pid: number;
    outcome?: { status?: number; body?: { task?: { id: string } } } | null;
    run: AgentRun;
    messages: CreativeMessage[];
    events: CreativeRunEvent[];
    parent: StoredGenerationTaskRecord;
    publicRun: { ecommerceReferenceReview?: unknown; canCheckStatus?: boolean };
};
type Gate = ReturnType<typeof gate>;

// Both providers execute exactly the same business cases. All stores, auth,
// source I/O, upstream TCP transport and schedulers remain real.
export function referenceRecoveryProcessSuite(provider: "file" | "postgres") {
    const enabled = provider === "file" || process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION === "1";
    (enabled ? describe : describe.skip)(`isolated ${provider} reference recovery and independent process boundaries`, () => {
        let directory: string;
        let userId: string;
        let otherUserId: string;
        let cookie: string;
        let otherCookie: string;
        let origin: string;
        let server: Server;
        let closingServer: Promise<void> | undefined;
        let originalSettings: AuthSettings;
        let stores: typeof import("./agent-run-store");
        let runtime: typeof import("./creative-runtime-store");
        let tasks: typeof import("./generation-task-store");
        let scheduler: typeof import("./generation-task-scheduler");
        let database: typeof import("./database");
        let auth: typeof import("@/lib/auth/store");
        let fixture: ReturnType<typeof createProtocolFixtureServer>;
        const fixtureOptions = { failEcommerceAnalysis: false, ecommerceAsyncImage: true, imagePath: "" };
        let sourceUnavailable = false;
        const imageRecoveries: string[] = [];
        const imageQueries: string[] = [];
        let source: Buffer;
        const results = new Map<string, ProcessResult>();
        const gates = new Map<string, Gate>();
        const commands = new Map<ChildProcess, Promise<void>>();
        const handlers = new Set<Promise<void>>();
        const ownedRuns = new Set<string>();
        const handlerErrors: unknown[] = [];
        const imagePosts: string[] = [];

        beforeAll(async () => {
            if (provider === "postgres" && (process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1" || process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || !process.env.DATABASE_URL))
                throw new Error("Explicit isolated PostgreSQL fixture authorization is required");
            directory = await mkdtemp(path.join(tmpdir(), "vozeb-reference-process-"));
            vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
            vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
            vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
            vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
            vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "internal");
            [database, auth, stores, runtime, tasks, scheduler] = await Promise.all([
                import("./database"),
                import("@/lib/auth/store"),
                import("./agent-run-store"),
                import("./creative-runtime-store"),
                import("./generation-task-store"),
                import("./generation-task-scheduler"),
            ]);
            if (provider === "postgres") await database.ensurePostgresSchema();
            originalSettings = await auth.getFreshAuthSettings();
            const { getObjectStorageRuntimeConfig } = await import("./object-storage-config");
            if ((await getObjectStorageRuntimeConfig()).enabled) throw new Error("Isolated fixture requires local media storage");
            userId = `fixture-reference-${randomUUID()}`;
            otherUserId = `fixture-reference-${randomUUID()}`;
            if (provider === "file") {
                const { mutateAuthDb } = await import("@/lib/auth/store-repository");
                await mutateAuthDb((db) => {
                    for (const [index, id] of [userId, otherUserId].entries())
                        db.users.push({
                            id,
                            accountId: `fixture-${index}`,
                            username: `fixture_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
                            displayName: "隔离回归用户",
                            bio: "",
                            role: "user",
                            adminPermissions: [],
                            status: "active",
                            planId: db.settings.entitlements.defaultPlanId || db.settings.entitlements.plans[0].id,
                            pointsBalance: 1000,
                            passwordHash: "fixture-only",
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        });
                });
            } else {
                const repos = database.createPostgresRepositories();
                const settings = await repos.settings.getSettings();
                const planId = settings.settings?.defaultPlanId || settings.plans[0]?.id;
                if (!planId) throw new Error("Fixture entitlement plan missing");
                for (const id of [userId, otherUserId])
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
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
            }
            cookie = await auth.createSession(userId);
            otherCookie = await auth.createSession(otherUserId);
            nextContext.cookie = cookie;
            const object = await sharp({ create: { width: 30, height: 25, channels: 3, background: "#987654" } })
                .png()
                .toBuffer();
            source = await sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } })
                .composite([{ input: object, top: 12, left: 17 }])
                .png()
                .toBuffer();
            const imagePath = path.join(directory, "fixture-result.png");
            await writeFile(imagePath, source);
            // The same options object is intentionally mutable only in this test.
            fixtureOptions.imagePath = imagePath;
            fixture = createProtocolFixtureServer(fixtureOptions);
            await listen(fixture.server);
            const fixtureOrigin = serverOrigin(fixture.server);
            const routes = await Promise.all([
                import("@/app/api/image-tasks/route"),
                import("@/app/api/image-tasks/[id]/route"),
                import("@/app/api/ai/system/[channelId]/[...path]/route"),
                import("@/app/api/reference-assets/[...path]/route"),
                import("@/app/api/generation-log-assets/[...path]/route"),
            ]);
            server = createServer((incoming, outgoing) => {
                const operation = (async () => {
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
                        if (url.pathname.startsWith("/_process-stage/")) {
                            const [, , key, phase] = url.pathname.split("/");
                            const checkpoint = gates.get(`${key}:${phase}`);
                            if (!checkpoint) throw new Error("Unexpected fixture stage");
                            checkpoint.arrive(JSON.parse(bytes.toString("utf8")));
                            await checkpoint.released;
                            outgoing.end("ok");
                            return;
                        }
                        const headers = new Headers();
                        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
                        const request = new Request(url, { method: incoming.method, headers, ...(bytes.length ? { body: bytes } : {}) });
                        const imageId = url.pathname.match(/^\/api\/image-tasks\/(.+)$/)?.[1];
                        const channel = url.pathname.match(/^\/api\/ai\/system\/([^/]+)\/(.+)$/);
                        const reference = url.pathname.match(/^\/api\/reference-assets\/(.+)$/)?.[1];
                        const media = url.pathname.match(/^\/api\/generation-log-assets\/(.+)$/)?.[1];
                        let response: Response;
                        if (incoming.method === "POST" && url.pathname === "/api/image-tasks") {
                            imagePosts.push(JSON.parse(bytes.toString("utf8")).context?.runId);
                            response = await routes[0].POST(request);
                        } else if (imageId) {
                            if (incoming.method === "POST") imageRecoveries.push(imageId);
                            else imageQueries.push(imageId);
                            response = await routes[1][incoming.method === "POST" ? "POST" : "GET"](request, { params: Promise.resolve({ id: imageId }) });
                        } else if (channel) response = await routes[2].POST(request, { params: Promise.resolve({ channelId: channel[1], path: channel[2].split("/") }) });
                        else if (reference) response = sourceUnavailable ? new Response("Fixture source unavailable", { status: 503 }) : await routes[3].GET(request, { params: Promise.resolve({ path: reference.split("/") }) });
                        else if (media) response = await routes[4].GET(request, { params: Promise.resolve({ path: media.split("/") }) });
                        else response = new Response("Fixture route missing", { status: 404 });
                        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                        outgoing.end(Buffer.from(await response.arrayBuffer()));
                    } catch (error) {
                        handlerErrors.push(error);
                        outgoing.writeHead(500);
                        outgoing.end("Fixture handler failed");
                    }
                })();
                handlers.add(operation);
                void operation.finally(() => handlers.delete(operation));
            });
            await listen(server);
            origin = serverOrigin(server);
            vi.stubEnv("VOZEB_PRO_INTERNAL_ORIGIN", origin);
            await auth.setAuthSettings({
                ecommerceGenerationEnabled: true,
                ecommerceVisualQualityCheckEnabled: false,
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
            sourceUnavailable = false;
            if (!server.listening) {
                await closingServer;
                await listen(server);
                closingServer = undefined;
                origin = serverOrigin(server);
                vi.stubEnv("VOZEB_PRO_INTERNAL_ORIGIN", origin);
            }
        }, 120_000);
        afterEach(async () => {
            await stopCommands();
            await drainHandlers();
            await sealAdmission();
            await drainHandlers();
            const images = await import("./image-task-store");
            const records = await tasks.listStoredGenerationTaskRecordsByRunIds([...ownedRuns], [userId]);
            for (const record of records)
                if (record.type === "image" && ["pending", "running", "paused"].includes(record.status)) {
                    const image = await images.getImageTask(record.id);
                    if (image) await images.transitionImageTask(image, ["pending", "running"], { status: "cancelled" }, { executionPhase: "completed", nextPollAt: undefined });
                }
            for (const id of ownedRuns) {
                const run = await stores.getAgentRun(id);
                if (run && ["planning", "running", "paused"].includes(run.status)) await stores.setAgentRunStatus(run, "cancelled");
            }
            await clearAgentReservations();
            ownedRuns.clear();
            if (handlerErrors.length) throw new AggregateError(handlerErrors.splice(0), "Fixture handlers failed");
        }, 120_000);
        afterAll(async () => {
            const failures: unknown[] = [];
            const settle = async (action: () => Promise<unknown>) => {
                try {
                    await action();
                } catch (error) {
                    failures.push(error);
                }
            };
            await settle(stopCommands);
            await settle(drainHandlers);
            if (server) await settle(sealAdmission);
            await settle(drainHandlers);
            await settle(clearAgentReservations);
            if (fixture) await settle(() => close(fixture.server));
            if (provider === "postgres" && auth && originalSettings) await settle(() => auth.setAuthSettings(originalSettings));
            if (provider === "postgres" && database) for (const id of [userId, otherUserId].filter(Boolean)) await settle(() => database.createPostgresRepositories().users.delete(id));
            if (directory) await settle(() => rm(directory, { recursive: true, force: true }));
            vi.unstubAllEnvs();
            if (failures.length) throw new AggregateError(failures, "Isolated reference fixture cleanup failed");
        }, 120_000);

        async function stopCommands() {
            for (const checkpoint of gates.values()) checkpoint.release();
            const pending = [...commands.entries()];
            for (const [child] of pending) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await Promise.all(pending.map(([, settled]) => settled));
        }
        async function drainHandlers() {
            while (handlers.size) await Promise.allSettled([...handlers]);
        }
        async function clearAgentReservations() {
            if (provider !== "postgres" || !database || !userId) return;
            if (commands.size || handlers.size || server?.listening) throw new Error("Owned fixture work must stop before reservation cleanup");
            await database.postgresQuery("DELETE FROM generation_concurrency_reservations WHERE user_id = $1 AND task_type = 'agent'", [userId]);
            const remaining = await database.postgresQuery<{ total: string }>("SELECT count(*) AS total FROM generation_concurrency_reservations WHERE user_id = $1 AND task_type = 'agent'", [userId]);
            expect(Number(remaining.rows[0]?.total)).toBe(0);
        }
        async function sealAdmission() {
            if (!closingServer) {
                closingServer = close(server);
                server.closeAllConnections();
            }
            await closingServer;
        }

        function command(run: AgentRun, action: string, extra: Record<string, unknown> = {}) {
            const key = randomUUID();
            const phases = (extra.gatePhases || []) as string[];
            for (const phase of phases) gates.set(`${key}:${phase}`, gate());
            const input = { command: action, provider, fixtureDirectory: directory, origin, cookie, resultKey: key, runId: run.id, conversationId: run.conversationId, ...extra };
            const child = spawn(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "src/lib/server/ecommerce-process-fixture.test.ts", "--no-file-parallelism", "--reporter=dot"], {
                cwd: process.cwd(),
                env: { ...process.env, VOZEB_PRO_ECOMMERCE_PROCESS_INPUT: JSON.stringify(input) },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout?.on("data", (chunk) => {
                output += chunk;
            });
            child.stderr?.on("data", (chunk) => {
                output += chunk;
            });
            const completed = new Promise<ProcessResult | { crashed: true }>((resolve, reject) => {
                child.on("error", reject);
                child.once("close", (code) => {
                    const result = results.get(key);
                    results.delete(key);
                    if (extra.crashAfterCommit && code !== 0 && !result && gates.get(`${key}:parent_commit_complete`)?.evidence) resolve({ crashed: true });
                    else if (code === 0 && result) resolve(result);
                    else {
                        for (const secret of [cookie, otherCookie, process.env.DATABASE_URL, process.env.VOZEB_PRO_ENCRYPTION_KEY].filter((value): value is string => Boolean(value))) output = output.replaceAll(secret, "[redacted]");
                        reject(new Error(`Independent reference fixture failed (${code}): ${output}`));
                    }
                });
            });
            const exited = completed.then(
                () => undefined,
                () => undefined,
            );
            commands.set(child, exited);
            void exited.finally(() => commands.delete(child));
            void completed.catch(() => {});
            return {
                key,
                completed: completed as Promise<ProcessResult>,
                phase: async (phase: string) =>
                    Promise.race([
                        gates.get(`${key}:${phase}`)!.arrived,
                        completed.then(() => {
                            throw new Error(`Actor exited before ${phase}`);
                        }),
                    ]),
                release: (phase: string) => gates.get(`${key}:${phase}`)!.release(),
            };
        }
        async function seed(retry = false, count = 1) {
            const conversation = await runtime.createCreativeConversation(userId, { surface: "chat" });
            const { writeReferenceImageDataUrl } = await import("./reference-asset-store");
            const assets = [];
            for (const [index, bytes] of (retry
                ? [source]
                : [
                      source,
                      await sharp({ create: { width: 64, height: 48, channels: 3, background: "#456789" } })
                          .png()
                          .toBuffer(),
                  ]
            ).entries()) {
                const stored = await writeReferenceImageDataUrl(`data:image/png;base64,${bytes.toString("base64")}`, { ownerUserId: userId, conversationId: conversation.id, source: "fixture", originalName: `reference-${index}.png` });
                assets.push(
                    (
                        await runtime.registerCreativeAssets([
                            {
                                id: `fixture-reference-${randomUUID()}`,
                                userId,
                                conversationId: conversation.id,
                                ordinal: index,
                                type: "image",
                                title: `reference-${index}.png`,
                                sourceRunId: "upload",
                                serverUrl: `/api/reference-assets/${stored.token}`,
                                width: 64,
                                height: 48,
                                metadata: {},
                            },
                        ])
                    )[0],
                );
            }
            const run = (
                await stores.createAgentRun(userId, {
                    clientRequestId: randomUUID(),
                    conversationId: conversation.id,
                    surface: "chat",
                    prompt: retry ? "把图片1放进客厅场景" : "图片1和图片2",
                    assetIds: assets.map((asset) => asset.id),
                    skillIds: [],
                    modelIds: [],
                    preferences: { mode: "image", ...(count > 1 ? { image: { count } } : {}) },
                })
            ).run;
            ownedRuns.add(run.id);
            fixtureOptions.failEcommerceAnalysis = retry;
            const executed = await command(run, "execute").completed;
            fixtureOptions.failEcommerceAnalysis = false;
            expect(executed.run.status).toBe("paused");
            expect(executed.run.ecommerceSnapshot?.referenceCheckpoint?.version).toBe("ecommerce-reference-checkpoint.v1");
            let reviewDiagnostic: string | undefined;
            if (!executed.publicRun.ecommerceReferenceReview) {
                const checkpoint = executed.run.ecommerceSnapshot!.referenceCheckpoint!;
                const owned = await runtime.getCreativeAssetsByIds(
                    checkpoint.assets.map((item) => item.asset.id),
                    userId,
                );
                reviewDiagnostic = JSON.stringify({
                    unsubmitted: unsubmittedReferenceCheckpoint(executed.run),
                    surface: executed.run.surface,
                    status: executed.run.status,
                    cancellation: Boolean(executed.run.cancellation),
                    mode: executed.run.ecommerceSnapshot?.mode,
                    qualityCheck: Boolean(executed.run.ecommerceSnapshot?.qualityCheck),
                    outputAssets: executed.run.assetIds?.length || 0,
                    fallback: executed.run.ecommerceSnapshot?.fallback?.reason,
                    tasks: executed.run.tasks.map((task) => ({
                        status: task.status,
                        attempts: task.attempts,
                        taskId: Boolean(task.taskId),
                        taskIds: task.taskIds?.length || 0,
                        childTasks: task.childTasks?.length || 0,
                        sceneProtection: Boolean(task.sceneProtection),
                    })),
                    checkpoint: { state: checkpoint.state, analysisStage: checkpoint.analysisStage.state, analysisVersion: checkpoint.analysis?.analysisVersion, issueCodes: checkpoint.decision?.issues.map((issue) => issue.code) },
                    sources: checkpoint.assets.map((item) => {
                        const current = owned.find((asset) => asset.id === item.asset.id);
                        return {
                            alias: item.alias,
                            found: Boolean(current),
                            owner: current?.userId === userId,
                            conversation: current?.conversationId === executed.run.conversationId,
                            type: current?.type,
                            status: current?.status,
                            tupleMatches: Boolean(current && referenceSourceTuple(current).every((value, index) => value === referenceSourceTuple(item.asset)[index])),
                            ownedPath: /^\/api\/(reference-assets|generation-log-assets)\//.test(item.asset.serverUrl || ""),
                        };
                    }),
                });
            }
            expect(executed.publicRun.ecommerceReferenceReview, reviewDiagnostic).toMatchObject({ kind: retry ? "retry_analysis" : "confirm_purposes" });
            return executed.run;
        }
        function recovery(run: AgentRun): CreativeReferenceRecovery {
            const checkpoint = run.ecommerceSnapshot!.referenceCheckpoint!;
            if (checkpoint.sourceReadFailure && checkpoint.analysisStage.state === "completed") return { reviewId: checkpoint.reviewId, action: "retry_source" };
            return checkpoint.analysis
                ? {
                      reviewId: checkpoint.reviewId,
                      action: "confirm_purposes",
                      decisionVersion: "ecommerce-reference-decision.v1",
                      bindings: checkpoint.assets.filter((asset) => asset.alias).map((asset, index) => ({ assetId: asset.asset.id, assetVersion: asset.assetVersion, purposes: index ? ["lighting"] : ["edit_target", "product_identity"] })),
                  }
                : { reviewId: checkpoint.reviewId, action: "retry_analysis" };
        }
        function body(run: AgentRun) {
            const checkpoint = run.ecommerceSnapshot!.referenceCheckpoint!;
            const task = run.tasks[0];
            return {
                config: { apiSource: "system", baseUrl: "/api/ai/system/fixture", apiKey: "", apiFormat: "openai", model: "fixture-image" },
                prompt: "fixture reference dispatch",
                source: "agent",
                kind: "generation",
                context: {
                    runId: run.id,
                    conversationId: run.conversationId,
                    surface: "chat",
                    parentTaskId: task.id,
                    attemptNo: task.attempts,
                    clientRequestId: `${run.clientRequestId}:${task.id}:${task.attempts}:1`,
                    referenceDispatch: { executionId: run.executionId, inputId: checkpoint.inputId, decisionId: checkpoint.decisionId, analysisRequestId: checkpoint.analysisStage.requestId, copy: 1 },
                },
            };
        }
        async function runnable(run: AgentRun) {
            const task: AgentRunTask = { ...run.tasks[0], type: "image", status: "running", attempts: 1, count: 1 };
            return (await stores.updateAgentRunById(run.id, {
                status: "running",
                executionId: "fixture-old-execution",
                tasks: [task],
                ecommerceSnapshot: { ...run.ecommerceSnapshot!, referenceCheckpoint: { ...run.ecommerceSnapshot!.referenceCheckpoint!, state: "resolved" } },
            }))!;
        }
        async function durableChildren(run: AgentRun) {
            if (provider === "postgres") return (await database.postgresQuery<{ id: string }>("SELECT id FROM generation_tasks WHERE run_id = $1 AND user_id = $2 AND task_type <> 'agent'", [run.id, userId])).rows;
            const { readJsonDataFile } = await import("./data-adapter");
            return (await readJsonDataFile<StoredGenerationTaskRecord[]>("generation-tasks.json", [])).filter((task) => task.type !== "agent" && task.runId === run.id && task.userId === userId);
        }
        function visionPosts() {
            return fixture.requests.filter((request: { method: string; body: Buffer }) => request.method === "POST" && request.body.toString("utf8").includes('"analyze_ecommerce_references"')).length;
        }
        function upstreamCreates() {
            return fixture.requests.filter((request: { method: string; path: string }) => request.method === "POST" && /\/images\/(?:generations|edits)$/.test(request.path)).length;
        }

        async function recoverStages(created: ProcessResult) {
            const run = created.run;
            const frozen = structuredClone(run.ecommerceSnapshot!.referenceCheckpoint!);
            const snapshot = structuredClone(run.ecommerceSnapshot!);
            const childId = run.tasks[0].taskIds?.[0];
            expect(childId).toBeTruthy();
            const visionCount = visionPosts();
            const creations = upstreamCreates();
            let upstreamId: string | undefined;
            let result = created;
            const pids = new Set([created.pid]);
            for (const phase of ["created", "polling", "result_ready", "completed"] as const) {
                if (phase !== "created") {
                    // Drive each explicitly owned next-due stage. The fixture's
                    // after() is a no-op; production scheduling stays intact.
                    await scheduler.scheduleGenerationTask("image", childId!, { nextPollAt: Date.now() });
                    await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
                    result = await command(run, "recover").completed;
                    pids.add(result.pid);
                }
                const record = await tasks.getStoredGenerationTaskRecord("image", childId!);
                expect(record?.executionPhase).toBe(phase);
                expect(record).toMatchObject({ runId: run.id, parentTaskId: run.id, attemptNo: 1, clientRequestId: `${run.clientRequestId}:${run.tasks[0].id}:1:1` });
                expect(result.run.tasks[0]).toMatchObject({ id: run.tasks[0].id, attempts: 1, count: 1, taskIds: [childId], childTasks: [{ id: childId, attempt: 1 }] });
                expect(result.run.tasks[0].ecommerceExecution).toEqual(run.tasks[0].ecommerceExecution);
                expect(await durableChildren(run)).toHaveLength(1);
                expect(imagePosts.filter((id) => id === run.id)).toHaveLength(1);
                expect(upstreamCreates()).toBe(creations + (phase === "created" ? 0 : 1));
                expect(visionPosts()).toBe(visionCount);
                if (phase !== "created") {
                    upstreamId ||= record?.upstreamTaskId;
                    expect(upstreamId).toBeTruthy();
                    expect(record?.upstreamTaskId).toBe(upstreamId);
                    expect(record?.submittedAt).toEqual(expect.any(Number));
                }
                expect(result.run.ecommerceSnapshot!.referenceCheckpoint).toEqual(frozen);
                expect(result.run.ecommerceSnapshot!.plan).toEqual(snapshot.plan);
                expect(result.run.ecommerceSnapshot!.continuity).toEqual(snapshot.continuity);
                expect(result.publicRun.ecommerceReferenceReview).toBeNull();
            }
            expect(pids.size).toBe(4);
            expect(result.run.status).toBe("completed");
            expect(result.run.ecommerceSnapshot).toMatchObject({ qualityPolicy: "disabled", technicalCheck: { status: "passed" } });
            expect(result.run.ecommerceSnapshot?.qualityCheck).toBeUndefined();
            const { getImageTask } = await import("./image-task-store");
            expect((await getImageTask(childId!))?.ecommerceTrace).toMatchObject({ runId: run.id, agentTaskId: run.tasks[0].id, imageTaskIds: [childId] });
            return result;
        }

        it("consumes one review once across two real confirmation PIDs and rejects ABA, owner and version drift", async () => {
            const run = await seed();
            const selection = recovery(run);
            const before = await command(run, "read").completed;
            const count = visionPosts();
            const first = command(run, "confirm", { referenceRecovery: selection, gatePhases: ["preflight_complete"] });
            const second = command(run, "confirm", { referenceRecovery: selection, gatePhases: ["preflight_complete"] });
            const [a, b] = await Promise.all([first.phase("preflight_complete"), second.phase("preflight_complete")]);
            expect(a.pid).not.toBe(b.pid);
            first.release("preflight_complete");
            second.release("preflight_complete");
            expect((await Promise.all([first.completed, second.completed])).map((result) => result.outcome!.status).sort()).toEqual([200, 409]);
            const after = await command(run, "read").completed;
            expect(after.run).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId });
            expect(after.messages.map((message) => message.id)).toEqual(before.messages.map((message) => message.id));
            expect(after.events.filter((event) => event.type === "run.reference.recovered")).toHaveLength(1);
            expect(visionPosts()).toBe(count);
            expect(await durableChildren(run)).toHaveLength(0);
            expect(imagePosts.filter((id) => id === run.id)).toHaveLength(0);
            const aba = await stores.updateAgentRunById(run.id, { status: "paused", tasks: run.tasks, ecommerceSnapshot: { ...run.ecommerceSnapshot!, referenceCheckpoint: { ...run.ecommerceSnapshot!.referenceCheckpoint!, reviewId: randomUUID() } } });
            expect((await command(aba!, "confirm", { referenceRecovery: selection }).completed).outcome!.status).toBe(409);
            expect((await command(aba!, "confirm", { referenceRecovery: recovery(aba!), cookie: otherCookie }).completed).outcome!.status).toBe(404);
            const invalid = recovery(aba!) as Extract<CreativeReferenceRecovery, { action: "confirm_purposes" }>;
            invalid.bindings[0].assetVersion = "stale-source-version";
            expect((await command(aba!, "confirm", { referenceRecovery: invalid }).completed).outcome!.status).toBe(409);
        }, 120_000);

        it.each([false, true])(
            "rejects a durable child without a parent JSON link including expired=%s",
            async (expired) => {
                const run = await seed();
                const running = await runnable(run);
                const created = await command(running, "create_image", { imageBody: body(running) }).completed;
                expect(created.outcome!.status).toBe(200);
                const childId = created.outcome!.body!.task!.id;
                const frozen = (await stores.updateAgentRunById(run.id, { status: "paused", executionId: undefined, tasks: run.tasks, ecommerceSnapshot: run.ecommerceSnapshot }))!;
                expect(frozen.tasks.every((task) => !task.taskId && !task.taskIds?.length && !task.childTasks?.length && !task.attempts)).toBe(true);
                if (expired) {
                    if (provider === "postgres") await database.postgresQuery("UPDATE generation_tasks SET expires_at = $2 WHERE id = $1", [childId, new Date(1)]);
                    else await tasks.withGenerationTaskFileMutation(async (records) => ({ tasks: records.map((record) => (record.id === childId ? { ...record, expiresAt: 1 } : record)), result: undefined }));
                }
                expect((await command(frozen, "confirm", { referenceRecovery: recovery(frozen) }).completed).outcome!.status).toBe(409);
                expect((await durableChildren(run)).map((task) => task.id)).toEqual([childId]);
                const replay = await command(running, "create_image", { imageBody: body(running) }).completed;
                expect(replay.outcome!.body!.task!.id).toBe(childId);
                expect(await durableChildren(run)).toHaveLength(1);
            },
            120_000,
        );

        it("confirmation holding the real parent lock fences a late old image request", async () => {
            const run = await seed();
            const old = await runnable(run);
            const imageBody = body(old);
            await stores.updateAgentRunById(run.id, { status: "paused", executionId: undefined, tasks: run.tasks, ecommerceSnapshot: run.ecommerceSnapshot });
            const confirming = command(run, "confirm", { referenceRecovery: recovery(run), gatePhases: ["parent_lock_acquired"] });
            const winner = await confirming.phase("parent_lock_acquired");
            const creating = command(old, "create_image", { imageBody, gatePhases: ["parent_lock_attempt", "parent_lock_acquired"] });
            const waiting = await creating.phase("parent_lock_attempt");
            expect(waiting.pid).not.toBe(winner.pid);
            creating.release("parent_lock_attempt");
            if (provider === "postgres") expect((await database.postgresQuery<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [waiting.backendPid])).rows[0].blockers).toContain(winner.backendPid);
            else expect(await readFile(path.join(directory, "generation-tasks.json.lock"), "utf8")).toBe("");
            confirming.release("parent_lock_acquired");
            expect((await confirming.completed).outcome!.status).toBe(200);
            await creating.phase("parent_lock_acquired");
            creating.release("parent_lock_acquired");
            expect((await creating.completed).outcome!.status).toBe(409);
            expect(await durableChildren(run)).toHaveLength(0);
        }, 120_000);

        it("a child holding the real parent lock blocks the old preflight recovery then preserves its identity", async () => {
            const run = await seed();
            const confirming = command(run, "confirm", { referenceRecovery: recovery(run), gatePhases: ["preflight_complete", "parent_lock_attempt", "parent_lock_acquired"] });
            await confirming.phase("preflight_complete");
            const old = await runnable(run);
            const creating = command(old, "create_image", { imageBody: body(old), gatePhases: ["parent_lock_acquired"] });
            const winner = await creating.phase("parent_lock_acquired");
            confirming.release("preflight_complete");
            const waiting = await confirming.phase("parent_lock_attempt");
            expect(waiting.pid).not.toBe(winner.pid);
            confirming.release("parent_lock_attempt");
            if (provider === "postgres") expect((await database.postgresQuery<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [waiting.backendPid])).rows[0].blockers).toContain(winner.backendPid);
            else expect(await readFile(path.join(directory, "generation-tasks.json.lock"), "utf8")).toBe("");
            creating.release("parent_lock_acquired");
            const created = await creating.completed;
            expect(created.outcome!.status).toBe(200);
            await confirming.phase("parent_lock_acquired");
            confirming.release("parent_lock_acquired");
            expect((await confirming.completed).outcome!.status).toBe(409);
            expect((await durableChildren(run)).map((task) => task.id)).toEqual([created.outcome!.body!.task!.id]);
        }, 120_000);

        if (provider === "file")
            it("G0 restores the runtime preimage after a real rename throws before the parent write", async () => {
                const run = await seed();
                const before = await command(run, "read").completed;
                const fault = command(run, "confirm", { referenceRecovery: recovery(run), failRuntimeWrite: true, gatePhases: ["runtime_write_complete_before_parent_write"] });
                const receipt = await fault.phase("runtime_write_complete_before_parent_write");
                expect(receipt.pid).not.toBe(before.pid);
                fault.release("runtime_write_complete_before_parent_write");
                expect((await fault.completed).outcome!.status).toBe(409);
                const restored = await command(run, "read").completed;
                expect(restored.run).toEqual(before.run);
                expect(restored.messages).toEqual(before.messages);
                expect(restored.events).toEqual(before.events);
                expect(restored.publicRun).toEqual(before.publicRun);
                expect(restored.parent).toEqual(before.parent);
                expect((await command(run, "confirm", { referenceRecovery: recovery(run) }).completed).outcome!.status).toBe(200);
                expect((await command(run, "confirm", { referenceRecovery: recovery(run) }).completed).outcome!.status).toBe(409);
            }, 120_000);

        it.each([false, true])(
            "G1 survives post-commit actor exit and rejects the old lease release afterClaim=%s",
            async (afterClaim) => {
                const run = await seed();
                await stores.updateAgentRunById(run.id, { status: "planning" });
                await scheduler.scheduleGenerationTask("agent", run.id, { executionPhase: "created", nextPollAt: Date.now() });
                expect(await scheduler.claimDueGenerationTasks({ workerId: "fixture-old-owner", taskIds: [run.id], limit: 1 })).toHaveLength(1);
                await stores.updateAgentRunById(run.id, { status: "paused" });
                const count = visionPosts();
                const creates = upstreamCreates();
                const confirming = command(run, "confirm", { referenceRecovery: recovery(run), crashAfterCommit: true, gatePhases: ["parent_commit_complete"] });
                await confirming.phase("parent_commit_complete");
                confirming.release("parent_commit_complete");
                expect(await confirming.completed).toEqual({ crashed: true });
                const saved = await command(run, "read").completed;
                expect(saved.run.ecommerceSnapshot!.referenceCheckpoint).toMatchObject({ state: "consumed", consumption: { action: "confirm_purposes" } });
                expect(saved.parent).toMatchObject({ executionPhase: "created", nextPollAt: expect.any(Number), lastUpstreamStatus: "created" });
                expect(saved.parent.workerId).toBeUndefined();
                expect(saved.parent.leaseUntil).toBeUndefined();
                const freshWorker = afterClaim ? command(run, "recover", { gatePhases: ["worker_claimed"] }) : undefined;
                if (freshWorker) await freshWorker.phase("worker_claimed");
                const leased = await tasks.getStoredGenerationTaskRecord("agent", run.id);
                expect((await command(run, "late_release", { workerId: "fixture-old-owner" }).completed).outcome).toBeNull();
                expect(await tasks.getStoredGenerationTaskRecord("agent", run.id)).toEqual(leased);
                freshWorker?.release("worker_claimed");
                const created = await (freshWorker || command(run, "recover")).completed;
                expect(created.run.ecommerceSnapshot!.referenceCheckpoint!.assets).toEqual(saved.run.ecommerceSnapshot!.referenceCheckpoint!.assets);
                expect(created.run.ecommerceSnapshot!.referenceCheckpoint!.planningInput).toEqual(saved.run.ecommerceSnapshot!.referenceCheckpoint!.planningInput);
                expect(created.run.ecommerceSnapshot!.referenceCheckpoint!.analysisStage.requestId).toBe(saved.run.ecommerceSnapshot!.referenceCheckpoint!.analysisStage.requestId);
                const worker = await recoverStages(created);
                expect(worker.run.status).toBe("completed");
                expect(worker.run.ecommerceSnapshot).toMatchObject({ qualityPolicy: "disabled", technicalCheck: { status: "passed" } });
                expect(worker.run.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                expect(worker.run.ecommerceSnapshot?.visualAnalysis?.analysisVersion).toBe("ecommerce-visual-analysis.v4");
                expect(worker.run.ecommerceSnapshot?.plan?.planVersion).toBe("ecommerce-edit.v6");
                expect(worker.run.ecommerceSnapshot?.referenceCheckpoint?.inputId).toBe(run.ecommerceSnapshot!.referenceCheckpoint!.inputId);
                expect(worker.publicRun.ecommerceReferenceReview).toBeNull();
                expect(visionPosts()).toBe(count);
                expect(upstreamCreates()).toBe(creates + 1);
                expect(await durableChildren(run)).toHaveLength(1);
                if (provider === "postgres") {
                    const reservations = await database.postgresQuery<{ total: string; unexpired: string }>(
                        "SELECT count(*) AS total, count(*) FILTER (WHERE expires_at > now()) AS unexpired FROM generation_concurrency_reservations WHERE user_id = $1 AND task_type = 'agent'",
                        [userId],
                    );
                    expect(Number(reservations.rows[0]?.total)).toBe(1);
                    expect(Number(reservations.rows[0]?.unexpired)).toBe(1);
                }
            },
            120_000,
        );

        it("retries the persisted analysis stage on frozen input in a fresh worker without creating a second round", async () => {
            const run = await seed(true);
            const original = run.ecommerceSnapshot!.referenceCheckpoint!;
            const before = await command(run, "read").completed;
            const visionCount = visionPosts();
            const confirmed = await command(run, "confirm", { referenceRecovery: recovery(run) }).completed;
            expect(confirmed.outcome!.status).toBe(200);
            const next = confirmed.run.ecommerceSnapshot!.referenceCheckpoint!;
            expect(next.analysisStage.requestId).not.toBe(original.analysisStage.requestId);
            expect(next.planningInput).toEqual(original.planningInput);
            expect(next.history).toHaveLength(1);
            const created = await command(run, "recover").completed;
            expect(created.run.ecommerceSnapshot!.referenceCheckpoint!.assets).toEqual(next.assets);
            expect(visionPosts()).toBe(visionCount + 1);
            const worker = await recoverStages(created);
            expect(worker.run.status).toBe("completed");
            expect(worker.run.ecommerceSnapshot).toMatchObject({ qualityPolicy: "disabled", technicalCheck: { status: "passed" } });
            expect(worker.run.ecommerceSnapshot?.qualityCheck).toBeUndefined();
            expect(worker.run.ecommerceSnapshot?.visualAnalysis?.analysisVersion).toBe("ecommerce-visual-analysis.v4");
            expect(worker.run.ecommerceSnapshot?.plan?.planVersion).toBe("ecommerce-edit.v6");
            expect(worker.messages.map((message) => message.id)).toEqual(before.messages.map((message) => message.id));
            expect(worker.run.ecommerceSnapshot!.referenceCheckpoint!.analysisStage.requestId).toBe(next.analysisStage.requestId);
            expect(await durableChildren(run)).toHaveLength(1);
        }, 120_000);

        it("recovers source 503 on the same Run while reusing completed analysis and the frozen source in fresh processes", async () => {
            const run = await seed();
            const confirmed = await command(run, "confirm", { referenceRecovery: recovery(run) }).completed;
            expect(confirmed.outcome!.status).toBe(200);
            const original = structuredClone(confirmed.run.ecommerceSnapshot!.referenceCheckpoint!);
            const visionCount = visionPosts();
            const creates = upstreamCreates();
            sourceUnavailable = true;
            const unavailable = await command(run, "recover").completed;
            expect(unavailable.run.status).toBe("paused");
            expect(unavailable.run.ecommerceSnapshot?.fallback?.reason).toBe("reference_source_unavailable");
            const paused = unavailable.run.ecommerceSnapshot!.referenceCheckpoint!;
            expect(paused.analysisStage).toEqual(original.analysisStage);
            expect(paused.analysis).toEqual(original.analysis);
            expect(paused.route).toEqual(original.route);
            expect(paused.assets).toEqual(original.assets);
            expect(paused.inputId).toBe(original.inputId);
            expect(paused.decisionId).toBe(original.decisionId);
            expect(paused.sourceReadFailure).toMatchObject({ kind: "source_read", status: 503 });
            expect(unavailable.publicRun.ecommerceReferenceReview).toMatchObject({ kind: "retry_source" });
            expect(unavailable.publicRun.canCheckStatus).toBe(false);
            expect(visionPosts()).toBe(visionCount);
            expect(upstreamCreates()).toBe(creates);
            expect(await durableChildren(run)).toHaveLength(0);
            sourceUnavailable = false;
            const resumed = await command(run, "confirm", { referenceRecovery: recovery(unavailable.run) }).completed;
            expect(resumed.outcome!.status).toBe(200);
            expect(resumed.run.ecommerceSnapshot!.referenceCheckpoint!.analysisStage).toEqual(original.analysisStage);
            const created = await command(run, "recover").completed;
            const completed = await recoverStages(created);
            expect(completed.messages.map((message) => message.id)).toEqual(confirmed.messages.map((message) => message.id));
            expect(completed.run.ecommerceSnapshot!.referenceCheckpoint!.analysisStage).toEqual(original.analysisStage);
            expect(completed.run.ecommerceSnapshot!.referenceCheckpoint!.sourceReadFailure).toBeUndefined();
            expect(completed.run.ecommerceSnapshot!.referenceCheckpoint!.sourceReadHistory).toHaveLength(1);
            expect(visionPosts()).toBe(visionCount);
            expect(upstreamCreates()).toBe(creates + 1);
        }, 120_000);

        it.each(["created", "polling", "completed"] as const)(
            "resumes the same two-copy Run with a source-read pause and an original %s sibling",
            async (siblingPhase) => {
                const run = await seed(false, 2);
                expect((await command(run, "confirm", { referenceRecovery: recovery(run) }).completed).outcome!.status).toBe(200);
                const created = await command(run, "recover").completed;
                const ids = created.run.tasks[0].taskIds!;
                expect(ids).toHaveLength(2);
                const [sourceId, siblingId] = ids;
                const checkpoint = structuredClone(created.run.ecommerceSnapshot!.referenceCheckpoint!);
                const originalChildren = new Map(
                    await Promise.all(
                        ids.map(async (id) => {
                            const record = (await tasks.getStoredGenerationTaskRecord("image", id))!;
                            const dispatch = record.payload.referenceDispatch as EcommerceReferenceDispatchFence;
                            expect(dispatch).toEqual({ executionId: created.run.executionId, inputId: checkpoint.inputId, decisionId: checkpoint.decisionId, analysisRequestId: checkpoint.analysisStage.requestId, copy: expect.any(Number) });
                            expect(record).toMatchObject({ id, runId: run.id, parentTaskId: run.id, attemptNo: 1, clientRequestId: `${run.clientRequestId}:${created.run.tasks[0].id}:1:${dispatch.copy}` });
                            return [id, record] as const;
                        }),
                    ),
                );
                expect([...originalChildren.values()].map((record) => (record.payload.referenceDispatch as EcommerceReferenceDispatchFence).copy).sort()).toEqual([1, 2]);
                const assertSubmittedIdentity = (record: StoredGenerationTaskRecord, submission: StoredGenerationTaskRecord) => {
                    const original = originalChildren.get(record.id)!;
                    expect(record).toMatchObject({
                        id: original.id,
                        runId: original.runId,
                        parentTaskId: original.parentTaskId,
                        attemptNo: original.attemptNo,
                        clientRequestId: original.clientRequestId,
                        upstreamTaskId: submission.upstreamTaskId,
                        submittedAt: submission.submittedAt,
                    });
                    expect(record.payload.referenceDispatch).toEqual(original.payload.referenceDispatch);
                    expect(record.payload.attempts).toHaveLength(1);
                    expect(record.payload.attempts).toMatchObject([{ attemptNo: 1 }]);
                };
                const visionCount = visionPosts();
                const creates = upstreamCreates();
                sourceUnavailable = true;
                await command(run, "recover", { taskIds: [sourceId] }).completed;
                const unavailable = (await tasks.getStoredGenerationTaskRecord("image", sourceId))!;
                expect(unavailable).toMatchObject({ executionPhase: "needs_review", lastUpstreamStatus: expect.stringMatching(/^reference_source_unavailable/) });
                expect(unavailable.payload.attempts || []).toEqual([]);
                expect(unavailable.submittedAt).toBeUndefined();
                expect(unavailable.upstreamTaskId).toBeUndefined();
                expect(unavailable.payload.billing).toBeUndefined();
                expect(upstreamCreates()).toBe(creates);
                sourceUnavailable = false;
                if (siblingPhase !== "created") await command(run, "recover", { taskIds: [siblingId] }).completed;
                const sibling = (await tasks.getStoredGenerationTaskRecord("image", siblingId))!;
                if (siblingPhase === "created") {
                    expect(sibling.executionPhase).toBe("created");
                    expect(sibling.payload.attempts || []).toEqual([]);
                    expect(sibling.upstreamTaskId).toBeUndefined();
                    expect(sibling.submittedAt).toBeUndefined();
                } else expect(sibling).toMatchObject({ executionPhase: "polling", upstreamTaskId: expect.any(String), submittedAt: expect.any(Number) });
                const paused = await command(run, "execute").completed;
                expect(paused.run).toMatchObject({ status: "paused", tasks: [{ count: 2, attempts: 1, childTasks: ids.map((id) => ({ id, attempt: 1, status: "needs_review" })) }] });
                expect(paused.publicRun).toMatchObject({ ecommerceReferenceReview: null, canCheckStatus: true });
                if (siblingPhase === "completed") {
                    for (const phase of ["result_ready", "completed"] as const) {
                        await scheduler.scheduleGenerationTask("image", siblingId, { nextPollAt: Date.now() });
                        await command(run, "recover", { taskIds: [siblingId] }).completed;
                        const record = (await tasks.getStoredGenerationTaskRecord("image", siblingId))!;
                        expect(record.executionPhase).toBe(phase);
                        assertSubmittedIdentity(record, sibling);
                    }
                    expect((await command(run, "read").completed).publicRun.canCheckStatus).toBe(true);
                }
                const recoveryCount = imageRecoveries.length;
                const queryCount = imageQueries.length;
                const resumed = await command(run, "confirm").completed;
                expect(resumed.outcome!.status).toBe(200);
                if (siblingPhase !== "completed") await scheduler.scheduleGenerationTask("image", siblingId, { nextPollAt: Date.now() });
                await command(run, "recover").completed;
                expect(imageRecoveries.slice(recoveryCount)).toEqual([sourceId]);
                expect(imageQueries.slice(queryCount)).toContain(siblingId);
                const submitted = (await tasks.getStoredGenerationTaskRecord("image", sourceId))!;
                expect(submitted).toMatchObject({ executionPhase: "polling", upstreamTaskId: expect.any(String), submittedAt: expect.any(Number) });
                const resumedSibling = (await tasks.getStoredGenerationTaskRecord("image", siblingId))!;
                expect(resumedSibling).toMatchObject({ executionPhase: siblingPhase === "created" ? "polling" : siblingPhase === "polling" ? "result_ready" : "completed", upstreamTaskId: expect.any(String), submittedAt: expect.any(Number) });
                if (siblingPhase !== "created") assertSubmittedIdentity(resumedSibling, sibling);
                expect(submitted.upstreamTaskId).not.toBe(resumedSibling.upstreamTaskId);
                for (const submission of [submitted, resumedSibling]) {
                    assertSubmittedIdentity(submission, submission);
                    const phases = submission.id === sourceId || siblingPhase === "created" ? (["result_ready", "completed"] as const) : siblingPhase === "polling" ? (["completed"] as const) : [];
                    for (const phase of phases) {
                        await scheduler.scheduleGenerationTask("image", submission.id, { nextPollAt: Date.now() });
                        await command(run, "recover", { taskIds: [submission.id] }).completed;
                        const record = (await tasks.getStoredGenerationTaskRecord("image", submission.id))!;
                        expect(record.executionPhase).toBe(phase);
                        assertSubmittedIdentity(record, submission);
                    }
                }
                await scheduler.scheduleGenerationTask("agent", run.id, { nextPollAt: Date.now() });
                const completed = await command(run, "recover").completed;
                expect(completed.run).toMatchObject({
                    id: run.id,
                    conversationId: run.conversationId,
                    inputMessageId: run.inputMessageId,
                    assistantMessageId: run.assistantMessageId,
                    status: "completed",
                    tasks: [{ id: created.run.tasks[0].id, count: 2, attempts: 1, taskIds: ids, childTasks: ids.map((id) => ({ id, attempt: 1, status: "completed" })) }],
                });
                expect(completed.run.ecommerceSnapshot!.referenceCheckpoint).toEqual(checkpoint);
                expect(completed.run.ecommerceSnapshot).toMatchObject({ qualityPolicy: "disabled", technicalCheck: { status: "passed" } });
                expect(completed.run.ecommerceSnapshot?.qualityCheck).toBeUndefined();
                expect(completed.messages.map((message) => message.id)).toEqual(created.messages.map((message) => message.id));
                expect(imagePosts.filter((id) => id === run.id)).toHaveLength(2);
                expect(upstreamCreates()).toBe(creates + 2);
                expect(visionPosts()).toBe(visionCount);
                expect((await durableChildren(run)).map((record) => record.id).sort()).toEqual([...ids].sort());
                assertSubmittedIdentity((await tasks.getStoredGenerationTaskRecord("image", sourceId))!, submitted);
                assertSubmittedIdentity((await tasks.getStoredGenerationTaskRecord("image", siblingId))!, resumedSibling);
            },
            120_000,
        );

        it("checks the original unsubmitted child after source 503 through ordinary Run resume and submits it once", async () => {
            const run = await seed();
            expect((await command(run, "confirm", { referenceRecovery: recovery(run) }).completed).outcome!.status).toBe(200);
            const created = await command(run, "recover").completed;
            const childId = created.run.tasks[0].taskIds![0];
            const checkpoint = structuredClone(created.run.ecommerceSnapshot!.referenceCheckpoint!);
            const visionCount = visionPosts();
            const creates = upstreamCreates();
            const recoveryCount = imageRecoveries.length;
            expect((await tasks.getStoredGenerationTaskRecord("image", childId))?.executionPhase).toBe("created");
            sourceUnavailable = true;
            await scheduler.scheduleGenerationTask("agent", run.id, { nextPollAt: Date.now() });
            const paused = await command(run, "recover").completed;
            expect(paused.run.status).toBe("paused");
            expect(paused.publicRun).toMatchObject({ ecommerceReferenceReview: null, canCheckStatus: true });
            const unsubmitted = (await tasks.getStoredGenerationTaskRecord("image", childId))!;
            expect(unsubmitted).toMatchObject({ executionPhase: "needs_review", lastUpstreamStatus: expect.stringMatching(/^reference_source_unavailable/) });
            expect(unsubmitted.submittedAt).toBeUndefined();
            expect(unsubmitted.upstreamTaskId).toBeUndefined();
            expect(unsubmitted.payload.attempts || []).toEqual([]);
            expect(unsubmitted.payload.billing).toBeUndefined();
            expect(unsubmitted.payload.result).toBeUndefined();
            expect(upstreamCreates()).toBe(creates);
            sourceUnavailable = false;
            const resumed = await command(run, "confirm").completed;
            expect(resumed.outcome!.status).toBe(200);
            const polling = await command(run, "recover").completed;
            const submitted = (await tasks.getStoredGenerationTaskRecord("image", childId))!;
            expect(submitted.executionPhase).toBe("polling");
            expect(submitted.upstreamTaskId).toBeTruthy();
            expect(imageRecoveries.slice(recoveryCount)).toEqual([childId]);
            const pids = new Set([created.pid, polling.pid]);
            for (const phase of ["result_ready", "completed"] as const) {
                await scheduler.scheduleGenerationTask("image", childId, { nextPollAt: Date.now() });
                pids.add((await command(run, "recover", { taskIds: [childId] }).completed).pid);
                const record = (await tasks.getStoredGenerationTaskRecord("image", childId))!;
                expect(record.executionPhase).toBe(phase);
                expect(record.upstreamTaskId).toBe(submitted.upstreamTaskId);
                expect(record.submittedAt).toBe(submitted.submittedAt);
            }
            expect(pids.size).toBe(4);
            await scheduler.scheduleGenerationTask("agent", run.id, { nextPollAt: Date.now() });
            const completed = await command(run, "recover").completed;
            expect(completed.run).toMatchObject({ id: run.id, conversationId: run.conversationId, inputMessageId: run.inputMessageId, assistantMessageId: run.assistantMessageId, status: "completed" });
            expect(completed.run.tasks[0]).toMatchObject({ id: created.run.tasks[0].id, attempts: 1, taskIds: [childId], childTasks: [{ id: childId, attempt: 1, status: "completed" }] });
            expect(completed.run.ecommerceSnapshot!.referenceCheckpoint).toEqual(checkpoint);
            expect(completed.run.ecommerceSnapshot).toMatchObject({ qualityPolicy: "disabled", technicalCheck: { status: "passed" } });
            expect(completed.run.ecommerceSnapshot?.qualityCheck).toBeUndefined();
            expect(completed.messages.map((message) => message.id)).toEqual(created.messages.map((message) => message.id));
            expect(imagePosts.filter((id) => id === run.id)).toHaveLength(1);
            expect(upstreamCreates()).toBe(creates + 1);
            expect(visionPosts()).toBe(visionCount);
            expect(await durableChildren(run)).toHaveLength(1);
        }, 120_000);
    });
}

function gate() {
    const arrived = Promise.withResolvers<Stage>();
    const released = Promise.withResolvers<void>();
    return {
        arrived: arrived.promise,
        released: released.promise,
        evidence: undefined as Stage | undefined,
        arrive(value: Stage) {
            this.evidence = value;
            arrived.resolve(value);
        },
        release() {
            released.resolve();
        },
    };
}
function listen(server: Server) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}
function serverOrigin(server: Server) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
    return `http://127.0.0.1:${address.port}`;
}
function close(server: Server) {
    return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
    });
}
