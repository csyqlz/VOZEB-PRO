"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Modal, Select, Slider, Tooltip } from "antd";
import { Camera, FlipHorizontal2, Images, Loader2, LocateFixed, Plus, Trash2 } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { DIRECTOR_ASPECT_RATIOS, aspectRatioOf, clamp, equirectCropRect, frameToPixelRect, readStagePoint, renderDirectorCapture, type DirectorAspectRatio, type DirectorFrame, type DirectorSticker } from "../utils/canvas-director-utils";

const CanvasPanoramaSurface = dynamic(() => import("./canvas-panorama-surface").then((module) => module.CanvasPanoramaSurface), {
    ssr: false,
    loading: () => <div className="grid h-full w-full place-items-center text-xs text-white/75">正在准备全景查看器...</div>,
});

export type DirectorCanvasImage = { id: string; title: string; src: string };

export function CanvasDirectorStudio({ open, onClose, sceneSrc, sceneIsPanorama, canvasImages, onCapture }: { open: boolean; onClose: () => void; sceneSrc: string; sceneIsPanorama: boolean; canvasImages: DirectorCanvasImage[]; onCapture: (dataUrl: string, title: string) => Promise<void> | void }) {
    const { message } = App.useApp();
    const [phase, setPhase] = useState<"aim" | "compose">(sceneIsPanorama ? "aim" : "compose");
    const [aimFov, setAimFov] = useState(70);
    const [aimPosition, setAimPosition] = useState({ yaw: 0, pitch: 0 });
    const [sceneBg, setSceneBg] = useState(sceneIsPanorama ? "" : sceneSrc);
    const [stickers, setStickers] = useState<DirectorSticker[]>([]);
    const [frame, setFrame] = useState<DirectorFrame>({ x: 0.5, y: 0.5, width: 0.55, aspect: "16:9" });
    const [pickerOpen, setPickerOpen] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [aiming, setAiming] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ kind: "sticker" | "frame"; id: string; last: { x: number; y: number } } | null>(null);
    const resizeRef = useRef<{ id: string; startWidth: number; startX: number } | null>(null);
    const zCounter = useRef(1);

    useEffect(() => {
        if (!open) return;
        setPhase(sceneIsPanorama ? "aim" : "compose");
        setSceneBg(sceneIsPanorama ? "" : sceneSrc);
        setStickers([]);
        setFrame({ x: 0.5, y: 0.5, width: 0.55, aspect: "16:9" });
        setPickerOpen(false);
        setCapturing(false);
        zCounter.current = 1;
    }, [open, sceneSrc, sceneIsPanorama]);

    const stickerImages = useMemo(() => {
        const map = new Map<string, HTMLImageElement>();
        stickers.forEach((sticker) => {
            const image = new Image();
            image.crossOrigin = "anonymous";
            image.src = sticker.src;
            map.set(sticker.id, image);
        });
        return map;
    }, [stickers]);

    const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
    useEffect(() => {
        if (!sceneBg) {
            setBackgroundImage(null);
            return;
        }
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => setBackgroundImage(image);
        image.src = sceneBg;
    }, [sceneBg]);

    const freezeAim = async () => {
        if (!sceneSrc) return;
        setAiming(true);
        try {
            const meta = await readImageMeta(sceneSrc);
            const rect = equirectCropRect(aimPosition.yaw, aimPosition.pitch, aimFov, aspectRatioOf(frame.aspect), meta.width, meta.height);
            const source = new Image();
            source.crossOrigin = "anonymous";
            await new Promise<void>((resolve, reject) => {
                source.onload = () => resolve();
                source.onerror = () => reject(new Error("全景图读取失败"));
                source.src = imagePreviewUrl(sceneSrc, 4096);
            });
            const canvas = document.createElement("canvas");
            canvas.width = rect.width;
            canvas.height = rect.height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("当前浏览器无法定格场景");
            context.drawImage(source, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
            setSceneBg(canvas.toDataURL("image/jpeg", 0.92));
            setPhase("compose");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "定格场景失败");
        } finally {
            setAiming(false);
        }
    };

    const addSticker = (item: DirectorCanvasImage) => {
        setStickers((prev) => [
            ...prev,
            { id: `sticker-${item.id}-${Date.now()}`, src: item.src, label: item.title || "角色", x: 0.5, y: 0.62, width: 0.22, flipped: false, zIndex: ++zCounter.current },
        ]);
        setPickerOpen(false);
    };

    const uploadSticker = async (file?: File) => {
        if (!file) return;
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ""));
                reader.onerror = () => reject(new Error("读取图片失败"));
                reader.readAsDataURL(file);
            });
            setStickers((prev) => [...prev, { id: `sticker-upload-${Date.now()}`, src: dataUrl, label: file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "角色", x: 0.5, y: 0.62, width: 0.22, flipped: false, zIndex: ++zCounter.current }]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "上传角色失败");
        }
    };

    const startDrag = (event: ReactPointerEvent<HTMLElement>, kind: "sticker" | "frame", id: string) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { kind, id, last: readStagePoint(event) };
    };

    const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        const point = readStagePoint(event);
        const dx = point.x - drag.last.x;
        const dy = point.y - drag.last.y;
        dragRef.current = { ...drag, last: point };
        if (drag.kind === "frame") {
            setFrame((prev) => ({ ...prev, x: clamp(prev.x + dx, 0, 1), y: clamp(prev.y + dy, 0, 1) }));
        } else {
            setStickers((prev) => prev.map((sticker) => (sticker.id === drag.id ? { ...sticker, x: clamp(sticker.x + dx, 0, 1), y: clamp(sticker.y + dy, 0.05, 1) } : sticker)));
        }
    };

    const endDrag = () => {
        dragRef.current = null;
        resizeRef.current = null;
    };

    const startStickerResize = (event: ReactPointerEvent<HTMLElement>, id: string) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const sticker = stickers.find((item) => item.id === id);
        resizeRef.current = { id, startWidth: sticker?.width ?? 0.22, startX: event.clientX };
    };

    const moveStickerResize = (event: ReactPointerEvent<HTMLElement>) => {
        const resize = resizeRef.current;
        const stage = stageRef.current;
        if (!resize || !stage) return;
        const delta = (event.clientX - resize.startX) / Math.max(1, stage.getBoundingClientRect().width);
        setStickers((prev) => prev.map((sticker) => (sticker.id === resize.id ? { ...sticker, width: clamp(resize.startWidth + delta * 2, 0.05, 1.2) } : sticker)));
    };

    const capture = async () => {
        const stage = stageRef.current;
        if (!stage || !backgroundImage) return;
        setCapturing(true);
        try {
            const rect = stage.getBoundingClientRect();
            const dataUrl = await renderDirectorCapture({ background: backgroundImage, stickers, stickerImages, frame, stageWidth: backgroundImage.naturalWidth, stageHeight: (backgroundImage.naturalWidth * rect.height) / Math.max(1, rect.width) });
            await onCapture(dataUrl, "导演台构图");
            message.success("已生成构图参考图节点");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成构图图片失败");
        } finally {
            setCapturing(false);
        }
    };

    const frameAspect = aspectRatioOf(frame.aspect);
    const stageHeightRatio = phase === "compose" ? 9 / 16 : 0.5;

    return (
        <Modal title="导演台" open={open} width="min(1180px, calc(100vw - 24px))" centered destroyOnHidden footer={null} onCancel={onClose} styles={{ body: { padding: 0 } }}>
            <div className="flex flex-col gap-3 p-4">
                {phase === "aim" ? (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm text-muted-foreground">第一步 · 转动全景寻找机位视角，然后定格为导演台场景。</div>
                            <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">视场 {aimFov}°</span>
                                <Slider className="!w-36" min={35} max={100} step={1} value={aimFov} onChange={setAimFov} tooltip={{ formatter: (value) => `${value}°` }} />
                            </div>
                        </div>
                        <div className="relative h-[62vh] min-h-[320px] overflow-hidden rounded-xl bg-black" onPointerMove={(event) => setAimPosition((prev) => prev)}>
                            <CanvasPanoramaSurface src={imagePreviewUrl(sceneSrc, 4096)} alt="导演台全景场景" />
                        </div>
                        <div className="flex items-center justify-end gap-2">
                            <Button onClick={onClose}>取消</Button>
                            <Button type="primary" icon={<LocateFixed className="size-4" />} loading={aiming} onClick={() => void freezeAim()}>
                                定格此视角进入摆位
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm text-muted-foreground">第二步 · 摆放角色站位，移动机位框取景，生成构图参考图。</div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Select size="small" className="!w-32" value={frame.aspect} onChange={(value) => setFrame((prev) => ({ ...prev, aspect: value as DirectorAspectRatio }))} options={DIRECTOR_ASPECT_RATIOS.map((item) => ({ value: item.value, label: item.label }))} />
                                <Tooltip title="从画布图片选择角色">
                                    <Button size="small" icon={<Images className="size-3.5" />} onClick={() => setPickerOpen((prev) => !prev)}>
                                        角色
                                    </Button>
                                </Tooltip>
                                <label>
                                    <input type="file" accept="image/*" className="hidden" onChange={(event) => void uploadSticker(event.target.files?.[0])} />
                                    <span className="ant-btn ant-btn-sm inline-flex items-center gap-1" role="button">
                                        <Plus className="size-3.5" /> 上传
                                    </span>
                                </label>
                                <Button size="small" type="primary" icon={capturing ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />} disabled={!sceneBg || capturing} onClick={() => void capture()}>
                                    生成构图参考图
                                </Button>
                            </div>
                        </div>
                        {pickerOpen ? (
                            <div className="grid max-h-32 grid-cols-3 gap-1.5 overflow-y-auto rounded-lg border border-border bg-muted/30 p-1.5 sm:grid-cols-5">
                                {canvasImages.length ? (
                                    canvasImages.map((item) => (
                                        <button key={item.id} type="button" className="truncate rounded-md border border-border bg-background px-2 py-1.5 text-left text-xs transition hover:border-violet-400" title={item.title} onClick={() => addSticker(item)}>
                                            <span className="block truncate">{item.title || "未命名"}</span>
                                        </button>
                                    ))
                                ) : (
                                    <div className="col-span-full py-3 text-center text-xs text-muted-foreground">画布上暂无其他图片节点，可直接上传角色立牌</div>
                                )}
                            </div>
                        ) : null}
                        <div
                            ref={stageRef}
                            className="relative w-full select-none overflow-hidden rounded-xl bg-black"
                            style={{ aspectRatio: `${frameAspect * 1.6}` }}
                            data-canvas-no-zoom
                            onPointerMove={(event) => {
                                if (dragRef.current) moveDrag(event);
                                if (resizeRef.current) moveStickerResize(event);
                            }}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                        >
                            {sceneBg ? <img src={sceneBg} alt="导演台场景" draggable={false} className="absolute inset-0 h-full w-full object-cover" /> : <div className="absolute inset-0 grid place-items-center text-xs text-white/70">正在准备场景…</div>}
                            {stickers.map((sticker) => (
                                <div key={sticker.id} className="absolute" style={{ left: `${sticker.x * 100}%`, top: `${sticker.y * 100}%`, width: `${sticker.width * 100}%`, zIndex: sticker.zIndex }} onPointerDown={(event) => startDrag(event, "sticker", sticker.id)}>
                                    <div className="relative -translate-y-1/2 cursor-move">
                                        <img src={sticker.src} alt={sticker.label} draggable={false} className="pointer-events-none w-full" style={{ transform: sticker.flipped ? "scaleX(-1)" : undefined }} />
                                        <div className="absolute -top-6 left-0 flex items-center gap-1 opacity-0 transition group-hover:opacity-100" style={{ opacity: 1 }}>
                                            <button type="button" className="grid size-5 place-items-center rounded bg-black/60 !text-white hover:bg-black/80" title="水平翻转" onClick={() => setStickers((prev) => prev.map((item) => (item.id === sticker.id ? { ...item, flipped: !item.flipped } : item)))}>
                                                <FlipHorizontal2 className="size-3" />
                                            </button>
                                            <button type="button" className="grid size-5 place-items-center rounded bg-black/60 !text-white hover:bg-black/80" title="移除" onClick={() => setStickers((prev) => prev.filter((item) => item.id !== sticker.id))}>
                                                <Trash2 className="size-3" />
                                            </button>
                                        </div>
                                        <span className="absolute -right-1 -bottom-1 size-3 cursor-nesw-resize rounded-sm border border-white/80 bg-violet-500/80" onPointerDown={(event) => startStickerResize(event, sticker.id)} />
                                    </div>
                                </div>
                            ))}
                            <DirectorFrameOverlay frame={frame} onPointerDown={(event) => startDrag(event, "frame", "frame")} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">拖动机位框取景；角色立牌可拖动移动、角点缩放、翻转或删除。</span>
                            {sceneIsPanorama ? (
                                <Button size="small" onClick={() => setPhase("aim")}>
                                    返回全景取景
                                </Button>
                            ) : null}
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

function DirectorFrameOverlay({ frame, onPointerDown }: { frame: DirectorFrame; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void }) {
    const stage = useRef<HTMLDivElement>(null);
    const [rect, setRect] = useState<{ left: string; top: string; width: string; height: string } | null>(null);
    useEffect(() => {
        const element = stage.current?.parentElement;
        if (!element) return;
        const sync = () => {
            const width = frame.width;
            const height = width / aspectRatioOf(frame.aspect) / (element.clientWidth / Math.max(1, element.clientHeight));
            setRect({
                left: `${clamp(frame.x - width / 2, 0, 1 - width) * 100}%`,
                top: `${clamp(frame.y - height / 2, 0, 1 - height) * 100}%`,
                width: `${width * 100}%`,
                height: `${height * 100}%`,
            });
        };
        sync();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
        observer?.observe(element);
        return () => observer?.disconnect();
    }, [frame]);
    return (
        <div ref={stage} className="absolute z-50 cursor-move" style={rect || undefined} onPointerDown={onPointerDown}>
            <div className="pointer-events-none absolute inset-0 border-2 border-violet-400/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.18)]">
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
                    {Array.from({ length: 9 }).map((_, index) => (
                        <div key={index} className="border border-violet-300/25" />
                    ))}
                </div>
                <span className="absolute -top-6 left-0 rounded bg-violet-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white">机位 {frame.aspect}</span>
            </div>
            <span className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nesw-resize rounded-full border-2 border-white bg-violet-500" />
        </div>
    );
}
