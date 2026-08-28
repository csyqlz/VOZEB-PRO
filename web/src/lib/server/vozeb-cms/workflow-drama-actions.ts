import { getAuthSettings } from "@/lib/auth/store";
import type { DramaContentAnalysis, DramaEpisode, DramaProject, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import { applyDramaContentAnalysisToProject, applyDramaVisualAnalysisToProject } from "@/lib/server/drama-analysis-project";
import { mutateDramaProjectForUser } from "@/lib/server/drama-project-service";
import { getDramaProject } from "@/lib/server/drama-project-store";
import { toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { generationTaskNextPollAt } from "@/lib/server/generation-task-scheduler";
import { getStoredGenerationTaskByRequest, getStoredGenerationTaskRecordForUser, linkStoredGenerationTask, type StoredGenerationTaskRecord } from "@/lib/server/generation-task-store";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { maintenanceWorkerHeaders } from "@/lib/server/maintenance-auth";
import { scheduleGenerationTask } from "@/lib/server/generation-task-scheduler";
import { createTextTask, type TextTask } from "@/lib/server/text-task-store";
import type { VideoTask } from "@/lib/server/video-task-store";
import type { NodeExecutionResult, NodeExecutor } from "./workflow-execution-contract";

export const executeVozebCmsDramaWorkflowAction: NodeExecutor = async (input) => {
    const actionId = text(input.node.config.actionId);
    const projectId = input.run.projectRef?.type === "drama" ? input.run.projectRef.id : input.run.projectId;
    if (!projectId) return { status: "failed", error: "短剧工作流缺少项目标识" };
    const project = await getDramaProject(projectId, input.userId);
    if (!project) return { status: "failed", error: "短剧项目不存在或已被删除" };
    const episodeId = text(input.run.context.episodeId);
    if (!episodeId) return { status: "failed", error: "短剧工作流缺少剧集标识" };
    const episode = project.episodes.find((item) => item.id === episodeId);
    if (!episode) return { status: "failed", error: "短剧工作流指定的剧集不存在" };
    try {
        if (actionId === "drama.script.require") return requireScript(project, episode);
        if (actionId === "drama.content.analyze") return await executeAnalysis(input, project, episode, "content");
        if (actionId === "drama.visual.plan") return await executeAnalysis(input, project, episode, "visual");
        if (actionId === "drama.video.generate") return await executeVideoGeneration(input, project, episode);
        if (actionId === "drama.asset.commit") return commitAssets(project, episode);
        return { status: "failed", error: `工作流 Action 未注册：${actionId}` };
    } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : `${input.node.name} 执行失败` };
    }
};

function requireScript(project: DramaProject, episode: DramaEpisode): NodeExecutionResult {
    return episode.script.trim() ? { status: "success", output: { projectId: project.id, episodeId: episode.id } } : { status: "failed", error: "当前剧集还没有可执行剧本" };
}

async function executeAnalysis(input: Parameters<NodeExecutor>[0], project: DramaProject, episode: DramaEpisode, phase: "content" | "visual"): Promise<NodeExecutionResult> {
    if (phase === "content" && episode.reviewStatus !== "draft" && episode.shots.length) return { status: "success", output: analysisSummary(project, episode) };
    if (phase === "visual" && episode.reviewStatus === "visual_ready" && episode.shots.every((shot) => shot.imagePrompt && shot.videoPrompt)) return { status: "success", output: analysisSummary(project, episode) };
    if (phase === "visual" && !episode.shots.length) return { status: "failed", error: "视觉方案缺少已审核的镜头结构" };
    const requestId = nodeRequestId(input.run.id, input.node.id);
    const task = await resolveOrCreateAnalysisTask(input.userId, input.run.id, requestId, project, episode, phase, input.state.taskId);
    if (task.status === "error" || task.status === "cancelled") return { status: "failed", taskId: task.id, error: task.error || `${phase === "content" ? "内容分析" : "视觉方案"}任务失败` };
    if (task.status !== "success") return { status: "waiting", taskId: task.id, nextRunAt: generationTaskNextPollAt({ submittedAt: task.createdAt }) };
    const result = parseAnalysisResult(task);
    const updated = await mutateDramaProjectForUser(input.userId, project.id, (current) =>
        phase === "content" ? applyDramaContentAnalysisToProject(current, episode.id, result as DramaContentAnalysis) : applyDramaVisualAnalysisToProject(current, episode.id, result as DramaVisualAnalysis),
    );
    const updatedEpisode = updated.episodes.find((item) => item.id === episode.id);
    if (!updatedEpisode) return { status: "failed", taskId: task.id, error: "短剧分析完成后剧集已不存在" };
    return { status: "success", taskId: task.id, output: analysisSummary(updated, updatedEpisode) };
}

