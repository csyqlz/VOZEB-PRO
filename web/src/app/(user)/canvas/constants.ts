import { CanvasNodeType } from "./types";
import type { CanvasNodeMetadata } from "./types";
import { PANORAMA_NODE_SIZE } from "./utils/canvas-panorama";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

export const CANVAS_CONFIG_NODE_HEIGHT = {
    collapsed: 180,
    expanded: 226,
} as const;

export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { width: 340, height: 240, title: "New Generation" },
    [CanvasNodeType.Panorama]: { ...PANORAMA_NODE_SIZE, title: "全景图" },
    [CanvasNodeType.Text]: { width: 340, height: 240, title: "Note" },
    [CanvasNodeType.Config]: { width: 340, height: CANVAS_CONFIG_NODE_HEIGHT.collapsed, title: "生成配置" },
    [CanvasNodeType.Video]: { width: 420, height: 236, title: "Video" },
    [CanvasNodeType.Audio]: { width: 340, height: 120, title: "Audio" },
    [CanvasNodeType.Brief]: { width: 380, height: 280, title: "创作简报" },
    [CanvasNodeType.Task]: { width: 340, height: 210, title: "Agent 任务" },
    [CanvasNodeType.BrandKit]: { width: 340, height: 240, title: "品牌规范" },
    [CanvasNodeType.Director]: { width: 420, height: 260, title: "3D导演台" },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

const NODE_SPECS = {
    [CanvasNodeType.Image]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Image],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Panorama]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Panorama],
        metadata: { content: "", status: "idle", size: "2048x1024", panoramaProjection: "equirectangular" },
    },
    [CanvasNodeType.Text]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Text],
        metadata: { content: "", status: "idle", fontSize: 14 },
    },
    [CanvasNodeType.Config]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Config],
        metadata: { content: "", status: "idle", generationMode: "image", configDetailsOpen: false },
    },
    [CanvasNodeType.Video]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Video],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Audio]: {
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Audio],
        metadata: { content: "", status: "idle" },
    },
    [CanvasNodeType.Brief]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.Brief], metadata: { status: "idle" } },
    [CanvasNodeType.Task]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.Task], metadata: { status: "idle", agentTaskStatus: "pending", agentTaskAttempts: 0 } },
    [CanvasNodeType.BrandKit]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.BrandKit], metadata: { status: "idle" } },
    [CanvasNodeType.Director]: { ...NODE_DEFAULT_SIZE[CanvasNodeType.Director], metadata: { status: "idle", directorCaptureCount: 0 } },
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

export function getNodeSpec(type: CanvasNodeType) {
    return NODE_SPECS[type];
}
