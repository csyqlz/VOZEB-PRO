import { describe, expect, it } from "vitest";
import { formatAgentMessageText, friendlyAgentError } from "@/components/agent/agent-message-format";

describe("Canvas Agent 消息清理", () => {
    it("hides upstream JSON errors", () => {
        expect(formatAgentMessageText('{"error":{"message":"not available","code":"convert_request_failed"}}')).toBe("当前模型暂不可用，请切换模型或稍后重试。");
        expect(formatAgentMessageText('{"error":{"message":"/backend-api/conversation failed: status=422, body="}}')).toBe("当前请求参数不被模型支持，请检查模型与生成参数。");
        expect(formatAgentMessageText("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>")).toBe("当前模型暂不可用，请切换模型或稍后重试。");
    });

    it("shows actionable point errors from provider-safe JSON envelopes", () => {
        expect(formatAgentMessageText('{"error":"积分不足，当前余额 0，需要 1"}')).toBe("积分不足");
        expect(friendlyAgentError('{"error":{"message":"积分不足，当前余额 2，需要 3"}}')).toBe("积分不足");
    });

    it("distinguishes upstream model quota errors from local point errors", () => {
        expect(formatAgentMessageText('{"error":{"message":"余额不足，请充值","type":"invalid_request_error"}}')).toBe("上游模型额度不足或请求过于频繁，请检查模型服务账号余额、Key 权限或稍后重试。");
        expect(friendlyAgentError("文本模型渠道请求过于频繁或额度不足（HTTP 429）")).toBe("上游模型额度不足或请求过于频繁，请检查模型服务账号余额、Key 权限或稍后重试。");
    });

    it("shows a safe fix for protocol mismatches", () => {
        expect(formatAgentMessageText('{"error":{"message":"MetaJing video requests must use application/json"}}')).toBe("当前视频渠道要求 application/json，请在后台选择匹配的内置协议，或使用自定义协议配置请求模板。");
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
