"use client";

import { useCallback } from "react";

import { resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { useCanvasStore } from "../stores/use-canvas-store";
import { autoLayoutCanvas, isAgentInternalNode } from "../utils/canvas-auto-layout";

import { CanvasHistoryEntry } from "./canvas-page-elements";

import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasNavigationActions({ state }: { state: CanvasPageState }) {
    const siteTitle = usePublicSessionStore((current) => resolveSiteTitle(current.payload?.settings?.site?.title));
    const {
        message,
        router,
        projectId,
        containerRef,
        historyRef,
        lastHistoryRef,
        historyCommitTimerRef,
        applyingHistoryRef,
        createProject,
        deleteProjects,
        nodes,
        setNodes,
        connections,
        setConnections,
        chatSessions,
        setChatSessions,
        activeChatId,
        setActiveChatId,
        setViewport,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        backgroundMode,
        setBackgroundMode,
        showImageInfo,
        setShowImageInfo,
        setHistoryState,
        nodesRef,
        viewportRef,
    } = state;

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const locateCanvasNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const k = Math.min(1, Math.max(0.45, viewportRef.current.k));
            setSelectedNodeIds(new Set([nodeId]));
            setViewport({ x: size.width / 2 - (node.position.x + node.width / 2) * k, y: size.height / 2 - (node.position.y + node.height / 2) * k, k });
        },
        [size.height, size.width],
    );

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const autoLayout = useCallback(() => {
        const measuredSize = containerRef.current?.getBoundingClientRect();
        const canvasWidth = measuredSize?.width || size.width;
        const canvasHeight = measuredSize?.height || size.height;
        const availableWidth = Math.max(1, canvasWidth - 128);
        const availableHeight = Math.max(1, canvasHeight - 152);
        const next = autoLayoutCanvas(nodesRef.current, connections, { width: availableWidth, height: availableHeight });
        if (!next.length) return message.info("画布上还没有节点");
        const visible = next.filter((node) => !isAgentInternalNode(node));
        if (!visible.length) return message.info("画布上没有可整理的可见节点");
        setNodes(next);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        const left = Math.min(...visible.map((node) => node.position.x));
        const top = Math.min(...visible.map((node) => node.position.y));
        const right = Math.max(...visible.map((node) => node.position.x + node.width));
        const bottom = Math.max(...visible.map((node) => node.position.y + node.height));
        const contentWidth = Math.max(1, right - left);
        const contentHeight = Math.max(1, bottom - top);
        const scale = Math.min(1, Math.max(0.08, Math.min(availableWidth / contentWidth, availableHeight / contentHeight)));
        setViewport({ x: canvasWidth / 2 - (left + contentWidth / 2) * scale, y: canvasHeight / 2 - (top + contentHeight / 2) * scale, k: scale });
        message.success("画布已整理，操作可撤销");
    }, [connections, containerRef, message, size.height, size.width]);

    const createAndOpenProject = useCallback(async () => {
        try {
            const id = await createProject(`${siteTitle} 画布 ${useCanvasStore.getState().summaries.length + 1}`);
            router.push(`/canvas/${id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布创建失败");
        }
    }, [createProject, message, router, siteTitle]);

    const deleteCurrentProject = useCallback(async () => {
        try {
            await deleteProjects([projectId]);
            router.push("/canvas");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布删除失败");
        }
    }, [deleteProjects, message, projectId, router]);
    return {
        resetViewport,
        locateCanvasNode,
        setZoomScale,
        applyHistory,
        undoCanvas,
        redoCanvas,
        autoLayout,
        createAndOpenProject,
        deleteCurrentProject,
    };
}

export type CanvasNavigationActions = ReturnType<typeof useCanvasNavigationActions>;
