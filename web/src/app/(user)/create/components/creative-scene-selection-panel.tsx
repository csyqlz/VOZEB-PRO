"use client";

import { Button, Modal } from "antd";
import { useRef, useState, type PointerEvent } from "react";
import { imagePreviewUrl } from "@/lib/media-image-url";
import type { CreativeAgentRun, CreativeSceneSelection } from "@/services/api/creative";
import { sceneSelectionPoint, sceneSelectionRegion, type SceneSelectionPoint } from "./creative-scene-selection";

export function CreativeSceneSelectionPanel({ runId, action, onConfirm }: { runId: string; action: NonNullable<CreativeAgentRun["ecommerceSceneSelection"]>; onConfirm: (runId: string, selection: CreativeSceneSelection) => Promise<void> }) {
    const imageRef = useRef<HTMLImageElement>(null);
    const startRef = useRef<SceneSelectionPoint | undefined>(undefined);
    const confirmingRef = useRef(false);
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [region, setRegion] = useState<CreativeSceneSelection["region"]>();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState("");
    const point = (event: PointerEvent<HTMLDivElement>) => (imageRef.current && loaded ? sceneSelectionPoint({ x: event.clientX, y: event.clientY }, imageRef.current.getBoundingClientRect(), action) : undefined);
    const updateRegion = (event: PointerEvent<HTMLDivElement>) => {
        const end = point(event);
        if (startRef.current && end) setRegion(sceneSelectionRegion(startRef.current, end));
    };
    const show = () => {
        setOpen(true);
        setLoaded(false);
        setError("");
    };
    const close = () => {
        if (confirmingRef.current) return;
        startRef.current = undefined;
        setOpen(false);
    };
    const wholeImage = region?.width === action.width && region.height === action.height;
    const confirm = async () => {
        if (!region || wholeImage || confirmingRef.current) return;
        confirmingRef.current = true;
        setConfirming(true);
        setError("");
        try {
            await onConfirm(runId, { baselineAssetId: action.baselineAssetId, region });
            setOpen(false);
            setRegion(undefined);
        } catch {
            setError("修改位置未能确认，请刷新后重试。");
        } finally {
            confirmingRef.current = false;
            setConfirming(false);
        }
    };
    const overlay = region ? (
        <div
            data-testid="creative-scene-selection-region"
            aria-hidden
            className="pointer-events-none absolute border-2 border-primary bg-primary/15"
            style={{ left: `${(region.x / action.width) * 100}%`, top: `${(region.y / action.height) * 100}%`, width: `${(region.width / action.width) * 100}%`, height: `${(region.height / action.height) * 100}%` }}
        />
    ) : null;
    return (
        <>
            <div data-testid="creative-scene-selection-preview" className="mt-3 w-full min-w-0 space-y-3">
                <button
                    type="button"
                    aria-label="放大图片并选择修改位置"
                    disabled={confirming}
                    onClick={show}
                    className="relative block max-w-full cursor-zoom-in overflow-hidden rounded-md ring-1 ring-border hover:ring-primary focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60"
                    style={{ width: Math.min(action.width, 520) }}
                >
                    <img src={imagePreviewUrl(action.url, 960)} alt="待修改的原图" width={action.width} height={action.height} className="block h-auto w-full" onError={() => setError("原图暂时无法读取，请刷新后重试。")} />
                    {overlay}
                </button>
                <Button disabled={confirming} onClick={show}>
                    选择修改位置
                </Button>
                {!open && error ? (
                    <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                        {error}
                    </p>
                ) : null}
            </div>
            <Modal
                title="选择修改位置"
                open={open}
                footer={null}
                centered
                width="fit-content"
                destroyOnHidden
                style={{ maxWidth: "calc(100vw - 32px)" }}
                mask={{ closable: false }}
                closable={{ "aria-label": "关闭大图", disabled: confirming }}
                keyboard={!confirming}
                onCancel={close}
            >
                <div data-testid="creative-scene-selection" className="space-y-3">
                    <p className="text-sm leading-6">拖选需要修改的位置，包含新增物体及其接触阴影，选区外保持原样。</p>
                    <div
                        className="relative max-w-full cursor-crosshair overflow-hidden rounded-md"
                        style={{ width: `min(${action.width}px, calc(100vw - 80px), calc((100dvh - 240px) * ${action.width / action.height}))`, touchAction: "none" }}
                        onPointerDown={(event) => {
                            if (confirmingRef.current || (event.pointerType === "mouse" && event.button !== 0)) return;
                            const start = point(event);
                            if (!start) return;
                            event.preventDefault();
                            startRef.current = start;
                            setRegion(undefined);
                            event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={(event) => {
                            if (!confirmingRef.current) updateRegion(event);
                        }}
                        onPointerUp={(event) => {
                            if (!confirmingRef.current) updateRegion(event);
                            startRef.current = undefined;
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                        onPointerCancel={() => {
                            startRef.current = undefined;
                            setRegion(undefined);
                        }}
                    >
                        <img
                            ref={imageRef}
                            src={imagePreviewUrl(action.url, 1920)}
                            alt="选择修改位置的原图"
                            width={action.width}
                            height={action.height}
                            className="block h-auto w-full select-none"
                            draggable={false}
                            onLoad={() => setLoaded(true)}
                            onError={() => {
                                setLoaded(false);
                                setError("原图暂时无法读取，请刷新后重试。");
                            }}
                        />
                        {overlay}
                    </div>
                    {wholeImage ? <p className="text-sm text-amber-700 dark:text-amber-300">请只选择需要修改的局部位置。</p> : null}
                    {error ? (
                        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        <Button type="primary" loading={confirming} disabled={!loaded || !region || wholeImage || confirming} onClick={() => void confirm()}>
                            确认修改位置
                        </Button>
                        <Button
                            disabled={confirming}
                            onClick={() => {
                                setRegion(undefined);
                                close();
                            }}
                        >
                            取消选择
                        </Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
