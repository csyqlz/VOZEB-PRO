"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import type { CreativeAsset, CreativeMessage } from "@/lib/creative-runtime-contract";
import { cn } from "@/lib/utils";
import type { CreativeAgentRun } from "@/services/api/creative";

import { creativeRunMode } from "./creative-run-presentation";

const LONG_WAIT_MESSAGES = ["主人，久等了，辛苦你再陪我一会儿，我一直在这里守着这次创作。", "主人，别担心，创作还在继续，不用重复发送，先放松一下，这里交给我守着吧。", "主人，作品正在慢慢雕琢，可能比平时久一点，但我没有离开。"] as const;

export function CreativeGenerationWaiting({ run, message, readyAssets = [] }: { run?: CreativeAgentRun; message: Pick<CreativeMessage, "content" | "createdAt">; readyAssets?: Array<Pick<CreativeAsset, "status" | "type">> }) {
    const startedAt = run?.createdAt || message.createdAt;
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const update = () => setNow(Date.now());
        update();
        const timer = window.setInterval(update, 1000);
        return () => window.clearInterval(timer);
    }, [startedAt]);

    const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const copy = creativeGenerationWaitingCopy({ mode: creativeRunMode(run), runStatus: run?.status, progressText: message.content, elapsedSeconds });
    const loadingSlots = creativeMediaLoadingSlots(run, readyAssets);

    return (
        <div data-testid="creative-generation-waiting" className="mb-3 max-w-[620px] py-1 text-[#667085] dark:text-[#a0a9b4]">
            {loadingSlots.length ? <CreativeMediaLoadingGrid slots={loadingSlots} /> : null}
            <div className="flex items-start gap-2.5">
                <Sparkles className="mt-1 size-4 shrink-0 animate-pulse text-primary/75" aria-hidden />
                <div className="min-w-0">
                    <p className="text-sm leading-6 text-[#596474] dark:text-[#b0b8c2]" aria-live="polite">
                        {copy}
                    </p>
                    <p data-testid="creative-generation-elapsed" className="mt-0.5 text-[11px] tabular-nums leading-4 text-[#98a2b3] dark:text-[#7f8996]">
                        已等待 {formatCreativeWaitingTime(elapsedSeconds)}
                    </p>
                </div>
            </div>
        </div>
    );
}

type CreativeMediaLoadingSlot = { key: string; type: "planning" | "image" | "video"; title: string; model?: string; ratio?: string };

export function creativeMediaLoadingSlots(run: CreativeAgentRun | undefined, readyAssets: Array<Pick<CreativeAsset, "status" | "type">> = []): CreativeMediaLoadingSlot[] {
    const ready = { image: readyAssets.filter((asset) => asset.type === "image" && asset.status === "ready").length, video: readyAssets.filter((asset) => asset.type === "video" && asset.status === "ready").length };
    const tasks = (run?.tasks || []).filter((task) => (task.type === "image" || task.type === "video") && (task.status === "ready" || task.status === "running"));
    if (!tasks.length) {
        if (run && run.status !== "planning" && run.status !== "running") return [];
        const mode = creativeRunMode(run);
        if (mode !== "image" && mode !== "video") {
            return !run || (run.status === "planning" && !run.tasks.length) ? [{ key: `${run?.id || "pending"}-planning`, type: "planning", title: "正在规划创作" }] : [];
        }
        const preferences = run?.generationPreferences?.[mode];
        const count = Math.max(0, Math.floor(preferences?.count || 1) - ready[mode]);
        return Array.from({ length: count }, (_, index) => ({ key: `${run?.id || mode}-${index}`, type: mode, title: mode === "video" ? "视频生成" : "图片生成", ratio: preferences?.size }));
    }
    return tasks.flatMap((task) => {
        const type = task.type as "image" | "video";
        const count = Math.max(1, Math.floor(task.count || 1));
        const completed = Math.min(count, ready[type]);
        ready[type] -= completed;
        return Array.from({ length: count - completed }, (_, index) => ({ key: `${task.id}-${completed + index}`, type, title: task.title, model: task.model, ratio: task.ratio }));
    });
}

