"use client";

import { useEffect, useRef, useState } from "react";
import { Dropdown, Modal } from "antd";
import { BookOpen, Bot, LibraryBig, Menu, Redo2, Sparkles, Trash2, Undo2, Upload } from "lucide-react";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasProjectSaveState } from "../stores/use-canvas-store";

export function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    saveState,
    canUndo,
    canRedo,
    onWorkbench,
    onDeleteProject,
    onImportImage,
    onUndo,
    onRedo,
    assetsOpen,
    onToggleAssets,
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    saveState?: CanvasProjectSaveState;
    canUndo: boolean;
    canRedo: boolean;
    onWorkbench: () => void;
    onDeleteProject: () => void;
    onImportImage: () => void;
    onUndo: () => void;
    onRedo: () => void;
    assetsOpen: boolean;
    onToggleAssets: () => void;
    agentOpen: boolean;
    compactAgentStatus?: { connected: boolean; enabled: boolean; activity: string };
    onToggleAgent: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const menuTriggerRef = useRef<HTMLButtonElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    useEffect(() => {
        if (!menuOpen) return;
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (menuTriggerRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest(".ant-dropdown, .ant-dropdown-menu, .ant-dropdown-menu-submenu, .ant-dropdown-menu-submenu-popup")) return;
            setMenuOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [menuOpen]);

    return (
        <>
            <div className="canvas-topbar pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between gap-2 px-3 sm:h-20 sm:px-6" data-save-status={saveState?.status || "saved"}>
                <div className="canvas-topbar-left pointer-events-auto flex min-w-0 items-center gap-2 sm:gap-3">
                    <Dropdown
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        trigger={["click"]}
                        menu={{
                            onClick: () => setMenuOpen(false),
                            items: [
                                { key: "workbench", icon: <Sparkles className="size-4" />, label: "工作台", onClick: onWorkbench },
                                { key: "docs", icon: <BookOpen className="size-4" />, label: "使用帮助", onClick: () => window.location.assign("/help?section=canvas") },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: "导入素材", onClick: onImportImage },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                                { type: "divider" },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: "删除画布", onClick: onDeleteProject },
                            ],
                        }}
                    >
                        <button ref={menuTriggerRef} type="button" className="grid size-9 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                            <Menu className="size-5" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className="canvas-topbar-title flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="w-[min(280px,48vw)] max-w-[280px] bg-transparent p-0 text-left text-base font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="canvas-topbar-title-button max-w-[min(34vw,280px)] truncate border-b border-dashed border-transparent text-left text-sm font-semibold tracking-normal transition hover:border-current sm:text-base"
                                onDoubleClick={onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {title}
                            </button>
                        )}
                    </div>
                    <span className="h-4 w-px shrink-0" style={{ background: theme.toolbar.border }} aria-hidden="true" />
                    <button
                        type="button"
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition hover:opacity-70 focus-visible:outline-none focus-visible:ring-2"
                        style={{ background: assetsOpen ? theme.toolbar.itemHover : "transparent", color: theme.node.text }}
                        onClick={onToggleAssets}
                        aria-label={assetsOpen ? "关闭资产面板" : "打开资产面板"}
                        aria-expanded={assetsOpen}
                    >
                        <LibraryBig className="size-4" aria-hidden="true" />
                        <span className="hidden sm:inline">资产</span>
                    </button>
                </div>

                <div className="canvas-topbar-actions pointer-events-auto flex min-w-0 items-center gap-1.5">
                    {compactAgentStatus ? <CompactAgentStatus status={compactAgentStatus} onClick={onToggleAgent} /> : null}
                    <UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} />
                    {!agentOpen ? (
                        <button
                            type="button"
                            className="canvas-agent-button inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border px-2.5 text-sm font-medium shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 [&_svg]:size-4"
                            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item, boxShadow: colorTheme === "dark" ? "0 10px 30px rgba(0,0,0,.28)" : "0 10px 24px rgba(28,25,23,.08)" }}
                            onClick={onToggleAgent}
                            aria-label="打开智能助手"
                        >
                            <Bot aria-hidden="true" />
                            <span>智能助手</span>
                        </button>
                    ) : null}
                </div>
            </div>
            <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered width={640}>
                <div className="max-h-[min(72vh,620px)] space-y-0.5 overflow-y-auto border-t pt-3 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["拖动画布"]} value="平移视图" theme={theme} />
                    <Shortcut keys={["滚轮"]} value="缩放画布" theme={theme} />
                    <Shortcut keys={["缩放滑杆"]} value="精确调整缩放" theme={theme} />
                    <Shortcut keys={["Ctrl / Cmd", "拖动"]} value="框选多个节点" theme={theme} />
                    <Shortcut keys={["Shift / Ctrl / Cmd", "点击"]} value="追加选择节点" theme={theme} />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value="全选节点" theme={theme} />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value="复制 / 粘贴节点，或粘贴剪切板文本/图片" theme={theme} />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value="撤销" theme={theme} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value="重做" theme={theme} />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value="重做" theme={theme} />
                    <Shortcut keys={["Delete / Backspace"]} value="删除选中" theme={theme} />
                    <Shortcut keys={["Esc"]} value="取消选择并关闭浮层" theme={theme} />
                    <Shortcut keys={["拖入图片/视频/音频"]} value="上传到画布" theme={theme} />
                </div>
            </Modal>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function CompactAgentStatus({ status, onClick }: { status: { connected: boolean; enabled: boolean; activity: string }; onClick: () => void }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const label = status.connected ? "已连接到本地 Codex" : status.enabled ? status.activity || "连接中" : "正在连接本地 Codex";
    const dotColor = status.connected ? "#22c55e" : status.enabled ? "#f59e0b" : theme.node.muted;
    return (
        <button
            type="button"
            className="flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-sm font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
            style={{ background: "transparent", color: theme.node.text }}
            onClick={onClick}
            title="打开本地 Codex 面板"
        >
            <span className="size-2 rounded-full" style={{ background: dotColor }} />
            <span className="max-w-[120px] truncate sm:max-w-[180px]">{label}</span>
        </button>
    );
}

function Shortcut({ keys, value, theme }: { keys: string[]; value: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,190px)] items-start gap-4 rounded-lg px-1.5 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2 py-1 text-center text-xs font-medium leading-4 shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: theme.toolbar.border, background: theme.toolbar.itemHover, color: theme.toolbar.item }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-left text-xs leading-5" style={{ color: theme.node.muted }}>
                {value}
            </span>
        </div>
    );
}
