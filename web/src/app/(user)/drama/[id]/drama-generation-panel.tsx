"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { App, Button, Progress, Tag } from "antd";
import { ArrowRight, Captions, CircleAlert, CircleCheck, CircleDashed, Download, Film, LoaderCircle, Pause, Play, RefreshCw, ScanSearch, Send, Volume2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { MediaRetentionNotice } from "@/components/media/media-retention-notice";
import { createAgentPromptHref } from "@/lib/create-agent-prompt";
import { compileDramaShotPrompts } from "@/lib/drama-prompt-compiler";
import { mediaDownloadFileName } from "@/lib/media-file";
import { originalMediaDownloadUrl } from "@/lib/media-image-url";
import { exportDramaJianyingDraft, getDramaProjectCosts, reviewDramaEpisode } from "@/services/api/drama-projects";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useDramaStore } from "../stores/use-drama-store";
import { buildSrt } from "../subtitle";
import type { DramaCostSummary, DramaEpisode, DramaProject, DramaRenderTask, DramaShot } from "../types";
import { cancelDramaAudioTask } from "./use-drama-audio-queue";
import { AudioTag, DramaStageHeader, GenerationTag, StoryboardTag } from "./drama-editor-elements";
import { summarizeDramaGeneration } from "./drama-generation-readiness";
import { DramaMediaPreviewModal, DramaMediaThumbnail, type DramaPreviewMedia } from "./drama-media-preview";
import { DramaJianyingModal, DramaSubtitleModal } from "./drama-project-modals";
import type { DramaProjectStage } from "./drama-project-sections";
import { estimateEpisodePoints } from "./drama-shot-generation-utils";

const actionButtonClass = "!h-9 !px-3 [&>span:last-child]:whitespace-nowrap";

