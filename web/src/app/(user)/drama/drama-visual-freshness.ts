import type { DramaShot, DramaVisualAnalysis } from "./types";
import type { DramaShotInputFingerprints } from "./[id]/drama-shot-input-fingerprint";

export type DramaVisualFingerprintUpdate = {
    shotId: string;
    before: DramaShotInputFingerprints;
    after: DramaShotInputFingerprints;
};

export function applyDramaVisualFields(shot: DramaShot, visual: DramaVisualAnalysis["shots"][number]): DramaShot {
    return {
        ...shot,
        imagePrompt: visual.imagePrompt,
        videoPrompt: visual.videoPrompt,
        cameraMotion: visual.cameraMotion,
        startFramePrompt: visual.startFramePrompt,
        endFramePrompt: visual.endFramePrompt,
        negativePrompt: visual.negativePrompt,
        continuity: visual.continuity,
    };
}

export function applyDramaVisualFreshness(shot: DramaShot, visual: DramaVisualAnalysis["shots"][number], update: DramaVisualFingerprintUpdate): DramaShot {
    return applyDramaShotFingerprintUpdate(applyDramaVisualFields(shot, visual), update, "视觉方案已更新");
}

export function applyDramaShotFingerprintUpdate(shot: DramaShot, update: Omit<DramaVisualFingerprintUpdate, "shotId">, reason: string): DramaShot {
    const storyboardResult = shot.storyboardResultFingerprint || (shot.storyboardImageUrl ? update.before.storyboard : undefined);
    const storyboardEndResult = shot.storyboardEndResultFingerprint || (shot.storyboardEndImageUrl ? update.before.storyboardEnd : undefined);
    const videoResult = shot.videoResultFingerprint || (shot.videoUrl ? update.before.video : undefined);
    const storyboardStale = Boolean(storyboardResult && storyboardResult !== update.after.storyboard);
    const storyboardEndStale = Boolean(storyboardEndResult && storyboardEndResult !== update.after.storyboardEnd);
    const videoStale = Boolean(videoResult && videoResult !== update.after.video);

    return {
        ...shot,
        storyboardInputFingerprint: update.after.storyboard,
        storyboardEndInputFingerprint: update.after.storyboardEnd,
        videoInputFingerprint: update.after.video,
        storyboardAttemptFingerprint: shot.storyboardAttemptFingerprint || (isActive(shot.storyboardStatus) ? update.before.storyboard : undefined),
        storyboardEndAttemptFingerprint: shot.storyboardEndAttemptFingerprint || (isActive(shot.storyboardEndStatus) ? update.before.storyboardEnd : undefined),
        videoAttemptFingerprint: shot.videoAttemptFingerprint || (isActive(shot.generationStatus) ? update.before.video : undefined),
        storyboardResultFingerprint: storyboardResult,
        storyboardEndResultFingerprint: storyboardEndResult,
        videoResultFingerprint: videoResult,
        storyboardFreshness: storyboardResult ? (storyboardStale ? "stale" : "current") : undefined,
        storyboardEndFreshness: storyboardEndResult ? (storyboardEndStale ? "stale" : "current") : undefined,
        videoFreshness: videoResult ? (videoStale ? "stale" : "current") : undefined,
        storyboardStaleReason: storyboardStale ? `${reason}，当前分镜图基于旧输入` : undefined,
        storyboardEndStaleReason: storyboardEndStale ? `${reason}，当前结束帧基于旧输入` : undefined,
        videoStaleReason: videoStale ? `${reason}，当前视频基于旧输入` : undefined,
    };
}

function isActive(status: DramaShot["storyboardStatus"]) {
    return status === "queued" || status === "running";
}
