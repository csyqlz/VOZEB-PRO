import { describe, expect, it } from "vitest";
import type { CreativeConversationContext } from "@/lib/creative-runtime-contract";
import type { AgentRunTask } from "./agent-run-store";
import { withDirectAgentExecutionContext } from "./agent-run-direct-context";

describe("withDirectAgentExecutionContext", () => {
    it("adds conversation history only to the private execution prompt", () => {
        const tasks = withDirectAgentExecutionContext([task()], "chat", undefined, conversation());

        expect(tasks[0]?.optimizedPrompt).toBe("把它改成夜景");
        expect(tasks[0]?.prompt).toContain("把它改成夜景");
        expect(tasks[0]?.prompt).toContain("上一轮确定使用红色跑车");
        expect(tasks[0]?.prompt).toContain("保持同一个主体");
    });

    it("includes the drama project snapshot without changing the public prompt", () => {
        const tasks = withDirectAgentExecutionContext([task()], "drama", { currentStage: "storyboard", episode: { title: "第一集" }, characters: [{ name: "林夏" }] }, emptyConversation());

        expect(tasks[0]?.optimizedPrompt).toBe("把它改成夜景");
        expect(tasks[0]?.prompt).toContain('"currentStage":"storyboard"');
        expect(tasks[0]?.prompt).toContain('"name":"林夏"');
    });

    it("returns the original task array when chat has no previous context", () => {
        const input = [task()];
        expect(withDirectAgentExecutionContext(input, "chat", undefined, emptyConversation())).toBe(input);
    });
});

function task(): AgentRunTask {
    return { id: "image", title: "图片", type: "image", optimizedPrompt: "把它改成夜景", prompt: "把它改成夜景", count: 1, dependencies: [], status: "ready", attempts: 0 };
}

function conversation(): CreativeConversationContext {
    return {
        summary: "上一轮确定使用红色跑车",
        summaryThroughSequence: 1,
        recentMessages: [
            {
                id: "message",
                conversationId: "conversation",
                sequence: 2,
                role: "user",
                status: "completed",
                content: "保持同一个主体",
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
            },
        ],
    };
}

function emptyConversation(): CreativeConversationContext {
    return { summary: "", summaryThroughSequence: 0, recentMessages: [] };
}
