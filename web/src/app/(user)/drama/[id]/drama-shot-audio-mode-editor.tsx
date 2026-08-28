"use client";

import { Segmented } from "antd";

import { useDramaStore } from "../stores/use-drama-store";
import type { DramaShot, DramaShotAudioMode } from "../types";

const descriptions: Record<DramaShotAudioMode, string> = {
    source: "保留即梦等视频模型生成的对白、环境声和音乐。",
    voiceover: "关闭视频模型原声，按角色音色生成独立配音并替换音轨。",
    mute: "生成静音镜头，整集合成时不保留视频原声。",
};

export function DramaShotAudioModeEditor({ projectId, episodeId, shot }: { projectId: string; episodeId: string; shot: DramaShot }) {
    const updateShot = useDramaStore((state) => state.updateShot);
    const audioMode = shot.audioMode || "source";
    const audioActive = shot.audioStatus === "queued" || shot.audioStatus === "running";
    const changeMode = (value: string | number) => {
        const next = value as DramaShotAudioMode;
        updateShot(projectId, episodeId, shot.id, {
            audioMode: next,
            audioStatus: "idle",
            audioTaskId: undefined,
            audioError: undefined,
            audioUrl: undefined,
            audioStorageKey: undefined,
            generationStatus: shot.videoUrl ? shot.generationStatus : "idle",
        });
    };

    return (
        <div className="mt-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
                <span className="text-sm font-medium">成片声音</span>
                <span className="text-xs text-muted-foreground">按镜头选择，不会重复配音</span>
            </div>
            <Segmented
                block
                disabled={audioActive}
                className="!mt-2 !min-w-0 !w-full [&_.ant-segmented-item]:!min-w-0 [&_.ant-segmented-item-label]:!truncate [&_.ant-segmented-item-label]:!px-1.5 sm:[&_.ant-segmented-item-label]:!px-3"
                value={audioMode}
                options={[
                    { label: "视频原声", value: "source" },
                    { label: "AI 配音", value: "voiceover" },
                    { label: "静音", value: "mute" },
                ]}
                onChange={changeMode}
            />
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{descriptions[audioMode]}</p>
        </div>
    );
}
