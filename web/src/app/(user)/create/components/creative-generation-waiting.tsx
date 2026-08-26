"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import type { CreativeMessage } from "@/lib/creative-runtime-contract";
import type { CreativeAgentRun } from "@/services/api/creative";

import { creativeRunMode } from "./creative-run-presentation";

const LONG_WAIT_MESSAGES = ["久等了，创作还在继续，请再给我一点时间。", "不用重复发送，创作还在继续，我会持续更新结果。", "作品正在慢慢雕琢，可能比平时久一点，请耐心等待。"] as const;

export function CreativeGenerationWaiting({ run, message }: { run?: CreativeAgentRun; message: Pick<CreativeMessage, "content" | "createdAt"> }) {
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

    return (
        <div data-testid="creative-generation-waiting" className="mb-3 max-w-[520px] py-1 text-[#667085] dark:text-[#a0a9b4]">
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

export function creativeGenerationWaitingCopy({ mode, runStatus, progressText, elapsedSeconds }: { mode?: "text" | "image" | "video" | "audio"; runStatus?: CreativeAgentRun["status"]; progressText: string; elapsedSeconds: number }) {
    const progress = progressText.trim();
    if (runStatus === "paused" || /任务已暂停/.test(progress)) return "任务已暂停，进度已保存，准备好后可以继续。";
    if (/连接暂时中断|无法确认实时状态/.test(progress)) return "连接暂时不稳定，但任务仍在继续，正在确认最新状态（任务仍在后台继续）。";
    if (/连接已恢复|恢复连接/.test(progress)) return "连接已恢复，创作会继续进行。";
    if (/检查完成|正在整理|创作结果/.test(progress)) return "作品已经生成，正在整理最后的细节。";

    const activeTask = /正在处理|上游处理中|创作任务|重新生成|正在优化/.test(progress);
    if (!activeTask && (runStatus === "planning" || /理解需求|匹配创作技能|方案已确定|创建任务/.test(progress))) return planningCopy(mode);

    const elapsedMinutes = Math.floor(Math.max(0, elapsedSeconds) / 60);
    if (elapsedMinutes === 0) {
        if (mode === "image") return "画面正在一点点显现，再给我一点时间。";
        if (mode === "video") return "镜头正在一帧帧铺开，请耐心等待。";
        if (mode === "audio") return "声音正在一点点成形，马上就好。";
        return "灵感已经接住，正在把它变成作品。";
    }
    if (elapsedMinutes === 1) return longWaitCopy(mode, false);
    return longWaitCopy(mode, true, LONG_WAIT_MESSAGES[(elapsedMinutes - 2) % LONG_WAIT_MESSAGES.length]);
}

function planningCopy(mode?: "text" | "image" | "video" | "audio") {
    if (mode === "image") return "已收到你的灵感，正在安排画面的氛围和细节。";
    if (mode === "video") return "已抓住这个镜头，正在把节奏和画面串起来。";
    if (mode === "audio") return "正在把声音的语气和节奏调到合适。";
    return "正在帮你把想法理顺，很快给你一版好内容。";
}

function longWaitCopy(mode: "text" | "image" | "video" | "audio" | undefined, veryLong: boolean, fallback: string = "") {
    if (veryLong) {
        if (mode === "image") return "画面还在细细打磨，不用重复发送，完成后会自动更新。";
        if (mode === "video") return "久等了，镜头还在一帧帧渲染，不用重复发送，完成后会自动更新。";
        if (mode === "audio") return "声音还在细细校准，不用重复发送，完成后会自动更新。";
        return fallback;
    }
    if (mode === "image") return "画面还在认真打磨，很快就能看到细节。";
    if (mode === "video") return "镜头还在慢慢铺开，再等一会儿就好。";
    if (mode === "audio") return "声音还在细细调校，再等一会儿就好。";
    return "文字还在认真打磨，再等一会儿就好。";
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
