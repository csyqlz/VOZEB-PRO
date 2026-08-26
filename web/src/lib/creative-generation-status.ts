export const CREATIVE_GENERATION_STATUS = {
    running: "好的，正在按你的要求生成。",
    completed: "已完成，创作结果已生成。",
    insufficientPoints: "人民币余额不足",
    failed: "生成失败，请重试",
    cancelled: "已停止生成",
} as const;

type GenerationKind = "image" | "video" | "audio";

export function generationRunningMessage(kind?: GenerationKind) {
    return kind ? `好的，正在按你的要求生成${generationKindLabel(kind)}。` : CREATIVE_GENERATION_STATUS.running;
}

export function generationCompletedMessage(kind?: GenerationKind) {
    return kind ? `已完成，${generationKindLabel(kind)}已生成。` : CREATIVE_GENERATION_STATUS.completed;
}

export function compactGenerationFailure(value: unknown) {
    return hasInsufficientPointsError(value) ? CREATIVE_GENERATION_STATUS.insufficientPoints : CREATIVE_GENERATION_STATUS.failed;
}

export function compactGenerationStatus(status: "pending" | "success" | "failed" | "cancelled", error?: unknown, kind?: GenerationKind) {
    if (status === "pending") return generationRunningMessage(kind);
    if (status === "success") return generationCompletedMessage(kind);
    if (status === "cancelled") return CREATIVE_GENERATION_STATUS.cancelled;
    return compactGenerationFailure(error);
}

function generationKindLabel(kind: GenerationKind) {
    return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

export function hasInsufficientPointsError(value: unknown, depth = 0): boolean {
    if (depth > 4 || value === null || value === undefined) return false;
    if (typeof value === "string") {
        if (/积分不足|余额不足/.test(value)) return true;
        const text = value.trim();
        if (!text.startsWith("{") && !text.startsWith("[")) return false;
        try {
            return hasInsufficientPointsError(JSON.parse(text), depth + 1);
        } catch {
            return false;
        }
    }
    if (value instanceof Error) return hasInsufficientPointsError([value.message, value.cause], depth + 1);
    if (Array.isArray(value)) return value.some((item) => hasInsufficientPointsError(item, depth + 1));
    if (typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => hasInsufficientPointsError(item, depth + 1));
    return false;
}
