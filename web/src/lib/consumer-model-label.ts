import { normalizeModelId } from "./model-capability";

/** Keep upstream IDs internal while giving users short, recognizable labels. */
const CONSUMER_MODEL_LABELS: Record<string, string> = {
    "gpt-5.5": "智能文本 · GPT-5.5",
    "gpt-5.6-luna": "智能文本 · GPT-5.6 Luna",
    "gpt-5.6-sol": "智能文本 · GPT-5.6 Sol",
    "gpt-5.6-terra": "智能文本 · GPT-5.6 Terra",
    "gpt-image-2": "高清图片 · GPT Image 2",
    "image-2": "高清图片 · GPT Image 2",
    "gpt-image-2-4k": "超清图片 · GPT Image 2 4K",
    "grok-image-破甲": "Grok 图片 · 破甲",
    "grok-imagine-image": "Grok 图片",
    "grok-imagine-image-2.0": "Grok 图片 2.0",
    "grok-imagine-image-quality": "Grok 图片 · 高质量",
    "nano-banana-pro": "Nano Banana Pro 图片",
    "nano-banana2": "Nano Banana 2 图片",
    "gemini-3.1-flash-image-1k": "Gemini 图片 · 1K",
    "gemini-3.1-flash-image-2k": "Gemini 图片 · 2K",
    "gemini-3.1-flash-image-4k": "Gemini 图片 · 4K",
    "gemini-3.1-flash-image-preview": "Gemini 图片 · 预览版",
    "gemini-3.1-flash-image-preview-2k": "Gemini 图片 · 预览 2K",
    "gemini-3.1-flash-image-preview-4k": "Gemini 图片 · 预览 4K",
    "grok-imagine-video": "Grok 视频",
    "grok-imagine-video-1.5": "Grok 视频 1.5",
    "kling-3.0": "可灵视频 3.0",
    "minimax-h3": "MiniMax 视频 H3",
    "omni-flash": "全能视频",
    "seedance2.0": "Seedance 视频 2.0",
    "seedance2.5": "Seedance 视频 2.5",
    "veo3.1": "Veo 视频 3.1",
    "veo3.1-fast": "Veo 视频 3.1 Fast",
    "veo3.1-lite": "Veo 视频 3.1 Lite",
};

export function consumerModelLabel(model: string) {
    const key = normalizeModelId(model);
    return CONSUMER_MODEL_LABELS[key] || model.trim();
}
