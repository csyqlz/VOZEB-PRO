import { describe, expect, it } from "vitest";

import { resolveGenerationReviewReason } from "./generation-task-review-reason";

describe("generation review reason", () => {
    it("prefers the persisted sanitized reason", () => {
        expect(resolveGenerationReviewReason({ executionPhase: "needs_review", lastUpstreamStatus: "submission_outcome_unknown", resultPayload: { reviewReason: "渠道返回内容无法确认" } })).toBe("渠道返回内容无法确认");
    });

    it("explains a legacy uncertain submission without implying it is safe to retry", () => {
        expect(resolveGenerationReviewReason({ executionPhase: "needs_review", lastUpstreamStatus: "submission_outcome_unknown" })).toContain("避免重复生成和扣费");
    });

    it("replaces the misleading reference warning for an uncertain submission", () => {
        expect(
            resolveGenerationReviewReason({
                executionPhase: "needs_review",
                lastUpstreamStatus: "submission_outcome_unknown",
                resultPayload: { reviewReason: "参考素材暂时无法提交给当前生成渠道，请重新上传或稍后重试。" },
            }),
        ).toContain("未取得可查询的任务 ID");
    });
});
