import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { AgentChatComposer } from "./canvas-agent-chat-ui";

const baseProps = {
    prompt: "换成紫毛",
    placeholder: "描述需求",
    theme: canvasThemes.light,
    onPromptChange: vi.fn(),
    onSubmit: vi.fn(),
};

describe("Canvas Agent image attachments", () => {
    it("renders the add-reference slot inside the input row instead of the bottom toolbar", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} onAddFiles={vi.fn()} />);

        expect(markup).toContain("data-canvas-agent-input-row");
        expect(markup).toContain('aria-label="添加参考素材"');
        expect(markup.indexOf('aria-label="添加参考素材"')).toBeLessThan(markup.indexOf("data-canvas-agent-toolbar"));
        expect(markup.slice(markup.indexOf("data-canvas-agent-toolbar"))).not.toContain('aria-label="添加参考素材"');
    });

    it("shows an immediate upload preview and blocks submission until it is ready", () => {
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} attachments={[{ id: "upload", name: "clipboard-image.png", url: "blob:preview", status: "uploading" }]} onAddFiles={vi.fn()} onRemoveAttachment={vi.fn()} />);

        expect(markup).toContain('aria-label="clipboard-image.png 上传中"');
        expect(markup).toContain('aria-label="正在上传图片"');
        expect(markup.indexOf('aria-label="clipboard-image.png 上传中"')).toBeLessThan(markup.indexOf("<textarea"));
        expect(markup).toMatch(/aria-label="发送"[^>]*disabled=""/);
    });

    it("keeps a failed preview in place with retry and remove actions", () => {
        const markup = renderToStaticMarkup(
            <AgentChatComposer {...baseProps} attachments={[{ id: "failed", name: "reference.png", url: "blob:failed", status: "failed", error: "上传失败" }]} onAddFiles={vi.fn()} onRetryAttachment={vi.fn()} onRemoveAttachment={vi.fn()} />,
        );

        expect(markup).toContain('aria-label="重试上传图片：reference.png"');
        expect(markup).toContain('aria-label="移除参考素材：reference.png"');
        expect(markup).toContain('title="上传失败"');
        expect(markup).toMatch(/aria-label="发送"[^>]*disabled=""/);
    });

    it.each(["light", "dark"] as const)("uses a compact themed remove badge in %s mode", (themeName) => {
        const theme = canvasThemes[themeName];
        const markup = renderToStaticMarkup(<AgentChatComposer {...baseProps} theme={theme} attachments={[{ id: "ready", name: "reference.png", url: "blob:ready", status: "ready" }]} onRemoveAttachment={vi.fn()} />);

        expect(markup).toContain("right-0 top-0");
        expect(markup).toContain("size-7");
        expect(markup).toContain("size-4");
        expect(markup).toContain("rounded-full");
        expect(markup).toContain(`--remove-surface:${theme.node.removeSurface}`);
        expect(markup).toContain(`--remove-border:${theme.node.removeBorder}`);
        expect(markup).toContain(`--remove-text:${theme.node.removeText}`);
        expect(markup).toContain(`--remove-hover-surface:${theme.node.dangerSurface}`);
        expect(markup).toContain("group-hover/remove:bg-[var(--remove-hover-surface)]");
        expect(markup).toContain("group-focus-visible/remove:bg-[var(--remove-hover-surface)]");
    });

    it("clips the scrolled @ reference preview inside the textarea", () => {
        const markup = renderToStaticMarkup(
            <AgentChatComposer {...baseProps} prompt="请基于 @图片1 生成视频" mentionAssets={[{ id: "image-one", title: "参考图", type: "image", url: "/api/reference-assets/permanent/reference.png" }]} selectedReferenceIds={["image-one"]} />,
        );

        const preview = markup.slice(markup.indexOf('data-testid="canvas-agent-mention-preview"'), markup.indexOf("<textarea"));
        expect(preview).toContain("absolute inset-0 z-0 overflow-hidden");
        expect(preview).toContain("data-canvas-agent-mention-scroll-layer");
        expect(preview.indexOf("overflow-hidden")).toBeLessThan(preview.indexOf("data-canvas-agent-mention-scroll-layer"));
    });
});
