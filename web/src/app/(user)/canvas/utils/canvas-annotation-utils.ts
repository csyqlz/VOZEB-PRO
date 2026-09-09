"use client";

export type CanvasAnnotationPoint = { x: number; y: number };

export type CanvasAnnotation = { kind: "arrow"; id: string; from: CanvasAnnotationPoint; to: CanvasAnnotationPoint; color: string } | { kind: "text"; id: string; at: CanvasAnnotationPoint; text: string; color: string };

export const ANNOTATION_COLORS = [
    { value: "#ff4d4f", label: "红色" },
    { value: "#fadb14", label: "黄色" },
    { value: "#36cfc1", label: "青色" },
];

export const DEFAULT_ANNOTATION_COLOR = ANNOTATION_COLORS[0].value;

/** Annotation strokes keep a similar visual weight on small previews and 4K sources. */
export function annotationStrokeScale(width: number, height: number) {
    return Math.max(1, Math.max(width, height) / 1000);
}

/**
 * Arrow head as a filled triangle anchored at the arrow tip, pointing along
 * from -> to. `headLength` grows with the stroke scale so heads stay visible.
 */
export function arrowHeadPoints(from: CanvasAnnotationPoint, to: CanvasAnnotationPoint, scale: number) {
    const headLength = 22 * scale;
    const spread = 0.42;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    return [-spread, spread].map((offset) => ({
        x: to.x - headLength * Math.cos(angle + offset),
        y: to.y - headLength * Math.sin(angle + offset),
    }));
}

export function drawCanvasAnnotation(context: CanvasRenderingContext2D, annotation: CanvasAnnotation, scale: number) {
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    if (annotation.kind === "arrow") {
        const stroke = 6 * scale;
        context.strokeStyle = annotation.color;
        context.fillStyle = annotation.color;
        context.lineWidth = stroke;
        context.beginPath();
        context.moveTo(annotation.from.x, annotation.from.y);
        context.lineTo(annotation.to.x, annotation.to.y);
        context.stroke();
        const [left, right] = arrowHeadPoints(annotation.from, annotation.to, scale);
        context.beginPath();
        context.moveTo(annotation.to.x, annotation.to.y);
        context.lineTo(left.x, left.y);
        context.lineTo(right.x, right.y);
        context.closePath();
        context.fill();
    } else {
        const fontSize = 26 * scale;
        context.font = `bold ${fontSize}px sans-serif`;
        context.textBaseline = "top";
        context.lineWidth = Math.max(3, fontSize / 6);
        context.strokeStyle = "rgba(0, 0, 0, .62)";
        context.strokeText(annotation.text, annotation.at.x, annotation.at.y);
        context.fillStyle = annotation.color;
        context.fillText(annotation.text, annotation.at.x, annotation.at.y);
    }
    context.restore();
}

export function drawCanvasAnnotations(context: CanvasRenderingContext2D, annotations: CanvasAnnotation[], scale: number) {
    for (const annotation of annotations) drawCanvasAnnotation(context, annotation, scale);
}

/** Renders the source image plus annotations into a PNG data URL for the generation request. */
export async function composeAnnotatedImage(source: string, annotations: CanvasAnnotation[]): Promise<string> {
    if (typeof createImageBitmap !== "function") throw new Error("当前浏览器无法合成标注图片");
    const response = await fetch(source);
    if (!response.ok) throw new Error("无法读取源图片，请重试");
    const bitmap = await createImageBitmap(await response.blob());
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前浏览器无法合成标注图片");
        context.drawImage(bitmap, 0, 0);
        drawCanvasAnnotations(context, annotations, annotationStrokeScale(canvas.width, canvas.height));
        return canvas.toDataURL("image/png");
    } finally {
        bitmap.close();
    }
}
