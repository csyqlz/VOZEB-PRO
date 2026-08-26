import { faceBoxPrompt, type CanvasFaceBox } from "./canvas-face-detection";

type CanvasExpressionPreset = { id: string; label: string; prompt: string; excitement: number; affinity: number };

export const CANVAS_EXPRESSION_PRESETS = [
    { id: "natural", label: "自然", prompt: "自然放松", excitement: 0.5, affinity: 0.55 },
    { id: "smile", label: "微笑", prompt: "柔和微笑", excitement: 0.55, affinity: 0.72 },
    { id: "happy", label: "开心", prompt: "开心愉悦", excitement: 0.72, affinity: 0.82 },
    { id: "laugh", label: "大笑", prompt: "开怀大笑", excitement: 0.92, affinity: 0.86 },
    { id: "angry", label: "愤怒", prompt: "愤怒生气", excitement: 0.88, affinity: 0.18 },
    { id: "sad", label: "悲伤", prompt: "悲伤低落", excitement: 0.25, affinity: 0.35 },
    { id: "crying", label: "哭泣", prompt: "含泪哭泣", excitement: 0.48, affinity: 0.3 },
    { id: "surprised", label: "惊讶", prompt: "惊讶意外", excitement: 0.9, affinity: 0.55 },
    { id: "afraid", label: "害怕", prompt: "紧张害怕", excitement: 0.82, affinity: 0.22 },
    { id: "disgusted", label: "厌恶", prompt: "厌恶排斥", excitement: 0.68, affinity: 0.14 },
    { id: "contempt", label: "轻蔑", prompt: "轻蔑不屑", excitement: 0.55, affinity: 0.12 },
    { id: "confused", label: "困惑", prompt: "疑惑不解", excitement: 0.52, affinity: 0.42 },
    { id: "indifferent", label: "冷漠", prompt: "冷漠克制", excitement: 0.22, affinity: 0.2 },
    { id: "shy", label: "害羞", prompt: "含蓄害羞", excitement: 0.38, affinity: 0.78 },
    { id: "determined", label: "坚定", prompt: "坚定自信", excitement: 0.66, affinity: 0.48 },
    { id: "tired", label: "疲惫", prompt: "疲惫倦怠", excitement: 0.12, affinity: 0.34 },
] as const satisfies readonly CanvasExpressionPreset[];

export type CanvasExpressionPresetId = (typeof CANVAS_EXPRESSION_PRESETS)[number]["id"];
export type CanvasExpressionIntensity = "subtle" | "clear" | "strong";

export const CANVAS_EXPRESSION_INTENSITIES: ReadonlyArray<{ id: CanvasExpressionIntensity; label: string; prompt: string }> = [
    { id: "subtle", label: "轻微", prompt: "轻微地" },
    { id: "clear", label: "明显", prompt: "清晰地" },
    { id: "strong", label: "强烈", prompt: "强烈地" },
];

export function buildCanvasEmotionPrompt(input: { face: CanvasFaceBox; expressionId: CanvasExpressionPresetId; intensity: CanvasExpressionIntensity; excitement: number; affinity: number }) {
    const expression = CANVAS_EXPRESSION_PRESETS.find((item) => item.id === input.expressionId) || CANVAS_EXPRESSION_PRESETS[0];
    const intensity = CANVAS_EXPRESSION_INTENSITIES.find((item) => item.id === input.intensity) || CANVAS_EXPRESSION_INTENSITIES[1];
    const excitement = input.excitement > 0.66 ? "更激动" : input.excitement < 0.34 ? "更平静" : "保持自然";
    const affinity = input.affinity > 0.66 ? "更亲近" : input.affinity < 0.34 ? "更疏离" : "保持自然";
    return `${faceBoxPrompt(input.face)}，${intensity.prompt}呈现“${expression.label}”表情（${expression.prompt}），整体情绪${excitement}、${affinity}，保留身份、发型、构图和光线。`;
}
