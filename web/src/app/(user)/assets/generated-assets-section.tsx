"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Pagination, Segmented, Spin } from "antd";
import { Download, Image as ImageIcon, Film, Save } from "lucide-react";
import { saveAs } from "file-saver";

import { mediaDownloadFileName } from "@/lib/media-file";
import { imagePreviewUrl, originalMediaDownloadUrl } from "@/lib/media-image-url";
import { createLibraryAsset } from "@/services/api/library-assets";
import { cn } from "@/lib/utils";

type GeneratedAsset = {
    id: string;
    type: "image" | "video" | "audio";
    title: string;
    serverUrl?: string;
    remoteUrl?: string;
    storageKey?: string;
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
    createdAt?: string;
    metadata?: { surface?: string };
};

const PAGE_SIZE = 24;

export function GeneratedAssetsSection({ onSaved }: { onSaved?: () => void }) {
    const { message } = App.useApp();
    const [assets, setAssets] = useState<GeneratedAsset[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
    const [loading, setLoading] = useState(true);
    const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

    const load = useCallback(
        (nextPage: number, type: "all" | "image" | "video") => {
            setLoading(true);
            const params = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) });
            if (type !== "all") params.set("type", type);
            void fetch(`/api/creative/assets?${params}`, { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .then((payload) => {
                    if (payload?.code === 0 && payload.data) {
                        setAssets(payload.data.items || []);
                        setTotal(payload.data.total || 0);
                    } else {
                        setAssets([]);
                        setTotal(0);
                    }
                })
                .catch(() => {
                    setAssets([]);
                    setTotal(0);
                })
                .finally(() => setLoading(false));
        },
        [],
    );

    useEffect(() => {
        load(page, typeFilter);
    }, [load, page, typeFilter]);

    const mediaUrl = (asset: GeneratedAsset) => asset.serverUrl || asset.remoteUrl || "";

    const saveToLibrary = async (asset: GeneratedAsset) => {
        const url = mediaUrl(asset);
        if (!url) return;
        setSavingIds((prev) => new Set(prev).add(asset.id));
        try {
            if (asset.type === "image") {
                await createLibraryAsset({
                    kind: "image",
                    title: asset.title || "生成图片",
                    coverUrl: url,
                    tags: ["生成"],
                    source: "生成记录",
                    data: { dataUrl: url, storageKey: asset.storageKey, remoteUrl: asset.remoteUrl, serverUrl: asset.serverUrl, width: asset.width || 0, height: asset.height || 0, bytes: asset.bytes || 0, mimeType: asset.mimeType || "image/png" },
                });
            } else if (asset.type === "video") {
                await createLibraryAsset({
                    kind: "video",
                    title: asset.title || "生成视频",
                    coverUrl: "",
                    tags: ["生成"],
                    source: "生成记录",
                    data: { url, storageKey: asset.storageKey, remoteUrl: asset.remoteUrl, serverUrl: asset.serverUrl, width: asset.width || 0, height: asset.height || 0, bytes: asset.bytes || 0, mimeType: asset.mimeType || "video/mp4" },
                });
            } else {
                message.warning("音频素材请在创作页保存");
                return;
            }
            message.success("已转存到我的素材");
            onSaved?.();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "转存失败");
        } finally {
            setSavingIds((prev) => {
                const next = new Set(prev);
                next.delete(asset.id);
                return next;
            });
        }
    };

    const download = (asset: GeneratedAsset) => {
        const url = mediaUrl(asset);
        if (!url) return;
        const fileName = mediaDownloadFileName(asset.title || `生成${asset.type === "image" ? "图片" : "视频"}`, asset.mimeType);
        saveAs(originalMediaDownloadUrl(url), fileName);
    };

    return (
        <section aria-label="生成记录">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">生成记录</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{total ? `${total} 个生成结果（含图片/视频），可预览、下载或转存为长期素材` : "完成生成后会自动出现在这里"}</p>
                </div>
                <Segmented
                    size="small"
                    value={typeFilter}
                    onChange={(value) => {
                        setPage(1);
                        setTypeFilter(value as "all" | "image" | "video");
                    }}
                    options={[
                        { value: "all", label: "全部" },
                        { value: "image", label: "图片", icon: <ImageIcon className="size-3" /> },
                        { value: "video", label: "视频", icon: <Film className="size-3" /> },
                    ]}
                />
            </div>

            {loading ? (
                <div className="flex min-h-40 items-center justify-center py-10">
                    <Spin description="正在加载生成记录" />
                </div>
            ) : assets.length ? (
                <>
                    <div className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-[repeat(auto-fill,minmax(200px,240px))]">
                        {assets.map((asset) => {
                            const url = mediaUrl(asset);
                            return (
                                <div key={asset.id} className="group overflow-hidden rounded-lg border border-border bg-card">
                                    <div className="relative aspect-square bg-muted/40">
                                        {asset.type === "image" && url ? (
                                            <img src={imagePreviewUrl(url, 640)} alt={asset.title} className="size-full object-cover" loading="lazy" />
                                        ) : asset.type === "video" && url ? (
                                            <video src={url} className="size-full object-cover" preload="metadata" muted controls={false} onMouseEnter={(event) => void event.currentTarget.play().catch(() => {})} onMouseLeave={(event) => event.currentTarget.pause()} />
                                        ) : (
                                            <div className="grid size-full place-items-center text-xs text-muted-foreground">无法预览</div>
                                        )}
                                    </div>
                                    <div className="space-y-1.5 p-2.5">
                                        <p className="truncate text-xs font-medium" title={asset.title}>
                                            {asset.title || `生成${asset.type === "image" ? "图片" : "视频"}`}
                                        </p>
                                        <div className="flex items-center justify-between gap-1">
                                            <span className="text-[10px] text-muted-foreground">{asset.metadata?.surface === "drama" ? "短剧" : asset.metadata?.surface === "canvas" ? "画布" : "创作"}</span>
                                            <div className="flex items-center gap-0.5">
                                                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" aria-label="下载" title="下载" onClick={() => download(asset)}>
                                                    <Download className="size-3.5" />
                                                </Button>
                                                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" aria-label="转存为素材" title="转存为长期素材" loading={savingIds.has(asset.id)} onClick={() => void saveToLibrary(asset)}>
                                                    {!savingIds.has(asset.id) ? <Save className="size-3.5" /> : null}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    {total > PAGE_SIZE ? (
                        <div className="flex justify-end pt-3">
                            <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} />
                        </div>
                    ) : null}
                </>
            ) : (
                <div className="flex min-h-40 flex-col items-center justify-center gap-2 py-10 text-center">
                    <p className="text-sm text-muted-foreground">还没有生成记录</p>
                    <p className="text-xs text-muted-foreground">在创作页、画布或短剧完成生成后，结果会自动出现在这里</p>
                </div>
            )}
        </section>
    );
}
