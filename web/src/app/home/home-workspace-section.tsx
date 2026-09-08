"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Film, Layers, MessageSquare, Plus, Sparkles } from "lucide-react";

import { useHomeActions } from "./home-actions";

type WorkspaceConversation = { id: string; title: string; updatedAt?: string };
type WorkspaceCanvas = { id: string; title: string; nodeCount?: number; updatedAt?: string };
type WorkspaceDrama = { id: string; title: string; episodeCount?: number; shotCount?: number; updatedAt?: string };

export function HomeWorkspaceSection() {
    const { authenticated, sessionReady, openProtectedPath } = useHomeActions();
    const [conversations, setConversations] = useState<WorkspaceConversation[]>([]);
    const [canvases, setCanvases] = useState<WorkspaceCanvas[]>([]);
    const [dramas, setDramas] = useState<WorkspaceDrama[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!sessionReady || !authenticated) return;
        let active = true;
        setLoading(true);
        void Promise.allSettled([
            fetch("/api/creative/conversations?page=1&pageSize=4", { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .catch(() => null),
            fetch("/api/canvas/projects", { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .catch(() => null),
            fetch("/api/drama/projects?page=1&pageSize=4", { cache: "no-store" })
                .then((response) => (response.ok ? response.json() : null))
                .catch(() => null),
        ]).then(([conversationResult, canvasResult, dramaResult]) => {
            if (!active) return;
            if (conversationResult.status === "fulfilled" && conversationResult.value?.data?.conversations) setConversations(conversationResult.value.data.conversations.slice(0, 4));
            if (canvasResult.status === "fulfilled" && canvasResult.value?.data?.projects) setCanvases(canvasResult.value.data.projects.slice(0, 4));
            if (dramaResult.status === "fulfilled" && dramaResult.value?.data?.projects) setDramas(dramaResult.value.data.projects.slice(0, 4));
            setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [authenticated, sessionReady]);

    if (!sessionReady || !authenticated) return null;

    const go = (path: string) => openProtectedPath(path);

    return (
        <section className="home-workspace mx-auto w-full max-w-[1120px] px-4 pb-10 pt-2 sm:px-8" aria-labelledby="home-workspace-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 id="home-workspace-title" className="text-lg font-semibold text-[#20242a] dark:text-[#f3f5f7]">
                        我的工作台
                    </h2>
                    <p className="mt-1 text-xs text-[#697381] dark:text-[#9aa3af]">最近的创作会话、画布与短剧项目，点击直接继续。</p>
                </div>
                <div className="flex items-center gap-2">
                    <button type="button" onClick={() => go("/drama")} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e4e7ec] bg-white px-2.5 text-xs font-medium !text-[#344054] transition hover:border-[#d0d5dd] hover:bg-[#f8f9fb] dark:border-[#343a43] dark:bg-[#181b20] dark:!text-[#aab2bc] dark:hover:bg-[#22262c]">
                        <Film className="size-3.5" /> 新建短剧
                    </button>
                    <button type="button" onClick={() => go("/canvas")} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e4e7ec] bg-white px-2.5 text-xs font-medium !text-[#344054] transition hover:border-[#d0d5dd] hover:bg-[#f8f9fb] dark:border-[#343a43] dark:bg-[#181b20] dark:!text-[#aab2bc] dark:hover:bg-[#22262c]">
                        <Layers className="size-3.5" /> 新建画布
                    </button>
                    <button type="button" onClick={() => go("/create")} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#e4e7ec] bg-white px-2.5 text-xs font-medium !text-[#344054] transition hover:border-[#d0d5dd] hover:bg-[#f8f9fb] dark:border-[#343a43] dark:bg-[#181b20] dark:!text-[#aab2bc] dark:hover:bg-[#22262c]">
                        <Sparkles className="size-3.5" /> 去创作页
                    </button>
                </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
                <WorkspaceCard title="最近创作" icon={<MessageSquare className="size-3.5" />} loading={loading} emptyText="还没有创作会话，输入框写下想法即可开始" emptyAction={{ label: "开始创作", onClick: () => go("/create") }}>
                    {conversations.map((item) => (
                        <button key={item.id} type="button" onClick={() => go(`/create?conversation=${encodeURIComponent(item.id)}`)} className="group flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:border-[#e4e7ec] hover:bg-white dark:hover:border-[#343a43] dark:hover:bg-[#181b20]">
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-[#20242a] dark:text-[#f3f5f7]">{item.title || "未命名创作"}</span>
                            </span>
                            <ArrowUpRight className="size-3.5 shrink-0 text-[#9aa2ad] opacity-0 transition group-hover:opacity-100" />
                        </button>
                    ))}
                </WorkspaceCard>

                <WorkspaceCard title="画布项目" icon={<Layers className="size-3.5" />} loading={loading} emptyText="画布适合多图排版、参考连线与局部重绘" emptyAction={{ label: "新建画布", onClick: () => go("/canvas") }}>
                    {canvases.map((item) => (
                        <button key={item.id} type="button" onClick={() => go(`/canvas/${item.id}`)} className="group flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:border-[#e4e7ec] hover:bg-white dark:hover:border-[#343a43] dark:hover:bg-[#181b20]">
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-[#20242a] dark:text-[#f3f5f7]">{item.title || "未命名画布"}</span>
                                <span className="mt-0.5 block text-[11px] text-[#9aa2ad]">{item.nodeCount ?? 0} 个节点</span>
                            </span>
                            <ArrowUpRight className="size-3.5 shrink-0 text-[#9aa2ad] opacity-0 transition group-hover:opacity-100" />
                        </button>
                    ))}
                </WorkspaceCard>

                <WorkspaceCard title="短剧项目" icon={<Film className="size-3.5" />} loading={loading} emptyText="从小说或剧本开始，AI 改编、分镜、出片一站完成" emptyAction={{ label: "新建短剧", onClick: () => go("/drama") }}>
                    {dramas.map((item) => (
                        <button key={item.id} type="button" onClick={() => go(`/drama/${item.id}`)} className="group flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:border-[#e4e7ec] hover:bg-white dark:hover:border-[#343a43] dark:hover:bg-[#181b20]">
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-[#20242a] dark:text-[#f3f5f7]">{item.title || "未命名短剧"}</span>
                                <span className="mt-0.5 block text-[11px] text-[#9aa2ad]">
                                    {item.episodeCount ?? 0} 集 · {item.shotCount ?? 0} 镜头
                                </span>
                            </span>
                            <ArrowUpRight className="size-3.5 shrink-0 text-[#9aa2ad] opacity-0 transition group-hover:opacity-100" />
                        </button>
                    ))}
                </WorkspaceCard>
            </div>
        </section>
    );
}

function WorkspaceCard({ title, icon, loading, emptyText, emptyAction, children }: { title: string; icon: React.ReactNode; loading: boolean; emptyText: string; emptyAction?: { label: string; onClick: () => void }; children: React.ReactNode }) {
    const hasItems = Boolean(children && Array.isArray(children) && children.length > 0);
    return (
        <div className="rounded-xl border border-[#e2e7eb] bg-white/70 p-3 dark:border-[#2b3037] dark:bg-[#181b20]/60">
            <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-semibold text-[#343b44] dark:text-[#dce1e7]">
                <span className="text-[#7c8694] dark:text-[#8b95a1]">{icon}</span>
                {title}
            </div>
            {loading ? (
                <div className="space-y-2 px-1 py-2">
                    {[0, 1, 2].map((index) => (
                        <div key={index} className="h-8 animate-pulse rounded-lg bg-[#eef1f4] dark:bg-[#252a31]" />
                    ))}
                </div>
            ) : hasItems ? (
                <div className="space-y-0.5">{children}</div>
            ) : (
                <div className="px-2.5 py-4 text-center">
                    <p className="text-xs leading-5 text-[#9aa2ad]">{emptyText}</p>
                    {emptyAction ? (
                        <button type="button" onClick={emptyAction.onClick} className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-[#e4e7ec] bg-white px-2 text-[11px] font-medium !text-[#344054] transition hover:bg-[#f8f9fb] dark:border-[#343a43] dark:bg-[#22262c] dark:!text-[#aab2bc] dark:hover:bg-[#2b3037]">
                            <Plus className="size-3" /> {emptyAction.label}
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}
