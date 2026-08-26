import { describe, expect, it } from "vitest";
import { resolveDramaPlannerSnapshot } from "./agent-context-resolver";

describe("agent context resolver", () => {
    it("keeps only the active drama episode instead of every episode payload", () => {
        const result = resolveDramaPlannerSnapshot({
            id: "project-one",
            title: "短剧",
            summary: "摘要",
            style: "电影感",
            ratio: "9:16",
            activeEpisodeId: "episode-two",
            episodes: [
                { id: "episode-one", title: "第一集", script: "旧剧本", shots: [{ id: "old-shot" }] },
                { id: "episode-two", title: "第二集", script: "当前剧本", shots: [{ id: "current-shot" }], scriptRichContent: { huge: true } },
            ],
            characters: [{ id: "character-one" }],
            unrelated: "不要发送",
        });

        expect(result).toMatchObject({ project: { id: "project-one", title: "短剧" }, episode: { id: "episode-two", script: "当前剧本", shots: [{ id: "current-shot" }] }, characters: [{ id: "character-one" }] });
        expect(result).not.toHaveProperty("episodes");
        expect(result).not.toHaveProperty("unrelated");
        expect(result.episode).not.toHaveProperty("scriptRichContent");
    });

    it("preserves non-project planner fixtures", () => {
        expect(resolveDramaPlannerSnapshot({ episodeId: "episode-one", field: "value" })).toEqual({ episodeId: "episode-one", field: "value" });
    });

    it("uses a current-turn episode projection only when it belongs to the active project episode", () => {
        const result = resolveDramaPlannerSnapshot({
            activeEpisodeId: "episode-one",
            episodes: [{ id: "episode-one", script: "已保存剧本" }],
            episode: { id: "episode-one", script: "刚编辑的剧本", shots: [{ id: "shot-one" }] },
        });

        expect(result.episode).toMatchObject({ id: "episode-one", script: "刚编辑的剧本", shots: [{ id: "shot-one" }] });
    });
});
