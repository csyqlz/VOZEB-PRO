import { describe, expect, it } from "vitest";

import { GenerationTaskRequestError, generationCapacityRetryDelayMs, isDefinitiveGenerationTaskRequestFailure, isGenerationCapacityError, readGenerationRetryAfterMs } from "./generation-task-request-error";

describe("generation task request errors", () => {
    it("treats capacity and rate-limit responses as recoverable", () => {
        expect(isGenerationCapacityError(new GenerationTaskRequestError("当前用户生图任务已达到并发上限", 429))).toBe(true);
        expect(isGenerationCapacityError(new Error("生图请求过于频繁，请稍后重试"))).toBe(true);
    });

    it("does not retry terminal request errors", () => {
        expect(isGenerationCapacityError(new GenerationTaskRequestError("任务参数不完整", 400))).toBe(false);
        expect(isGenerationCapacityError(new Error("上游模型不支持当前参数"))).toBe(false);
    });

    it("uses only the server Retry-After contract for automatic capacity retries", () => {
        expect(readGenerationRetryAfterMs(new Headers({ "Retry-After": "7" }))).toBe(7_000);
        expect(readGenerationRetryAfterMs(new Headers({ "Retry-After": "Mon, 17 Aug 2026 12:00:05 GMT" }), Date.parse("2026-08-17T12:00:00Z"))).toBe(5_000);
        expect(readGenerationRetryAfterMs(new Headers({ "Retry-After": "invalid" }))).toBeUndefined();
        expect(generationCapacityRetryDelayMs(new GenerationTaskRequestError("达到并发上限", 429, false, 7_000))).toBe(7_000);
        expect(generationCapacityRetryDelayMs(new GenerationTaskRequestError("达到并发上限", 429))).toBeUndefined();
    });

    it("only treats explicit non-transient 4xx responses as definitive submission failures", () => {
        expect(isDefinitiveGenerationTaskRequestFailure(new GenerationTaskRequestError("任务参数不完整", 400))).toBe(true);
        expect(isDefinitiveGenerationTaskRequestFailure(new GenerationTaskRequestError("等待原任务", 408))).toBe(false);
        expect(isDefinitiveGenerationTaskRequestFailure(new GenerationTaskRequestError("仍在处理", 425))).toBe(false);
        expect(isDefinitiveGenerationTaskRequestFailure(new GenerationTaskRequestError("请求过多", 429))).toBe(false);
        expect(isDefinitiveGenerationTaskRequestFailure(new GenerationTaskRequestError("服务暂不可用", 503))).toBe(false);
        expect(isDefinitiveGenerationTaskRequestFailure(new TypeError("网络连接中断"))).toBe(false);
    });
});
