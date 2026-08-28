import { describe, expect, it } from "vitest";

import { defaultConfig } from "@/stores/use-config-store";
import type { DramaEpisode, DramaProject, DramaShot } from "../types";
import { buildDramaShotInputFingerprints } from "./drama-shot-input-fingerprint";

describe("drama shot input fingerprints", () => {
    it("is stable for identical canonical inputs", () => {
        const project = projectFixture();
        const episode = project.episodes[0];

        expect(build(project, episode, episode.shots[0])).toEqual(build(structuredClone(project), structuredClone(episode), structuredClone(episode.shots[0])));
    });

    it("changes only the affected generation surfaces", () => {
        const project = projectFixture();
        const episode = project.episodes[0];
        const shot = episode.shots[0];
        const current = build(project, episode, shot);

        const promptChanged = build(project, episode, { ...shot, videoPrompt: "新的动态过程" });
        expect(promptChanged.storyboard).toBe(current.storyboard);
        expect(promptChanged.storyboardEnd).toBe(current.storyboardEnd);
        expect(promptChanged.video).not.toBe(current.video);

        const frameChanged = build(project, episode, { ...shot, storyboardImageUrl: "/new-start.png" });
        expect(frameChanged.storyboard).toBe(current.storyboard);
        expect(frameChanged.storyboardEnd).not.toBe(current.storyboardEnd);
        expect(frameChanged.video).not.toBe(current.video);

        const imageModelChanged = build(project, episode, { ...shot, imageModel: "image-model-2" });
        expect(imageModelChanged.storyboard).not.toBe(current.storyboard);
        expect(imageModelChanged.storyboardEnd).not.toBe(current.storyboardEnd);
        expect(imageModelChanged.video).toBe(current.video);

        const videoModelChanged = build(project, episode, { ...shot, videoModel: "video-model-2" });
        expect(videoModelChanged.storyboard).toBe(current.storyboard);
        expect(videoModelChanged.storyboardEnd).toBe(current.storyboardEnd);
        expect(videoModelChanged.video).not.toBe(current.video);
    });
});

function build(project: DramaProject, episode: DramaEpisode, shot: DramaShot) {
    return buildDramaShotInputFingerprints({ ...defaultConfig, imageModel: "image-model", imageModels: ["image-model"], videoModel: "video-model", videoModels: ["video-model"], quality: "2K", vquality: "1080P" }, project, episode, shot);
}

function projectFixture(): DramaProject {
    const shot: DramaShot = {
        id: "shot",
        order: 1,
        title: "雨夜回头",
        description: "女孩在雨中回头",
        sourceText: "女孩听见脚步声后回头。",
        shotBoundary: "动作完成",
        dialogue: "谁在那里？",
        narration: "",
        utterances: [],
        imagePrompt: "雨夜天台，中景",
        videoPrompt: "女孩缓慢回头",
        cameraMotion: "缓慢推进",
        startFramePrompt: "女孩背对镜头",
        endFramePrompt: "女孩看向镜头",
        negativePrompt: "文字、水印",
        continuity: {
            shotSize: "中景",
            cameraAngle: "平视",
            composition: "居中",
            characterBlocking: "女孩位于画面中央",
            gazeDirection: "看向镜头",
            actionStart: "背对镜头",
            actionEnd: "转身看向镜头",
            screenDirection: "向右",
            axisRule: "不越轴",
            continuityNotes: "服装保持一致",
        },
        duration: 5,
        characterIds: [],
        propIds: [],
        clueIds: [],
        storyboardFrameMode: "first_last",
        storyboardImageUrl: "/start.png",
        storyboardEndImageUrl: "/end.png",
        storyboardStatus: "success",
        storyboardEndStatus: "success",
        generationStatus: "success",
        audioMode: "source",
        audioStatus: "idle",
    };
    const episode: DramaEpisode = {
        id: "episode",
        episodeNumber: 1,
        title: "第一集",
        script: "剧本",
        outline: "",
        hook: "",
        nextPreview: "",
        sourceRange: "",
        reviewStatus: "visual_ready",
        shots: [shot],
    };
    return {
        id: "project",
        title: "雨夜",
        summary: "",
        style: "电影写实",
        ratio: "9:16",
        status: "active",
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        defaultVideoMode: "storyboard",
        videoModel: "video-model",
        activeEpisodeId: episode.id,
        episodes: [episode],
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
    };
}
