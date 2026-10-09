import { describe, expect, it } from "vitest";

import { GenerationSubmissionUncertainError } from "./generation-submission-error";
import { DEFAULT_CHANNEL_CONNECT_ERROR, UNKNOWN_SUBMISSION_REVIEW_ERROR, toSafeGenerationErrorMessage, toSafeGenerationReviewReason } from "./generation-errors";

describe("generation error messages", () => {
    it("keeps actionable business errors", () => {
        expect(toSafeGenerationErrorMessage(new Error("当前用户视频任务已达到并发上限"), "视频生成失败")).toBe("当前用户视频任务已达到并发上限");
        expect(toSafeGenerationErrorMessage(new Error('{"code":400,"data":null,"msg":"积分不足，无法生成"}'), "生成失败")).toBe("积分不足");
        expect(toSafeGenerationErrorMessage(new Error('{"error":{"message":"MetaJing video requests must use application/json"}}'), "生成失败")).toBe("MetaJing video requests must use application/json");
    });

    it("does not expose infrastructure addresses or environment names", () => {
        expect(toSafeGenerationErrorMessage(new Error("POST http://localhost:3000 failed"), "生成失败")).toBe(DEFAULT_CHANNEL_CONNECT_ERROR);
        expect(toSafeGenerationErrorMessage(new Error("参考图需要公网图片 URL，请配置 NEXT_PUBLIC_SITE_URL"), "生成失败")).toBe("参考素材暂时无法提交给当前生成渠道，请重新上传或稍后重试。");
        expect(toSafeGenerationErrorMessage(new Error("<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>"), "生成失败")).toBe(DEFAULT_CHANNEL_CONNECT_ERROR);
    });

    it("keeps safe upstream HTTP details while removing the host", () => {
        const error = new GenerationSubmissionUncertainError("图片生成失败，上游返回了网页错误（HTTP 502，地址 https://provider.example/v1/images/edits，类型 text/html; charset=UTF-8），请检查网关状态");

        expect(toSafeGenerationErrorMessage(error, "生成失败")).toBe("图片生成失败：上游接口 /v1/images/edits 返回 HTTP 502（text/html; charset=UTF-8）");
        expect(toSafeGenerationReviewReason(error, "生成失败")).toBe("图片生成失败：上游接口 /v1/images/edits 返回 HTTP 502（text/html; charset=UTF-8）；创建结果无法确认，为避免重复生成和扣费，系统已停止自动重试。");
    });

    it("does not mislabel an uncertain upstream submission as a missing reference", () => {
        expect(toSafeGenerationReviewReason(new GenerationSubmissionUncertainError("参考图处理失败：https://provider.example/images/edits"), "图片任务创建结果未知")).toBe(UNKNOWN_SUBMISSION_REVIEW_ERROR);
    });
});
