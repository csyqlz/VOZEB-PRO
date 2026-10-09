import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPostgresRepositories } from "./repositories";
import { withPostgresTransaction } from "./postgres";

const postgresIt = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;

describe("create overview quality PostgreSQL integration", () => {
    postgresIt.each(["log", "task", "both"])("lists optional visual quality only after consistent technical delivery (%s)", async (source) => {
        const rollbackOnly = new Error("rollback optional quality fixture");
        await expect(
            withPostgresTransaction(async (client) => {
                const owner = randomUUID(),
                    other = randomUUID();
                for (const id of [owner, other]) await client.query("INSERT INTO users (id, username, display_name, password_hash, status) VALUES ($1, $1, 'integration', 'integration-test-only', 'active')", [id]);
                const passed = deliveryTrace("advisory", "blocked");
                const missing = structuredClone(passed);
                missing.stages[2].output = {};
                const hard = structuredClone(passed);
                hard.stages[2].output = { technicalCheck: { status: "passed", hardFailures: [{ key: "canvas_geometry" }] } };
                const generating = structuredClone(passed);
                generating.stages[2].status = "running";
                const unknownPolicy = structuredClone(passed);
                unknownPolicy.stages[3].output.policy = "unknown";
                const cases: Array<{ name: string; evidence: unknown; accepted?: boolean; conflicting?: unknown; foreign?: boolean; pending?: boolean }> = [
                    { name: "disabled", evidence: deliveryTrace("disabled"), accepted: true },
                    ...["not_run", "blocked", "unavailable", "review_pending"].map((status) => ({ name: `advisory-${status}`, evidence: deliveryTrace("advisory", status), accepted: true })),
                    { name: "missing", evidence: missing },
                    { name: "blocked", evidence: deliveryTrace("advisory", "passed", "blocked") },
                    { name: "unavailable", evidence: deliveryTrace("disabled", "not_run", "unavailable") },
                    { name: "hard", evidence: hard },
                    { name: "generating", evidence: generating },
                    { name: "missing-generation", evidence: { ...passed, stages: passed.stages.filter((stage) => stage.key !== "image_generation") } },
                    { name: "conflicting-generation", evidence: { ...passed, stages: [...passed.stages, { ...passed.stages[2], output: { technicalCheck: { status: "blocked" } } }] } },
                    { name: "incomplete", evidence: { ...passed, finalStatus: "needs_review" } },
                    { name: "shadow", evidence: { ...passed, mode: "shadow" } },
                    { name: "unknown-policy", evidence: unknownPolicy },
                    { name: "stale-log", evidence: passed, conflicting: deliveryTrace("advisory", "blocked", "blocked") },
                    { name: "stale-task", evidence: missing, conflicting: passed },
                    { name: "policy-conflict", evidence: passed, conflicting: deliveryTrace("disabled") },
                    { name: "foreign", evidence: passed, foreign: true },
                    { name: "pending", evidence: passed, pending: true },
                ];
                for (const sample of cases) {
                    const id = randomUUID();
                    await client.query("INSERT INTO generation_tasks (id,user_id,task_type,status,payload,expires_at) VALUES ($1,$2,'image','success',$3::jsonb,now()+interval '1 hour')", [
                        id,
                        sample.foreign ? other : owner,
                        JSON.stringify({ ecommerceExecution: {}, ...(sample.conflicting || source !== "log" ? { ecommerceTrace: sample.conflicting || sample.evidence } : {}) }),
                    ]);
                    await client.query("INSERT INTO generation_logs (id,user_id,username,display_name,kind,source,status,title,prompt,task_id,ecommerce_trace) VALUES ($1,$2,'integration','integration','image','agent',$3,$4,'',$1,$5::jsonb)", [
                        id,
                        owner,
                        sample.pending ? "pending" : "success",
                        sample.name,
                        JSON.stringify(sample.conflicting || source !== "task" ? sample.evidence : {}),
                    ]);
                    await client.query("INSERT INTO generation_log_assets (generation_log_id,type,url,server_url) VALUES ($1,'image',$2,$2)", [id, `/api/generation-log-assets/${sample.name}.png`]);
                }
                const overview = await createPostgresRepositories(client).generationLogs.getCreateOverview(owner);
                expect(overview.recentAssets.map((asset) => asset.title).sort()).toEqual(
                    cases
                        .filter((sample) => sample.accepted)
                        .map((sample) => sample.name)
                        .sort(),
                );
                throw rollbackOnly;
            }),
        ).rejects.toBe(rollbackOnly);
    });
    postgresIt.each([
        { name: "status null", output: { status: null } },
        { name: "publicStatus null", output: { publicStatus: null } },
        { name: "both statuses null", output: { status: null, publicStatus: null } },
    ])("rejects explicit $name in both log and task QA evidence", async ({ output }) => {
        const rollbackOnly = new Error("rollback explicit null fixture");
        await expect(
            withPostgresTransaction(async (client) => {
                const owner = randomUUID();
                await client.query("INSERT INTO users (id, username, display_name, password_hash, status) VALUES ($1, $1, 'integration', 'integration-test-only', 'active')", [owner]);
                const passed = trace("passed");
                const evidence = { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output }] };
                for (const source of ["log", "task"]) {
                    const id = randomUUID();
                    await client.query("INSERT INTO generation_tasks (id,user_id,task_type,status,payload,expires_at) VALUES ($1,$2,'image','success',$3::jsonb,now()+interval '1 hour')", [
                        id,
                        owner,
                        JSON.stringify(source === "task" ? { ecommerceTrace: evidence } : {}),
                    ]);
                    await client.query("INSERT INTO generation_logs (id,user_id,username,display_name,kind,source,status,title,prompt,task_id,ecommerce_trace) VALUES ($1,$2,'integration','integration','image','agent','success',$3,'',$1,$4::jsonb)", [
                        id,
                        owner,
                        source,
                        JSON.stringify(source === "log" ? evidence : {}),
                    ]);
                    await client.query("INSERT INTO generation_log_assets (generation_log_id,type,url,server_url) VALUES ($1,'image',$2,$2)", [id, `/api/generation-log-assets/${source}.png`]);
                }
                const overview = await createPostgresRepositories(client).generationLogs.getCreateOverview(owner);
                expect(overview.recentAssets).toEqual([]);
                throw rollbackOnly;
            }),
        ).rejects.toBe(rollbackOnly);
    });
    postgresIt("gates exact log and task verdicts while preserving ordinary and shadow success", async () => {
        const rollbackOnly = new Error("rollback integration fixture");
        await expect(
            withPostgresTransaction(async (client) => {
                const owner = randomUUID();
                const other = randomUUID();
                for (const id of [owner, other]) await client.query("INSERT INTO users (id, username, display_name, password_hash, status) VALUES ($1, $1, 'integration', 'integration-test-only', 'active')", [id]);
                const passed = trace("passed");
                const shadow = { ...trace("completed", "not_run"), mode: "shadow" };
                const cases = [
                    { name: "ordinary" },
                    { name: "active-passed", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { status: "passed", publicStatus: "passed" } }] }, execution: true },
                    { name: "outbox-passed", task: passed, execution: true },
                    { name: "shadow", log: shadow },
                    { name: "qa-window", execution: true },
                    { name: "stale-log", log: passed, task: trace("needs_review") },
                    { name: "stale-task", log: trace("needs_review"), task: passed },
                    { name: "soft", log: trace("needs_adjustment") },
                    { name: "unavailable", log: trace("needs_review", "unavailable") },
                    { name: "hard", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { hardFailures: [{ key: "canvas_geometry" }] } }] } },
                    { name: "foreign", task: passed, foreign: true },
                    { name: "active-shadow", log: shadow, execution: true },
                    { name: "shadow-failed", log: { ...shadow, finalStatus: "needs_review" } },
                    { name: "shadow-hard", log: { ...shadow, stages: [...shadow.stages.slice(0, 3), { key: "quality_check", status: "not_run", output: { hardFailures: [{ key: "canvas_geometry" }] } }] } },
                    { name: "corrupt-stages", log: { ...passed, stages: null } },
                    { name: "missing-final", log: { stages: passed.stages } },
                    { name: "missing-qa-status", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", output: {} }] } },
                    { name: "status-null-log", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { status: null } }] } },
                    { name: "public-status-null-log", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { publicStatus: null } }] } },
                    { name: "both-statuses-null-log", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { status: null, publicStatus: null } }] } },
                    { name: "status-null-task", task: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { status: null } }] } },
                    { name: "public-status-null-task", task: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { publicStatus: null } }] } },
                    { name: "both-statuses-null-task", task: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { status: null, publicStatus: null } }] } },
                    { name: "output-unavailable", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { status: "unavailable" } }] } },
                    { name: "public-output-unavailable", log: { ...passed, stages: [...passed.stages.slice(0, 3), { key: "quality_check", status: "passed", output: { publicStatus: "unavailable" } }] } },
                ] as Array<{ name: string; log?: unknown; task?: unknown; execution?: boolean; foreign?: boolean }>;
                for (const sample of cases) {
                    const id = randomUUID();
                    await client.query("INSERT INTO generation_tasks (id,user_id,task_type,status,payload,expires_at) VALUES ($1,$2,'image','success',$3::jsonb,now()+interval '1 hour')", [
                        id,
                        sample.foreign ? other : owner,
                        JSON.stringify({ ...(sample.execution ? { ecommerceExecution: {} } : {}), ...(sample.task ? { ecommerceTrace: sample.task } : {}) }),
                    ]);
                    await client.query("INSERT INTO generation_logs (id,user_id,username,display_name,kind,source,status,title,prompt,task_id,ecommerce_trace) VALUES ($1,$2,'integration','integration','image','agent','success',$3,'',$1,$4::jsonb)", [
                        id,
                        owner,
                        sample.name,
                        JSON.stringify(sample.log || {}),
                    ]);
                    await client.query("INSERT INTO generation_log_assets (generation_log_id,type,url,server_url) VALUES ($1,'image',$2,$2)", [id, `/api/generation-log-assets/${sample.name}.png`]);
                }
                const overview = await createPostgresRepositories(client).generationLogs.getCreateOverview(owner);
                expect(overview.recentAssets.map((asset) => asset.title).sort()).toEqual(["active-passed", "ordinary", "outbox-passed", "shadow"]);
                const logs = await client.query<{ status: string }>("SELECT status FROM generation_logs WHERE user_id=$1", [owner]);
                expect(logs.rows).toHaveLength(cases.length);
                expect(logs.rows.every((log) => log.status === "success")).toBe(true);
                throw rollbackOnly;
            }),
        ).rejects.toBe(rollbackOnly);
    });
});

function deliveryTrace(policy: "disabled" | "advisory", qualityStatus = "not_run", technicalStatus = "passed") {
    const evidence: Record<string, unknown> = { ...trace("completed"), mode: "active" };
    const stages: Array<{ key: string; status: string; output: Record<string, unknown> }> = trace("completed").stages;
    stages[2].output = { technicalCheck: { status: technicalStatus, hardFailures: [] } };
    stages[3] = { key: "quality_check", status: qualityStatus, output: { policy, status: qualityStatus, hardFailures: qualityStatus === "blocked" ? [{ key: "protected_structure" }] : [] } };
    return { ...evidence, stages };
}

function trace(finalStatus: string, qaStatus = finalStatus) {
    return {
        version: "ecommerce-generation-trace.v1",
        runId: "fixture-run",
        agentTaskId: "fixture-task",
        imageTaskIds: [],
        finalStatus,
        recordedAt: 1,
        stages: [
            { key: "visual_analysis", status: "completed", output: {} },
            { key: "edit_planning", status: "completed", output: {} },
            { key: "image_generation", status: "completed", output: {} },
            { key: "quality_check", status: qaStatus, output: {} },
        ],
    };
}
