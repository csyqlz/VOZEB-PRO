import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
    durationMs?: number;
    text?: string;
    active: boolean;
};

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null) {
    return createCanvasResourceReferenceIndex(nodes, connections).all(contextNodeId);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return createCanvasResourceReferenceIndex(nodes, connections).forNode(node.id);
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return createCanvasResourceReferenceIndex(nodes, connections).resourceNodesFor(nodeId, false);
}

export function createCanvasResourceReferenceIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const inputsByTargetId = new Map<string, CanvasNodeData[]>();
    const connectedConfigBySourceId = new Map<string, string>();
    for (const connection of connections) {
        const source = nodeById.get(connection.fromNodeId);
        const target = nodeById.get(connection.toNodeId);
        if (!source || !target) continue;
        if (isResourceNode(source)) {
            const inputs = inputsByTargetId.get(target.id);
            if (inputs) inputs.push(source);
            else inputsByTargetId.set(target.id, [source]);
        }
        if (target.type === CanvasNodeType.Config && !connectedConfigBySourceId.has(source.id)) connectedConfigBySourceId.set(source.id, target.id);
    }

    const globalReferences = labelResourceNodes(nodes.filter(isResourceNode), false);
    const resourceNodesCache = new Map<string, CanvasNodeData[]>();
    const referencesCache = new Map<string, CanvasResourceReference[]>();
    const resourceNodesFor = (nodeId: string, includeSelf = true) => {
        const cacheKey = `${includeSelf ? "self" : "inputs"}:${nodeId}`;
        const cached = resourceNodesCache.get(cacheKey);
        if (cached) return cached;
        const configId = connectedConfigBySourceId.get(nodeId);
        const configInputs = configId ? (inputsByTargetId.get(configId) || []).filter((node) => node.id !== nodeId) : [];
        const ownInputs = inputsByTargetId.get(nodeId) || [];
        const ownNode = nodeById.get(nodeId);
        const result = configInputs.length ? configInputs : ownInputs.length ? ownInputs : includeSelf && ownNode && isResourceNode(ownNode) ? [ownNode] : [];
        resourceNodesCache.set(cacheKey, result);
        return result;
    };
    const forNode = (nodeId: string) => {
        const cached = referencesCache.get(nodeId);
        if (cached) return cached;
        const references = labelResourceNodes(resourceNodesFor(nodeId), true);
        referencesCache.set(nodeId, references);
        return references;
    };
    return {
        resourceNodesFor,
        forNode,
        all(contextNodeId?: string | null) {
            if (!contextNodeId) return globalReferences;
            const activeByNodeId = new Map(forNode(contextNodeId).map((reference) => [reference.nodeId, reference]));
            return globalReferences.map((reference) => activeByNodeId.get(reference.nodeId) || reference);
        },
    };
}

export type CanvasResourceReferenceIndex = ReturnType<typeof createCanvasResourceReferenceIndex>;

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: node.title || label,
                previewUrl: node.metadata?.content,
                storageKey: node.metadata?.storageKey,
                remoteUrl: node.metadata?.remoteUrl,
                serverUrl: node.metadata?.serverUrl,
                mimeType: node.metadata?.mimeType,
                width: node.metadata?.naturalWidth || node.width,
                height: node.metadata?.naturalHeight || node.height,
                bytes: node.metadata?.bytes,
                durationMs: node.metadata?.durationMs,
                text: node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : undefined,
                active,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return seedanceReferenceLabel("video", index);
    if (kind === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (isCanvasImageNodeType(node.type) && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    return null;
}
