"use client";

import { Input, InputNumber, Select } from "antd";

import type { DramaEpisode, DramaProject } from "../types";
import { useDramaStore } from "../stores/use-drama-store";

export function DramaEpisodeSettings({ project, episode, embedded = false }: { project: DramaProject; episode: DramaEpisode; embedded?: boolean }) {
    const updateProject = useDramaStore((state) => state.updateProject);
    const updateEpisode = useDramaStore((state) => state.updateEpisode);
    const updateEpisodeNumber = useDramaStore((state) => state.updateEpisodeNumber);
    const episodeIndex = Math.max(
        0,
        project.episodes.findIndex((item) => item.id === episode.id),
    );
    const episodeNumber = episode.episodeNumber || episodeIndex + 1;
    const paragraphCount = episode.script.trim() ? episode.script.split(/\n+/).filter(Boolean).length : 0;
    const characterCount = new Set(episode.shots.flatMap((shot) => shot.characterIds)).size;
    const duration = episode.shots.reduce((total, shot) => total + (Number.isFinite(shot.duration) ? shot.duration : 0), 0);
    return (
        <aside className={`hide-scrollbar min-h-0 min-w-0 overflow-y-auto bg-card ${embedded ? "max-h-[min(620px,calc(100vh-150px))] p-1" : "border-l border-border p-3"}`} data-drama-episode-settings>
            {!embedded ? (
                <>
                    <h3 className="text-sm font-semibold">本集设置</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">设置会自动保存到当前项目</p>
                </>
            ) : null}
            <div className={`${embedded ? "space-y-3" : "mt-4 space-y-4"}`}>
                <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">集数</span>
                    <InputNumber className="!h-8 !w-full" min={1} precision={0} value={episodeNumber} onChange={(value) => typeof value === "number" && updateEpisodeNumber(project.id, episode.id, value)} />
                </label>
                <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">本集名称</span>
                    <Input className="!h-8" value={episode.title} onChange={(event) => updateEpisode(project.id, episode.id, { title: event.target.value })} />
                </label>
                <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">故事简介</span>
                    <Input.TextArea value={project.summary} onChange={(event) => updateProject(project.id, { summary: event.target.value })} autoSize={{ minRows: 3, maxRows: 6 }} />
                </label>
                <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-foreground">视觉风格</span>
                    <Input className="!h-8" value={project.style} placeholder="例如：电影感国漫" onChange={(event) => updateProject(project.id, { style: event.target.value })} />
                </label>
                <div className="space-y-1.5">
                    <span className="text-xs font-medium text-foreground">视频生产模式</span>
                    <div className="min-w-0">
                        <Select
                            className="w-full"
                            value={project.defaultVideoMode}
                            options={[
                                { label: "分镜驱动", value: "storyboard" },
                                { label: "直接生成", value: "direct" },
                                { label: "参考图", value: "reference" },
                            ]}
                            onChange={(value) => updateProject(project.id, { defaultVideoMode: value as DramaProject["defaultVideoMode"] })}
                        />
                    </div>
                </div>
            </div>
            <div className="mt-4 border-t border-border pt-3" data-drama-episode-overview>
                <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold">本集概况</h4>
                    <span className="text-[10px] text-muted-foreground">当前数据</span>
                </div>
                <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <Stat label="字数" value={episode.script.length} />
                    <Stat label="段落" value={paragraphCount} />
                    <Stat label="场景 / 镜头" value={episode.shots.length} />
                    <Stat label="角色" value={characterCount} />
                    {duration > 0 ? <Stat label="预估时长" value={`${duration} 秒`} /> : null}
                </dl>
            </div>
        </aside>
    );
}

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div>
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</dd>
        </div>
    );
}
