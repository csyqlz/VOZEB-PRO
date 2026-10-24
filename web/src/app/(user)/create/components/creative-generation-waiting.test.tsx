import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CreativeGenerationWaiting, creativeGenerationWaitingCopy, formatCreativeWaitingTime } from "./creative-generation-waiting";

describe("creative generation waiting", () => {
    it("offers resume only for the paused run with a resume action", () => {
        const run = { id: "run-one", conversationId: "conversation-one", inputMessageId: "user", assistantMessageId: "assistant", status: "paused" as const, assetIds: [], tasks: [] };
        const message = { content: "任务已暂停", createdAt: Date.now(), runId: run.id };
        expect(renderToStaticMarkup(<CreativeGenerationWaiting run={run} message={message} onResume={async () => undefined} />)).toContain("继续原任务");
        expect(renderToStaticMarkup(<CreativeGenerationWaiting run={run} message={message} />)).not.toContain("继续原任务");
        expect(renderToStaticMarkup(<CreativeGenerationWaiting run={{ ...run, status: "running" }} message={message} onResume={async () => undefined} />)).not.toContain("继续原任务");
    });

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
});
