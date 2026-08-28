"use client";

import { App, Button, Image, Segmented } from "antd";
import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { imagePreviewUrl } from "@/lib/media-image-url";
import { uploadImage } from "@/services/image-storage";
import { parseServerMediaUrl } from "@/services/server-media-storage";
import { useDramaStore } from "../stores/use-drama-store";
import type { DramaShot } from "../types";

type FrameKind = "start" | "end";

export function DramaShotFrameEditor({ projectId, episodeId, shot }: { projectId: string; episodeId: string; shot: DramaShot }) {
    const { message } = App.useApp();
    const updateShot = useDramaStore((state) => state.updateShot);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadTarget, setUploadTarget] = useState<FrameKind>("start");
    const [uploading, setUploading] = useState<FrameKind | "">("");
    const frameMode = shot.storyboardFrameMode || "single";
    const generationActive = [shot.storyboardStatus, shot.storyboardEndStatus, shot.generationStatus].some((status) => status === "queued" || status === "running");

    const chooseFile = (kind: FrameKind) => {
        setUploadTarget(kind);
        fileInputRef.current?.click();
    };
    const uploadFrame = async (file?: File) => {
        if (!file) return;
        setUploading(uploadTarget);
        try {
            const stored = await uploadImage(file);
            const url = stored.serverUrl || stored.url;
            updateShot(projectId, episodeId, shot.id, {
                ...(uploadTarget === "start"
                    ? {
                          storyboardStatus: "success" as const,
                          storyboardTaskId: undefined,
                          storyboardError: undefined,
                          storyboardImageUrl: url,
                          storyboardImageStorageKey: stored.storageKey || parseServerMediaUrl(url)?.storageKey,
                          storyboardImageWidth: stored.width,
                          storyboardImageHeight: stored.height,
                      }
                    : {
                          storyboardFrameMode: "first_last" as const,
                          storyboardEndStatus: "success" as const,
                          storyboardEndTaskId: undefined,
                          storyboardEndError: undefined,
                          storyboardEndImageUrl: url,
                          storyboardEndImageStorageKey: stored.storageKey || parseServerMediaUrl(url)?.storageKey,
                          storyboardEndImageWidth: stored.width,
                          storyboardEndImageHeight: stored.height,
                      }),
            });
            message.success(`${uploadTarget === "start" ? "起始帧" : "结束帧"}已上传`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "分镜图片上传失败");
        } finally {
            setUploading("");
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };
    const removeFrame = (kind: FrameKind) => {
        updateShot(projectId, episodeId, shot.id, {
            ...(kind === "start"
                ? { storyboardStatus: "idle" as const, storyboardImageUrl: undefined, storyboardImageStorageKey: undefined, storyboardImageWidth: undefined, storyboardImageHeight: undefined }
                : { storyboardEndStatus: "idle" as const, storyboardEndImageUrl: undefined, storyboardEndImageStorageKey: undefined, storyboardEndImageWidth: undefined, storyboardEndImageHeight: undefined }),
        });
    };

    return (
        <div className="mt-3.5 border-t border-border/70 pt-3.5">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-sm font-semibold">分镜帧</div>
                    <p className="min-w-0 truncate text-xs leading-5 text-muted-foreground">生成镜头时自动补齐缺失帧，可上传覆盖</p>
                </div>
                <Segmented
                    className="!w-fit !shrink-0"
                    disabled={generationActive}
                    value={frameMode}
                    options={[
                        { label: "单帧", value: "single" },
                        { label: "首尾帧", value: "first_last" },
                    ]}
                    onChange={(value) => updateShot(projectId, episodeId, shot.id, { storyboardFrameMode: value as "single" | "first_last" })}
                />
            </div>
            <div className="mt-3 grid min-w-0 gap-2.5 sm:grid-cols-2">
                <FrameSlot title="起始帧" url={shot.storyboardImageUrl} loading={uploading === "start"} disabled={generationActive} onUpload={() => chooseFile("start")} onRemove={() => removeFrame("start")} />
                {frameMode === "first_last" ? <FrameSlot title="结束帧" url={shot.storyboardEndImageUrl} loading={uploading === "end"} disabled={generationActive} onUpload={() => chooseFile("end")} onRemove={() => removeFrame("end")} /> : null}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void uploadFrame(event.target.files?.[0])} />
        </div>
    );
}

function FrameSlot({ title, url, loading, disabled, onUpload, onRemove }: { title: string; url?: string; loading: boolean; disabled: boolean; onUpload: () => void; onRemove: () => void }) {
    return (
        <div className="flex min-w-0 items-center gap-2.5 rounded-md border border-border/80 bg-muted/15 p-2">
            <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded border border-border/70 bg-background">
                {url ? (
                    <Image className="!size-full !object-cover" src={imagePreviewUrl(url, 640)} alt={title} preview={{ mask: "查看", src: imagePreviewUrl(url, 1920) }} />
                ) : (
                    <button
                        type="button"
                        disabled={disabled}
                        className="grid size-full place-items-center text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={onUpload}
                        aria-label={`上传${title}`}
                    >
                        <ImagePlus className="size-4.5" />
                    </button>
                )}
            </div>
            <div className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{title}</span>
                <div className="mt-1 flex items-center gap-0.5">
                    <Button type="text" size="small" className="!h-7 !px-1.5" loading={loading} disabled={disabled} icon={<Upload className="size-3.5" />} onClick={onUpload}>
                        {url ? "替换" : "上传"}
                    </Button>
                    {url ? <Button type="text" size="small" danger disabled={disabled} className="!size-7 !min-w-0 !p-0" aria-label={`移除${title}`} icon={<Trash2 className="size-3.5" />} onClick={onRemove} /> : null}
                </div>
            </div>
        </div>
    );
}
