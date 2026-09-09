"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

export type DirectorAspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:2";

export const DIRECTOR_ASPECT_RATIOS: Array<{ value: DirectorAspectRatio; label: string; ratio: number }> = [
    { value: "16:9", label: "16:9 横屏", ratio: 16 / 9 },
    { value: "9:16", label: "9:16 竖屏", ratio: 9 / 16 },
    { value: "1:1", label: "1:1 方形", ratio: 1 },
    { value: "4:3", label: "4:3 传统", ratio: 4 / 3 },
    { value: "3:2", label: "3:2 摄影", ratio: 3 / 2 },
];

export type DirectorSticker = {
    id: string;
    src: string;
    label: string;
    /** 0-1 relative to stage width */
    x: number;
    /** 0-1 relative to stage height */
    y: number;
    /** 0-1 relative to stage width */
    width: number;
    flipped: boolean;
    zIndex: number;
};

export type DirectorFrame = {
    /** 0-1 relative center positions */
    x: number;
    y: number;
    /** 0-1 relative to stage width */
    width: number;
    aspect: DirectorAspectRatio;
};

export function aspectRatioOf(value: DirectorAspectRatio) {
    return DIRECTOR_ASPECT_RATIOS.find((item) => item.value === value)?.ratio ?? 16 / 9;
}

/**
 * 从等距柱状全景图按视角计算裁剪矩形（近似中心透视，用于构图参考）。
 * yaw/pitch 单位弧度，fov 为垂直视场角（度）。
 */
export function equirectCropRect(yaw: number, pitch: number, fov: number, aspect: number, imageWidth: number, imageHeight: number) {
    const cropHeight = Math.min(imageHeight, Math.max(64, Math.round((fov / 180) * imageHeight)));
    const cropWidth = Math.min(imageWidth, Math.max(64, Math.round(cropHeight * aspect)));
    const centerX = wrap((yaw / (2 * Math.PI) + 0.5) * imageWidth, imageWidth);
    const centerY = Math.round((0.5 - pitch / Math.PI) * imageHeight);
    const halfWidth = cropWidth / 2;
    const leftRaw = Math.round(centerX - halfWidth);
    const top = clamp(Math.round(centerY - cropHeight / 2), 0, Math.max(0, imageHeight - cropHeight));
    const left = clamp(leftRaw, 0, Math.max(0, imageWidth - cropWidth));
    // 等距柱状图左右环绕：跨越边缘时从另一侧补齐
    if (leftRaw < 0 || leftRaw + cropWidth > imageWidth) {
        return { left, top, width: cropWidth, height: cropHeight, wraps: true };
    }
    return { left, top, width: cropWidth, height: cropHeight, wraps: false };
}

export function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function wrap(value: number, bound: number) {
    return ((value % bound) + bound) % bound;
}

export function readStagePoint(event: ReactPointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
        x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
        y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
    };
}

export function frameToPixelRect(frame: DirectorFrame, stageWidth: number, stageHeight: number) {
    const width = Math.max(32, frame.width * stageWidth);
    const height = Math.max(32, width / aspectRatioOf(frame.aspect));
    return {
        x: clamp(frame.x * stageWidth - width / 2, 0, Math.max(0, stageWidth - width)),
        y: clamp(frame.y * stageHeight - height / 2, 0, Math.max(0, stageHeight - height)),
        width: Math.min(width, stageWidth),
        height: Math.min(height, stageHeight),
    };
}

/** 把舞台内容按机位框渲染为图片数据（保持自然分辨率的等比绘制）。 */
export async function renderDirectorCapture(options: { background: HTMLImageElement; stickers: DirectorSticker[]; stickerImages: Map<string, HTMLImageElement>; frame: DirectorFrame; stageWidth: number; stageHeight: number; maxWidth?: number }) {
    const { background, stickers, stickerImages, frame, stageWidth, stageHeight, maxWidth = 2048 } = options;
    const rect = frameToPixelRect(frame, stageWidth, stageHeight);
    const scale = Math.min(1, maxWidth / Math.max(1, rect.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成构图图片");
    context.imageSmoothingQuality = "high";
    context.drawImage(background, -rect.x * scale, -rect.y * scale, stageWidth * scale, stageHeight * scale);
    const ordered = [...stickers].sort((left, right) => left.zIndex - right.zIndex);
    for (const sticker of ordered) {
        const image = stickerImages.get(sticker.id);
        if (!image) continue;
        const x = sticker.x * stageWidth * scale - rect.x * scale;
        const y = sticker.y * stageHeight * scale - rect.y * scale;
        const width = sticker.width * stageWidth * scale;
        const height = width * (image.naturalHeight / Math.max(1, image.naturalWidth));
        if (sticker.flipped) {
            context.save();
            context.translate(x + width, y);
            context.scale(-1, 1);
            context.drawImage(image, 0, 0, width, height);
            context.restore();
        } else {
            context.drawImage(image, x, y - height / 2, width, height);
        }
    }
    return canvas.toDataURL("image/png");
}
