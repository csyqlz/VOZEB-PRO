import { describe, expect, it } from "vitest";

import type { StoredGenerationLog } from "@/lib/server/generation-log-types";
import type { ImageTask } from "./image-task-store";
import type { JsonValue } from "./database";

import { buildCreateAgentRunOverview, buildCreateGenerationOverview } from "./create-workbench-overview-service";

describe("create workbench overview service", () => {
    it.each([
        ["disabled", "not_run"],
        ["advisory", "not_run"],
        ["advisory", "blocked"],
        ["advisory", "unavailable"],
        ["advisory", "review_pending"],
    ] as const)("lists technically delivered %s images with %s visual quality in either durable source", (policy, qualityStatus) => {
        const evidence = deliveryTrace(policy, qualityStatus);
        for (const source of ["log", "task", "both"]) {
            const log = { ...generationLog(source, "success", "2026-07-26T12:00:00.000Z", [{ type: "image" as const, url: `/api/media/${source}.png` }]), taskId: source, ...(source !== "task" ? { ecommerceTrace: evidence } : {}) };
            const tasks = new Map<string, Pick<ImageTask, "userId" | "ecommerceExecution" | "ecommerceTrace">>([[source, { userId: log.userId, ecommerceExecution: {} as never, ...(source !== "log" ? { ecommerceTrace: evidence } : {}) }]]);
            expect(buildCreateGenerationOverview([log], tasks).recentAssets.map((asset) => asset.url)).toEqual([`/api/media/${source}.png`]);
        }
    });
    it("rejects missing or contradictory technical delivery while ignoring only visual advice", () => {
        const passed = deliveryTrace("advisory", "blocked");
        const missingTechnical = structuredClone(passed);
        missingTechnical.stages[2].output = {};
        const hardTechnical = structuredClone(passed);
        hardTechnical.stages[2].output = { technicalCheck: { status: "passed", hardFailures: [{ key: "canvas_geometry" }] } };
        const generating = structuredClone(passed);
        generating.stages[2].status = "running";
        const missingGeneration = { ...passed, stages: passed.stages.filter((stage) => stage.key !== "image_generation") };
        const conflictingGeneration = { ...passed, stages: [...passed.stages, { ...passed.stages[2], output: { technicalCheck: { status: "blocked" } } }] };
        const invalidPolicy = structuredClone(passed);
        invalidPolicy.stages[3].output = { policy: "unknown" };
        const cases: Array<{ id: string; log: NonNullable<StoredGenerationLog["ecommerceTrace"]>; task?: NonNullable<StoredGenerationLog["ecommerceTrace"]>; foreign?: boolean; pending?: boolean }> = [
            { id: "missing", log: missingTechnical },
            { id: "blocked", log: deliveryTrace("advisory", "passed", "blocked") },
            { id: "unavailable", log: deliveryTrace("disabled", "not_run", "unavailable") },
            { id: "hard", log: hardTechnical },
            { id: "generating", log: generating },
            { id: "missing-generation", log: missingGeneration },
            { id: "conflicting-generation", log: conflictingGeneration },
            { id: "incomplete", log: { ...passed, finalStatus: "needs_review" } },
            { id: "shadow", log: { ...passed, mode: "shadow" as const } },
            { id: "invalid-policy", log: invalidPolicy },
            { id: "stale-log", log: passed, task: deliveryTrace("advisory", "blocked", "blocked") },
            { id: "stale-task", log: missingTechnical, task: passed },
            { id: "policy-conflict", log: passed, task: deliveryTrace("disabled") },
            { id: "foreign", log: passed, foreign: true },
            { id: "pending", log: passed, pending: true },
        ];
        for (const sample of cases) {
            const log = { ...generationLog(sample.id, sample.pending ? "pending" : "success", "2026-07-26T12:00:00.000Z", [{ type: "image" as const, url: `/api/media/${sample.id}.png` }]), taskId: sample.id, ecommerceTrace: sample.log };
            const tasks = new Map<string, Pick<ImageTask, "userId" | "ecommerceExecution" | "ecommerceTrace">>([
                [sample.id, { userId: sample.foreign ? "other" : log.userId, ecommerceExecution: {} as never, ...(sample.task ? { ecommerceTrace: sample.task } : {}) }],
            ]);
            expect(buildCreateGenerationOverview([log], tasks).recentAssets, sample.id).toEqual([]);
        }
    });
    const qualityOutputs: Array<{ name: string; output: Record<string, JsonValue>; publishable: boolean }> = [
        { name: "missing optional statuses", output: {}, publishable: true },
        { name: "explicit passed statuses", output: { status: "passed", publicStatus: "passed" }, publishable: true },
        { name: "status null", output: { status: null }, publishable: false },
        { name: "publicStatus null", output: { publicStatus: null }, publishable: false },
        { name: "both statuses null", output: { status: null, publicStatus: null }, publishable: false },
        { name: "unavailable status", output: { status: "unavailable" }, publishable: false },
        { name: "known hard failure", output: { hardFailures: [{ key: "canvas_geometry" }] }, publishable: false },
    ];
    it.each(qualityOutputs)("uses explicit QA output semantics for $name in log and task evidence", ({ output, publishable }) => {
        const trace = acceptanceTrace("passed");
        trace.stages[3].output = output;
        for (const source of ["log", "task"]) {
            const log = { ...generationLog(source, "success", "2026-07-26T12:00:00.000Z", [{ type: "image" as const, url: `/api/media/${source}.png` }]), taskId: source, ...(source === "log" ? { ecommerceTrace: trace } : {}) };
            const tasks = new Map<string, Pick<ImageTask, "userId" | "ecommerceTrace">>([[source, { userId: "user-one", ...(source === "task" ? { ecommerceTrace: trace } : {}) }]]);
            expect(buildCreateGenerationOverview([log], tasks).recentAssets.map((asset) => asset.url)).toEqual(publishable ? [`/api/media/${source}.png`] : []);
            expect(log.status).toBe("success");
        }
    });
    it("keeps shadow observation successes publishable without treating explicit failures as observations", () => {
        const shadow = { ...acceptanceTrace("completed"), mode: "shadow" as const };
        shadow.stages[3] = { key: "quality_check", status: "not_run", output: {} };
        const create = (id: string, trace = shadow) => ({ ...generationLog(id, "success", "2026-07-26T12:00:00.000Z", [{ type: "image" as const, url: `/api/media/${id}.png` }]), taskId: id, ecommerceTrace: trace });
        const logs = [
            create("shadow"),
            create("active"),
            create("shadow-hard", { ...shadow, stages: shadow.stages.map((stage) => (stage.key === "quality_check" ? { ...stage, output: { hardFailures: [{ key: "canvas_geometry" }] } } : stage)) }),
            create("shadow-failed", { ...shadow, finalStatus: "needs_review" }),
        ];
        const tasks = new Map<string, Pick<ImageTask, "userId" | "ecommerceExecution" | "ecommerceTrace">>([
            ["shadow", { userId: "user-one" }],
            ["active", { userId: "user-one", ecommerceExecution: {} as never }],
        ]);
        expect(buildCreateGenerationOverview(logs, tasks).recentAssets.map((asset) => asset.url)).toEqual(["/api/media/shadow.png"]);
    });
    it("publishes only accepted ecommerce media while preserving generation success facts", () => {
        const logs = ["passed", "needs_adjustment", "needs_review", "blocked", "unavailable"].map((finalStatus) => ({
            ...generationLog(finalStatus, "success", "2026-07-26T12:00:00.000Z", [{ type: "image" as const, url: `/api/media/${finalStatus}.png` }]),
            ecommerceTrace: acceptanceTrace(finalStatus),
        }));
        expect(buildCreateGenerationOverview(logs).recentAssets.map((asset) => asset.url)).toEqual(["/api/media/passed.png"]);
        expect(logs.every((log) => log.status === "success")).toBe(true);
    });
    it("fails closed through the QA window, ownership mismatch and conflicting durable verdicts", () => {
        const create = (id: string) => ({ ...generationLog(id, "success", "2026-07-26T12:00:00.000Z", [{ type: "image" as const, url: `/api/media/${id}.png` }]), taskId: id });
        const logs = [
            create("pending-qa"),
            { ...create("stale-log"), ecommerceTrace: acceptanceTrace("passed") },
            { ...create("stale-task"), ecommerceTrace: acceptanceTrace("needs_review") },
            create("foreign"),
            create("ordinary"),
            create("outbox-passed"),
        ];
        const tasks = new Map<string, Pick<ImageTask, "userId" | "ecommerceExecution" | "ecommerceTrace">>([
            ["pending-qa", { userId: "user-one", ecommerceExecution: {} as never }],
            ["stale-log", { userId: "user-one", ecommerceTrace: acceptanceTrace("needs_review") }],
            ["stale-task", { userId: "user-one", ecommerceTrace: acceptanceTrace("passed") }],
            ["foreign", { userId: "other", ecommerceTrace: acceptanceTrace("passed") }],
            ["ordinary", { userId: "user-one" }],
            ["outbox-passed", { userId: "user-one", ecommerceExecution: {} as never, ecommerceTrace: acceptanceTrace("passed") }],
        ]);
        expect(buildCreateGenerationOverview(logs, tasks).recentAssets.map((asset) => asset.url)).toEqual(["/api/media/ordinary.png", "/api/media/outbox-passed.png"]);
    });
    it("returns four running tasks and eight latest unique stable assets", () => {
        const logs = [
            ...Array.from({ length: 6 }, (_, index) => generationLog(`pending-${index}`, "pending", `2026-07-2${index}T12:00:00.000Z`, [])),
            generationLog("success-new", "success", "2026-07-26T12:00:00.000Z", [
                { type: "image", url: "/api/media/image-one.webp" },
                { type: "image", url: "data:image/png;base64,abc" },
            ]),
            generationLog("success-old", "success", "2026-07-25T12:00:00.000Z", [{ type: "image", url: "/api/media/image-one.webp" }, ...Array.from({ length: 9 }, (_, index) => ({ type: "video" as const, url: `/api/media/video-${index}.mp4` }))]),
        ];

        const overview = buildCreateGenerationOverview(logs);

        expect(overview.runningTasks).toHaveLength(4);
        expect(overview.runningTasks[0].id).toBe("pending-5");
        expect(overview.recentAssets).toHaveLength(8);
        expect(overview.recentAssets[0]).toMatchObject({ id: "success-new-0", url: "/api/media/image-one.webp" });
        expect(overview.recentAssets.filter((asset) => asset.url === "/api/media/image-one.webp")).toHaveLength(1);
        expect(overview.recentAssets.some((asset) => asset.url.startsWith("data:"))).toBe(false);
    });

    it("keeps active Agent runs linked to their original conversation", () => {
        const tasks = buildCreateAgentRunOverview([
            { id: "run-one", surface: "chat", status: "running", prompt: "生成西瓜海报", conversationId: "conversation-one", createdAt: 100, tasks: [{ type: "image" }] },
            { id: "run-two", surface: "chat", status: "completed", prompt: "已完成", conversationId: "conversation-two", createdAt: 200, tasks: [] },
        ] as never);

        expect(tasks).toEqual([expect.objectContaining({ id: "run-one", kind: "image", source: "agent", conversationId: "conversation-one", status: "running" })]);
    });
});

