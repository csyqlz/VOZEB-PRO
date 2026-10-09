"use client";

import type { TableColumnsType } from "antd";
import { App, Button, Input, Modal, Pagination, Segmented, Select, Table, Tag, Tooltip } from "antd";
import { Ban, Check, Eye, GalleryVerticalEnd, RefreshCw, Search, Star, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminAccountId, AdminUserIdentity } from "@/components/admin/admin-user-identity";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { workStatusToneClass } from "@/lib/work-publication-status";
import { setAdminWorkFeatured } from "@/services/api/work-governance";
import {
    deleteAdminWorkPublication,
    listAdminWorkPublications,
    reviewAdminWorkPublication,
    takeDownAdminWorkPublication,
    type WorkPublication,
    type WorkPublicationLifecycleStatus,
    type WorkPublicationModerationStatus,
    type WorkPublicationVisibility,
} from "@/services/api/work-publications";
import { AdminWorkCasesSection } from "./admin-work-cases-section";

const PAGE_SIZE = 12;
const STATUS_OPTIONS: Array<{ value: WorkPublicationModerationStatus | "all"; label: string }> = [
    { value: "all", label: "全部" },
    { value: "pending", label: "待审核" },
    { value: "approved", label: "已通过" },
    { value: "rejected", label: "已驳回" },
    { value: "taken_down", label: "已下架" },
];

export function AdminWorksSection() {
    const [view, setView] = useState<"reviews" | "governance">("reviews");
    return (
        <Panel variant="page">
            <PanelHeader
                title="作品管理"
                description="审核公开作品并处理举报与申诉；所有处置保留版本证据，不影响用户原始素材和项目。"
                actions={
                    <Segmented
                        value={view}
                        aria-label="切换作品管理视图"
                        options={[
                            { value: "reviews", label: "作品审核" },
                            { value: "governance", label: "举报申诉" },
                        ]}
                        onChange={(value) => setView(value as typeof view)}
                    />
                }
            />
            {view === "reviews" ? <AdminWorkReviewSection /> : <AdminWorkCasesSection />}
        </Panel>
    );
}

