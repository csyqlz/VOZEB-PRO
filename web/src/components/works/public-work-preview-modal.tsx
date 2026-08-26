"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Modal, Tooltip } from "antd";
import { CalendarDays, Copy, Eye, ImagePlus, LoaderCircle, Share2, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";

import { getPublicWorkPublication, recordPublicWorkPublicationView, type PublicWorkPublication } from "@/services/api/work-publications";
import { createAgentPromptHref } from "@/lib/create-agent-prompt";
import { userAvatarFallback } from "@/lib/user-avatar";
import { PublicWorkCommunityActions } from "./public-work-community-actions";
import { PublicWorkMediaBrowser } from "./public-work-media-browser";
import { PublicWorkReportButton } from "./public-work-report-button";

export function PublicWorkPreviewModal({
    slug,
    onClose,
    onOpenCreator,
    onUsePrompt,
    onUseImage,
    imageImporting = false,
}: {
    slug?: string;
    onClose: () => void;
    onOpenCreator?: (username: string) => void;
    onUsePrompt?: (prompt: string) => void;
    onUseImage?: () => void | Promise<void>;
    imageImporting?: boolean;
}) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const viewedSlugs = useRef(new Set<string>());
    const query = useQuery({
        queryKey: ["public-work", slug],
        queryFn: () => getPublicWorkPublication(slug!),
        enabled: Boolean(slug),
        staleTime: 30_000,
    });
    const work = query.data;

    useEffect(() => {
        if (!slug || viewedSlugs.current.has(slug)) return;
        viewedSlugs.current.add(slug);
        void recordPublicWorkPublicationView(slug)
            .then((viewCount) => queryClient.setQueryData<PublicWorkPublication>(["public-work", slug], (current) => (current ? { ...current, viewCount } : current)))
            .catch(() => undefined);
    }, [queryClient, slug]);

    const copyPrompt = async () => {
        if (!work?.publicPrompt) return;
        try {
            await navigator.clipboard.writeText(work.publicPrompt);
            message.success("提示词已复制");
        } catch {
            message.error("复制失败，请手动选择提示词");
        }
    };

    const share = async () => {
        if (!work) return;
        const url = new URL(`/share/${encodeURIComponent(work.slug)}`, window.location.origin).toString();
        try {
            await navigator.clipboard.writeText(url);
            message.success("分享链接已复制");
        } catch {
            message.error("分享链接复制失败");
        }
    };

    const contentAssets = useMemo(() => work?.assets.filter((asset) => asset.role === "content" && (asset.mediaType === "image" || asset.mediaType === "video")).sort((left, right) => left.sortOrder - right.sortOrder) || [], [work]);
    const remixHref = createAgentPromptHref(work?.publicPrompt || "");
    const authorUsername = work?.authorUsername;
    const authorIdentity = work ? (
        <>
            <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-foreground text-[11px] font-semibold text-background" aria-hidden="true">
                {work.authorAvatarUrl ? <img src={work.authorAvatarUrl} alt="" className="size-full object-cover" /> : userAvatarFallback(work.authorName || "匿名作者")}
            </span>
            <span className="flex h-8 min-w-0 flex-1 items-center truncate text-sm font-semibold leading-none">{work.authorName || "匿名作者"}</span>
        </>
    ) : null;

    return (
        <Modal centered open={Boolean(slug)} width="min(1280px, calc(100vw - 16px))" footer={null} closable={false} destroyOnHidden title={null} onCancel={onClose} styles={{ container: { padding: 0, overflow: "hidden" }, body: { padding: 0 } }}>
            <div className="max-h-[92dvh] min-w-0 overflow-y-auto bg-background text-foreground lg:h-[min(82dvh,780px)] lg:overflow-hidden">
                {query.isLoading ? (
                    <div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin" /> 正在加载作品
                    </div>
                ) : query.error || !work ? (
                    <div className="grid min-h-[360px] place-items-center px-5 text-center">
                        <div>
                            <p className="text-sm font-semibold">作品暂时无法打开</p>
                            <p className="mt-2 text-xs text-muted-foreground">{query.error instanceof Error ? query.error.message : "作品不存在或已停止公开"}</p>
                            <Button className="mt-4" onClick={() => void query.refetch()}>
                                重新加载
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="grid min-w-0 lg:h-full lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
                        <div className="min-w-0 border-b border-border bg-muted/20 p-2.5 sm:p-3 lg:h-full lg:border-b-0 lg:border-r">
                            <PublicWorkMediaBrowser assets={contentAssets} title={work.title} compact />
                        </div>
                        <aside className="min-w-0 p-3.5 sm:p-4 lg:h-full lg:overflow-y-auto" aria-label="作品详情">
                            <header className="border-b border-border pb-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    {authorUsername && onOpenCreator ? (
                                        <button
                                            type="button"
                                            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            aria-label={`查看 ${work.authorName || authorUsername} 的主页`}
                                            aria-haspopup="dialog"
                                            onClick={() => {
                                                onClose();
                                                onOpenCreator(authorUsername);
                                            }}
                                        >
                                            {authorIdentity}
                                        </button>
                                    ) : authorUsername ? (
                                        <Link
                                            href={`/u/${encodeURIComponent(authorUsername)}`}
                                            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={onClose}
                                        >
                                            {authorIdentity}
                                        </Link>
                                    ) : (
                                        <div className="flex min-w-0 flex-1 items-center gap-2.5">{authorIdentity}</div>
                                    )}
                                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                                        <span className="inline-flex h-7 items-center gap-1 px-1 text-[11px] text-muted-foreground" aria-label="作品浏览量" title="浏览量">
                                            <Eye className="size-3.5" /> <span className="tabular-nums">{work.viewCount}</span>
                                        </span>
                                        <PublicWorkCommunityActions slug={work.slug} compact compactFollowIcon className="flex-nowrap !gap-0.5" />
                                        <Tooltip title="分享作品">
                                            <Button type="text" size="small" shape="circle" icon={<Share2 className="size-3.5" />} onClick={() => void share()} aria-label="分享作品" />
                                        </Tooltip>
                                        <Button type="text" size="small" shape="circle" className="!-mr-1" icon={<X className="size-4" />} onClick={onClose} aria-label="关闭作品详情" title="关闭" />
                                    </div>
                                </div>

                                <h2 className="mt-3.5 break-words text-lg font-semibold leading-7">{work.title}</h2>
                                <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                                    <span className="inline-flex shrink-0 items-center gap-1" title="发布时间">
                                        <CalendarDays className="size-3" /> {formatDate(work.publishedAt)}
                                    </span>
                                    <span className="min-w-0 truncate">
                                        {sourceTypeLabel(work.sourceType)} · {work.category}
                                    </span>
                                    <span>{work.visibility === "public" ? "公开作品" : "仅链接分享"}</span>
                                    <div className="ml-auto shrink-0">
                                        <PublicWorkReportButton slug={work.slug} compact />
                                    </div>
                                </div>
                            </header>

                            {work.description ? (
                                <section className="mt-3.5">
                                    <h3 className="text-xs font-semibold">作品说明</h3>
                                    <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">{work.description}</p>
                                </section>
                            ) : null}

                            <section className="mt-3.5">
                                <h3 className="text-xs font-semibold">作品提示词</h3>
                                <pre className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2.5 font-sans text-[13px] leading-5 text-foreground">{work.publicPrompt || "该作品暂无可公开提示词。"}</pre>
                                {work.publicPrompt ? (
                                    <div className="mt-2.5">
                                        <div className="flex justify-end gap-1">
                                            <Tooltip title="复制提示词">
                                                <Button size="small" shape="circle" icon={<Copy className="size-3.5" />} onClick={() => void copyPrompt()} aria-label="复制提示词" />
                                            </Tooltip>
                                            {onUseImage && contentAssets.some((asset) => asset.mediaType === "image") ? (
                                                <Tooltip title="引用图片到智能创作">
                                                    <Button
                                                        size="small"
                                                        shape="circle"
                                                        icon={imageImporting ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
                                                        disabled={imageImporting}
                                                        onClick={() => void onUseImage()}
                                                        aria-label="引用图片到智能创作"
                                                    />
                                                </Tooltip>
                                            ) : null}
                                            {onUsePrompt ? (
                                                <Tooltip title="引用提示词到智能创作">
                                                    <Button
                                                        type="primary"
                                                        size="small"
                                                        shape="circle"
                                                        icon={<Sparkles className="size-3.5" />}
                                                        aria-label="引用提示词到智能创作"
                                                        onClick={() => {
                                                            onUsePrompt(work.publicPrompt);
                                                            onClose();
                                                        }}
                                                    />
                                                </Tooltip>
                                            ) : null}
                                        </div>
                                        {!onUsePrompt ? (
                                            <Link href={remixHref} className="mt-3 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-md !bg-foreground px-4 text-sm font-semibold !text-background transition hover:opacity-80">
                                                <Sparkles className="size-4" /> 做同款
                                            </Link>
                                        ) : null}
                                    </div>
                                ) : null}
                            </section>

                            {work.tags.length ? (
                                <div className="mt-4 flex min-w-0 flex-wrap gap-1">
                                    {work.tags.map((tag) => (
                                        <span key={tag} className="max-w-36 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                            #{tag}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                        </aside>
                    </div>
                )}
            </div>
        </Modal>
    );
}

function sourceTypeLabel(sourceType: PublicWorkPublication["sourceType"]) {
    return sourceType === "media" ? "素材作品" : sourceType === "canvas" ? "画布作品" : "短剧作品";
}

function formatDate(value: string) {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}
