import { describe, expect, it } from "vitest";

import {
    describeDramaModelOutput,
    hasCompleteDramaContentAnalysis,
    hasCompleteDramaDialogueAttribution,
    hasUsableDramaToolArguments,
    normalizeDramaContentAnalysis,
    normalizeDramaVisualAnalysis,
    normalizeDramaToolArguments,
    readDramaChatArguments,
    readDramaResponsesArguments,
    readDramaUpstreamError,
} from "./drama-analysis";

describe("drama analysis contracts", () => {
    it("keeps content facts separate from visual prompts", () => {
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "大纲", hook: "钩子", nextPreview: "预告", sourceRange: "第一章" },
                characters: [{ name: "女主", description: "红衣", profile: { visualIdentity: "短发", styling: "红衣", colorPalette: "红黑", consistencyRules: "服装不变" } }],
                scenes: [{ name: "天台", description: "夜晚" }],
                props: [{ name: "钥匙", description: "铜钥匙" }],
                clues: [
                    { name: "", description: "空项", payoff: "错误回收" },
                    { name: "血迹", description: "门边血迹", payoff: "第三幕揭示" },
                ],
                shots: [
                    {
                        title: "发现",
                        description: "女主发现血迹",
                        sourceText: "她在门边看见一滴血。",
                        shotBoundary: "发现信息后切镜",
                        dialogue: "谁来过？",
                        narration: "",
                        utterances: [{ type: "dialogue", speaker: "女主", text: "谁来过？" }],
                        duration: 7,
                        characterNames: ["女主"],
                        sceneName: "天台",
                        propNames: ["钥匙"],
                        clueNames: ["血迹"],
                        imagePrompt: "不应进入内容结构",
                    },
                ],
            },
            5,
        );

        expect(result.clues).toEqual([expect.objectContaining({ name: "血迹", payoff: "第三幕揭示" })]);
        expect(result.characters[0]).toMatchObject({ profile: { visualIdentity: "短发", consistencyRules: "服装不变" } });
        expect(result.shots[0]).toMatchObject({ sourceText: "她在门边看见一滴血。", duration: 7, clueNames: ["血迹"] });
        expect(result.shots[0]).not.toHaveProperty("imagePrompt");
    });

    it("restores every direct line from the source script and rejects narrative summaries", () => {
        const script = ["一旁的女人再次开口：“俊成家的，你还好吗？”", "郁心妍闭着眼回了一句：“我没事，就是有些头晕。”", "“你等着，我这就去给你叫医生。”", "郁心妍刚想说：不用，她缓一下就没事了。"].join("\n");
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "大纲", hook: "钩子", nextPreview: "预告", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "病房问候",
                        description: "女人关心郁心妍的状态",
                        sourceText: "一旁的女人再次开口：“俊成家的，你还好吗？”",
                        shotBoundary: "问候后切镜",
                        dialogue: "女人说明自己关心郁心妍。",
                        narration: "",
                        utterances: [],
                        duration: 5,
                        characterNames: [],
                        sceneName: "",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            },
            5,
            script,
        );

        expect(result.shots.flatMap((shot) => shot.utterances.map((item) => item.text))).toEqual(["俊成家的，你还好吗？", "我没事，就是有些头晕。", "你等着，我这就去给你叫医生。", "不用，她缓一下就没事了。"]);
        expect(result.shots.flatMap((shot) => shot.utterances.map((item) => item.speaker)).slice(0, 2)).toEqual(["女人", "郁心妍"]);
        expect(result.shots[0].dialogue).not.toContain("说明自己");
    });

    it("keeps repeated dialogue occurrences instead of deduplicating by text", () => {
        const script = "她点点头：“好。”\n走到门口，她又回头：“好。”";
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "大纲", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "第一次回应",
                        description: "她点头回应",
                        sourceText: "她点点头：“好。”",
                        shotBoundary: "动作结束",
                        dialogue: "好。",
                        narration: "",
                        utterances: [],
                        duration: 4,
                        characterNames: [],
                        sceneName: "",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            },
            5,
            script,
        );

        expect(result.shots[0].utterances.filter((item) => item.type === "dialogue").map((item) => item.text)).toEqual(["好。", "好。"]);
    });

    it("splits an overlong shot while preserving every line in source order", () => {
        const lines = Array.from({ length: 12 }, (_, index) => `角色${index + 1}说：“这是第${index + 1}句对白。”`);
        const script = lines.join("\n");
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "连续争论", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "连续争论",
                        description: "众人依次发言",
                        sourceText: script,
                        shotBoundary: "模型错误地合并为长镜头",
                        dialogue: lines.map((_, index) => `这是第${index + 1}句对白。`).join("\n"),
                        narration: "",
                        utterances: lines.map((_, index) => ({ type: "dialogue", speaker: `角色${index + 1}`, text: `这是第${index + 1}句对白。` })),
                        duration: 40,
                        characterNames: [],
                        sceneName: "会议室",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            },
            { defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] },
            script,
        );

        expect(result.shots.map((shot) => shot.duration)).toEqual([15, 15, 10]);
        expect(result.shots.every((shot) => [5, 8, 10, 15].includes(shot.duration))).toBe(true);
        expect(result.shots.flatMap((shot) => shot.utterances.map((utterance) => utterance.text))).toEqual(lines.map((_, index) => `这是第${index + 1}句对白。`));
        expect(
            result.shots
                .map((shot) => shot.sourceText)
                .join("")
                .replace(/\s/g, ""),
        ).toBe(script.replace(/\s/g, ""));
    });

    it("rejects a fake eight-second duration when one model shot contains 78 dialogue lines", () => {
        const lines = Array.from({ length: 78 }, (_, index) => `角色${index + 1}说：“这是必须完整保留的第${index + 1}句对白。”`);
        const script = lines.join("\n");
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "长篇对白", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "模型错误合并的镜头",
                        description: "模型只概括了开头",
                        sourceText: lines[0],
                        shotBoundary: "模型没有正确切镜",
                        dialogue: "",
                        narration: "",
                        utterances: [],
                        duration: 8,
                        characterNames: [],
                        sceneName: "",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            },
            { defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] },
            script,
        );

        expect(result.shots.length).toBeGreaterThan(1);
        expect(result.shots.every((shot) => [5, 8, 10, 15].includes(shot.duration))).toBe(true);
        expect(result.shots.flatMap((shot) => shot.utterances.filter((item) => item.type === "dialogue").map((item) => item.text))).toEqual(lines.map((_, index) => `这是必须完整保留的第${index + 1}句对白。`));
        expect(
            result.shots
                .map((shot) => shot.sourceText)
                .join("")
                .replace(/\s/g, ""),
        ).toBe(script.replace(/\s/g, ""));
        expect(new Set(result.shots.map((shot) => shot.description)).size).toBe(result.shots.length);
    });

    it("does not treat quoted place names as dialogue while allowing speaker review", () => {
        const script = ["林照雪低声道：“忍着点，九幽冥毒深入髓海，过程会有些痛苦。”", "二人来到“涤心池”，池水泛起灵光。", "云舒咬紧牙关：“无妨，你尽管施为。”", "剑意入体，她闷哼一声：“唔……”"].join("\n");
        const base = {
            episode: { outline: "疗毒", hook: "", nextPreview: "", sourceRange: "第二章" },
            characters: [
                { name: "林照雪", description: "施术者" },
                { name: "云舒", description: "中毒者" },
            ],
            scenes: [],
            props: [],
            clues: [],
        };
        const shot = {
            title: "竹海疗毒",
            description: "林照雪为云舒疗毒",
            sourceText: script,
            shotBoundary: "连续疗毒过程",
            dialogue: "",
            narration: "",
            duration: 15,
            characterNames: ["林照雪", "云舒"],
            sceneName: "涤心池",
            propNames: [],
            clueNames: [],
        };
        const invalid = {
            ...base,
            shots: [
                {
                    ...shot,
                    utterances: [
                        { type: "dialogue", speaker: "林照雪", text: "忍着点，九幽冥毒深入髓海，过程会有些痛苦。" },
                        { type: "dialogue", speaker: "", text: "涤心池" },
                        { type: "dialogue", speaker: "", text: "无妨，你尽管施为。" },
                        { type: "dialogue", speaker: "她", text: "唔……" },
                    ],
                },
            ],
        };
        const valid = {
            ...base,
            shots: [
                {
                    ...shot,
                    utterances: [
                        { type: "dialogue", speaker: "林照雪", text: "忍着点，九幽冥毒深入髓海，过程会有些痛苦。" },
                        { type: "dialogue", speaker: "云舒", text: "无妨，你尽管施为。" },
                        { type: "dialogue", speaker: "云舒", text: "唔……" },
                    ],
                },
            ],
        };

        expect(hasCompleteDramaDialogueAttribution(JSON.stringify(invalid), script)).toBe(false);
        expect(hasCompleteDramaDialogueAttribution(JSON.stringify(valid), script)).toBe(true);

        const pendingSpeakerReview = {
            ...base,
            shots: [
                {
                    ...shot,
                    utterances: [
                        { type: "dialogue", speaker: "林照雪", text: "忍着点，九幽冥毒深入髓海，过程会有些痛苦。" },
                        { type: "dialogue", speaker: "", text: "无妨，你尽管施为。" },
                        { type: "dialogue", speaker: "她", text: "唔……" },
                    ],
                },
            ],
        };
        expect(hasCompleteDramaDialogueAttribution(JSON.stringify(pendingSpeakerReview), script)).toBe(true);

        const result = normalizeDramaContentAnalysis(valid, { defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] }, script);
        expect(result.shots.flatMap((item) => item.utterances.filter((utterance) => utterance.type === "dialogue").map((utterance) => [utterance.speaker, utterance.text]))).toEqual([
            ["林照雪", "忍着点，九幽冥毒深入髓海，过程会有些痛苦。"],
            ["云舒", "无妨，你尽管施为。"],
            ["云舒", "唔……"],
        ]);
    });

    it("keeps a source-attributed speaker when the model returns an unusable label", () => {
        const script = "顾言推开城门说道：“先离开这里。”";
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "城门告急", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [{ name: "顾言", description: "守城人" }],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "城门",
                        description: "顾言推开城门",
                        sourceText: script,
                        shotBoundary: "对白结束",
                        dialogue: "先离开这里。",
                        narration: "",
                        utterances: [{ type: "dialogue", speaker: "未知", text: "先离开这里。" }],
                        duration: 5,
                        characterNames: ["顾言"],
                        sceneName: "城门",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            },
            5,
            script,
        );

        expect(result.shots[0].utterances).toEqual([expect.objectContaining({ speaker: "顾言", text: "先离开这里。" })]);
        expect(hasCompleteDramaDialogueAttribution(JSON.stringify(result), script)).toBe(true);
    });

    it("infers speakers around common speech verbs and object phrases", () => {
        const script = "灯光下，顾远看见妻子不安，便放下筷子，对着她讲：“别害怕。”妻子叹了口气，望向窗外。对顾远讲：“我还是担心。”";
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "饭后交谈", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [
                    { name: "顾远", description: "丈夫" },
                    { name: "妻子", description: "妻子" },
                ],
                scenes: [],
                props: [],
                clues: [],
                shots: [{ title: "交谈", description: "夫妻交谈", sourceText: script, shotBoundary: "对白结束", utterances: [], duration: 8, characterNames: [], sceneName: "饭桌", propNames: [], clueNames: [] }],
            },
            { defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] },
            script,
        );

        expect(result.shots.flatMap((shot) => shot.utterances.map((utterance) => [utterance.speaker, utterance.text]))).toEqual([
            ["顾远", "别害怕。"],
            ["妻子", "我还是担心。"],
        ]);
        expect(hasCompleteDramaContentAnalysis(result, script)).toBe(true);
    });

    it("recovers an object-only attribution from the prior sentence without a model character roster", () => {
        const script = "孩子的名字叫“石头”。男人讲：“别担心。”女人叹了口气，望向窗外。对男人讲：“我还是担心。”";
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "饭后交谈", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [{ title: "交谈", description: "女人表达担忧", sourceText: script, shotBoundary: "对白结束", utterances: [], duration: 8, characterNames: [], sceneName: "饭桌", propNames: [], clueNames: [] }],
            },
            { defaultSeconds: 5, durationSeconds: [5, 8, 10, 15] },
            script,
        );

        expect(result.shots.flatMap((shot) => shot.utterances.map((utterance) => [utterance.speaker, utterance.text]))).toEqual([
            ["男人", "别担心。"],
            ["女人", "我还是担心。"],
        ]);
        expect(hasCompleteDramaContentAnalysis(result, script)).toBe(true);
    });

    it("keeps the local script authoritative when model source text or utterances drift", () => {
        const script = "顾言说道：“先走。”风雪压过城门。";
        const result = normalizeDramaContentAnalysis(
            {
                episode: { outline: "离城" },
                characters: [{ name: "顾言", description: "守城人" }],
                shots: [
                    {
                        title: "城门",
                        description: "顾言离开城门",
                        sourceText: "顾言离开。",
                        dialogue: "顾言表示必须马上离开。",
                        utterances: [
                            { type: "dialogue", speaker: "顾言", text: "先走。" },
                            { type: "dialogue", speaker: "顾言", text: "风雪压过城门。" },
                        ],
                        duration: 5,
                    },
                ],
            },
            5,
            script,
        );

        const utteranceText = result.shots.flatMap((shot) => shot.utterances.map((utterance) => utterance.text));
        expect(result.shots.map((shot) => shot.sourceText).join("")).toBe(script);
        expect(utteranceText).toHaveLength(1);
        expect(utteranceText[0]).toBe("先走。");
        expect(hasCompleteDramaContentAnalysis(result, script)).toBe(true);
    });

    it("only accepts visual fields for reviewed shot ids", () => {
        expect(
            normalizeDramaVisualAnalysis(
                {
                    shots: [
                        {
                            shotId: "shot-one",
                            imagePrompt: "夜景中景",
                            videoPrompt: "缓慢推进",
                            cameraMotion: "dolly in",
                            startFramePrompt: "抬头前",
                            endFramePrompt: "抬头后",
                            negativePrompt: "身份漂移",
                            continuity: {
                                shotSize: "中景",
                                cameraAngle: "平视",
                                composition: "居中",
                                characterBlocking: "女主在门边",
                                gazeDirection: "向左",
                                actionStart: "低头",
                                actionEnd: "抬头",
                                screenDirection: "向左",
                                axisRule: "不越轴",
                                continuityNotes: "服装不变",
                            },
                        },
                        { shotId: "unknown", imagePrompt: "错误", videoPrompt: "错误", cameraMotion: "" },
                        { shotId: "shot-one", imagePrompt: "重复", videoPrompt: "重复", cameraMotion: "" },
                    ],
                },
                ["shot-one"],
            ),
        ).toEqual({
            shots: [
                {
                    shotId: "shot-one",
                    imagePrompt: "夜景中景",
                    videoPrompt: "缓慢推进",
                    cameraMotion: "dolly in",
                    startFramePrompt: "抬头前",
                    endFramePrompt: "抬头后",
                    negativePrompt: "身份漂移",
                    continuity: {
                        shotSize: "中景",
                        cameraAngle: "平视",
                        composition: "居中",
                        characterBlocking: "女主在门边",
                        gazeDirection: "向左",
                        actionStart: "低头",
                        actionEnd: "抬头",
                        screenDirection: "向左",
                        axisRule: "不越轴",
                        continuityNotes: "服装不变",
                    },
                },
            ],
        });
    });

    it("turns upstream failures into actionable messages", () => {
        expect(readDramaUpstreamError('{"error":{"message":"无可用账号，请稍后重试"}}', 502)).toBe("无可用账号，请稍后重试");
        expect(readDramaUpstreamError("", 502)).toBe("文本模型渠道暂不可用（HTTP 502）");
        expect(readDramaUpstreamError("", 401)).toBe("文本模型渠道鉴权失败，请管理员检查账号和密钥");
    });

    it("accepts strict JSON when a channel returns content instead of a tool call", () => {
        expect(readDramaChatArguments({ choices: [{ message: { content: '```json\n{"shots":[]}\n```' } }] }, "analyze_drama_content")).toBe('{"shots":[]}');
        expect(readDramaResponsesArguments({ output: [{ type: "message", content: [{ type: "output_text", text: '{"shots":[]}' }] }] }, "analyze_drama_content")).toBe('{"shots":[]}');
    });

    it("accepts common provider variants without accepting surrounding prose", () => {
        expect(readDramaResponsesArguments({ output_text: '{"shots":[]}' }, "analyze_drama_content")).toBe('{"shots":[]}');
        expect(readDramaResponsesArguments({ output: [{ type: "function_call", name: "analyze_drama_content", arguments: { shots: [] } }] }, "analyze_drama_content")).toBe('{"shots":[]}');
        expect(readDramaChatArguments({ choices: [{ message: { content: [{ type: "text", text: '{"shots":[]}' }] } }] }, "analyze_drama_content")).toBe('{"shots":[]}');
        expect(readDramaChatArguments({ choices: [{ message: { function_call: { name: "analyze_drama_content", arguments: { shots: [] } } } }] }, "analyze_drama_content")).toBe('{"shots":[]}');
        expect(readDramaChatArguments({ choices: [{ message: { content: '结果如下：{"shots":[]}' } }] }, "analyze_drama_content")).toBe("");
    });

    it("rejects echoed input and empty structured results", () => {
        expect(hasUsableDramaToolArguments('{"script":"原始剧本","summary":"简介"}', "analyze_drama_content")).toBe(false);
        expect(hasUsableDramaToolArguments('{"shots":[{"title":"镜头一"}]}', "analyze_drama_content")).toBe(true);
        expect(hasUsableDramaToolArguments('{"shots":[{"shotId":"shot-one"}]}', "design_drama_visuals")).toBe(true);
    });

    it("unwraps common Responses-compatible result containers without weakening the content validator", () => {
        const result = { episode: { outline: "大纲" }, shots: [{ title: "镜头一" }] };

        expect(normalizeDramaToolArguments(JSON.stringify({ data: result }), "analyze_drama_content")).toBe(JSON.stringify(result));
        expect(normalizeDramaToolArguments(JSON.stringify({ arguments: JSON.stringify(result) }), "analyze_drama_content")).toBe(JSON.stringify(result));
        const invalid = JSON.stringify({ wrong: { shots: result.shots } });
        expect(normalizeDramaToolArguments(invalid, "analyze_drama_content")).toBe(invalid);
        expect(hasUsableDramaToolArguments(normalizeDramaToolArguments(JSON.stringify({ result }), "analyze_drama_content"), "analyze_drama_content")).toBe(true);
    });

    it("describes response shape without including model content", () => {
        expect(describeDramaModelOutput({ output_text: "private", choices: [{ message: { content: [{ type: "text", text: "private" }], tool_calls: [{ function: { name: "analyze_drama_content", arguments: "private" } }] } }] })).toEqual({
            topLevelKeys: ["output_text", "choices"],
            outputTextType: "string",
            output: [],
            choices: [{ contentType: "array", toolCallCount: 1, toolNames: ["analyze_drama_content"], functionCallName: "" }],
        });
    });
});
