"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { BriefcaseBusiness, ChevronRight, CircleCheck, CircleX, Clock3, Globe2, Image as ImageIcon, ListChecks, Music2, Palette, RefreshCw, Star, Video } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasPanoramaViewer } from "./canvas-panorama-viewer";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

export type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type NodeContentRendererProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    onContentChange: (nodeId: string, content: string) => void;
    onStopEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
    onImageDimensions?: (nodeId: string, naturalWidth: number, naturalHeight: number) => void;
};

export function NodeContent(props: NodeContentRendererProps) {
    if ((props.node.type === CanvasNodeType.Config || props.node.type === CanvasNodeType.Director) && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading") return <LoadingContent theme={props.theme} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;
    if (props.node.metadata?.status === "needs_review") return <ReviewContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;
    if (props.node.metadata?.status === "cancelled") return <CancelledContent theme={props.theme} />;

    const Renderer = nodeContentRenderers[props.node.type];
    return Renderer ? <Renderer {...props} /> : <UnknownNodeContent theme={props.theme} />;
}

export const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Panorama]: PanoramaNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Brief]: BriefNodeContent,
    [CanvasNodeType.Task]: TaskNodeContent,
    [CanvasNodeType.BrandKit]: BrandKitNodeContent,
    [CanvasNodeType.Director]: DirectorNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function DirectorNodeContent({ theme }: NodeContentRendererProps) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.text }}>
            3D导演台
        </div>
    );
}

export function BriefNodeContent({ node, theme }: NodeContentRendererProps) {
    const brief = node.metadata?.agentBrief;
    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-5" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2 text-xs font-semibold">
                <BriefcaseBusiness className="size-4" style={{ color: theme.node.activeStroke }} />
                创作目标
            </div>
            <p className="text-sm leading-6">{brief?.objective || "等待 Agent 整理创作目标"}</p>
            {brief?.audience ? (
                <div className="text-xs" style={{ color: theme.node.placeholder }}>
                    受众：{brief.audience}
                </div>
            ) : null}
            {brief?.usage ? (
                <div className="text-xs" style={{ color: theme.node.placeholder }}>
                    场景：{brief.usage}
                </div>
            ) : null}
            {brief?.coreMessage ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    核心信息：{brief.coreMessage}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
                {brief?.deliverables?.map((item, index) => (
                    <span key={`${item.title}-${index}`} className="rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: theme.node.subtleBorder, background: theme.node.subtleSurface, color: theme.node.subtleText }}>
                        {item.title}
                        {item.count && item.count > 1 ? ` ×${item.count}` : ""}
                    </span>
                ))}
            </div>
        </div>
    );
}

export function TaskNodeContent({ node, theme }: NodeContentRendererProps) {
    const status = node.metadata?.agentTaskStatus || "pending";
    const statusTheme = taskStatusTheme(status, theme);
    return (
        <div className="flex h-full min-h-0 flex-col p-5" style={{ color: theme.node.text }}>
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="mb-4 flex items-center justify-between">
                    <ListChecks className="size-5" style={{ color: theme.node.activeStroke }} />
                    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium" style={{ background: statusTheme.surface, borderColor: statusTheme.border, color: statusTheme.text }}>
                        <span className="size-1.5 rounded-full" style={{ background: statusTheme.text }} aria-hidden="true" />
                        {TASK_STATUS_LABELS[status]}
                    </span>
                </div>
                <p className="thin-scrollbar min-h-0 flex-1 overflow-y-auto pr-1 text-sm leading-6" onWheel={(event) => event.stopPropagation()}>
                    {node.metadata?.prompt || node.metadata?.content || node.title}
                </p>
            </div>
            <div className="mt-3 flex shrink-0 items-center justify-between text-xs" style={{ color: theme.node.placeholder }}>
                <span>{node.metadata?.agentTaskType || "任务"}</span>
                <span className="flex items-center gap-1">
                    <CircleCheck className="size-3.5" />
                    尝试 {node.metadata?.agentTaskAttempts || 0}/2
                </span>
            </div>
        </div>
    );
}

export function BrandKitNodeContent({ node, theme }: NodeContentRendererProps) {
    const kit = node.metadata?.brandKit;
    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-5" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2 text-xs font-semibold">
                <Palette className="size-4" style={{ color: theme.node.activeStroke }} />
                灵感与视觉方向
            </div>
            <p className="text-sm leading-6">{kit?.summary || "等待补充品牌与视觉方向"}</p>
            {kit?.composition ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    构图：{kit.composition}
                </p>
            ) : null}
            {kit?.lighting ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    光线：{kit.lighting}
                </p>
            ) : null}
            <div className="flex gap-2">
                {kit?.colors?.map((color) => (
                    <span key={color} className="size-7 rounded-full border" style={{ background: color, borderColor: theme.node.stroke }} title={color} />
                ))}
            </div>
            <div className="flex flex-wrap gap-2">
                {(kit?.keywords || kit?.visualKeywords)?.map((word) => (
                    <span key={word} className="rounded-md border px-2 py-1 text-xs" style={{ background: theme.node.subtleSurface, borderColor: theme.node.subtleBorder, color: theme.node.subtleText }}>
                        {word}
                    </span>
                ))}
            </div>
            {kit?.avoid?.length ? (
                <p className="text-xs leading-5" style={{ color: theme.node.placeholder }}>
                    避免：{kit.avoid.join("；")}
                </p>
            ) : null}
        </div>
    );
}

