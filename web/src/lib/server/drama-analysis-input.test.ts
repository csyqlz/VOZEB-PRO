import { describe, expect, it } from "vitest";

import { normalizeDramaVisualInput, selectDramaVisualInput } from "./drama-analysis-input";

describe("normalizeDramaVisualInput", () => {
    it("keeps reviewed facts while removing duplicate episode and unreferenced asset data", () => {
        const longDescription = "镜头描述".repeat(2_500);
        const shots = Array.from({ length: 81 }, (_, index) => ({
            id: `shot-${index}`,
            title: `镜头 ${index}`,
            description: index === 80 ? longDescription : "描述",
            sourceText: "原文",
            duration: index === 80 ? 21 : 5,
            utterances: Array.from({ length: 101 }, (__, utteranceIndex) => ({ id: `utterance-${utteranceIndex}`, order: utteranceIndex + 1, type: "dialogue", speaker: "角色", text: `台词 ${utteranceIndex}` })),
            characterIds: Array.from({ length: 51 }, (__, relationIndex) => `character-${relationIndex}`),
            propIds: Array.from({ length: 51 }, (__, relationIndex) => `prop-${relationIndex}`),
            clueIds: Array.from({ length: 51 }, (__, relationIndex) => `clue-${relationIndex}`),
        }));
        const characters = Array.from({ length: 201 }, (_, index) => ({ id: `character-${index}`, name: `角色 ${index}`, description: index === 200 ? longDescription : "角色设定" }));

        const result = normalizeDramaVisualInput({
            phase: "visual",
            summary: longDescription,
            episode: { id: "episode-one", title: "第一集", outline: "大纲", script: longDescription, shots, renderTask: { id: "task-one" } },
            characters,
            shots,
        });

        expect(result.shotIds).toHaveLength(81);
        expect(result.payload.assets.characters).toHaveLength(51);
        expect(result.payload.shots[80]).toMatchObject({ description: longDescription, duration: 21 });
        expect(result.payload.shots[80].utterances).toHaveLength(101);
        expect(result.payload.shots[80].characterIds).toHaveLength(51);
        expect(result.payload.shots[80].propIds).toHaveLength(51);
        expect(result.payload.shots[80].clueIds).toHaveLength(51);
        expect(result.payload.project.summary).toBe(longDescription);
        expect(result.payload.episode).toEqual({ id: "episode-one", title: "第一集", outline: "大纲", hook: "", nextPreview: "", sourceRange: "" });
        expect(result.payload.episode).not.toHaveProperty("script");
        expect(result.payload.episode).not.toHaveProperty("shots");
        expect(result.payload.shots[80]).not.toHaveProperty("dialogue");
    });

    it("keeps only the shots and assets referenced by an adaptive visual batch", () => {
        const input = normalizeDramaVisualInput({
            phase: "visual",
            characters: [
                { id: "character-one", name: "角色一" },
                { id: "character-two", name: "角色二" },
            ],
            scenes: [
                { id: "scene-one", name: "场景一" },
                { id: "scene-two", name: "场景二" },
            ],
            shots: [
                { id: "shot-one", sourceText: "镜头一", characterIds: ["character-one"], sceneId: "scene-one" },
                { id: "shot-two", sourceText: "镜头二", characterIds: ["character-two"], sceneId: "scene-two" },
            ],
        });

        const batch = selectDramaVisualInput(input, ["shot-two"]);

        expect(batch.shotIds).toEqual(["shot-two"]);
        expect(batch.payload.shots.map((shot) => shot.id)).toEqual(["shot-two"]);
        expect(batch.payload.assets.characters.map((asset) => asset.id)).toEqual(["character-two"]);
        expect(batch.payload.assets.scenes.map((asset) => asset.id)).toEqual(["scene-two"]);
    });
});
