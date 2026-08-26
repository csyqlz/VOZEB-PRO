"use client";

import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { readImageMeta } from "@/lib/image-utils";
import { resolveStoredImageDataUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { resolveMediaUrl, type UploadedFile } from "@/services/file-storage";
import { parseServerMediaUrl, serverMediaUrl } from "@/services/server-media-storage";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { CANVAS_CONFIG_NODE_HEIGHT, NODE_DEFAULT_SIZE } from "../constants";
import type { CanvasImageAngleParams } from "../components/canvas-node-angle-dialog";
import type { NodeGenerationInput } from "../components/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "../components/canvas-node-prompt-panel";
import { resolveCanvasGenerationModel } from "../utils/canvas-node-config";
import { nodeSizeFromRatio, resizeImageNodeToNaturalRatio } from "../utils/canvas-node-size";
import { PANORAMA_IMAGE_SIZE } from "../utils/canvas-panorama";
import { isAgentInternalNode } from "../utils/canvas-auto-layout";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type ConnectionHandle } from "../types";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export async function uploadCanvasImage(input: string | Blob): Promise<UploadedImage> {
    const image = await uploadImage(input);
    return { ...image, url: await resolveStoredImageDataUrl(image.storageKey, image.url) };
}

type GeneratedCanvasImage = {
    dataUrl?: string;
    remoteUrl?: string;
    serverUrl?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

export async function uploadGeneratedCanvasImage(generated: GeneratedCanvasImage): Promise<UploadedImage> {
    const url = generated.dataUrl || "";
    const remoteUrl = isRemoteGeneratedUrl(generated.remoteUrl || "") ? generated.remoteUrl || "" : isRemoteGeneratedUrl(url) ? url : "";
    const serverUrl = isServerGeneratedUrl(generated.serverUrl || "") ? generated.serverUrl || "" : isServerGeneratedUrl(url) ? url : "";
    const existing = existingGeneratedCanvasImage(generated, serverUrl, remoteUrl);
    if (existing) return existing;
    const localUrl = isLocalGeneratedUrl(url) ? url : "";
    const candidates = Array.from(new Set([serverUrl, localUrl, url, remoteUrl].filter(Boolean)));
    for (const candidate of candidates) {
        try {
            const image = await uploadCanvasImage(candidate);
            return { ...image, remoteUrl: remoteUrl || undefined, serverUrl: image.serverUrl || serverUrl || image.url };
        } catch {
            // Try the next fallback source.
        }
    }
    throw new Error("图片保存到服务器失败");
}

function existingGeneratedCanvasImage(generated: GeneratedCanvasImage, serverUrl: string, remoteUrl: string): UploadedImage | null {
    const reference = parseServerMediaUrl(serverUrl);
    const width = Number(generated.width);
    const height = Number(generated.height);
    const bytes = Number(generated.bytes);
    const mimeType = generated.mimeType?.trim().toLowerCase() || "";
    if (!reference?.storageKey.startsWith("permanent/") || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 || !Number.isFinite(bytes) || bytes <= 0 || !mimeType.startsWith("image/")) return null;
    return {
        url: reference.url,
        storageKey: reference.storageKey,
        remoteUrl: remoteUrl || undefined,
        serverUrl: reference.url,
        width,
        height,
        bytes,
        mimeType,
    };
}

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, remoteUrl: image.remoteUrl, serverUrl: image.serverUrl, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

export function canvasNodeReferenceImage(node: CanvasNodeData): ReferenceImage {
    const content = node.metadata?.content || "";
    const remoteUrl = isRemoteGeneratedUrl(node.metadata?.remoteUrl || "") ? node.metadata?.remoteUrl || "" : isRemoteGeneratedUrl(content) ? content : "";
    const serverUrl = isServerGeneratedUrl(node.metadata?.serverUrl || "") ? node.metadata?.serverUrl || "" : isServerGeneratedUrl(content) ? content : "";
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata?.mimeType || "image/png",
        dataUrl: content,
        storageKey: node.metadata?.storageKey,
        url: serverUrl || remoteUrl || undefined,
        remoteUrl: remoteUrl || undefined,
        serverUrl: serverUrl || undefined,
        width: node.metadata?.naturalWidth || node.width,
        height: node.metadata?.naturalHeight || node.height,
    };
}

export function isRemoteGeneratedUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

export function isLocalGeneratedUrl(value: string) {
    return value.startsWith("data:") || value.startsWith("blob:");
}

