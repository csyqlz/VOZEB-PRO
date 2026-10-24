import { describe, expect, it } from "vitest";
import { agentRunCompletionReply, agentRunFailureMessage, agentTaskCompletionMessage } from "./agent-run-messages";
import type { AgentRun, AgentRunTask } from "./agent-run-store";

const task = (patch: Partial<AgentRunTask>): AgentRunTask => ({ id: "task", title: "任务", type: "text", prompt: "", count: 1, dependencies: [], status: "completed", attempts: 1, ...patch });

describe("Agent 返回文案", () => {
    it("returns generated text content to the chat", () => {
        expect(agentTaskCompletionMessage(task({ title: "文案", result: { content: "最终文案内容" } }))).toContain("最终文案内容");
    });

    it("returns the complete text conversation answer without a generation prefix", () => {
        const answer = "图表显示逐月增长。".repeat(300);
        expect(agentRunCompletionReply(agentRun({ surface: "chat", generationPreferences: { mode: "text" }, tasks: [task({ result: { content: answer } })] }))).toBe(answer);
    });

    it("summarizes media completion without exposing base64", () => {
        const image = task({ title: "主图", type: "image", result: { dataUrl: "data:image/png;base64,abc" } });
        const run = agentRun({ tasks: [image] });
        expect(agentRunCompletionReply(run)).toBe("已完成 1 个创作任务。\n\n「主图」已生成并返回画布。");
    });

    it("does not expose per-task media titles in chat completion", () => {
        const image = task({ title: "主图", type: "image", result: { url: "https://example.com/image.png" } });
        const detail = task({ id: "detail", title: "环境生活方式版", type: "image", result: { url: "https://example.com/detail.png" } });
        const reply = agentRunCompletionReply(agentRun({ surface: "chat", projectId: undefined, tasks: [image, detail] }));

        expect(reply).toBe("已完成 2 个创作任务。");
        expect(reply).not.toContain("主图");
        expect(reply).not.toContain("环境生活方式版");
    });

    it("keeps the visual review internal", () => {
        const image = task({ title: "主图", type: "image", result: { url: "https://example.com/image.png" } });
        const run = agentRun({
            tasks: [image],
            review: { mode: "visual", status: "passed", score: 91, summary: "主体、色彩和构图符合视觉方向", issues: [], retryTaskIds: [] },
        });

        expect(agentRunCompletionReply(run)).toBe("已完成 1 个创作任务。\n\n「主图」已生成并返回画布。");
        expect(agentRunCompletionReply(run)).not.toContain("视觉复盘");
        expect(agentRunCompletionReply(run)).not.toContain("91/100");
    });

    it("returns only the final text when the user explicitly asks for a text-only result", () => {
        const textTask = task({ title: "品牌口号", result: { content: "**声创未来**\n\n- 解释一\n- 解释二" } });
        const run = agentRun({ prompt: "生成四字口号，只需要文本产物", tasks: [textTask] });
        expect(agentRunCompletionReply(run)).toBe("声创未来");
    });

    it("recognizes conversational concise requests and enforces the requested character limit", () => {
        const textTask = task({ result: { content: "科技连接无限未来" } });
        const run = agentRun({ prompt: "直接给我6字以内答案，别啰嗦", tasks: [textTask] });
        expect(agentRunCompletionReply(run)).toBe("科技连接无限");
    });

    it("never cuts an emoji surrogate pair while shortening generated text", () => {
        const content = `${"字".repeat(1599)}😊后续`;
        const message = agentTaskCompletionMessage(task({ title: "长文", result: { content } }));

        expect(message).toContain(`${"字".repeat(1599)}😊`);
        expect(message).not.toMatch(/[\uD800-\uDFFF]/u);
    });

    it("keeps the final emoji intact in concise text results", () => {
        const content = `${"字".repeat(499)}😊后续`;
        const run = agentRun({ prompt: "只需要文本产物", tasks: [task({ result: { content } })] });

        expect(agentRunCompletionReply(run)).toBe(`${"字".repeat(499)}😊`);
        expect(agentRunCompletionReply(run)).not.toMatch(/[\uD800-\uDFFF]/u);
    });

    it("preserves the first failed task cause instead of replacing it with a dependency error", () => {
        expect(agentRunFailureMessage([task({ title: "辣妹图", status: "failed", error: "模型 gpt-image-2-4k 暂不可用" }), task({ title: "配套视频", status: "ready", dependencies: ["task"] })])).toContain("「辣妹图」：模型 gpt-image-2-4k 暂不可用");
    });

    it("reports partial image success and every failed result", () => {
        const partial = task({
            title: "角色图",
            type: "image",
            count: 3,
            status: "failed",
            error: "上游生成失败",
            childTasks: [
                { id: "one", status: "completed", attempt: 1, result: { url: "https://example.com/one.png" } },
                { id: "two", status: "failed", attempt: 1, error: "上游生成失败" },
                { id: "three", status: "failed", attempt: 1, error: "上游生成失败" },
            ],
        });

        expect(agentRunFailureMessage([partial])).toBe("生成结果：成功 1 张，失败 2 张。\n失败原因：\n「角色图」：上游生成失败");
    });
});

function agentRun(patch: Partial<AgentRun> = {}): AgentRun {
    return {
        id: "run",
        userId: "user",
        conversationId: "conversation",
        clientRequestId: "request",
        surface: "canvas",
        projectId: "project",
        inputMessageId: "input-message",
        assistantMessageId: "assistant-message",
        prompt: "",
        referencedAssetIds: [],
        assetIds: [],
        status: "completed",
        tasks: [],
        reviewed: true,
        createdAt: 1,
        updatedAt: 1,
        ...patch,
    };
}