export function DramaGenerationPanel({ project, episode, onStageChange, onOpenAssets }: { project: DramaProject; episode: DramaEpisode; onStageChange: (stage: DramaProjectStage) => void; onOpenAssets: () => void }) {
    const { message } = App.useApp();
    const router = useRouter();
    const config = useEffectiveConfig();
    const updateEpisode = useDramaStore((state) => state.updateEpisode);
    const updateShot = useDramaStore((state) => state.updateShot);
    const queueShots = useDramaStore((state) => state.queueShots);
    const queueAudio = useDramaStore((state) => state.queueAudio);
    const [costSummary, setCostSummary] = useState<DramaCostSummary | null>(null);
    const [renderReady, setRenderReady] = useState<boolean | null>(null);
    const [reviewingVisuals, setReviewingVisuals] = useState(false);
    const [jianyingOpen, setJianyingOpen] = useState(false);
    const [jianyingPath, setJianyingPath] = useState("");
    const [jianyingVersion, setJianyingVersion] = useState<"5" | "6">("6");
    const [jianyingExporting, setJianyingExporting] = useState(false);
    const [subtitleOpen, setSubtitleOpen] = useState(false);
    const [previewMedia, setPreviewMedia] = useState<DramaPreviewMedia>();
    const readiness = useMemo(() => summarizeDramaGeneration(project, episode), [episode, project]);
    const renderTask = episode.renderTask || null;
    const costRefreshKey = useMemo(
        () =>
            [
                ...episode.shots.flatMap((shot) => [shot.storyboardTaskId, shot.storyboardStatus, shot.storyboardEndTaskId, shot.storyboardEndStatus, shot.generationTaskId, shot.generationStatus, shot.audioTaskId, shot.audioStatus]),
                renderTask?.id,
                renderTask?.status,
            ].join(":"),
        [episode.shots, renderTask?.id, renderTask?.status],
    );
    const audioReady = Boolean(config.audioModel.trim());
    const assetCount = project.characters.length + project.scenes.length + project.props.length + project.clues.length;
    const audioCandidateShotIds = episode.shots.filter((shot) => shot.videoUrl && (shot.subtitle || shot.dialogue).trim() && shot.audioStatus !== "success").map((shot) => shot.id);

    useEffect(() => {
        let active = true;
        setRenderReady(null);
        void fetch("/api/drama/render-capability", { cache: "no-store" })
            .then((response) => response.json())
            .then((payload: { data?: { available?: boolean } }) => active && setRenderReady(Boolean(payload.data?.available)))
            .catch(() => active && setRenderReady(false));
        return () => {
            active = false;
        };
    }, [episode.id, project.id]);

    useEffect(() => {
        let active = true;
        void getDramaProjectCosts(project.id)
            .then((value) => active && setCostSummary(value))
            .catch(() => active && setCostSummary(null));
        return () => {
            active = false;
        };
    }, [costRefreshKey, project.id]);

    useEffect(() => {
        if (!renderTask?.id || !["pending", "running"].includes(renderTask.status)) return;
        let active = true;
        const load = async () => {
            const response = await fetch(`/api/drama/render/${encodeURIComponent(renderTask.id)}`, { cache: "no-store" });
            const payload = (await response.json().catch(() => ({}))) as { data?: DramaRenderTask };
            if (active && response.ok && payload.data) updateEpisode(project.id, episode.id, { renderTask: payload.data });
        };
        void load();
        const timer = window.setInterval(() => void load(), 2500);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [episode.id, project.id, renderTask?.id, renderTask?.status, updateEpisode]);

    const cancelShot = async (shot: DramaShot) => {
        const requests = [
            shot.storyboardTaskId ? fetch(`/api/image-tasks/${encodeURIComponent(shot.storyboardTaskId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }) : undefined,
            shot.storyboardEndTaskId ? fetch(`/api/image-tasks/${encodeURIComponent(shot.storyboardEndTaskId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }) : undefined,
            shot.generationTaskId ? fetch(`/api/video-tasks/${encodeURIComponent(shot.generationTaskId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }) : undefined,
        ].filter(Boolean) as Promise<Response>[];
        await Promise.all(requests.map((request) => request.catch(() => undefined)));
        updateShot(project.id, episode.id, shot.id, shot.storyboardTaskId || shot.storyboardEndTaskId ? { storyboardStatus: "cancelled", storyboardEndStatus: "cancelled", generationStatus: "cancelled" } : { generationStatus: "cancelled" });
    };

    const sendToAgent = (shot: DramaShot) => {
        const prompt = compileDramaShotPrompts(project, episode, shot).videoPrompt;
        router.push(createAgentPromptHref(`${prompt}\n画幅：${project.ratio}`));
    };

    const downloadSubtitles = () => {
        const content = buildSrt(episode.shots);
        if (!content) return message.warning("请先填写至少一条对白或字幕");
        const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: "application/x-subrip;charset=utf-8" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${project.title.trim().replace(/[\\/:*?"<>|]/g, "-") || "短剧字幕"}.srt`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.success("SRT 字幕已导出");
    };

    const exportJianying = async () => {
        if (!jianyingPath.trim()) return message.warning("请填写剪映草稿目录");
        setJianyingExporting(true);
        try {
            const result = await exportDramaJianyingDraft(project.id, { episodeId: episode.id, draftPath: jianyingPath.trim(), version: jianyingVersion });
            const url = URL.createObjectURL(result.blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = result.fileName;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            setJianyingOpen(false);
            message.success("剪映草稿已导出");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "剪映草稿导出失败");
        } finally {
            setJianyingExporting(false);
        }
    };

    const createRender = async () => {
        try {
            const response = await fetch("/api/drama/render", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectId: project.id,
                    conversationId: project.creativeConversationId,
                    title: project.title,
                    ratio: project.ratio,
                    shots: episode.shots.map((shot) => ({ videoUrl: shot.videoUrl, audioMode: shot.audioMode || "source", audioUrl: shot.audioUrl, subtitle: shot.subtitle || shot.dialogue, duration: shot.duration })),
                }),
            });
            const payload = (await response.json().catch(() => ({}))) as { data?: DramaRenderTask; msg?: string };
            if (!response.ok || !payload.data) throw new Error(payload.msg || "整集合成任务创建失败");
            updateEpisode(project.id, episode.id, { renderTask: payload.data });
            message.success("整集合成任务已创建");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "整集合成任务创建失败");
        }
    };

    const cancelRender = async () => {
        if (!renderTask?.id) return;
        try {
            const response = await fetch(`/api/drama/render/${encodeURIComponent(renderTask.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
            if (!response.ok) throw new Error("整集合成取消失败");
            updateEpisode(project.id, episode.id, { renderTask: { ...renderTask, status: "cancelled" } });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "整集合成取消失败");
        }
    };

    const reviewVisuals = async () => {
        if (!episode.shots.some((shot) => shot.storyboardImageUrl)) return message.warning("请先生成至少一张分镜图");
        setReviewingVisuals(true);
        try {
            const review = await reviewDramaEpisode(project, episode);
            updateEpisode(project.id, episode.id, { visualReview: review });
            if (review.status === "passed") message.success("视觉复盘通过");
            else if (review.status === "needs_revision") message.warning("视觉复盘发现需要调整的镜头");
            else message.info(review.summary);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视觉复盘失败");
        } finally {
            setReviewingVisuals(false);
        }
    };

    const primaryAction = buildPrimaryAction({
        episode,
        readiness,
        renderReady,
        audioReady,
        renderTask,
        onStageChange,
        onQueueShots: (shotIds) => queueShots(project.id, episode.id, shotIds),
        onQueueAudio: (shotIds) => queueAudio(project.id, episode.id, shotIds),
        onCreateRender: () => void createRender(),
    });
    const status = generationStageStatus(readiness, renderTask);
    const checklist = [
        {
            id: "review",
            title: "内容审核",
            detail: episode.reviewStatus === "visual_ready" ? `${readiness.totalShots} 个镜头已确认并生成视觉方案` : readiness.totalShots ? "镜头内容尚未完成确认或视觉方案未生成" : "还没有可审核的镜头结构",
            tone: episode.reviewStatus === "visual_ready" ? ("done" as const) : ("blocked" as const),
            action: () => onStageChange(readiness.totalShots ? "review" : "script"),
            actionLabel: readiness.totalShots ? "去审核" : "去写剧本",
        },
        {
            id: "assets",
            title: "视觉资产",
            detail: readiness.missingReferenceShotIds.length
                ? `${readiness.missingReferenceShotIds.length} 个参考图模式镜头缺少可用资产引用`
                : assetCount
                  ? `已登记 ${assetCount} 项资产，当前没有硬性引用阻塞`
                  : "当前镜头未要求参考图；建立基准资产可提升一致性",
            tone: readiness.missingReferenceShotIds.length ? ("blocked" as const) : assetCount ? ("done" as const) : ("optional" as const),
            action: readiness.missingReferenceShotIds.length ? () => onStageChange("storyboard") : onOpenAssets,
            actionLabel: readiness.missingReferenceShotIds.length ? "处理引用" : "查看资产",
        },
        {
            id: "storyboard",
            title: "分镜配置",
            detail: readiness.missingPromptShotIds.length ? `${readiness.missingPromptShotIds.length} 个镜头缺少画面或动态提示词` : readiness.totalShots ? `${readiness.totalShots} 个镜头生成参数已就绪` : "等待内容审核生成镜头",
            tone: readiness.missingPromptShotIds.length || !readiness.totalShots ? ("blocked" as const) : ("done" as const),
            action: () => onStageChange("storyboard"),
            actionLabel: "打开分镜",
        },
        {
            id: "audio",
            title: "音频模型",
            detail: !readiness.voiceoverShotIds.length
                ? "当前没有必须生成的 AI 配音，可使用视频原声或静音"
                : audioReady
                  ? `音频模型已配置，${readiness.voiceoverShotIds.length} 个镜头需要 AI 配音`
                  : `${readiness.voiceoverShotIds.length} 个镜头选择 AI 配音，但当前暂不可用`,
            tone: !readiness.voiceoverShotIds.length ? ("optional" as const) : audioReady ? ("done" as const) : ("blocked" as const),
            action: () => onStageChange("storyboard"),
            actionLabel: "检查配音方式",
        },
    ];

    return (
        <div className="min-w-0" data-drama-generation-panel>
            <DramaStageHeader
                step="04"
                title="镜头生成"
                description={status.description}
                status={status.label}
                tone={status.tone}
                metrics={
                    readiness.totalShots
                        ? [
                              { label: "镜头", value: `${readiness.completedVideoCount}/${readiness.totalShots}` },
                              { label: "配音", value: readiness.voiceoverShotIds.length ? `${readiness.completedAudioCount}/${readiness.voiceoverShotIds.length}` : "无需" },
                              { label: "预计", value: `¥${estimateEpisodePoints(config, project, episode.shots)}` },
                              { label: "实际", value: `¥${costSummary?.actualPoints || 0}` },
                              { label: "任务", value: costSummary?.taskCount || 0 },
                          ]
                        : []
                }
                action={primaryAction}
            />

            {readiness.totalShots ? (
                <div className="mt-3 flex items-center gap-3" aria-label="镜头完成进度">
                    <Progress className="!m-0 min-w-0 flex-1" percent={readiness.progressPercent} showInfo={false} />
                    <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{readiness.progressPercent}%</span>
                </div>
            ) : null}

            <section className="mt-2.5" aria-labelledby="drama-preflight-title" data-drama-generation-readiness>
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <h3 id="drama-preflight-title" className="shrink-0 text-sm font-semibold">
                            生成前检查
                        </h3>
                        <p className="truncate text-xs text-muted-foreground">阻塞项会说明原因，并带你回到真正需要处理的位置。</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{checklist.filter((item) => item.tone === "done" || item.tone === "optional").length}/4 可继续</span>
                </div>
                <div className={`mt-2 grid gap-1.5 ${readiness.totalShots ? "sm:grid-cols-2 xl:grid-cols-4" : "max-w-xl"}`}>
                    {(readiness.totalShots ? checklist : checklist.slice(0, 1)).map(({ id, ...item }) => (
                        <ReadinessItem key={id} {...item} />
                    ))}
                </div>
            </section>

            {readiness.totalShots ? (
                <section className="mt-3 border-y border-border" aria-labelledby="drama-production-tools" data-drama-generation-tools>
                    <h3 id="drama-production-tools" className="sr-only">
                        生产辅助工具
                    </h3>
                    <div className="grid lg:grid-cols-3 lg:divide-x lg:divide-border">
                        <ToolGroup title="主生成" description="批量生成由顶部唯一主操作承接，避免重复触发任务。">
                            <Button className={actionButtonClass} icon={<ScanSearch className="size-4" />} loading={reviewingVisuals} disabled={!episode.shots.some((shot) => shot.storyboardImageUrl)} onClick={() => void reviewVisuals()}>
                                视觉复盘
                            </Button>
                        </ToolGroup>
                        <ToolGroup title="后期处理" description={audioReady ? "配音与字幕按镜头结果继续处理。" : "AI 配音暂不可用，可联系客服处理。"}>
                            <Button
                                className={actionButtonClass}
                                icon={<Volume2 className="size-4" />}
                                disabled={!audioReady || !audioCandidateShotIds.length}
                                title={audioReady ? undefined : "当前暂不可用，请联系客服"}
                                onClick={() => queueAudio(project.id, episode.id, audioCandidateShotIds)}
                            >
                                批量配音
                            </Button>
                            <Button className={actionButtonClass} icon={<Captions className="size-4" />} disabled={!episode.shots.some((shot) => (shot.subtitle || shot.dialogue).trim())} onClick={() => setSubtitleOpen(true)}>
                                字幕时间轴
                            </Button>
                        </ToolGroup>
                        <ToolGroup title="交付导出" description="镜头结果可导出字幕和剪映草稿，成片完成后直接下载。">
                            <Button className={actionButtonClass} icon={<Download className="size-4" />} disabled={!episode.shots.some((shot) => (shot.subtitle || shot.dialogue).trim())} onClick={downloadSubtitles}>
                                导出 SRT
                            </Button>
                            <Button className={actionButtonClass} icon={<Download className="size-4" />} disabled={!episode.shots.some((shot) => shot.videoUrl)} onClick={() => setJianyingOpen(true)}>
                                剪映草稿
                            </Button>
                        </ToolGroup>
                    </div>
                </section>
            ) : null}

            {episode.visualReview ? <VisualReview project={project} episode={episode} /> : null}
            {renderTask ? <RenderTaskCard task={renderTask} onCancel={() => void cancelRender()} /> : null}

            {episode.shots.length ? (
                <section className="mt-3" aria-labelledby="drama-shot-task-title">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
                        <div>
                            <h3 id="drama-shot-task-title" className="text-sm font-semibold">
                                镜头任务
                            </h3>
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">每个镜头独立显示分镜、视频和配音状态；失败时只重试目标镜头。</p>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                            <span>{readiness.completedVideoCount} 已完成</span>
                            <span>{readiness.activeShotIds.length} 处理中</span>
                            <span>{readiness.failedShotIds.length} 失败</span>
                        </div>
                    </div>

                    <div className="mt-2.5 overflow-hidden rounded-lg border border-border bg-card" data-drama-shot-task-list>
                        {episode.shots.map((shot) => (
                            <ShotTaskRow key={shot.id} project={project} episode={episode} shot={shot} audioReady={audioReady} onPreview={setPreviewMedia} onCancel={() => void cancelShot(shot)} onSendToAgent={() => sendToAgent(shot)} />
                        ))}
                    </div>
                </section>
            ) : null}

            <DramaJianyingModal
                open={jianyingOpen}
                path={jianyingPath}
                version={jianyingVersion}
                exporting={jianyingExporting}
                onClose={() => setJianyingOpen(false)}
                onExport={() => void exportJianying()}
                onPathChange={setJianyingPath}
                onVersionChange={setJianyingVersion}
            />
            <DramaSubtitleModal open={subtitleOpen} shots={episode.shots} onClose={() => setSubtitleOpen(false)} />
            <DramaMediaPreviewModal media={previewMedia} onClose={() => setPreviewMedia(undefined)} />
        </div>
    );
}

type ReadinessTone = "done" | "blocked" | "optional";

function ReadinessItem({ title, detail, tone, action, actionLabel }: { title: string; detail: string; tone: ReadinessTone; action: () => void; actionLabel: string }) {
    const Icon = tone === "done" ? CircleCheck : tone === "blocked" ? CircleAlert : CircleDashed;
    const iconClass = tone === "done" ? "text-emerald-600 dark:text-emerald-300" : tone === "blocked" ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground";
    return (
        <button
            type="button"
            className="group flex h-12 min-w-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-left transition hover:border-foreground/20 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/35"
            onClick={action}
            title={`${title}：${detail}`}
            aria-label={`${title}，${actionLabel}`}
        >
            <Icon className={`size-4 shrink-0 ${iconClass}`} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span>
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground transition group-hover:text-foreground">{actionLabel}</span>
        </button>
    );
}

function ToolGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <div className="min-w-0 border-b border-border py-3 last:border-b-0 lg:border-b-0 lg:px-4 lg:first:pl-0 lg:last:pr-0">
            <div className="text-sm font-semibold">{title}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            <div className="mt-2 flex min-w-0 flex-wrap gap-2">{children}</div>
        </div>
    );
}

function VisualReview({ project, episode }: { project: DramaProject; episode: DramaEpisode }) {
    const queueShots = useDramaStore((state) => state.queueShots);
    const review = episode.visualReview!;
    return (
        <section className="mt-6 border-b border-border pb-5" aria-label="分镜视觉复盘">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">分镜视觉复盘</h3>
                        <Tag color={review.status === "passed" ? "success" : review.status === "needs_revision" ? "warning" : "default"}>{review.status === "passed" ? "通过" : review.status === "needs_revision" ? "需调整" : "未完成"}</Tag>
                        {typeof review.score === "number" ? <span className="text-xs tabular-nums text-muted-foreground">{review.score} 分</span> : null}
                    </div>
                    <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{review.summary}</p>
                </div>
                {review.retryTaskIds.length ? (
                    <Button className="!h-9 shrink-0" icon={<RefreshCw className="size-4" />} onClick={() => queueShots(project.id, episode.id, review.retryTaskIds)}>
                        重试 {review.retryTaskIds.length} 个问题镜头
                    </Button>
                ) : null}
            </div>
            {review.issues.length ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {review.issues.map((issue, index) => {
                        const shot = episode.shots.find((item) => item.id === issue.taskId);
                        return (
                            <div key={`${issue.taskId || "general"}-${index}`} className="border-l-2 border-amber-400 pl-3 text-sm">
                                <div className="font-medium">{shot?.title || issue.category}</div>
                                <p className="mt-1 leading-5 text-muted-foreground">{issue.message}</p>
                                {issue.correction ? <p className="mt-1 leading-5">建议：{issue.correction}</p> : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </section>
    );
}

function RenderTaskCard({ task, onCancel }: { task: DramaRenderTask; onCancel: () => void }) {
    const active = task.status === "pending" || task.status === "running";
    return (
        <section className="mt-6 rounded-xl border border-border bg-card p-4 sm:p-5" aria-label="整集合成任务">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold">
                        {active ? <LoaderCircle className="size-4 animate-spin text-sky-600 dark:text-sky-300" /> : <Film className="size-4" />}
                        整集合成
                    </div>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {task.status === "success"
                            ? "成片已经完成，可预览并下载原文件。"
                            : task.status === "error"
                              ? task.error || "合成失败，请检查镜头媒体后重试。"
                              : task.status === "cancelled"
                                ? "合成已取消，可以从页面顶部重新创建任务。"
                                : "正在转码、拼接并烧录字幕，离开页面不会取消后台任务。"}
                    </p>
                </div>
                {active ? (
                    <Button danger className="!h-9 shrink-0" onClick={onCancel}>
                        取消合成
                    </Button>
                ) : null}
            </div>
            {task.result?.url ? (
                <div className="mt-4">
                    <video className="max-h-[520px] w-full rounded-xl bg-black" src={task.result.url} controls preload="metadata" />
                    <a className="mt-3 inline-flex text-sm font-medium text-blue-600 hover:underline dark:text-cyan-300" href={originalMediaDownloadUrl(task.result.url)} download={mediaDownloadFileName(task.id, "video/mp4", task.result.url)}>
                        下载整集成片
                    </a>
                    <MediaRetentionNotice className="max-w-full" />
                </div>
            ) : null}
        </section>
    );
}

function ShotTaskRow({
    project,
    episode,
    shot,
    audioReady,
    onPreview,
    onCancel,
    onSendToAgent,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    shot: DramaShot;
    audioReady: boolean;
    onPreview: (media: DramaPreviewMedia) => void;
    onCancel: () => void;
    onSendToAgent: () => void;
}) {
    const updateShot = useDramaStore((state) => state.updateShot);
    const queueShots = useDramaStore((state) => state.queueShots);
    const queueAudio = useDramaStore((state) => state.queueAudio);
    const generating = [shot.storyboardStatus, shot.storyboardEndStatus, shot.generationStatus].some((status) => status === "queued" || status === "running");
    const failed = [shot.storyboardStatus, shot.storyboardEndStatus, shot.generationStatus].some((status) => status === "error");
    const dialogue = (shot.subtitle || shot.dialogue || shot.narration).trim();

    return (
        <article
            className="grid min-w-0 gap-4 overflow-hidden border-b border-border p-3.5 last:border-b-0 hover:bg-muted/20 [content-visibility:visible] sm:p-4 sm:[content-visibility:auto] lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start"
            data-drama-shot-task
        >
            <div className="min-w-0">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold tabular-nums">{String(shot.order).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                            <h4 className="min-w-0 truncate font-semibold">{shot.title || `镜头 ${String(shot.order).padStart(2, "0")}`}</h4>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <StoryboardTag status={shot.storyboardStatus} />
                                {shot.storyboardFrameMode === "first_last" ? <Tag className="!m-0 !h-6 !rounded-md !leading-6">尾帧 {shot.storyboardEndStatus === "success" ? "完成" : shot.storyboardEndStatus === "error" ? "失败" : "待处理"}</Tag> : null}
                                <GenerationTag status={shot.generationStatus} />
                                {shot.audioMode === "voiceover" ? <AudioTag status={shot.audioStatus} /> : <Tag className="!m-0">{shot.audioMode === "mute" ? "静音" : "视频原声"}</Tag>}
                            </div>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{shot.videoPrompt || "动态提示词尚未填写，请回到分镜阶段补充。"}</p>
                    </div>
                </div>

                <ShotErrors shot={shot} />

                {shot.storyboardImageUrl || shot.videoUrl ? (
                    <div className="ml-11 mt-3 flex max-w-2xl flex-wrap gap-2">
                        {shot.storyboardImageUrl ? <DramaMediaThumbnail media={{ type: "image", url: shot.storyboardImageUrl, title: `${shot.title}起始帧` }} onOpen={onPreview} /> : null}
                        {shot.storyboardEndImageUrl ? <DramaMediaThumbnail media={{ type: "image", url: shot.storyboardEndImageUrl, title: `${shot.title}结束帧` }} onOpen={onPreview} /> : null}
                        {shot.videoUrl ? <DramaMediaThumbnail media={{ type: "video", url: shot.videoUrl, title: `${shot.title}生成视频` }} onOpen={onPreview} /> : null}
                    </div>
                ) : null}
                {dialogue ? <p className="ml-11 mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">字幕：{dialogue}</p> : null}
                {shot.audioUrl ? <audio className="ml-11 mt-3 h-10 w-[calc(100%_-_2.75rem)] max-w-sm" src={shot.audioUrl} controls preload="metadata" /> : null}
            </div>

            <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-1">
                {shot.audioStatus === "running" || shot.audioStatus === "queued" ? (
                    <Button className={actionButtonClass} icon={<Pause className="size-4" />} onClick={() => void cancelDramaAudioTask(shot.audioTaskId).finally(() => updateShot(project.id, episode.id, shot.id, { audioStatus: "cancelled" }))}>
                        取消配音
                    </Button>
                ) : dialogue ? (
                    <Button className={actionButtonClass} disabled={!audioReady} title={audioReady ? undefined : "当前暂不可用，请联系客服"} icon={<Volume2 className="size-4" />} onClick={() => queueAudio(project.id, episode.id, [shot.id])}>
                        {shot.audioStatus === "error" ? "重试配音" : shot.audioMode === "voiceover" ? "生成配音" : "改用 AI 配音"}
                    </Button>
                ) : null}
                {generating ? (
                    <Button className={`${dialogue ? "" : "col-span-2 lg:col-span-1"} ${actionButtonClass}`} icon={<Pause className="size-4" />} onClick={onCancel}>
                        取消生成
                    </Button>
                ) : (
                    <Button
                        className={`${dialogue ? "" : "col-span-2 lg:col-span-1"} ${actionButtonClass}`}
                        disabled={episode.reviewStatus !== "visual_ready"}
                        icon={failed ? <RefreshCw className="size-4" /> : <Play className="size-4" />}
                        onClick={() => queueShots(project.id, episode.id, [shot.id])}
                    >
                        {failed ? "重试镜头" : shot.videoUrl ? "重新生成" : "生成镜头"}
                    </Button>
                )}
                <Button type="text" disabled={!shot.videoPrompt} className={`col-span-2 !bg-muted/60 hover:!bg-muted lg:col-span-1 ${actionButtonClass}`} icon={<Send className="size-4" />} onClick={onSendToAgent}>
                    交给创作 Agent
                </Button>
            </div>
        </article>
    );
}

function ShotErrors({ shot }: { shot: DramaShot }) {
    const errors = [
        shot.storyboardError ? `分镜图：${shot.storyboardError}` : "",
        shot.storyboardEndError ? `结束帧：${shot.storyboardEndError}` : "",
        shot.generationError ? `视频：${shot.generationError}` : "",
        shot.audioError ? `配音：${shot.audioError}` : "",
    ].filter(Boolean);
    return errors.length ? (
        <div className="ml-11 mt-2 space-y-1 border-l-2 border-rose-300 pl-3 text-xs leading-5 text-rose-600 dark:border-rose-800 dark:text-rose-300">
            {errors.map((error) => (
                <p key={error}>{error}</p>
            ))}
        </div>
    ) : null;
}

function generationStageStatus(readiness: ReturnType<typeof summarizeDramaGeneration>, renderTask: DramaRenderTask | null): { label: string; description: string; tone: "neutral" | "ready" | "attention" | "running" } {
    if (!readiness.totalShots) return { label: "等待镜头", description: "当前集还没有镜头结构。完成剧本提取与内容审核后，生成任务会在这里集中管理。", tone: "attention" };
    if (renderTask?.status === "success") return { label: "成片已完成", description: "整集合成已经完成，可以预览成片、下载文件或继续导出字幕与剪映草稿。", tone: "ready" };
    if (renderTask && ["pending", "running"].includes(renderTask.status)) return { label: "正在合成", description: "全部镜头已经进入整集合成，后台会继续完成转码、拼接与字幕处理。", tone: "running" };
    if (readiness.activeShotIds.length) return { label: "生产进行中", description: `${readiness.activeShotIds.length} 个镜头正在排队或生成，完成后会自动继续处理下一项。`, tone: "running" };
    if (readiness.failedShotIds.length) return { label: "需要处理", description: `${readiness.failedShotIds.length} 个镜头存在失败项。下方会显示精确原因，并只重试对应镜头。`, tone: "attention" };
    if (readiness.completedVideoCount === readiness.totalShots && !readiness.missingAudioShotIds.length) return { label: "可合成", description: "镜头视频和必需配音已经就绪，下一步可以合成整集成片。", tone: "ready" };
    return { label: "准备生成", description: "先处理生成前检查中的阻塞项，再从唯一主操作启动本集镜头队列。", tone: "neutral" };
}

function buildPrimaryAction({
    episode,
    readiness,
    renderReady,
    audioReady,
    renderTask,
    onStageChange,
    onQueueShots,
    onQueueAudio,
    onCreateRender,
}: {
    episode: DramaEpisode;
    readiness: ReturnType<typeof summarizeDramaGeneration>;
    renderReady: boolean | null;
    audioReady: boolean;
    renderTask: DramaRenderTask | null;
    onStageChange: (stage: DramaProjectStage) => void;
    onQueueShots: (shotIds: string[]) => void;
    onQueueAudio: (shotIds: string[]) => void;
    onCreateRender: () => void;
}) {
    const primaryClass = "!h-11 !w-full !px-4 sm:!h-9 sm:!w-auto";
    if (!readiness.totalShots)
        return (
            <Button type="primary" className={primaryClass} icon={<ArrowRight className="size-4" />} onClick={() => onStageChange("script")}>
                返回剧本并提取结构
            </Button>
        );
    if (episode.reviewStatus !== "visual_ready")
        return (
            <Button type="primary" className={primaryClass} icon={<ArrowRight className="size-4" />} onClick={() => onStageChange("review")}>
                完成内容审核与视觉方案
            </Button>
        );
    if (readiness.activeShotIds.length)
        return (
            <Button type="primary" className={primaryClass} loading disabled>
                正在处理 {readiness.activeShotIds.length} 个镜头
            </Button>
        );
    if (readiness.queueableShotIds.length)
        return (
            <Button type="primary" className={primaryClass} icon={<Play className="size-4" />} onClick={() => onQueueShots(readiness.queueableShotIds)}>
                {readiness.failedShotIds.length ? "重试" : "生成"} {readiness.queueableShotIds.length} 个就绪镜头
            </Button>
        );
    if (readiness.missingPromptShotIds.length || readiness.missingReferenceShotIds.length)
        return (
            <Button type="primary" className={primaryClass} icon={<ArrowRight className="size-4" />} onClick={() => onStageChange("storyboard")}>
                处理 {new Set([...readiness.missingPromptShotIds, ...readiness.missingReferenceShotIds]).size} 个阻塞镜头
            </Button>
        );
    if (readiness.missingAudioShotIds.length)
        return (
            <Button type="primary" className={primaryClass} icon={<Volume2 className="size-4" />} disabled={!audioReady} title={audioReady ? undefined : "当前暂不可用，请联系客服"} onClick={() => onQueueAudio(readiness.missingAudioShotIds)}>
                {audioReady ? `生成 ${readiness.missingAudioShotIds.length} 条配音` : "配音暂不可用"}
            </Button>
        );
    if (renderTask && ["pending", "running"].includes(renderTask.status))
        return (
            <Button type="primary" className={primaryClass} loading disabled>
                正在合成整集
            </Button>
        );
    if (renderTask?.result?.url)
        return (
            <Button type="primary" className={primaryClass} icon={<Download className="size-4" />} href={originalMediaDownloadUrl(renderTask.result.url)} download={mediaDownloadFileName(renderTask.id, "video/mp4", renderTask.result.url)}>
                下载整集成片
            </Button>
        );
    if (renderReady === null)
        return (
            <Button type="primary" className={primaryClass} loading disabled>
                检查合成环境
            </Button>
        );
    if (!renderReady)
        return (
            <Button type="primary" className={primaryClass} disabled title="服务器尚未安装 FFmpeg">
                FFmpeg 未就绪
            </Button>
        );
    return (
        <Button type="primary" className={primaryClass} icon={<Film className="size-4" />} onClick={onCreateRender}>
            {renderTask?.status === "error" || renderTask?.status === "cancelled" ? "重新合成整集" : "合成整集"}
        </Button>
    );
}
