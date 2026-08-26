import { normalizeVideoReferenceRole, type CreativeVideoReferenceMode, type VideoReferenceRole } from "@/lib/video-reference-contract";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

import type { CanvasNodeMetadata, CanvasVideoFrameSelection, CanvasVideoReferenceSnapshot } from "../types";
import type { CanvasResourceReference } from "./canvas-resource-references";

type VideoGenerationContext = {
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
};

export type ResolvedCanvasVideoReferences = {
    mode: CreativeVideoReferenceMode;
    images: ReferenceImage[];
    videos: ReferenceVideo[];
    audios: ReferenceAudio[];
    snapshots: CanvasVideoReferenceSnapshot[];
    firstFrame?: CanvasVideoFrameSelection;
    lastFrame?: CanvasVideoFrameSelection;
};

export function canvasVideoReferenceMetadata(references: ResolvedCanvasVideoReferences): Partial<CanvasNodeMetadata> {
    return {
        videoReferenceMode: references.mode,
        videoFirstFrame: references.firstFrame,
        videoLastFrame: references.lastFrame,
        videoReferences: references.snapshots,
        references: references.snapshots.map((reference) => reference.source),
    };
}

const videoReferenceModes: CreativeVideoReferenceMode[] = ["reference", "first_frame", "first_last"];

export function normalizeCanvasVideoReferenceMode(value: unknown): CreativeVideoReferenceMode {
    return typeof value === "string" && videoReferenceModes.includes(value as CreativeVideoReferenceMode) ? (value as CreativeVideoReferenceMode) : "reference";
}

export function canvasVideoReferenceModeLabel(value: unknown) {
    const mode = normalizeCanvasVideoReferenceMode(value);
    return mode === "first_frame" ? "首帧" : mode === "first_last" ? "首尾帧" : "普通参考";
}

export function canvasVideoReferenceModePatch(mode: CreativeVideoReferenceMode): Partial<CanvasNodeMetadata> {
    if (mode === "reference") return { videoReferenceMode: mode, videoFirstFrame: undefined, videoLastFrame: undefined };
    if (mode === "first_frame") return { videoReferenceMode: mode, videoLastFrame: undefined };
    return { videoReferenceMode: mode };
}

export function canvasVideoFrameSelection(reference: CanvasResourceReference): CanvasVideoFrameSelection | null {
    if (reference.kind !== "image") return null;
    const previewUrl = persistedSource(reference.serverUrl, reference.remoteUrl, reference.previewUrl);
    const source = reference.storageKey?.trim() || previewUrl;
    if (!source) return null;
    return {
        nodeId: reference.nodeId,
        title: reference.title,
        source,
        previewUrl: previewUrl || undefined,
        storageKey: reference.storageKey,
        remoteUrl: reference.remoteUrl,
        serverUrl: reference.serverUrl,
        mimeType: reference.mimeType,
        width: reference.width,
        height: reference.height,
    };
}

export function canvasVideoFrameSelectionPatch(metadata: CanvasNodeMetadata | undefined, role: Extract<VideoReferenceRole, "first_frame" | "last_frame">, selection?: CanvasVideoFrameSelection): Partial<CanvasNodeMetadata> {
    if (!selection) return role === "first_frame" ? { videoFirstFrame: undefined } : { videoLastFrame: undefined };
    const other = role === "first_frame" ? metadata?.videoLastFrame : metadata?.videoFirstFrame;
    const clearOther = Boolean(other && sameFrameSelection(other, selection));
    return role === "first_frame" ? { videoFirstFrame: selection, ...(clearOther ? { videoLastFrame: undefined } : {}) } : { videoLastFrame: selection, ...(clearOther ? { videoFirstFrame: undefined } : {}) };
}

