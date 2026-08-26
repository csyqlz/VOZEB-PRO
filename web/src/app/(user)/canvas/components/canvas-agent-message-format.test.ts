import { describe, expect, it } from "vitest";
import { formatAgentMessageText, friendlyAgentError } from "@/components/agent/agent-message-format";

describe("Canvas Agent 消息清理", () => {
    it("hides upstream JSON errors", () => {
        expect(formatAgentMessageText('{"error":{"message":"not available","code":"convert_request_failed"}}')).toBe("当前模型暂不可用，请切换模型或稍后重试。");
        expect(formatAgentMessageText('{"error":{"message":"/backend-api/conversation failed: status=422, body="}}')).toBe("当前模型不支持这组参数，请调整参数或切换模型。");
        expect(formatAgentMessageText("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>")).toBe("当前模型暂不可用，请切换模型或稍后重试。");
    });

    it("shows actionable point errors from provider-safe JSON envelopes", () => {
        expect(formatAgentMessageText('{"error":"积分不足，当前余额 0，需要 1"}')).toBe("人民币余额不足，请先充值后再生成。");
        expect(friendlyAgentError('{"error":{"message":"积分不足，当前余额 2，需要 3"}}')).toBe("人民币余额不足，请先充值后再生成。");
    });

    it("shows a safe fix for protocol mismatches", () => {
        expect(formatAgentMessageText('{"error":{"message":"MetaJing video requests must use application/json"}}')).toBe("当前模型暂不可用，请切换模型或联系客服。");
    });

    it("replaces legacy task internals", () => {
        expect(formatAgentMessageText("正在执行任务 task-0（第 3 次）…")).toBe("正在执行创作任务…");
        expect(friendlyAgentError("任务依赖无法继续执行")).toBe("部分创作任务未能完成，请调整需求后重试。");
    });

    it("collapses legacy text-only completion messages to the actual result", () => {
        expect(formatAgentMessageText("已完成 1 个创作任务。\n\n「品牌口号」已完成：\n**声创未来**\n\n- 很长的解释")).toBe("声创未来");
    });

    it("hides legacy per-task media completion lines", () => {
        expect(formatAgentMessageText("已完成 3 个创作任务。\n\n「肖像版」已生成。\n\n「生活方式版」已生成。\n\n「电影感版」已生成。")).toBe("已完成 3 个创作任务。");
    });

    it("removes historical planning details from visible chat", () => {
        expect(formatAgentMessageText("我会直接调整当前画面。\n\n我的选择：\n- 模型：gpt-image\n\n已安排 1 个任务")).toBe("我会直接调整当前画面。");
    });
});
