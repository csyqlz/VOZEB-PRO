import { describe, expect, it } from "vitest";

import type { DramaProject, DramaShot } from "../types";
import { summarizeDramaGeneration } from "./drama-generation-readiness";

describe("drama generation readiness", () => {
    it("separates queueable shots from prompt and reference blockers", () => {
        const project = projectFixture([shotFixture({ id: "direct", videoMode: "direct" }), shotFixture({ id: "missing-prompt", videoMode: "storyboard", imagePrompt: "" }), shotFixture({ id: "missing-reference", videoMode: "reference" })]);

        const summary = summarizeDramaGeneration(project, project.episodes[0]);

        expect(summary.queueableShotIds).toEqual(["direct"]);
        expect(summary.missingPromptShotIds).toEqual(["missing-prompt"]);
        expect(summary.missingReferenceShotIds).toEqual(["missing-reference"]);
    });

    it("tracks real video and required voiceover completion without treating active tasks as queueable", () => {
        const project = projectFixture([
            shotFixture({ id: "complete", videoUrl: "/video.mp4", generationStatus: "success", audioMode: "voiceover", subtitle: "对白", audioUrl: "/voice.mp3", audioStatus: "success" }),
            shotFixture({ id: "running", generationStatus: "running", audioMode: "voiceover", subtitle: "旁白" }),
        ]);

        const summary = summarizeDramaGeneration(project, project.episodes[0]);

        expect(summary.completedVideoCount).toBe(1);
        expect(summary.activeShotIds).toEqual(["running"]);
        expect(summary.queueableShotIds).toEqual([]);
        expect(summary.voiceoverShotIds).toEqual(["complete", "running"]);
        expect(summary.completedAudioCount).toBe(1);
        expect(summary.missingAudioShotIds).toEqual(["running"]);
        expect(summary.progressPercent).toBe(50);
    });

    it("keeps stale media visible while queueing only affected shots for update", () => {
        const project = projectFixture([
            shotFixture({ id: "current", videoUrl: "/current.mp4", generationStatus: "success", videoFreshness: "current" }),
            shotFixture({ id: "stale", videoUrl: "/old.mp4", generationStatus: "success", videoFreshness: "stale" }),
        ]);

        const summary = summarizeDramaGeneration(project, project.episodes[0]);

        expect(summary.completedVideoCount).toBe(1);
        expect(summary.staleShotIds).toEqual(["stale"]);
        expect(summary.staleQueueableShotIds).toEqual(["stale"]);
        expect(summary.queueableShotIds).toEqual(["stale"]);
    });
});

function projectFixture(shots: DramaShot[]): DramaProject {
    return {
        id: "project",
        title: "测试短剧",
        summary: "",
        style: "",
        ratio: "9:16",
        status: "active",
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        defaultVideoMode: "storyboard",
        activeEpisodeId: "episode",
        episodes: [
            {
                id: "episode",
                title: "第一集",
                script: "剧本",
                outline: "",
                hook: "",
                nextPreview: "",
                sourceRange: "",
                reviewStatus: "visual_ready",
                shots,
            },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
}

function shotFixture(patch: Partial<DramaShot>): DramaShot {
    return {
        id: "shot",
        order: 1,
        title: "镜头",
        description: "动作",
        sourceText: "原文",
        shotBoundary: "段落",
        dialogue: "",
        narration: "",
        utterances: [],
        imagePrompt: "画面提示词",
        videoPrompt: "动态提示词",
        cameraMotion: "固定机位",
        duration: 5,
        characterIds: [],
        propIds: [],
        clueIds: [],
        storyboardStatus: "idle",
        generationStatus: "idle",
        audioMode: "source",
        audioStatus: "idle",
        ...patch,
    };
}
