import { useEffect, useRef } from "react";

import type { AiConfig } from "@/stores/use-config-store";
import { syncUserPointsFromHeaders } from "@/services/api/points";
import type { DramaEpisode, DramaProject, DramaShot } from "../types";

type UpdateShot = (projectId: string, episodeId: string, shotId: string, patch: Partial<DramaShot>) => void;

export function useDramaAudioQueue(project: DramaProject, episode: DramaEpisode, config: AiConfig, updateShot: UpdateShot) {
    const startingRef = useRef("");

    useEffect(() => {
        const running = episode.shots.find((shot) => shot.audioStatus === "running" && shot.audioTaskId);
        if (!running) return;
        const timer = window.setInterval(async () => {
            const response = await fetch(`/api/audio-tasks/${encodeURIComponent(running.audioTaskId!)}`, { cache: "no-store" });
            syncUserPointsFromHeaders(response.headers, "system");
            const payload = (await response.json().catch(() => ({}))) as { task?: { status?: string; result?: { url?: string }; error?: string }; error?: string };
            if (!response.ok) return updateShot(project.id, episode.id, running.id, { audioStatus: "error", audioError: payload.error || "音频任务查询失败" });
            if (payload.task?.status === "success") updateShot(project.id, episode.id, running.id, { audioStatus: "success", audioUrl: payload.task.result?.url, audioError: undefined });
            if (payload.task?.status === "error" || payload.task?.status === "cancelled") updateShot(project.id, episode.id, running.id, { audioStatus: payload.task.status, audioError: payload.task.error });
        }, 2000);
        return () => window.clearInterval(timer);
    }, [episode.id, episode.shots, project.id, updateShot]);

    useEffect(() => {
        if (episode.shots.some((shot) => shot.audioStatus === "running")) return;
        const next = episode.shots.find((shot) => shot.audioStatus === "queued");
        if (!next || startingRef.current === next.id) return;
        if (!config.audioModel.trim()) return updateShot(project.id, episode.id, next.id, { audioStatus: "error", audioError: "当前暂不可用，请联系客服" });
        const prompt = (next.subtitle || next.dialogue).trim();
        if (!prompt) return updateShot(project.id, episode.id, next.id, { audioStatus: "error", audioError: "请先填写对白或字幕" });
        const speaker = next.utterances.find((item) => item.type === "dialogue" && item.speaker.trim())?.speaker.trim();
        const character = speaker ? project.characters.find((item) => item.name.trim().toLocaleLowerCase() === speaker.toLocaleLowerCase()) : undefined;
        const voice = character?.voiceProfile;
        startingRef.current = next.id;
        void fetch("/api/audio-tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                config: {
                    model: config.audioModel,
                    voice: voice?.voice.trim() || config.audioVoice,
                    format: config.audioFormat,
                    speed: voice?.speed || config.audioSpeed,
                    instructions: [config.audioInstructions, voice?.instructions].filter(Boolean).join("\n"),
                },
                prompt,
                context: {
                    conversationId: project.creativeConversationId,
                    surface: "drama",
                    projectId: project.id,
                    episodeId: episode.id,
                    shotId: next.id,
                    estimatedPoints: Number(config.modelPointCosts[config.audioModel] || 0),
                    attemptNo: next.audioAttempt || 1,
                    clientRequestId: `drama-audio:${project.id}:${episode.id}:${next.id}:attempt-${next.audioAttempt || 1}`,
                },
            }),
        })
            .then(async (response) => {
                const payload = (await response.json().catch(() => ({}))) as { task?: { id?: string }; error?: string };
                if (!response.ok || !payload.task?.id) throw new Error(payload.error || "音频任务创建失败");
                updateShot(project.id, episode.id, next.id, { audioStatus: "running", audioTaskId: payload.task.id, audioError: undefined });
            })
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