function AdminWorkReviewSection() {
    const { message, modal } = App.useApp();
    const requestIdRef = useRef(0);
    const [items, setItems] = useState<WorkPublication[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [status, setStatus] = useState<WorkPublicationModerationStatus | "all">("all");
    const [lifecycleStatus, setLifecycleStatus] = useState<WorkPublicationLifecycleStatus | "all">("all");
    const [keyword, setKeyword] = useState("");
    const [debouncedKeyword, setDebouncedKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [actionId, setActionId] = useState("");
    const [reasonAction, setReasonAction] = useState<{ work: WorkPublication; kind: "reject" | "take-down" }>();
    const [reason, setReason] = useState("");
    const [viewingWork, setViewingWork] = useState<WorkPublication>();

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    const load = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setError("");
        try {
            const result = await listAdminWorkPublications({
                page,
                pageSize: PAGE_SIZE,
                status: status === "all" ? undefined : status,
                lifecycleStatus: lifecycleStatus === "all" ? undefined : lifecycleStatus,
                keyword: debouncedKeyword || undefined,
            });
            if (requestId !== requestIdRef.current) return;
            setItems(result.items);
            setTotal(result.total);
        } catch (loadError) {
            if (requestId !== requestIdRef.current) return;
            setItems([]);
            setTotal(0);
            setError(loadError instanceof Error ? loadError.message : "作品审核列表加载失败");
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [debouncedKeyword, lifecycleStatus, page, status]);

    useEffect(() => {
        void load();
    }, [load]);

    const approve = (work: WorkPublication) => {
        const version = work.currentVersion;
        if (!version) return;
        modal.confirm({
            title: "通过这个发布版本？",
            content: "审核通过后将原子切换为当前公开版本；已有线上版本会被替换，但历史审核证据仍保留。",
            okText: "通过审核",
            cancelText: "取消",
            onOk: async () => {
                setActionId(work.id);
                try {
                    await reviewAdminWorkPublication(work.id, { versionId: version.id, decision: "approved" });
                    message.success("作品已通过审核");
                    await load();
                } catch (approveError) {
                    message.error(approveError instanceof Error ? approveError.message : "审核失败");
                    throw approveError;
                } finally {
                    setActionId("");
                }
            },
        });
    };

    const submitReasonAction = async () => {
        const action = reasonAction;
        const value = reason.trim();
        if (!action || !value) return message.warning(action?.kind === "reject" ? "请填写驳回原因" : "请填写下架原因");
        const version = action.work.currentVersion;
        if (!version) return;
        setActionId(action.work.id);
        try {
            if (action.kind === "reject") await reviewAdminWorkPublication(action.work.id, { versionId: version.id, decision: "rejected", reason: value });
            else await takeDownAdminWorkPublication(action.work.id, value);
            message.success(action.kind === "reject" ? "作品已驳回" : "作品已下架");
            setReasonAction(undefined);
            setReason("");
            await load();
        } catch (actionError) {
            message.error(actionError instanceof Error ? actionError.message : "操作失败");
        } finally {
            setActionId("");
        }
    };

    const toggleFeatured = async (work: WorkPublication) => {
        setActionId(work.id);
        try {
            await setAdminWorkFeatured(work.id, !work.isFeatured);
            message.success(work.isFeatured ? "作品已取消精选" : "作品已设为精选");
            await load();
        } catch (featureError) {
            message.error(featureError instanceof Error ? featureError.message : "更新精选状态失败");
        } finally {
            setActionId("");
        }
    };

    const remove = (work: WorkPublication) => {
        modal.confirm({
            title: "永久删除这个作品？",
            content: "作品主记录、全部版本快照、发布媒体关联和互动记录会被永久删除，用户原始素材与项目不受影响。此操作无法撤销。",
            okText: "永久删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                setActionId(work.id);
                try {
                    await deleteAdminWorkPublication(work.id);
                    message.success("作品已永久删除");
                    await load();
                } catch (deleteError) {
                    message.error(deleteError instanceof Error ? deleteError.message : "删除失败");
                    throw deleteError;
                } finally {
                    setActionId("");
                }
            },
        });
    };

    const clearFilters = () => {
        setStatus("all");
        setLifecycleStatus("all");
        setKeyword("");
        setPage(1);
    };

    const renderActions = (work: WorkPublication) => {
        const version = work.currentVersion;
        if (!version) return null;
        const busy = actionId === work.id;
        const pending = work.lifecycleStatus === "active" && version.moderationStatus === "pending";
        const shareable = work.lifecycleStatus === "active" && Boolean(work.publishedVersionId) && work.publishedVersion?.visibility !== "private";
        const canFeature = shareable && work.publishedVersion?.visibility === "public";
        const canDelete = work.lifecycleStatus === "revoked" || (!work.publishedVersionId && version.moderationStatus === "taken_down");
        return (
            <div className="flex flex-wrap items-center justify-end gap-0.5">
                <Button type="link" size="small" icon={<Eye className="size-3.5" />} onClick={() => setViewingWork(work)}>
                    详情
                </Button>
                {shareable ? (
                    <Tooltip title="打开公开页面">
                        <Button type="text" size="small" aria-label="打开公开页面" icon={<Eye className="size-3.5" />} onClick={() => window.open(`/share/${encodeURIComponent(work.slug)}`, "_blank", "noopener,noreferrer")} />
                    </Tooltip>
                ) : null}
                {canFeature ? (
                    <Tooltip title={work.isFeatured ? "取消精选" : "设为精选"}>
                        <Button type="text" size="small" aria-label={work.isFeatured ? "取消精选" : "设为精选"} icon={<Star className={`size-3.5 ${work.isFeatured ? "fill-current" : ""}`} />} onClick={() => void toggleFeatured(work)} loading={busy} />
                    </Tooltip>
                ) : null}
                {pending ? (
                    <>
                        <Button
                            type="link"
                            size="small"
                            danger
                            icon={<X className="size-3.5" />}
                            disabled={busy}
                            onClick={() => {
                                setReason("");
                                setReasonAction({ work, kind: "reject" });
                            }}
                        >
                            驳回
                        </Button>
                        <Button type="link" size="small" icon={<Check className="size-3.5" />} loading={busy} onClick={() => approve(work)}>
                            通过
                        </Button>
                    </>
                ) : null}
                {work.lifecycleStatus === "active" && work.publishedVersionId ? (
                    <Button
                        type="link"
                        size="small"
                        danger
                        icon={<Ban className="size-3.5" />}
                        disabled={busy}
                        onClick={() => {
                            setReason("");
                            setReasonAction({ work, kind: "take-down" });
                        }}
                    >
                        下架
                    </Button>
                ) : null}
                {canDelete ? (
                    <Button type="link" size="small" danger icon={<Trash2 className="size-3.5" />} loading={busy} onClick={() => remove(work)}>
                        删除
                    </Button>
                ) : null}
            </div>
        );
    };

    const columns: TableColumnsType<WorkPublication> = [
        {
            title: "更新时间",
            dataIndex: "updatedAt",
            width: 128,
            render: (value: string) => <span className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">{formatAdminTime(value)}</span>,
        },
        {
            title: "作品",
            key: "work",
            width: 280,
            render: (_, work) => <AdminWorkIdentity work={work} />,
        },
        {
            title: "用户",
            key: "owner",
            width: 170,
            render: (_, work) => <AdminUserIdentity displayName={work.ownerDisplayName} username={work.ownerUsername} accountId={work.ownerAccountId} fallback="用户信息不可用" />,
        },
        {
            title: "来源",
            dataIndex: "sourceType",
            width: 72,
            render: (value: WorkPublication["sourceType"]) => <span className="text-xs text-zinc-600 dark:text-zinc-300">{sourceTypeLabel(value)}</span>,
        },
        {
            title: "版本 / 可见性",
            key: "version",
            width: 104,
            render: (_, work) => (
                <div className="text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                    <div>v{work.currentVersion?.versionNumber || 1}</div>
                    <div className="text-zinc-500 dark:text-zinc-400">{visibilityLabel(work.currentVersion?.visibility)}</div>
                </div>
            ),
        },
        {
            title: "状态",
            key: "status",
            width: 92,
            render: (_, work) => <AdminWorkStatus work={work} />,
        },
        {
            title: "数据",
            key: "metrics",
            width: 92,
            render: (_, work) => (
                <div className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                    <div>{work.viewCount} 次访问</div>
                    <div>{work.likeCount} 次点赞</div>
                </div>
            ),
        },
        {
            title: "操作",
            key: "actions",
            fixed: "right",
            width: 260,
            render: (_, work) => renderActions(work),
        },
    ];

    return (
        <>
            <div className="admin-panel-surface min-w-0 space-y-3 overflow-hidden rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950 sm:p-4">
                <div className="grid min-w-0 grid-cols-2 gap-2.5 xl:grid-cols-[minmax(280px,360px)_120px_132px_auto_auto_auto] xl:items-center" data-testid="admin-work-filters">
                    <div className="col-span-2 min-w-0 xl:col-span-1">
                        <Input
                            className="w-full"
                            allowClear
                            prefix={<Search className="size-4 text-zinc-400" />}
                            placeholder="搜索作品标题、用户、用户 ID 或作品链接"
                            value={keyword}
                            onChange={(event) => {
                                setKeyword(event.target.value);
                                setPage(1);
                            }}
                        />
                    </div>
                    <Select
                        className="min-w-0"
                        value={status}
                        options={STATUS_OPTIONS}
                        onChange={(value) => {
                            setStatus(value);
                            if (value === "taken_down") setLifecycleStatus("all");
                            setPage(1);
                        }}
                    />
                    <Select
                        className="min-w-0"
                        value={lifecycleStatus}
                        options={[
                            { value: "all", label: "全部" },
                            { value: "active", label: "有效作品" },
                            { value: "revoked", label: "用户已下架" },
                        ]}
                        onChange={(value) => {
                            setLifecycleStatus(value);
                            setPage(1);
                        }}
                    />
                    <span className="col-span-2 whitespace-nowrap text-sm text-zinc-500 dark:text-zinc-400 xl:col-span-1">共 {total} 条</span>
                    <Button className="w-full xl:w-auto" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                        刷新
                    </Button>
                    <Button className="w-full xl:w-auto" onClick={clearFilters}>
                        清除筛选
                    </Button>
                </div>

                {error ? (
                    <div className="grid min-h-40 place-items-center border-y border-rose-200 px-4 text-center text-sm text-rose-700 dark:border-rose-900/60 dark:text-rose-300">{error}</div>
                ) : (
                    <>
                        <div className="space-y-2 md:hidden">
                            {items.map((work) => (
                                <AdminWorkMobileCard key={work.id} work={work} actions={renderActions(work)} />
                            ))}
                            {!items.length && !loading ? <AdminWorksEmpty /> : null}
                            {loading && !items.length ? <div className="grid min-h-36 place-items-center text-sm text-zinc-500 dark:text-zinc-400">正在加载作品...</div> : null}
                            {total > PAGE_SIZE ? <Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} size="small" onChange={setPage} /> : null}
                        </div>
                        <div className="hidden min-w-0 md:block">
                            <Table
                                className="admin-work-table"
                                rowKey="id"
                                columns={columns}
                                dataSource={items}
                                loading={loading}
                                pagination={{
                                    current: page,
                                    pageSize: PAGE_SIZE,
                                    total,
                                    showSizeChanger: false,
                                    showTotal: (count, range) => `${range[0]}-${range[1]} / ${count} 条`,
                                    onChange: setPage,
                                }}
                                locale={{ emptyText: <AdminWorksEmpty /> }}
                                scroll={{ x: 1198 }}
                                size="middle"
                                tableLayout="fixed"
                            />
                        </div>
                    </>
                )}
            </div>

            <Modal
                title={reasonAction?.kind === "reject" ? "驳回发布版本" : "下架公开作品"}
                open={Boolean(reasonAction)}
                okText={reasonAction?.kind === "reject" ? "确认驳回" : "确认下架"}
                cancelText="取消"
                confirmLoading={Boolean(reasonAction && actionId === reasonAction.work.id)}
                okButtonProps={{ danger: true, disabled: !reason.trim() }}
                onOk={() => void submitReasonAction()}
                onCancel={() => {
                    setReasonAction(undefined);
                    setReason("");
                }}
            >
                <p className="mb-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{reasonAction?.kind === "reject" ? "原因会显示给投稿用户，需说明可执行的修改方向。" : "下架后公开链接和媒体会立即返回 404，请填写可审计原因。"}</p>
                <Input.TextArea
                    value={reason}
                    rows={4}
                    maxLength={500}
                    showCount
                    placeholder={reasonAction?.kind === "reject" ? "例如：封面包含不可公开的个人信息，请替换后重新提交" : "例如：收到权利方通知，等待运营复核"}
                    onChange={(event) => setReason(event.target.value)}
                />
            </Modal>
            <Modal title="作品详情" open={Boolean(viewingWork)} width={760} footer={null} destroyOnHidden onCancel={() => setViewingWork(undefined)}>
                {viewingWork ? <AdminWorkDetail work={viewingWork} /> : null}
            </Modal>
        </>
    );
}

