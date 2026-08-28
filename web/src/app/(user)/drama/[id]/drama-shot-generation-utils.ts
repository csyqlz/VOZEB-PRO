import type { DramaAssetReference, DramaProject, DramaShot } from "../types";
import type { AiConfig } from "@/stores/use-config-store";
import { resolveDramaGenerationSize } from "@/lib/drama-image-size";
import type { ReferenceImage } from "@/types/image";
import type { VideoReferenceRole } from "@/lib/video-reference-contract";
import { modelOptionName } from "@/stores/use-config-store";

export function shotReferenceImages(project: DramaProject, shot: DramaShot) {
    const assetUrls = [...project.characters.filter((item) => shot.characterIds.includes(item.id)), ...project.scenes.filter((item) => item.id === shot.sceneId), ...project.props.filter((item) => shot.propIds.includes(item.id))].flatMap((item) => {
        const reference = primaryAssetReference(item);
        return reference ? [referenceImage(item.id, `${item.name}.png`, reference.url, "image/png", reference.width, reference.height)] : [];
    });
    const sourceUrls = (project.sourceAssets || []).flatMap((item) => {
        if (item.type !== "image") return [];
        const url = item.serverUrl || item.remoteUrl;
        return url ? [referenceImage(item.id, item.title, url, item.mimeType, item.width, item.height)] : [];
    });
    return [...assetUrls, ...sourceUrls];
}

export function storyboardReferenceImages(shot: DramaShot) {
    return [
        shot.storyboardImageUrl ? referenceImage(`storyboard-start-${shot.id}`, `${shot.title}-起始帧.png`, shot.storyboardImageUrl, "image/png", shot.storyboardImageWidth, shot.storyboardImageHeight, "first_frame") : null,
        shot.storyboardFrameMode === "first_last" && shot.storyboardEndImageUrl
            ? referenceImage(`storyboard-end-${shot.id}`, `${shot.title}-结束帧.png`, shot.storyboardEndImageUrl, "image/png", shot.storyboardEndImageWidth, shot.storyboardEndImageHeight, "last_frame")
            : null,
    ].filter((item): item is ReturnType<typeof referenceImage> => Boolean(item));
}

function primaryAssetReference(item: DramaProject["characters"][number]): Pick<DramaAssetReference, "url" | "width" | "height"> | undefined {
    return item.references?.find((reference) => reference.id === item.primaryReferenceId) || item.references?.[0] || (item.referenceImageUrl ? { url: item.referenceImageUrl } : undefined);
}

export function referenceImage(id: string, name: string, url: string, type = "image/png", width?: number, height?: number, videoRole?: VideoReferenceRole): ReferenceImage {
    return { id, name, type, dataUrl: url, url, width, height, ...(videoRole ? { videoRole } : {}), ...(url.startsWith("/") ? { serverUrl: url } : /^https?:\/\//i.test(url) ? { remoteUrl: url } : {}) };
}

export function dramaGenerationSize(project: DramaProject, prompt: string, references: ReferenceImage[] = []) {
    return resolveDramaGenerationSize({ projectSize: project.ratio, prompt, references });
}

export function configuredDramaVideoModel(config: AiConfig, value?: string) {
    const requested = normalizeModel(value);
    return requested ? config.videoModels.find((model) => normalizeModel(model) === requested) || "" : "";
}

export function configuredDramaImageModel(config: AiConfig, value?: string) {
    const requested = normalizeModel(value);
    return requested ? config.imageModels.find((model) => normalizeModel(model) === requested) || "" : "";
}

export function resolveDramaImageModel(config: AiConfig, project: DramaProject, shot?: DramaShot) {
    const requested = shot?.imageModel || shot?.storyboardModel || project.imageModel || config.imageModel;
    return configuredDramaImageModel(config, requested);
}

export function resolveDramaVideoModel(config: AiConfig, project: DramaProject, shot?: DramaShot) {
    const requested = shot?.videoModel || shot?.generationModel || project.videoModel || config.videoModel;
    return configuredDramaVideoModel(config, requested);
}

export function estimateTaskPoints(config: AiConfig, type: "image" | "video" | "audio", duration = 5, selectedModel?: string) {
    const model = selectedModel !== undefined ? selectedModel : type === "image" ? config.imageModel || config.model : type === "video" ? config.videoModel : config.audioModel;
    const base = Number(config.modelPointCosts[model] || 0);
    if (type === "image") return Number((base * (config.generationPointMultipliers.imageQuality[config.quality] || 1)).toFixed(2));
    if (type === "video") {
        const quality = config.generationPointMultipliers.videoQuality[config.vquality] || 1;
        const seconds = config.generationPointMultipliers.videoSeconds[String(duration)] || config.generationPointMultipliers.videoSeconds[config.videoSeconds] || 1;
        return Number((base * quality * seconds).toFixed(2));
    }
    return Number(base.toFixed(2));
}

export function estimateEpisodePoints(config: AiConfig, project: DramaProject, shots: DramaShot[]) {
    const total = shots.reduce((sum, shot) => {
        const mode = shot.videoMode || project.defaultVideoMode;
        const image = mode === "storyboard" ? estimateTaskPoints(config, "image", 5, resolveDramaImageModel(config, project, shot)) * (shot.storyboardFrameMode === "first_last" ? 2 : 1) : 0;
        const audio = shot.audioMode === "voiceover" && (shot.subtitle || shot.dialogue || shot.narration).trim() ? estimateTaskPoints(config, "audio") : 0;
        return sum + image + estimateTaskPoints(config, "video", shot.duration, resolveDramaVideoModel(config, project, { ...shot, generationModel: undefined })) + audio;
    }, 0);
    return Number(total.toFixed(2));
}

function normalizeModel(value?: string) {
    return modelOptionName(value || "")
        .replace(/^models\//i, "")
        .trim()
        .toLowerCase();
}
