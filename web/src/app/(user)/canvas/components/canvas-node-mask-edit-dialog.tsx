"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Slider } from "antd";
import { Brush, Eraser, Lasso, RectangleHorizontal, RotateCcw, Sparkles, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { segmentCanvasSubject, type CanvasSubjectMask } from "../utils/canvas-subject-segmentation";

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
};

type DrawMode = "paint" | "erase" | "rect" | "lasso";
type MaskPoint = { x: number; y: number };
type PendingMaskShape = { kind: "rect"; start: MaskPoint; current: MaskPoint } | { kind: "lasso"; points: MaskPoint[] };

const defaultBrushSize = 100;
const maskFillColor = "rgba(37, 99, 235, .38)";
const maskBorderColor = "rgba(255, 255, 255, .72)";

export function CanvasNodeMaskEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageMaskEditPayload) => void }) {
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawingRef = useRef<{ active: boolean; last: MaskPoint | null; shape: PendingMaskShape | null }>({ active: false, last: null, shape: null });
    const subjectAbortRef = useRef<AbortController | null>(null);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode>("paint");
    const [subjectBusy, setSubjectBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setError("");
        void readImageMeta(dataUrl).then(setImage);
        return () => {
            subjectAbortRef.current?.abort();
            subjectAbortRef.current = null;
        };
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        scratchCanvasRef.current = null;
        drawingRef.current = { active: false, last: null, shape: null };
    }, [image]);

    const ensureScratchCanvas = (width: number, height: number) => {
        if (!scratchCanvasRef.current) scratchCanvasRef.current = document.createElement("canvas");
        const scratch = scratchCanvasRef.current;
        if (scratch.width !== width || scratch.height !== height) {
            scratch.width = width;
            scratch.height = height;
        }
        return scratch;
    };

    const drawBrush = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const maskCanvas = maskCanvasRef.current;
        const context = maskCanvas?.getContext("2d");
        if (!maskCanvas || !context) return;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = brushSize;
        context.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
        context.strokeStyle = "#000";
        context.fillStyle = "#000";
        if (!drawingRef.current.last) {
            drawMaskStroke(context, point, point, brushSize);
        } else {
            drawMaskStroke(context, drawingRef.current.last, point, brushSize);
        }
        renderMaskPreview(maskCanvas, previewCanvasRef.current);
        drawingRef.current.last = point;
        if (mode !== "erase") {
            setError("");
        }
    };

    const updateShape = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const shape = drawingRef.current.shape;
        if (!shape) return;
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        if (shape.kind === "rect") {
            shape.current = point;
        } else {
            shape.points.push(point);
        }
        renderShapePreview();
    };

    const renderShapePreview = () => {
        const maskCanvas = maskCanvasRef.current;
        const shape = drawingRef.current.shape;
        if (!maskCanvas || !shape) return;
        const scratch = ensureScratchCanvas(maskCanvas.width, maskCanvas.height);
        const context = scratch.getContext("2d");
        if (!context) return;
        context.globalCompositeOperation = "source-over";
        context.clearRect(0, 0, scratch.width, scratch.height);
        context.drawImage(maskCanvas, 0, 0);
        context.fillStyle = "#000";
        context.strokeStyle = "#000";
        fillMaskShape(context, shape);
        renderMaskPreview(scratch, previewCanvasRef.current);
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, last: null, shape: null };
        if (mode === "rect" || mode === "lasso") {
            const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
            drawingRef.current.shape = mode === "rect" ? { kind: "rect", start: point, current: point } : { kind: "lasso", points: [point] };
            renderShapePreview();
            return;
        }
        if (maskCanvasRef.current) renderMaskPreview(maskCanvasRef.current, previewCanvasRef.current);
        drawBrush(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        event.preventDefault();
        if (drawingRef.current.shape) {
            updateShape(event);
            return;
        }
        drawBrush(event);
    };

    const stopDraw = () => {
        const maskCanvas = maskCanvasRef.current;
        const shape = drawingRef.current.shape;
        if (maskCanvas && shape) {
            const context = maskCanvas.getContext("2d");
            if (context) {
                context.globalCompositeOperation = "source-over";
                context.fillStyle = "#000";
                context.strokeStyle = "#000";
                fillMaskShape(context, shape);
            }
        }
        drawingRef.current = { active: false, last: null, shape: null };
        scratchCanvasRef.current = null;
        if (maskCanvas) renderMaskPreview(maskCanvas, previewCanvasRef.current, canvasHasPaint(maskCanvas));
        if (mode !== "erase") {
            setError("");
        }
    };

    const resetMask = () => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        setError("");
    };

    const pickSubject = async () => {
        const maskCanvas = maskCanvasRef.current;
        if (!maskCanvas || subjectBusy) return;
        setSubjectBusy(true);
        setError("");
        const controller = new AbortController();
        subjectAbortRef.current = controller;
        try {
            const subject = await segmentCanvasSubject(dataUrl, controller.signal);
            paintSubjectMask(maskCanvas, subject);
            renderMaskPreview(maskCanvas, previewCanvasRef.current, canvasHasPaint(maskCanvas));
        } catch (caught) {
            if (!(caught instanceof DOMException && caught.name === "AbortError")) {
                setError(caught instanceof Error ? caught.message : "主体识别失败，请重试");
            }
        } finally {
            setSubjectBusy(false);
            subjectAbortRef.current = null;
        }
    };

    const submit = () => {
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas) return;
        if (!canvasHasPaint(canvas)) return setError("请先涂抹或圈选局部区域");
        onConfirm({ prompt: nextPrompt, maskDataUrl: buildEditMask(canvas) });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden>
            <div className="grid gap-4 lg:grid-cols-[minmax(360px,1fr)_320px] lg:gap-5">
                <div className="flex min-h-52 items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 sm:min-h-[300px] lg:min-h-[360px] dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={imagePreviewUrl(dataUrl, 1920)} alt="" className="block max-h-[42vh] max-w-full bg-transparent sm:max-h-[60vh] lg:max-h-[68vh]" draggable={false} />
                        {image ? (
                            <>
                                <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                <canvas
                                    ref={previewCanvasRef}
                                    width={image.width}
                                    height={image.height}
                                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                    onPointerDown={startDraw}
                                    onPointerMove={moveDraw}
                                    onPointerUp={stopDraw}
                                    onPointerCancel={stopDraw}
                                />
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex flex-col gap-4 lg:min-h-[360px] lg:gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">局部遮罩编辑</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : "读取中"}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "paint" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setMode("paint")}>
                            画笔
                        </Button>
                        <Button type={mode === "erase" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setMode("erase")}>
                            擦除
                        </Button>
                        <Button type={mode === "rect" ? "primary" : "default"} icon={<RectangleHorizontal className="size-4" />} onClick={() => setMode("rect")}>
                            框选
                        </Button>
                        <Button type={mode === "lasso" ? "primary" : "default"} icon={<Lasso className="size-4" />} onClick={() => setMode("lasso")}>
                            套索
                        </Button>
                    </div>

                    <Button icon={<Sparkles className="size-4" />} loading={subjectBusy} onClick={() => void pickSubject()}>
                        一键选中主体
                    </Button>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">笔刷大小</span>
                            <span className="font-semibold">{brushSize}px</span>
                        </div>
                        <Slider min={8} max={160} step={2} value={brushSize} disabled={mode === "rect" || mode === "lasso"} onChange={setBrushSize} />
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">修改要求</div>
                        <Input.TextArea
                            autoSize={{ minRows: 3, maxRows: 6 }}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder="例如：把选中区域改成金属材质，保持原图光影"
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetMask}>
                            重置
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} onClick={submit}>
                                AI 修改
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function fillMaskShape(context: CanvasRenderingContext2D, shape: PendingMaskShape) {
    context.beginPath();
    if (shape.kind === "rect") {
        const left = Math.min(shape.start.x, shape.current.x);
        const top = Math.min(shape.start.y, shape.current.y);
        context.rect(left, top, Math.abs(shape.current.x - shape.start.x), Math.abs(shape.current.y - shape.start.y));
    } else {
        const points = shape.points;
        if (points.length < 2) {
            context.arc(points[0].x, points[0].y, Math.max(2, 4), 0, Math.PI * 2);
        } else {
            context.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) context.lineTo(point.x, point.y);
            context.closePath();
        }
    }
    context.fill();
}

