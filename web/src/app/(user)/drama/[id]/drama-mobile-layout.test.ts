import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("drama mobile list layout", () => {
    it("does not enable cached content sizing before the responsive breakpoint", async () => {
        const [page, generation] = await Promise.all([readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8"), readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-generation-panel.tsx"), "utf8")]);
        const source = `${page}\n${generation}`;

        expect(source).not.toMatch(/(?:^|[\s"])(?<!sm:)\[content-visibility:auto\]/m);
        expect(source).toContain("[content-visibility:visible]");
        expect(source).toContain("sm:[content-visibility:auto]");
    });

    it("uses the production workspace panels with responsive episode and Agent controls", async () => {
        const [page, sections, agent, elements, scriptWorkspace, episodeSettings, storyboardCard, frameEditor] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-project-sections.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-agent-panel.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-editor-elements.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-script-workspace.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-episode-settings.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-storyboard-shot-card.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-shot-frame-editor.tsx"), "utf8"),
        ]);

        expect(page).not.toContain("xl:grid-cols-[184px_minmax(0,1fr)_360px]");
        expect(page).toContain("data-drama-workspace-body");
        expect(page).toContain("data-drama-production-scroll");
        expect(page).toContain("<DramaEpisodeSidebar");
        expect(page).toContain("episodeNavigatorOpen={episodeNavigatorOpen}");
        expect(page).toContain("open={agentOpen}");
        expect(sections).toContain("data-drama-workspace-header");
        expect(sections).toContain("data-drama-stage-navigation");
        expect(page).toContain("<DramaGenerationPanel");
        expect(page).toContain("<DramaStageHeader");
        expect(sections).toContain('aria-label="短剧剧集导航"');
        expect(sections).toContain("data-drama-episode-sidebar");
        expect(sections).toContain("min-[1366px]:block");
        expect(sections).toContain("stageStatuses");
        expect(sections).toContain("待审核");
        expect(sections).toContain('aria-label="打开项目资产"');
        expect(sections).not.toContain('value: "assets"');
        expect(sections).toContain("assetsOpen");
        expect(sections).toContain("onOpenAssets");
        expect(page).toContain("open={episodeNavigatorOpen && !assetsOpen}");
        expect(page).toContain("setAssetsOpen(true)");
        expect(sections).toContain("data-drama-script-statusbar");
        expect(sections).toContain("data-drama-content-lifecycle");
        for (const step of ["创建任务", "排队接管", "读取原文", "结构提取", "合并校验", "保存项目", "完成"]) expect(sections).toContain(step);
        expect(sections).toContain('step="01"');
        expect(elements).toContain("data-drama-stage-metrics");
        expect(elements).toContain("border-l border-border/80");
        expect(page).toContain("data-drama-script-global-bar");
        expect(page).toContain("min-[1366px]:!pl-[210px]");
        expect(sections).toContain("w-[190px]");
        expect(sections).toContain("styles={{ container: { padding: 12, width: 320 } }}");
        expect(agent).toContain("size={360}");
        expect(agent).toContain("drama-agent-drawer");
        expect(agent).toContain('aria-label="项目 Agent"');
        expect(agent).toContain("data-drama-agent-panel-frame");
        expect(agent).toContain("useState(404)");
        expect(agent).toContain('aria-label="项目 Agent 面板"');
        expect(agent).toContain('aria-label="调整项目 Agent 面板宽度"');
        expect(sections).toContain("data-drama-agent-trigger");
        expect(page).not.toContain("data-drama-agent-handle");
        expect(sections).not.toContain(">Agent</span>");
        expect(page).toContain('episode.reviewStatus === "draft"');
        expect(page).toContain('updateEpisode(project.id, episode.id, { reviewStatus: "content_review" })');
        expect(page).toContain('setStage("review")');
        expect(agent).not.toContain("data-drama-right-workspace");
        expect(agent).not.toContain("DramaEpisodeSettings");
        expect(sections).not.toContain("<Tabs");
        expect(agent).toContain("activated");
        expect(agent).not.toContain("剧本右侧工作栏");
        expect(agent).toContain("destroyOnHidden={false}");
        expect(scriptWorkspace).not.toContain("<DramaEpisodeSettings");
        expect(scriptWorkspace).toContain("min-[1120px]:grid-cols-[200px_minmax(700px,1fr)]");
        expect(sections).not.toContain("min-[1366px]:!hidden");
        for (const label of ["分镜驱动", "直接生成", "参考图"]) {
            expect(episodeSettings).toContain(label);
            expect(storyboardCard).toContain(label);
        }
        expect(frameEditor).toContain("单帧");
        expect(frameEditor).toContain("首尾帧");
    });
});
