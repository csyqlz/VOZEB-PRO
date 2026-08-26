import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DramaAgentMentionPicker } from "./drama-agent-mention-picker";
import type { DramaAgentMentionItem } from "./drama-agent-mention";

describe("DramaAgentMentionPicker", () => {
    it("uses category tabs and initially renders only character names", () => {
        const markup = renderToStaticMarkup(<DramaAgentMentionPicker items={items} selectedIds={new Set()} onSelect={() => undefined} />);

        expect(markup).toContain('role="tablist"');
        expect(markup).toContain('aria-label="引用项目内容类型"');
        expect(markup).toContain('aria-selected="true"');
        expect(markup).toContain('data-drama-agent-mention-list="character"');
        expect(markup).toContain("赵徽");
        expect(markup).toContain("阎王");
        expect(markup).not.toContain("忘川河畔");
        expect(markup).not.toContain("孟婆汤");
    });

    it("renders image and video previews for project source mentions", () => {
        const markup = renderToStaticMarkup(<DramaAgentMentionPicker items={sourceItems} selectedIds={new Set()} onSelect={() => undefined} />);

        expect(markup).toContain('data-drama-agent-mention-list="source"');
        expect(markup).toContain('data-drama-agent-mention-media="image"');
        expect(markup).toContain('data-drama-agent-mention-media="video"');
        expect(markup).toContain("<img");
        expect(markup).toContain("<video");
    });
});

const items: DramaAgentMentionItem[] = [
    { id: "character-1", kind: "character", title: "赵徽", description: "", alias: "赵徽" },
    { id: "character-2", kind: "character", title: "阎王", description: "", alias: "阎王" },
    { id: "scene-1", kind: "scene", title: "忘川河畔", description: "", alias: "场景1" },
    { id: "prop-1", kind: "prop", title: "孟婆汤", description: "", alias: "道具1" },
];

const sourceItems: DramaAgentMentionItem[] = [
    { id: "source-image", kind: "source", title: "人物参考图", description: "image", alias: "来源1", preview: { type: "image", url: "/api/reference-assets/source-image" } },
    { id: "source-video", kind: "source", title: "动作参考视频", description: "video", alias: "来源2", preview: { type: "video", url: "/api/reference-assets/source-video.mp4" } },
];
