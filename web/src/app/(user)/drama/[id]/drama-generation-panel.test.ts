import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Drama generation production workspace", () => {
    it("uses readiness, one primary action, grouped tools and an actionable compact empty state", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-generation-panel.tsx"), "utf8");

        expect(source).toContain("summarizeDramaGeneration");
        expect(source).toContain("data-drama-generation-readiness");
        expect(source).toContain("生成前检查");
        expect(source).toContain("主生成");
        expect(source).toContain("后期处理");
        expect(source).toContain("交付导出");
        expect(source).toContain("buildPrimaryAction");
        expect(source).toContain("onOpenAssets");
        expect(source).not.toContain("data-drama-generation-empty");
        expect(source).toContain('<section className="mt-2.5"');
        expect(source).not.toContain("<Empty");
        expect(source).not.toContain("sm:grid-cols-4");
        expect(source).toContain("costRefreshKey");
        expect(source).not.toContain("window.setInterval(load, 5000)");
        expect(source).toContain("data-drama-video-model");
        expect(source).toContain("DramaModelSelector");
        expect(source).not.toContain("data-drama-models");
        expect(source).toContain("data-drama-shot-video-model");
        expect(source).not.toContain("DramaDirectorPlanSelector");
        expect(source).toContain("imageValue={project.imageModel}");
        expect(source).toContain("videoValue={project.videoModel}");
        expect(source).toContain("onClearImage={() => updateProject(project.id, { imageModel: undefined })}");
        expect(source).toContain("onClearVideo={() => updateProject(project.id, { videoModel: undefined })}");
        expect(source).not.toContain("resolveModelChannel");
        expect(source).not.toContain("渠道");
        expect(source).toContain("publicModelLabel");
        expect(source).not.toContain("resolveModelChannel");
        expect(source).not.toContain("项目默认 ·");

        const shotRow = source.slice(source.indexOf("function ShotTaskRow"), source.indexOf("function ShotErrors"));
        expect(shotRow.indexOf("data-drama-shot-video-model")).toBeLessThan(shotRow.indexOf("动态提示词尚未填写"));
        expect(shotRow).toContain("sm:ml-auto sm:basis-auto");
        expect(shotRow).not.toContain("改用项目默认视频模型");
    });

    it("creates video attempts only from the resolved video model", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/page.tsx"), "utf8");

        expect(source).toContain("resolveDramaVideoModel(config, project, next)");
        expect(source).toContain("{ ...config, model: videoModel, videoModel");
        expect(source).toContain("generationModel: videoModel");
        expect(source).not.toContain("model: config.videoModel || config.model");
    });

    it("keeps shot task rows mobile-safe and exposes exact failure labels", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-generation-panel.tsx"), "utf8");

        expect(source).toContain("data-drama-shot-task-list");
        expect(source).toContain("data-drama-shot-task");
        expect(source).toContain("[content-visibility:visible]");
        expect(source).toContain("sm:[content-visibility:auto]");
        expect(source).toContain("分镜图：");
        expect(source).toContain("结束帧：");
        expect(source).toContain("视频：");
        expect(source).toContain("配音：");
    });

    it("uses the server capacity schedule instead of a fixed client retry delay", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/use-generation-capacity-retry.ts"), "utf8");

        expect(source).toContain("generationCapacityRetryDelayMs");
        expect(source).not.toContain("RETRY_DELAY_MS");
    });
});
