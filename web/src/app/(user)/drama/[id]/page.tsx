"use client";

import { useEffect, useRef, useState } from "react";
import { App, Button, Empty } from "antd";
import { ArrowRight, History } from "lucide-react";
import { nanoid } from "nanoid";
import { useParams, useRouter } from "next/navigation";

import { createImageGenerationTask, waitForImageGenerationTask } from "@/services/api/image";
import { createServerVideoGenerationTask } from "@/services/api/video";
import { syncUserPointsFromHeaders } from "@/services/api/points";
import { compileDramaShotPrompts } from "@/lib/drama-prompt-compiler";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useDramaStore } from "../stores/use-drama-store";
import type { DramaContentAnalysis, DramaProject, DramaProjectVersion, DramaVisualAnalysis } from "../types";
import { useDramaAudioQueue } from "./use-drama-audio-queue";
import { DramaAgentPanel } from "./drama-agent-panel";
import { DramaAssetsPanel } from "./drama-assets-panel";
import { DramaStageHeader, stableTaskUrl } from "./drama-editor-elements";
import { DramaGenerationPanel } from "./drama-generation-panel";
import { DramaReviewPanel } from "./drama-review-panel";
import { DramaStoryboardShotCard } from "./drama-storyboard-shot-card";
import { DramaVersionModal } from "./drama-project-modals";
import { dramaGenerationSize, estimateTaskPoints, referenceImage, shotReferenceImages, storyboardReferenceImages } from "./drama-shot-generation-utils";
import { useGenerationCapacityRetry } from "./use-generation-capacity-retry";
import { DramaEpisodeSidebar, DramaScriptPanel, DramaWorkspaceHeader, type DramaProjectStage } from "./drama-project-sections";

export default function DramaProjectPage() {
    const router = useRouter();
    const projectId = String(useParams<{ id: string }>().id || "");
    const loadProject = useDramaStore((state) => state.loadProject);
    const project = useDramaStore((state) => state.projects.find((item) => item.id === projectId));
    const userId = useUserStore((state) => state.user?.id || "");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadError("");
        void loadProject(projectId)
            .catch((error) => active && setLoadError(error instanceof Error ? error.message : "短剧项目加载失败"))
            .finally(() => active && setLoading(false));
        return () => {
            active = false;
        };
    }, [loadProject, projectId, userId]);
    if (loading && !project) return <main className="grid h-full place-items-center bg-background text-sm text-muted-foreground">正在加载短剧项目…</main>;
    if (!project)
        return (
            <main className="grid h-full place-items-center bg-background">
                <Empty description={loadError || "短剧项目不存在"}>
                    <Button onClick={() => router.push("/drama")}>返回项目列表</Button>
                </Empty>
            </main>
        );
    return <DramaProjectEditor project={project} />;
}

