type VozebRecommendedVideoInput = {
    model: string;
    prompt: string;
    duration: number;
    aspectRatio?: string;
    resolution?: string;
    generateAudio: boolean;
    images: string[];
    videos: string[];
    audios: string[];
};

const SEEDANCE_FAST_720P = "seedance 2.0-fast-720p";

export function assertVozebRecommendedVideoReferences(model: string, references: Array<{ type?: string }>) {
    if (normalizeModel(model) !== SEEDANCE_FAST_720P) return;
    if (references.some((reference) => reference.type === "video")) throw new Error("Seedance 2.0-fast-720p 不支持参考视频");
    if (references.some((reference) => reference.type === "audio")) throw new Error("Seedance 2.0-fast-720p 不支持参考音频");
}

export function buildVozebRecommendedVideoRequest(input: VozebRecommendedVideoInput) {
    const seedanceFast720p = normalizeModel(input.model) === SEEDANCE_FAST_720P;
    const resolution = seedanceFast720p ? "720p" : input.resolution;
    const payload: Record<string, unknown> = {
        model: input.model,
        prompt: input.prompt,
        duration: Math.min(15, Math.max(5, Math.trunc(input.duration) || 5)),
        ...(resolution ? { resolution, metadata: { resolution } } : {}),
        generate_audio: seedanceFast720p ? false : input.generateAudio,
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    };
    if (input.images.length) payload.images = input.images.slice(0, 9);
    if (input.videos.length) payload.videos = input.videos.slice(0, 3);
    if (input.audios.length) payload.audios = input.audios.slice(0, 3);
    return payload;
}

function normalizeModel(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}
