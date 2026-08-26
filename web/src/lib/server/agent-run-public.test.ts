import { describe, expect, it } from "vitest";

import { publicAgentRun, publicAgentRunEvent } from "./agent-run-public";
import { AGENT_PLAN_SCHEMA_VERSION } from "./agent-run-audit";

describe("publicAgentRun", () => {
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
});
