"use client";

import { App, Button, Checkbox, Image, Input, Modal, Pagination, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { Clock3, Download, Eye, File, FileAudio, Film, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminMediaTypeTabs } from "@/components/admin/admin-media-type-tabs";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminAccountId } from "@/components/admin/admin-user-identity";
import type { LocalMediaAsset, LocalMediaStoragePayload } from "@/lib/local-media-storage-contract";
import { managedMediaTypeLabel, mediaSourceGroupOptions, mediaSourceLabel } from "@/lib/media-management-contract";
import { imagePreviewUrl, originalMediaDownloadUrl } from "@/lib/media-image-url";

const PAGE_SIZE = 20;

export function AdminLocalMediaStorage() {
    const { message } = App.useApp();
    const [data, setData] = useState<LocalMediaStoragePayload>();
    const [loading, setLoading] = useState(true);
    const [deletingId, setDeletingId] = useState("");
    const [cleaningExpired, setCleaningExpired] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [previewAsset, setPreviewAsset] = useState<LocalMediaAsset>();
    const [page, setPage] = useState(1);
    const [storageClass, setStorageClass] = useState("");
    const [type, setType] = useState("");
    const [source, setSource] = useState("");
    const [search, setSearch] = useState("");
    const [submittedSearch, setSubmittedSearch] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
            if (storageClass) query.set("storageClass", storageClass);
            if (type) query.set("type", type);
            if (source) query.set("source", source);
            if (submittedSearch) query.set("search", submittedSearch);
            const response = await fetch(`/api/admin/generation-assets?${query}`, { cache: "no-store" });
            const payload = (await response.json().catch(() => ({}))) as { data?: LocalMediaStoragePayload; msg?: string; error?: string };
            if (!response.ok || !payload.data) throw new Error(payload.msg || payload.error || "媒体文件加载失败");
            setData(payload.data);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "媒体文件加载失败");
        } finally {
            setLoading(false);
        }
    }, [message, page, source, storageClass, submittedSearch, type]);

    useEffect(() => {
        void load();
    }, [load]);

    const applySearchFilter = (value: string) => {
        setPage(1);
        setSubmittedSearch(value.trim());
    };

    const remove = async (ids: string[]) => {
        setDeletingId(ids.length === 1 ? ids[0] : "bulk");
        try {
            const response = await fetch("/api/admin/generation-assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
            const payload = (await response.json().catch(() => ({}))) as { data?: { deletedFiles?: number; blocked?: Array<{ referenceCount?: number }> }; msg?: string; error?: string };
            if (!response.ok) throw new Error(payload.msg || payload.error || "媒体文件删除失败");
            const blocked = payload.data?.blocked?.length || 0;
            if (blocked) message.warning(`${blocked} 个文件仍被业务记录引用，已保留；其余文件已删除`);
            else message.success(`已删除 ${payload.data?.deletedFiles || ids.length} 个媒体文件`);
            setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "媒体文件删除失败");
        } finally {
            setDeletingId("");
        }
    };

    const cleanupExpired = async () => {
        setCleaningExpired(true);
        try {
            const response = await fetch("/api/admin/generation-assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expired: true }) });
            const payload = (await response.json().catch(() => ({}))) as { data?: { deletedFiles?: number; blocked?: unknown[] }; msg?: string; error?: string };
            if (!response.ok) throw new Error(payload.msg || payload.error || "过期文件清理失败");
            const blocked = payload.data?.blocked?.length || 0;
            if (blocked) message.warning(`已清理 ${payload.data?.deletedFiles || 0} 个过期临时文件，${blocked} 个仍被业务数据引用并已保留`);
            else message.success(`已清理 ${payload.data?.deletedFiles || 0} 个过期临时文件`);
            setSelectedIds([]);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "过期文件清理失败");
        } finally {
            setCleaningExpired(false);
        }
    };

    const columns = useMemo<TableColumnsType<LocalMediaAsset>>(
        () => [
            {
                title: "文件",
                render: (_, asset) => (
                    <div className="flex min-w-0 items-center gap-3">
                        <MediaThumbnail asset={asset} onPreview={setPreviewAsset} />
                        <div className="min-w-0">
                            <div className="truncate text-sm font-medium" title={asset.originalName || asset.name}>
                                {asset.originalName || asset.name}
                            </div>
                            <div className="mt-1 text-xs text-zinc-500">
                                {managedMediaTypeLabel(asset.type)} · {formatBytes(asset.bytes)} · {asset.name}
                            </div>
                        </div>
                    </div>
                ),
            },
            {
                title: "归属与来源",
                width: 220,
                render: (_, asset) => (
                    <div className="min-w-0 text-xs text-zinc-500">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="truncate text-zinc-800 dark:text-zinc-200">{asset.ownerDisplayName || asset.ownerUsername || (asset.ownerUserId ? "用户信息不可用" : "未登记用户")}</span>
                            <AdminAccountId accountId={asset.ownerAccountId} className="shrink-0" />
                        </div>
                        <div className="mt-1 truncate">{mediaSourceLabel(asset.source)}</div>
                        {asset.projectId || asset.conversationId || asset.taskId ? (
                            <div className="mt-1 truncate font-mono" title={asset.projectId || asset.conversationId || asset.taskId}>
                                {asset.projectId || asset.conversationId || asset.taskId}
                            </div>
                        ) : null}
                    </div>
                ),
            },
            {
                title: "存储目录",
                dataIndex: "directory",
                width: 280,
                render: (value: string) => (
                    <span className="block truncate font-mono text-xs text-zinc-500" title={value}>
                        {value}
                    </span>
                ),
            },
            {
                title: "分类",
                width: 120,
                render: (_, asset) => (
                    <div className="space-y-1">
                        <Tag color={asset.storageClass === "permanent" ? "blue" : "gold"}>{asset.storageClass === "permanent" ? "长期" : "临时"}</Tag>
                        {asset.referenceCount ? <div className="text-xs text-zinc-500">引用 {asset.referenceCount}</div> : null}
                    </div>
                ),
            },
            { title: "保留期限", width: 170, render: (_, asset) => <span className={asset.expiresAt && Date.parse(asset.expiresAt) <= Date.now() ? "text-red-600 dark:text-red-300" : "text-zinc-500 dark:text-zinc-400"}>{formatRetention(asset)}</span> },
            { title: "写入时间", dataIndex: "createdAt", width: 180, render: (value: string) => formatTime(value) },
            {
                title: "操作",
                width: 86,
                align: "right",
                render: (_, asset) => (
                    <div className="flex justify-end gap-1">
                        <Button type="text" shape="circle" aria-label="预览媒体文件" icon={<Eye className="size-4" />} onClick={() => setPreviewAsset(asset)} />
                        <Popconfirm title="删除这个媒体文件？" description="仍被会话、项目或素材库引用时会自动保留。" okText="删除" cancelText="取消" onConfirm={() => void remove([asset.id])}>
                            <Button danger type="text" shape="circle" aria-label="删除媒体文件" icon={<Trash2 className="size-4" />} loading={deletingId === asset.id} />
                        </Popconfirm>
                    </div>
                ),
            },
        ],
        [deletingId],
    );

    const summary = data?.summary;
    return (
        <Panel variant="page">
            <PanelHeader
                title="本地媒体文件"
                description="临时文件保留 24 小时，长期文件保留到管理员删除。"
                actions={
                    <>
                        <Tooltip title="刷新">
                            <Button aria-label="刷新媒体文件" className="!w-8 !px-0 sm:!w-auto sm:!px-3" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                                <span className="hidden sm:inline">刷新</span>
                            </Button>
                        </Tooltip>
                        <Popconfirm title="清理全部已过期且未被引用的临时文件？" okText="清理" cancelText="取消" onConfirm={() => void cleanupExpired()}>
                            <Tooltip title="清理过期文件">
                                <Button aria-label="清理过期文件" className="!w-8 !px-0 sm:!w-auto sm:!px-3" disabled={!summary?.expiredTemporaryFiles} icon={<Clock3 className="size-4" />} loading={cleaningExpired}>
                                    <span className="hidden sm:inline">清理过期</span>
                                </Button>
                            </Tooltip>
                        </Popconfirm>
                        <Popconfirm title={`删除选中的 ${selectedIds.length} 个媒体文件？`} description="仍被会话、项目或素材库引用的文件会自动保留。" okText="批量删除" cancelText="取消" onConfirm={() => void remove(selectedIds)}>
                            <Tooltip title="批量删除">
                                <Button danger aria-label="批量删除媒体文件" className="!w-8 !px-0 sm:!w-auto sm:!px-3" disabled={!selectedIds.length} loading={deletingId === "bulk"} icon={<Trash2 className="size-4" />}>
                                    <span className="hidden sm:inline">批量删除</span>
                                </Button>
                            </Tooltip>
                        </Popconfirm>
                    </>
                }
            />
            <div className="p-4 sm:p-5">
                <div className="grid overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 sm:grid-cols-3">
                    <StorageMetric label="全部文件" files={summary?.totalFiles || 0} bytes={summary?.totalBytes || 0} />
                    <StorageMetric label="临时文件" files={summary?.temporaryFiles || 0} bytes={summary?.temporaryBytes || 0} detail={`${summary?.expiredTemporaryFiles || 0} 个已过期`} />
                    <StorageMetric label="长期文件" files={summary?.permanentFiles || 0} bytes={summary?.permanentBytes || 0} />
                </div>

                <div className="mt-4">
                    <AdminMediaTypeTabs
                        value={type}
                        onChange={(value) => {
                            setPage(1);
                            setType(value);
                        }}
                    />
                    <div className="grid max-w-[840px] grid-cols-[minmax(0,1fr)_40px] gap-2 xl:grid-cols-[360px_40px_180px_160px]">
                        <Input
                            value={search}
                            allowClear
                            placeholder="搜索文件名、用户、用户 ID 或关联 ID"
                            onChange={(event) => {
                                const next = event.target.value;
                                setSearch(next);
                                if (!next && submittedSearch) applySearchFilter("");
                            }}
                            onPressEnter={(event) => applySearchFilter(event.currentTarget.value)}
                        />
                        <Tooltip title="筛选">
                            <Button aria-label="筛选本地媒体文件" className="!w-10 !px-0" icon={<Search className="size-4" />} onClick={() => applySearchFilter(search)} />
                        </Tooltip>
                        <div className="col-span-2 min-w-0 xl:col-span-1">
                            <Select
                                className="w-full"
                                value={source}
                                options={mediaSourceGroupOptions.map((option) => ({ ...option }))}
                                onChange={(value) => {
                                    setPage(1);
                                    setSource(value);
                                }}
                            />
                        </div>
                        <div className="col-span-2 min-w-0 xl:col-span-1">
                            <Select
                                className="w-full"
                                value={storageClass || undefined}
                                allowClear
                                placeholder="存储期限"
                                options={[
                                    { value: "temporary", label: "临时文件" },
                                    { value: "permanent", label: "长期文件" },
                                ]}
                                onChange={(value) => {
                                    setPage(1);
                                    setStorageClass(value || "");
                                }}
                            />
                        </div>
                    </div>
                </div>

                <div className="mt-4 hidden overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 md:block">
                    <Table rowKey="id" size="middle" loading={loading} columns={columns} dataSource={data?.items || []} pagination={false} rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys.map(String)) }} />
                </div>
                <div className="mt-4 space-y-2 md:hidden">
                    <Checkbox
                        checked={Boolean(data?.items.length) && data!.items.every((asset) => selectedIds.includes(asset.id))}
                        indeterminate={Boolean(data?.items.some((asset) => selectedIds.includes(asset.id))) && !data?.items.every((asset) => selectedIds.includes(asset.id))}
                        onChange={(event) =>
                            setSelectedIds((current) => (event.target.checked ? Array.from(new Set([...current, ...(data?.items || []).map((asset) => asset.id)])) : current.filter((id) => !(data?.items || []).some((asset) => asset.id === id))))
                        }
                    >
                        选择本页
                    </Checkbox>
                    {(data?.items || []).map((asset) => (
                        <div key={asset.id} className="flex min-w-0 items-center gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                            <Checkbox checked={selectedIds.includes(asset.id)} onChange={(event) => setSelectedIds((current) => (event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id)))} aria-label="选择媒体文件" />
                            <MediaThumbnail asset={asset} onPreview={setPreviewAsset} />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{asset.originalName || asset.name}</div>
                                <div className="mt-1 text-xs text-zinc-500">
                                    {asset.storageClass === "permanent" ? "长期" : "临时"} · {managedMediaTypeLabel(asset.type)} · {formatBytes(asset.bytes)}
                                </div>
                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                                    <span className="truncate">{asset.ownerDisplayName || asset.ownerUsername || (asset.ownerUserId ? "用户信息不可用" : "未登记用户")}</span>
                                    <AdminAccountId accountId={asset.ownerAccountId} className="shrink-0" />
                                    <span className="truncate">{mediaSourceLabel(asset.source)}</span>
                                </div>
                                <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{asset.directory}</div>
                                <div className="mt-1 text-xs text-zinc-500">{formatRetention(asset)}</div>
                            </div>
                            <Popconfirm title="删除这个媒体文件？" okText="删除" cancelText="取消" onConfirm={() => void remove([asset.id])}>
                                <Button danger type="text" shape="circle" aria-label="删除媒体文件" icon={<Trash2 className="size-4" />} loading={deletingId === asset.id} />
                            </Popconfirm>
                        </div>
                    ))}
                    {!loading && !data?.items.length ? <div className="py-10 text-center text-sm text-zinc-500">暂无媒体文件</div> : null}
                </div>
                <Pagination className="mt-4 justify-end" current={page} pageSize={PAGE_SIZE} total={data?.total || 0} showSizeChanger={false} onChange={setPage} />
            </div>
            <Modal
                title={previewAsset?.originalName || previewAsset?.name || "媒体预览"}
                open={Boolean(previewAsset)}
                footer={
                    previewAsset ? (
                        <Button icon={<Download className="size-4" />} href={originalDownloadUrl(previewAsset.url)} target="_blank">
                            下载原文件
                        </Button>
                    ) : null
                }
                width={820}
                centered
                destroyOnHidden
                onCancel={() => setPreviewAsset(undefined)}
            >
                {previewAsset ? <MediaViewer asset={previewAsset} /> : null}
            </Modal>
        </Panel>
    );
}

