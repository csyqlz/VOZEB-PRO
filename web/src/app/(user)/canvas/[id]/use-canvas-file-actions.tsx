"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect } from "react";

import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { uploadMediaFile } from "@/services/file-storage";
import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";
import { fitNodeSize } from "../utils/canvas-node-size";

import { CANVAS_DROP_NODE_OFFSET, NODE_STATUS_SUCCESS, VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH, createCanvasNode } from "./canvas-page-elements";
import { audioMetadata, imageMetadata, uploadCanvasImage, videoMetadata } from "./canvas-page-utils";

import type { CanvasInteractions } from "./use-canvas-interactions";
import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasFileActions({ state, interactions }: { state: CanvasPageState; interactions: CanvasInteractions }) {
    const {
        message,
        setNodes,
        size,
        setSelectedNodeIds,
        selectedConnectionId,
        setSelectedConnectionId,
        setHoveredNodeId,
        setPendingConnectionCreate,
        setContextMenu,
        setToolbarNodeId,
        setDialogNodeId,
        setEditingNodeId,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setEmotionNodeId,
        nodesRef,
        selectedNodeIdsRef,
    } = state;
    const { getCanvasCenter, deleteNodes, deleteConnection, copySelectedNodes, pasteCopiedNodes, undoCanvas, redoCanvas } = interactions;

    const createImageFileNode = useCallback(async (file: File, position: Position, preserveSelection = false, openDialog = true) => {
        const image = await uploadCanvasImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${nanoid()}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
        setSelectedConnectionId(null);
        if (openDialog) setDialogNodeId(id);
        return id;
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position, preserveSelection = false, openDialog = true) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${nanoid()}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
        setSelectedConnectionId(null);
        if (openDialog) setDialogNodeId(id);
        return id;
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position, preserveSelection = false) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${nanoid()}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
        setSelectedConnectionId(null);
        return id;
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom]")) return;
            if (!event.clipboardData) return;
            const images = clipboardImageFiles(event.clipboardData);
            if (images.length) {
                event.preventDefault();
                setSelectedNodeIds(new Set());
                const center = getCanvasCenter();
                void Promise.allSettled(images.map((file, index) => createImageFileNode(file, { x: center.x + index * CANVAS_DROP_NODE_OFFSET, y: center.y + index * CANVAS_DROP_NODE_OFFSET }, true, false))).then((results) => {
                    const failures = results.filter((result) => result.status === "rejected");
                    if (failures.length) message.error(failures.length === images.length ? "剪切板图片添加失败" : `有 ${failures.length} 张剪切板图片添加失败`);
                    if (failures.length < images.length) message.success(`已从剪切板添加 ${images.length - failures.length} 张图片`);
                });
                return;
            }
            const text = event.clipboardData?.getData("text/plain") || "";
            if (!text.trim()) return;
            event.preventDefault();
            if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, setSelectedNodeIds]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                if (pasteCopiedNodes()) event.preventDefault();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setEmotionNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, redoCanvas, selectedConnectionId, undoCanvas]);
    return {
        createImageFileNode,
        createVideoFileNode,
        createAudioFileNode,
        createTextNodeFromClipboard,
    };
}

export type CanvasFileActions = ReturnType<typeof useCanvasFileActions>;
