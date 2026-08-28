import { describe, expect, it } from "vitest";

import type { DramaContentAnalysis, DramaProject, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import { applyDramaContentAnalysisToProject, applyDramaVisualAnalysisToProject } from "./drama-analysis-project";

const project = {
    id: "drama-one",
    title: "短剧",
    summary: "",
    style: "",
    ratio: "9:16",
    status: "active",
    activeEpisodeId: "episode-one",
    characters: [],
    scenes: [],
    props: [],
    clues: [],
    defaultVideoMode: "direct",
    episodes: [{ id: "episode-one", title: "第 1 集", script: "剧本", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft", shots: [] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies DramaProject;

const content = {
    episode: { outline: "梗概", hook: "钩子", nextPreview: "预告", sourceRange: "全文" },
    characters: [{ name: "阿明", description: "主角" }],
    scenes: [{ name: "车站", description: "雨夜" }],
    props: [],
    clues: [],
    shots: [{ title: "相遇", description: "", sourceText: "阿明来到车站", shotBoundary: "场景开始", dialogue: "", narration: "", utterances: [], duration: 5, characterNames: ["阿明"], propNames: [], clueNames: [], sceneName: "车站" }],
} satisfies DramaContentAnalysis;

describe("drama analysis project projection", () => {
    it("writes content analysis with stable asset and shot identities", () => {
        const first = applyDramaContentAnalysisToProject(project, "episode-one", content);
        const replay = applyDramaContentAnalysisToProject(project, "episode-one", content);
        expect(first.episodes[0]).toMatchObject({ reviewStatus: "content_review", outline: "梗概" });
        expect(first.episodes[0].shots[0]).toMatchObject({ characterIds: [first.characters[0].id], sceneId: first.scenes[0].id });
        expect(replay.episodes[0].shots[0].id).toBe(first.episodes[0].shots[0].id);
        expect(replay.characters[0].id).toBe(first.characters[0].id);
    });

    it("writes the visual plan onto matching shots", () => {
        const contentProject = applyDramaContentAnalysisToProject(project, "episode-one", content);
        const shotId = contentProject.episodes[0].shots[0].id;
        const visual = {
            shots: [
                {
                    shotId,
                    imagePrompt: "画面",
                    videoPrompt: "动作",
                    cameraMotion: "推进",
                    startFramePrompt: "开始",
                    endFramePrompt: "结束",
                    negativePrompt: "水印",
                    continuity: {
                        shotSize: "中景",
                        cameraAngle: "平视",
                        composition: "居中",
                        characterBlocking: "站立",
                        gazeDirection: "前方",
                        actionStart: "静止",
                        actionEnd: "转身",
                        screenDirection: "左到右",
                        axisRule: "不越轴",
                        continuityNotes: "服装一致",
                    },
                },
            ],
        } satisfies DramaVisualAnalysis;
        const next = applyDramaVisualAnalysisToProject(contentProject, "episode-one", visual);
        expect(next.episodes[0]).toMatchObject({ reviewStatus: "visual_ready", shots: [expect.objectContaining({ imagePrompt: "画面", videoPrompt: "动作", cameraMotion: "推进" })] });
    });
});