export function isServerGeneratedUrl(value: string) {
    return value.startsWith("/api/generation-log-assets/");
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return {
        content: video.url,
        storageKey: video.storageKey,
        remoteUrl: video.remoteUrl,
        serverUrl: video.serverUrl,
        status: "success",
        naturalWidth: video.width,
        naturalHeight: video.height,
        bytes: video.bytes,
        mimeType: video.mimeType || "video/mp4",
        durationMs: video.durationMs,
    };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, remoteUrl: audio.remoteUrl, serverUrl: audio.serverUrl, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

export function replaceCanvasNodeMediaMetadata(current: CanvasNodeMetadata | undefined, media: CanvasNodeMetadata, patch: CanvasNodeMetadata = {}): CanvasNodeMetadata {
    return {
        ...current,
        prompt: undefined,
        sourcePrompt: undefined,
        panoramaSourcePrompt: undefined,
        generationType: undefined,
        model: undefined,
        size: undefined,
        quality: undefined,
        count: undefined,
        seconds: undefined,
        vquality: undefined,
        generateAudio: undefined,
        watermark: undefined,
        videoReferenceMode: undefined,
        videoFirstFrame: undefined,
        videoLastFrame: undefined,
        videoReferences: undefined,
        audioVoice: undefined,
        audioFormat: undefined,
        audioSpeed: undefined,
        audioInstructions: undefined,
        cameraControl: undefined,
        panoramaProjection: undefined,
        references: undefined,
        isBatchRoot: undefined,
        batchRootId: undefined,
        batchChildIds: undefined,
        batchUsesReferenceImages: undefined,
        primaryImageId: undefined,
        imageBatchExpanded: undefined,
        imageTask: undefined,
        imageEditMask: undefined,
        imageEditValidationMask: undefined,
        preserveUnmaskedPixels: undefined,
        imageOutputBackground: undefined,
        videoTask: undefined,
        textTask: undefined,
        audioTask: undefined,
        errorDetails: undefined,
        freeResize: false,
        ...media,
        ...patch,
    };
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions || "",
    };
}

export function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const stored = url.startsWith("image:") || /^(?:temporary|permanent)\//.test(url);
            const dataUrl = stored ? await resolveStoredImageDataUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: stored ? url : undefined, serverUrl: stored ? dataUrl : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function resolveMetadataImageEditMask(metadata: CanvasNodeMetadata): Promise<ReferenceImage | null | undefined> {
    const mask = metadata.imageEditMask;
    if (!mask) return undefined;
    const dataUrl = await resolveStoredImageDataUrl(mask.storageKey, mask.serverUrl || "");
    if (!dataUrl) return null;
    return {
        id: `mask-${mask.storageKey}`,
        name: "mask.png",
        type: mask.mimeType || "image/png",
        dataUrl,
        storageKey: mask.storageKey,
        serverUrl: mask.serverUrl,
        width: mask.width,
        height: mask.height,
    };
}

export async function resolveMetadataImageEditValidationMask(metadata: CanvasNodeMetadata): Promise<ReferenceImage | null | undefined> {
    const mask = metadata.imageEditValidationMask;
    if (!mask) return undefined;
    const dataUrl = await resolveStoredImageDataUrl(mask.storageKey, mask.serverUrl || "");
    if (!dataUrl) return null;
    return {
        id: `validation-mask-${mask.storageKey}`,
        name: "validation-mask.png",
        type: mask.mimeType || "image/png",
        dataUrl,
        storageKey: mask.storageKey,
        serverUrl: mask.serverUrl,
        width: mask.width,
        height: mask.height,
    };
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(nodes.map((node) => hydrateCanvasNode(node).catch(() => node)));
}

export function prepareCanvasImages(nodes: CanvasNodeData[]) {
    return nodes.map((node) => {
        const content = node.metadata?.content;
        const fallbackContent = generatedContentFallback(content, node.metadata?.remoteUrl, node.metadata?.serverUrl);
        if (!node.metadata || (!node.metadata.storageKey && !content?.startsWith("blob:") && content)) return resizePreparedImage(node);
        const stableContent = node.metadata.storageKey ? serverMediaUrl(node.metadata.storageKey, fallbackContent) : fallbackContent;
        if (!stableContent || stableContent === content) return resizePreparedImage(node);
        return resizePreparedImage({ ...node, metadata: { ...node.metadata, content: stableContent } });
    });
}

function resizePreparedImage(node: CanvasNodeData) {
    if (!isCanvasImageNodeType(node.type) || node.type === CanvasNodeType.Panorama) return node;
    const naturalWidth = node.metadata?.naturalWidth;
    const naturalHeight = node.metadata?.naturalHeight;
    return naturalWidth && naturalHeight ? resizeImageNodeToNaturalRatio(node, naturalWidth, naturalHeight) : node;
}