function paintSubjectMask(target: HTMLCanvasElement, subject: CanvasSubjectMask) {
    clearCanvas(target);
    if (subject.width === target.width && subject.height === target.height) {
        const context = target.getContext("2d");
        if (!context) return;
        context.putImageData(subjectMaskImageData(subject), 0, 0);
        return;
    }
    const source = document.createElement("canvas");
    source.width = subject.width;
    source.height = subject.height;
    source.getContext("2d")?.putImageData(subjectMaskImageData(subject), 0, 0);
    const context = target.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, target.width, target.height);
}

function subjectMaskImageData(subject: CanvasSubjectMask) {
    const image = new ImageData(subject.width, subject.height);
    for (let index = 0; index < subject.data.length; index += 1) {
        if (subject.data[index] >= 0.5) {
            image.data[index * 4 + 3] = 255;
        }
    }
    return image;
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

function renderMaskPreview(maskCanvas: HTMLCanvasElement, previewCanvas: HTMLCanvasElement | null, withBorder = false) {
    const context = previewCanvas?.getContext("2d");
    if (!previewCanvas || !context) return;
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.fillStyle = maskFillColor;
    context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    if (withBorder) drawDashedMaskBorder(context, maskCanvas);
}

function drawDashedMaskBorder(context: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) {
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) return;
    const { width, height } = maskCanvas;
    const data = maskContext.getImageData(0, 0, width, height).data;
    const step = Math.max(1, Math.round(Math.max(width, height) / 1200));
    const dash = step * 8;
    const gap = step * 5;
    const period = dash + gap;

    context.save();
    context.fillStyle = maskBorderColor;
    context.shadowColor = "rgba(0, 0, 0, .24)";
    context.shadowBlur = step * 1.5;
    for (let y = step; y < height - step; y += step) {
        for (let x = step; x < width - step; x += step) {
            const offset = (y * width + x) * 4 + 3;
            if (data[offset] === 0 || !isMaskEdge(data, width, x, y, step)) continue;
            if ((x + y) % period > dash) continue;
            context.fillRect(x - step / 2, y - step / 2, Math.max(1.5, step), Math.max(1.5, step));
        }
    }
    context.restore();
}

function isMaskEdge(data: Uint8ClampedArray, width: number, x: number, y: number, step: number) {
    return data[((y - step) * width + x) * 4 + 3] === 0 || data[((y + step) * width + x) * 4 + 3] === 0 || data[(y * width + x - step) * 4 + 3] === 0 || data[(y * width + x + step) * 4 + 3] === 0;
}

function buildEditMask(selectionCanvas: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return selectionCanvas.toDataURL("image/png");
    const selectionContext = selectionCanvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!selectionContext) return canvas.toDataURL("image/png");
    const selection = selectionContext.getImageData(0, 0, canvas.width, canvas.height);
    const mask = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < mask.data.length; index += 4) {
        if (selection.data[index] > 0) mask.data[index] = 0;
    }
    context.putImageData(mask, 0, 0);
    return canvas.toDataURL("image/png");
}
