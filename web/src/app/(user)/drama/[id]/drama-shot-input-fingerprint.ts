import { compileDramaShotPrompts } from "@/lib/drama-prompt-compiler";
import type { AiConfig } from "@/stores/use-config-store";
import type { DramaEpisode, DramaProject, DramaShot } from "../types";
import { dramaGenerationSize, resolveDramaImageModel, resolveDramaVideoModel, shotReferenceImages, storyboardReferenceImages } from "./drama-shot-generation-utils";

export type DramaShotInputFingerprints = {
    storyboard: string;
    storyboardEnd: string;
    video: string;
};

export function buildDramaShotInputFingerprints(config: AiConfig, project: DramaProject, episode: DramaEpisode, shot: DramaShot): DramaShotInputFingerprints {
    const prompts = compileDramaShotPrompts(project, episode, shot);
    const assetReferences = shotReferenceImages(project, shot);
    const storyboardReferences = storyboardReferenceImages(shot);
    const mode = shot.videoMode || project.defaultVideoMode;
    const videoReferences = mode === "reference" ? assetReferences : storyboardReferences;
    const storyboardEndReferences = storyboardReferences.filter((reference) => reference.videoRole === "first_frame");
    const imageModel = resolveDramaImageModel(config, project, { ...shot, storyboardModel: undefined, storyboardEndModel: undefined });
    const videoModel = resolveDramaVideoModel(config, project, { ...shot, generationModel: undefined });

    return {
        storyboard: exactFingerprint("storyboard", {
            model: imageModel,
            prompt: prompts.imagePrompt,
            references: referenceInputs(assetReferences),
            size: dramaGenerationSize(project, prompts.imagePrompt, assetReferences),
            quality: config.quality,
        }),
        storyboardEnd: exactFingerprint("storyboard-end", {
            model: imageModel,
            prompt: prompts.endFramePrompt,
            references: referenceInputs(storyboardEndReferences),
            size: dramaGenerationSize(project, prompts.endFramePrompt, storyboardEndReferences),
            quality: config.quality,
        }),
        video: exactFingerprint("video", {
            model: videoModel,
            prompt: prompts.videoPrompt,
            references: referenceInputs(videoReferences),
            size: dramaGenerationSize(project, prompts.videoPrompt, videoReferences),
            mode,
            quality: config.vquality,
            duration: shot.duration,
            generateAudio: (shot.audioMode || "source") === "source",
        }),
    };
}

function referenceInputs(references: ReturnType<typeof shotReferenceImages>) {
    return references.map((reference) => ({
        id: reference.id,
        url: reference.serverUrl || reference.remoteUrl || reference.url || reference.dataUrl,
        role: reference.videoRole || "reference",
        width: reference.width || 0,
        height: reference.height || 0,
    }));
}

function exactFingerprint(kind: string, value: object) {
    return `drama-${kind}-v1:${JSON.stringify(value)}`;
}