function AdminWorkIdentity({ work }: { work: WorkPublication }) {
    const version = work.currentVersion;
    if (!version) return <span className="text-xs text-zinc-500">版本不可用</span>;
    return (
        <div className="flex min-w-0 items-center gap-2.5">
            <AdminWorkThumbnail work={work} />
            <div className="min-w-0 flex-1">
                <Tooltip title={version.title} placement="topLeft">
                    <div className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">{version.title}</div>
                </Tooltip>
                <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{version.description || "未填写作品说明"}</div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-400 dark:text-zinc-500" title={work.slug}>
                    {work.slug}
                </div>
            </div>
        </div>
    );
}

function AdminWorkStatus({ work }: { work: WorkPublication }) {
    const version = work.currentVersion;
    if (!version) return <Tag className="m-0">未知</Tag>;
    const moderationSignal = version.moderationStatus === "pending" ? moderationSignalText(version.moderationProvider, version.moderationSignal) : "";
    const tag = (
        <span className={`inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium leading-none ${workStatusToneClass(work.lifecycleStatus === "revoked" ? "revoked" : version.moderationStatus)}`}>
            {work.lifecycleStatus === "revoked" ? "用户已下架" : adminStatusLabel(version.moderationStatus)}
        </span>
    );
    return (
        <div className="flex flex-col items-start gap-1">
            {moderationSignal ? <Tooltip title={moderationSignal}>{tag}</Tooltip> : tag}
            {work.isFeatured ? <Tag color="gold">精选</Tag> : null}
            {work.publishedVersion && work.publishedVersion.id !== version.id ? <span className="text-[11px] text-zinc-500 dark:text-zinc-400">线上 v{work.publishedVersion.versionNumber}</span> : null}
        </div>
    );
}

