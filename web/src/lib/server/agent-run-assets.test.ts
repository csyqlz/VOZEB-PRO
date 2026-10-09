import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, AgentRunTask } from "./agent-run-store";

const mocks = vi.hoisted(() => ({ registerCreativeAssets: vi.fn() }));

vi.mock("@/lib/server/creative-runtime-store", () => ({ registerCreativeAssets: mocks.registerCreativeAssets }));

import { registerAgentTaskAssets } from "./agent-run-assets";

describe("registerAgentTaskAssets", () => {
    beforeEach(() => {
        mocks.registerCreativeAssets.mockReset().mockImplementation(async (inputs: Array<Record<string, unknown>>) => inputs);
    });

    it("records the scene root, branch parent and QA status without a product anchor", async () => {
        const current = {
            ...run(),
            ecommerceSnapshot: {
                plan: { operation: "scene_edit", source: { productAnchorId: null, currentSceneBaselineId: "previous-result" } },
                continuity: { sceneRootAssetId: "scene-root", parentResultId: "previous-result", branchId: "scene-branch" },
                qualityCheck: { status: "needs_adjustment", publicStatus: "needs_adjustment", checks: [{ reason: "scene lighting" }] },
            } as AgentRun["ecommerceSnapshot"],
        };
        const [asset] = await registerAgentTaskAssets(current, { ...task(), type: "image", referenceAssetId: "previous-result" }, { url: "/api/generation-log-assets/result.png" }, ["image-task"]);
        expect(asset).toMatchObject({
            parentAssetId: "scene-root",
            metadata: {
                ecommerceContinuity: {
                    productAnchorId: null,
                    sceneRootAssetId: "scene-root",
                    parentResultId: "previous-result",
                    branchId: "scene-branch",
                    qualityStatus: "needs_adjustment",
                },
            },
        });
        expect(asset.metadata.ecommerceContinuity).not.toHaveProperty("qualityCheck");
        expect(JSON.stringify(asset.metadata)).not.toContain("scene lighting");
    });

    it("preserves emoji in a persisted Agent text asset", async () => {
        const content = "今天也要保持好心情 😊❤️🚀";
        await registerAgentTaskAssets(run(), task(), { content }, ["text-task-one"]);

        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([
            expect.objectContaining({
                conversationId: "conversation-one",
                messageId: "assistant-message",
                sourceRunId: "run-one",
                sourceTaskId: "text-task-one",
                type: "text",
                textContent: content,
            }),
        ]);
    });

    it("normalizes multiple provider results and keeps public playback metadata", async () => {
        await registerAgentTaskAssets(
            run(),
            { ...task(), type: "video", title: "视频", count: 1 },
            { data: { videos: [{ url: "https://cdn.example.com/one.mp4", posterUrl: "https://cdn.example.com/one.webp", ratio: "9:16", width: 1080, height: 1920 }, { error: "第二条失败" }, { url: "https://cdn.example.com/two.mp4" }] } },
            ["video-task-one"],
        );

        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([
            expect.objectContaining({ ordinal: 0, remoteUrl: "https://cdn.example.com/one.mp4", width: 1080, height: 1920, metadata: expect.objectContaining({ coverUrl: "https://cdn.example.com/one.webp", ratio: "9:16" }) }),
            expect.objectContaining({ ordinal: 1, remoteUrl: "https://cdn.example.com/two.mp4" }),
        ]);
    });

    it("keeps the ecommerce product anchor first in generated asset lineage", async () => {
        const ecommerceRun = {
            ...run(),
            ecommerceSnapshot: {
                version: "ecommerce-generation.v1",
                mode: "active",
                input: { userRequest: "生成场景图", assetIds: ["asset-product", "asset-scene"], conversationId: "conversation-one", surface: "chat" },
                plan: { source: { productAnchorId: "asset-product", currentSceneBaselineId: "asset-scene" } },
                continuity: { parentResultId: "asset-scene", branchId: "ecommerce-run-one" },
                createdAt: 1,
                runId: "run-one",
                userId: "user-one",
            } as AgentRun["ecommerceSnapshot"],
        };
        await registerAgentTaskAssets(
            ecommerceRun,
            {
                ...task(),
                type: "image",
                referenceAssetId: "asset-scene",
                references: [{ assetId: "asset-scene", type: "image", url: "/api/reference-assets/permanent/scene.png" }],
            },
            { url: "https://cdn.example.com/result.png" },
            ["image-task-one"],
        );

        expect(mocks.registerCreativeAssets).toHaveBeenCalledWith([
            expect.objectContaining({
                parentAssetId: "asset-product",
                metadata: expect.objectContaining({
                    parentAssetIds: ["asset-product", "asset-scene"],
                    ecommerceContinuity: { productAnchorId: "asset-product", sceneBaselineId: "asset-scene", parentResultId: "asset-scene", branchId: "ecommerce-run-one" },
                }),
            }),
        ]);
    });
});

function run(): AgentRun {
    return {
        id: "run-one",
        userId: "user-one",
        conversationId: "conversation-one",
        clientRequestId: "request-one",
        surface: "chat",
        inputMessageId: "user-message",
        assistantMessageId: "assistant-message",
        prompt: "写一篇带表情的文章",
        referencedAssetIds: [],
        assetIds: [],
        status: "running",
        tasks: [],
        reviewed: false,
        createdAt: 1,
        updatedAt: 1,
    };
}

function task(): AgentRunTask {
    return {
        id: "article-one",
        title: "夏日新品推文",
        type: "text",
        prompt: "写一篇带表情的文章",
        count: 1,
        dependencies: [],
        status: "completed",
        attempts: 1,
    };
}