export function resolveCanvasVideoGenerationReferences({
    metadata,
    context,
    availableInputs,
    sourceImage,
}: {
    metadata: CanvasNodeMetadata | undefined;
    context: VideoGenerationContext;
    availableInputs: Array<{ image?: ReferenceImage }>;
    sourceImage?: ReferenceImage;
}): ResolvedCanvasVideoReferences {
    const mode = normalizeCanvasVideoReferenceMode(metadata?.videoReferenceMode);
    const availableImages = availableInputs.flatMap((input) => (input.image ? [input.image] : []));
    const referenceImages = sourceImage ? [sourceImage] : context.referenceImages;
    if (mode === "reference") {
        const images = referenceImages.map((image) => ({ ...image, videoRole: "reference" as const }));
        return resolvedVideoReferences(mode, images, context.referenceVideos, context.referenceAudios);
    }

    const firstImage = resolveFrameImage(metadata?.videoFirstFrame, availableImages);
    if (!firstImage) throw new Error("请先选择视频首帧图片");
    const firstFrame = frameSelectionFromImage(firstImage, metadata?.videoFirstFrame);
    if (!firstFrame) throw new Error("视频首帧尚未保存到服务器，请重新连接图片后再试");

    let lastImage: ReferenceImage | undefined;
    let lastFrame: CanvasVideoFrameSelection | undefined;
    if (mode === "first_last") {
        lastImage = resolveFrameImage(metadata?.videoLastFrame, availableImages);
        if (!lastImage) throw new Error("请先选择视频尾帧图片");
        lastFrame = frameSelectionFromImage(lastImage, metadata?.videoLastFrame);
        if (!lastFrame) throw new Error("视频尾帧尚未保存到服务器，请重新连接图片后再试");
        if (sameReferenceImage(firstImage, lastImage)) throw new Error("视频首帧和尾帧不能使用同一张图片");
    }

    const frameImages = [withVideoRole(firstImage, "first_frame"), ...(lastImage ? [withVideoRole(lastImage, "last_frame")] : [])];
    const regularImages = referenceImages.filter((image) => !frameImages.some((frame) => sameReferenceImage(frame, image))).map((image) => withVideoRole(image, "reference"));
    return resolvedVideoReferences(mode, [...frameImages, ...regularImages], context.referenceVideos, context.referenceAudios, firstFrame, lastFrame);
}

export function restoreCanvasVideoGenerationReferences(metadata: CanvasNodeMetadata | undefined): ResolvedCanvasVideoReferences | null {
    if (!Array.isArray(metadata?.videoReferences)) return null;
    const images: ReferenceImage[] = [];
    const videos: ReferenceVideo[] = [];
    const audios: ReferenceAudio[] = [];
    for (const snapshot of metadata.videoReferences) {
        const role = normalizeVideoReferenceRole(snapshot.role) || "reference";
        if (!snapshot.source?.trim()) continue;
        if (snapshot.type === "image") {
            images.push({
                id: snapshot.id,
                name: snapshot.name,
                type: snapshot.mimeType,
                dataUrl: snapshot.previewUrl || snapshot.serverUrl || snapshot.remoteUrl || snapshot.source,
                url: snapshot.serverUrl || snapshot.remoteUrl || (isDirectUrl(snapshot.source) ? snapshot.source : undefined),
                storageKey: snapshot.storageKey || (isStorageKey(snapshot.source) ? snapshot.source : undefined),
                remoteUrl: snapshot.remoteUrl,
                serverUrl: snapshot.serverUrl,
                width: snapshot.width,
                height: snapshot.height,
                videoRole: role,
            });
            continue;
        }
        if (role !== "reference") throw new Error("视频首尾帧只能使用图片素材");
        if (snapshot.type === "video") {
            videos.push({
                id: snapshot.id,
                name: snapshot.name,
                type: snapshot.mimeType,
                url: snapshot.previewUrl || snapshot.source,
                storageKey: snapshot.storageKey || (isStorageKey(snapshot.source) ? snapshot.source : undefined),
                bytes: snapshot.bytes,
                width: snapshot.width,
                height: snapshot.height,
                durationMs: snapshot.durationMs,
            });
            continue;
        }
        audios.push({
            id: snapshot.id,
            name: snapshot.name,
            type: snapshot.mimeType,
            url: snapshot.previewUrl || snapshot.source,
            storageKey: snapshot.storageKey || (isStorageKey(snapshot.source) ? snapshot.source : undefined),
            durationMs: snapshot.durationMs,
        });
    }
    assertFrameRoles(images);
    const mode = inferReferenceMode(metadata.videoReferenceMode, images);
    assertReferenceModeFrames(mode, images);
    return {
        mode,
        images,
        videos,
        audios,
        snapshots: metadata.videoReferences,
        firstFrame: metadata.videoFirstFrame,
        lastFrame: metadata.videoLastFrame,
    };
}

