import { expect, it, vi } from "vitest";

// Only Next request-lifetime plumbing is supplied by this test host. Auth,
// stores, transactions, scheduling, execution and transport remain real.
const input = vi.hoisted(
    () =>
        JSON.parse(process.env.VOZEB_PRO_ECOMMERCE_PROCESS_INPUT || "null") as {
            command: "confirm" | "recover" | "read" | "create_image" | "late_release" | "execute";
            origin: string;
            cookie: string;
            resultKey: string;
            runId: string;
            conversationId: string;
            sceneSelection?: unknown;
            referenceRecovery?: unknown;
            imageBody?: unknown;
            taskIds?: string[];
            provider?: "file" | "postgres";
            fixtureDirectory?: string;
            gatePhases?: string[];
            failRuntimeWrite?: boolean;
            crashAfterCommit?: boolean;
            workerId?: string;
        } | null,
);
const observation = vi.hoisted(() => ({ referenceMutation: false, failedWrite: false, stages: new Set<string>() }));
async function stage(phase: string, evidence: Record<string, unknown> = {}) {
    if (!input?.gatePhases?.includes(phase) || observation.stages.has(phase)) return;
    observation.stages.add(phase);
    const response = await fetch(`${input.origin}/_process-stage/${input.resultKey}/${phase}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phase, pid: process.pid, runId: input.runId, ...evidence }) });
    if (!response.ok) throw new Error("Fixture stage host refused observation");
}
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (input?.cookie ? { value: input.cookie } : undefined) }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("./data-adapter", async (original) => {
    const actual = await original<typeof import("./data-adapter")>();
    return {
        ...actual,
        withJsonDataFileLock: async <T>(file: string, callback: () => Promise<T>, options?: { timeoutMs?: number }) => {
            const parentLock = file === "generation-tasks.json" && (observation.referenceMutation || input?.command === "create_image");
            const pending = actual.withJsonDataFileLock(
                file,
                async () => {
                    if (parentLock) await stage("parent_lock_acquired");
                    return callback();
                },
                options,
            );
            if (parentLock) await stage("parent_lock_attempt");
            return pending;
        },
        writeJsonDataFile: async (file: string, value: unknown) => {
            await actual.writeJsonDataFile(file, value);
            if (file === "creative-runtime.json" && observation.referenceMutation && input?.failRuntimeWrite && !observation.failedWrite) {
                observation.failedWrite = true;
                await stage("runtime_write_complete_before_parent_write");
                throw new Error("Fixture G0 fault after real runtime rename");
            }
        },
    };
});
vi.mock("./database", async (original) => {
    const actual = await original<typeof import("./database")>();
    return {
        ...actual,
        withPostgresTransaction: <T>(callback: Parameters<typeof actual.withPostgresTransaction<T>>[0]) =>
            actual.withPostgresTransaction(async (client) => {
                const query = client.query.bind(client);
                const observedClient = {
                    ...client,
                    query: async (sql: string, values?: unknown[]) => {
                        const parentLock = /FROM\s+generation_tasks/i.test(sql) && /FOR UPDATE/i.test(sql) && values?.[0] === input?.runId && (observation.referenceMutation || input?.command === "create_image");
                        const pid = parentLock ? await query<{ pid: number }>("SELECT pg_backend_pid() AS pid") : undefined;
                        const pending = query(sql, values);
                        if (parentLock) await stage("parent_lock_attempt", { backendPid: pid!.rows[0].pid });
                        const result = await pending;
                        if (parentLock) {
                            await stage("parent_lock_acquired", { backendPid: pid!.rows[0].pid });
                        }
                        return result;
                    },
                } as typeof client;
                return callback(observedClient);
            }),
    };
});
vi.mock("./creative-runtime-store", async (original) => {
    const actual = await original<typeof import("./creative-runtime-store")>();
    return {
        ...actual,
        mutateCreativeRun: async (...args: Parameters<typeof actual.mutateCreativeRun>) => {
            if (!args[5]?.referenceRecovery) return actual.mutateCreativeRun(...args);
            await stage("preflight_complete");
            observation.referenceMutation = true;
            try {
                const result = await actual.mutateCreativeRun(...args);
                if (result) {
                    await stage("parent_commit_complete");
                    if (input?.crashAfterCommit) process.kill(process.pid, "SIGKILL");
                }
                return result;
            } finally {
                observation.referenceMutation = false;
            }
        },
    };
});
vi.mock("./generation-task-scheduler", async (original) => {
    const actual = await original<typeof import("./generation-task-scheduler")>();
    return {
        ...actual,
        claimDueGenerationTasks: async (...args: Parameters<typeof actual.claimDueGenerationTasks>) => {
            const leases = await actual.claimDueGenerationTasks(...args);
            if (input?.command === "recover" && leases.some((lease) => lease.id === input.runId)) await stage("worker_claimed");
            return leases;
        },
    };
});

const processIt = input ? it : it.skip;
// A fresh Vitest process does not inherit the outer PostgreSQL test timeout.
// Use the same integration limit for imports, real transactions and the gate.
processIt(
    "executes one isolated ecommerce process command",
    async () => {
        if (!input) throw new Error("Isolated ecommerce fixture input is required");
        if (input.provider === "file") {
            const path = await import("node:path");
            const os = await import("node:os");
            const directory = path.resolve(input.fixtureDirectory || "");
            if (
                process.env.VOZEB_PRO_DATABASE_PROVIDER !== "file" ||
                directory !== path.resolve(process.env.VOZEB_PRO_DATA_DIR || "") ||
                path.dirname(directory) !== path.resolve(os.tmpdir()) ||
                !path.basename(directory).startsWith("vozeb-reference-process-")
            )
                throw new Error("Exact isolated file fixture directory is required");
        } else if (process.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION !== "1" || process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE !== "1") throw new Error("Isolated ecommerce PostgreSQL fixture is required");
        const { getAgentRun } = await import("./agent-run-store");
        let outcome: unknown;
        if (input.command === "confirm") {
            const { POST } = await import("@/app/api/agent/runs/[id]/[action]/route");
            const response = await POST(
                new Request(`${input.origin}/api/agent/runs/${input.runId}/resume`, {
                    method: "POST",
                    headers: { "content-type": "application/json", cookie: `vozeb_pro_session=${input.cookie}` },
                    body: JSON.stringify({ conversationId: input.conversationId, sceneSelection: input.sceneSelection, referenceRecovery: input.referenceRecovery }),
                }),
                { params: Promise.resolve({ id: input.runId, action: "resume" }) },
            );
            outcome = { status: response.status, body: await response.json() };
        } else if (input.command === "recover") {
            const { runGenerationTaskRecoveryBatch } = await import("./generation-task-recovery-service");
            outcome = await runGenerationTaskRecoveryBatch({ origin: input.origin, cookie: `vozeb_pro_session=${input.cookie}`, taskIds: input.taskIds || [input.runId], limit: input.taskIds?.length || 1, workerId: `fixture-process:${process.pid}` });
        } else if (input.command === "create_image") {
            const { POST } = await import("@/app/api/image-tasks/route");
            const response = await POST(new Request(`${input.origin}/api/image-tasks`, { method: "POST", headers: { "content-type": "application/json", cookie: `vozeb_pro_session=${input.cookie}` }, body: JSON.stringify(input.imageBody) }));
            outcome = { status: response.status, body: await response.json() };
        } else if (input.command === "late_release") {
            const { releaseGenerationTaskLease } = await import("./generation-task-scheduler");
            outcome = await releaseGenerationTaskLease("agent", input.runId, input.workerId || "old-owner", { executionPhase: "completed", nextPollAt: undefined });
        } else if (input.command === "execute") {
            const { executeAgentRun } = await import("./agent-run-executor");
            const run = await getAgentRun(input.runId);
            if (!run) throw new Error("Fixture run missing");
            await executeAgentRun(run, input.origin, `vozeb_pro_session=${input.cookie}`);
        }
        const runtime = await import("./creative-runtime-store");
        const tasks = await import("./generation-task-store");
        const { publicAgentRunForRequest } = await import("./agent-run-public-selection");
        const run = await getAgentRun(input.runId);
        const result = {
            pid: process.pid,
            outcome,
            run,
            messages: await runtime.listCreativeMessages(input.conversationId, 0, 20),
            events: await runtime.listCreativeRunEvents(input.runId),
            parent: await tasks.getStoredGenerationTaskRecord("agent", input.runId),
            publicRun: run ? await publicAgentRunForRequest(run, new Request(input.origin)) : null,
        };
        const response = await fetch(`${input.origin}/_process-result/${input.resultKey}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
        expect(response.status).toBe(200);
    },
    120_000,
);