export function LoadingContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <span className="text-[10px] tracking-[0.2em]">生成中</span>
        </div>
    );
}

export function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden px-5 py-4 text-center">
            <div className="max-h-[60%] max-w-[260px] overflow-y-auto text-xs leading-5" style={{ color: theme.node.danger }}>
                {node.metadata?.errorDetails || "生成失败"}
            </div>
            <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: theme.node.dangerSurface, borderColor: theme.node.dangerBorder, color: theme.node.danger }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                重试
            </button>
        </div>
    );
}

export function ReviewContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden px-5 py-4 text-center">
            <Clock3 className="size-6 shrink-0" style={{ color: theme.node.warningText }} />
            <div className="max-h-[55%] max-w-[280px] overflow-y-auto text-xs leading-5" style={{ color: theme.node.text }}>
                {node.metadata?.errorDetails || "任务创建结果待管理员确认，系统未重复提交。"}
            </div>
            <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition hover:brightness-95"
                style={{ background: theme.node.warningSurface, borderColor: theme.node.warningBorder, color: theme.node.warningText }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                检查状态
            </button>
        </div>
    );
}

export function CancelledContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 py-4 text-center" style={{ color: theme.node.placeholder }}>
            <CircleX className="size-6" />
            <span className="text-xs">任务已取消</span>
        </div>
    );
}

export function UnknownNodeContent({ theme }: Pick<NodeContentRendererProps, "theme">) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>
            未知节点
        </div>
    );
}

export function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStopEditing, onGenerateImage }: NodeContentRendererProps) {
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.65)}px`, color: theme.node.text, boxSizing: "border-box" } as React.CSSProperties;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden pt-8">
            <button
                type="button"
                className="absolute right-3 top-3 z-20 inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onGenerateImage?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title="用文本生图"
                aria-label="用文本生图"
            >
                <ImageIcon className="size-3.5" />
                生图
            </button>
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent pl-4 pr-14 pt-0 pb-4 m-0 font-mono outline-none select-text appearance-none"
                    style={textStyle}
                    value={node.metadata?.content || ""}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : (
                <div className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent pl-4 pr-14 pt-0 pb-4 font-mono" style={textStyle} onWheel={(event) => event.stopPropagation()}>
                    {node.metadata?.content || <span style={{ color: theme.node.placeholder }}>点击编辑文字</span>}
                </div>
            )}
        </div>
    );
}

export function ResourceLabelBadge({ reference }: { reference: CanvasResourceReference }) {
    return (
        <span className={`pointer-events-none absolute right-2 top-0 z-[80] -translate-y-[calc(100%+6px)] rounded-md px-1.5 py-0.5 text-[10px] font-medium ${reference.active ? "bg-[#2f80ff] text-white shadow-sm" : "bg-black/35 text-white/75"}`}>
            {reference.label}
        </span>
    );
}

export function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && props.isBatchRoot) {
        const content =
            props.node.metadata?.status === "loading" ? (
                <LoadingContent theme={props.theme} />
            ) : props.node.metadata?.status === "error" ? (
                <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />
            ) : props.node.metadata?.status === "cancelled" ? (
                <CancelledContent theme={props.theme} />
            ) : (
                <EmptyImageContent {...props} isBatchRoot={false} />
            );
        return (
            <BatchFrame batchCount={props.batchCount} batchExpanded={props.batchExpanded} batchOpening={props.batchOpening} batchRecovering={props.batchRecovering} onToggleBatch={props.onToggleBatch}>
                {content}
            </BatchFrame>
        );
    }
    if (!props.node.metadata?.content) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            isBatchRoot={props.isBatchRoot}
            batchCount={props.batchCount}
            batchExpanded={props.batchExpanded}
            batchOpening={props.batchOpening}
            batchRecovering={props.batchRecovering}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onImageDimensions={props.onImageDimensions}
        />
    );
}

export function EmptyImageContent({ theme, isBatchRoot, batchCount, batchExpanded, batchOpening, batchRecovering, onToggleBatch }: NodeContentRendererProps) {
    const content = (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl border" style={{ background: theme.node.subtleSurface, borderColor: theme.node.subtleBorder, color: theme.node.subtleText }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">空图片节点</span>
        </div>
    );
    if (isBatchRoot)
        return (
            <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
                {content}
            </BatchFrame>
        );
    return content;
}

export function VideoNodeContent({ node, theme }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">空视频节点</span>
            </div>
        );
    return <video src={node.metadata.content} controls className="h-full w-full rounded-[18px] bg-black object-contain" data-canvas-no-zoom />;
}

export function PanoramaNodeContent({ node, theme }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Globe2 className="size-7 opacity-35" />
                <span className="text-sm">空全景节点</span>
                <span className="text-[10px] opacity-55">360° · 2:1</span>
            </div>
        );
    return <CanvasPanoramaViewer src={node.metadata.content} alt={node.title || "全景图"} />;
}

export function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">空音频节点</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{node.title || "音频"}</span>
            </div>
            <audio src={node.metadata.content} controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

export function ImageContent({
    node,
    isBatchRoot,
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    onSetBatchPrimary,
    onImageDimensions,
}: {
    node: CanvasNodeData;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: () => void;
    onImageDimensions?: (nodeId: string, naturalWidth: number, naturalHeight: number) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchChild = Boolean(node.metadata?.batchRootId);
    const imageRef = useRef<HTMLImageElement>(null);
    const reportDimensions = useCallback(
        (image: HTMLImageElement) => {
            if (image.naturalWidth > 0 && image.naturalHeight > 0) onImageDimensions?.(node.id, image.naturalWidth, image.naturalHeight);
        },
        [node.id, onImageDimensions],
    );

    useEffect(() => {
        const image = imageRef.current;
        if (image?.complete) reportDimensions(image);
    }, [node.metadata?.content, reportDimensions]);

    return (
        <BatchFrame batchCount={isBatchRoot ? batchCount : 0} batchExpanded={batchExpanded} batchOpening={batchOpening} batchRecovering={batchRecovering} onToggleBatch={onToggleBatch}>
            <div className="h-full w-full overflow-hidden rounded-3xl">
                <img
                    ref={imageRef}
                    src={imagePreviewUrl(node.metadata!.content!, 1920)}
                    alt={node.title}
                    draggable={false}
                    onLoad={(event) => reportDimensions(event.currentTarget)}
                    onDragStart={(event) => event.preventDefault()}
                    className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-contain"}`}
                />
            </div>
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1 rounded-full border px-2.5 text-xs font-semibold shadow-[0_6px_18px_rgba(15,23,42,.10)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    aria-label={batchExpanded ? "图片组已展开" : "图片组已收起"}
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none opacity-85">{batchCount}</span>
                    <ChevronRight className={`size-3.5 transition-transform ${batchExpanded ? "rotate-90" : ""}`} style={{ color: theme.node.muted }} />
                </button>
            ) : null}
            {isBatchChild ? (
                <button
                    type="button"
                    className="absolute right-3 top-3 z-30 flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium opacity-0 shadow-[0_8px_20px_rgba(68,64,60,.13)] backdrop-blur-md transition group-hover/batch:opacity-100 hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onSetBatchPrimary?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <Star className="size-3.5 text-[#2f80ff]" />
                    设为主图
                </button>
            ) : null}
        </BatchFrame>
    );
}