function resolvedVideoReferences(
    mode: CreativeVideoReferenceMode,
    images: ReferenceImage[],
    videos: ReferenceVideo[],
    audios: ReferenceAudio[],
    firstFrame?: CanvasVideoFrameSelection,
    lastFrame?: CanvasVideoFrameSelection,
): ResolvedCanvasVideoReferences {
    assertFrameRoles(images);
    assertReferenceModeFrames(mode, images);
    return { mode, images, videos, audios, snapshots: snapshotVideoReferences(images, videos, audios), firstFrame, lastFrame };
}

function snapshotVideoReferences(images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[]) {
    return [
        ...images.flatMap((image): CanvasVideoReferenceSnapshot[] => {
            const source = stableImageSource(image);
            if (!source) return [];
            return [
                {
                    type: "image",
                    role: image.videoRole || "reference",
                    id: image.id,
                    name: image.name,
                    mimeType: image.type,
                    source,
                    previewUrl: persistedSource(image.serverUrl, image.remoteUrl, image.url, image.dataUrl) || undefined,
                    storageKey: image.storageKey,
                    remoteUrl: image.remoteUrl,
                    serverUrl: image.serverUrl,
                    width: image.width,
                    height: image.height,
                },
            ];
        }),
        ...videos.flatMap((video): CanvasVideoReferenceSnapshot[] => {
            const source = video.storageKey?.trim() || persistedSource(video.url);
            return source
                ? [
                      {
                          type: "video",
                          role: "reference",
                          id: video.id,
                          name: video.name,
                          mimeType: video.type,
                          source,
                          previewUrl: persistedSource(video.url) || undefined,
                          storageKey: video.storageKey,
                          bytes: video.bytes,
                          width: video.width,
                          height: video.height,
                          durationMs: video.durationMs,
                      },
                  ]
                : [];
        }),
        ...audios.flatMap((audio): CanvasVideoReferenceSnapshot[] => {
            const source = audio.storageKey?.trim() || persistedSource(audio.url);
            return source ? [{ type: "audio", role: "reference", id: audio.id, name: audio.name, mimeType: audio.type, source, previewUrl: persistedSource(audio.url) || undefined, storageKey: audio.storageKey, durationMs: audio.durationMs }] : [];
        }),
    ];
}

function resolveFrameImage(selection: CanvasVideoFrameSelection | undefined, images: ReferenceImage[]) {
    if (!selection) return undefined;
    const current = images.find((image) => (selection.nodeId && image.id === selection.nodeId) || sameSource(selection.source, stableImageSource(image)));
    if (current) return current;
    const previewUrl = persistedSource(selection.serverUrl, selection.remoteUrl, selection.previewUrl);
    return {
        id: selection.nodeId || `frame-${selection.source}`,
        name: `${selection.title || "视频帧"}.png`,
        type: selection.mimeType || "image/png",
        dataUrl: previewUrl || selection.source,
        url: selection.serverUrl || selection.remoteUrl || (isDirectUrl(selection.source) ? selection.source : undefined),
        storageKey: selection.storageKey || (isStorageKey(selection.source) ? selection.source : undefined),
        remoteUrl: selection.remoteUrl,
        serverUrl: selection.serverUrl,
        width: selection.width,
        height: selection.height,
    } satisfies ReferenceImage;
}