function CreativeMediaLoadingGrid({ slots }: { slots: CreativeMediaLoadingSlot[] }) {
    return (
        <div data-testid="creative-media-loading-grid" data-slot-count={slots.length} className="mb-3 grid w-full grid-cols-1 gap-2.5 min-[560px]:grid-cols-2">
            {slots.map((slot, index) => (
                <CreativeMediaLoadingCard key={slot.key} slot={slot} index={index} />
            ))}
        </div>
    );
}

function CreativeMediaLoadingCard({ slot, index }: { slot: CreativeMediaLoadingSlot; index: number }) {
    return (
        <div
            data-testid="creative-media-loading"
            data-loading-type={slot.type}
            style={{ aspectRatio: loadingAspectRatio(slot.ratio, slot.type) }}
            className="relative isolate min-h-40 w-full min-w-0 overflow-hidden rounded-xl border border-[#e5e7eb] bg-white shadow-[0_4px_18px_rgba(15,23,42,0.04)] dark:border-[#343a43] dark:bg-[#171a1f]"
            role="status"
            aria-label={`${slot.title}生成中 ${index + 1}`}
        >
            <span
                className="absolute inset-0 bg-[radial-gradient(circle_at_32%_42%,rgba(255,142,199,.42),transparent_32%),radial-gradient(circle_at_68%_38%,rgba(152,116,255,.32),transparent_34%),radial-gradient(circle_at_50%_68%,rgba(95,218,238,.24),transparent_38%)] opacity-80 blur-2xl motion-safe:animate-pulse"
                aria-hidden
            />
            <span className="absolute left-[24%] top-[22%] size-9 rounded-tl-[18px] border-l-[5px] border-t-[5px] border-white/95 drop-shadow-[0_1px_5px_rgba(255,255,255,.75)]" aria-hidden />
            <span className="absolute right-[24%] top-[22%] size-9 rounded-tr-[18px] border-r-[5px] border-t-[5px] border-white/95 drop-shadow-[0_1px_5px_rgba(255,255,255,.75)]" aria-hidden />
            <span className="absolute bottom-[22%] left-[24%] size-9 rounded-bl-[18px] border-b-[5px] border-l-[5px] border-white/95 drop-shadow-[0_1px_5px_rgba(255,255,255,.75)]" aria-hidden />
            <span className="absolute bottom-[22%] right-[24%] size-9 rounded-br-[18px] border-b-[5px] border-r-[5px] border-white/95 drop-shadow-[0_1px_5px_rgba(255,255,255,.75)]" aria-hidden />
            <span className="absolute inset-0 grid place-items-center" aria-hidden>
                <span className="relative block size-16 motion-safe:animate-pulse">
                    <svg viewBox="0 0 64 64" className="size-full overflow-visible drop-shadow-[0_6px_14px_rgba(129,92,246,.35)]">
                        <path d="M31.5 4 38 22.8 57 29.5 38 36.2 31.5 55 25 36.2 6 29.5 25 22.8Z" fill="#8b5cf6" />
                        <path d="M50 8.5 53 16l7.5 3-7.5 3-3 7.5-3-7.5-7.5-3 7.5-3Z" fill="#d946ef" className="origin-center motion-safe:animate-spin" />
                        <path d="M49 37.5 51 42l4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2Z" fill="#fb7185" />
                    </svg>
                </span>
            </span>
            <span className={cn("absolute inset-x-3 bottom-2 truncate text-center text-[10px] font-medium text-[#7c8591] dark:text-[#a7b0ba]", !slot.model && "sr-only")}>{slot.model || slot.title}</span>
        </div>
    );
}