export function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const width = Math.round(node.metadata?.naturalWidth || node.width);
    const height = Math.round(node.metadata?.naturalHeight || node.height);
    const size = formatBytes(node.metadata?.bytes || 0);
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {width} x {height}
                {size ? ` · ${size}` : ""}
            </span>
        </div>
    );
}

export function BatchFrame({
    batchCount,
    batchExpanded,
    batchOpening,
    batchRecovering,
    onToggleBatch,
    children,
}: {
    batchCount: number;
    batchExpanded: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    onToggleBatch?: () => void;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div
            className="group/batch relative h-full w-full overflow-visible"
            onDoubleClick={
                isBatchRoot
                    ? (event) => {
                          event.stopPropagation();
                          onToggleBatch?.();
                      }
                    : undefined
            }
        >
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 5) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_14px_34px_rgba(68,64,60,.16)] transition-all duration-300 group-hover/batch:translate-x-2"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded && !batchOpening ? 0.34 : 1,
                                transform:
                                    batchOpening || batchRecovering ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)` : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
export function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div data-canvas-resize-corner={corner} className={`absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

export function ConnectionHandleDot({ side, visible, onConnectStart }: { side: "left" | "right"; visible: boolean; onConnectStart: (event: React.MouseEvent | React.PointerEvent) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            data-canvas-handle={side === "left" ? "target" : "source"}
            aria-label={side === "left" ? "输入连接点" : "输出连接点"}
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onConnectStart}
            onPointerDown={(event) => {
                if (event.pointerType !== "mouse") onConnectStart(event);
            }}
            style={{ touchAction: "none" }}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}

const TASK_STATUS_LABELS = {
    ready: "等待执行",
    pending: "等待执行",
    running: "执行中",
    paused: "已暂停",
    waiting_user: "等待确认",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
} as const;

function taskStatusTheme(status: keyof typeof TASK_STATUS_LABELS, theme: NodeContentRendererProps["theme"]) {
    if (status === "running") return { surface: theme.node.infoSurface, border: theme.node.infoBorder, text: theme.node.infoText };
    if (status === "completed") return { surface: theme.node.successSurface, border: theme.node.successBorder, text: theme.node.successText };
    if (status === "paused" || status === "waiting_user") return { surface: theme.node.warningSurface, border: theme.node.warningBorder, text: theme.node.warningText };
    if (status === "failed") return { surface: theme.node.dangerSurface, border: theme.node.dangerBorder, text: theme.node.danger };
    return { surface: theme.node.subtleSurface, border: theme.node.subtleBorder, text: theme.node.subtleText };
}
