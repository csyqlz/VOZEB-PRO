import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Segmented, Switch } from "antd";
import { CircleDot, Download, Eraser, FolderOpen, Globe2, Grid2x2, Hand, Image as ImageIcon, Info, Moon, MousePointer2, Music2, Palette, Redo2, Settings2, Square, Sun, Trash2, Type, Undo2, Upload, Video, Workflow } from "lucide-react";

import { canvasThemes, type CanvasBackgroundMode, type CanvasColorTheme, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import type { CanvasInteractionMode } from "./canvas-surface";

export function CanvasToolbar({
    selectedCount,
    selectedMediaCount,
    selectedMediaDownloadPending,
    canUndo,
    canRedo,
    agentOpen,
    backgroundMode,
    interactionMode,
    showImageInfo,
    onAddImage,
    onAddPanorama,
    onAddVideo,
    onAddAudio,
    onAddText,
    onAddConfig,
    onUndo,
    onRedo,
    onUpload,
    onDownloadSelectedMedia,
    onDelete,
    onClear,
    onInteractionModeChange,
    onBackgroundModeChange,
    onShowImageInfoChange,
    onOpenAssets,
    onAutoLayout,
}: {
    selectedCount: number;
    selectedMediaCount: number;
    selectedMediaDownloadPending: boolean;
    canUndo: boolean;
    canRedo: boolean;
    agentOpen?: boolean;
    backgroundMode: CanvasBackgroundMode;
    interactionMode: CanvasInteractionMode;
    showImageInfo: boolean;
    onAddImage: () => void;
    onAddPanorama: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddConfig: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDownloadSelectedMedia: () => void;
    onDelete: () => void;
    onClear: () => void;
    onInteractionModeChange: (mode: CanvasInteractionMode) => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onOpenAssets: () => void;
    onAutoLayout: () => void;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const colorTheme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const [tipX, setTipX] = useState(0);
    const [appearanceOpen, setAppearanceOpen] = useState(false);
    const [panelX, setPanelX] = useState(0);
    const dockStyle = { background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 10px 30px rgba(0,0,0,.24)" : "0 10px 28px rgba(15,23,42,.08)" };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };
    const activeStyle = { background: theme.toolbar.activeBg, color: theme.toolbar.activeText };
    const tip = hovered ? toolLabel(hovered) : "";

    useEffect(() => {
        if (!appearanceOpen) return;
        const closeOnOutside = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && (target.closest(".canvas-appearance-panel") || target.closest(".canvas-toolbar-dock"))) return;
            setAppearanceOpen(false);
        };
        window.addEventListener("pointerdown", closeOnOutside);
        return () => window.removeEventListener("pointerdown", closeOnOutside);
    }, [appearanceOpen]);

    return (
        <div data-canvas-toolbar className="canvas-toolbar-dock-wrap pointer-events-none absolute bottom-5 left-0 right-0 z-50 flex justify-center">
            {tip ? <DockTip label={tip} x={tipX} theme={theme} /> : null}
            <div
                ref={wrapRef}
                className={`canvas-toolbar-dock thin-scrollbar pointer-events-auto flex h-[52px] max-w-full items-center gap-1 overflow-x-auto rounded-lg border px-2 backdrop-blur [&>*]:shrink-0 ${agentOpen ? "is-agent-open" : ""}`}
                style={dockStyle}
            >
                <ToolbarButton
                    id={interactionMode === "pan" ? "tool-pan-mode" : "tool-select-mode"}
                    label={interactionMode === "pan" ? "切换到框选模式" : "切换到小手模式"}
                    active
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipX={setTipX}
                    onHover={setHovered}
                    onClick={() => onInteractionModeChange(interactionMode === "pan" ? "select" : "pan")}
                >
                    {interactionMode === "pan" ? <Hand className="size-4.5" /> : <MousePointer2 className="size-4.5" />}
                </ToolbarButton>
                <ToolbarButton id="tool-undo" label="撤销" disabled={!canUndo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onUndo}>
                    <Undo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-redo" label="重做" disabled={!canRedo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onRedo}>
                    <Redo2 className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton id="tool-text" label="文本" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAddText}>
                    <Type className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-image" label="图片" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAddImage}>
                    <ImageIcon className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-panorama" label="全景图" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAddPanorama}>
                    <Globe2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-video" label="视频" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAddVideo}>
                    <Video className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-audio" label="音频" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAddAudio}>
                    <Music2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-config" label="生成配置" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAddConfig}>
                    <Settings2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-upload" label="上传素材" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onUpload}>
                    <Upload className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                <ToolbarButton id="tool-assets" label="资产" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onOpenAssets}>
                    <FolderOpen className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-auto-layout" label="一键整理画布" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onAutoLayout}>
                    <Workflow className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton
                    id="tool-style"
                    label="画布外观"
                    active={appearanceOpen}
                    hovered={hovered}
                    activeStyle={activeStyle}
                    hoverStyle={hoverStyle}
                    wrapRef={wrapRef}
                    onTipX={setTipX}
                    onHover={setHovered}
                    onClick={(event) => {
                        setPanelX(getTipX(wrapRef.current, event.currentTarget));
                        setAppearanceOpen((value) => !value);
                    }}
                >
                    <Palette className="size-4.5" />
                </ToolbarButton>
                {selectedMediaCount > 1 ? (
                    <>
                        <Divider theme={theme} />
                        <Button
                            data-canvas-batch-download
                            data-canvas-batch-download-count={selectedMediaCount}
                            aria-label={`批量下载 ${selectedMediaCount} 个图片或视频`}
                            title={`批量下载 ${selectedMediaCount} 个图片或视频`}
                            className="canvas-toolbar-batch-download !flex !h-8 !min-w-[52px] !items-center !justify-center !gap-1 !rounded-md !px-2 !text-xs !font-medium"
                            style={{ background: theme.node.action, borderColor: theme.node.action, color: theme.node.actionText }}
                            icon={<Download className="size-4" />}
                            loading={selectedMediaDownloadPending}
                            onClick={onDownloadSelectedMedia}
                        >
                            <span aria-hidden="true">{formatBatchDownloadCount(selectedMediaCount)}</span>
                        </Button>
                    </>
                ) : null}
                {selectedCount ? (
                    <>
                        <Divider theme={theme} />
                        <ToolbarButton id="tool-delete" label="删除选中" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onDelete} danger>
                            <Trash2 className="size-4.5" />
                        </ToolbarButton>
                    </>
                ) : null}
                <Divider theme={theme} />
                <ToolbarButton id="tool-clear" label="清空画布" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onTipX={setTipX} onHover={setHovered} onClick={onClear} danger>
                    <Eraser className="size-4.5" />
                </ToolbarButton>
            </div>

            {appearanceOpen ? (
                <div
                    className="canvas-appearance-panel pointer-events-auto absolute bottom-[72px] z-30 w-[248px] -translate-x-1/2 rounded-xl border p-2.5 shadow-xl backdrop-blur"
                    style={{ left: panelX || "50%", background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                >
                    <div className="px-1 pb-2 text-sm font-medium opacity-65">画布外观</div>
                    <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">主题模式</div>
                    <div className="grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: theme.toolbar.itemHover }}>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="light" onThemeChange={setTheme}>
                            <Sun className="size-4" />
                            浅色
                        </CanvasThemeButton>
                        <CanvasThemeButton colorTheme={colorTheme} targetTheme="dark" onThemeChange={setTheme}>
                            <Moon className="size-4" />
                            深色
                        </CanvasThemeButton>
                    </div>
                    <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">网格样式</div>
                    <Segmented
                        className="w-full !p-1 [&_.ant-segmented-group]:!flex [&_.ant-segmented-item]:!min-h-8 [&_.ant-segmented-item]:!flex-1 [&_.ant-segmented-item-label]:!min-h-8 [&_.ant-segmented-item-label]:!leading-8"
                        value={backgroundMode}
                        onChange={(value) => onBackgroundModeChange(value as CanvasBackgroundMode)}
                        options={[
                            {
                                value: "dots",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <CircleDot className="size-4" />点
                                    </span>
                                ),
                            },
                            {
                                value: "lines",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Grid2x2 className="size-4" />线
                                    </span>
                                ),
                            },
                            {
                                value: "blank",
                                label: (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Square className="size-4" />
                                        空白
                                    </span>
                                ),
                            },
                        ]}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
                            <Info className="size-3.5" />
                            图片信息
                        </span>
                        <Switch size="small" checked={showImageInfo} onChange={onShowImageInfoChange} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    wrapRef,
    onTipX,
    onHover,
    onClick,
    disabled = false,
    danger = false,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: CSSProperties;
    hoverStyle: CSSProperties;
    wrapRef: RefObject<HTMLDivElement | null>;
    onTipX: (x: number) => void;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <Button
            type="text"
            aria-label={label}
            className="!h-8 !w-8 !min-w-8 !p-0"
            disabled={disabled}
            style={active ? activeStyle : hovered === id && !disabled ? hoverStyle : { color: danger ? "#f87171" : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }}
            icon={children}
            onMouseEnter={(event) => {
                onHover(id);
                onTipX(getTipX(wrapRef.current, event.currentTarget));
            }}
            onMouseLeave={() => onHover(null)}
            onClick={onClick}
        />
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="canvas-toolbar-divider mx-1 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

function CanvasThemeButton({ colorTheme, targetTheme, onThemeChange, children }: { colorTheme: CanvasColorTheme; targetTheme: CanvasColorTheme; onThemeChange: (theme: CanvasColorTheme) => void; children: ReactNode }) {
    const theme = canvasThemes[colorTheme];
    const active = colorTheme === targetTheme;
    const activeStyle = { background: theme.node.action, color: theme.node.actionText };

    return (
        <AnimatedThemeToggler
            theme={colorTheme}
            targetTheme={targetTheme}
            onThemeChange={onThemeChange}
            className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition"
            style={active ? activeStyle : { color: theme.toolbar.item }}
            aria-label={`切换到${targetTheme === "dark" ? "深色" : "浅色"}主题`}
            title={`切换到${targetTheme === "dark" ? "深色" : "浅色"}主题`}
        >
            {children}
        </AnimatedThemeToggler>
    );
}

function DockTip({ label, x, theme }: { label: string; x: number; theme: CanvasTheme }) {
    return (
        <span className="canvas-toolbar-dock-tip absolute bottom-[calc(100%+8px)] -translate-x-1/2 rounded-md px-2 py-1 text-xs shadow-lg" style={{ left: x, background: theme.node.text, color: theme.node.panel }}>
            {label}
        </span>
    );
}

function toolLabel(id: string) {
    if (id === "tool-pan-mode") return "小手模式 · 拖动画布";
    if (id === "tool-select-mode") return "框选模式 · 拖框选择";
    if (id === "tool-undo") return "撤销";
    if (id === "tool-redo") return "重做";
    if (id === "tool-text") return "文本";
    if (id === "tool-image") return "图片";
    if (id === "tool-panorama") return "全景图";
    if (id === "tool-video") return "视频";
    if (id === "tool-audio") return "音频";
    if (id === "tool-config") return "生成配置";
    if (id === "tool-upload") return "上传素材";
    if (id === "tool-assets") return "资产";
    if (id === "tool-auto-layout") return "一键整理画布";
    if (id === "tool-style") return "画布外观";
    if (id === "tool-delete") return "删除选中";
    if (id === "tool-clear") return "清空画布";
    return "";
}

function formatBatchDownloadCount(count: number) {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${Math.round(count / 1000)}k`;
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
    if (!wrap) return 0;
    const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    return box.left - wrapBox.left + box.width / 2;
}