function MediaThumbnail({ asset, onPreview }: { asset: LocalMediaAsset; onPreview: (asset: LocalMediaAsset) => void }) {
    return (
        <button
            type="button"
            className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 text-zinc-500 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:text-white"
            aria-label={`预览${managedMediaTypeLabel(asset.type)}`}
            onClick={() => onPreview(asset)}
        >
            {asset.type === "image" ? (
                <Image preview={false} src={imagePreviewUrl(asset.url, 256)} alt="" width={48} height={48} className="size-12 object-cover" fallback="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" />
            ) : asset.type === "video" ? (
                <Film className="size-5" />
            ) : asset.type === "audio" ? (
                <FileAudio className="size-5" />
            ) : (
                <File className="size-5" />
            )}
        </button>
    );
}

function MediaViewer({ asset }: { asset: LocalMediaAsset }) {
    if (asset.type === "image")
        return (
            <div className="flex max-h-[70dvh] justify-center overflow-auto rounded-md bg-zinc-100 p-3 dark:bg-zinc-900">
                <Image src={imagePreviewUrl(asset.url, 1920)} alt={asset.name} className="max-h-[66dvh] object-contain" preview={{ src: imagePreviewUrl(asset.url, 1920) }} />
            </div>
        );
    if (asset.type === "video") return <video className="max-h-[70dvh] w-full rounded-md bg-black" src={asset.url} controls playsInline preload="metadata" />;
    if (asset.type === "audio")
        return (
            <div className="flex min-h-48 flex-col items-center justify-center gap-4 rounded-md bg-zinc-100 p-6 dark:bg-zinc-900">
                <FileAudio className="size-10 text-zinc-400" />
                <audio className="w-full max-w-xl" src={asset.url} controls preload="metadata" />
            </div>
        );
    return (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-md bg-zinc-100 p-6 text-center dark:bg-zinc-900">
            <File className="size-10 text-zinc-400" />
            <div className="text-sm text-zinc-500">附件不支持在线预览，请下载后查看</div>
        </div>
    );
}

function StorageMetric({ label, files, bytes, detail }: { label: string; files: number; bytes: number; detail?: string }) {
    return (
        <div className="border-b border-zinc-200 p-3 last:border-b-0 dark:border-zinc-800 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{files}</div>
            <div className="mt-1 text-xs text-zinc-500">
                {formatBytes(bytes)}
                {detail ? ` · ${detail}` : ""}
            </div>
        </div>
    );
}

function formatRetention(asset: LocalMediaAsset) {
    if (!asset.expiresAt) return "长期保留";
    const remaining = Date.parse(asset.expiresAt) - Date.now();
    if (remaining <= 0) return "已过期";
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.max(1, Math.ceil((remaining % 3_600_000) / 60_000));
    return hours ? `${hours} 小时 ${minutes} 分后过期` : `${minutes} 分后过期`;
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function originalDownloadUrl(url: string) {
    return originalMediaDownloadUrl(url);
}

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}
