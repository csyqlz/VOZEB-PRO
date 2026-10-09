import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { describe, expect, it, vi } from "vitest";

import { agentMediaDownloadName } from "./agent-media-download";
import { formatAgentArtifactText, formatAgentMessageText, friendlyAgentError } from "./agent-message-format";
import { agentMediaPreviewPopupStyles, AgentMediaPreview } from "./agent-media-preview";
import { AgentMessageActions } from "./agent-message-actions";

describe("agent message controls", () => {
    it("shows copy for every message and edit only for user messages", () => {
        const userActions = renderToStaticMarkup(
            <App>
                <AgentMessageActions text="生成一张海报" onEdit={vi.fn()} />
            </App>,
        );
        const assistantActions = renderToStaticMarkup(
            <App>
                <AgentMessageActions text="海报已经生成" downloads={[{ type: "image", url: "/generated/image.png", title: "生成图片" }]} />
            </App>,
        );

        expect(userActions).toContain('aria-label="复制消息"');
        expect(userActions).toContain('aria-label="编辑消息"');
        expect(assistantActions).toContain('aria-label="复制消息"');
        expect(assistantActions).toContain('aria-label="下载图片"');
        expect(assistantActions).not.toContain('aria-label="编辑消息"');
    });

    it("renders clickable image and video preview entries", () => {
        const onDimensions = vi.fn();
        const image = renderToStaticMarkup(
            <App>
                <AgentMediaPreview type="image" url="/generated/image.png" title="生成图片" fit="contain" onDimensions={onDimensions} />
            </App>,
        );
        const video = renderToStaticMarkup(
            <App>
                <AgentMediaPreview type="video" url="/generated/video.mp4" title="生成视频" fit="contain" />
            </App>,
        );

        expect(image).toContain("查看大图");
        expect(image).toContain('src="/generated/image.png"');
        expect(image).toContain("object-contain");
        expect(image).toContain("!size-full object-contain");
        expect(image).not.toContain("object-cover");
        expect(agentMediaPreviewPopupStyles.popup.root).toMatchObject({ position: "fixed", inset: 0, width: "100vw", height: "100dvh" });
        expect(agentMediaPreviewPopupStyles.popup.mask).toMatchObject({ position: "fixed", inset: 0 });
        expect(agentMediaPreviewPopupStyles.popup.body).toMatchObject({ position: "fixed", inset: 0, alignItems: "center", justifyContent: "center" });
        expect(image).not.toContain("rootClassName");
        expect(video).toContain('aria-label="打开视频：生成视频"');
        expect(video).toContain('src="/generated/video.mp4"');
        expect(video).toContain("object-contain");
        expect(video).not.toContain("object-cover");
    });

    it("builds safe download names and hides upstream JSON errors", () => {
        const imageName = agentMediaDownloadName("image", "小狗/竖版", "/generated/image.webp?token=1");
        const videoName = agentMediaDownloadName("video", "短片.mp4", "/generated/video.mp4");
        expect(imageName).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}\.png$/);
        expect(videoName).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}\.mp4$/);
        expect(agentMediaDownloadName("video", "短片", "/api/reference-assets/video.mp4", "video/quicktime")).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}\.mov$/);
        expect(agentMediaDownloadName("image", "海报.webp", "/api/reference-assets/image.webp", "image/png")).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}\.png$/);
        expect(imageName).not.toBe(videoName);
        expect(formatAgentMessageText('{"error":{"message":"/backend-anon/conversation failed: status=403"}}')).toBe("当前渠道鉴权失败，请管理员检查 API Key 和模型权限。");
        expect(formatAgentMessageText('{"error":{"message":"/backend-api/conversation failed: status=422, body="}}')).toBe("当前请求参数不被模型支持，请检查模型与生成参数。");
        expect(formatAgentMessageText('{"error":"当前渠道无法读取站内参考素材，请联系管理员检查站点部署地址"}')).toBe("参考图片暂时无法被上游模型读取，请重新上传图片，或使用公网可访问的图片地址后重试。");
        expect(formatAgentMessageText('{"code":400,"data":null,"msg":"积分不足，无法生成"}')).toBe("积分不足");
        expect(formatAgentMessageText('{"error":{"message":"余额不足，请充值","type":"invalid_request_error"}}')).toBe("上游模型额度不足或请求过于频繁，请检查模型服务账号余额、Key 权限或稍后重试。");
        expect(formatAgentMessageText('{"error":"request timeout"}')).toBe("模型响应超时，请稍后重试。");
        expect(formatAgentMessageText('{"error":"fetch failed: ECONNRESET"}')).toBe("模型服务连接失败，请稍后重试。");
        expect(formatAgentMessageText('{"error":"status=429"}')).toBe("请求过于频繁，请稍后重试。");
        expect(formatAgentMessageText('{"error":"width should be less than 2048"}')).toBe("当前图片尺寸超过模型限制，请把宽高调整到 1024×1024 或更小后重试。");
        expect(formatAgentMessageText('{"error":"「肥胖橘猫进食广告主视觉」：上游图片无法通过授权媒体路径读取"}')).toBe("参考图片暂时无法被上游模型读取，请重新上传图片，或使用公网可访问的图片地址后重试。");
        expect(friendlyAgentError("后台尚未配置可用的默认图片模型")).toBe("当前没有可用模型，请管理员检查默认模型和渠道配置。");
    });

    it("keeps generated text while removing upstream display directives", () => {
        expect(formatAgentMessageText("是的，我在呢！上一轮生成渠道暂时无法连接，现在可以重新生成。")).toBe("是的，我在呢！上一轮生成渠道暂时无法连接，现在可以重新生成。");
        expect(formatAgentMessageText('已完成 1 个创作任务。\n\n「狗提示词」已完成：\n:::writing{variant="document" id="58391"}\n一只温暖友善的狗，真实毛发，柔和自然光。\n:::\n可继续调整。')).toBe(
            "已完成 1 个创作任务。\n\n「狗提示词」已完成：\n\n一只温暖友善的狗，真实毛发，柔和自然光。\n\n可继续调整。",
        );
        expect(formatAgentArtifactText(':::writing{variant="document" id="58391" title="《潮汐写给远方的信》"}\n# 潮汐写给远方的信\n\n等你回来。:::')).toBe("# 潮汐写给远方的信\n\n等你回来。");
    });
});
