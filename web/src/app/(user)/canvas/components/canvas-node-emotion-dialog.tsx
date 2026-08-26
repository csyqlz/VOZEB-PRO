"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Modal, Slider, type SliderSingleProps } from "antd";
import { Crosshair, ScanFace, Sparkles } from "lucide-react";

import { imagePreviewUrl } from "@/lib/media-image-url";
import { buildCanvasEmotionPrompt, CANVAS_EXPRESSION_INTENSITIES, CANVAS_EXPRESSION_PRESETS, type CanvasExpressionIntensity, type CanvasExpressionPresetId } from "../utils/canvas-emotion-prompt";
import { detectCanvasFaces, normalizeFaceBox, type CanvasFaceBox } from "../utils/canvas-face-detection";

export type CanvasEmotionPayload = { face: CanvasFaceBox; excitement: number; affinity: number; prompt: string };

type EmotionDialogProps = {
    dataUrl: string;
    open: boolean;
    onClose: () => void;
    onConfirm: (payload: CanvasEmotionPayload) => void;
};

const intensityMarks: SliderSingleProps["marks"] = Object.fromEntries(CANVAS_EXPRESSION_INTENSITIES.map((item, index) => [index, item.label]));

function intensityLabel(value?: number) {
    return CANVAS_EXPRESSION_INTENSITIES[value ?? 1]?.label || CANVAS_EXPRESSION_INTENSITIES[1].label;
}