function deliveryTrace(policy: "disabled" | "advisory", qualityStatus = "not_run", technicalStatus = "passed"): NonNullable<StoredGenerationLog["ecommerceTrace"]> {
    const evidence = { ...acceptanceTrace("completed"), mode: "active" as const };
    evidence.stages[2].output = { technicalCheck: { status: technicalStatus, hardFailures: [] } };
    evidence.stages[3] = { key: "quality_check", status: qualityStatus, output: { policy, status: qualityStatus, hardFailures: qualityStatus === "blocked" ? [{ key: "protected_structure" }] : [] } };
    return evidence;
}

function acceptanceTrace(finalStatus: string): NonNullable<StoredGenerationLog["ecommerceTrace"]> {
    return {
        version: "ecommerce-generation-trace.v1",
        runId: "run",
        agentTaskId: "task",
        imageTaskIds: [],
        finalStatus,
        recordedAt: 1,
        stages: [
            { key: "visual_analysis", status: "completed", output: {} },
            { key: "edit_planning", status: "completed", output: {} },
            { key: "image_generation", status: "completed", output: {} },
            { key: "quality_check", status: finalStatus, output: { status: finalStatus, hardFailures: [] } },
        ],
    };
}

function generationLog(id: string, status: StoredGenerationLog["status"], createdAt: string, assets: StoredGenerationLog["assets"]): StoredGenerationLog {
    return {
        id,
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: assets[0]?.type || "image",
        source: "agent",
        status,
        title: id,
        prompt: "",
        model: "model",
        summary: "",
        durationMs: 0,
        count: Math.max(1, assets.length),
        successCount: status === "success" ? assets.length : 0,
        failCount: 0,
        assets,
        createdAt,
        updatedAt: createdAt,
    };
}