function AdminWorkThumbnail({ work }: { work: WorkPublication }) {
    const [failed, setFailed] = useState(false);
    const asset = work.currentPreview;
    const url = asset?.previewUrl || "";
    const imageUrl = imagePreviewUrl(url, 256);
    useEffect(() => setFailed(false), [url]);
    return (
        <div className="relative size-14 shrink-0 overflow-hidden rounded-md border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
            <img src="/logo.svg" alt="" className="absolute inset-0 size-full object-contain p-3 opacity-45" />
            {!failed && url && asset?.mediaType === "video" ? <video src={url} muted playsInline preload="metadata" className="relative size-full object-cover" onError={() => setFailed(true)} /> : null}
            {!failed && imageUrl && asset?.mediaType === "image" ? <img src={imageUrl} alt={work.currentVersion?.title || "作品预览"} loading="lazy" className="relative size-full object-cover" onError={() => setFailed(true)} /> : null}
        </div>
    );
}

function AdminWorkMobileCard({ work, actions }: { work: WorkPublication; actions: ReactNode }) {
    return (
        <article className="min-w-0 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <AdminWorkIdentity work={work} />
                </div>
                <AdminWorkStatus work={work} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{work.ownerDisplayName || work.ownerUsername || "用户信息不可用"}</span>
                    <AdminAccountId accountId={work.ownerAccountId} className="shrink-0" />
                </span>
                <span>{sourceTypeLabel(work.sourceType)}</span>
                <span>{formatAdminTime(work.updatedAt)}</span>
            </div>
            <div className="mt-2 flex flex-wrap justify-end gap-0.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">{actions}</div>
        </article>
    );
}

