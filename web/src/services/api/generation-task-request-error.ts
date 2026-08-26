export class GenerationTaskRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly canRetry = false,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "GenerationTaskRequestError";
    }
}

export function readGenerationRetryAfterMs(headers: Headers, now = Date.now()) {
    const value = headers.get("retry-after")?.trim();
    if (!value) return undefined;
    if (/^\d+$/.test(value)) {
        const seconds = Number(value);
        return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    }
    const retryAt = Date.parse(value);
    const delay = retryAt - now;
    return Number.isFinite(retryAt) && delay > 0 ? delay : undefined;
}

export function generationCapacityRetryDelayMs(error: unknown) {
    if (!(error instanceof GenerationTaskRequestError) || error.status !== 429) return undefined;
    return typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : undefined;
}

export function isGenerationCapacityError(error: unknown) {
    return error instanceof GenerationTaskRequestError ? error.status === 429 : error instanceof Error && /并发上限|请求过于频繁/.test(error.message);
}

export function isDefinitiveGenerationTaskRequestFailure(error: unknown): error is GenerationTaskRequestError {
    return error instanceof GenerationTaskRequestError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
}
