import { describe, expect, it } from "vitest";

import type { DramaShot, DramaVisualAnalysis } from "./types";
import { applyDramaShotFingerprintUpdate, applyDramaVisualFreshness } from "./drama-visual-freshness";

const fingerprints = {
    storyboard: "storyboard-a",
    storyboardEnd: "storyboard-end-a",
    video: "video-a",
};

describe("drama visual result freshness", () => {
    it("preserves every task, attempt and media URL when visual inputs are identical", () => {
        const shot = shotFixture({
            storyboardTaskId: "image-task",
            storyboardAttempt: 2,
            storyboardImageUrl: "/storyboard.png",
            storyboardResultFingerprint: fingerprints.storyboard,
            storyboardEndTaskId: "end-task",
            storyboardEndAttempt: 3,
            storyboardEndImageUrl: "/end.png",
            storyboardEndResultFingerprint: fingerprints.storyboardEnd,
            generationTaskId: "video-task",
            generationAttempt: 4,
            videoUrl: "/video.mp4",
            videoResultFingerprint: fingerprints.video,
            audioTaskId: "audio-task",
            audioAttempt: 5,
            audioUrl: "/voice.mp3",
        });

        const result = applyDramaVisualFreshness(shot, visualFixture(), { shotId: shot.id, before: fingerprints, after: fingerprints });

        expect(result).toMatchObject({
            storyboardTaskId: "image-task",
            storyboardAttempt: 2,
            storyboardImageUrl: "/storyboard.png",
            storyboardFreshness: "current",
            storyboardEndTaskId: "end-task",
            storyboardEndAttempt: 3,
            storyboardEndImageUrl: "/end.png",
            storyboardEndFreshness: "current",
            generationTaskId: "video-task",
            generationAttempt: 4,
            videoUrl: "/video.mp4",
            videoFreshness: "current",
            audioTaskId: "audio-task",
            audioAttempt: 5,
            audioUrl: "/voice.mp3",
        });
    });

    it("marks only the result whose canonical input changed", () => {
        const shot = shotFixture({
            storyboardImageUrl: "/storyboard.png",
            storyboardResultFingerprint: fingerprints.storyboard,
            storyboardEndImageUrl: "/end.png",
            storyboardEndResultFingerprint: fingerprints.storyboardEnd,
            videoUrl: "/video.mp4",
            videoResultFingerprint: fingerprints.video,
        });

        const result = applyDramaShotFingerprintUpdate(shot, { before: fingerprints, after: { ...fingerprints, video: "video-b" } }, "动态提示词已更新");

        expect(result.storyboardFreshness).toBe("current");
        expect(result.storyboardEndFreshness).toBe("current");
        expect(result.videoFreshness).toBe("stale");
        expect(result.videoUrl).toBe("/video.mp4");
        expect(result.videoStaleReason).toContain("动态提示词已更新");
    });

    it("keeps a running task's submitted fingerprint and marks its late result stale", () => {
        const running = applyDramaShotFingerprintUpdate(shotFixture({ generationStatus: "running", generationTaskId: "video-task" }), { before: fingerprints, after: { ...fingerprints, video: "video-b" } }, "镜头输入已更新");
        expect(running.videoAttemptFingerprint).toBe("video-a");

        const completed = applyDramaShotFingerprintUpdate(
            { ...running, generationStatus: "success", videoUrl: "/late.mp4", videoResultFingerprint: running.videoAttemptFingerprint },
            { before: { ...fingerprints, video: "video-b" }, after: { ...fingerprints, video: "video-b" } },
            "镜头输入已更新",
        );

        expect(completed.videoUrl).toBe("/late.mp4");
        expect(completed.videoResultFingerprint).toBe("video-a");
        expect(completed.videoFreshness).toBe("stale");
    });
});

function visualFixture(): DramaVisualAnalysis["shots"][number] {
    return {
        shotId: "shot",
        imagePrompt: "画面",
        videoPrompt: "动作",
        cameraMotion: "固定",
        startFramePrompt: "开始",
        endFramePrompt: "结束",
        negativePrompt: "文字",
        continuity: continuityFixture(),
    };
}

function shotFixture(patch: Partial<DramaShot> = {}): DramaShot {
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
        imagePrompt: "画面",
        videoPrompt: "动作",
        cameraMotion: "固定",
        startFramePrompt: "开始",
        endFramePrompt: "结束",
        negativePrompt: "文字",
        continuity: continuityFixture(),
        duration: 5,
        characterIds: [],
        propIds: [],
        clueIds: [],
        storyboardStatus: "success",
        storyboardEndStatus: "success",
        generationStatus: "success",
        audioStatus: "success",
        audioMode: "voiceover",
        ...patch,
    };
}

function continuityFixture() {
    return {
        shotSize: "",
        cameraAngle: "",
        composition: "",
        characterBlocking: "",
        gazeDirection: "",
        actionStart: "",
        actionEnd: "",
        screenDirection: "",
        axisRule: "",
        continuityNotes: "",
    };
}