function AdminWorksEmpty() {
    return (
        <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-4 text-center">
            <GalleryVerticalEnd className="size-5 text-zinc-400" />
            <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">当前筛选下没有作品</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">切换审核状态或清除筛选后再查看。</div>
        </div>
    );
}

function AdminWorkDetail({ work }: { work: WorkPublication }) {
    const version = work.currentVersion;
    if (!version) return null;
    const asset = work.currentPreview;
    const url = asset?.previewUrl || "";
    const imageUrl = imagePreviewUrl(url, 1920);
    return (
        <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[240px_minmax(0,1fr)]">
                <div className="relative aspect-square overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
                    <img src="/logo.svg" alt="" className="absolute inset-0 size-full object-contain p-16 opacity-40" />
                    {url && asset?.mediaType === "video" ? <video src={url} controls playsInline preload="metadata" className="relative size-full object-contain" /> : null}
                    {imageUrl && asset?.mediaType === "image" ? <img src={imageUrl} alt={version.title} loading="lazy" className="relative size-full object-contain" /> : null}
                </div>
                <div className="min-w-0 space-y-3">
                    <div>
                        <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-100">{version.title}</h3>
                        <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{version.description || "未填写作品说明"}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-zinc-200 py-3 text-xs dark:border-zinc-800">
                        <DetailValue label="用户" value={`${work.ownerDisplayName || work.ownerUsername || "用户信息不可用"}${work.ownerAccountId ? ` · ID：${work.ownerAccountId}` : ""}`} />
                        <DetailValue label="来源" value={sourceTypeLabel(work.sourceType)} />
                        <DetailValue label="版本" value={`v${version.versionNumber}`} />
                        <DetailValue label="可见性" value={visibilityLabel(version.visibility)} />
                        <DetailValue label="更新时间" value={formatAdminTime(work.updatedAt)} />
                        <DetailValue label="作品链接" value={work.slug} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        <AdminWorkStatus work={work} />
                        {version.tags.map((tag) => (
                            <Tag key={tag} className="m-0">
                                {tag}
                            </Tag>
                        ))}
                    </div>
                </div>
            </div>
            <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">公开提示词</div>
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-zinc-800 dark:text-zinc-200">{version.publicPrompt || "未填写提示词"}</div>
            </div>
            {version.rejectionReason ? <div className="border-l-2 border-rose-400 pl-3 text-sm leading-6 text-rose-700 dark:text-rose-300">处理原因：{version.rejectionReason}</div> : null}
        </div>
    );
}

function DetailValue({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <div className="text-zinc-400 dark:text-zinc-500">{label}</div>
            <div className="mt-0.5 truncate text-zinc-700 dark:text-zinc-200" title={value}>
                {value}
            </div>
        </div>
    );
}

function sourceTypeLabel(value: WorkPublication["sourceType"]) {
    return value === "canvas" ? "画布" : value === "drama" ? "短剧" : "素材";
}

function visibilityLabel(value: WorkPublicationVisibility | undefined) {
    return value === "public" ? "公开" : value === "unlisted" ? "持链接可见" : "仅自己可见";
}

function formatAdminTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function adminStatusLabel(status: WorkPublicationModerationStatus) {
    return status === "pending" ? "待审核" : status === "approved" ? "已通过" : status === "rejected" ? "已驳回" : status === "taken_down" ? "已下架" : "草稿";
}

function moderationSignalText(provider: string | undefined, value: unknown) {
    if (!provider || provider === "manual") return "等待人工审核";
    if (!value || typeof value !== "object") return "";
    const signal = value as { riskLevel?: unknown; summary?: unknown };
    const summary = typeof signal.summary === "string" ? signal.summary : "";
    if (!summary) return "";
    const level = signal.riskLevel === "safe" ? "低风险" : signal.riskLevel === "block" ? "高风险" : "需复核";
    return `${provider} / ${level} / ${summary}`;
}
