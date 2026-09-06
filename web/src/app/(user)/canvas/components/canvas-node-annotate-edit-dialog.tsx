"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal } from "antd";
import { MoveUpRight, RotateCcw, Type, Undo2, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { nanoid } from "nanoid";

import { ANNOTATION_COLORS, DEFAULT_ANNOTATION_COLOR, annotationStrokeScale, composeAnnotatedImage, drawCanvasAnnotation, drawCanvasAnnotations, type CanvasAnnotation, type CanvasAnnotationPoint } from "../utils/canvas-annotation-utils";

export type CanvasImageAnnotateEditPayload = {
    prompt: string;
    imageDataUrl: string;
};

type AnnotateTool = "arrow" | "text";
type DraftArrow = { from: CanvasAnnotationPoint; to: CanvasAnnotationPoint };
type TextDraft = { at: CanvasAnnotationPoint; value: string };

export function CanvasNodeAnnotateEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageAnnotateEditPayload) => void }) {
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const draftArrowRef = useRef<DraftArrow | null>(null);
    const drawingRef = useRef(false);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [annotations, setAnnotations] = useState<CanvasAnnotation[]>([]);
    const [tool, setTool] = useState<AnnotateTool>("arrow");
    const [color, setColor] = useState(DEFAULT_ANNOTATION_COLOR);
    const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
    const [prompt, setPrompt] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setAnnotations([]);
        setTool("arrow");
        setColor(DEFAULT_ANNOTATION_COLOR);
        setTextDraft(null);
        setPrompt("");
        setError("");
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const scale = image ? annotationStrokeScale(image.width, image.height) : 1;

    const renderOverlay = () => {
        const canvas = overlayCanvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        drawCanvasAnnotations(context, annotations, scale);
        if (draftArrowRef.current) {
            drawCanvasAnnotation(context, { kind: "arrow", id: "draft", color, ...draftArrowRef.current }, scale);
        }
    };

    useEffect(() => {
        renderOverlay();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [image, annotations, scale]);

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (tool !== "arrow") return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = true;
        draftArrowRef.current = { from: readCanvasPoint(event.currentTarget, event.clientX, event.clientY), to: readCanvasPoint(event.currentTarget, event.clientX, event.clientY) };
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current || !draftArrowRef.current) return;
        event.preventDefault();
        draftArrowRef.current.to = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        renderOverlay();
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (tool === "text") {
            const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
            if (image) setTextDraft({ at: point, value: "" });
            return;
        }
        if (!drawingRef.current || !draftArrowRef.current) return;
        event.preventDefault();
        const draft = draftArrowRef.current;
        draftArrowRef.current = null;
        drawingRef.current = false;
        const moved = Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) > 6;
        if (moved) {
            setAnnotations((prev) => [...prev, { kind: "arrow", id: nanoid(), from: draft.from, to: draft.to, color }]);
        } else {
            renderOverlay();
        }
    };

    const commitTextDraft = () => {
        if (!textDraft) return;
        const value = textDraft.value.trim();
        if (value) {
            setAnnotations((prev) => [...prev, { kind: "text", id: nanoid(), at: textDraft.at, text: value, color }]);
        }
        setTextDraft(null);
    };

    const undoLast = () => {
        setAnnotations((prev) => prev.slice(0, -1));
        setError("");
    };

    const resetAnnotations = () => {
        setAnnotations([]);
        setTextDraft(null);
        setError("");
    };

    const submit = async () => {
        const nextPrompt = prompt.trim();
        if (!nextPrompt) return setError("请输入修改要求");
        if (!annotations.length) return setError("请先在图片上添加箭头或文字标注");
        setSubmitting(true);
        setError("");
        try {
            const imageDataUrl = await composeAnnotatedImage(dataUrl, annotations);
            onConfirm({ prompt: nextPrompt, imageDataUrl });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "标注合成失败，请重试");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden>
            <div className="grid gap-4 lg:grid-cols-[minmax(360px,1fr)_320px] lg:gap-5">
                <div className="flex min-h-52 items-center justify-center rounded-xl border border-black/10 bg-transparent p-0 sm:min-h-[300px] lg:min-h-[360px] dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={imagePreviewUrl(dataUrl, 1920)} alt="" className="block max-h-[42vh] max-w-full bg-transparent sm:max-h-[60vh] lg:max-h-[68vh]" draggable={false} />
                        {image ? (
                            <canvas
                                ref={overlayCanvasRef}
                                width={image.width}
                                height={image.height}
                                className={`absolute inset-0 h-full w-full touch-none ${tool === "arrow" ? "cursor-crosshair" : "cursor-text"}`}
                                onPointerDown={startDraw}
                                onPointerMove={moveDraw}
                                onPointerUp={stopDraw}
                                onPointerCancel={() => {
                                    drawingRef.current = false;
                                    draftArrowRef.current = null;
                                    renderOverlay();
                                }}
                            />
                        ) : null}
                        {textDraft ? (
                            <div className="absolute z-10" style={{ left: `${(textDraft.at.x / image!.width) * 100}%`, top: `${(textDraft.at.y / image!.height) * 100}%` }}>
                                <Input
                                    autoFocus
                                    size="small"
                                    value={textDraft.value}
                                    placeholder="输入标注文字"
                                    onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
                                    onPressEnter={commitTextDraft}
                                    onBlur={commitTextDraft}
                                    style={{ width: 180, boxShadow: `0 0 0 2px ${color}` }}
                                />
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="flex flex-col gap-4 lg:min-h-[360px] lg:gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">标注改图</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : "读取中"}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={tool === "arrow" ? "primary" : "default"} icon={<MoveUpRight className="size-4" />} onClick={() => setTool("arrow")}>
                            箭头
                        </Button>
                        <Button type={tool === "text" ? "primary" : "default"} icon={<Type className="size-4" />} onClick={() => setTool("text")}>
                            文字
                        </Button>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium opacity-75">颜色</span>
                        {ANNOTATION_COLORS.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                aria-label={item.label}
                                title={item.label}
                                onClick={() => setColor(item.value)}
                                className={`size-6 rounded-full border-2 transition ${color === item.value ? "border-black/70 dark:border-white/80" : "border-transparent"}`}
                                style={{ backgroundColor: item.value }}
                            />
                        ))}
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">修改要求</div>
                        <Input.TextArea
                            autoSize={{ minRows: 3, maxRows: 6 }}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder="例如：按红色箭头把背景换成黄昏海边，其他保持不变"
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <Button icon={<Undo2 className="size-4" />} disabled={!annotations.length} onClick={undoLast}>
                                撤销
                            </Button>
                            <Button icon={<RotateCcw className="size-4" />} disabled={!annotations.length} onClick={resetAnnotations}>
                                清空
                            </Button>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} loading={submitting} onClick={() => void submit()}>
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
