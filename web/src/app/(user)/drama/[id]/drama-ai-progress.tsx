"use client";

import { Progress } from "antd";
import { AlertCircle, Loader2 } from "lucide-react";

import { formatElapsed } from "./use-elapsed-timer";

/** AI 长任务运行状态条：进度（可选百分比）、实时耗时与阶段说明。 */
export function DramaAiProgress({ label, elapsedMs, done, total, hint, error }: { label: string; elapsedMs: number; done?: number; total?: number; hint?: string; error?: string }) {
    const determinate = typeof done === "number" && typeof total === "number" && total > 0;
    const percent = determinate ? Math.round(((done as number) / (total as number)) * 100) : undefined;
    return (
        <div className="rounded-lg border border-violet-200/70 bg-violet-50/60 px-3 py-2.5 dark:border-violet-500/30 dark:bg-violet-950/25">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-violet-800 dark:text-violet-200">
                    {error ? <AlertCircle className="size-4 shrink-0 text-[#ef4444]" /> : <Loader2 className="size-4 shrink-0 animate-spin" />}
                    <span className="truncate">{error ? `${label} 失败` : label}</span>
                </span>
                {determinate ? (
                    <span className="text-xs font-medium tabular-nums text-violet-700/90 dark:text-violet-300/90">
                        {done}/{total} · {percent}%
                    </span>
                ) : null}
                <span className="text-xs tabular-nums text-violet-700/90 dark:text-violet-300/90">已用时 {formatElapsed(elapsedMs)}</span>
            </div>
            <Progress className="!mb-0 !mt-2" percent={percent ?? 8} showInfo={false} size="small" status={error ? "exception" : "active"} strokeColor={error ? "#ef4444" : undefined} />
            {error ? <div className="mt-1.5 text-xs leading-5 text-[#ef4444]">{error}</div> : hint ? <div className="mt-1.5 text-xs leading-5 text-muted-foreground">{hint}</div> : null}
        </div>
    );
}
