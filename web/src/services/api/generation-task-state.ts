export type GenerationTaskExecutionState = {
    needsReview?: boolean;
    executionPhase?: string;
    reviewReason?: string;
};

export const GENERATION_TASK_NEEDS_REVIEW_MESSAGE = "生成状态暂时无法确认，系统已停止重复提交，请稍后重试或联系客服";

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
