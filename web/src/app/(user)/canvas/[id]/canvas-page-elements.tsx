"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Globe2, ImageIcon, List, Music2, Settings2, Video } from "lucide-react";
import { nanoid } from "nanoid";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getNodeSpec } from "../constants";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type ConnectionHandle, type Position } from "../types";

export type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

export type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

export type CanvasCreatableNodeType = CanvasNodeType.Image | CanvasNodeType.Panorama | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio;

export type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export const VIDEO_NODE_MAX_WIDTH = 420;
export const VIDEO_NODE_MAX_HEIGHT = 420;
export const CANVAS_DROP_NODE_OFFSET = 48;
export const CONNECTION_HANDLE_HIT_RADIUS = 40;
export const CONNECTION_NODE_HIT_PADDING = 32;
export const NODE_STATUS_IDLE = "idle" as const;
export const NODE_STATUS_LOADING = "loading" as const;
export const NODE_STATUS_SUCCESS = "success" as const;
export const NODE_STATUS_ERROR = "error" as const;
export const NODE_STATUS_NEEDS_REVIEW = "needs_review" as const;
export const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段可直接用于 AI 生图的完整提示词。先在心里按九个维度依次分析图片，再把分析结果浓缩成一段连贯的提示词正文：

一、画幅与景别：横竖画幅、比例、景别（远景/全景/中景/近景/特写）、主体占画面比例与位置。
二、主体与姿态：主体是什么（人物/动物/物品/建筑/场景），人物写清性别年龄感、身高比例、全身姿态与肢体角度、重心与动态方向。
三、面部与妆造（人物图必写）：脸型、眉形、眼型与眼神方向、鼻唇形态、表情情绪；发型结构与发饰、妆容质感、珠宝首饰（材质、层数、位置）。
四、服装与道具：服装层次、颜色、材质、纹样、褶皱与垂坠状态；手持或身旁道具的形态、尺寸、握持方式。
五、材质与色彩：主要材质质感（丝绸/金属/木材/玻璃/皮肤质感等）、整体色板（主色/辅色/点缀色）、饱和度与明度倾向。
六、光线与氛围：光的方向与类型（顺光/侧光/逆光/顶光）、软硬程度、色温；画面情绪（宁静/紧张/梦幻/史诗感）。
七、构图与镜头：构图法则（三分/对称/引导线/框架）、视角（平视/俯拍/仰拍）、透视关系、景深与背景虚化、模拟焦段感。
八、风格与后期：艺术风格（摄影纪实/插画/国漫/赛博朋克/极简等）、渲染质感、调色倾向（胶片感/高对比/低饱和）。
九、关键细节：画面里最独特、最不可省略的细节（文字内容、特殊符号、飘带轨迹、空间遮挡关系等）。

输出要求：
1. 只输出一段连贯的提示词正文，不要输出分析过程和维度标签。
2. 形容词精确、可执行：不写“很美”“大气”，要写“柔光从左上方 45 度切入，皮肤呈暖调奶油质感”这类描述。
3. 保留图片中最有辨识度的独有细节，确保据此生成的图与原图高度相似。`;

export function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${nanoid()}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export function CanvasRefreshShell() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <main className="relative h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.backdrop, color: theme.node.text }}>
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: `radial-gradient(circle, ${theme.canvas.dot} 1px, transparent 1px)`,
                    backgroundSize: "28px 28px",
                }}
            />

            <div className="absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-24 left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-5 left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}

export function NodeCreateMenu({ position, onCreate, onClose }: { position: Position; onCreate: (type: CanvasCreatableNodeType) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-canvas-node-create-menu
            style={{ left: position.x, top: position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    新建节点
                </span>
                <button
                    type="button"
                    className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:opacity-100"
                    onClick={onClose}
                    onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                    onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                    aria-label="关闭"
                >
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title="文本" description="脚本、广告词、品牌文案" onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title="图片" onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Globe2 className="size-5" />} title="全景图" description="生成 2:1 环境全景" onClick={() => onCreate(CanvasNodeType.Panorama)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title="视频" onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-5" />} title="音频" onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title="生成配置" description="模型、尺寸、数量和输入顺序" onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

export function ConnectionCreateMenu({ pending, onCreate, onClose }: { pending: PendingConnectionCreate; onCreate: (type: CanvasCreatableNodeType) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const menuRef = useRef<HTMLDivElement>(null);
    const [placement, setPlacement] = useState({ anchorX: pending.position.x, anchorY: pending.position.y, offsetX: 0, offsetY: 0 });
    const currentPlacement = placement.anchorX === pending.position.x && placement.anchorY === pending.position.y ? placement : { anchorX: pending.position.x, anchorY: pending.position.y, offsetX: 0, offsetY: 0 };
    useLayoutEffect(() => {
        const menu = menuRef.current;
        const surface = menu?.closest<HTMLElement>("[data-canvas-surface]");
        if (!menu || !surface) return;
        const menuRect = menu.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        const inset = 16;
        const shiftX = menuRect.left < surfaceRect.left + inset ? surfaceRect.left + inset - menuRect.left : menuRect.right > surfaceRect.right - inset ? surfaceRect.right - inset - menuRect.right : 0;
        const shiftY = menuRect.top < surfaceRect.top + inset ? surfaceRect.top + inset - menuRect.top : menuRect.bottom > surfaceRect.bottom - inset ? surfaceRect.bottom - inset - menuRect.bottom : 0;
        if (!shiftX && !shiftY) return;
        const scale = menu.offsetWidth ? menuRect.width / menu.offsetWidth : 1;
        setPlacement({
            anchorX: pending.position.x,
            anchorY: pending.position.y,
            offsetX: currentPlacement.offsetX + shiftX / Math.max(scale, 0.01),
            offsetY: currentPlacement.offsetY + shiftY / Math.max(scale, 0.01),
        });
    }, [currentPlacement.offsetX, currentPlacement.offsetY, pending.position.x, pending.position.y]);
    return (
        <div
            ref={menuRef}
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x + currentPlacement.offsetX, top: pending.position.y + currentPlacement.offsetY, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    引用该节点生成
                </span>
                <button
                    type="button"
                    className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:opacity-100"
                    onClick={onClose}
                    onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                    onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                    aria-label="关闭"
                >
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title="文本生成" description="脚本、广告词、品牌文案" onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title="图片生成" onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Globe2 className="size-5" />} title="全景生成" description="生成 2:1 环境全景" onClick={() => onCreate(CanvasNodeType.Panorama)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title="视频生成" onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-5" />} title="音频参考" onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title="配置节点" description="模型、尺寸、数量和输入顺序" onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

export function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}
