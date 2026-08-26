"use client";

import { useCallback, useMemo, useRef } from "react";

import { nanoid } from "nanoid";
import { buildNodeGenerationInputs, type NodeGenerationInput } from "../components/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle } from "../types";
import { useCanvasLocalAgentBridge } from "../use-canvas-local-agent-bridge";
import { applyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import { createCanvasResourceReferenceIndex, type CanvasResourceReferenceIndex } from "../utils/canvas-resource-references";

import { PendingConnectionCreate, type CanvasCreatableNodeType, createCanvasNode } from "./canvas-page-elements";
import { getGenerationCount, normalizeConnection } from "./canvas-page-utils";

import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasInteractionCore({ state }: { state: CanvasPageState }) {
    const {
        message,
        projectId,
        containerRef,
        toolbarHideTimerRef,
        nodeDraggingRef,
        effectiveConfig,
        currentProject,
        nodes,
        setNodes,
        connections,
        setConnections,
        viewport,
        setViewport,
        size,
        selectedNodeIds,
        setSelectedNodeIds,
        setSelectedConnectionId,
        hoveredNodeId,
        setPendingConnectionCreate,
        setContextMenu,
        toolbarNodeId,
        setToolbarNodeId,
        nodeImageSettingsOpen,
        dialogNodeId,
        setDialogNodeId,
        infoNodeId,
        cropNodeId,
        maskEditNodeId,
        splitNodeId,
        upscaleNodeId,
        angleNodeId,
        emotionNodeId,
        previewNodeId,
        collapsingBatchIds,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
    } = state;

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId(null);
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasCreatableNodeType, pending: PendingConnectionCreate) => {
            const metadata =
                type === CanvasNodeType.Config
                    ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, sizeLocked: effectiveConfig.size !== "auto", count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) }
                    : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
    }, []);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const toolbarNode = toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const emotionNode = emotionNodeId ? nodeById.get(emotionNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const configNodeIds = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Config).map((node) => node.id), [nodes]);
    const resourceReferenceIndexCacheRef = useRef<{ nodes: CanvasNodeData[]; connections: typeof connections; index: CanvasResourceReferenceIndex } | null>(null);
    const resourceReferenceIndex = useMemo(() => {
        const previous = resourceReferenceIndexCacheRef.current;
        if (previous && previous.connections === connections && sameCanvasResourceState(previous.nodes, nodes)) return previous.index;
        const index = createCanvasResourceReferenceIndex(nodes, connections);
        resourceReferenceIndexCacheRef.current = { nodes, connections, index };
        return index;
    }, [connections, nodes]);
    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        configNodeIds.forEach((nodeId) => map.set(nodeId, buildNodeGenerationInputs(nodeId, nodes, connections, resourceReferenceIndex)));
        return map;
    }, [configNodeIds, resourceReferenceIndex]);
    const resourceContextNodeId = dialogNodeId || activeNodeId;
    const canvasResourceReferences = useMemo(() => resourceReferenceIndex.all(resourceContextNodeId), [resourceContextNodeId, resourceReferenceIndex]);
    const resourceReferenceByNodeId = useMemo(() => new Map(canvasResourceReferences.map((reference) => [reference.nodeId, reference])), [canvasResourceReferences]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof resourceReferenceIndex.forNode>>();
        nodes.forEach((node) => map.set(node.id, resourceReferenceIndex.forNode(node.id)));
        return map;
    }, [resourceReferenceIndex]);
    const agentSnapshot = useMemo<CanvasAgentSnapshot>(
        () => ({ projectId, title: currentProject?.title || "未命名画布", imageSize: effectiveConfig.size, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds), viewport }),
        [connections, currentProject?.title, effectiveConfig.size, nodes, projectId, selectedNodeIds, viewport],
    );
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = {
                projectId,
                title: currentProject?.title || "未命名画布",
                imageSize: effectiveConfig.size,
                nodes: nodesRef.current,
                connections: connectionsRef.current,
                selectedNodeIds: Array.from(selectedNodeIdsRef.current),
                viewport: viewportRef.current,
            };
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const next = applyCanvasAgentOps(
                before,
                safeOps.filter((op) => op.type !== "run_generation"),
            );
            nodesRef.current = next.nodes;
            connectionsRef.current = next.connections;
            selectedNodeIdsRef.current = new Set(next.selectedNodeIds);
            viewportRef.current = next.viewport;
            setNodes(next.nodes);
            setConnections(next.connections);
            setSelectedNodeIds(new Set(next.selectedNodeIds));
            setSelectedConnectionId(null);
            setViewport(next.viewport);
            setContextMenu(null);
            if (generationOps.length) {
                queueMicrotask(() =>
                    generationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    }),
                );
            }
            return { ...next, projectId, title: currentProject?.title || "未命名画布" };
        },
        [currentProject?.title, effectiveConfig.size, projectId],
    );
    useCanvasLocalAgentBridge({ snapshot: agentSnapshot, onApplyOps: applyAgentOps });
    return {
        screenToCanvas,
        getCanvasCenter,
        keepNodeToolbar,
        hideNodeToolbar,
        connectNodes,
        createConnectedNode,
        cancelPendingConnectionCreate,
        toolbarNode,
        infoNode,
        cropNode,
        maskEditNode,
        splitNode,
        upscaleNode,
        angleNode,
        emotionNode,
        previewNode,
        hasMultipleSelectedNodes,
        activeNodeId,
        batchChildCountById,
        batchMotionById,
        relatedHighlight,
        configInputsById,
        resourceContextNodeId,
        canvasResourceReferences,
        resourceReferenceByNodeId,
        mentionReferencesByNodeId,
        agentSnapshot,
        applyAgentOps,
    };
}

function sameCanvasResourceState(previous: CanvasNodeData[], next: CanvasNodeData[]) {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
        const left = previous[index];
        const right = next[index];
        if (left.id !== right.id || left.type !== right.type || left.title !== right.title || left.width !== right.width || left.height !== right.height) return false;
        const leftMetadata = left.metadata;
        const rightMetadata = right.metadata;
        if (
            leftMetadata?.content !== rightMetadata?.content ||
            leftMetadata?.prompt !== rightMetadata?.prompt ||
            leftMetadata?.storageKey !== rightMetadata?.storageKey ||
            leftMetadata?.remoteUrl !== rightMetadata?.remoteUrl ||
            leftMetadata?.serverUrl !== rightMetadata?.serverUrl ||
            leftMetadata?.mimeType !== rightMetadata?.mimeType ||
            leftMetadata?.naturalWidth !== rightMetadata?.naturalWidth ||
            leftMetadata?.naturalHeight !== rightMetadata?.naturalHeight ||
            leftMetadata?.bytes !== rightMetadata?.bytes ||
            leftMetadata?.durationMs !== rightMetadata?.durationMs
        )
            return false;
    }
    return true;
}

export type CanvasInteractionCore = ReturnType<typeof useCanvasInteractionCore>;
