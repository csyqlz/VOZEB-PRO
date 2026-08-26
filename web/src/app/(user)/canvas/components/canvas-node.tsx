"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BriefcaseBusiness, ChevronRight, CircleCheck, Image as ImageIcon, ListChecks, Music2, Palette, RefreshCw, Star, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasNodeData, type Position } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { isCanvasVideoControlPoint } from "../utils/canvas-surface-geometry";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";

function isInteractiveTarget(target: EventTarget | null, event?: Pick<MouseEvent, "clientY">) {
    if (!(target instanceof Element)) return false;
    const video = target.closest("video");
    if (video) {
        const rect = video.getBoundingClientRect();
        if (event && !isCanvasVideoControlPoint(rect, event.clientY)) return false;
        return true;
    }
    return Boolean(target.closest("button,input,textarea,select,audio,[data-canvas-no-drag]"));
}

export type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    editRequestNonce?: number;
    showPanel: boolean;
    showImageInfo: boolean;
    resourceLabel?: CanvasResourceReference;
    mentionReferences?: CanvasResourceReference[];
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    batchCount?: number;
    batchExpanded?: boolean;
    batchClosing?: boolean;
    batchOpening?: boolean;
    batchRecovering?: boolean;
    batchMotion?: { x: number; y: number; index: number };
    onMouseDown: (event: React.MouseEvent | React.PointerEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent | React.PointerEvent, nodeId: string, handleType: "source" | "target") => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd?: (nodeId: string, width: number, height: number, position?: Position) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (node: CanvasNodeData) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onOpenPanel?: (node: CanvasNodeData) => void;
    onImageDimensions?: (nodeId: string, naturalWidth: number, naturalHeight: number) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

