import { describe, expect, it } from "vitest";

import { publicAgentRun, publicAgentRunEvent, publicAgentRunSnapshot } from "./agent-run-public";
import { AGENT_PLAN_SCHEMA_VERSION } from "./agent-run-audit";
import type { AgentRun } from "./agent-run-store";

describe("publicAgentRun", () => {
    it("delivers advisory visual failures without hiding saved results", () => {
        const run = {
            id: "advisory-result",
            status: "completed",
            tasks: [],
            assetIds: ["saved-result"],
            ecommerceSnapshot: {
                qualityPolicy: "advisory",
                technicalCheck: { status: "passed", checks: [], hardFailures: [], internalReason: "saved" },
                qualityCheck: {
                    status: "blocked",
                    publicStatus: "needs_review",
                    checks: [{ key: "protected_structure", status: "failed", reason: "private-count-error" }],
                    hardFailures: [{ key: "protected_structure", status: "failed", reason: "private-count-error" }],
                },
            },
        } as unknown as AgentRun;
        expect(publicAgentRun(run)).toMatchObject({ status: "completed", assetIds: ["saved-result"], ecommerceQualityStatus: "needs_adjustment" });
        expect(JSON.stringify(publicAgentRunSnapshot(run))).not.toContain("private-count-error");
    });

    it("delivers disabled quality without inventing a passed visual check", () => {
        const run = { id: "no-qa", status: "completed", tasks: [], assetIds: ["saved-result"], ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed", checks: [], hardFailures: [] } } } as unknown as AgentRun;
        expect(publicAgentRun(run).assetIds).toEqual(["saved-result"]);
        expect(publicAgentRun(run)).not.toHaveProperty("ecommerceQualityStatus");
    });

    it("keeps unreadable technical results blocked when visual quality is disabled", () => {
        const run = {
            id: "technical-failure",
            status: "paused",
            tasks: [],
            assetIds: ["unreadable"],
            ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "unavailable", checks: [], hardFailures: [], internalReason: "stored media unavailable" } },
        } as unknown as AgentRun;
        expect(publicAgentRun(run)).toMatchObject({ assetIds: [], ecommerceQualityStatus: "needs_review" });
    });

    it("keeps known hard failure keys readable when their evidence was not applicable", () => {
        const run = {
            id: "run",
            tasks: [],
            assetIds: ["private-result"],
            ecommerceSnapshot: { qualityCheck: { status: "blocked", publicStatus: "needs_review", hardFailures: [{ key: "product_silhouette", status: "not_applicable", reason: "private evidence unavailable" }] } },
        } as unknown as AgentRun;
        expect(publicAgentRun(run)).toMatchObject({ assetIds: [], ecommerceQualityReview: { failureKeys: ["product_silhouette"] } });
    });
    it("keeps soft acceptance and readable canvas failures in public snapshots without private evidence", () => {
        const run = {
            id: "quality",
            status: "completed",
            tasks: [],
            assetIds: ["preview"],
            ecommerceSnapshot: {
                qualityCheck: {
                    status: "needs_adjustment",
                    publicStatus: "needs_adjustment",
                    checks: [{ key: "scene_intent", status: "failed", reason: "private-textureDirection" }],
                    hardFailures: [],
                    internalReason: "compiledPrompt-private",
                },
            },
        } as unknown as AgentRun;
        expect(publicAgentRun(run)).toMatchObject({ ecommerceQualityStatus: "needs_adjustment", ecommerceQualityReview: { kind: "needs_adjustment", failureKeys: ["scene_intent"] } });
        expect(publicAgentRunSnapshot(run)).toMatchObject({ ecommerceQualityStatus: "needs_adjustment" });
        run.ecommerceSnapshot!.qualityCheck = {
            ...run.ecommerceSnapshot!.qualityCheck!,
            status: "blocked",
            publicStatus: "needs_review",
            hardFailures: [{ resultId: "result", key: "canvas_geometry", status: "failed", reason: "private" }],
            canvasEvidence: [
                {
                    resultId: "result",
                    constraint: { mode: "exact", size: { width: 1024, height: 1024 }, source: "user_text", allowReframe: false },
                    nativeSize: { width: 1254, height: 1254 },
                    nativeStatus: "readable",
                    storedStatus: "unavailable",
                    nativeMatches: false,
                    storedMatches: null,
                    storedUrl: "/private-result",
                    hardFailures: ["canvas_geometry"],
                },
            ],
        };
        expect(publicAgentRun(run)).toMatchObject({ assetIds: [], ecommerceQualityReview: { failureKeys: ["canvas_geometry"], message: "画幅与要求不一致：要求 1024×1024，上游原图 1254×1254。" } });
        expect(JSON.stringify(publicAgentRunSnapshot(run))).not.toMatch(/private|textureDirection|compiledPrompt|canvasEvidence|storedStatus/);
    });
    it("exposes only user-facing Run and task fields", () => {
        const publicRun = publicAgentRun({
            id: "run",
            userId: "user-secret",
            conversationId: "conversation",
            clientRequestId: "request-secret",
            surface: "chat",
            inputMessageId: "input",
            assistantMessageId: "assistant",
            prompt: "@图片1 用户原始需求",
            publicPrompt: "图片1 用户原始需求",
            snapshot: { private: true },
            referencedAssetIds: ["asset-one"],
            selectedSkillIds: ["skill-one"],
            requestedModelIds: ["video-pro"],
            assetIds: ["result-one"],
            status: "failed",
            executionId: "execution-secret",
            tasks: [
                {
                    id: "video",
                    title: "视频",
                    type: "video",
                    model: "video-pro",
                    prompt: "电影感海边日落运镜，人物动作自然流畅\n\n以下为内部执行上下文，只用于理解连续创作关系和指代；当前用户需求优先：\n内部执行提示词-secret",
                    count: 1,
                    ratio: "16:9",
                    quality: "2160",
                    seconds: 60,
                    generateAudio: false,
                    watermark: true,
                    dependencies: [],
                    status: "failed",
                    attempts: 1,
                    taskId: "child-secret",
                    childTasks: [{ id: "child-secret", status: "failed", attempt: 1, result: { raw: "secret" } }],
                    result: { raw: "secret" },
                    error: "生成失败",
                },
            ],
            foundation: { complexity: "simple", brief: { objective: "secret" }, direction: { summary: "secret" } },
            plannerAudit: {
                schemaVersion: AGENT_PLAN_SCHEMA_VERSION,
                mode: "model",
                logicalModelId: "planner-secret",
                channelId: "channel-secret",
                upstreamModel: "upstream-secret",
                protocol: "chat",
                pointsCost: 2,
                skills: [
                    {
                        id: "skill-one",
                        name: "Skill",
                        description: "secret-skill-description",
                        plannerSummary: "secret-skill-summary",
                        instructions: "secret-skill-instructions",
                        enabled: true,
                        keywords: ["secret-keyword"],
                        workspaces: ["image"],
                        action: "generate",
                        requiresReference: false,
                        defaultConfig: { quality: "secret-quality" },
                        sourceCommit: "commit-secret",
                    },
                ],
            },
            review: { mode: "visual", status: "needs_revision", summary: "secret", issues: [], retryTaskIds: [] },
            reviewed: true,
            cancellation: { requestedAt: 1, pendingChildTaskIds: ["child-secret"], lastError: "secret" },
            failure: "internal-failure-secret",
            failureStage: "planning",
            candidateFailures: [{ channelId: "channel-failure-secret", upstreamModel: "model-failure-secret", error: "candidate-failure-secret" }],
            createdAt: 1,
            updatedAt: 2,
        });
        const serialized = JSON.stringify(publicRun);

        expect(publicRun).toMatchObject({
            prompt: "图片1 用户原始需求",
            cancellation: { pendingCount: 1 },
            tasks: [{ id: "video", model: "video-pro", optimizedPrompt: "电影感海边日落运镜，人物动作自然流畅", seconds: 60, generateAudio: false, watermark: true, status: "failed" }],
        });
        expect(serialized).not.toContain("内部执行提示词-secret");
        expect(serialized).not.toContain("@图片1");
        expect(serialized).not.toContain("execution-secret");
        expect(serialized).not.toContain("child-secret");
        expect(serialized).not.toContain("user-secret");
        expect(serialized).not.toContain("request-secret");
        expect(serialized).not.toContain('"foundation"');
        expect(serialized).not.toContain("planner-secret");
        expect(serialized).not.toContain("commit-secret");
        expect(serialized).not.toContain("secret-skill-instructions");
        expect(serialized).not.toContain('"review"');
        expect(serialized).not.toContain('"result"');
        expect(serialized).not.toContain("internal-failure-secret");
        expect(serialized).not.toContain("channel-failure-secret");
        expect(serialized).not.toContain("candidate-failure-secret");
    });

    it("removes review details and internal Canvas planning nodes from SSE events", () => {
        expect(publicAgentRunEvent({ id: "1", runId: "run", type: "run.review.needs_revision", data: { review: { summary: "secret" } }, createdAt: 1 }).data).toBeUndefined();
        const event = publicAgentRunEvent({
            id: "2",
            runId: "run",
            type: "canvas.ops",
            data: {
                reply: "开始生成",
                ops: [
                    { type: "add_node", id: "brief-run", nodeType: "brief", metadata: { agentBrief: { objective: "secret" } } },
                    { type: "connect_nodes", fromNodeId: "brief-run", toNodeId: "task-run-0" },
                    { type: "add_node", id: "task-run-0", nodeType: "task", metadata: { prompt: "internal-secret", model: "image-pro" } },
                ],
            },
            createdAt: 1,
        });

        expect(event.data).toEqual({ reply: "开始生成", ops: [{ type: "add_node", id: "task-run-0", nodeType: "task", metadata: { model: "image-pro" } }] });
    });

    it("removes internal planning payloads from public SSE events", () => {
        expect(publicAgentRunEvent({ id: "event-one", runId: "run-one", type: "run.planning.context_ready", data: { promptJson: "secret" }, createdAt: 1 })).toMatchObject({ type: "run.planning.context_ready", data: undefined });
    });

    it("exposes safe ecommerce review items and hides blocked assets and internal reasons", () => {
        const run = {
            id: "run-quality",
            userId: "user-secret",
            conversationId: "conversation",
            clientRequestId: "request-secret",
            surface: "chat",
            inputMessageId: "input",
            assistantMessageId: "assistant",
            prompt: "生成场景图",
            referencedAssetIds: ["product"],
            assetIds: ["blocked-result"],
            status: "paused",
            tasks: [],
            reviewed: true,
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                input: { userRequest: "生成场景图", assetIds: ["product"], conversationId: "conversation", surface: "chat" },
                qualityCheck: {
                    version: "ecommerce-quality.v1",
                    status: "blocked",
                    publicStatus: "needs_review",
                    modelRole: {
                        logicalRole: "quality_check",
                        capability: "text",
                        logicalModelId: "quality-model",
                        channelId: "quality-channel",
                        upstreamModel: "gpt-5.6-sol",
                        apiFormat: "openai",
                    },
                    checks: [{ resultId: "result-1", key: "product_silhouette", status: "failed", reason: "internal-secret" }],
                    hardFailures: [{ resultId: "result-1", key: "product_silhouette", status: "failed", reason: "internal-secret" }],
                    internalReason: "internal-secret",
                    checkedAt: 1,
                },
                createdAt: 1,
                runId: "run-quality",
                userId: "user-secret",
            },
            createdAt: 1,
            updatedAt: 2,
        } as AgentRun;

        const publicRun = publicAgentRun(run);
        const event = publicAgentRunEvent({
            id: "event-quality",
            runId: run.id,
            type: "ecommerce.quality",
            data: { status: "needs_review", text: "商品一致性检查未通过，需要复核。", internalReason: "internal-secret", checks: ["secret"] },
            createdAt: 2,
        });

        expect(publicRun).toMatchObject({
            ecommerceQualityStatus: "needs_review",
            ecommerceQualityReview: { kind: "hard_failure", failureKeys: ["product_silhouette"] },
            assetIds: [],
        });
        expect(event.data).toEqual({ status: "needs_review", text: "商品一致性检查未通过，需要复核。" });
        expect(JSON.stringify({ publicRun, event })).not.toContain("internal-secret");
        expect(JSON.stringify({ publicRun, event })).not.toContain("blocked-result");
    });
});
