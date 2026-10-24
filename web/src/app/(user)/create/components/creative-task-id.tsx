"use client";

import { Copy } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";

export function CreativeTaskId({ id, className }: { id?: string; className?: string }) {
    const copyText = useCopyText();
    if (!id) return null;

    return (
        <div data-testid="creative-task-id" className={cn("flex max-w-full items-center gap-1.5 text-[11px] leading-5 text-[#8b949f] dark:text-[#929ca8]", className)}>
            <span className="shrink-0">任务 ID：</span>
            <code className="min-w-0 break-all font-mono text-[#667085] dark:text-[#b0b8c2]">{id}</code>
            <button
                type="button"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[#667085] transition-colors hover:bg-[#f4f5f7] hover:text-[#344054] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#615cff]/30 dark:text-[#a0a9b4] dark:hover:bg-[#252a31] dark:hover:text-white"
                aria-label={`复制任务 ID ${id}`}
                title="复制任务 ID，用于反馈问题"
                onClick={() => copyText(id, "任务 ID 已复制")}
            >
                <Copy className="size-3.5" aria-hidden />
            </button>
        </div>
    );
}