async function resolveOrCreateAnalysisTask(userId: string, runId: string, requestId: string, project: DramaProject, episode: DramaEpisode, phase: "content" | "visual", taskId?: string) {
    if (taskId) {
        const task = await getStoredGenerationTaskRecordForUser(taskId, userId);
        if (task?.type === "text") return task.payload as unknown as TextTask;
    }
    const existing = await getStoredGenerationTaskByRequest<TextTask>("text", userId, requestId, 1);
    if (existing) return existing;
    const settings = await getAuthSettings();
    const candidates = resolveLogicalModelCandidates(settings, "text", settings.defaultModels.textModel).map(toSystemGenerationChannel);
    if (!candidates.length) throw new Error("后台尚未配置可用的默认文本模型");
    const body =
        phase === "content"
            ? { requestId, projectId: project.id, phase, script: episode.script, summary: project.summary, videoModel: project.videoModel }
            : {
                  requestId,
                  projectId: project.id,
                  phase,
                  summary: project.summary,
                  style: project.style,
                  videoModel: project.videoModel,
                  episode,
                  characters: project.characters,
                  scenes: project.scenes,
                  props: project.props,
                  clues: project.clues,
                  shots: episode.shots,
              };
    const task = await createTextTask({
        userId,
        runId,
        surface: "drama",
        projectId: project.id,
        episodeId: episode.id,
        clientRequestId: requestId,
        attemptNo: 1,
        config: candidates[0],
        candidateConfigs: candidates.slice(1),
        messages: [{ role: "user", content: episode.script }],
        dramaAnalysis: { body },
    });
    await linkStoredGenerationTask("text", task.id, { runId, surface: "drama", projectId: project.id, episodeId: episode.id, clientRequestId: requestId, attemptNo: 1 });
    await scheduleGenerationTask("text", task.id, { executionPhase: "created", channelId: task.config.channelId, provider: task.config.advancedConfig?.protocol || task.config.apiFormat, nextPollAt: Date.now(), lastUpstreamStatus: "created" });
    return task;
}

async function executeVideoGeneration(input: Parameters<NodeExecutor>[0], project: DramaProject, episode: DramaEpisode): Promise<NodeExecutionResult> {
    if (!episode.shots.length) return { status: "failed", error: "当前剧集没有可生成镜头" };
    const failedShot = episode.shots.find((shot) => shot.generationStatus === "error" && !shot.generationTaskId);
    if (failedShot) return { status: "failed", error: failedShot.generationError || `镜头 ${failedShot.id} 视频生成失败` };
    if (episode.shots.every((shot) => shot.videoUrl)) {
        return {
            status: "success",
            taskIds: episode.shots.flatMap((shot) => shot.generationTaskId || []),
            output: episode.shots.map((shot) => ({ type: "video" as const, url: shot.videoUrl!, mimeType: "video/mp4", shotId: shot.id, taskId: shot.generationTaskId })),
        };
    }
    const tasks = await Promise.all(
        episode.shots.map(async (shot) => {
            if (shot.videoUrl) return { shot, url: shot.videoUrl };
            const requestId = `${nodeRequestId(input.run.id, input.node.id)}:shot:${shot.id}`;
            let record = shot.generationTaskId ? await getStoredGenerationTaskRecordForUser(shot.generationTaskId, input.userId) : null;
            if (!record) {
                const existing = await getStoredGenerationTaskByRequest<VideoTask>("video", input.userId, requestId, 1);
                if (existing) record = await getStoredGenerationTaskRecordForUser(existing.id, input.userId);
            }
            if (!record) {
                const taskId = await createVideoTask(input.userId, input.run.id, requestId, project, episode, shot);
                record = await getStoredGenerationTaskRecordForUser(taskId, input.userId);
            }
            if (!record || record.type !== "video") throw new Error(`镜头 ${shot.id} 的视频任务未成功登记`);
            return { shot, record, url: videoUrl(record) };
        }),
    );
    const records = tasks.flatMap((item) => item.record || []);
    const taskIds = records.map((record) => record.id);
    await mutateDramaProjectForUser(input.userId, project.id, (current) => ({
        ...current,
        episodes: current.episodes.map((currentEpisode) =>
            currentEpisode.id !== episode.id
                ? currentEpisode
                : {
                      ...currentEpisode,
                      shots: currentEpisode.shots.map((shot) => {
                          const item = tasks.find((candidate) => candidate.shot.id === shot.id);
                          if (!item?.record) return shot;
                          return {
                              ...shot,
                              generationTaskId: item.record.id,
                              generationStatus: item.record.status === "success" ? "success" : item.record.status === "error" ? "error" : item.record.status === "cancelled" ? "cancelled" : "running",
                              ...(item.url ? { videoUrl: item.url } : {}),
                          };
                      }),
                  },
        ),
    }));
    const failed = records.find((record) => record.status === "error" || record.status === "cancelled");
    if (failed) return { status: "failed", taskId: failed.id, taskIds, error: text(failed.payload.error) || `视频任务 ${failed.id} 执行失败` };
    if (records.some((record) => record.status !== "success")) {
        const nextRunAt = records
            .map((record) => record.nextPollAt)
            .filter((value): value is number => Boolean(value))
            .sort((a, b) => a - b)[0];
        return { status: "waiting", taskId: taskIds[0], taskIds, nextRunAt };
    }
    const outputs = tasks.flatMap((item) => (item.url ? [{ type: "video" as const, url: item.url, mimeType: "video/mp4", shotId: item.shot.id, taskId: item.record?.id }] : []));
    return outputs.length === episode.shots.length ? { status: "success", taskId: taskIds[0], taskIds, output: outputs } : { status: "failed", taskIds, error: "视频任务已完成但结果地址缺失" };
}

