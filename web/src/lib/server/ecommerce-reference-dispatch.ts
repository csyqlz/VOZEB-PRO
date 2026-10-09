import type { AgentRun } from "./agent-run-store";
import type { GenerationTaskContext } from "./generation-task-types";

export type EcommerceReferenceDispatchFence = {
    executionId: string;
    inputId: string;
    decisionId: string;
    analysisRequestId: string;
    copy: number;
};

export class EcommerceReferenceDispatchConflict extends Error {
    constructor() {
        super("参考任务派发身份已失效");
    }
}

// Called only while holding the same persisted parent lock used by recovery.
export function assertEcommerceReferenceDispatch(parent: AgentRun | undefined, userId: string, context: GenerationTaskContext, fence?: EcommerceReferenceDispatchFence) {
    const checkpoint = parent?.ecommerceSnapshot?.referenceCheckpoint;
    if (!checkpoint && !fence) return;
    const task = parent?.tasks.find((item) => item.id === context.parentTaskId);
    if (
        !parent ||
        !fence ||
        parent.userId !== userId ||
        parent.id !== context.runId ||
        parent.conversationId !== context.conversationId ||
        parent.status !== "running" ||
        parent.cancellation ||
        parent.executionId !== fence.executionId ||
        checkpoint?.version !== "ecommerce-reference-checkpoint.v1" ||
        checkpoint.state !== "resolved" ||
        checkpoint.inputId !== fence.inputId ||
        checkpoint.decisionId !== fence.decisionId ||
        checkpoint.analysisStage.requestId !== fence.analysisRequestId ||
        checkpoint.analysisStage.state !== "completed" ||
        task?.type !== "image" ||
        task.status !== "running" ||
        task.attempts !== context.attemptNo ||
        !Number.isSafeInteger(fence.copy) ||
        fence.copy < 1 ||
        fence.copy > task.count ||
        context.clientRequestId !== `${parent.clientRequestId}:${task.id}:${task.attempts}:${fence.copy}`
    )
        throw new EcommerceReferenceDispatchConflict();
}