function frameSelectionFromImage(image: ReferenceImage, fallback?: CanvasVideoFrameSelection) {
    const source = stableImageSource(image) || fallback?.source || "";
    if (!source) return undefined;
    return {
        nodeId: image.id || fallback?.nodeId,
        title: fallback?.title || image.name.replace(/\.[^.]+$/, "") || "视频帧",
        source,
        previewUrl: persistedSource(image.serverUrl, image.remoteUrl, image.url, image.dataUrl, fallback?.previewUrl) || undefined,
        storageKey: image.storageKey || fallback?.storageKey,
        remoteUrl: image.remoteUrl || fallback?.remoteUrl,
        serverUrl: image.serverUrl || fallback?.serverUrl,
        mimeType: image.type || fallback?.mimeType,
        width: image.width || fallback?.width,
        height: image.height || fallback?.height,
    } satisfies CanvasVideoFrameSelection;
}

function withVideoRole(image: ReferenceImage, role: VideoReferenceRole): ReferenceImage {
    return { ...image, videoRole: role };
}

function assertFrameRoles(images: ReferenceImage[]) {
    const firstFrames = images.filter((image) => image.videoRole === "first_frame");
    const lastFrames = images.filter((image) => image.videoRole === "last_frame");
    if (firstFrames.length > 1) throw new Error("一次只能指定一张视频首帧图片");
    if (lastFrames.length > 1) throw new Error("一次只能指定一张视频尾帧图片");
    if (lastFrames.length && !firstFrames.length) throw new Error("指定视频尾帧时必须同时指定首帧");
    if (firstFrames[0] && lastFrames[0] && sameReferenceImage(firstFrames[0], lastFrames[0])) throw new Error("视频首帧和尾帧不能使用同一张图片");
}

function assertReferenceModeFrames(mode: CreativeVideoReferenceMode, images: ReferenceImage[]) {
    if (mode !== "reference" && !images.some((image) => image.videoRole === "first_frame")) throw new Error("请先选择视频首帧图片");
    if (mode === "first_last" && !images.some((image) => image.videoRole === "last_frame")) throw new Error("请先选择视频尾帧图片");
}

function inferReferenceMode(value: unknown, images: ReferenceImage[]): CreativeVideoReferenceMode {
    const normalized = normalizeCanvasVideoReferenceMode(value);
    if (normalized !== "reference") return normalized;
    if (images.some((image) => image.videoRole === "last_frame")) return "first_last";
    if (images.some((image) => image.videoRole === "first_frame")) return "first_frame";
    return "reference";
}

function sameFrameSelection(left: CanvasVideoFrameSelection, right: CanvasVideoFrameSelection) {
    return Boolean((left.nodeId && right.nodeId && left.nodeId === right.nodeId) || sameSource(left.storageKey || left.source, right.storageKey || right.source));
}

function sameReferenceImage(left: ReferenceImage, right: ReferenceImage) {
    return Boolean((left.id && right.id && left.id === right.id) || sameSource(stableImageSource(left), stableImageSource(right)));
}

function stableImageSource(image: ReferenceImage) {
    return image.storageKey?.trim() || persistedSource(image.serverUrl, image.remoteUrl, image.url, image.dataUrl);
}

function sameSource(left: string | undefined, right: string | undefined) {
    return Boolean(left && right && left.trim() === right.trim());
}

function persistedSource(...values: Array<string | undefined>) {
    return values.map((value) => value?.trim() || "").find((value) => value && !value.startsWith("data:") && !value.startsWith("blob:")) || "";
}

function isStorageKey(value: string) {
    return /^(?:image|media):/.test(value);
}

function isDirectUrl(value: string) {
    return /^(?:https?:\/\/|\/)/i.test(value);
}
