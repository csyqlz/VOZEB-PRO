"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CreativeMessage, CreativeReferenceRecovery } from "@/lib/creative-runtime-contract";
import type { CreativeAgentRun, CreativeSceneSelection } from "@/services/api/creative";

import { creativeRunMode } from "./creative-run-presentation";
import { CreativeSceneSelectionPanel } from "./creative-scene-selection-panel";
import { CreativeReferenceReviewPanel } from "./creative-reference-review-panel";

const LONG_WAIT_MESSAGES = ["主人，久等了，辛苦你再陪我一会儿，我一直在这里守着这次创作。", "主人，别担心，创作还在继续，不用重复发送，先放松一下，这里交给我守着吧。", "主人，作品正在慢慢雕琢，可能比平时久一点，但我没有离开。"] as const;

export function CreativeGenerationWaiting({
    run,
    message,
    onConfirmSceneSelection,
    onRecoverReference,
    onCheckStatus,
}: {
    run?: CreativeAgentRun;
    message: Pick<CreativeMessage, "content" | "createdAt">;
    onConfirmSceneSelection?: (runId: string, selection: CreativeSceneSelection) => Promise<void>;
    onRecoverReference?: (runId: string, recovery: CreativeReferenceRecovery) => Promise<void>;
    onCheckStatus?: (runId: string) => Promise<void>;
}) {
    const startedAt = run?.createdAt || message.createdAt;
    const active = !run || run.status === "planning" || run.status === "running";
    const [now, setNow] = useState(() => Date.now());
    const [checking, setChecking] = useState(false);
    const [checkError, setCheckError] = useState("");
    const checkingRef = useRef(false);
    const checkStatus = async () => {
        if (!run?.canCheckStatus || !onCheckStatus || checkingRef.current) return;
        checkingRef.current = true;
        setChecking(true);
        setCheckError("");
        try {
            await onCheckStatus(run.id);
        } catch (error) {
            setCheckError(error instanceof Error ? error.message : "暂时无法检查原任务状态，请重试。");
        } finally {
            checkingRef.current = false;
            setChecking(false);
        }
    };

    useEffect(() => {
        if (!active) return;
        const update = () => setNow(Date.now());
        update();
        const timer = window.setInterval(update, 1000);
        return () => window.clearInterval(timer);
    }, [startedAt, active]);

    const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const reviewText = run?.status === "paused" ? run.tasks.find((task) => task.status === "needs_review" && task.error?.trim())?.error : undefined;
    const copy =
        run?.ecommerceReferenceReview && run.status === "paused"
            ? run.ecommerceReferenceReview.question
            : run?.ecommerceSceneSelection && run.status === "paused"
              ? "请确认需要修改的位置，然后继续这次创作。"
              : creativeGenerationWaitingCopy({ mode: creativeRunMode(run), runStatus: run?.status, progressText: message.content, reviewText, elapsedSeconds });

    return (
        <div data-testid="creative-generation-waiting" className="mb-3 max-w-[520px] py-1 text-[#667085] dark:text-[#a0a9b4]">
            <div className="flex items-start gap-2.5">
                <Sparkles className={`mt-1 size-4 shrink-0 text-primary/75${active ? " animate-pulse" : ""}`} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-sm leading-6 text-[#596474] dark:text-[#b0b8c2]" aria-live="polite">
                        {copy}
                    </p>
                    {active ? (
                        <p data-testid="creative-generation-elapsed" className="mt-0.5 text-[11px] tabular-nums leading-4 text-[#98a2b3] dark:text-[#7f8996]">
                            已等待 {formatCreativeWaitingTime(elapsedSeconds)}
                        </p>
                    ) : null}
                    {run?.status === "paused" && run.ecommerceSceneSelection && onConfirmSceneSelection ? (
                        <CreativeSceneSelectionPanel key={`${run.id}:${run.ecommerceSceneSelection.baselineAssetId}`} runId={run.id} action={run.ecommerceSceneSelection} onConfirm={onConfirmSceneSelection} />
                    ) : null}
                    {run?.status === "paused" && run.ecommerceReferenceReview && onRecoverReference ? (
                        <CreativeReferenceReviewPanel key={`${run.id}:${run.ecommerceReferenceReview.reviewId}`} runId={run.id} review={run.ecommerceReferenceReview} onRecover={onRecoverReference} />
                    ) : null}
                    {run?.status === "paused" && run.canCheckStatus && onCheckStatus && !run.ecommerceReferenceReview && !run.ecommerceSceneSelection ? (
                        <button type="button" disabled={checking} onClick={() => void checkStatus()} className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-60">
                            {checking ? "正在检查" : "检查状态"}
                        </button>
                    ) : null}
                    {checkError ? (
                        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-300">
                            {checkError}
                        </p>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

export function creativeGenerationWaitingCopy({
    mode,
    runStatus,
    progressText,
    reviewText,
    elapsedSeconds,
}: {
    mode?: "text" | "image" | "video" | "audio";
    runStatus?: CreativeAgentRun["status"];
    progressText: string;
    reviewText?: string;
    elapsedSeconds: number;
}) {
    const progress = progressText.trim();
    const review = reviewText?.trim();
    if (runStatus === "paused" && review) return review;
    if (["正在识别商品", "正在规划场景", "正在生成图片", "正在检查商品细节"].includes(progress)) return progress;
    if (runStatus === "paused" && progress && !/任务已暂停|任务仍在后台保存/.test(progress)) return progress;
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
