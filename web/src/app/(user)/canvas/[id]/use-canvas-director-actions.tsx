"use client";

import { nanoid } from "nanoid";
import { useCallback, useMemo, useState } from "react";

import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasNodeData } from "../types";
import { fitNodeSize } from "../utils/canvas-node-size";
import type { DirectorDeskCapture } from "../components/director-desk-host";
import { imageMetadata, uploadCanvasImage } from "./canvas-page-utils";
import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasDirectorActions({ state }: { state: CanvasPageState }) {
    const { message, nodes, connections, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setDialogNodeId } = state;
    const [directorNodeId, setDirectorNodeId] = useState<string | null>(null);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const directorNode = directorNodeId ? nodeById.get(directorNodeId) || null : null;
    const directorPanorama = useMemo(() => {
        if (!directorNode) return null;
        const connection = [...connections].reverse().find((item) => item.toNodeId === directorNode.id && isCanvasImageNodeType(nodeById.get(item.fromNodeId)?.type));
        if (!connection) return null;
        const imageNode = nodeById.get(connection.fromNodeId);
        return imageNode && isCanvasImageNodeType(imageNode.type) && imageNode.metadata?.content ? { connection, imageNode } : null;
    }, [connections, directorNode, nodeById]);

    const openDirectorDesk = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Director) return;
            setDialogNodeId(null);
            setDirectorNodeId(node.id);
        },
        [setDialogNodeId],
    );
    const closeDirectorDesk = useCallback(() => setDirectorNodeId(null), []);
    const removeDirectorPanorama = useCallback(
        (connectionId: string) => {
            setConnections((current) => current.filter((connection) => connection.id !== connectionId));
        },
        [setConnections],
    );
    const updateDirectorProject = useCallback(
        (nodeId: string, project: unknown) => {
            setNodes((current) => current.map((node) => (node.id === nodeId && node.type === CanvasNodeType.Director ? { ...node, metadata: { ...node.metadata, directorProject: project } } : node)));
        },
        [setNodes],
    );
    const insertDirectorCaptures = useCallback(
        async (sourceNodeId: string, captures: DirectorDeskCapture[]) => {
            const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId && node.type === CanvasNodeType.Director);
            if (!sourceNode || !captures.length) return;
            try {
                const uploaded = [];
                for (let index = 0; index < captures.length; index += 3) {
                    uploaded.push(...(await Promise.all(captures.slice(index, index + 3).map((capture) => uploadCanvasImage(capture.dataUrl)))));
                }
                const currentSourceNode = nodesRef.current.find((node) => node.id === sourceNodeId && node.type === CanvasNodeType.Director);
                if (!currentSourceNode) return;
                const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const gap = 32;
                const columns = Math.min(uploaded.length, 3);
                const captureNodes = uploaded.map((image, index) => {
                    const size = fitNodeSize(image.width, image.height, imageSpec.width, imageSpec.height);
                    return {
                        id: `image-${nanoid()}`,
                        type: CanvasNodeType.Image,
                        title: captures[index]?.fileName?.replace(/\.[^.]+$/, "") || `导演台镜头 ${index + 1}`,
                        position: {
                            x: currentSourceNode.position.x + currentSourceNode.width + 56 + (index % columns) * (imageSpec.width + gap),
                            y: currentSourceNode.position.y + Math.floor(index / columns) * (imageSpec.height + gap),
                        },
                        width: size.width,
                        height: size.height,
                        metadata: imageMetadata(image),
                    } satisfies CanvasNodeData;
                });
                const nextNodes = nodesRef.current.map((node) => (node.id === sourceNodeId ? { ...node, metadata: { ...node.metadata, directorCaptureCount: (node.metadata?.directorCaptureCount || 0) + captureNodes.length } } : node)).concat(captureNodes);
                const nextConnections = connectionsRef.current.concat(captureNodes.map((node) => ({ id: nanoid(), fromNodeId: sourceNodeId, toNodeId: node.id })));
                nodesRef.current = nextNodes;
                connectionsRef.current = nextConnections;
                setNodes(nextNodes);
                setConnections(nextConnections);
                setSelectedNodeIds(new Set(captureNodes.map((node) => node.id)));
                setSelectedConnectionId(null);
                message.success(`已将 ${captureNodes.length} 张导演台截图放回画布`);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "导演台截图保存失败");
                throw error;
            }
        },
        [connectionsRef, message, nodesRef, setConnections, setNodes, setSelectedConnectionId, setSelectedNodeIds],
    );

    return {
        directorNode,
        directorPanorama,
        openDirectorDesk,
        closeDirectorDesk,
        removeDirectorPanorama,
        updateDirectorProject,
        insertDirectorCaptures,
    };
}

export type CanvasDirectorActions = ReturnType<typeof useCanvasDirectorActions>;
