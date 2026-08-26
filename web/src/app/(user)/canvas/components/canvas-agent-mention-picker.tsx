"use client";

import { ChevronDown, ChevronUp, FileVideo, ImageIcon, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { imagePreviewUrl } from "@/lib/media-image-url";

import type { CanvasAgentMentionAsset, CanvasAgentMentionSegment } from "./canvas-agent-mention";

export function CanvasAgentMentionPicker({ assets, selectedNodeIds, theme, onSelect }: { assets: CanvasAgentMentionAsset[]; selectedNodeIds: string[]; theme: CanvasTheme; onSelect: (asset: CanvasAgentMentionAsset) => void }) {
    const [activeType, setActiveType] = useState<"image" | "video">("image");
    const gridRef = useRef<HTMLDivElement>(null);
    const [scrollEdges, setScrollEdges] = useState({ previous: false, next: false });
    const { images, videos } = useMemo(() => {
        const grouped = { images: [] as CanvasAgentMentionAsset[], videos: [] as CanvasAgentMentionAsset[] };
        for (const asset of assets) (asset.type === "image" ? grouped.images : grouped.videos).push(asset);
        return grouped;
    }, [assets]);
    const visibleType = activeType === "image" && images.length ? "image" : activeType === "video" && videos.length ? "video" : images.length ? "image" : videos.length ? "video" : undefined;
    const visibleAssets = visibleType === "video" ? videos : images;
    const selected = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

    useEffect(() => {
        const grid = gridRef.current;
        if (!grid || !visibleType) return;
        const update = () => {
            const maximum = Math.max(0, grid.scrollHeight - grid.clientHeight);
            const previous = grid.scrollTop > 1;
            const next = grid.scrollTop < maximum - 1;
            setScrollEdges((current) => (current.previous === previous && current.next === next ? current : { previous, next }));
        };
        const frame = window.requestAnimationFrame(update);
        const observer = new ResizeObserver(update);
        observer.observe(grid);
        grid.addEventListener("scroll", update, { passive: true });
        return () => {
            window.cancelAnimationFrame(frame);
            observer.disconnect();
            grid.removeEventListener("scroll", update);
        };
    }, [visibleAssets.length, visibleType]);

    if (!visibleType) {
        return (
            <p className="w-64 px-3 py-5 text-center text-xs" style={{ color: theme.node.muted }}>
                没有匹配的图片或视频
            </p>
        );
    }

    return (
        <div className="flex w-[min(14rem,calc(100vw-2rem))] min-w-0 flex-col overflow-hidden p-1" data-testid="canvas-agent-mention-picker">
            {images.length && videos.length ? (
                <div className="mb-2 grid grid-cols-2 gap-1 rounded-lg border p-1" style={{ borderColor: theme.toolbar.border, background: theme.node.fill }} role="tablist" aria-label="引用素材类型">
                    <MentionTypeTab type="image" count={images.length} active={visibleType === "image"} theme={theme} onClick={() => setActiveType("image")} />
                    <MentionTypeTab type="video" count={videos.length} active={visibleType === "video"} theme={theme} onClick={() => setActiveType("video")} />
                </div>
            ) : null}
            <div className="relative min-h-0 overflow-hidden">
                <div ref={gridRef} className="hide-scrollbar grid max-h-[min(12rem,calc(100dvh-10rem))] grid-cols-4 gap-1 overflow-y-auto overscroll-contain p-0.5" data-testid={`canvas-agent-mention-${visibleType}-grid`}>
                    {visibleAssets.map((asset) => (
                        <button
                            key={asset.id}
                            type="button"
                            data-node-id={asset.id}
                            className="group relative aspect-square min-w-0 overflow-hidden rounded-md border-2 transition focus-visible:outline-none focus-visible:ring-2"
                            style={{
                                borderColor: selected.has(asset.id) ? theme.node.activeStroke : "transparent",
                                background: theme.node.fill,
                                outlineColor: theme.node.activeStroke,
                            }}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onSelect(asset)}
                            aria-label={`引用${asset.title}`}
                            title={asset.title}
                        >
                            <MentionAssetPreview asset={asset} />
                        </button>
                    ))}
                </div>
                {scrollEdges.previous ? <ScrollHint direction="up" theme={theme} /> : null}
                {scrollEdges.next ? <ScrollHint direction="down" theme={theme} /> : null}
            </div>
        </div>
    );
}