async function hydrateCanvasNode(node: CanvasNodeData) {
    const content = node.metadata?.content;
    const fallbackContent = generatedContentFallback(content, node.metadata?.remoteUrl, node.metadata?.serverUrl);
    if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, fallbackContent) } };
    if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && content?.startsWith("blob:") && fallbackContent) return { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && !content && fallbackContent) return { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    if (!isCanvasImageNodeType(node.type) || !fallbackContent) return node;
    let hydratedNode = node;
    if (node.metadata?.storageKey) hydratedNode = { ...node, metadata: { ...node.metadata, content: await resolveStoredImageDataUrl(node.metadata.storageKey, fallbackContent) } };
    else if (content?.startsWith("blob:") && fallbackContent) hydratedNode = { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    else if (!content && fallbackContent) hydratedNode = { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    const contentValue = content || "";
    if (contentValue.startsWith("data:image/")) hydratedNode = { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadCanvasImage(contentValue)) } };
    if (hydratedNode.type === CanvasNodeType.Panorama) return hydratedNode;
    const naturalWidth = hydratedNode.metadata?.naturalWidth;
    const naturalHeight = hydratedNode.metadata?.naturalHeight;
    if (naturalWidth && naturalHeight) return resizeImageNodeToNaturalRatio(hydratedNode, naturalWidth, naturalHeight);
    const dimensions = await readImageMeta(hydratedNode.metadata?.content || fallbackContent);
    return resizeImageNodeToNaturalRatio(hydratedNode, dimensions.width, dimensions.height);
}

export function generatedContentFallback(content?: string, remoteFallback?: string, serverFallback?: string) {
    const value = content || "";
    const localValue = value.startsWith("data:") ? value : "";
    const remoteUrl = isRemoteGeneratedUrl(remoteFallback || "") ? remoteFallback || "" : isRemoteGeneratedUrl(value) ? value : "";
    const serverUrl = isServerGeneratedUrl(serverFallback || "") ? serverFallback || "" : isServerGeneratedUrl(value) ? value : "";
    const fallback = serverUrl || localValue || (value && !value.startsWith("blob:") ? value : "") || remoteUrl;
    return browserReadableMediaUrl(fallback);
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        try {
            if (item.storageKey) return { ...item, dataUrl: await resolveStoredImageDataUrl(item.storageKey, item.dataUrl) };
            if (item.dataUrl?.startsWith("data:image/")) {
                const image = await uploadCanvasImage(item.dataUrl);
                return { ...item, dataUrl: image.url, storageKey: image.storageKey };
            }
        } catch {
            return item;
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function prepareAssistantImages(sessions: CanvasAssistantSession[]) {
    return sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) => ({
            ...message,
            references: (message.references || []).map((item) => {
                const dataUrl = item.storageKey ? serverMediaUrl(item.storageKey, item.dataUrl) : item.dataUrl;
                return dataUrl && dataUrl !== item.dataUrl ? { ...item, dataUrl } : item;
            }),
        })),
    }));
}

export function getGenerationCount(count: string) {
    const value = Math.floor(Number(count));
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = {
        ...node,
        metadata: {
            ...node.metadata,
            ...safePatch,
            ...(typeof safePatch.size === "string" ? { sizeLocked: safePatch.size !== "auto" } : {}),
        },
    };
    if (node.type === CanvasNodeType.Config && typeof safePatch.configDetailsOpen === "boolean") {
        return { ...next, height: safePatch.configDetailsOpen ? CANVAS_CONFIG_NODE_HEIGHT.expanded : CANVAS_CONFIG_NODE_HEIGHT.collapsed };
    }
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : node.type === CanvasNodeType.Panorama ? NODE_DEFAULT_SIZE[CanvasNodeType.Panorama] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    if (node.type === CanvasNodeType.Panorama) return { ...next, metadata: { ...next.metadata, size: PANORAMA_IMAGE_SIZE } };
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

export function normalizeCanvasConfigNodeLayout(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Config) return node;
    const configDetailsOpen = node.metadata?.configDetailsOpen === true;
    const height = configDetailsOpen ? CANVAS_CONFIG_NODE_HEIGHT.expanded : CANVAS_CONFIG_NODE_HEIGHT.collapsed;
    if (node.height === height && node.metadata?.configDetailsOpen === configDetailsOpen) return node;
    return { ...node, height, metadata: { ...node.metadata, configDetailsOpen } };
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const model = resolveCanvasGenerationModel(config, mode, node?.metadata?.model);
    return {
        ...config,
        model,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.type === CanvasNodeType.Panorama ? PANORAMA_IMAGE_SIZE : node?.metadata?.size || config.size || defaultConfig.size,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
    };
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || !isCanvasImageNodeType(node.type) || !node.metadata?.content) return [];
    return [canvasNodeReferenceImage(node)];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    if (isAgentInternalNode(node)) return true;
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
