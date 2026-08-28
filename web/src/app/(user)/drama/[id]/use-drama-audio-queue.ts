import { useEffect, useRef } from "react";

import type { AiConfig } from "@/stores/use-config-store";
import { createAudioGenerationTask, readAudioGenerationTask } from "@/services/api/audio";
import { GENERATION_TASK_NEEDS_REVIEW_MESSAGE } from "@/services/api/generation-task-state";
import { parseServerMediaUrl } from "@/services/server-media-storage";
import type { DramaEpisode, DramaProject, DramaShot } from "../types";

type UpdateShot = (projectId: string, episodeId: string, shotId: string, patch: Partial<DramaShot>) => void;

export function useDramaAudioQueue(project: DramaProject, episode: DramaEpisode, config: AiConfig, updateShot: UpdateShot) {
    const startingRef = useRef("");

    useEffect(() => {
        const running = episode.shots.find((shot) => shot.audioStatus === "running" && shot.audioTaskId);
        if (!running) return;
        const controller = new AbortController();
        let timer: number | undefined;
        const poll = async () => {
            try {
                const task = await readAudioGenerationTask(running.audioTaskId!, "system", controller.signal);
                if (task.needsReview) return updateShot(project.id, episode.id, running.id, { audioStatus: "error", audioError: task.reviewReason || GENERATION_TASK_NEEDS_REVIEW_MESSAGE });
                if (task.status === "success") {
                    const audioUrl = task.result?.url;
                    return updateShot(project.id, episode.id, running.id, { audioStatus: "success", audioUrl, audioStorageKey: parseServerMediaUrl(audioUrl || "")?.storageKey, audioError: undefined });
                }
                if (task.status === "error" || task.status === "cancelled") return updateShot(project.id, episode.id, running.id, { audioStatus: task.status, audioError: task.error });
                timer = window.setTimeout(poll, 2000);
            } catch (error) {
                if (!controller.signal.aborted) updateShot(project.id, episode.id, running.id, { audioStatus: "error", audioError: error instanceof Error ? error.message : "音频任务查询失败" });
            }
        };
        void poll();
        return () => {
            controller.abort();
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [episode.id, episode.shots, project.id, updateShot]);

    useEffect(() => {
        if (episode.shots.some((shot) => shot.audioStatus === "running")) return;
        const next = episode.shots.find((shot) => shot.audioStatus === "queued");
        if (!next || startingRef.current === next.id) return;
        if (!config.audioModel.trim()) return updateShot(project.id, episode.id, next.id, { audioStatus: "error", audioError: "后台尚未配置可用的默认音频模型" });
        const prompt = (next.subtitle || next.dialogue).trim();
        if (!prompt) return updateShot(project.id, episode.id, next.id, { audioStatus: "error", audioError: "请先填写对白或字幕" });
        const speaker = next.utterances.find((item) => item.type === "dialogue" && item.speaker.trim())?.speaker.trim();
        const character = speaker ? project.characters.find((item) => item.name.trim().toLocaleLowerCase() === speaker.toLocaleLowerCase()) : undefined;
        const voice = character?.voiceProfile;
        startingRef.current = next.id;
        const attemptNo = next.audioAttempt || 1;
        void createAudioGenerationTask(
            {
                ...config,
                model: config.audioModel,
                audioModel: config.audioModel,
                audioVoice: voice?.voice.trim() || config.audioVoice,
                audioSpeed: String(voice?.speed || config.audioSpeed),
                audioInstructions: [config.audioInstructions, voice?.instructions].filter(Boolean).join("\n"),
            },
            prompt,
            {
                source: "drama",
                conversationId: project.creativeConversationId,
                surface: "drama",
                projectId: project.id,
                episodeId: episode.id,
                shotId: next.id,
                estimatedPoints: Number(config.modelPointCosts[config.audioModel] || 0),
                attemptNo,
                clientRequestId: `drama-audio:${project.id}:${episode.id}:${next.id}:attempt-${attemptNo}`,
            },
        )
            .then((task) => updateShot(project.id, episode.id, next.id, { audioStatus: "running", audioTaskId: task.id, audioError: undefined }))
            .catch((error) => updateShot(project.id, episode.id, next.id, { audioStatus: "error", audioError: error instanceof Error ? error.message : "音频任务创建失败" }))
            .finally(() => {
                startingRef.current = "";
            });
    }, [config, episode.id, episode.shots, project.id, updateShot]);
}

export async function cancelDramaAudioTask(taskId?: string) {
    if (!taskId) return;
    await fetch(`/api/audio-tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }).catch(() => undefined);
}