async function createVideoTask(userId: string, runId: string, requestId: string, project: DramaProject, episode: DramaEpisode, shot: DramaEpisode["shots"][number]) {
    const origin = resolveInternalOrigin(process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000");
    const references = [
        ...(shot.storyboardImageUrl ? [{ type: "image", role: "first_frame", url: shot.storyboardImageUrl }] : []),
        ...(shot.storyboardFrameMode === "first_last" && shot.storyboardEndImageUrl ? [{ type: "image", role: "last_frame", url: shot.storyboardEndImageUrl }] : []),
    ];
    const headers = new Headers({ "content-type": "application/json", "x-vozeb-pro-client-request-id": requestId, "x-vozeb-pro-attempt-no": "1", ...maintenanceWorkerHeaders(userId) });
    const response = await fetchInternalApi(`${origin}/api/video-generation-tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            config: { model: shot.videoModel || project.videoModel || "", size: project.ratio, videoSeconds: String(shot.duration), videoGenerateAudio: String((shot.audioMode || "source") === "source") },
            prompt: shot.videoPrompt || shot.description || shot.sourceText,
            references,
            source: "drama",
            context: { runId, surface: "drama", projectId: project.id, episodeId: episode.id, shotId: shot.id, attemptNo: 1, clientRequestId: requestId },
        }),
        cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as { task?: { id?: string }; error?: string } | null;
    if (!response.ok || !payload?.task?.id) throw new Error(payload?.error || `镜头 ${shot.id} 的视频任务创建失败`);
    return payload.task.id;
}

function commitAssets(project: DramaProject, episode: DramaEpisode): NodeExecutionResult {
    const assets = episode.shots.flatMap((shot) => [
        ...(shot.videoUrl ? [{ type: "video" as const, url: shot.videoUrl, mimeType: "video/mp4", taskId: shot.generationTaskId }] : []),
        ...(shot.storyboardImageUrl ? [{ type: "image" as const, url: shot.storyboardImageUrl, mimeType: "image/png", taskId: shot.storyboardTaskId }] : []),
        ...(shot.storyboardEndImageUrl ? [{ type: "image" as const, url: shot.storyboardEndImageUrl, mimeType: "image/png", taskId: shot.storyboardEndTaskId }] : []),
    ]);
    return assets.length ? { status: "success", output: assets } : { status: "failed", error: "短剧工作流没有可回写资产" };
}

function parseAnalysisResult(task: TextTask) {
    try {
        return JSON.parse(task.result?.content || "");
    } catch {
        throw new Error("短剧分析任务返回了无效结构");
    }
}

function videoUrl(record: StoredGenerationTaskRecord) {
    const result = object(record.payload.result);
    return text(result.serverUrl) || text(result.remoteUrl) || text(result.url) || text(record.resultPayload?.url);
}

function analysisSummary(project: DramaProject, episode: DramaEpisode) {
    return { projectId: project.id, episodeId: episode.id, reviewStatus: episode.reviewStatus, characters: project.characters.length, scenes: project.scenes.length, shots: episode.shots.length };
}

function nodeRequestId(runId: string, nodeId: string) {
    return `workflow:${runId}:node:${nodeId}`;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