export function CanvasAgentMentionPreview({ segments, assetsById, previewRef, theme }: { segments: CanvasAgentMentionSegment[]; assetsById: ReadonlyMap<string, CanvasAgentMentionAsset>; previewRef: RefObject<HTMLDivElement | null>; theme: CanvasTheme }) {
    return (
        <div data-testid="canvas-agent-mention-preview" aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div ref={previewRef} data-canvas-agent-mention-scroll-layer className="whitespace-pre-wrap break-words px-1 py-1 text-sm leading-5 [font-family:inherit]" style={{ color: theme.node.text }}>
                {segments.map((segment, index) => {
                    const asset = segment.nodeId ? assetsById.get(segment.nodeId) : undefined;
                    if (!segment.referenced || !asset) return <span key={`${index}-${segment.text}`}>{segment.text}</span>;
                    return (
                        <span key={`${asset.id}-${index}`} data-testid="canvas-agent-reference-token" data-node-id={asset.id} title={asset.title} className="relative inline-block align-baseline font-normal text-transparent">
                            <span data-mention-token-width className="whitespace-pre">
                                {segment.text}
                            </span>
                            <span className="absolute inset-0 inline-flex min-w-0 items-center gap-0.5 overflow-hidden" style={{ color: theme.node.text }}>
                                {asset.type === "image" ? <img src={imagePreviewUrl(asset.url, 80)} alt="" className="size-3 shrink-0 rounded-sm object-cover" /> : <FileVideo className="size-3 shrink-0" />}
                                <span className="min-w-0 truncate text-xs font-medium">{segment.text.slice(1)}</span>
                            </span>
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

function MentionTypeTab({ type, count, active, theme, onClick }: { type: "image" | "video"; count: number; active: boolean; theme: CanvasTheme; onClick: () => void }) {
    const Icon = type === "image" ? ImageIcon : FileVideo;
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            className="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2"
            style={{ background: active ? theme.node.panel : "transparent", color: active ? theme.node.text : theme.node.muted, outlineColor: theme.node.activeStroke }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
        >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{type === "image" ? "图片" : "视频"}</span>
            <span className="text-[10px] font-normal tabular-nums opacity-55">{count}</span>
        </button>
    );
}

function MentionAssetPreview({ asset }: { asset: CanvasAgentMentionAsset }) {
    if (asset.type === "image") return <img src={imagePreviewUrl(asset.url, 192)} alt="" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" loading="lazy" />;
    return (
        <>
            <video src={asset.url} muted playsInline preload="metadata" aria-hidden="true" className="pointer-events-none size-full object-cover" />
            <span className="pointer-events-none absolute bottom-1 left-1 grid size-5 place-items-center rounded-full bg-black/55 text-white">
                <Play className="ml-0.5 size-2.5 fill-current" />
            </span>
        </>
    );
}

function ScrollHint({ direction, theme }: { direction: "up" | "down"; theme: CanvasTheme }) {
    const Icon = direction === "up" ? ChevronUp : ChevronDown;
    return (
        <span
            className={`pointer-events-none absolute inset-x-0 z-10 flex h-6 justify-center ${direction === "up" ? "top-0 items-start pt-0.5" : "bottom-0 items-end pb-0.5"}`}
            style={{ color: theme.node.muted, background: `linear-gradient(${direction === "up" ? "to bottom" : "to top"}, ${theme.node.panel}, transparent)` }}
            aria-hidden="true"
        >
            <Icon className="size-3.5" />
        </span>
    );
}
