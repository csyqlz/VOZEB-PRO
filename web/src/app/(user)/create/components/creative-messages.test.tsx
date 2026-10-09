import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CreativeAsset, CreativeMessage } from "@/lib/creative-runtime-contract";

import { CreativeMessages, creativeReferenceAction, creativeResultPrompt } from "./creative-messages";

describe("creative result references", () => {
    const first = mediaAsset("first");
    const second = mediaAsset("second");

    it("targets only the currently selected result", () => {
        expect(creativeReferenceAction(second, [first.id])).toEqual({ assetId: second.id, referenced: false });
        expect(creativeReferenceAction(first, [first.id])).toEqual({ assetId: first.id, referenced: true });
    });

    it("does not expose a reference action without a ready media result", () => {
        expect(creativeReferenceAction(undefined, [])).toBeUndefined();
        expect(creativeReferenceAction({ ...first, status: "failed" }, [])).toBeUndefined();
        expect(creativeReferenceAction({ ...first, type: "text" }, [])).toBeUndefined();
    });

    it("resolves the public optimized prompt for the selected result without exposing the execution prompt", () => {
        const selected = { ...second, metadata: { agentTaskId: "task-two" } };
        const run = {
            id: "run",
            conversationId: "conversation-one",
            inputMessageId: "user",
            assistantMessageId: "assistant",
            status: "completed" as const,
            assetIds: [first.id, second.id],
            tasks: [
                { id: "task-one", title: "结果一", status: "completed" as const, optimizedPrompt: "优化提示词一" },
                { id: "task-two", title: "结果二", status: "completed" as const, optimizedPrompt: "优化提示词二" },
            ],
        };

        expect(creativeResultPrompt(selected, [first, selected], run)).toBe("优化提示词二");
        expect(creativeResultPrompt({ ...selected, metadata: { agentTaskId: "missing" } }, [first, selected], run)).toBe("");
    });
});

