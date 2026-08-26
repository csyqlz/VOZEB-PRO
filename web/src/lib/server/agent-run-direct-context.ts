import type { CreativeConversationContext, CreativeSurface } from "@/lib/creative-runtime-contract";
import type { AgentRunTask } from "./agent-run-store";
import { canvasSnapshotPlannerView } from "./agent-run-canvas-snapshot";

export function withDirectAgentExecutionContext(tasks: AgentRunTask[], surface: CreativeSurface, snapshot: unknown, conversation: CreativeConversationContext): AgentRunTask[] {
    const context = buildDirectAgentExecutionContext(surface, snapshot, conversation);
    if (!context) return tasks;
    return tasks.map((task) => ({ ...task, prompt: `${task.prompt}\n\n${context}` }));
}

export function buildDirectAgentExecutionContext(surface: CreativeSurface, snapshot: unknown, conversation: CreativeConversationContext) {
    const conversationContext = {
        summary: conversation.summary.trim(),
        recentMessages: conversation.recentMessages.map((message) => ({ role: message.role, content: message.content, sequence: message.sequence })),
    };
    const surfaceContext = surface === "canvas" ? { canvasSnapshot: canvasSnapshotPlannerView(snapshot) } : surface === "drama" ? { projectSnapshot: record(snapshot) } : {};
    if (!conversationContext.summary && !conversationContext.recentMessages.length && !Object.keys(surfaceContext).length) return "";
    return `以下为内部执行上下文，只用于理解连续创作关系和指代；当前用户需求与本轮显式参数优先，不得把上下文原文作为公开回复或提示词输出：\n${JSON.stringify({ conversationContext, ...surfaceContext })}`;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
