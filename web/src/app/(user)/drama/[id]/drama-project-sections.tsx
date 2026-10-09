"use client";

import { useEffect, useState } from "react";
import { Alert, App, Button, Drawer, Input, Popover, Steps, Tooltip } from "antd";
import { ArrowLeft, Bot, Boxes, ChevronDown, ChevronRight, History, PanelLeft, Plus, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import type { DramaEpisode, DramaProject } from "../types";
import { useDramaStore } from "../stores/use-drama-store";
import { DramaScriptWorkspace } from "./drama-script-workspace";
import { DramaEpisodeSettings } from "./drama-episode-settings";
import { DramaStageHeader } from "./drama-editor-elements";
import { DramaSourceImport } from "./drama-source-import";

export type DramaProjectStage = "script" | "review" | "storyboard" | "generate";

const stages = [
    { value: "script", label: "剧本", shortLabel: "剧本" },
    { value: "review", label: "内容审核", shortLabel: "审核" },
    { value: "storyboard", label: "分镜", shortLabel: "分镜" },
    { value: "generate", label: "镜头生成", shortLabel: "生成" },
] as const;

function usePermanentDramaPanels() {
    const [permanent, setPermanent] = useState(false);
    useEffect(() => {
        const media = window.matchMedia("(min-width: 1366px)");
        const update = () => setPermanent(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    return permanent;
}

function DramaEpisodePanel({ project, episode, permanent, onOpenChange, onStageChange }: { project: DramaProject; episode: DramaEpisode; permanent: boolean; onOpenChange: (open: boolean) => void; onStageChange: (stage: DramaProjectStage) => void }) {
    const { modal } = App.useApp();
    const addEpisode = useDramaStore((state) => state.addEpisode);
    const deleteEpisode = useDramaStore((state) => state.deleteEpisode);
    const selectEpisode = useDramaStore((state) => state.selectEpisode);
    const [query, setQuery] = useState("");

    const confirmDelete = (episodeId: string) => {
        const removing = project.episodes.find((item) => item.id === episodeId);
        if (!removing) return;
        modal.confirm({
            title: `删除${removing.title}？`,
            content: "本集剧本、分镜和任务记录会一起删除。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => deleteEpisode(project.id, removing.id),
        });
    };

    const filteredEpisodes = project.episodes.filter((item, index) => `${item.episodeNumber || index + 1} ${item.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return (
        <div className="flex h-full min-h-0 flex-col bg-card" data-drama-episode-panel>
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3.5">
                <div className="flex min-w-0 items-center gap-2">
                    <div className="text-sm font-semibold">剧集</div>
                    <span className="text-xs tabular-nums text-muted-foreground">{project.episodes.length}</span>
                </div>
                <div className="flex items-center gap-1">
                    <Tooltip title="添加剧集">
                        <Button
                            type="text"
                            shape="circle"
                            className="!size-8 !min-w-8"
                            icon={<Plus className="size-4" />}
                            onClick={() => {
                                addEpisode(project.id);
                                onStageChange("script");
                            }}
                            aria-label="添加剧集"
                        />
                    </Tooltip>
                    {!permanent ? (
                        <Tooltip title="收起集数管理">
                            <Button type="text" shape="circle" className="!size-8 !min-w-8" icon={<X className="size-4" />} onClick={() => onOpenChange(false)} aria-label="收起集数管理" />
                        </Tooltip>
                    ) : null}
                </div>
            </div>
            <div className="shrink-0 px-2.5 pt-2.5">
                <Input className="!h-8" allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索剧集" aria-label="搜索集数" />
            </div>
            <nav className="hide-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5" aria-label="短剧剧集导航">
                {filteredEpisodes.map((item) => {
                    const index = project.episodes.findIndex((episodeItem) => episodeItem.id === item.id);
                    const active = item.id === episode.id;
                    const progress = episodeProgressLabel(item);
                    return (
                        <div
                            key={item.id}
                            className={`group flex min-w-0 items-center rounded-md border transition ${active ? "border-violet-300 bg-violet-50/70 dark:border-violet-700/70 dark:bg-violet-950/25" : "border-transparent bg-transparent hover:border-border hover:bg-muted/60"}`}
                        >
                            <button
                                type="button"
                                className="flex min-h-14 min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                                onClick={() => {
                                    selectEpisode(project.id, item.id);
                                    if (!permanent) onOpenChange(false);
                                }}
                                aria-current={active ? "page" : undefined}
                                aria-label={`打开${item.title}`}
                            >
                                <span
                                    className={`grid size-8 shrink-0 place-items-center rounded text-[11px] font-semibold tabular-nums ${active ? "bg-violet-100 text-violet-700 dark:bg-violet-900/45 dark:text-violet-300" : "border border-border bg-background text-muted-foreground"}`}
                                >
                                    {String(item.episodeNumber || index + 1).padStart(2, "0")}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                                        {item.script.length} 字 · {item.shots.length} 场 · {progress}
                                    </span>
                                </span>
                            </button>
                            {project.episodes.length > 1 ? (
                                <Tooltip title={`删除${item.title}`}>
                                    <Button
                                        type="text"
                                        shape="circle"
                                        className="!mr-1 !size-8 !min-w-8 !text-muted-foreground opacity-60 transition hover:!bg-rose-50 hover:!text-rose-600 group-hover:opacity-100 focus:opacity-100 dark:hover:!bg-rose-950/30 dark:hover:!text-rose-300"
                                        icon={<Trash2 className="size-3.5" />}
                                        onClick={() => confirmDelete(item.id)}
                                        aria-label={`删除${item.title}`}
                                    />
                                </Tooltip>
                            ) : null}
                        </div>
                    );
                })}
            </nav>
            <div className="shrink-0 border-t border-border p-2.5">
                <Button
                    block
                    type="text"
                    icon={<Plus className="size-4" />}
                    onClick={() => {
                        addEpisode(project.id);
                        onStageChange("script");
                    }}
                >
                    新建集数
                </Button>
            </div>
        </div>
    );
}

export function DramaEpisodeSidebar({ project, episode, open, onOpenChange, onStageChange }: { project: DramaProject; episode: DramaEpisode; open: boolean; onOpenChange: (open: boolean) => void; onStageChange: (stage: DramaProjectStage) => void }) {
    if (!open) return null;
    return (
        <aside className="hidden h-full min-h-0 w-[190px] shrink-0 border-r border-border min-[1366px]:block" aria-label="集数管理侧栏" data-drama-episode-sidebar>
            <DramaEpisodePanel project={project} episode={episode} permanent onOpenChange={onOpenChange} onStageChange={onStageChange} />
        </aside>
    );
}

export function DramaEpisodeNavigator({ project, episode, open, onOpenChange, onStageChange }: { project: DramaProject; episode: DramaEpisode; open: boolean; onOpenChange: (open: boolean) => void; onStageChange: (stage: DramaProjectStage) => void }) {
    const permanent = usePermanentDramaPanels();

    const episodeIndex = Math.max(
        0,
        project.episodes.findIndex((item) => item.id === episode.id),
    );
    const episodeNumber = episode.episodeNumber || episodeIndex + 1;
    const trigger = (
        <button
            type="button"
            className="mt-0.5 flex max-w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition hover:text-foreground"
            onClick={() => onOpenChange(!open)}
            aria-expanded={open}
            aria-label={open ? "收起剧集导航" : "打开剧集导航"}
        >
            <PanelLeft className="size-3.5 shrink-0" />
            <span className="shrink-0 tabular-nums">第 {String(episodeNumber).padStart(2, "0")} 集</span>
            <ChevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
    );

    return (
        <>
            {trigger}
            <Drawer title="集数管理" placement="left" size={300} open={!permanent && open} closable={false} onClose={() => onOpenChange(false)} styles={{ wrapper: { maxWidth: "100vw" }, body: { padding: 0 } }}>
                <DramaEpisodePanel project={project} episode={episode} permanent={false} onOpenChange={onOpenChange} onStageChange={onStageChange} />
            </Drawer>
        </>
    );
}

export function DramaWorkspaceHeader({
    project,
    episode,
    stage,
    assetsOpen,
    episodeNavigatorOpen,
    agentOpen,
    onStageChange,
    onOpenAssets,
    onCloseAssets,
    onEpisodeNavigatorOpenChange,
    onToggleAgent,
    onOpenVersions,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    stage: DramaProjectStage;
    assetsOpen: boolean;
    episodeNavigatorOpen: boolean;
    agentOpen: boolean;
    onStageChange: (stage: DramaProjectStage) => void;
    onOpenAssets: () => void;
    onCloseAssets: () => void;
    onEpisodeNavigatorOpenChange: (open: boolean) => void;
    onToggleAgent: () => void;
    onOpenVersions: () => void;
}) {
    const router = useRouter();
    const updateProject = useDramaStore((state) => state.updateProject);
    const stageStatuses = dramaStageStatuses(project, episode);

    return (
        <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] border-b border-border bg-card/95 min-[1366px]:h-[64px] min-[1366px]:grid-cols-[190px_minmax(0,1fr)_auto]" data-drama-workspace-header>
            <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 px-2.5 py-2 sm:px-4 min-[1366px]:h-full min-[1366px]:border-r min-[1366px]:border-border min-[1366px]:px-4 min-[1366px]:py-0">
                <Tooltip title="返回短剧项目">
                    <Button type="text" shape="circle" className="!size-9 !min-w-9" icon={<ArrowLeft className="size-4" />} onClick={() => router.push("/drama")} aria-label="返回短剧项目" />
                </Tooltip>
                <div className="min-w-0 flex-1">
                    <Input variant="borderless" className="!h-7 !p-0 !text-base !font-semibold sm:!text-lg" value={project.title} onChange={(event) => updateProject(project.id, { title: event.target.value })} aria-label="短剧项目名称" />
                    {assetsOpen ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">项目资产库</div>
                    ) : (
                        <DramaEpisodeNavigator project={project} episode={episode} open={episodeNavigatorOpen} onOpenChange={onEpisodeNavigatorOpenChange} onStageChange={onStageChange} />
                    )}
                </div>
            </div>
            <nav
                className="hide-scrollbar col-span-2 row-start-2 flex min-w-0 items-center justify-start overflow-x-auto border-t border-border/70 px-2 py-1.5 sm:px-4 min-[1366px]:col-span-1 min-[1366px]:col-start-2 min-[1366px]:row-start-1 min-[1366px]:justify-center min-[1366px]:border-t-0 min-[1366px]:px-4 min-[1366px]:py-1.5"
                aria-label="短剧单集生产阶段"
                data-drama-stage-navigation
            >
                {stages.map((item, index) => {
                    const active = !assetsOpen && stage === item.value;
                    return (
                        <div key={item.value} className="flex shrink-0 items-center">
                            <button
                                type="button"
                                onClick={() => onStageChange(item.value)}
                                aria-label={`切换到${item.label}`}
                                aria-current={active ? "step" : undefined}
                                className={`relative flex h-11 min-w-[74px] items-center justify-center gap-2 px-3 text-xs font-medium transition sm:min-w-[96px] ${active ? "bg-violet-50 text-violet-700 after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-violet-600 dark:bg-violet-950/30 dark:text-violet-300 dark:after:bg-violet-400" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
                            >
                                <span
                                    className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] tabular-nums ${active ? "border-violet-500 bg-violet-600 text-white dark:border-violet-400 dark:bg-violet-400 dark:text-violet-950" : "border-border bg-background"}`}
                                >
                                    {index + 1}
                                </span>
                                <span className="block sm:hidden">{item.shortLabel}</span>
                                <span className="hidden sm:block">{item.label}</span>
                                <span className="sr-only">{stageStatuses[item.value]}</span>
                            </button>
                            {index < stages.length - 1 ? <ChevronRight className="size-3.5 text-border" aria-hidden="true" /> : null}
                        </div>
                    );
                })}
            </nav>
            <div className="col-start-2 row-start-1 flex min-w-0 shrink-0 items-center justify-end gap-1 px-2.5 py-2 sm:px-4 min-[1366px]:col-start-3 min-[1366px]:h-full min-[1366px]:py-0">
                <Tooltip title="项目资产">
                    <Button
                        className={`!h-9 !px-2.5 ${assetsOpen ? "!border-foreground !bg-foreground !text-background" : "!border-border !bg-background hover:!border-foreground/25 hover:!bg-muted"}`}
                        icon={<Boxes className="size-4" />}
                        onClick={assetsOpen ? onCloseAssets : onOpenAssets}
                        aria-current={assetsOpen ? "page" : undefined}
                        aria-label="打开项目资产"
                    >
                        <span className="hidden 2xl:inline">项目资产</span>
                    </Button>
                </Tooltip>
                <Tooltip title="项目版本">
                    <Button className="!size-9 !min-w-9 !px-0 sm:!w-auto sm:!px-3" icon={<History className="size-4" />} onClick={onOpenVersions} aria-label="打开项目版本">
                        <span className="hidden sm:inline">版本记录</span>
                    </Button>
                </Tooltip>
                <Tooltip title={agentOpen ? "收起项目 Agent" : "打开项目 Agent"}>
                    <Button
                        className={`!size-9 !min-w-9 !px-0 ${agentOpen ? "!border-violet-300 !bg-violet-50 !text-violet-700 dark:!border-violet-700 dark:!bg-violet-950/35 dark:!text-violet-300" : ""}`}
                        icon={<Bot className="size-4" />}
                        onClick={onToggleAgent}
                        aria-label={agentOpen ? "收起项目 Agent" : "打开项目 Agent"}
                        aria-expanded={agentOpen}
                        data-drama-agent-trigger
                    />
                </Tooltip>
                <div className="min-w-0 overflow-visible">
                    <UserStatusActions />
                </div>
            </div>
        </header>
    );
}

function dramaStageStatuses(_project: DramaProject, episode: DramaEpisode): Record<DramaProjectStage, string> {
    const tasks = episode.shots.flatMap((shot) => [shot.storyboardStatus, shot.generationStatus, shot.audioStatus]);
    return {
        script: !episode.script.trim() ? "待编辑" : episode.shots.length ? "已整理" : "编辑中",
        review: episode.reviewStatus === "approved" || episode.reviewStatus === "visual_ready" ? "已确认" : episode.reviewStatus === "content_review" ? "待确认" : "待审核",
        storyboard: episode.shots.length && episode.shots.every((shot) => shot.storyboardStatus === "success") ? "已完成" : "待生成",
        generate: tasks.some((status) => status === "queued" || status === "running") ? "生成中" : episode.shots.length && episode.shots.every((shot) => shot.generationStatus === "success") ? "已完成" : "待生成",
    };
}

function episodeProgressLabel(episode: DramaEpisode) {
    if (episode.renderTask?.status === "success") return "整集已完成";
    if (episode.renderTask && ["pending", "running"].includes(episode.renderTask.status)) return "正在合成";
    if (episode.shots.some((shot) => shot.generationStatus === "queued" || shot.generationStatus === "running")) return "镜头生成中";
    if (episode.reviewStatus === "visual_ready") return `${episode.shots.length} 个镜头 · 可生成`;
    if (episode.reviewStatus === "approved") return `${episode.shots.length} 个镜头 · 待视觉设计`;
    if (episode.reviewStatus === "content_review") return `${episode.shots.length} 个镜头 · 待审核`;
    return episode.script.trim() ? "剧本待解析" : "尚未填写剧本";
}

export function DramaScriptPanel({
    project,
    episode,
    analyzing,
    lifecycle,
    onAnalyze,
    onStageChange,
    selectedShotId,
    onSelectedShotChange,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    analyzing: boolean;
    lifecycle?: { current: number; description: string; status?: "process" | "error" };
    onAnalyze: () => void;
    onStageChange: (stage: DramaProjectStage) => void;
    selectedShotId?: string;
    onSelectedShotChange: (shotId?: string) => void;
}) {
    const scriptText = episode.script.trim();

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="shrink-0" data-drama-script-statusbar>
                <DramaStageHeader
                    step="01"
                    title="剧本编辑"
                    description="编辑或导入本集剧本，整理后进入内容审核。"
                    status={lifecycle?.status === "error" ? "整理失败" : lifecycle ? "整理进行中" : scriptText ? (episode.shots.length ? "已整理" : "待整理") : "待编辑"}
                    tone={lifecycle?.status === "error" ? "attention" : lifecycle ? "running" : scriptText ? (episode.shots.length ? "ready" : "neutral") : "attention"}
                    metrics={[
                        { label: "字数", value: scriptText.length },
                        { label: "场景", value: episode.shots.length },
                    ]}
                    action={
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                            <DramaSourceImport project={project} onImported={() => onStageChange("script")} />
                            <Button
                                type="primary"
                                className="!h-8 !px-2.5 enabled:!border-violet-600 enabled:!bg-violet-600 enabled:!text-white enabled:hover:!border-violet-500 enabled:hover:!bg-violet-500 dark:enabled:!border-violet-400 dark:enabled:!bg-violet-400 dark:enabled:!text-violet-950"
                                size="small"
                                icon={<Sparkles className="size-3.5" />}
                                loading={analyzing}
                                disabled={!scriptText}
                                title={scriptText ? undefined : "请先填写或导入本集剧本"}
                                onClick={onAnalyze}
                            >
                                AI 整理
                            </Button>
                            <Popover trigger="click" placement="bottomRight" styles={{ container: { padding: 12, width: 320 } }} content={<DramaEpisodeSettings project={project} episode={episode} embedded />}>
                                <Button className="!h-8 !px-2.5" size="small" icon={<Settings2 className="size-3.5" />} aria-label="打开本集设置">
                                    本集设置
                                </Button>
                            </Popover>
                        </div>
                    }
                    below={
                        lifecycle ? (
                            <div
                                className={`w-full min-w-0 rounded-lg border px-3 py-2.5 ${lifecycle.status === "error" ? "border-rose-200 bg-rose-50/70 dark:border-rose-900/70 dark:bg-rose-950/25" : "border-sky-200 bg-sky-50/70 dark:border-sky-900/70 dark:bg-sky-950/25"}`}
                                data-drama-content-lifecycle
                            >
                                <Steps
                                    className="[&_.ant-steps-item-title]:!whitespace-nowrap"
                                    current={lifecycle.current}
                                    responsive
                                    size="small"
                                    status={lifecycle.status}
                                    items={["创建任务", "排队接管", "读取原文", "结构提取", "合并校验", "保存项目", "完成"].map((title) => ({ title }))}
                                />
                                <Tooltip title={lifecycle.description}>
                                    <p className={`mt-2 truncate text-xs ${lifecycle.status === "error" ? "text-rose-600 dark:text-rose-300" : "text-sky-700 dark:text-sky-300"}`} aria-live="polite">
                                        {lifecycle.description}
                                    </p>
                                </Tooltip>
                            </div>
                        ) : null
                    }
                />
                {episode.contentError ? <Alert className="mt-2.5" type="error" showIcon message="内容整理失败" description={episode.contentError} /> : null}
            </div>
            <div className="mt-3 flex min-h-0 flex-1 overflow-hidden bg-transparent">
                <DramaScriptWorkspace project={project} episode={episode} selectedShotId={selectedShotId} onSelectedShotChange={onSelectedShotChange} analyzing={analyzing} onAnalyze={onAnalyze} />
            </div>
        </div>
    );
}
