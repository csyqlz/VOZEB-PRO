"use client";

import { Alert, Button, Input, InputNumber, Modal } from "antd";
import { ArrowLeft, Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

import type { DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import { useDramaStore } from "../stores/use-drama-store";
import { DramaStageHeader } from "./drama-editor-elements";
import type { DramaProjectStage } from "./drama-project-sections";
import { DramaShotDialogueEditor } from "./drama-shot-dialogue-editor";

export function DramaReviewPanel({
    project,
    episode,
    onDesignVisuals,
    designing,
    visualFailure,
    onStageChange,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    onDesignVisuals: () => void;
    designing: boolean;
    visualFailure?: { kind: "terminal" | "connection"; detail: string };
    onStageChange: (stage: DramaProjectStage) => void;
}) {
    const updateEpisode = useDramaStore((state) => state.updateEpisode);
    const updateShot = useDramaStore((state) => state.updateShot);
    const [episodeInfoOpen, setEpisodeInfoOpen] = useState(false);
    const [expandedShotIds, setExpandedShotIds] = useState<Set<string>>(() => new Set(episode.shots.slice(0, 1).map((shot) => shot.id)));
    useEffect(() => {
        setExpandedShotIds(new Set(episode.shots.slice(0, 1).map((shot) => shot.id)));
    }, [episode.id]);
    const updateContentShot = (shotId: string, patch: Parameters<typeof updateShot>[3]) => {
        updateShot(project.id, episode.id, shotId, patch);
        if (episode.reviewStatus !== "content_review") updateEpisode(project.id, episode.id, { reviewStatus: "content_review" });
    };
    const toggleShot = (shotId: string) => {
        setExpandedShotIds((current) => {
            const next = new Set(current);
            if (next.has(shotId)) next.delete(shotId);
            else next.add(shotId);
            return next;
        });
    };
    const totalDuration = episode.shots.reduce((total, shot) => total + shot.duration, 0);
    const dialogueCount = episode.shots.reduce((total, shot) => total + (shot.utterances.filter((item) => item.type === "dialogue").length || shot.dialogue.split(/\n+/).filter((line) => line.trim()).length), 0);
    return (
        <div>
            <DramaStageHeader
                step="02"
                title="内容审核"
                description="确认剧本事实、镜头边界、对白与叙事信息；视觉模型不会在这个阶段改写内容。"
                status={
                    !episode.shots.length
                        ? "等待内容结构"
                        : visualFailure?.kind === "terminal"
                          ? "视觉方案生成失败"
                          : visualFailure
                            ? "任务状态待检查"
                            : episode.visualTaskId
                              ? "视觉方案生成中"
                              : episode.reviewStatus === "visual_ready"
                                ? "视觉方案已生成"
                                : "待确认"
                }
                tone={!episode.shots.length || episode.visualTaskId ? "attention" : episode.reviewStatus === "visual_ready" ? "ready" : "neutral"}
                metrics={
                    episode.shots.length
                        ? [
                              { label: "镜头", value: episode.shots.length },
                              { label: "总时长", value: `${totalDuration} 秒` },
                              { label: "对白", value: `${dialogueCount} 句` },
                          ]
                        : []
                }
                secondaryAction={
                    <Button className="!h-8" icon={<SlidersHorizontal className="size-3.5" />} onClick={() => setEpisodeInfoOpen(true)}>
                        本集信息
                    </Button>
                }
                action={
                    <Button
                        type="primary"
                        className="!h-9 !w-full sm:!w-auto"
                        icon={episode.shots.length ? <Check className="size-4" /> : <ArrowLeft className="size-4" />}
                        loading={designing}
                        onClick={episode.shots.length ? onDesignVisuals : () => onStageChange("script")}
                    >
                        {!episode.shots.length
                            ? "返回剧本并提取结构"
                            : visualFailure?.kind === "connection"
                              ? "检查任务状态"
                              : visualFailure?.kind === "terminal"
                                ? "重新生成视觉方案"
                                : episode.visualTaskId
                                  ? "视觉方案生成中"
                                  : episode.reviewStatus === "visual_ready"
                                    ? "更新视觉方案"
                                    : "确认内容并生成视觉方案"}
                    </Button>
                }
            />
            {visualFailure || episode.visualError ? (
                <Alert
                    className="mt-2.5"
                    type={visualFailure?.kind === "connection" ? "warning" : "error"}
                    showIcon
                    title={visualFailure?.kind === "connection" ? "与任务状态服务的连接中断" : "视觉方案未更新"}
                    description={visualFailure?.detail || episode.visualError}
                />
            ) : null}
            {episode.shots.length ? (
                <div className="mt-2.5 space-y-2.5">
                    {episode.shots.map((shot) => {
                        const expanded = expandedShotIds.has(shot.id);
                        const dialogueCount = shot.utterances.filter((item) => item.type === "dialogue").length || shot.dialogue.split(/\n+/).filter((line) => line.trim()).length;
                        const sourcePreview = compactReviewText(shot.sourceText || shot.description || "暂无原文依据");
                        return (
                            <article key={shot.id} className="rounded-lg border border-border bg-background p-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <span className="grid size-8 place-items-center rounded-md bg-muted text-xs font-semibold">{String(shot.order).padStart(2, "0")}</span>
                                    <Input variant="borderless" className="!min-w-0 !flex-1 !p-0 !font-semibold" value={shot.title} onChange={(event) => updateContentShot(shot.id, { title: event.target.value })} />
                                    <span className="hidden shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/45 px-2 py-1 text-[11px] text-muted-foreground sm:inline-flex">
                                        <span className="size-1.5 rounded-full bg-foreground/60" />
                                        可编辑内容
                                    </span>
                                    <Button
                                        size="small"
                                        className="!h-8 !shrink-0 !rounded-md !border-border/80 !px-2 !text-xs"
                                        icon={<ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />}
                                        iconPlacement="end"
                                        aria-expanded={expanded}
                                        onClick={() => toggleShot(shot.id)}
                                    >
                                        {expanded ? "收起" : "展开"}
                                    </Button>
                                </div>
                                {expanded ? (
                                    <>
                                        <div className="mt-3 grid gap-3 xl:grid-cols-2">
                                            <label className="block space-y-1.5 xl:col-span-2">
                                                <span className="text-xs font-medium text-muted-foreground">原文依据</span>
                                                <Input.TextArea
                                                    value={shot.sourceText}
                                                    onChange={(event) => updateContentShot(shot.id, { sourceText: event.target.value })}
                                                    autoSize={{ minRows: 2, maxRows: 5 }}
                                                    placeholder="保留这一镜头对应的连续原文，便于核对台词和动作"
                                                />
                                            </label>
                                            <label className="block space-y-1.5">
                                                <span className="text-xs font-medium text-muted-foreground">镜头事实</span>
                                                <Input.TextArea
                                                    value={shot.description}
                                                    onChange={(event) => updateContentShot(shot.id, { description: event.target.value })}
                                                    autoSize={{ minRows: 2, maxRows: 4 }}
                                                    placeholder="只写画面中能看到的动作、人物状态和环境事实"
                                                />
                                            </label>
                                            <label className="block space-y-1.5">
                                                <span className="text-xs font-medium text-muted-foreground">镜头边界</span>
                                                <Input.TextArea
                                                    value={shot.shotBoundary}
                                                    onChange={(event) => updateContentShot(shot.id, { shotBoundary: event.target.value })}
                                                    autoSize={{ minRows: 2, maxRows: 4 }}
                                                    placeholder="例如：说话人改变、动作反应或场景变化"
                                                />
                                            </label>
                                            <div className="min-w-0">
                                                <DramaShotDialogueEditor projectId={project.id} episodeId={episode.id} shot={shot} />
                                            </div>
                                            <label className="block space-y-1.5">
                                                <span className="text-xs font-medium text-muted-foreground">画外音（旁白）</span>
                                                <Input.TextArea
                                                    value={shot.narration}
                                                    onChange={(event) => updateContentShot(shot.id, { narration: event.target.value, subtitle: [shot.dialogue, event.target.value].filter(Boolean).join("\n") })}
                                                    autoSize={{ minRows: 2, maxRows: 5 }}
                                                    placeholder="只填写原文明确存在的旁白；没有旁白请留空"
                                                />
                                            </label>
                                        </div>
                                        <div className="mt-3 grid grid-cols-[auto_72px_auto] items-center gap-2 text-sm text-muted-foreground sm:grid-cols-[auto_88px_auto_minmax(0,1fr)]">
                                            <span className="whitespace-nowrap">镜头时长</span>
                                            <InputNumber className="!h-9 !w-[72px] sm:!w-[88px]" min={1} max={20} value={shot.duration} onChange={(value) => updateContentShot(shot.id, { duration: Number(value) || 5 })} />
                                            <span>秒</span>
                                            <span className="hidden min-w-0 text-right text-xs sm:block">视觉提示词将在确认后生成</span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                                        <span className="min-w-0 max-w-full truncate">原文：{sourcePreview}</span>
                                        <span>{dialogueCount ? `${dialogueCount} 句对白` : "暂无对白"}</span>
                                        <span>{shot.duration} 秒</span>
                                    </div>
                                )}
                            </article>
                        );
                    })}
                </div>
            ) : (
                <div className="mt-2.5 flex min-h-14 items-center rounded-lg border border-dashed border-border bg-card/25 px-3 py-2.5">
                    <div className="min-w-0">
                        <h3 className="text-sm font-medium">还没有待审核的内容结构</h3>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">先填写或导入本集剧本，再由 AI 提取可编辑的镜头事实、对白和原文依据。</p>
                    </div>
                </div>
            )}
            <Modal title="本集信息" open={episodeInfoOpen} width={620} centered destroyOnHidden footer={null} onCancel={() => setEpisodeInfoOpen(false)} styles={{ container: { maxWidth: "calc(100vw - 24px)" } }}>
                <div className="grid gap-3 pt-1 sm:grid-cols-2">
                    {[
                        ["本集大纲", "outline", "用一句话概括本集推进"],
                        ["来源范围", "sourceRange", "例如：原文第 1-3 节"],
                        ["结尾钩子", "hook", "本集结尾要留下的冲突"],
                        ["下集预告", "nextPreview", "下一集承接方向"],
                    ].map(([label, key, placeholder]) => (
                        <label key={key} className="block space-y-1.5">
                            <span className="text-xs font-medium text-muted-foreground">{label}</span>
                            <Input.TextArea
                                value={episode[key as "outline" | "sourceRange" | "hook" | "nextPreview"]}
                                onChange={(event) => updateEpisode(project.id, episode.id, { [key]: event.target.value })}
                                autoSize={{ minRows: 2, maxRows: 4 }}
                                placeholder={placeholder}
                            />
                        </label>
                    ))}
                </div>
            </Modal>
        </div>
    );
}

function compactReviewText(value: string) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
}
