import { describe, expect, it } from "vitest";

import { classifyGenerationError, DEFAULT_CHANNEL_CONNECT_ERROR, generationErrorCategoryLabel, toSafeGenerationErrorMessage } from "./generation-errors";

describe("generation error messages", () => {
    it("keeps actionable business errors", () => {
        expect(toSafeGenerationErrorMessage(new Error("当前用户视频任务已达到并发上限"), "视频生成失败")).toBe("当前用户视频任务已达到并发上限");
        expect(toSafeGenerationErrorMessage(new Error('{"code":400,"data":null,"msg":"人民币余额不足，无法生成"}'), "生成失败")).toBe("人民币余额不足，请先充值后再生成。");
        expect(toSafeGenerationErrorMessage(new Error('{"error":{"message":"MetaJing video requests must use application/json"}}'), "生成失败")).toBe("当前参数不符合模型要求，请调整后重试。");
    });

    it("turns upstream provider failures into consumer-facing guidance", () => {
        expect(toSafeGenerationErrorMessage(new Error("Service temporarily unavailable"), "生成失败")).toBe("当前模型暂不可用，请切换模型或稍后重试。");
        expect(toSafeGenerationErrorMessage(new Error("Upstream access forbidden, please contact administrator"), "生成失败")).toBe("当前模型暂不可用，请切换模型或稍后重试。");
        expect(toSafeGenerationErrorMessage(new Error("Invalid token"), "生成失败")).toBe("当前模型渠道暂时无法使用，请联系管理员。");
    });

    it("classifies common log failures instead of grouping them as unsupported", () => {
        expect(classifyGenerationError(new Error("Invalid token"))).toBe("auth");
        expect(classifyGenerationError(new Error("AI 模型渠道鉴权失败，请管理员检查 API Key 和模型权限。"))).toBe("auth");
        expect(classifyGenerationError(new Error("model gpt-image-2-4k not found"))).toBe("model_not_found");
        expect(classifyGenerationError(new Error('invalid image size: edges must be multiples of 16'))).toBe("parameter");
        expect(classifyGenerationError(new Error("请上传你提到的参考图片"))).toBe("reference");
        expect(classifyGenerationError(new Error("任务已取消"))).toBe("cancelled");
        expect(classifyGenerationError(new Error("内容政策拒绝"))).toBe("moderation");
        expect(generationErrorCategoryLabel("quota")).toBe("余额或上游额度不足");
    });

    it("does not expose infrastructure addresses or environment names", () => {
        expect(toSafeGenerationErrorMessage(new Error("POST http://localhost:3000 failed"), "生成失败")).toBe("当前模型暂不可用，请切换模型或联系客服。");
        expect(toSafeGenerationErrorMessage(new Error("参考图需要公网图片 URL，请配置 NEXT_PUBLIC_SITE_URL"), "生成失败")).toBe("参考素材暂时无法提交，请重新上传或稍后重试。");
        expect(toSafeGenerationErrorMessage(new Error("<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>"), "生成失败")).toBe(DEFAULT_CHANNEL_CONNECT_ERROR);
    });

    it("does not mislabel an uncertain upstream submission as a missing reference", () => {
        expect(toSafeGenerationReviewReason(new GenerationSubmissionUncertainError("参考图处理失败：https://provider.example/images/edits"), "图片任务创建结果未知")).toBe(UNKNOWN_SUBMISSION_REVIEW_ERROR);
    });
});