function DramaProjectEditor({ project }: { project: DramaProject }) {
    const { message } = App.useApp();
    const router = useRouter();
    const updateProject = useDramaStore((state) => state.updateProject);
    const updateEpisode = useDramaStore((state) => state.updateEpisode);
    const updateShot = useDramaStore((state) => state.updateShot);
    const applyContentAnalysis = useDramaStore((state) => state.applyContentAnalysis);
    const applyVisualAnalysis = useDramaStore((state) => state.applyVisualAnalysis);
    const createVersion = useDramaStore((state) => state.createVersion);
    const listVersions = useDramaStore((state) => state.listVersions);
    const restoreVersion = useDramaStore((state) => state.restoreVersion);
    const config = useEffectiveConfig();
    const startingShotRef = useRef("");
    const storyboardTaskRef = useRef("");
    const [stage, setStage] = useState<DramaProjectStage>("script");
    const [assetsOpen, setAssetsOpen] = useState(false);
    const [episodeNavigatorOpen, setEpisodeNavigatorOpen] = useState(false);
    const [agentOpen, setAgentOpen] = useState(false);
    const [selectedShotId, setSelectedShotId] = useState<string>();
    const [analyzing, setAnalyzing] = useState(false);
    const [designing, setDesigning] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [versions, setVersions] = useState<DramaProjectVersion[]>([]);
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [expandedStoryboardShotId, setExpandedStoryboardShotId] = useState("");
    const { isWaiting: isCapacityWaiting, schedule: scheduleCapacityRetry } = useGenerationCapacityRetry();
    const audioReady = Boolean(config.audioModel.trim());
    const changeStage = (nextStage: DramaProjectStage) => {
        setStage(nextStage);
        setAssetsOpen(false);
    };

    const episode = project.episodes.find((item) => item.id === project.activeEpisodeId) || project.episodes[0];
    useEffect(() => {
        const media = window.matchMedia("(min-width: 1366px)");
        const update = () => {
            setEpisodeNavigatorOpen(media.matches);
        };
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        setSelectedShotId(undefined);
    }, [episode.id]);
    useDramaAudioQueue(project, episode, config, updateShot);
    const analyzeScript = async () => {
        if (!episode.script.trim()) return message.warning("请先填写剧本内容");
        setAnalyzing(true);
        try {
            const response = await fetch("/api/drama/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: `drama-content:${project.id}:${episode.id}:${nanoid()}`, phase: "content", script: episode.script, summary: project.summary, style: project.style, videoModel: config.videoModel || config.model }),
            });
            syncUserPointsFromHeaders(response.headers, "system");
            const payload = (await response.json().catch(() => ({}))) as { data?: DramaContentAnalysis; msg?: string };
            if (!response.ok || !payload.data) throw new Error(payload.msg || "AI 剧本解析失败");
            await createVersion(project, "AI 内容解析前");
            applyContentAnalysis(project.id, episode.id, payload.data);
            setStage("review");
            message.success(`已提取 ${payload.data.characters.length} 个角色、${payload.data.scenes.length} 个场景和 ${payload.data.shots.length} 个待审核镜头`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "AI 剧本解析失败");
        } finally {
            setAnalyzing(false);
        }
    };
    const designVisuals = async () => {
        if (!episode.shots.length) return message.warning("请先完成内容解析");
        updateEpisode(project.id, episode.id, { reviewStatus: "approved" });
        setDesigning(true);
        try {
            const response = await fetch("/api/drama/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    requestId: `drama-visual:${project.id}:${episode.id}:${nanoid()}`,
                    phase: "visual",
                    summary: project.summary,
                    style: project.style,
                    episode: {
                        id: episode.id,
                        title: episode.title,
                        outline: episode.outline,
                        hook: episode.hook,
                        nextPreview: episode.nextPreview,
                        sourceRange: episode.sourceRange,
                    },
                    characters: project.characters,
                    scenes: project.scenes,
                    props: project.props,
                    clues: project.clues,
                    shots: episode.shots,
                }),
            });
            syncUserPointsFromHeaders(response.headers, "system");
            const payload = (await response.json().catch(() => ({}))) as { data?: DramaVisualAnalysis; msg?: string };
            if (!response.ok || !payload.data) throw new Error(payload.msg || "AI 视觉方案生成失败");
            await createVersion(project, "视觉方案生成前");
            applyVisualAnalysis(project.id, episode.id, payload.data);
            setStage("storyboard");
            message.success("已按审核内容生成视觉方案");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "AI 视觉方案生成失败");
        } finally {
            setDesigning(false);
        }
    };
    const openVersions = async () => {
        setVersionsOpen(true);
        setVersionsLoading(true);
        try {
            setVersions(await listVersions(project.id));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "版本记录加载失败");
        } finally {
            setVersionsLoading(false);
        }
    };
    const restore = async (version: DramaProjectVersion) => {
        try {
            await restoreVersion(project.id, version.id);
            setVersionsOpen(false);
            setStage("review");
            message.success(`已恢复到版本 ${version.version}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "版本恢复失败");
        }
    };
    useEffect(() => {
        const runningEnd = episode.shots.find((shot) => shot.storyboardEndStatus === "running" && shot.storyboardEndTaskId);
        if (runningEnd) {
            const key = `${episode.id}:${runningEnd.id}:${runningEnd.storyboardEndTaskId}`;
            if (storyboardTaskRef.current === key) return;
            storyboardTaskRef.current = key;
            const imageConfig = { ...config, model: config.imageModel || config.model, imageModel: config.imageModel || config.model, size: project.ratio, count: "1" };
            void waitForImageGenerationTask(imageConfig, { id: runningEnd.storyboardEndTaskId!, kind: "generation", model: imageConfig.model })
                .then((result) => {
                    const imageUrl = stableTaskUrl(result.remoteUrl, result.serverUrl, result.dataUrl);
                    if (!imageUrl) throw new Error("尾帧图没有可持久化的访问地址");
                    updateShot(project.id, episode.id, runningEnd.id, {
                        storyboardEndStatus: "success",
                        storyboardEndImageUrl: imageUrl,
                        storyboardEndImageWidth: result.width,
                        storyboardEndImageHeight: result.height,
                        storyboardEndError: undefined,
                        generationStatus: "queued",
                    });
                })
                .catch((error) => updateShot(project.id, episode.id, runningEnd.id, { storyboardEndStatus: "error", storyboardEndError: error instanceof Error ? error.message : "尾帧图生成失败" }))
                .finally(() => {
                    storyboardTaskRef.current = "";
                });
            return;
        }
        const running = episode.shots.find((shot) => shot.storyboardStatus === "running" && shot.storyboardTaskId);
        if (running) {
            const key = `${episode.id}:${running.id}:${running.storyboardTaskId}`;
            if (storyboardTaskRef.current === key) return;
            storyboardTaskRef.current = key;
            const imageConfig = { ...config, model: config.imageModel || config.model, imageModel: config.imageModel || config.model, size: project.ratio, count: "1" };
            void waitForImageGenerationTask(imageConfig, { id: running.storyboardTaskId!, kind: "generation", model: imageConfig.model })
                .then((result) => {
                    const imageUrl = stableTaskUrl(result.remoteUrl, result.serverUrl, result.dataUrl);
                    if (!imageUrl) throw new Error("分镜图没有可持久化的访问地址");
                    const hasEndFrame = running.storyboardFrameMode === "first_last" && running.storyboardEndStatus === "success" && Boolean(running.storyboardEndImageUrl);
                    updateShot(project.id, episode.id, running.id, {
                        storyboardStatus: "success",
                        storyboardImageUrl: imageUrl,
                        storyboardImageWidth: result.width,
                        storyboardImageHeight: result.height,
                        storyboardError: undefined,
                        storyboardEndStatus: running.storyboardFrameMode === "first_last" ? (hasEndFrame ? "success" : "queued") : "idle",
                        generationStatus: running.storyboardFrameMode === "first_last" && !hasEndFrame ? "idle" : "queued",
                    });
                })
                .catch((error) => updateShot(project.id, episode.id, running.id, { storyboardStatus: "error", storyboardError: error instanceof Error ? error.message : "分镜图生成失败" }))
                .finally(() => {
                    storyboardTaskRef.current = "";
                });
            return;
        }
        const nextEnd = episode.shots.find((shot) => shot.storyboardEndStatus === "queued" && shot.storyboardImageUrl);
        if (nextEnd && !storyboardTaskRef.current) {
            const retryKey = `storyboard-end:${nextEnd.id}`;
            if (isCapacityWaiting(retryKey)) return;
            storyboardTaskRef.current = `${episode.id}:${nextEnd.id}:creating-end`;
            const prompt = compileDramaShotPrompts(project, episode, nextEnd).endFramePrompt;
            const references = [referenceImage(`storyboard-start-${nextEnd.id}`, `${nextEnd.title}-起始帧.png`, nextEnd.storyboardImageUrl!, "image/png", nextEnd.storyboardImageWidth, nextEnd.storyboardImageHeight)];
            const imageConfig = { ...config, model: config.imageModel || config.model, imageModel: config.imageModel || config.model, size: dramaGenerationSize(project, prompt, references), count: "1" };
            void createImageGenerationTask(imageConfig, prompt, references, undefined, {
                logSource: "drama",
                logTitle: `${project.title} · ${nextEnd.title}尾帧`,
                conversationId: project.creativeConversationId,
                surface: "drama",
                projectId: project.id,
                episodeId: episode.id,
                shotId: nextEnd.id,
                estimatedPoints: estimateTaskPoints(config, "image"),
                attemptNo: nextEnd.storyboardEndAttempt || 1,
                clientRequestId: `drama-storyboard-end:${project.id}:${episode.id}:${nextEnd.id}:attempt-${nextEnd.storyboardEndAttempt || 1}`,
            })
                .then((task) => updateShot(project.id, episode.id, nextEnd.id, { storyboardEndStatus: "running", storyboardEndTaskId: task.id, storyboardEndError: undefined }))
                .catch((error) =>
                    scheduleCapacityRetry(retryKey, error)
                        ? updateShot(project.id, episode.id, nextEnd.id, { storyboardEndStatus: "queued", storyboardEndError: undefined })
                        : updateShot(project.id, episode.id, nextEnd.id, { storyboardEndStatus: "error", storyboardEndError: error instanceof Error ? error.message : "尾帧图任务创建失败" }),
                )
                .finally(() => {
                    storyboardTaskRef.current = "";
                });
            return;
        }
        const next = episode.shots.find((shot) => shot.storyboardStatus === "queued");
        if (!next || storyboardTaskRef.current) return;
        const retryKey = `storyboard:${next.id}`;
        if (isCapacityWaiting(retryKey)) return;
        storyboardTaskRef.current = `${episode.id}:${next.id}:creating`;
        const prompts = compileDramaShotPrompts(project, episode, next);
        const references = shotReferenceImages(project, next);
        const imageConfig = { ...config, model: config.imageModel || config.model, imageModel: config.imageModel || config.model, size: dramaGenerationSize(project, prompts.imagePrompt, references), count: "1" };
        void createImageGenerationTask(imageConfig, prompts.imagePrompt, references, undefined, {
            logSource: "drama",
            logTitle: `${project.title} · ${next.title}`,
            conversationId: project.creativeConversationId,
            surface: "drama",
            projectId: project.id,
            episodeId: episode.id,
            shotId: next.id,
            estimatedPoints: estimateTaskPoints(config, "image"),
            attemptNo: next.storyboardAttempt || 1,
            clientRequestId: `drama-storyboard:${project.id}:${episode.id}:${next.id}:attempt-${next.storyboardAttempt || 1}`,
        })
            .then((task) => updateShot(project.id, episode.id, next.id, { storyboardStatus: "running", storyboardTaskId: task.id, storyboardError: undefined }))
            .catch((error) =>
                scheduleCapacityRetry(retryKey, error)
                    ? updateShot(project.id, episode.id, next.id, { storyboardStatus: "queued", storyboardError: undefined })
                    : updateShot(project.id, episode.id, next.id, { storyboardStatus: "error", storyboardError: error instanceof Error ? error.message : "分镜图任务创建失败" }),
            )
            .finally(() => {
                storyboardTaskRef.current = "";
            });
    }, [config, episode.id, episode.shots, isCapacityWaiting, project.id, project.ratio, project.title, scheduleCapacityRetry, updateShot]);

    useEffect(() => {
        const running = episode.shots.find((shot) => shot.generationStatus === "running" && shot.generationTaskId);
        if (!running) return;
        const timer = window.setInterval(async () => {
            const response = await fetch(`/api/video-tasks/${encodeURIComponent(running.generationTaskId!)}`, { cache: "no-store" });
            syncUserPointsFromHeaders(response.headers, "system");
            const payload = (await response.json().catch(() => ({}))) as { task?: { status?: string; result?: { url?: string }; error?: string }; error?: string };
            if (!response.ok) return updateShot(project.id, episode.id, running.id, { generationStatus: "error", generationError: payload.error || "视频任务查询失败" });
            if (payload.task?.status === "success")
                updateShot(project.id, episode.id, running.id, {
                    generationStatus: "success",
                    videoUrl: payload.task.result?.url,
                    generationError: undefined,
                    ...(running.audioMode === "voiceover" && (running.subtitle || running.dialogue).trim() && audioReady ? { audioStatus: "queued" as const, audioError: undefined } : {}),
                });
            if (payload.task?.status === "error" || payload.task?.status === "cancelled") updateShot(project.id, episode.id, running.id, { generationStatus: payload.task.status, generationError: payload.task.error });
        }, 2500);
        return () => window.clearInterval(timer);
    }, [audioReady, episode.id, episode.shots, project.id, updateShot]);

    useEffect(() => {
        if (episode.shots.some((shot) => shot.generationStatus === "running")) return;
        const next = episode.shots.find((shot) => shot.generationStatus === "queued");
        if (!next || startingShotRef.current === next.id) return;
        const retryKey = `video:${next.id}`;
        if (isCapacityWaiting(retryKey)) return;
        startingShotRef.current = next.id;
        const mode = next.videoMode || project.defaultVideoMode;
        const references = mode === "reference" ? shotReferenceImages(project, next) : storyboardReferenceImages(next);
        const prompts = compileDramaShotPrompts(project, episode, next);
        if (mode === "reference" && !references.length) {
            updateShot(project.id, episode.id, next.id, { generationStatus: "error", generationError: "参考图模式需要先为关联角色、场景、道具或项目素材配置参考图" });
            startingShotRef.current = "";
            return;
        }
        if (mode === "storyboard" && !next.storyboardImageUrl) {
            updateShot(project.id, episode.id, next.id, { generationStatus: "error", generationError: "分镜模式需要先生成或上传起始帧" });
            startingShotRef.current = "";
            return;
        }
        if (mode === "storyboard" && next.storyboardFrameMode === "first_last" && !next.storyboardEndImageUrl) {
            updateShot(project.id, episode.id, next.id, { generationStatus: "error", generationError: "首尾帧模式需要先生成或上传结束帧" });
            startingShotRef.current = "";
            return;
        }
        void createServerVideoGenerationTask(
            { ...config, model: config.videoModel || config.model, size: dramaGenerationSize(project, prompts.videoPrompt, references), videoSeconds: String(next.duration), videoGenerateAudio: String((next.audioMode || "source") === "source") },
            prompts.videoPrompt,
            references,
            [],
            [],
            {
                conversationId: project.creativeConversationId,
                surface: "drama",
                projectId: project.id,
                episodeId: episode.id,
                shotId: next.id,
                estimatedPoints: estimateTaskPoints(config, "video", next.duration),
                parentTaskId: next.storyboardTaskId,
                attemptNo: next.generationAttempt || 1,
                clientRequestId: `drama-video:${project.id}:${episode.id}:${next.id}:attempt-${next.generationAttempt || 1}`,
            },
        )
            .then((task) => updateShot(project.id, episode.id, next.id, { generationStatus: "running", generationTaskId: task.serverTaskId || task.id, generationError: undefined }))
            .catch((error) =>
                scheduleCapacityRetry(retryKey, error)
                    ? updateShot(project.id, episode.id, next.id, { generationStatus: "queued", generationError: undefined })
                    : updateShot(project.id, episode.id, next.id, { generationStatus: "error", generationError: error instanceof Error ? error.message : "视频任务创建失败" }),
            )
            .finally(() => {
                startingShotRef.current = "";
            });
    }, [config, episode.id, episode.shots, isCapacityWaiting, project, scheduleCapacityRetry, updateShot]);

    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-drama-workspace aria-label="短剧制作工作区">
            <DramaWorkspaceHeader
                project={project}
                episode={episode}
                stage={stage}
                assetsOpen={assetsOpen}
                episodeNavigatorOpen={episodeNavigatorOpen}
                agentOpen={agentOpen}
                onStageChange={changeStage}
                onOpenAssets={() => {
                    setAssetsOpen(true);
                    setAgentOpen(false);
                    setEpisodeNavigatorOpen(false);
                }}
                onCloseAssets={() => setAssetsOpen(false)}
                onEpisodeNavigatorOpenChange={setEpisodeNavigatorOpen}
                onToggleAgent={() => setAgentOpen((open) => !open)}
                onOpenVersions={() => void openVersions()}
            />
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-drama-workspace-body>
                <DramaEpisodeSidebar project={project} episode={episode} open={episodeNavigatorOpen && !assetsOpen} onOpenChange={setEpisodeNavigatorOpen} onStageChange={changeStage} />
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-drama-production-surface>
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-drama-production-scroll>
                        <section
                            className={`mx-auto flex min-h-full min-w-0 flex-col px-3 py-3 ${stage === "script" ? "max-w-none min-[1366px]:px-3 min-[1366px]:pb-3 min-[1366px]:pt-3" : "max-w-[1440px] sm:px-5 sm:py-4"}`}
                            data-drama-stage={assetsOpen ? "assets" : stage}
                        >
                            {assetsOpen ? <DramaAssetsPanel project={project} episode={episode} /> : null}

                            {!assetsOpen && stage === "script" ? (
                                <DramaScriptPanel project={project} episode={episode} analyzing={analyzing} onAnalyze={() => void analyzeScript()} onStageChange={changeStage} selectedShotId={selectedShotId} onSelectedShotChange={setSelectedShotId} />
                            ) : null}

                            {!assetsOpen && stage === "review" ? <DramaReviewPanel project={project} episode={episode} designing={designing} onDesignVisuals={() => void designVisuals()} onStageChange={changeStage} /> : null}

                            {!assetsOpen && stage === "storyboard" ? (
                                <div>
                                    <DramaStageHeader
                                        step="03"
                                        title="分镜编辑"
                                        description="精调画面、镜头运动、生成方式和配音策略；完成后进入统一镜头生产队列。"
                                        status={
                                            !episode.shots.length ? "等待镜头" : episode.shots.every((shot) => shot.videoPrompt.trim() && ((shot.videoMode || project.defaultVideoMode) !== "storyboard" || shot.imagePrompt.trim())) ? "配置就绪" : "需要补充"
                                        }
                                        tone={
                                            !episode.shots.length ? "attention" : episode.shots.every((shot) => shot.videoPrompt.trim() && ((shot.videoMode || project.defaultVideoMode) !== "storyboard" || shot.imagePrompt.trim())) ? "ready" : "attention"
                                        }
                                        metrics={
                                            episode.shots.length
                                                ? [
                                                      { label: "镜头", value: episode.shots.length },
                                                      { label: "总时长", value: `${episode.shots.reduce((total, shot) => total + shot.duration, 0)} 秒` },
                                                      { label: "参考图模式", value: episode.shots.filter((shot) => (shot.videoMode || project.defaultVideoMode) === "reference").length },
                                                  ]
                                                : []
                                        }
                                        action={
                                            <Button
                                                type="primary"
                                                className="!h-9 !w-full sm:!w-auto"
                                                icon={<ArrowRight className="size-4" />}
                                                disabled={!episode.shots.length || episode.reviewStatus !== "visual_ready"}
                                                onClick={() => setStage("generate")}
                                            >
                                                进入镜头生成
                                            </Button>
                                        }
                                    />
                                    {episode.shots.length ? (
                                        <div className="mt-3 grid min-w-0 items-start gap-3 xl:grid-cols-2">
                                            {episode.shots.map((shot) => (
                                                <DramaStoryboardShotCard
                                                    key={shot.id}
                                                    project={project}
                                                    episodeId={episode.id}
                                                    shot={shot}
                                                    expanded={expandedStoryboardShotId === shot.id}
                                                    onToggle={() => setExpandedStoryboardShotId((current) => (current === shot.id ? "" : shot.id))}
                                                />
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="mt-2.5 flex min-h-14 items-center rounded-lg border border-dashed border-border bg-card/25 px-3 py-2.5">
                                            <div className="min-w-0">
                                                <h3 className="text-sm font-medium">还没有可编辑的分镜</h3>
                                                <p className="mt-0.5 truncate text-xs text-muted-foreground">先从剧本提取内容结构，并在内容审核阶段确认镜头事实与视觉方案。</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : null}

                            {!assetsOpen && stage === "generate" ? <DramaGenerationPanel project={project} episode={episode} onStageChange={changeStage} onOpenAssets={() => setAssetsOpen(true)} /> : null}
                        </section>
                    </div>
                </div>
                <DramaAgentPanel
                    project={project}
                    episode={episode}
                    stage={stage}
                    selectedShotId={selectedShotId}
                    open={agentOpen}
                    onOpenChange={setAgentOpen}
                    onConversationChange={(creativeConversationId) => updateProject(project.id, { creativeConversationId })}
                />
            </div>
            {stage === "script" ? (
                <DramaScriptGlobalBar
                    project={project}
                    episode={episode}
                    onSave={() => createVersion(project, "手动保存版本")}
                    onContinue={() => {
                        if (!episode.shots.length) return void analyzeScript();
                        if (episode.reviewStatus === "draft") updateEpisode(project.id, episode.id, { reviewStatus: "content_review" });
                        setStage("review");
                    }}
                    analyzing={analyzing}
                    episodeNavigatorOpen={episodeNavigatorOpen}
                />
            ) : null}
            <DramaVersionModal
                open={versionsOpen}
                loading={versionsLoading}
                versions={versions}
                onClose={() => setVersionsOpen(false)}
                onSave={() => void createVersion(project, "手动保存版本").then(() => openVersions())}
                onRestore={(version) => void restore(version)}
            />
        </main>
    );
}

function DramaScriptGlobalBar({
    project,
    episode,
    onSave,
    onContinue,
    analyzing,
    episodeNavigatorOpen,
}: {
    project: DramaProject;
    episode: DramaProject["episodes"][number];
    onSave: () => Promise<void>;
    onContinue: () => void;
    analyzing: boolean;
    episodeNavigatorOpen: boolean;
}) {
    const { message } = App.useApp();
    const saveState = useDramaStore((state) => state.saveStateByProject[project.id]);
    const [savingVersion, setSavingVersion] = useState(false);
    const savedLabel =
        saveState?.status === "saving"
            ? "保存中…"
            : saveState?.status === "error"
              ? "保存失败"
              : saveState?.savedAt
                ? `最近保存 ${new Date(saveState.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : `最近保存 ${new Date(project.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    return (
        <footer className={`flex h-[60px] shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-3 sm:gap-3 sm:px-5 ${episodeNavigatorOpen ? "min-[1366px]:!pl-[210px]" : ""}`} data-drama-script-global-bar>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className={`size-2 shrink-0 rounded-full ${saveState?.status === "error" ? "bg-rose-500" : saveState?.status === "saving" ? "bg-amber-500" : "bg-emerald-500"}`} />
                <span className="hidden sm:inline" title={savedLabel}>
                    {saveState?.status === "saving" ? "正在自动保存" : saveState?.status === "error" ? "自动保存失败" : "自动保存已开启"}
                </span>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                <Button
                    className="!h-10 !px-3 sm:!px-5"
                    loading={savingVersion}
                    onClick={() => {
                        setSavingVersion(true);
                        void onSave()
                            .then(() => message.success("草稿版本已保存"))
                            .catch((error) => message.error(error instanceof Error ? error.message : "草稿保存失败"))
                            .finally(() => setSavingVersion(false));
                    }}
                >
                    <span className="sm:hidden">保存</span>
                    <span className="hidden sm:inline">保存草稿</span>
                </Button>
                <Button
                    type="primary"
                    className="!h-10 !px-3 enabled:!border-violet-600 enabled:!bg-violet-600 enabled:!text-white enabled:hover:!border-violet-500 enabled:hover:!bg-violet-500 dark:enabled:!border-violet-400 dark:enabled:!bg-violet-400 dark:enabled:!text-violet-950 sm:!px-6"
                    icon={<ArrowRight className="size-4" />}
                    disabled={!episode.script.trim()}
                    loading={analyzing}
                    onClick={onContinue}
                >
                    <span className="sm:hidden">进入内容审核</span>
                    <span className="hidden sm:inline">完成剧本，进入内容审核</span>
                </Button>
            </div>
        </footer>
    );
}
