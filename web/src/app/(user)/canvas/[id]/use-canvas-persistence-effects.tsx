"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";

import { isGenerationTaskNeedsReviewError } from "@/services/api/generation-task-state";
import { isImageGenerationTaskDeferredError } from "@/services/api/image";
import { CanvasNodeType, isCanvasImageNodeType } from "../types";
import { classifyCanvasVideoTaskFailure } from "./canvas-video-task-recovery";

import { NODE_STATUS_ERROR, NODE_STATUS_LOADING } from "./canvas-page-elements";
import { buildGenerationConfig, isGenerationCanceled, normalizeCanvasConfigNodeLayout, prepareAssistantImages, prepareCanvasImages } from "./canvas-page-utils";
import { pauseCanvasGenerationReview } from "./canvas-generation-review";

import type { CanvasPageState } from "./use-canvas-page-state";
import type { CanvasTaskRuntime } from "./use-canvas-task-runtime";

export function useCanvasPersistenceEffects({ state, tasks }: { state: CanvasPageState; tasks: CanvasTaskRuntime }) {
    const skipInitialProjectSyncRef = useRef(false);
    const videoRetryTimersRef = useRef(new Map<string, number>());
    const [videoRetryNonce, triggerVideoRetry] = useReducer((value: number) => value + 1, 0);
    const {
        message,
        modal,
        params,
        router,
        projectId,
        containerRef,
        imageInputRef,
        uploadTargetRef,
        clipboardRef,
        historyRef,
        lastHistoryRef,
        historyCommitTimerRef,
        viewportSaveTimerRef,
        applyingHistoryRef,
        didInitialCenterRef,
        toolbarHideTimerRef,
        nodeDraggingRef,
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        addAsset,
        userId,
        hydrate,
        loadProject,
        createProject,
        updateProject,
        flushProjectSave,
        renameProject,
        deleteProjects,
        currentProject,
        theme,
        nodes,
        setNodes,
        connections,
        setConnections,
        chatSessions,
        setChatSessions,
        activeChatId,
        setActiveChatId,
        viewport,
        setViewport,
        size,
        setSize,
        selectedNodeIds,
        setSelectedNodeIds,
        selectedConnectionId,
        setSelectedConnectionId,
        hoveredNodeId,
        setHoveredNodeId,
        pendingConnectionCreate,
        setPendingConnectionCreate,
        contextMenu,
        setContextMenu,
        runningNodeId,
        setRunningNodeId,
        isMiniMapOpen,
        setIsMiniMapOpen,
        backgroundMode,
        setBackgroundMode,
        showImageInfo,
        setShowImageInfo,
        clearConfirmOpen,
        setClearConfirmOpen,
        assetPickerOpen,
        setAssetPickerOpen,
        projectLoaded,
        setProjectLoaded,
        toolbarNodeId,
        setToolbarNodeId,
        nodeImageSettingsOpen,
        setNodeImageSettingsOpen,
        dialogNodeId,
        setDialogNodeId,
        editingNodeId,
        setEditingNodeId,
        editRequestNonce,
        setEditRequestNonce,
        infoNodeId,
        setInfoNodeId,
        cropNodeId,
        setCropNodeId,
        maskEditNodeId,
        setMaskEditNodeId,
        splitNodeId,
        setSplitNodeId,
        upscaleNodeId,
        setUpscaleNodeId,
        angleNodeId,
        setAngleNodeId,
        previewNodeId,
        setPreviewNodeId,
        assistantCollapsed,
        setAssistantCollapsed,
        assistantMounted,
        setAssistantMounted,
        assistantClosing,
        setAssistantClosing,
        titleEditing,
        setTitleEditing,
        titleDraft,
        setTitleDraft,
        historyState,
        setHistoryState,
        collapsingBatchIds,
        setCollapsingBatchIds,
        openingBatchIds,
        setOpeningBatchIds,
        isNodeDragging,
        setIsNodeDragging,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        agentCloseTimerRef,
        autoOpenedAgentRef,
        pendingConnectionCreateRef,
        generationRequestsRef,
        resumingImageTaskIdsRef,
        resumingVideoTaskIdsRef,
        resumingTextTaskIdsRef,
        resumingAudioTaskIdsRef,
    } = state;
    const { createHistoryEntry, startGenerationRequest, finishGenerationRequest, stopGenerationByRunningId, confirmStopGeneration, completeVideoTask, completeImageTask, startAndCompleteImageTask, completeTextTask, completeAudioTask } = tasks;
    const clearCanvasLayerProgress = (nodeId: string) => {
        const sourceNodeId = nodesRef.current.find((node) => node.id === nodeId)?.metadata?.sourceLayerNodeId || nodeId;
        message.destroy(`canvas-layers-${sourceNodeId}`);
        message.destroy(`canvas-subject-${sourceNodeId}`);
    };
    const deferReviewedTask = (nodeId: string, errorDetails: string) => {
        clearCanvasLayerProgress(nodeId);
        setNodes((prev) => pauseCanvasGenerationReview(prev, [nodeId], errorDetails));
    };
    const deferVideoTask = useCallback(
        (nodeId: string) => {
            setNodes((prev) => prev.map((item) => (item.id === nodeId && item.metadata?.videoTask ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            const existing = videoRetryTimersRef.current.get(nodeId);
            if (existing) window.clearTimeout(existing);
            const timer = window.setTimeout(() => {
                videoRetryTimersRef.current.delete(nodeId);
                triggerVideoRetry();
            }, 15_000);
            videoRetryTimersRef.current.set(nodeId, timer);
        },
        [setNodes],
    );

    useEffect(
        () => () => {
            videoRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
            videoRetryTimersRef.current.clear();
        },
        [],
    );

    useEffect(() => {
        if (userId) void hydrate();
    }, [hydrate, userId]);

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        setProjectLoaded(false);
        void loadProject(projectId, true)
            .then((project) => {
                const restoredNodes = prepareCanvasImages(project.nodes).map(normalizeCanvasConfigNodeLayout);
                const restoredSessions = prepareAssistantImages(project.chatSessions || []);
                if (cancelled) return;
                skipInitialProjectSyncRef.current = true;
                setNodes(restoredNodes);
                setConnections(project.connections);
                setChatSessions(restoredSessions);
                setActiveChatId(project.activeChatId || null);
                setBackgroundMode(project.backgroundMode);
                setShowImageInfo(project.showImageInfo || false);
                setViewport(project.viewport);
                didInitialCenterRef.current = Boolean(restoredNodes.length || project.connections.length || project.viewport.x || project.viewport.y || project.viewport.k !== 1 || project.createdAt !== project.updatedAt);
                historyRef.current = { past: [], future: [] };
                if (historyCommitTimerRef.current) {
                    clearTimeout(historyCommitTimerRef.current);
                    historyCommitTimerRef.current = null;
                }
                lastHistoryRef.current = {
                    nodes: restoredNodes,
                    connections: project.connections,
                    chatSessions: restoredSessions,
                    activeChatId: project.activeChatId || null,
                    backgroundMode: project.backgroundMode,
                    showImageInfo: project.showImageInfo || false,
                };
                setHistoryState({ canUndo: false, canRedo: false });
                setProjectLoaded(true);
            })
            .catch((error) => {
                if (cancelled) return;
                const text = error instanceof Error ? error.message : "画布项目加载失败";
                if (text.includes("不存在")) router.replace("/canvas");
                else message.error(text);
            });
        return () => {
            cancelled = true;
        };
    }, [loadProject, message, projectId, router, userId]);

    useEffect(() => {
        if (!projectLoaded) return;
        const resumable = nodes.filter((node) => isCanvasImageNodeType(node.type) && node.metadata?.status === NODE_STATUS_LOADING && node.metadata.imageTask && !generationRequestsRef.current.has(node.id));
        resumable.forEach((node) => {
            const task = node.metadata?.imageTask;
            if (!task || resumingImageTaskIdsRef.current.has(node.id)) return;
            resumingImageTaskIdsRef.current.add(node.id);
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const generationConfig = buildGenerationConfig(effectiveConfig, node, "image");
            setRunningNodeId((current) => current || node.id);
            void completeImageTask(node.id, generationConfig, task, controller, node.metadata?.prompt)
                .catch((error) => {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "图片生成失败";
                    clearCanvasLayerProgress(node.id);
                    if (isImageGenerationTaskDeferredError(error)) {
                        message.info(errorDetails);
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails } } : item)));
                        return;
                    }
                    if (isGenerationTaskNeedsReviewError(error)) {
                        deferReviewedTask(node.id, errorDetails);
                        return;
                    }
                    message.error(errorDetails);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, imageTask: undefined } } : item)));
                })
                .finally(() => {
                    resumingImageTaskIdsRef.current.delete(node.id);
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                });
        });
    }, [completeImageTask, effectiveConfig, finishGenerationRequest, message, nodes, projectLoaded, startGenerationRequest]);

    useEffect(() => {
        if (!projectLoaded) return;
        const resumable = nodes.filter((node) => node.type === CanvasNodeType.Video && node.metadata?.status === NODE_STATUS_LOADING && node.metadata.videoTask && !generationRequestsRef.current.has(node.id));
        resumable.forEach((node) => {
            const task = node.metadata?.videoTask;
            if (!task || resumingVideoTaskIdsRef.current.has(node.id)) return;
            resumingVideoTaskIdsRef.current.add(node.id);
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const generationConfig = buildGenerationConfig(effectiveConfig, node, "video");
            setRunningNodeId((current) => current || node.id);
            void completeVideoTask(node.id, generationConfig, task, controller, node.metadata?.prompt)
                .catch((error) => {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "视频生成失败";
                    const failureKind = classifyCanvasVideoTaskFailure(error);
                    if (failureKind === "needs_review") {
                        deferReviewedTask(node.id, errorDetails);
                        return;
                    }
                    if (failureKind === "query_pending") {
                        message.info("视频仍在后台生成，系统会继续查询原任务");
                        deferVideoTask(node.id);
                        return;
                    }
                    message.error(errorDetails);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, videoTask: undefined } } : item)));
                })
                .finally(() => {
                    resumingVideoTaskIdsRef.current.delete(node.id);
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                });
        });
    }, [completeVideoTask, deferVideoTask, effectiveConfig, finishGenerationRequest, message, nodes, projectLoaded, startGenerationRequest, videoRetryNonce]);

    useEffect(() => {
        if (!projectLoaded) return;
        const resumable = nodes.filter((node) => node.type === CanvasNodeType.Text && node.metadata?.status === NODE_STATUS_LOADING && node.metadata.textTask && !generationRequestsRef.current.has(node.id));
        resumable.forEach((node) => {
            const task = node.metadata?.textTask;
            if (!task || resumingTextTaskIdsRef.current.has(node.id)) return;
            resumingTextTaskIdsRef.current.add(node.id);
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const generationConfig = buildGenerationConfig(effectiveConfig, node, "text");
            setRunningNodeId((current) => current || node.id);
            void completeTextTask(node.id, generationConfig, task, controller, node.metadata?.prompt)
                .catch((error) => {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "文本生成失败";
                    if (isGenerationTaskNeedsReviewError(error)) {
                        deferReviewedTask(node.id, errorDetails);
                        return;
                    }
                    message.error(errorDetails);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, textTask: undefined } } : item)));
                })
                .finally(() => {
                    resumingTextTaskIdsRef.current.delete(node.id);
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                });
        });
    }, [completeTextTask, effectiveConfig, finishGenerationRequest, message, nodes, projectLoaded, startGenerationRequest]);

    useEffect(() => {
        if (!projectLoaded) return;
        const resumable = nodes.filter((node) => node.type === CanvasNodeType.Audio && node.metadata?.status === NODE_STATUS_LOADING && node.metadata.audioTask && !generationRequestsRef.current.has(node.id));
        resumable.forEach((node) => {
            const task = node.metadata?.audioTask;
            if (!task || resumingAudioTaskIdsRef.current.has(node.id)) return;
            resumingAudioTaskIdsRef.current.add(node.id);
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const generationConfig = buildGenerationConfig(effectiveConfig, node, "audio");
            setRunningNodeId((current) => current || node.id);
            void completeAudioTask(node.id, generationConfig, task, controller, node.metadata?.prompt)
                .catch((error) => {
                    if (isGenerationCanceled(error)) return;
                    const errorDetails = error instanceof Error ? error.message : "音频生成失败";
                    if (isGenerationTaskNeedsReviewError(error)) {
                        deferReviewedTask(node.id, errorDetails);
                        return;
                    }
                    message.error(errorDetails);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, audioTask: undefined } } : item)));
                })
                .finally(() => {
                    resumingAudioTaskIdsRef.current.delete(node.id);
                    finishGenerationRequest(node.id, controller);
                    setRunningNodeId((current) => (current === node.id ? null : current));
                });
        });
    }, [completeAudioTask, effectiveConfig, finishGenerationRequest, message, nodes, projectLoaded, startGenerationRequest]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(
        () => () => {
            if (agentCloseTimerRef.current) clearTimeout(agentCloseTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        if (!projectLoaded) return;
        if (skipInitialProjectSyncRef.current) {
            skipInitialProjectSyncRef.current = false;
            return;
        }
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useEffect(() => {
        if (!projectLoaded) return;
        const flushPendingSave = () => {
            updateProject(projectId, {
                nodes: nodesRef.current,
                connections: connectionsRef.current,
                chatSessions,
                activeChatId,
                backgroundMode,
                showImageInfo,
                viewport: viewportRef.current,
            });
            void flushProjectSave(projectId, true);
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") flushPendingSave();
        };
        window.addEventListener("pagehide", flushPendingSave);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.removeEventListener("pagehide", flushPendingSave);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [activeChatId, backgroundMode, chatSessions, flushProjectSave, projectId, projectLoaded, showImageInfo, updateProject]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, pendingConnectionCreate]);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);
}
