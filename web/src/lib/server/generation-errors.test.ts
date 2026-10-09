import { describe, expect, it } from "vitest";

import { GenerationSubmissionUncertainError } from "./generation-submission-error";
import { DEFAULT_CHANNEL_CONNECT_ERROR, IMAGE_DIMENSION_ERROR, MODEL_NOT_CONFIGURED_ERROR, UNKNOWN_SUBMISSION_REVIEW_ERROR, UPSTREAM_MEDIA_ACCESS_ERROR, toSafeGenerationErrorMessage, toSafeGenerationReviewReason } from "./generation-errors";

describe("generation error messages", () => {
    it("keeps actionable business errors", () => {
        expect(toSafeGenerationErrorMessage(new Error("当前用户视频任务已达到并发上限"), "视频生成失败")).toBe("当前用户视频任务已达到并发上限");
        expect(toSafeGenerationErrorMessage(new Error('{"code":400,"data":null,"msg":"积分不足，无法生成"}'), "生成失败")).toBe("积分不足");
        expect(toSafeGenerationErrorMessage(new Error('{"error":{"message":"MetaJing video requests must use application/json"}}'), "生成失败")).toBe("MetaJing video requests must use application/json");
    });

    it("does not relabel upstream quota or rate-limit errors as local points", () => {
        const upstreamQuotaMessage = "上游模型额度不足或请求过于频繁，请检查模型服务账号余额、Key 权限或稍后重试。";
        expect(toSafeGenerationErrorMessage(new Error("文本模型渠道请求过于频繁或额度不足（HTTP 429）"), "规划渠道调用失败")).toBe(upstreamQuotaMessage);
        expect(toSafeGenerationErrorMessage(new Error('{"error":{"message":"余额不足，请充值","type":"invalid_request_error"}}'), "规划渠道调用失败")).toBe(upstreamQuotaMessage);
        expect(toSafeGenerationErrorMessage(new Error('{"error":{"message":"Insufficient Balance","type":"invalid_request_error"}}'), "规划渠道调用失败")).toBe(upstreamQuotaMessage);
    });

    it("does not expose infrastructure addresses or environment names", () => {
        expect(toSafeGenerationErrorMessage(new Error("POST http://localhost:3000 failed"), "生成失败")).toBe(DEFAULT_CHANNEL_CONNECT_ERROR);
        expect(toSafeGenerationErrorMessage(new Error("参考图需要公网图片 URL，请配置 NEXT_PUBLIC_SITE_URL"), "生成失败")).toBe("参考素材暂时无法提交给当前生成渠道，请重新上传或稍后重试。");
        expect(toSafeGenerationErrorMessage(new Error("<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>"), "生成失败")).toBe(DEFAULT_CHANNEL_CONNECT_ERROR);
    });

    it("returns actionable messages for image generation provider errors", () => {
        expect(toSafeGenerationErrorMessage(new Error("width should be less than 2048"), "图片生成失败")).toBe(IMAGE_DIMENSION_ERROR);
        expect(toSafeGenerationErrorMessage(new Error("「肥胖橘猫进食广告主视觉」：上游图片无法通过授权媒体路径读取"), "图片生成失败")).toBe(UPSTREAM_MEDIA_ACCESS_ERROR);
        expect(toSafeGenerationErrorMessage(new Error("后台尚未配置可用的默认图片模型"), "图片生成失败")).toBe(MODEL_NOT_CONFIGURED_ERROR);
        expect(toSafeGenerationErrorMessage(new Error("content policy violation"), "图片生成失败")).toBe("内容未通过模型安全审核，请调整提示词或参考素材后重试。");
        expect(toSafeGenerationErrorMessage(new Error("unsupported image format"), "图片生成失败")).toBe("参考图片格式暂不支持，请换成 PNG 或 JPG 后重试。");
    });

    it("does not mislabel an uncertain upstream submission as a missing reference", () => {
        expect(toSafeGenerationReviewReason(new GenerationSubmissionUncertainError("参考图处理失败：https://provider.example/images/edits"), "图片任务创建结果未知")).toBe(UNKNOWN_SUBMISSION_REVIEW_ERROR);
    });
});