import {
    NodeContent,
    nodeContentRenderers,
    BriefNodeContent,
    TaskNodeContent,
    BrandKitNodeContent,
    LoadingContent,
    ErrorContent,
    UnknownNodeContent,
    TextContent,
    ResourceLabelBadge,
    ImageNodeContent,
    EmptyImageContent,
    VideoNodeContent,
    AudioNodeContent,
    ImageContent,
    ImageInfoBar,
    BatchFrame,
    ResizeHandle,
    ConnectionHandleDot,
} from "./canvas-node-content";

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    editRequestNonce = 0,
    showPanel,
    showImageInfo,
    resourceLabel,
    mentionReferences = [],
    renderPanel,
    renderNodeContent,
    batchCount = 0,
    batchExpanded = false,
    batchClosing = false,
    batchOpening = false,
    batchRecovering = false,
    batchMotion,
    onMouseDown,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onToggleBatch,
    onSetBatchPrimary,
    onRetry,
    onGenerateImage,
    onOpenPanel,
    onImageDimensions,
    onViewImage,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [panelPlacement, setPanelPlacement] = useState<"top" | "bottom">("bottom");
    const [panelMaxHeight, setPanelMaxHeight] = useState<number>();
    const [panelMaxWidth, setPanelMaxWidth] = useState<number>();
    const [panelOffsetX, setPanelOffsetX] = useState(0);
    const nodeRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const panelOffsetXRef = useRef(0);
    const hasImageContent = isCanvasImageNodeType(data.type) && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const isConfig = data.type === CanvasNodeType.Config;
    const nodeBackground = isConfig ? theme.node.panel : hasImageContent || hasVideoContent ? "transparent" : theme.node.fill;
    const isBatchRoot = data.type === CanvasNodeType.Image && Boolean(data.metadata?.isBatchRoot) && batchCount > 1;
    const isBatchChild = data.type === CanvasNodeType.Image && Boolean(data.metadata?.batchRootId);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    const imageBorderColor = isActive ? selectionBlue : isRelated && !isBatchChild ? theme.node.muted : theme.node.stroke;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const clickStartRef = useRef<{ x: number; y: number } | null>(null);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
        currentWidth: 0,
        currentHeight: 0,
        currentPosition: { x: 0, y: 0 },
    });

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!editRequestNonce || data.type !== CanvasNodeType.Text) return;
        setIsEditingContent(true);
    }, [data.type, editRequestNonce]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            const position = {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            };
            resizeRef.current.currentWidth = width;
            resizeRef.current.currentHeight = height;
            resizeRef.current.currentPosition = position;
            onResize(data.id, width, height, position);
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        if (!resizeRef.current.isResizing) return;
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd?.(data.id, resizeRef.current.currentWidth, resizeRef.current.currentHeight, resizeRef.current.currentPosition);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (isCanvasImageNodeType(data.type) && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video,
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
            currentWidth: data.width,
            currentHeight: data.height,
            currentPosition: data.position,
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    const handleNodeDoubleClick = (event: React.MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button,input,textarea,select,video,audio,[data-canvas-no-drag]")) return;
        if (isBatchRoot) {
            event.stopPropagation();
            onToggleBatch?.(data.id);
            return;
        }
        if (data.type === CanvasNodeType.Image && hasImageContent) {
            event.stopPropagation();
            onViewImage?.(data);
            return;
        }
        if (data.type === CanvasNodeType.Text) {
            event.stopPropagation();
            setIsEditingContent(true);
            return;
        }
        if (data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Panorama || data.type === CanvasNodeType.Video || data.type === CanvasNodeType.Audio || data.type === CanvasNodeType.Config) {
            event.stopPropagation();
            onOpenPanel?.(data);
        }
    };

    const rememberNodePointer = (event: React.MouseEvent | React.PointerEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button,input,textarea,select,video,audio,[data-canvas-no-drag]")) return;
        clickStartRef.current = { x: event.clientX, y: event.clientY };
    };

    const handleNodeClick = (event: React.MouseEvent) => {
        const start = clickStartRef.current;
        clickStartRef.current = null;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button,input,textarea,select,video,audio,[data-canvas-no-drag]")) return;
        if (data.type === CanvasNodeType.Text) {
            setIsEditingContent(true);
            return;
        }
        if (data.type === CanvasNodeType.Image || data.type === CanvasNodeType.Panorama || data.type === CanvasNodeType.Video || data.type === CanvasNodeType.Audio || data.type === CanvasNodeType.Config) {
            onOpenPanel?.(data);
        }
    };

    const activateTextEditorAfterClick = (event: React.MouseEvent | React.PointerEvent) => {
        if (data.type !== CanvasNodeType.Text || isInteractiveTarget(event.target, event)) return;
        const start = clickStartRef.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6 && !event.shiftKey && !event.ctrlKey && !event.metaKey) setIsEditingContent(true);
    };

    const updatePanelPlacement = useCallback(() => {
        const nodeElement = nodeRef.current;
        const panelElement = panelRef.current;
        const surfaceElement = nodeElement?.closest<HTMLElement>("[data-canvas-surface]");
        if (!showPanel || !nodeElement || !panelElement || !surfaceElement) return;
        const nodeRect = nodeElement.getBoundingClientRect();
        const panelRect = panelElement.getBoundingClientRect();
        const surfaceRect = surfaceElement.getBoundingClientRect();
        const visualViewport = window.visualViewport;
        const viewportLeft = visualViewport?.offsetLeft ?? 0;
        const viewportTop = visualViewport?.offsetTop ?? 0;
        const viewportRight = viewportLeft + (visualViewport?.width ?? window.innerWidth);
        const viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
        const toolbarRect = surfaceElement.querySelector<HTMLElement>("[data-canvas-toolbar]")?.getBoundingClientRect();
        const usableLeft = Math.max(surfaceRect.left, viewportLeft) + 16;
        const usableRight = Math.min(surfaceRect.right, viewportRight) - 16;
        const usableTop = Math.max(surfaceRect.top, viewportTop);
        const usableBottom = Math.min(surfaceRect.bottom, viewportBottom, toolbarRect ? toolbarRect.top - 16 : surfaceRect.bottom);
        const availableWidth = Math.max(0, usableRight - usableLeft);
        const renderedScale = Math.max(scale, 0.01);
        const nextMaxWidth = availableWidth > 0 ? availableWidth / renderedScale : undefined;
        const currentOffset = panelOffsetXRef.current * renderedScale;
        const centeredPanelLeft = panelRect.left - currentOffset;
        const centeredPanelRight = panelRect.right - currentOffset;
        const centeredPanelCenter = (centeredPanelLeft + centeredPanelRight) / 2;
        const renderedPanelWidth = Math.min(panelRect.width, availableWidth);
        const minimumCenter = usableLeft + renderedPanelWidth / 2;
        const maximumCenter = usableRight - renderedPanelWidth / 2;
        const desiredCenter = minimumCenter <= maximumCenter ? Math.min(maximumCenter, Math.max(minimumCenter, centeredPanelCenter)) : (usableLeft + usableRight) / 2;
        const nextOffsetX = (desiredCenter - centeredPanelCenter) / renderedScale;
        const spaceAbove = Math.max(0, nodeRect.top - usableTop - 16);
        const spaceBelow = Math.max(0, usableBottom - nodeRect.bottom);
        const nextPlacement = panelRect.bottom > usableBottom && spaceAbove >= 96 ? "top" : "bottom";
        const availableSpace = nextPlacement === "top" ? spaceAbove : spaceBelow;
        setPanelPlacement((current) => (current === nextPlacement ? current : nextPlacement));
        if (availableSpace > 0) setPanelMaxHeight((current) => (current === availableSpace ? current : availableSpace));
        if (nextMaxWidth) setPanelMaxWidth((current) => (current !== undefined && Math.abs(current - nextMaxWidth) < 0.1 ? current : nextMaxWidth));
        panelOffsetXRef.current = nextOffsetX;
        setPanelOffsetX((current) => (Math.abs(current - nextOffsetX) < 0.1 ? current : nextOffsetX));
    }, [scale, showPanel]);

    useLayoutEffect(() => {
        if (!showPanel || !panelRef.current) return;
        updatePanelPlacement();
        const observer = new ResizeObserver(updatePanelPlacement);
        observer.observe(panelRef.current);
        const surfaceElement = nodeRef.current?.closest<HTMLElement>("[data-canvas-surface]");
        if (surfaceElement) observer.observe(surfaceElement);
        const visualViewport = window.visualViewport;
        window.addEventListener("resize", updatePanelPlacement);
        visualViewport?.addEventListener("resize", updatePanelPlacement);
        visualViewport?.addEventListener("scroll", updatePanelPlacement);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updatePanelPlacement);
            visualViewport?.removeEventListener("resize", updatePanelPlacement);
            visualViewport?.removeEventListener("scroll", updatePanelPlacement);
        };
    }, [showPanel, data.id, data.position.x, data.position.y, scale, updatePanelPlacement]);

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    return (
        <div
            ref={nodeRef}
            data-node-id={data.id}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${isSelected ? "z-50" : "z-10"}`}
            style={{
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
            }}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onClick={handleNodeClick}
            onMouseUp={activateTextEditorAfterClick}
            onPointerUp={(event) => {
                if (event.pointerType !== "mouse") activateTextEditorAfterClick(event);
            }}
            onDoubleClick={handleNodeDoubleClick}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            <div
                className={`relative h-full w-full overflow-visible ${isConfig ? "rounded-2xl border" : "rounded-3xl border-2"}`}
                style={{
                    background: nodeBackground,
                    borderColor: hasImageContent ? imageBorderColor : isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.stroke,
                    boxShadow: isActive ? `0 0 0 1px ${selectionBlue}55` : isRelated && !isBatchChild ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => {
                    rememberNodePointer(event);
                    onMouseDown(event, data.id);
                }}
                onPointerDown={(event) => {
                    rememberNodePointer(event);
                    if (event.pointerType !== "mouse") onMouseDown(event, data.id);
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: nodeBackground,
                            "--batch-from-x": `${batchMotion?.x || 0}px`,
                            "--batch-from-y": `${batchMotion?.y || 0}px`,
                            "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
                            animation: data.metadata?.batchRootId ? (batchClosing ? "canvas-batch-child-out 260ms cubic-bezier(.4,0,.2,1) both" : "canvas-batch-child-in 340ms cubic-bezier(.2,.85,.18,1) both") : undefined,
                            animationDelay: data.metadata?.batchRootId ? `${batchClosing ? 0 : 45 + (batchMotion?.index || 0) * 24}ms` : undefined,
                        } as React.CSSProperties
                    }
                >
                    <NodeContent
                        node={data}
                        theme={theme}
                        scale={scale}
                        isEditingContent={isEditingContent}
                        textareaRef={textareaRef}
                        isBatchRoot={isBatchRoot}
                        batchCount={batchCount}
                        batchExpanded={batchExpanded}
                        batchOpening={batchOpening}
                        batchRecovering={batchRecovering}
                        renderNodeContent={renderNodeContent}
                        mentionReferences={mentionReferences}
                        onContentChange={onContentChange}
                        onStopEditing={() => setIsEditingContent(false)}
                        onRetry={onRetry}
                        onGenerateImage={onGenerateImage}
                        onImageDimensions={onImageDimensions}
                        onToggleBatch={() => onToggleBatch?.(data.id)}
                        onSetBatchPrimary={() => onSetBatchPrimary?.(data)}
                    />
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}
                {resourceLabel ? <ResourceLabelBadge reference={resourceLabel} /> : null}

                {!hasImageContent && !hasVideoContent && !hasAudioContent && data.type !== CanvasNodeType.Config ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} />
                ) : null}

                <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
            </div>

            <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onConnectStart={(event) => onConnectStart(event, data.id, "target")} />
            <ConnectionHandleDot side="right" visible={data.type !== CanvasNodeType.Config && (hovered || isSelected || isConnecting)} onConnectStart={(event) => onConnectStart(event, data.id, "source")} />

            {showPanel && renderPanel ? (
                <div
                    ref={panelRef}
                    data-canvas-no-drag
                    data-canvas-node-panel
                    data-canvas-node-panel-placement={panelPlacement}
                    className={`absolute left-1/2 z-[70] w-[500px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto ${panelPlacement === "top" ? "bottom-full pb-4" : "top-full pt-4"}`}
                    style={{ marginLeft: panelOffsetX, maxHeight: panelMaxHeight ? `${panelMaxHeight}px` : "calc(100dvh - 1rem)", maxWidth: panelMaxWidth }}
                >
                    {renderPanel(data)}
                </div>
            ) : null}
        </div>
    );
});