export function CanvasNodeEmotionDialog({ dataUrl, open, onClose, onConfirm }: EmotionDialogProps) {
    const [faces, setFaces] = useState<CanvasFaceBox[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [manualMode, setManualMode] = useState(false);
    const [manualBox, setManualBox] = useState<CanvasFaceBox | null>(null);
    const [detecting, setDetecting] = useState(false);
    const [expressionId, setExpressionId] = useState<CanvasExpressionPresetId>("natural");
    const [intensity, setIntensity] = useState<CanvasExpressionIntensity>("clear");
    const [excitement, setExcitement] = useState(0.55);
    const [affinity, setAffinity] = useState(0.55);
    const [status, setStatus] = useState("正在识别人物…");
    const manualStartRef = useRef<{ x: number; y: number } | null>(null);
    const detectionRequestRef = useRef(0);
    const detectionAbortRef = useRef<AbortController | null>(null);
    const selectedFace = manualMode ? manualBox : faces[selectedIndex];

    const runFaceDetection = useCallback(async () => {
        detectionAbortRef.current?.abort();
        const controller = new AbortController();
        detectionAbortRef.current = controller;
        const requestId = ++detectionRequestRef.current;
        setDetecting(true);
        setStatus("正在自动识别…");
        try {
            const detected = await detectCanvasFaces(dataUrl, controller.signal);
            if (detectionRequestRef.current !== requestId) return;
            setFaces(detected);
            setSelectedIndex(0);
            setManualBox(null);
            setManualMode(!detected.length);
            setStatus(detected.length > 1 ? `已自动识别 ${detected.length} 个人物，可选择目标` : detected.length === 1 ? "已自动识别 1 个人物" : "未自动识别到人脸，请手动框选");
        } catch (error) {
            if (detectionRequestRef.current !== requestId) return;
            if (error instanceof DOMException && error.name === "AbortError") return;
            setFaces([]);
            setManualMode(true);
            setStatus("自动识别不可用，请手动框选");
        } finally {
            if (detectionRequestRef.current === requestId) {
                setDetecting(false);
                if (detectionAbortRef.current === controller) detectionAbortRef.current = null;
            }
        }
    }, [dataUrl]);

    const stopFaceDetection = useCallback(() => {
        detectionRequestRef.current += 1;
        detectionAbortRef.current?.abort();
        detectionAbortRef.current = null;
        setDetecting(false);
    }, []);

    useEffect(() => {
        if (!open) {
            stopFaceDetection();
            return;
        }
        setFaces([]);
        setManualMode(false);
        setManualBox(null);
        manualStartRef.current = null;
        setSelectedIndex(0);
        setExpressionId("natural");
        setIntensity("clear");
        setExcitement(0.55);
        setAffinity(0.55);
        void runFaceDetection();
        return () => {
            stopFaceDetection();
        };
    }, [open, runFaceDetection, stopFaceDetection]);

    const readPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
        };
    };
    const readManualBox = (event: ReactPointerEvent<HTMLDivElement>) => {
        const manualStart = manualStartRef.current;
        if (!manualStart) return null;
        const point = readPoint(event);
        return normalizeFaceBox(
            {
                x: Math.min(manualStart.x, point.x),
                y: Math.min(manualStart.y, point.y),
                width: Math.abs(point.x - manualStart.x),
                height: Math.abs(point.y - manualStart.y),
            },
            1,
            1,
        );
    };
    const startManual = (event: ReactPointerEvent<HTMLDivElement>) => {
        const point = readPoint(event);
        stopFaceDetection();
        event.currentTarget.setPointerCapture(event.pointerId);
        setManualMode(true);
        manualStartRef.current = point;
        setManualBox(null);
        setStatus("松开后确认人物范围");
    };
    const moveManual = (event: ReactPointerEvent<HTMLDivElement>) => {
        const box = readManualBox(event);
        if (box) setManualBox(box);
    };
    const finishManual = (event: ReactPointerEvent<HTMLDivElement>) => {
        const box = readManualBox(event);
        manualStartRef.current = null;
        setManualBox(box);
        setStatus(box ? "已手动框选人物" : "框选范围太小，请重新拖动选择");
    };

    const submit = () => {
        if (!selectedFace) return;
        onConfirm({
            face: selectedFace,
            excitement,
            affinity,
            prompt: buildCanvasEmotionPrompt({ face: selectedFace, expressionId, intensity, excitement, affinity }),
        });
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={920} centered destroyOnHidden styles={{ body: { maxHeight: "calc(100dvh - 96px)", overflowY: "auto" } }}>
            <div className="mb-4 border-b pb-3 pr-9 sm:pr-10" data-face-dialog-header>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" data-face-dialog-heading>
                    <h2 className="!m-0 flex h-[26px] items-center text-xl font-semibold !leading-none" data-face-dialog-title>
                        人脸与表情参考
                    </h2>
                    <div
                        className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.025] px-2.5 text-xs leading-none text-black/55 dark:border-white/10 dark:bg-white/[0.06] dark:text-white/60"
                        data-face-dialog-status
                        role="status"
                    >
                        <span className={`size-1.5 shrink-0 rounded-full bg-sky-500 ${detecting ? "animate-pulse" : ""}`} aria-hidden="true" />
                        <span>{status}</span>
                    </div>
                </div>
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(360px,1fr)_300px]">
                <div className="flex w-full items-center justify-center self-start rounded-xl border bg-black/5 p-3 dark:bg-white/5" data-face-preview-panel>
                    <div
                        className="relative inline-block max-h-[62vh] max-w-full select-none"
                        onPointerDown={startManual}
                        onPointerMove={moveManual}
                        onPointerUp={finishManual}
                        onPointerCancel={() => {
                            manualStartRef.current = null;
                        }}
                    >
                        <img src={imagePreviewUrl(dataUrl, 1600)} alt="待调整表情的图片" className="block max-h-[58vh] max-w-full rounded-lg object-contain" draggable={false} />
                        {!manualMode
                            ? faces.map((face, index) => (
                                  <FaceBox
                                      key={`face-${index}`}
                                      box={face}
                                      selected={selectedIndex === index}
                                      onClick={(event) => {
                                          event.stopPropagation();
                                          setManualBox(null);
                                          setSelectedIndex(index);
                                      }}
                                      label={`人物 ${index + 1}`}
                                  />
                              ))
                            : null}
                        {manualMode && manualBox ? <FaceBox box={manualBox} selected label="手动框选" /> : null}
                        {manualMode && !manualBox ? <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white drop-shadow">拖动框选人物脸部</div> : null}
                    </div>
                </div>
                <div className="flex flex-col gap-4" data-face-control-panel>
                    <div className="space-y-2">
                        <div className="grid w-full grid-cols-2 gap-2" data-face-mode-controls>
                            <Button className="!h-7 !px-3" size="small" type={!manualMode ? "primary" : "default"} icon={<ScanFace className="size-3.5" />} loading={detecting} onClick={() => void runFaceDetection()}>
                                自动识别
                            </Button>
                            <Button
                                className="!h-7 !px-3"
                                size="small"
                                type={manualMode ? "primary" : "default"}
                                icon={<Crosshair className="size-3.5" />}
                                onClick={() => {
                                    stopFaceDetection();
                                    setManualMode(true);
                                    manualStartRef.current = null;
                                    setManualBox(null);
                                    setStatus("请在图片上拖动框选人物脸部");
                                }}
                            >
                                手动框选
                            </Button>
                        </div>
                        {faces.length > 1 ? (
                            <div className="grid w-full grid-cols-2 gap-2" role="group" aria-label="选择识别人物">
                                {faces.map((_, index) => (
                                    <Button
                                        key={index}
                                        size="small"
                                        className={faces.length % 2 === 1 && index === faces.length - 1 ? "col-span-2" : undefined}
                                        type={!manualMode && selectedIndex === index ? "primary" : "default"}
                                        onClick={() => {
                                            stopFaceDetection();
                                            setManualMode(false);
                                            manualStartRef.current = null;
                                            setManualBox(null);
                                            setSelectedIndex(index);
                                        }}
                                    >
                                        人物 {index + 1}
                                    </Button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    <div className="space-y-2">
                        <div className="text-sm font-medium">表情预设</div>
                        <div className="grid grid-cols-4 gap-1.5">
                            {CANVAS_EXPRESSION_PRESETS.map((preset) => {
                                const selected = preset.id === expressionId;
                                return (
                                    <Button
                                        key={preset.id}
                                        size="small"
                                        type={selected ? "primary" : "default"}
                                        title={preset.prompt}
                                        aria-label={preset.label}
                                        aria-pressed={selected}
                                        onClick={() => {
                                            setExpressionId(preset.id);
                                            setExcitement(preset.excitement);
                                            setAffinity(preset.affinity);
                                        }}
                                    >
                                        {preset.label}
                                    </Button>
                                );
                            })}
                        </div>
                        <div className="pt-1" data-emotion-intensity-slider>
                            <div className="mb-1 text-sm font-medium">表情强度</div>
                            <div className="px-4">
                                <Slider
                                    className="!mx-0 mb-6"
                                    min={0}
                                    max={CANVAS_EXPRESSION_INTENSITIES.length - 1}
                                    step={1}
                                    marks={intensityMarks}
                                    dots
                                    value={Math.max(
                                        0,
                                        CANVAS_EXPRESSION_INTENSITIES.findIndex((item) => item.id === intensity),
                                    )}
                                    onChange={(value) => setIntensity(CANVAS_EXPRESSION_INTENSITIES[value]?.id || "clear")}
                                    tooltip={{ formatter: intensityLabel }}
                                    ariaLabelForHandle="表情强度"
                                    ariaValueTextFormatterForHandle={intensityLabel}
                                />
                            </div>
                        </div>
                    </div>
                    <EmotionPad
                        excitement={excitement}
                        affinity={affinity}
                        onChange={(x, y) => {
                            setExcitement(x);
                            setAffinity(y);
                        }}
                    />
                    <div className="mt-auto flex justify-end gap-2">
                        <Button aria-label="取消" onClick={onClose}>
                            取消
                        </Button>
                        <Button type="primary" icon={<Sparkles className="size-4" />} disabled={!selectedFace} onClick={submit}>
                            生成表情参考
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function FaceBox({ box, selected, label, onClick }: { box: CanvasFaceBox; selected?: boolean; label: string; onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
    return (
        <button
            type="button"
            className="absolute rounded border-2 shadow-sm"
            style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.width * 100}%`,
                height: `${box.height * 100}%`,
                borderColor: selected ? "#38bdf8" : "#fbbf24",
                background: selected ? "rgba(14,165,233,.18)" : "rgba(245,158,11,.10)",
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClick}
            aria-label={`选择${label}`}
            aria-pressed={selected}
            data-face-box
        />
    );
}

function EmotionPad({ excitement, affinity, onChange }: { excitement: number; affinity: number; onChange: (x: number, y: number) => void }) {
    const handle = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onChange(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)));
    };
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between text-sm font-medium">
                <span>情绪细调</span>
                <span className="text-xs opacity-60">
                    激动 {Math.round(excitement * 100)} · 亲近 {Math.round(affinity * 100)}
                </span>
            </div>
            <div
                className="relative h-44 touch-none rounded-xl border bg-[radial-gradient(circle_at_center,rgba(56,189,248,.18),transparent_64%),linear-gradient(135deg,rgba(148,163,184,.12),transparent)]"
                onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    handle(event);
                }}
                onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) handle(event);
                }}
                onKeyDown={(event) => {
                    if (event.key === "ArrowLeft") onChange(Math.max(0, excitement - 0.05), affinity);
                    else if (event.key === "ArrowRight") onChange(Math.min(1, excitement + 0.05), affinity);
                    else if (event.key === "ArrowDown") onChange(excitement, Math.max(0, affinity - 0.05));
                    else if (event.key === "ArrowUp") onChange(excitement, Math.min(1, affinity + 0.05));
                    else return;
                    event.preventDefault();
                }}
                role="group"
                tabIndex={0}
                aria-label={`二维表情参考：激动 ${Math.round(excitement * 100)}，亲近 ${Math.round(affinity * 100)}`}
            >
                <span className="absolute left-1/2 top-2 -translate-x-1/2 text-[11px] opacity-60">亲近</span>
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] opacity-60">疏离</span>
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] opacity-60">激动</span>
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] opacity-60">平静</span>
                <span className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500 shadow" style={{ left: `${excitement * 100}%`, top: `${(1 - affinity) * 100}%` }} />
            </div>
        </div>
    );
}
