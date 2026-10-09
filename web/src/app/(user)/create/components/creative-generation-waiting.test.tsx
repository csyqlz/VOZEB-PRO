import { describe, expect, it } from "vitest";

import { creativeGenerationWaitingCopy, creativeMediaLoadingSlots, formatCreativeWaitingTime } from "./creative-generation-waiting";

describe("creative generation waiting", () => {
    it("uses the real task phase before elapsed-time comfort copy", () => {
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "planning", progressText: "正在理解需求并选择合适的创作能力", elapsedSeconds: 180 })).toContain("画面的氛围和细节");
        expect(creativeGenerationWaitingCopy({ mode: "text", runStatus: "planning", progressText: "正在理解需求并选择合适的创作能力", elapsedSeconds: 180 })).toContain("想法理顺");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "planning", progressText: "正在理解需求并选择合适的创作能力", elapsedSeconds: 180 })).toContain("镜头");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "连接暂时中断，正在确认后台任务状态", elapsedSeconds: 180 })).toContain("任务仍在后台继续");
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "检查完成，正在整理结果", elapsedSeconds: 180 })).toContain("整理最后的细节");
    });

    it("adapts the comfort copy by media type and natural elapsed minutes", () => {
        expect(creativeGenerationWaitingCopy({ mode: "image", runStatus: "running", progressText: "正在处理创作任务", elapsedSeconds: 20 })).toContain("画面正在一点点显现");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "正在处理创作任务", elapsedSeconds: 20 })).toContain("镜头正在一帧帧铺开");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "仍在上游处理中", elapsedSeconds: 60 })).toContain("慢慢铺开");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "仍在上游处理中", elapsedSeconds: 120 })).toContain("久等了");
        expect(creativeGenerationWaitingCopy({ mode: "video", runStatus: "running", progressText: "仍在上游处理中", elapsedSeconds: 180 })).toContain("一帧帧渲染");
    });

    it("formats the actual elapsed time without an artificial upper limit", () => {
        expect(formatCreativeWaitingTime(42)).toBe("42秒");
        expect(formatCreativeWaitingTime(72)).toBe("1分12秒");
        expect(formatCreativeWaitingTime(3_661)).toBe("1小时1分1秒");
    });

    it("creates one independent loading slot for each pending image and video result", () => {
        const run = {
            id: "run",
            conversationId: "conversation",
            inputMessageId: "user",
            assistantMessageId: "assistant",
            status: "running" as const,
            assetIds: [],
            tasks: [
                { id: "images", title: "生成图片", type: "image" as const, model: "image-model", count: 3, status: "running" as const },
                { id: "videos", title: "生成视频", type: "video" as const, model: "video-model", count: 2, status: "running" as const },
            ],
        };

        const slots = creativeMediaLoadingSlots(run, [{ type: "image", status: "ready" }]);

        expect(slots).toHaveLength(4);
        expect(slots.map((slot) => slot.type)).toEqual(["image", "image", "video", "video"]);
        expect(slots.map((slot) => slot.model)).toEqual(["image-model", "image-model", "video-model", "video-model"]);
    });

    it("shows a generic loading slot before planning has created media tasks", () => {
        expect(creativeMediaLoadingSlots(undefined)).toEqual([{ key: "pending-planning", type: "planning", title: "正在规划创作" }]);
        expect(
            creativeMediaLoadingSlots({
                id: "planning-run",
                conversationId: "conversation",
                inputMessageId: "user",
                assistantMessageId: "assistant",
                status: "planning",
                assetIds: [],
                tasks: [],
            }),
        ).toEqual([{ key: "planning-run-planning", type: "planning", title: "正在规划创作" }]);
    });

    it("removes the last fallback loading slot after its result is ready", () => {
        const run = {
            id: "planning-run",
            conversationId: "conversation",
            inputMessageId: "user",
            assistantMessageId: "assistant",
            status: "running" as const,
            generationPreferences: { mode: "image" as const, image: { count: 1 } },
            assetIds: [],
            tasks: [],
        };

        expect(creativeMediaLoadingSlots(run, [{ type: "image", status: "ready" }])).toEqual([]);
    });

    it("does not render loading slots for a task waiting for manual review", () => {
        expect(
            creativeMediaLoadingSlots({
                id: "paused-run",
                conversationId: "conversation",
                inputMessageId: "user",
                assistantMessageId: "assistant",
                status: "paused",
                assetIds: [],
                tasks: [{ id: "video", title: "生成视频", type: "video", status: "needs_review", error: "视频协议最多支持 1 张参考图" }],
            }),
        ).toEqual([]);
    });
});