function loadingAspectRatio(value: string | undefined, type: CreativeMediaLoadingSlot["type"]) {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i);
    if (!match) return type === "video" ? "16 / 9" : "1 / 1";
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? `${width} / ${height}` : type === "video" ? "16 / 9" : "1 / 1";
}

export function creativeGenerationWaitingCopy({ mode, runStatus, progressText, elapsedSeconds }: { mode?: "text" | "image" | "video" | "audio"; runStatus?: CreativeAgentRun["status"]; progressText: string; elapsedSeconds: number }) {
    const progress = progressText.trim();
    if (runStatus === "paused" || /任务已暂停/.test(progress)) return "主人，任务已经替你暂停，进度好好保存着，想继续时叫我就好。";
    if (/连接暂时中断|无法确认实时状态/.test(progress)) return "主人，连接刚刚有些不稳，不过任务仍在后台继续，我正在替你确认。";
    if (/连接已恢复|恢复连接/.test(progress)) return "主人，连接恢复啦，我会继续守着这次创作。";
    if (/检查完成|正在整理|创作结果/.test(progress)) return "主人，作品已经生成，我正在整理最后的细节，很快就能交到你手上。";

    const activeTask = /正在处理|上游处理中|创作任务|重新生成|正在优化/.test(progress);
    if (!activeTask && (runStatus === "planning" || /理解需求|匹配创作技能|方案已确定|创建任务/.test(progress))) return planningCopy(mode);

    const elapsedMinutes = Math.floor(Math.max(0, elapsedSeconds) / 60);
    if (elapsedMinutes === 0) {
        if (mode === "image") return "主人，画面正在一点点显现，再给我一点点时间呀。";
        if (mode === "video") return "主人，镜头正在一帧帧铺开，我会在这里陪你等着。";
        if (mode === "audio") return "主人，声音正在一点点成形，我会替你仔细听好。";
        return "主人，灵感已经接住啦，我正在把它变成作品。";
    }
    if (elapsedMinutes === 1) return longWaitCopy(mode, false);
    return longWaitCopy(mode, true, LONG_WAIT_MESSAGES[(elapsedMinutes - 2) % LONG_WAIT_MESSAGES.length]);
}

function planningCopy(mode?: "text" | "image" | "video" | "audio") {
    if (mode === "image") return "主人，我接住你的灵感啦，正在把画面的氛围和细节安排好。";
    if (mode === "video") return "主人，我已经抓住这个镜头啦，正在把节奏和画面串起来。";
    if (mode === "audio") return "主人，我先替你把声音的语气和节奏调到合适。";
    return "主人，我先帮你把想法理顺，很快就给你一版好内容。";
}

function longWaitCopy(mode: "text" | "image" | "video" | "audio" | undefined, veryLong: boolean, fallback: string = "") {
    if (veryLong) {
        if (mode === "image") return "主人，画面还在细细打磨，不用重复发送，我会替你稳稳守着。";
        if (mode === "video") return "主人，久等了，镜头还在一帧帧渲染，不用重复发送，我会替你稳稳守着。";
        if (mode === "audio") return "主人，声音还在细细校准，不用重复发送，我会替你稳稳守着。";
        return fallback;
    }
    if (mode === "image") return "主人，画面还在认真打磨，马上就把好看的细节交给你。";
    if (mode === "video") return "主人，镜头还在慢慢铺开，再陪我一会儿，很快就好。";
    if (mode === "audio") return "主人，声音还在细细调校，再陪我一会儿，很快就好。";
    return "主人，文字还在认真打磨，再陪我一会儿，很快就好。";
}

export function formatCreativeWaitingTime(elapsedSeconds: number) {
    const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}小时${minutes ? `${minutes}分` : ""}${seconds ? `${seconds}秒` : ""}`;
    if (minutes) return `${minutes}分${seconds ? `${seconds}秒` : ""}`;
    return `${seconds}秒`;
}
