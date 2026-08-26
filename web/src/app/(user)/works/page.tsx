"use client";

import { App, Button, Input, Modal, Pagination, Segmented, Select, Tag } from "antd";
import { ArrowUpFromLine, Ban, Compass, Copy, Eye, Film, GalleryVerticalEnd, Image as ImageIcon, Pencil, Plus, RefreshCw, Scale, Search, Send, Trash2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CompactEmptyState } from "@/components/compact-empty-state";
import { useCopyText } from "@/hooks/use-copy-text";
import { workStatusToneClass } from "@/lib/work-publication-status";
import {
    deleteWorkPublication,
    listWorkPublications,
    relistWorkPublication,
    revokeWorkPublication,
    submitWorkPublication,
    type WorkPublication,
    type WorkPublicationModerationStatus,
    type WorkPublicationSourceType,
} from "@/services/api/work-publications";
import { submitWorkAppeal } from "@/services/api/work-governance";
import { WorkPublicationEditor } from "./components/work-publication-editor";
import { formatWorkTime, SOURCE_TYPE_LABELS, VISIBILITY_LABELS, workSharePath, workStatusLabel, WORK_STATUS_OPTIONS } from "./work-publication-values";

const PAGE_SIZE = 10;

export default function WorksPage() {
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const searchParams = useSearchParams();
    const initialSource = useMemo(() => parseInitialSource(searchParams.get("sourceType"), searchParams.get("sourceId")), [searchParams]);
    const autoOpenedRef = useRef(false);
    const requestIdRef = useRef(0);
    const [items, setItems] = useState<WorkPublication[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [status, setStatus] = useState<WorkPublicationModerationStatus | "all">("all");
    const [keyword, setKeyword] = useState("");
    const [debouncedKeyword, setDebouncedKeyword] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [actionId, setActionId] = useState("");
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingWorkId, setEditingWorkId] = useState<string>();
    const [appealWork, setAppealWork] = useState<WorkPublication>();
    const [appealDescription, setAppealDescription] = useState("");

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    const load = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setError("");
        try {
            const result = await listWorkPublications({ page, pageSize: PAGE_SIZE, status: status === "all" ? undefined : status, keyword: debouncedKeyword || undefined });
            if (requestId !== requestIdRef.current) return;
            setItems(result.items);
            setTotal(result.total);
        } catch (loadError) {
            if (requestId !== requestIdRef.current) return;
            setItems([]);
            setTotal(0);
            setError(loadError instanceof Error ? loadError.message : "作品列表加载失败");
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [debouncedKeyword, page, status]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (!initialSource || autoOpenedRef.current) return;
        autoOpenedRef.current = true;
        setEditingWorkId(undefined);
        setEditorOpen(true);
    }, [initialSource]);

    const openCreate = () => {
        setEditingWorkId(undefined);
        setEditorOpen(true);
    };

    const submit = async (work: WorkPublication) => {
        setActionId(work.id);
        try {
            await submitWorkPublication(work.id);
            message.success("作品已提交审核");
            await load();
        } catch (submitError) {
            message.error(submitError instanceof Error ? submitError.message : "提交审核失败");
        } finally {
            setActionId("");
        }
    };

    const takeDown = (work: WorkPublication) => {
        modal.confirm({
            title: "下架这个作品？",
            content: "下架后公开链接和媒体将立即不可访问；需要彻底移除时，可在下架后继续删除作品。",
            okText: "确认下架",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                setActionId(work.id);
                try {
                    await revokeWorkPublication(work.id);
                    message.success("作品已下架");
                    await load();
                } catch (takeDownError) {
                    message.error(takeDownError instanceof Error ? takeDownError.message : "下架失败");
                    throw takeDownError;
                } finally {
                    setActionId("");
                }
            },
        });
    };

    const relist = (work: WorkPublication) => {
        modal.confirm({
            title: "重新上架这个作品？",
            content: "将恢复最近一次已审核通过的公开版本，作品链接和广场展示会重新生效。",
            okText: "确认上架",
            cancelText: "取消",
            onOk: async () => {
                setActionId(work.id);
                try {
                    await relistWorkPublication(work.id);
                    message.success("作品已重新上架");
                    await load();
                } catch (relistError) {
                    message.error(relistError instanceof Error ? relistError.message : "重新上架失败");
                    throw relistError;
                } finally {
                    setActionId("");
                }
            },
        });
    };

    const remove = (work: WorkPublication) => {
        modal.confirm({
            title: "永久删除这个作品？",
            content: "作品发布记录、全部版本快照和互动记录会被永久删除，原始素材、画布或短剧项目不会删除。此操作无法撤销。",
            okText: "永久删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                setActionId(work.id);
                try {
                    await deleteWorkPublication(work.id);
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

    const appeal = async () => {
        const work = appealWork;
        const version = work?.currentVersion;
        if (!work || !version) return;
        if (appealDescription.trim().length < 5) return message.warning("请至少填写 5 个字的申诉说明");
        setActionId(work.id);
        try {
            await submitWorkAppeal(work.id, { versionId: version.id, description: appealDescription.trim() });
            message.success("申诉已提交，平台会尽快复核");
            setAppealWork(undefined);
            setAppealDescription("");
        } catch (appealError) {
            message.error(appealError instanceof Error ? appealError.message : "提交申诉失败");
        } finally {
            setActionId("");
        }
    };

    return (
        <main className="h-full min-h-0 overflow-y-auto bg-background text-foreground">
            <div className="mx-auto w-full max-w-7xl px-2 py-2 sm:px-6 sm:py-8">
                <header className="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between sm:gap-5 sm:pb-6">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <GalleryVerticalEnd className="size-4" />
                            发布中心
                        </div>
                        <h1 className="mt-1.5 text-xl font-semibold sm:mt-2 sm:text-2xl">作品管理</h1>
                        <p className="mt-1.5 text-xs leading-5 text-muted-foreground sm:mt-2 sm:text-sm">管理草稿、审核状态和当前公开版本</p>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                        <Button className="!size-9 !p-0 sm:!size-auto sm:!h-8 sm:!px-3" href="/community" icon={<Compass className="size-4" />} aria-label="浏览作品广场">
                            <span className="hidden sm:inline">作品广场</span>
                        </Button>
                        <Button className="!size-9 !p-0 sm:!size-auto sm:!h-8 sm:!px-3" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()} aria-label="刷新作品列表" />
                        <Button className="!h-9 !px-3 sm:!h-8" type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                            发布作品
                        </Button>
                    </div>
                </header>

                <section className="flex min-w-0 flex-row items-center gap-2 border-b border-border py-3 sm:justify-between sm:gap-3 sm:py-4">
                    <div className="hidden shrink-0 sm:block">
                        <Segmented
                            value={status}
                            options={WORK_STATUS_OPTIONS}
                            onChange={(value) => {
                                setStatus(value as typeof status);
                                setPage(1);
                            }}
                        />
                    </div>
                    <div className="w-28 shrink-0 sm:hidden">
                        <Select
                            className="w-full"
                            value={status}
                            options={WORK_STATUS_OPTIONS}
                            onChange={(value) => {
                                setStatus(value);
                                setPage(1);
                            }}
                        />
                    </div>
                    <Input
                        className="min-w-0 flex-1 sm:max-w-sm"
                        allowClear
                        prefix={<Search className="size-4 text-stone-400" />}
                        placeholder="搜索标题或作品链接"
                        value={keyword}
                        onChange={(event) => {
                            setKeyword(event.target.value);
                            setPage(1);
                        }}
                    />
                </section>

                {error ? (
                    <section className="mt-4 flex min-h-40 flex-col items-center justify-center gap-3 border-y border-rose-200 px-4 text-center dark:border-rose-900/70">
                        <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>
                            重新加载
                        </Button>
                    </section>
                ) : loading && !items.length ? (
                    <section className="grid min-h-40 place-items-center text-sm text-muted-foreground">正在加载作品...</section>
                ) : items.length ? (
                    <section className="grid min-w-0 gap-2 py-3 sm:gap-3 sm:py-5">
                        {items.map((work) => (
                            <WorkListItem
                                key={work.id}
                                work={work}
                                busy={actionId === work.id}
                                onEdit={() => {
                                    setEditingWorkId(work.id);
                                    setEditorOpen(true);
                                }}
                                onSubmit={() => void submit(work)}
                                onTakeDown={() => takeDown(work)}
                                onRelist={() => relist(work)}
                                onDelete={() => remove(work)}
                                onCopy={() => copyText(new URL(workSharePath(work.slug), window.location.origin).toString(), "作品链接已复制")}
                                onPreview={() => window.open(workSharePath(work.slug), "_blank", "noopener,noreferrer")}
                                onAppeal={() => {
                                    setAppealDescription("");
                                    setAppealWork(work);
                                }}
                            />
                        ))}
                    </section>
                ) : (
                    <CompactEmptyState
                        className="mt-3 min-h-44 sm:mt-6 sm:min-h-64"
                        icon={<GalleryVerticalEnd className="size-4" />}
                        title={keyword || status !== "all" ? "没有匹配的作品" : "还没有发布作品"}
                        description={keyword || status !== "all" ? "调整筛选条件后再试一次。" : "从素材、画布或短剧项目创建第一个可审核版本。"}
                        action={
                            <Button className="!h-9 !px-3" type="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                                发布第一个作品
                            </Button>
                        }
                    />
                )}

                {total > PAGE_SIZE ? <Pagination className="pb-6 pt-2" current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} size="small" onChange={setPage} /> : null}
            </div>

            <WorkPublicationEditor
                open={editorOpen}
                workId={editingWorkId}
                initialSource={editingWorkId ? undefined : initialSource}
                onCancel={() => setEditorOpen(false)}
                onSaved={() => {
                    setEditorOpen(false);
                    void load();
                }}
            />
            <Modal
                title="申诉恢复作品"
                open={Boolean(appealWork)}
                okText="提交申诉"
                cancelText="取消"
                confirmLoading={Boolean(appealWork && actionId === appealWork.id)}
                okButtonProps={{ disabled: appealDescription.trim().length < 5 }}
                onOk={() => void appeal()}
                onCancel={() => !actionId && setAppealWork(undefined)}
            >
                <p className="mb-3 text-sm leading-6 text-muted-foreground">请说明下架判断需要复核的原因和可验证信息。申诉通过后，仅在没有其他线上版本时恢复该版本。</p>
                <Input.TextArea value={appealDescription} rows={5} maxLength={1000} showCount placeholder="例如：作品使用的素材均为本人原创，可提供创作记录进行核验" onChange={(event) => setAppealDescription(event.target.value)} />
            </Modal>
        </main>
    );
}

function WorkListItem({
    work,
    busy,
    onEdit,
    onSubmit,
    onTakeDown,
    onRelist,
    onDelete,
    onCopy,
    onPreview,
    onAppeal,
}: {
    work: WorkPublication;
    busy: boolean;
    onEdit: () => void;
    onSubmit: () => void;
    onTakeDown: () => void;
    onRelist: () => void;
    onDelete: () => void;
    onCopy: () => void;
    onPreview: () => void;
    onAppeal: () => void;
}) {
    const version = work.currentVersion;
    if (!version) return null;
    const active = work.lifecycleStatus === "active";
    const canSubmit = active && (version.moderationStatus === "draft" || version.moderationStatus === "rejected");
    const canEdit = active && version.moderationStatus !== "pending";
    const shareable = active && Boolean(work.publishedVersionId) && work.publishedVersion?.visibility !== "private";
    const sourceIcon = work.sourceType === "media" ? <ImageIcon className="size-4" /> : work.sourceType === "canvas" ? <GalleryVerticalEnd className="size-4" /> : <Film className="size-4" />;
    return (
        <article className="min-w-0 rounded-lg border border-border bg-card p-3.5 text-card-foreground transition hover:border-foreground/20 sm:p-4">
            <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground">{sourceIcon}</span>
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <h2 className="min-w-0 max-w-full truncate text-sm font-semibold">{version.title}</h2>
                            <span className={`inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium leading-none ${workStatusToneClass(active ? version.moderationStatus : "revoked")}`}>
                                {active ? workStatusLabel(version.moderationStatus) : "已下架"}
                            </span>
                            {work.publishedVersion && work.publishedVersion.id !== version.id ? <Tag color="success">线上 v{work.publishedVersion.versionNumber}</Tag> : null}
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground">{version.description || "暂未填写作品说明"}</p>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>{SOURCE_TYPE_LABELS[work.sourceType]}来源</span>
                            <span>v{version.versionNumber}</span>
                            <span>{VISIBILITY_LABELS[version.visibility]}</span>
                            <span>{work.viewCount} 次访问</span>
                            <span>更新于 {formatWorkTime(work.updatedAt)}</span>
                        </div>
                        {version.rejectionReason ? <div className="mt-1.5 border-l-2 border-rose-400 pl-2 text-xs leading-5 text-rose-700 dark:text-rose-300">驳回原因：{version.rejectionReason}</div> : null}
                    </div>
                </div>
                <div className="flex min-w-0 flex-wrap gap-1.5 border-t border-border pt-3 md:max-w-md md:shrink-0 md:justify-end md:border-t-0 md:pt-0">
                    {shareable ? (
                        <>
                            <Button size="small" icon={<Eye className="size-3.5" />} onClick={onPreview}>
                                预览
                            </Button>
                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopy}>
                                复制链接
                            </Button>
                        </>
                    ) : null}
                    {canEdit ? (
                        <Button size="small" icon={<Pencil className="size-3.5" />} onClick={onEdit} disabled={busy}>
                            {version.moderationStatus === "approved" ? "创建新版本" : "编辑"}
                        </Button>
                    ) : null}
                    {active && version.moderationStatus === "taken_down" ? (
                        <Button size="small" icon={<Scale className="size-3.5" />} onClick={onAppeal} disabled={busy}>
                            提交申诉
                        </Button>
                    ) : null}
                    {canSubmit ? (
                        <Button size="small" type="primary" icon={<Send className="size-3.5" />} onClick={onSubmit} loading={busy}>
                            提交审核
                        </Button>
                    ) : null}
                    {active && work.publishedVersionId ? (
                        <Button size="small" danger icon={<Ban className="size-3.5" />} onClick={onTakeDown} disabled={busy}>
                            下架
                        </Button>
                    ) : null}
                    {!active ? (
                        <>
                            <Button size="small" type="primary" icon={<ArrowUpFromLine className="size-3.5" />} onClick={onRelist} loading={busy}>
                                上架
                            </Button>
                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} disabled={busy}>
                                删除
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>
        </article>
    );
}

function parseInitialSource(sourceType: string | null, sourceId: string | null) {
    if ((sourceType === "media" || sourceType === "canvas" || sourceType === "drama") && sourceId) return { sourceType: sourceType as WorkPublicationSourceType, sourceId };
    return undefined;
}