describe("CreativeMessages", () => {
    it.each([
        ["confirm_purposes", "确认用途并继续"],
        ["retry_analysis", "重新分析"],
    ] as const)("restores the original paused round's %s entry when its assistant message is completed", (kind, button) => {
        const userMessage: CreativeMessage = {
            id: "reference-input-original",
            conversationId: "conversation-one",
            runId: "reference-run-original",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "参考这张图的光线，生成商品场景图",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const assistantMessage: CreativeMessage = { ...userMessage, id: "reference-assistant-original", sequence: 2, role: "assistant", content: "请确认参考图片用途" };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, assistantMessage]}
                    assets={[]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "reference-run-original": {
                            id: "reference-run-original",
                            conversationId: "conversation-one",
                            inputMessageId: userMessage.id,
                            assistantMessageId: assistantMessage.id,
                            status: "paused",
                            assetIds: [],
                            tasks: [{ id: "placeholder", title: "商品场景图", type: "image", status: "needs_review" }],
                            ecommerceReferenceReview: {
                                version: "ecommerce-reference-review.v1",
                                reviewId: "reference-review-original",
                                kind,
                                question: "请确认参考图片用途",
                                assets: [
                                    { assetId: "product", assetVersion: "version-one", alias: "图片1", previewUrl: "/api/reference-assets/product.png", purposes: ["edit_target", "product_identity"], allowedPurposes: ["edit_target", "product_identity"] },
                                ],
                            },
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    onRecoverReference={async () => undefined}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );
        expect(markup).toContain(button);
        expect(markup).toContain("/api/reference-assets/product.png");
        expect(markup.match(/data-testid="creative-generation-waiting"/g)).toHaveLength(1);
        expect(markup).not.toContain("已为你生成图片");
        expect(markup).not.toContain("已等待");
    });

    it("renders completed assistant markdown instead of showing syntax markers", () => {
        const message: CreativeMessage = {
            id: "assistant-markdown",
            conversationId: "conversation-one",
            sequence: 2,
            role: "assistant",
            status: "completed",
            content: "以下为一份**通用专业简历报告模板**。\n\n---\n\n# 个人职业简历报告",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderMessages(message);

        expect(markup).toContain("<strong");
        expect(markup).toContain("通用专业简历报告模板</strong>");
        expect(markup).toContain("<hr");
        expect(markup).toContain("<h1");
        expect(markup).not.toContain("**通用专业简历报告模板**");
    });

    it("renders a text-only Agent asset as the full article with emoji", () => {
        const message: CreativeMessage = {
            id: "assistant-article",
            conversationId: "conversation-one",
            sequence: 2,
            role: "assistant",
            status: "completed",
            content: "已完成 1 个创作任务。",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const asset: CreativeAsset = {
            id: "article-one",
            userId: "user-one",
            conversationId: "conversation-one",
            messageId: message.id,
            ordinal: 0,
            type: "text",
            status: "ready",
            title: "夏日新品推文",
            textContent: "# 夏日新品\n\n今天也要保持好心情 😊❤️🚀",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderMessages(message, [asset]);

        expect(markup).toContain('aria-label="文本产物：夏日新品推文"');
        expect(markup).toContain("夏日新品推文");
        expect(markup).toContain("今天也要保持好心情 😊❤️🚀");
        expect(markup).toContain("<h1");
        expect(markup).not.toContain("已完成 1 个创作任务。");
    });

    it("keeps a complete document artifact while hiding upstream wrapper syntax", () => {
        const message: CreativeMessage = {
            id: "assistant-novel",
            conversationId: "conversation-one",
            sequence: 2,
            role: "assistant",
            status: "completed",
            content: "创作任务已完成。",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const asset: CreativeAsset = {
            id: "novel-one",
            userId: "user-one",
            conversationId: "conversation-one",
            messageId: message.id,
            ordinal: 0,
            type: "text",
            status: "ready",
            title: "原创小说正文",
            textContent: ':::writing{variant="document" id="58391" title="《潮汐写给远方的信》"}\n# 潮汐写给远方的信\n\n## 六\n\n等你回来。:::',
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderMessages(message, [asset]);

        expect(markup).toContain("潮汐写给远方的信");
        expect(markup).toContain("等你回来。");
        expect(markup).not.toContain(":::writing");
        expect(markup).not.toContain(":::");
    });

    it("renders current-turn reference images above the user message", () => {
        const message: CreativeMessage = {
            id: "user-message",
            conversationId: "conversation-one",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "把她换成白发",
            metadata: { assetIds: ["reference-one"] },
            createdAt: 1,
            updatedAt: 1,
        };
        const asset: CreativeAsset = {
            id: "reference-one",
            userId: "user-one",
            conversationId: "conversation-one",
            sourceRunId: "upload",
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "人物参考图",
            serverUrl: "/api/reference-assets/permanent/person.png",
            storageKey: "permanent/person.png",
            mimeType: "image/png",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[message]}
                    assets={[asset]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{}}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain('aria-label="本轮参考素材"');
        expect(markup.indexOf('alt="人物参考图"')).toBeLessThan(markup.indexOf("把她换成白发"));
    });

    it("renders a single generated media result as a large uncropped preview", () => {
        const message: CreativeMessage = {
            id: "message-one",
            conversationId: "conversation-one",
            sequence: 1,
            role: "assistant",
            status: "completed",
            content: "图片已生成。",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const asset: CreativeAsset = {
            id: "asset-one",
            userId: "user-one",
            conversationId: "conversation-one",
            messageId: message.id,
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "生成图片",
            serverUrl: "/generated/image.png",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[message]}
                    assets={[asset]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{}}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain("max-w-[1040px]");
        expect(markup).toContain("flex-wrap");
        expect(markup).toContain("width:min(420px, 33.333333dvh)");
        expect(markup).toContain("object-contain");
        expect(markup).toContain("!size-full object-contain");
        expect(markup).toContain('data-testid="creative-message-end"');
        expect(markup).toContain("!mt-0 h-px");
        expect(markup).not.toContain("h-36 sm:h-40");
        expect(markup).toContain('aria-label="引用素材"');
        expect(markup).toContain('aria-label="下载图片"');
        expect(markup).toContain('aria-label="复制消息"');
        expect(markup).toContain("mt-1 flex min-h-8 items-center justify-end");
        expect(markup).not.toContain("absolute bottom-2 right-2");
        expect(markup).not.toContain("drop-shadow(0_1px_2px_rgba(0,0,0,0.85))");
        expect(markup).not.toContain("bg-white/90");
        expect(markup).not.toContain("<figcaption");
        expect(markup).not.toContain(">引用素材<");
        expect(markup).not.toContain("border-stone-200 bg-stone-50");
        expect(markup).not.toContain("aspect-square");
    });

    it("keeps every media result in a compact wrapping group", () => {
        const message: CreativeMessage = {
            id: "message-many",
            conversationId: "conversation-one",
            sequence: 1,
            role: "assistant",
            status: "completed",
            content: "图片已生成。",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const asset = {
            id: "asset-one",
            userId: "user-one",
            conversationId: "conversation-one",
            messageId: message.id,
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "结果一",
            serverUrl: "/generated/one.png",
            width: 1920,
            height: 1080,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        } satisfies CreativeAsset;
        const markup = renderMessages(message, [asset, { ...asset, id: "asset-two", ordinal: 1, title: "结果二", serverUrl: "/generated/two.png" }]);

        expect(markup).toContain('alt="结果一"');
        expect(markup).toContain('alt="结果二"');
        expect(markup).toContain("max-w-[420px]");
        expect(markup).toContain("width:200px");
        expect(markup).toContain("max-[480px]:!w-[calc(50%-4px)]");
        expect(markup).toContain('aria-label="下载图片"');
    });

    it("groups a media run into a request-first creative record with real actions", () => {
        const userMessage: CreativeMessage = {
            id: "user-video",
            conversationId: "conversation-one",
            runId: "run-video",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "让参考图自然动起来",
            metadata: { assetIds: ["reference-one"] },
            createdAt: 1,
            updatedAt: 1,
        };
        const assistantMessage: CreativeMessage = {
            id: "assistant-video",
            conversationId: "conversation-one",
            runId: "run-video",
            sequence: 2,
            role: "assistant",
            status: "completed",
            content: "视频已生成。",
            metadata: {
                generation: {
                    coverUrl: "/video-cover.webp",
                    resolution: "1080p",
                    highlights: [
                        { type: "visual", title: "视频亮点", description: ["电影级画面质感", "多场景转场流畅"] },
                        { type: "rhythm", title: "镜头节奏", description: "开场铺垫 → 高潮展示 → 收尾" },
                    ],
                    scenes: [
                        { id: "scene-one", index: 1, start: 0, end: 5, thumbnail: "/scene-one.webp", title: "云海开场" },
                        { id: "scene-two", index: 2, start: 5, end: 10, thumbnail: "/scene-two.webp", title: "主角出场" },
                    ],
                },
            },
            createdAt: 1,
            updatedAt: 1,
        };
        const reference = {
            id: "reference-one",
            userId: "user-one",
            conversationId: "conversation-one",
            sourceRunId: "upload",
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "参考图",
            serverUrl: "/reference.webp",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        } satisfies CreativeAsset;
        const output = {
            ...reference,
            id: "video-one",
            messageId: assistantMessage.id,
            sourceRunId: "run-video",
            sourceTaskId: "task-video",
            type: "video",
            title: "生成视频",
            serverUrl: "/video.mp4",
            width: 1920,
            height: 1080,
            durationMs: 10_000,
            metadata: { agentTaskId: "task-video" },
        } satisfies CreativeAsset;
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, assistantMessage]}
                    assets={[reference, output]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "run-video": {
                            id: "run-video",
                            conversationId: "conversation-one",
                            inputMessageId: userMessage.id,
                            assistantMessageId: assistantMessage.id,
                            status: "completed",
                            createdAt: 1_000,
                            updatedAt: 7_000,
                            requestedModelIds: ["seedance"],
                            generationPreferences: { mode: "video", video: { size: "16:9", quality: "720P", seconds: 10 } },
                            assetIds: [output.id],
                            tasks: [{ id: "task-video", title: "生成视频", type: "video", model: "seedance", optimizedPrompt: "人物自然转身，镜头平稳推进", ratio: "16:9", quality: "720P", seconds: 10, status: "completed" }],
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain('data-testid="creative-media-round"');
        expect(markup).toContain('data-testid="creative-round-request"');
        expect(markup).toContain('data-testid="creative-user-avatar"');
        expect(markup).toContain('data-testid="creative-result-group"');
        expect(markup).toContain('data-testid="creative-video-result"');
        expect(markup).toContain('data-testid="creative-video-player"');
        expect(markup).toContain('data-results-count="1"');
        expect(markup).toContain('data-rendered-width="520"');
        expect(markup).toContain('data-rendered-height="293"');
        expect(markup).toContain("space-y-5 sm:space-y-6");
        expect(markup).toContain("max-w-[640px]");
        expect(markup).toContain('aria-label="创作助手"');
        expect(markup).toContain("text-right");
        expect(markup).toContain("让参考图自然动起来");
        expect(markup).toContain('aria-label="复制输入内容"');
        expect(markup).toContain("已为你生成视频");
        expect(markup).toContain('aria-label="本轮创作参数"');
        expect(markup).toContain("16:9");
        expect(markup).toContain("720P");
        expect(markup).toContain("10秒");
        expect(markup).toContain('aria-label="生成耗时：6秒"');
        expect(markup).toContain("完成时间：");
        expect(markup).toContain('data-testid="creative-run-timing"');
        expect(markup).toContain('aria-label="查看本轮创作详细信息"');
        expect(markup).not.toContain(">复制提示词</button>");
        expect(markup).toContain("grid-cols-[94px_32px]");
        expect(markup).not.toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px]");
        expect(markup).not.toContain("重新编辑");
        expect(markup).not.toContain("再次生成");
        expect(markup).toContain("下载视频");
        expect(markup).toContain('aria-label="更多本轮创作操作"');
        expect(markup).toContain('preload="metadata"');
        expect(markup).toContain('aria-label="视频播放进度"');
        expect(markup).toContain('aria-label="全屏播放"');
        expect(markup).toContain("00:00 / 00:10");
        expect(markup).not.toContain("视频已生成。");
        expect(markup).not.toContain("更多生成结果");
        expect(markup).not.toContain("视频亮点");
        expect(markup).not.toContain("镜头分镜");
        expect(markup).not.toContain("lg:grid-cols-[minmax(0,420px)_minmax(0,480px)]");
        expect(markup).not.toContain("!bg-[#f0f2f4]");
        expect(markup).not.toContain("!bg-[#f7f6ff]");
        expect(markup).not.toContain("!text-[#5c5fff]");
        expect(markup).not.toContain("shadow-[0_4px_16px_rgba(32,36,42,0.04)]");
    });

    it.each([
        ["product_silhouette", "商品轮廓与原图不一致", "needs_review"],
        ["canvas_geometry", "画幅与本轮尺寸要求不一致", "needs_review"],
        ["protected_structure", "受保护的结构与原图不一致", "needs_review"],
        ["unmodified_region", "编辑范围外的内容未保持", "needs_review"],
        ["composition_lighting", "构图或光线需要调整", "needs_adjustment"],
    ] as const)("shows readable %s acceptance without a QA regeneration action", (failureKey, label, qualityStatus) => {
        const userMessage: CreativeMessage = {
            id: "review-user",
            conversationId: "conversation-one",
            runId: "review-run",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "把白底商品放进现代客厅",
            metadata: { assetIds: ["reference-product"] },
            createdAt: 1,
            updatedAt: 1,
        };
        const assistantMessage: CreativeMessage = {
            id: "review-assistant",
            conversationId: "conversation-one",
            runId: "review-run",
            sequence: 2,
            role: "assistant",
            status: "completed",
            content: "商品一致性验收未通过，请复核后重试。",
            metadata: {},
            createdAt: 2,
            updatedAt: 2,
        };
        const reference = {
            id: "reference-product",
            userId: "user-one",
            conversationId: "conversation-one",
            sourceRunId: "upload",
            ordinal: 0,
            type: "image",
            status: "ready",
            title: "商品白底图",
            serverUrl: "/reference-product.png",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        } satisfies CreativeAsset;
        const internalResult = {
            ...reference,
            id: "internal-result",
            messageId: assistantMessage.id,
            sourceRunId: "review-run",
            sourceTaskId: "image-task",
            title: "内部生成结果",
            serverUrl: "/internal-result.png",
            metadata: { agentTaskId: "image-task" },
            createdAt: 2,
            updatedAt: 2,
        } satisfies CreativeAsset;

        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, assistantMessage]}
                    assets={[reference, internalResult]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "review-run": {
                            id: "review-run",
                            conversationId: "conversation-one",
                            inputMessageId: userMessage.id,
                            assistantMessageId: assistantMessage.id,
                            status: qualityStatus === "needs_review" ? "paused" : "completed",
                            assetIds: qualityStatus === "needs_review" ? [] : [internalResult.id],
                            ecommerceQualityStatus: qualityStatus,
                            ecommerceQualityReview: { kind: qualityStatus === "needs_review" ? "hard_failure" : "needs_adjustment", failureKeys: [failureKey] },
                            tasks: [
                                {
                                    id: "image-task",
                                    title: "生成商品场景图",
                                    type: "image",
                                    status: "completed",
                                },
                            ],
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    onAdjustRequest={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain('alt="商品白底图"');
        expect(markup).toContain("商品一致性验收未通过，请复核后重试。");
        if (qualityStatus === "needs_review") {
            expect(markup).not.toContain("/internal-result.png");
            expect(markup).not.toContain('data-testid="creative-media-result"');
        } else {
            expect(markup).toContain("/internal-result.png");
            expect(markup).toContain('data-testid="creative-media-result"');
        }
        expect(markup).toContain(label);
        expect(markup).toContain(qualityStatus === "needs_review" ? "待复核" : "需要调整");
        expect(markup).not.toContain("已为你生成");
        expect(markup).toContain('data-testid="creative-quality-review"');
        expect(markup).not.toContain('aria-label="重新生成未通过的商品图"');
        expect(markup).toContain('aria-label="调整本轮创作要求"');
    });

    it.each(["hard_failure", "check_unavailable", "needs_adjustment"] as const)("keeps delivered media usable when advisory %s arrives", (kind) => {
        const userMessage: CreativeMessage = { id: "advisory-user", conversationId: "conversation-one", runId: "advisory-run", sequence: 1, role: "user", status: "completed", content: "参考光线修改商品场景", metadata: {}, createdAt: 1, updatedAt: 1 };
        const assistantMessage: CreativeMessage = { ...userMessage, id: "advisory-assistant", sequence: 2, role: "assistant", content: "图片已生成。" };
        const result: CreativeAsset = { ...mediaAsset("advisory-result"), messageId: assistantMessage.id, sourceRunId: userMessage.runId, sourceTaskId: "image-task", metadata: { agentTaskId: "image-task" } };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, assistantMessage]}
                    assets={[result]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "advisory-run": {
                            id: "advisory-run",
                            conversationId: userMessage.conversationId,
                            inputMessageId: userMessage.id,
                            assistantMessageId: assistantMessage.id,
                            status: "completed",
                            assetIds: [result.id],
                            ecommerceQualityStatus: "needs_adjustment",
                            ecommerceQualityReview: { kind, advisory: true, failureKeys: ["protected_structure"] },
                            tasks: [{ id: "image-task", title: "商品场景图", type: "image", status: "completed" }],
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    onAdjustRequest={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );
        expect(markup).toContain('data-testid="creative-media-result"');
        expect(markup).toContain("/advisory-result.png");
        expect(markup).toContain("下载");
        expect(markup).toContain('aria-label="更多本轮创作操作"');
        expect(markup).toContain("参考建议");
        expect(markup).toContain("已为你生成图片");
        expect(markup).not.toContain(">需要调整<");
        expect(markup).toContain("图片已交付，可下载、引用或继续编辑");
        expect(markup).not.toContain('data-testid="creative-generation-waiting"');
        expect(markup).not.toContain("待复核");
        expect(markup).not.toContain("未作为合格作品发布");
        if (kind === "check_unavailable") {
            expect(markup).toContain("视觉质检暂时不可用，图片已交付");
            expect(markup).not.toContain("受保护的结构与原图不一致");
        }
    });

    it("uses a warm elapsed-time status while a media result is still running", () => {
        const now = Date.now();
        const userMessage: CreativeMessage = {
            id: "waiting-user",
            conversationId: "conversation-one",
            runId: "waiting-run",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "生成一张海边照片",
            metadata: {},
            createdAt: now,
            updatedAt: now,
        };
        const assistantMessage: CreativeMessage = {
            id: "waiting-assistant",
            conversationId: "conversation-one",
            runId: "waiting-run",
            sequence: 2,
            role: "assistant",
            status: "running",
            content: "正在处理「图片生成」",
            metadata: {},
            createdAt: now,
            updatedAt: now,
        };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, assistantMessage]}
                    assets={[]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "waiting-run": {
                            id: "waiting-run",
                            conversationId: "conversation-one",
                            inputMessageId: userMessage.id,
                            assistantMessageId: assistantMessage.id,
                            status: "running",
                            generationPreferences: { mode: "image", image: { size: "1:1", quality: "high" } },
                            assetIds: [],
                            tasks: [{ id: "image-task", title: "图片生成", type: "image", status: "running" }],
                            createdAt: now,
                            updatedAt: now,
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain('data-testid="creative-generation-waiting"');
        expect(markup).toContain("主人，画面正在一点点显现");
        expect(markup).toContain("已等待");
        expect(markup).not.toContain("已为你生成图片");
        expect(markup).not.toContain("正在处理「图片生成」");
    });

    it("restores the original text before retrying an initial submission failure", () => {
        const userMessage: CreativeMessage = {
            id: "temporary-user",
            conversationId: "pending",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "生成一张商品图",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const message: CreativeMessage = {
            id: "temporary-assistant",
            conversationId: "pending",
            sequence: 2,
            role: "assistant",
            status: "failed",
            content: "创作请求失败",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, message]}
                    assets={[]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{}}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain("直接重试");
        expect(markup).toContain('aria-label="直接重试本次创作"');
    });

    it("offers an explicit retry when Agent planning finished with an uncertain result", () => {
        const userMessage: CreativeMessage = {
            id: "user-message",
            conversationId: "conversation-one",
            runId: "run-one",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "生成一张海报",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const message: CreativeMessage = {
            id: "assistant-message",
            conversationId: "conversation-one",
            runId: "run-one",
            sequence: 2,
            role: "assistant",
            status: "failed",
            content: "Agent 规划请求结果待确认",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, message]}
                    assets={[]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "run-one": {
                            id: "run-one",
                            conversationId: "conversation-one",
                            inputMessageId: "user-message",
                            assistantMessageId: message.id,
                            status: "failed",
                            assetIds: [],
                            tasks: [],
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain("直接重试");
        expect(markup).toContain('aria-label="直接重试本次创作"');
    });

    it("keeps failed media feedback under the single assistant logo", () => {
        const userMessage: CreativeMessage = {
            id: "failed-user",
            conversationId: "conversation-one",
            runId: "failed-run",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "生成一段视频",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const assistantMessage: CreativeMessage = {
            id: "failed-assistant",
            conversationId: "conversation-one",
            runId: "failed-run",
            sequence: 2,
            role: "assistant",
            status: "failed",
            content: "模型请求失败",
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const markup = renderToStaticMarkup(
            <App>
                <CreativeMessages
                    messages={[userMessage, assistantMessage]}
                    assets={[]}
                    loading={false}
                    projectLinks={{}}
                    projectErrors={{}}
                    runDetails={{
                        "failed-run": {
                            id: "failed-run",
                            conversationId: "conversation-one",
                            inputMessageId: userMessage.id,
                            assistantMessageId: assistantMessage.id,
                            status: "failed",
                            generationPreferences: { mode: "video" },
                            assetIds: [],
                            tasks: [],
                        },
                    }}
                    onMaterializeProject={async () => {
                        throw new Error("not used");
                    }}
                    onRetryMessage={vi.fn()}
                    selectedAssetIds={[]}
                    onToggleAsset={vi.fn()}
                />
            </App>,
        );

        expect(markup).toContain('data-testid="creative-generation-failure"');
        expect((markup.match(/aria-label="创作助手"/g) || []).length).toBe(1);
        expect((markup.match(/data-testid="creative-assistant-avatar"/g) || []).length).toBe(1);
        expect(markup).toContain('aria-label="直接重试本次创作"');
        expect(markup).toContain("直接重试");
        const failureMarkup = markup.slice(markup.indexOf('data-testid="creative-generation-failure"'));
        expect(failureMarkup).not.toContain("size-12");
        expect(failureMarkup).not.toContain("Sparkles");
    });

    it("uses the same compact identity spacing for ordinary text messages", () => {
        const markup = renderMessages(
            {
                id: "text-user",
                conversationId: "conversation-one",
                sequence: 1,
                role: "user",
                status: "completed",
                content: "你做什么的",
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
            },
            [],
            {
                id: "text-assistant",
                conversationId: "conversation-one",
                sequence: 2,
                role: "assistant",
                status: "completed",
                content: "我是创作助手。",
                metadata: {},
                createdAt: 2,
                updatedAt: 2,
            },
        );

        expect(markup).toContain('data-testid="creative-assistant-avatar"');
        expect(markup).toContain("size-11");
        expect(markup).toContain("!size-8");
        expect(markup).toContain("rounded-[14px]");
        expect(markup).toContain("bg-[linear-gradient(135deg,#f3f1ff_0%,#ebeaff_100%)]");
        expect(markup).toContain("1970");
        expect(markup).toContain('aria-label="复制输入内容"');
        expect(markup).toContain('aria-label="复制消息"');
        expect(markup).not.toContain('aria-label="编辑消息"');
        expect(markup).not.toContain("直接重试");
    });
});

function renderMessages(message: CreativeMessage, assets: CreativeAsset[] = [], ...additionalMessages: CreativeMessage[]) {
    return renderToStaticMarkup(
        <App>
            <CreativeMessages
                messages={[message, ...additionalMessages]}
                assets={assets}
                loading={false}
                projectLinks={{}}
                projectErrors={{}}
                runDetails={{}}
                onMaterializeProject={async () => {
                    throw new Error("not used");
                }}
                onRetryMessage={vi.fn()}
                selectedAssetIds={[]}
                onToggleAsset={vi.fn()}
            />
        </App>,
    );
}

function mediaAsset(id: string): CreativeAsset {
    return {
        id,
        userId: "user",
        conversationId: "conversation-one",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: id,
        serverUrl: `/${id}.png`,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}
