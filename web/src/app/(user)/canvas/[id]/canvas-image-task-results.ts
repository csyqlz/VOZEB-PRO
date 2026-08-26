import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { findFreeNodePosition } from "../utils/canvas-agent-ops";
import { fitNodeSize } from "../utils/canvas-node-size";
import { PANORAMA_IMAGE_SIZE } from "../utils/canvas-panorama";

export type CompletedCanvasImage = {
    metadata: CanvasNodeMetadata;
    width: number;
    height: number;
};

export function applyCanvasImageTaskResults(
    nodes: CanvasNodeData[],
    input: {
        nodeId: string;
        taskId: string;
        images: CompletedCanvasImage[];
        prompt?: string;
        model: string;
        size?: string;
    },
) {
    const target = nodes.find((node) => node.id === input.nodeId);
    const primary = input.images[0];
    if (!target || !primary) return nodes;
    const batchRootId = target.metadata?.batchRootId;
    let next = nodes.map((node) => {
        const shouldUpdateTarget = node.id === input.nodeId;
        const shouldUpdateEmptyRoot = Boolean(batchRootId && node.id === batchRootId && (!node.metadata?.content || node.metadata.primaryImageId === input.nodeId));
        if (!shouldUpdateTarget && !shouldUpdateEmptyRoot) return node;
        return completedImageNode(node, primary, input, shouldUpdateEmptyRoot);
    });

    const extraIds: string[] = [];
    input.images.slice(1).forEach((image, offset) => {
        const outputNumber = offset + 2;
        const id = `image-result-${input.taskId}-${outputNumber}`;
        extraIds.push(id);
        if (next.some((node) => node.id === id)) return;
        const isPanorama = target.type === CanvasNodeType.Panorama;
        const imageSize = isPanorama ? NODE_DEFAULT_SIZE[CanvasNodeType.Panorama] : fitNodeSize(image.width, image.height, target.width || NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, target.height || NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
        const position = findFreeNodePosition(next, { x: target.position.x + target.width + 36, y: target.position.y }, imageSize.width, imageSize.height);
        next = [
            ...next,
            {
                id,
                type: isPanorama ? CanvasNodeType.Panorama : CanvasNodeType.Image,
                title: `${target.title} · ${outputNumber}`,
                position,
                width: imageSize.width,
                height: imageSize.height,
                metadata: {
                    ...generatedSiblingMetadata(target.metadata),
                    ...image.metadata,
                    ...(isPanorama ? { size: PANORAMA_IMAGE_SIZE, panoramaProjection: "equirectangular" as const } : { size: input.size }),
                    prompt: input.prompt || target.metadata?.prompt,
                    model: input.model,
                    batchRootId,
                    imageTask: undefined,
                    errorDetails: undefined,
                },
            },
        ];
    });

    if (batchRootId && extraIds.length) {
        next = next.map((node) => (node.id === batchRootId ? { ...node, metadata: { ...node.metadata, batchChildIds: Array.from(new Set([...(node.metadata?.batchChildIds || []), ...extraIds])) } } : node));
    }
    return next;
}

export function applyCanvasImageLayerTaskResults(nodes: CanvasNodeData[], input: { nodeId: string; taskId: string; images: CompletedCanvasImage[]; prompt?: string; model: string; size?: string }) {
    const target = nodes.find((node) => node.id === input.nodeId);
    if (!target || !input.images.length) return nodes;
    let next = nodes;
    input.images.forEach((image, index) => {
        const id = canvasImageLayerResultNodeId(input.nodeId, input.taskId, index);
        const existing = next.find((node) => node.id === id);
        if (existing?.metadata?.imageLayerTaskId === input.taskId && existing.metadata.imageLayerResultIndex === index) return;
        const base = existing || target;
        const imageSize = fitNodeSize(image.width, image.height, base.width || NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, base.height || NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
        const position = existing
            ? { x: existing.position.x + existing.width / 2 - imageSize.width / 2, y: existing.position.y + existing.height / 2 - imageSize.height / 2 }
            : findFreeNodePosition(next, { x: target.position.x + target.width + 36, y: target.position.y }, imageSize.width, imageSize.height);
        const layerNode: CanvasNodeData = {
            ...(existing || target),
            id,
            type: CanvasNodeType.Image,
            title: `图层 ${index + 1}`,
            position,
            width: imageSize.width,
            height: imageSize.height,
            metadata: {
                ...generatedSiblingMetadata(base.metadata),
                ...image.metadata,
                prompt: input.prompt || target.metadata?.prompt,
                model: input.model,
                size: input.size || target.metadata?.size,
                generationType: "edit",
                imageOutputMode: "layers",
                imageLayerTaskId: input.taskId,
                imageLayerResultIndex: index,
                layerName: `图层 ${index + 1}`,
                sourceLayerNodeId: target.metadata?.sourceLayerNodeId,
                imageTask: undefined,
                errorDetails: undefined,
            },
        };
        next = existing ? next.map((node) => (node.id === id ? layerNode : node)) : [...next, layerNode];
    });
    return next;
}

export function canvasImageLayerResultNodeId(targetNodeId: string, taskId: string, resultIndex: number) {
    return resultIndex === 0 ? targetNodeId : `image-layer-${taskId}-${resultIndex + 1}`;
}

function completedImageNode(node: CanvasNodeData, image: CompletedCanvasImage, input: { nodeId: string; prompt?: string; model: string; size?: string }, updateBatchRoot: boolean) {
    const isPanorama = node.type === CanvasNodeType.Panorama;
    const imageSize = isPanorama ? NODE_DEFAULT_SIZE[CanvasNodeType.Panorama] : fitNodeSize(image.width, image.height, node.width || NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, node.height || NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
    const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
    return {
        ...node,
        position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
        width: imageSize.width,
        height: imageSize.height,
        metadata: {
            ...node.metadata,
            ...image.metadata,
            ...(isPanorama ? { size: PANORAMA_IMAGE_SIZE, panoramaProjection: "equirectangular" as const } : { size: input.size || node.metadata?.size }),
            prompt: input.prompt || node.metadata?.prompt,
            model: input.model,
            imageTask: undefined,
            primaryImageId: updateBatchRoot ? input.nodeId : node.metadata?.primaryImageId,
            errorDetails: undefined,
        },
    } satisfies CanvasNodeData;
}

function generatedSiblingMetadata(metadata: CanvasNodeMetadata | undefined): CanvasNodeMetadata {
    if (!metadata) return {};
    const {
        content: _content,
        storageKey: _storageKey,
        remoteUrl: _remoteUrl,
        serverUrl: _serverUrl,
        naturalWidth: _naturalWidth,
        naturalHeight: _naturalHeight,
        bytes: _bytes,
        mimeType: _mimeType,
        imageTask: _imageTask,
        isBatchRoot: _isBatchRoot,
        batchChildIds: _batchChildIds,
        primaryImageId: _primaryImageId,
        ...rest
    } = metadata;
    return rest;
}
