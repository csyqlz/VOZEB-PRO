"use client";

import { FileAudio, FileDown, FileUp, Film, Plus, Search, Upload } from "lucide-react";
import { useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { App, Button, Form, Input, Modal, Pagination, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { saveAs } from "file-saver";
import { useRouter } from "next/navigation";

import { useCopyText } from "@/hooks/use-copy-text";
import { CompactEmptyState } from "@/components/compact-empty-state";
import { droppedFiles, leftDropTarget, preventFileDragEvent } from "@/lib/file-drop";
import { formatBytes } from "@/lib/image-utils";
import { mediaDownloadFileName } from "@/lib/media-file";
import { imagePreviewUrl, originalImageDownloadUrl, originalImageExtension, originalMediaDownloadUrl } from "@/lib/media-image-url";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { isPermanentServerMedia, serverMediaUrl } from "@/services/server-media-storage";
import { listAllLibraryAssets } from "@/services/api/library-assets";
import { cn } from "@/lib/utils";
import { useAssetStore, type Asset, type AssetKind, type AudioAsset, type ImageAsset, type VideoAsset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type MediaDraft = ImageAsset["data"] | VideoAsset["data"] | AudioAsset["data"] | null;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

import { AssetCard, AssetPreviewModal } from "./asset-elements";
import { useAssetPage } from "./use-asset-page";

export default function AssetsPage() {
    const { message } = App.useApp();
    const router = useRouter();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const userId = useUserStore((state) => state.user?.id || "");
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [isCoverDragActive, setIsCoverDragActive] = useState(false);
    const [isImageDragActive, setIsImageDragActive] = useState(false);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [mediaDraft, setMediaDraft] = useState<MediaDraft>(null);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [importing, setImporting] = useState(false);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const { assets, total, loading, error, reload } = useAssetPage({ userId, page, pageSize, kind: kindFilter, keyword });
    const ready = Boolean(userId);

    const openCreate = () => {
        setEditingAsset(null);
        setMediaDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: "手动添加", note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setMediaDraft(asset.kind === "text" ? null : asset.data);
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        setSaving(true);
        try {
            const values = await form.validateFields();
            let nextCover = values.coverUrl?.trim() || (values.kind === "image" && mediaDraft && "dataUrl" in mediaDraft ? mediaDraft.dataUrl : "");
            if (nextCover && !isPermanentServerMedia(undefined, nextCover)) nextCover = (await uploadImage(nextCover)).url;
            else nextCover = serverMediaUrl(undefined, nextCover);
            const base = {
                title: values.title.trim(),
                coverUrl: nextCover,
                tags: values.tags || [],
                source: values.source?.trim(),
                note: values.note?.trim(),
                metadata: editingAsset?.metadata || { source: "manual" },
            };

            if (values.kind === "text") {
                const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
                await (editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset));
            } else {
                if (!mediaDraft) throw new Error(`请选择${values.kind === "image" ? "图片" : values.kind === "video" ? "视频" : "音频"}文件`);
                const asset = { ...base, kind: values.kind, data: mediaDraft } as Parameters<typeof addAsset>[0];
                await (editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset));
            }

            message.success(editingAsset ? "素材已更新" : "素材已保存");
            setIsAssetOpen(false);
            reload();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材保存失败");
        } finally {
            setSaving(false);
        }
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const image = await uploadImage(file);
        form.setFieldValue("coverUrl", image.url);
    };

    const readMediaFile = async (file?: File) => {
        if (!file || formKind === "text" || !file.type.startsWith(`${formKind}/`)) return message.warning(`请选择${formKind === "image" ? "图片" : formKind === "video" ? "视频" : "音频"}格式文件`);
        const media = formKind === "image" ? await uploadImage(file) : await uploadMediaFile(file, formKind);
        const draft: MediaDraft =
            formKind === "image"
                ? { dataUrl: media.url, storageKey: media.storageKey, serverUrl: media.url, width: media.width || 0, height: media.height || 0, bytes: media.bytes, mimeType: media.mimeType }
                : formKind === "video"
                  ? { url: media.url, storageKey: media.storageKey, serverUrl: media.url, width: media.width || 0, height: media.height || 0, bytes: media.bytes, mimeType: media.mimeType }
                  : { url: media.url, storageKey: media.storageKey, serverUrl: media.url, durationMs: "durationMs" in media ? media.durationMs : undefined, bytes: media.bytes, mimeType: media.mimeType };
        setMediaDraft(draft);
        if (formKind === "image" && !form.getFieldValue("coverUrl") && "dataUrl" in draft) form.setFieldValue("coverUrl", draft.dataUrl);
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const handleCoverDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!preventFileDragEvent(event)) return;
        setIsCoverDragActive(true);
    };

    const handleCoverDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!preventFileDragEvent(event) || !leftDropTarget(event)) return;
        setIsCoverDragActive(false);
    };

    const handleCoverDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!preventFileDragEvent(event)) return;
        setIsCoverDragActive(false);
        const [file] = droppedFiles(event, (item) => item.type.startsWith("image/"));
        if (file) void readCoverFile(file);
    };

    const handleImageDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!preventFileDragEvent(event)) return;
        setIsImageDragActive(true);
    };

    const handleImageDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!preventFileDragEvent(event) || !leftDropTarget(event)) return;
        setIsImageDragActive(false);
    };

    const handleImageDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!preventFileDragEvent(event)) return;
        setIsImageDragActive(false);
        const [file] = droppedFiles(event, (item) => formKind !== "text" && item.type.startsWith(`${formKind}/`));
        if (file) void readMediaFile(file);
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, "文本已复制");
    };

    const downloadImage = (asset: Asset) => {
        if (asset.kind === "text") return;
        const url = asset.kind === "image" ? originalImageDownloadUrl(asset.data.dataUrl) : originalMediaDownloadUrl(asset.data.url);
        const mediaUrl = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
        const media = asset.data;
        saveAs(url, mediaDownloadFileName(asset.id, media.mimeType, media.storageKey || media.serverUrl || mediaUrl));
    };

    const exportAllAssets = async () => {
        try {
            const exportable = await listAllLibraryAssets();
            if (!exportable.length) {
                message.warning("暂无素材可导出");
                return;
            }
            await exportAssets(exportable);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材导出失败");
        }
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        setImporting(true);
        try {
            const importedAssets = await readAssetPackage(file);
            await Promise.all(
                importedAssets.map((asset) => {
                    const payload = { ...asset } as Record<string, unknown>;
                    delete payload.id;
                    delete payload.createdAt;
                    delete payload.updatedAt;
                    return addAsset(payload as Parameters<typeof addAsset>[0]);
                }),
            );
            message.success(`已导入 ${importedAssets.length} 个素材`);
            reload();
        } catch {
            message.error("导入失败，请选择有效的素材压缩包");
        } finally {
            setImporting(false);
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset) return;
        setDeleting(true);
        try {
            await removeAsset(deletingAsset.id);
            message.success("素材已删除");
            setDeletingAsset(null);
            if (assets.length === 1 && page > 1) setPage((value) => Math.max(1, value - 1));
            else reload();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材删除失败");
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="h-full min-h-0 overflow-hidden bg-background text-foreground">
            <main className="h-full min-h-0 overflow-y-auto px-3 py-3 sm:px-6 sm:py-6">
                <div className="mx-auto max-w-[1560px]">
                    <header className="border-b border-border pb-3 sm:pb-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h1 className="text-lg font-semibold sm:text-xl">我的素材</h1>
                                <p className="mt-0.5 text-xs text-muted-foreground">{total ? `${total} 项素材` : "集中管理创作中复用的内容"}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Tooltip title="导出素材">
                                    <Button type="text" shape="circle" icon={<FileDown className="size-4" />} aria-label="导出素材" onClick={() => void exportAllAssets()} />
                                </Tooltip>
                                <Tooltip title={importing ? "正在导入" : "导入素材"}>
                                    <Button type="text" shape="circle" icon={<FileUp className="size-4" />} aria-label="导入素材" disabled={!ready || importing} loading={importing} onClick={() => assetInputRef.current?.click()} />
                                </Tooltip>
                                <Tooltip title="新增素材">
                                    <Button type="primary" shape="circle" icon={<Plus className="size-4" />} aria-label="新增素材" disabled={!ready} onClick={openCreate} />
                                </Tooltip>
                            </div>
                        </div>

                        <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(260px,520px)_auto] lg:items-center lg:justify-between">
                            <Input.Search
                                className="w-full"
                                size="middle"
                                allowClear
                                prefix={<Search className="size-4 text-stone-400" />}
                                value={keyword}
                                placeholder="搜索标题、内容、标签或来源"
                                onChange={(event) => {
                                    setPage(1);
                                    setKeyword(event.target.value);
                                }}
                                onSearch={(value) => {
                                    setPage(1);
                                    setKeyword(value);
                                }}
                            />
                            <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                <Segmented
                                    block
                                    value={kindFilter}
                                    options={kindOptions}
                                    onChange={(value) => {
                                        setPage(1);
                                        setKindFilter(value as AssetKind | "all");
                                    }}
                                />
                            </div>
                        </div>
                    </header>

                    <div className="flex flex-col gap-3 pt-3 sm:gap-5 sm:pt-5">
                        <div className={cn("grid grid-cols-1 gap-3 transition-opacity sm:grid-cols-[repeat(auto-fill,minmax(240px,280px))] sm:justify-start", loading && assets.length && "opacity-60")} aria-busy={loading}>
                            {assets.map((asset) => (
                                <AssetCard
                                    key={asset.id}
                                    asset={asset}
                                    onOpen={() => setPreviewAsset(asset)}
                                    onEdit={() => openEdit(asset)}
                                    onCopy={copyAssetText}
                                    onDownload={downloadImage}
                                    onDelete={() => setDeletingAsset(asset)}
                                    onPublish={asset.kind === "text" ? undefined : () => router.push(`/works?sourceType=media&sourceId=${encodeURIComponent(asset.id)}`)}
                                />
                            ))}
                        </div>

                        {loading && !assets.length ? (
                            <section className="flex min-h-32 items-center justify-center sm:min-h-56">
                                <Spin description="正在加载素材" />
                            </section>
                        ) : error ? (
                            <section className="flex min-h-32 flex-col items-center justify-center gap-3 border-y border-border px-4 text-center sm:min-h-56">
                                <p className="text-sm text-stone-500 dark:text-stone-400">{error}</p>
                                <Button size="small" onClick={reload}>
                                    重新加载
                                </Button>
                            </section>
                        ) : !assets.length ? (
                            <CompactEmptyState title="没有找到素材" description="调整筛选条件，或新增一条常用素材。" />
                        ) : null}

                        <div className="flex justify-center overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            <Pagination
                                current={page}
                                pageSize={pageSize}
                                total={total}
                                showSizeChanger
                                pageSizeOptions={[10, 20, 50, 100]}
                                onChange={(nextPage, nextPageSize) => {
                                    setPage(nextPage);
                                    setPageSize(nextPageSize);
                                }}
                            />
                        </div>
                    </div>
                </div>
            </main>

            <Modal title={editingAsset ? "编辑素材" : "新增素材"} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset()} confirmLoading={saving} okText="保存" cancelText="取消" destroyOnHidden>
                <div className="grid gap-3 pt-1 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label="类型">
                            <Select
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                    { label: "音频", value: "audio" },
                                ]}
                                onChange={(value) => {
                                    setFormKind(value);
                                    setMediaDraft(null);
                                }}
                            />
                        </Form.Item>
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input size="large" placeholder="给素材起一个容易检索的名字" />
                        </Form.Item>
                        <Form.Item label="封面 URL">
                            <div
                                className={cn("rounded-md transition", isCoverDragActive && "ring-2 ring-cyan-300 ring-offset-2 ring-offset-white dark:ring-cyan-500 dark:ring-offset-stone-950")}
                                onDragEnter={handleCoverDragOver}
                                onDragOver={handleCoverDragOver}
                                onDragLeave={handleCoverDragLeave}
                                onDrop={handleCoverDrop}
                            >
                                <Space.Compact className="w-full">
                                    <Form.Item name="coverUrl" noStyle>
                                        <Input placeholder="可粘贴图片 URL，也可以上传本地封面" />
                                    </Form.Item>
                                    <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </Space.Compact>
                            </div>
                        </Form.Item>
                        <Form.Item name="tags" label="标签">
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后回车" />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label="来源">
                                <Input placeholder="手动添加 / 画布 / 提示词库" />
                            </Form.Item>
                            <Form.Item name="note" label="备注">
                                <Input placeholder="可选" />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label="文本内容" rules={[{ required: true, message: "请输入文本内容" }]}>
                                <Input.TextArea rows={8} placeholder="保存提示词、说明文案、参考描述等文本素材" />
                            </Form.Item>
                        ) : (
                            <Form.Item label={`${formKind === "image" ? "图片" : formKind === "video" ? "视频" : "音频"}内容`} required>
                                <div
                                    className={cn(
                                        "rounded-lg border border-dashed border-stone-300 p-4 transition dark:border-stone-700",
                                        isImageDragActive && "border-cyan-400 bg-cyan-50/60 ring-1 ring-cyan-200 dark:border-cyan-400 dark:bg-cyan-500/10 dark:ring-cyan-400/25",
                                    )}
                                    onDragEnter={handleImageDragOver}
                                    onDragOver={handleImageDragOver}
                                    onDragLeave={handleImageDragLeave}
                                    onDrop={handleImageDrop}
                                >
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        选择{formKind === "image" ? "图片" : formKind === "video" ? "视频" : "音频"}文件
                                    </Button>
                                    {mediaDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {"width" in mediaDraft ? `${mediaDraft.width}x${mediaDraft.height} · ` : ""}
                                            {formatBytes(mediaDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            未选择文件
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>预览</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {coverUrl || (mediaDraft && "dataUrl" in mediaDraft ? mediaDraft.dataUrl : "") ? (
                                <img src={imagePreviewUrl(coverUrl || (mediaDraft && "dataUrl" in mediaDraft ? mediaDraft.dataUrl : ""), 960)} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : formKind === "video" && mediaDraft && "url" in mediaDraft ? (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-900 text-white">
                                    <Film className="size-10" />
                                </div>
                            ) : formKind === "audio" && mediaDraft && "url" in mediaDraft ? (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 text-stone-500 dark:bg-stone-900">
                                    <FileAudio className="size-10" />
                                </div>
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || "暂无封面"}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || "未命名素材"}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">未打标签</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept={formKind === "image" ? "image/*" : formKind === "video" ? "video/*" : "audio/*"}
                    className="hidden"
                    onChange={(event) => {
                        void readMediaFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetPreviewModal asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />

            <Modal title="删除素材" open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={() => void confirmDelete()} confirmLoading={deleting} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                <div className="space-y-2 text-sm leading-6">
                    <p>确定删除「{deletingAsset?.title}」吗？</p>
                    {deletingAsset?.kind === "text" ? <p className="text-muted-foreground">删除后仅会从我的素材中移除，文本内容无法恢复。</p> : <p className="text-muted-foreground">删除后仅从素材库移除；如果服务器文件没有其他引用，系统会一并清理，否则会保留给画布、短剧或作品继续使用。</p>}
                </div>
            </Modal>
        </div>
    );
}
