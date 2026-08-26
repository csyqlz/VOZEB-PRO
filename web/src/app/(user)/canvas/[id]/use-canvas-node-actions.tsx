"use client";

import { nanoid } from "nanoid";
import { useCallback } from "react";

import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";
import { resizeImageNodeToNaturalRatio } from "../utils/canvas-node-size";

import { createCanvasNode } from "./canvas-page-elements";
import { getGenerationCount } from "./canvas-page-utils";

import type { CanvasPageState } from "./use-canvas-page-state";

import type { CanvasInteractionCore } from "./use-canvas-interaction-core";

export function useCanvasNodeActions({ state, core }: { state: CanvasPageState; core: CanvasInteractionCore }) {
    const {
        clipboardRef,
        projectId,
        updateProject,
        flushProjectSave,
        effectiveConfig,
        nodes,
        setNodes,
        connections,
        setConnections,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setHoveredNodeId,
        setContextMenu,
        setRunningNodeId,
        setClearConfirmOpen,
        setToolbarNodeId,
        setDialogNodeId,
        setEditingNodeId,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setAngleNodeId,
        setPreviewNodeId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
    } = state;
    const { getCanvasCenter, cancelPendingConnectionCreate } = core;

    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          sizeLocked: effectiveConfig.size !== "auto",
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const deleteNodes = useCallback((ids: Set<string>) => {
        if (!ids.size) return;
        const allIds = new Set(ids);
        nodesRef.current.forEach((node) => {
            if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
        });
        setNodes((prev) => {
            const next = prev.filter((node) => !allIds.has(node.id));
            return next.map((node) => {
                const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                const primaryNode = next.find((item) => item.id === primaryImageId);
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        batchChildIds: childIds,
                        primaryImageId,
                        content: primaryNode?.metadata?.content || node.metadata.content,
                        naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                        naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                    },
                };
            });
        });
        setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
        setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
        setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
        setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
        setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
        setCropNodeId((current) => (current && allIds.has(current) ? null : current));
        setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
        setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
        setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
        setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
        setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
    }, []);

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const handleImageDimensions = useCallback((nodeId: string, naturalWidth: number, naturalHeight: number) => {
        setNodes((prev) => {
            let changed = false;
            const next = prev.map((node) => {
                if (node.id !== nodeId || node.type !== CanvasNodeType.Image) return node;
                const resized = resizeImageNodeToNaturalRatio(node, naturalWidth, naturalHeight);
                if (resized !== node) changed = true;
                return resized;
            });
            return changed ? next : prev;
        });
    }, []);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        updateProject(projectId, { nodes: [], connections: [] });
        void flushProjectSave(projectId);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
    }, [deselectCanvas, flushProjectSave, projectId, updateProject]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${nanoid()}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node) => {
            const id = `${node.type}-${nanoid()}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const nextConnections = clipboard.connections.flatMap((connection) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${nanoid()}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...nextNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(nextNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(nextNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);
    return {
        createNode,
        deleteNodes,
        deleteConnection,
        handleImageDimensions,
        deselectCanvas,
        clearCanvas,
        duplicateNode,
        copySelectedNodes,
        pasteCopiedNodes,
    };
}

export type CanvasNodeActions = ReturnType<typeof useCanvasNodeActions>;
