export type GenerationTaskExecutionState = {
    needsReview?: boolean;
    executionPhase?: string;
    lastUpstreamStatus?: string;
    reviewReason?: string;
};

export const GENERATION_TASK_NEEDS_REVIEW_MESSAGE = "上游任务状态待检查，系统不会重复创建，请点击“检查状态”继续追回结果";

export class GenerationTaskNeedsReviewError extends Error {
    constructor(reason?: string) {
        super(reason?.trim() || GENERATION_TASK_NEEDS_REVIEW_MESSAGE);
        this.name = "GenerationTaskNeedsReviewError";
    }
}

export function isGenerationTaskNeedsReviewError(error: unknown) {
    return error instanceof GenerationTaskNeedsReviewError || (error instanceof Error && error.message === GENERATION_TASK_NEEDS_REVIEW_MESSAGE);
}

export class GenerationTaskTerminalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GenerationTaskTerminalError";
    }
}

export function isGenerationTaskTerminalError(error: unknown) {
    return error instanceof GenerationTaskTerminalError;
}
