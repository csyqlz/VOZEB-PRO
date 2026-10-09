"use client";

import { App, Button, Dropdown, Popover, Tooltip } from "antd";
import { Check, Clapperboard, Clock3, Copy, Download, ExternalLink, FileAudio2, Film, Info, Link2, MoreHorizontal, PanelsTopLeft, RotateCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { downloadAgentMedia, type AgentMediaDownload } from "@/components/agent/agent-media-download";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { AgentMessageActions } from "@/components/agent/agent-message-actions";
import { formatAgentArtifactText, formatAgentMessageText, friendlyAgentError } from "@/components/agent/agent-message-format";
import { AgentMediaPreview } from "@/components/agent/agent-media-preview";
import { SiteLogo } from "@/components/layout/site-logo";
import { useCopyText } from "@/hooks/use-copy-text";
import { useCreativeAgentModels } from "@/hooks/use-creative-agent-options";
import { isCreativeProjectHandoff, type CreativeAsset, type CreativeMessage, type CreativeProjectHandoff } from "@/lib/creative-runtime-contract";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { cn } from "@/lib/utils";
import { userAvatarFallback } from "@/lib/user-avatar";
import { DEFAULT_SITE_TITLE } from "@/lib/site-brand";
import type { MaterializedCreativeProject } from "@/services/creative-project-handoff";
import { getCreativeAgentRun, type CreativeAgentRun } from "@/services/api/creative";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

import { creativeAssetLayout } from "./creative-asset-layout";
import { creativeConversationEntries, isMediaCreativeRound, type CreativeConversationEntry } from "./creative-conversation-rounds";
import { CreativeGenerationWaiting } from "./creative-generation-waiting";
import { CreativeMediaResult } from "./creative-media-result";
import { formatCreativeMessageTime } from "./creative-result-presentation";
import { creativeRunDuration, creativeRunMode, creativeRunPresentation } from "./creative-run-presentation";
import { CreativeVideoResult } from "./creative-video-result";

export function CreativeMessages({
    messages,
    assets,
    loading,
    projectLinks,
    projectErrors,
    runDetails,
    materializingProjectId,
    onMaterializeProject,
    onRetryMessage,
    selectedAssetIds,
    onToggleAsset,
    hasOlder,
    olderLoading,
    onLoadOlder,
    followLatest = true,
}: {
    messages: CreativeMessage[];
    assets: CreativeAsset[];
    loading: boolean;
    projectLinks: Record<string, MaterializedCreativeProject>;
    projectErrors: Record<string, string>;
    runDetails: Record<string, CreativeAgentRun>;
    materializingProjectId?: string;
    onMaterializeProject: (handoff: CreativeProjectHandoff) => Promise<MaterializedCreativeProject>;
    onRetryMessage: (message: CreativeMessage, run?: CreativeAgentRun) => Promise<boolean | void>;
    selectedAssetIds: string[];
    onToggleAsset: (id: string) => void;
    hasOlder?: boolean;
    olderLoading?: boolean;
    onLoadOlder?: () => void;
    followLatest?: boolean;
}) {
    const endRef = useRef<HTMLDivElement>(null);
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const user = usePublicSessionStore((state) => state.payload?.user || null);
    const models = useCreativeAgentModels();
    const avatarUrl = user?.avatarUrl?.trim();
    const avatarFallback = userAvatarFallback(user?.displayName || user?.username || "用户");
    const assetsByMessage = useMemo(() => {
        const map = new Map<string, CreativeAsset[]>();
        for (const asset of assets) {
            const key = asset.messageId || asset.sourceRunId;
            if (!key) continue;
            map.set(key, [...(map.get(key) || []), asset]);
        }
        return map;
    }, [assets]);
    const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
    const modelNames = useMemo(() => new Map(models.map((model) => [model.id, model.name])), [models]);
    const entries = useMemo(() => creativeConversationEntries(messages, runDetails), [messages, runDetails]);
    const failedRoundsByAssistantId = useMemo(() => {
        const map = new Map<string, Extract<CreativeConversationEntry, { type: "round" }>>();
        for (const entry of entries) {
            if (entry.type !== "round" || !creativeRoundFailed(entry.assistant, entry.run)) continue;
            map.set(entry.assistant.id, entry);
        }
        return map;
    }, [entries]);
    const lastMessageId = messages.at(-1)?.id;
    const mediaRounds = useMemo(() => {
        const byUserMessage = new Map<string, Extract<CreativeConversationEntry, { type: "round" }>>();
        const assistantMessageIds = new Set<string>();
        for (const entry of entries) {
            if (entry.type !== "round") continue;
            const outputAssets = assetsForAssistant(entry.assistant, assetsByMessage);
            if (!isMediaCreativeRound(entry.run, outputAssets)) continue;
            byUserMessage.set(entry.user.id, entry);
            assistantMessageIds.add(entry.assistant.id);
        }
        return { byUserMessage, assistantMessageIds };
    }, [assetsByMessage, entries]);

    useEffect(() => {
        if (followLatest) endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }, [assets.length, followLatest, lastMessageId, loading]);

    if (loading) return <div className="grid flex-1 place-items-center text-sm text-stone-400">正在读取会话...</div>;

    return (
        <div className="mx-auto w-full max-w-[1120px] space-y-3 px-3 pb-3 pt-5 sm:space-y-8 sm:px-8 sm:pt-7" data-testid="creative-message-list">
            {hasOlder ? (
                <div className="flex justify-center">
                    <Button type="text" loading={olderLoading} onClick={onLoadOlder}>
                        加载更早消息
                    </Button>
                </div>
            ) : null}
            {messages.map((item) => {
                const mediaRound = mediaRounds.byUserMessage.get(item.id);
                if (mediaRound) {
                    const referencedAssets = messageAssetIds(mediaRound.user).flatMap((id) => assetById.get(id) || []);
                    const outputAssets = assetsForAssistant(mediaRound.assistant, assetsByMessage);
                    return (
                        <CreativeMediaRound
                            key={mediaRound.id}
                            userMessage={mediaRound.user}
                            assistantMessage={mediaRound.assistant}
                            referencedAssets={referencedAssets}
                            outputAssets={outputAssets}
                            run={mediaRound.run}
                            modelNames={modelNames}
                            projectLinks={projectLinks}
                            projectErrors={projectErrors}
                            materializingProjectId={materializingProjectId}
                            onMaterializeProject={onMaterializeProject}
                            onRetryMessage={onRetryMessage}
                            selectedAssetIds={selectedAssetIds}
                            onToggleAsset={onToggleAsset}
                        />
                    );
                }
                if (mediaRounds.assistantMessageIds.has(item.id)) return null;
                const referencedAssets = item.role === "user" ? messageAssetIds(item).flatMap((id) => assetById.get(id) || []) : [];
                const itemAssets = [...referencedAssets, ...(assetsByMessage.get(item.id) || []), ...(item.runId ? assetsByMessage.get(item.runId) || [] : [])].filter((asset, index, list) => list.findIndex((current) => current.id === asset.id) === index);
                const handoff = isCreativeProjectHandoff(item.metadata.projectHandoff) ? item.metadata.projectHandoff : null;
                const displayContent = item.status === "failed" ? friendlyAgentError(item.content) : formatAgentMessageText(item.content);
                const textAssetContent = itemAssets
                    .filter((asset) => asset.type === "text" && asset.status === "ready" && asset.textContent?.trim())
                    .map((asset) => formatAgentArtifactText(asset.textContent!))
                    .join("\n\n");
                const downloads = agentAssetDownloads(itemAssets);
                const run = item.runId ? runDetails[item.runId] : undefined;
                const failedTasks = run?.tasks.filter((task) => task.status === "failed") || [];
                const failedRound = failedRoundsByAssistantId.get(item.id);
                return (
                    <article key={item.id} className={cn("group/message flex min-w-0 items-start gap-4 sm:gap-5", item.role === "user" ? "justify-end" : "justify-start")}>
                        {item.role === "assistant" ? <CreativeAssistantAvatar className="mt-0" logoUrl={site.logoUrl} /> : null}
                        <div className={cn("min-w-0", item.role === "user" ? "max-w-[520px] text-right" : "min-w-0 flex-1")}>
                            {item.role === "user" && itemAssets.length ? <CreativeRoundReferenceStrip assets={itemAssets} /> : null}
                            {item.role === "assistant" && item.status === "running" ? (
                                <CreativeGenerationWaiting run={run} message={item} />
                            ) : textAssetContent && item.role === "assistant" && item.status === "completed" ? null : (
                                <div
                                    className={cn(
                                        "break-words text-[15px] leading-7",
                                        item.role === "user" &&
                                            "rounded-[14px] bg-[linear-gradient(135deg,#f3f1ff_0%,#ebeaff_100%)] px-[18px] py-3 text-left leading-6 text-[#111827] dark:bg-[linear-gradient(135deg,#2d2a46_0%,#26243a_100%)] dark:text-[#f3f5f7]",
                                        item.status === "failed" && "text-red-600 dark:text-red-300",
                                        item.status === "cancelled" && "text-stone-400",
                                    )}
                                >
                                    {item.role === "assistant" && item.status === "completed" ? <AgentMarkdown>{displayContent}</AgentMarkdown> : <span className="whitespace-pre-wrap">{displayContent}</span>}
                                </div>
                            )}
                            {item.role === "user" ? <CreativeUserMessageMeta message={item} /> : null}
                            {item.role !== "user" && itemAssets.length ? <CreativeAssetResults assets={itemAssets} messageText={displayContent} selectedAssetIds={selectedAssetIds} onToggleAsset={onToggleAsset} /> : null}
                            {handoff ? (
                                <ProjectHandoffAction
                                    handoff={handoff}
                                    project={projectLinks[handoff.id]}
                                    error={projectErrors[handoff.id]}
                                    loading={materializingProjectId === handoff.id}
                                    onMaterialize={() => void onMaterializeProject(handoff).catch(() => undefined)}
                                />
                            ) : null}
                            {item.role === "assistant" && failedRound ? <RetryAction onRetry={() => onRetryMessage(failedRound.assistant, failedRound.run)} detail={failedTasks.length ? `${failedTasks.length} 项生成失败` : undefined} /> : null}
                            {item.role !== "user" && item.status !== "running" ? <AgentMessageActions text={textAssetContent || (downloads.length ? "" : displayContent)} downloads={downloads.length ? [] : downloads} /> : null}
                        </div>
                        {item.role === "user" ? <CreativeUserAvatar className="mt-2 !size-8" avatarUrl={avatarUrl} fallback={avatarFallback} label={user?.displayName || user?.username || "用户"} /> : null}
                    </article>
                );
            })}
            <div ref={endRef} data-testid="creative-message-end" className="!mt-0 h-px" aria-hidden="true" />
        </div>
    );
}

function CreativeMediaRound({
    userMessage,
    assistantMessage,
    referencedAssets,
    outputAssets,
    run,
    modelNames,
    projectLinks,
    projectErrors,
    materializingProjectId,
    onMaterializeProject,
    onRetryMessage,
    selectedAssetIds,
    onToggleAsset,
}: {
    userMessage: CreativeMessage;
    assistantMessage: CreativeMessage;
    referencedAssets: CreativeAsset[];
    outputAssets: CreativeAsset[];
    run?: CreativeAgentRun;
    modelNames: ReadonlyMap<string, string>;
    projectLinks: Record<string, MaterializedCreativeProject>;
    projectErrors: Record<string, string>;
    materializingProjectId?: string;
    onMaterializeProject: (handoff: CreativeProjectHandoff) => Promise<MaterializedCreativeProject>;
    onRetryMessage: (message: CreativeMessage, run?: CreativeAgentRun) => Promise<boolean | void>;
    selectedAssetIds: string[];
    onToggleAsset: (id: string) => void;
}) {
    const siteLogoUrl = usePublicSessionStore((state) => state.payload?.settings?.site?.logoUrl || "/logo.svg");
    const displayContent = assistantMessage.status === "failed" ? friendlyAgentError(assistantMessage.content) : formatAgentMessageText(assistantMessage.content);
    const handoff = isCreativeProjectHandoff(assistantMessage.metadata.projectHandoff) ? assistantMessage.metadata.projectHandoff : null;
    const failedTasks = run?.tasks.filter((task) => task.status === "failed") || [];
    const reviewTasks = run?.tasks.filter((task) => task.status === "needs_review") || [];
    const isPausedMediaRound = run?.status === "paused";
    const failureReason = Array.from(new Set(failedTasks.map((task) => task.error?.trim()).filter((value): value is string => Boolean(value)))).join("；") || displayContent;
    const reviewReason = reviewTasks.map((task) => task.error?.trim()).find(Boolean) || "上游创建结果待确认；为避免重复生成和扣费，任务已暂停。";
    const mediaOutputs = outputAssets.filter((asset) => asset.type !== "text" && assetUrl(asset));
    const videoOutputs = mediaOutputs.filter((asset) => asset.type === "video");
    const otherMediaOutputs = mediaOutputs.filter((asset) => asset.type !== "video");
    const textOutputs = outputAssets.filter((asset) => asset.type === "text" && asset.status === "ready" && asset.textContent?.trim());
    const isFailedMediaRound = assistantMessage.status === "failed" && run?.status === "failed" && !mediaOutputs.length && !textOutputs.length;
    const showAssistantText = Boolean(displayContent.trim()) && !(assistantMessage.status === "completed" && (mediaOutputs.length || textOutputs.length));
    const mode = creativeRunMode(run);
    const taskTitle = run?.tasks.find((task) => task.type === mode)?.title.trim();
    const resultTitle = taskTitle?.startsWith("生成") ? `已为你${taskTitle}` : mode === "video" ? "已为你生成视频" : mode === "audio" ? "已为你生成音频" : "已为你生成图片";
    const renderRoundActions = (activeAsset: CreativeAsset) =>
        activeAsset.status === "ready" ? <CreativeRoundActions outputAssets={outputAssets} activeAsset={activeAsset} run={run} selectedAssetIds={selectedAssetIds} onToggleAsset={onToggleAsset} /> : null;

    return (
        <section data-testid="creative-media-round" className="pb-8 sm:pb-11">
            <div className="w-full min-w-0 space-y-5 sm:space-y-6">
                <div data-testid="creative-round-request" className="ml-auto min-w-0 max-w-[640px] text-right lg:-mr-8">
                    <div className="flex items-start justify-end gap-3">
                        <div className="min-w-0 max-w-[520px]">
                            {referencedAssets.length ? <CreativeRoundReferenceStrip assets={referencedAssets} /> : null}
                            <p className="whitespace-pre-wrap break-words rounded-[14px] bg-[linear-gradient(135deg,#f3f1ff_0%,#ebeaff_100%)] px-[18px] py-3 text-left text-[15px] leading-6 text-[#111827] dark:bg-[linear-gradient(135deg,#2d2a46_0%,#26243a_100%)] dark:text-[#f3f5f7]">
                                {userMessage.content}
                            </p>
                            <CreativeUserMessageMeta message={userMessage} />
                        </div>
                        <CreativeUserAvatar className="mt-2 !size-8" />
                    </div>
                </div>

                <div className="flex min-w-0 items-start gap-4 sm:gap-5">
                    <CreativeAssistantAvatar logoUrl={siteLogoUrl} />
                    <div className="min-w-0 flex-1">
                        {!isFailedMediaRound ? (
                            <>
                                <div className="mb-2 flex w-fit max-w-full flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                    <h2 className="truncate text-[17px] font-semibold leading-7 text-[#1f2937] dark:text-[#f3f5f7]">
                                        {isPausedMediaRound ? "任务已暂停" : assistantMessage.status === "running" ? (mode === "video" ? "正在生成视频" : mode === "audio" ? "正在生成音频" : "正在生成图片") : resultTitle}
                                    </h2>
                                    {assistantMessage.status === "running" && !isPausedMediaRound ? null : <CreativeRunTiming run={run} time={assistantMessage.createdAt} />}
                                </div>
                                <CreativeRunSummary run={run} modelNames={modelNames} />
                            </>
                        ) : null}
                        <div data-testid="creative-result-group" className="mt-3 flex w-fit max-w-full flex-col items-start">
                            {isFailedMediaRound ? (
                                <CreativeGenerationFailure message={failureReason} onRetry={() => onRetryMessage(assistantMessage, run)} />
                            ) : isPausedMediaRound ? (
                                <p data-testid="creative-generation-review" className="max-w-[620px] break-words py-1 text-[15px] font-medium leading-7 text-amber-700 dark:text-amber-300">
                                    {reviewReason}
                                </p>
                            ) : assistantMessage.status === "running" ? (
                                <CreativeGenerationWaiting run={run} message={assistantMessage} readyAssets={outputAssets} />
                            ) : showAssistantText ? (
                                <div
                                    className={cn(
                                        "mb-3 max-w-[612px] break-words text-sm leading-6 text-[#75808c] dark:text-[#929ca8]",
                                        assistantMessage.status === "failed" && "text-red-600 dark:text-red-300",
                                        assistantMessage.status === "cancelled" && "text-[#8b949f] dark:text-[#7f8996]",
                                    )}
                                >
                                    {assistantMessage.status === "completed" ? <AgentMarkdown>{displayContent}</AgentMarkdown> : <span className="whitespace-pre-wrap">{displayContent}</span>}
                                </div>
                            ) : null}
                            {textOutputs.length ? <CreativeAssetResults assets={textOutputs} messageText={displayContent} selectedAssetIds={selectedAssetIds} onToggleAsset={onToggleAsset} contained /> : null}
                            {videoOutputs.length ? (
                                <>
                                    <CreativeVideoResult
                                        assets={videoOutputs}
                                        message={assistantMessage}
                                        fallbackResolution={run?.tasks.find((task) => task.type === "video")?.quality || run?.generationPreferences?.video?.quality}
                                        fallbackRatio={run?.tasks.find((task) => task.type === "video")?.ratio || run?.generationPreferences?.video?.size}
                                        renderActions={renderRoundActions}
                                    />
                                    {otherMediaOutputs.length ? (
                                        <div className="mt-3">
                                            <CreativeMediaResult assets={otherMediaOutputs} fallbackRatio={run?.tasks.find((task) => task.type === "image")?.ratio || run?.generationPreferences?.image?.size} />
                                        </div>
                                    ) : null}
                                </>
                            ) : mediaOutputs.length ? (
                                <CreativeMediaResult assets={mediaOutputs} fallbackRatio={run?.tasks.find((task) => task.type === "image")?.ratio || run?.generationPreferences?.image?.size} renderActions={renderRoundActions} />
                            ) : assistantMessage.status === "completed" && textOutputs.length ? (
                                <CreativeRoundActions outputAssets={outputAssets} run={run} selectedAssetIds={selectedAssetIds} onToggleAsset={onToggleAsset} />
                            ) : null}
                        </div>
                        {handoff ? (
                            <ProjectHandoffAction
                                handoff={handoff}
                                project={projectLinks[handoff.id]}
                                error={projectErrors[handoff.id]}
                                loading={materializingProjectId === handoff.id}
                                onMaterialize={() => void onMaterializeProject(handoff).catch(() => undefined)}
                            />
                        ) : null}
                        {!isFailedMediaRound && failedTasks.length ? <RetryAction onRetry={() => onRetryMessage(assistantMessage, run)} detail={`${failedTasks.length} 项生成失败`} /> : null}
                    </div>
                </div>
            </div>
        </section>
    );
}

function CreativeRoundReferenceStrip({ assets }: { assets: CreativeAsset[] }) {
    let imageIndex = 0;
    return (
        <div className="hide-scrollbar mb-2 ml-auto flex max-w-[176px] justify-end gap-1.5 overflow-x-auto pb-0.5" aria-label="本轮参考素材">
            {assets.map((asset) => {
                const url = assetUrl(asset);
                if (!url || asset.type === "text") return null;
                const label = asset.type === "image" ? imageReferenceLabel(imageIndex++) : asset.type === "video" ? "视频" : "音频";
                return (
                    <div
                        key={asset.id}
                        className="relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border border-[#dde2e7] bg-[#eef1f4] text-[#697582] dark:border-[#3b424b] dark:bg-[#252a31] dark:text-[#aab2bc]"
                        title={asset.title}
                    >
                        {asset.type === "image" ? <img src={imagePreviewUrl(url, 192)} alt={asset.title || "参考图"} loading="lazy" className="size-full object-cover" /> : null}
                        {asset.type === "video" ? <Film className="size-5" aria-hidden /> : null}
                        {asset.type === "audio" ? <FileAudio2 className="size-5" aria-hidden /> : null}
                        <span className="absolute left-1 top-1 rounded-sm bg-black/68 px-1 py-0.5 text-[9px] font-medium leading-none text-white">{label}</span>
                    </div>
                );
            })}
        </div>
    );
}

function CreativeUserAvatar({ avatarUrl, fallback, label, className }: { avatarUrl?: string; fallback?: string; label?: string; className?: string }) {
    const user = usePublicSessionStore((state) => state.payload?.user || null);
    const resolvedAvatarUrl = avatarUrl ?? user?.avatarUrl?.trim();
    const resolvedFallback = fallback ?? userAvatarFallback(user?.displayName || user?.username || "用户");
    const resolvedLabel = label ?? user?.displayName ?? user?.username ?? "用户";
    return (
        <span data-testid="creative-user-avatar" className={cn("grid size-7 shrink-0 place-items-center overflow-hidden rounded-full", className)} role="img" aria-label={resolvedLabel}>
            {resolvedAvatarUrl ? (
                <img src={resolvedAvatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
            ) : (
                <span aria-hidden="true" className="grid size-full place-items-center rounded-full bg-[#66758e] text-[10px] font-semibold leading-none text-white ring-1 ring-black/5 dark:bg-[#d8dee8] dark:text-[#252b33] dark:ring-white/10">
                    {resolvedFallback}
                </span>
            )}
        </span>
    );
}

function CreativeUserMessageMeta({ message }: { message: CreativeMessage }) {
    const copyText = useCopyText();
    return (
        <div className="mt-1 flex min-h-6 items-center justify-end gap-1 pr-0.5 text-[#98a2b3] dark:text-[#7f8996]">
            <time className="text-[11px] leading-4" dateTime={new Date(message.createdAt).toISOString()}>
                {formatCreativeMessageTime(message.createdAt)}
            </time>
            <Tooltip title="复制输入内容">
                <button
                    type="button"
                    className="grid size-6 place-items-center rounded-md text-current transition-colors hover:bg-[#f3f4f6] hover:text-[#475467] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:hover:bg-[#252a31] dark:hover:text-[#d0d5dd]"
                    onClick={() => copyText(message.content, "输入内容已复制")}
                    aria-label="复制输入内容"
                >
                    <Copy className="size-3" />
                </button>
            </Tooltip>
        </div>
    );
}

function CreativeAssistantAvatar({ logoUrl, className }: { logoUrl?: string; className?: string }) {
    return (
        <span
            data-testid="creative-assistant-avatar"
            className={cn("grid size-11 shrink-0 place-items-center rounded-full border border-[#b9b5ff] bg-white text-[#615cff] shadow-[0_4px_14px_rgba(97,92,255,0.08)] dark:border-[#514b81] dark:bg-[#1d2025]", className)}
            aria-label="创作助手"
        >
            <SiteLogo logoUrl={logoUrl || "/logo.svg"} className="size-6" />
        </span>
    );
}

function CreativeRunSummary({ run, modelNames }: { run?: CreativeAgentRun; modelNames: ReadonlyMap<string, string> }) {
    const items = creativeRunPresentation(run, modelNames);
    if (!items.length) return null;
    const summaryItems = items.filter((item) => item.key !== "mode" && item.key !== "status");
    const duration = creativeRunDuration(run);
    return (
        <div className="w-fit max-w-full text-[#667085] dark:text-[#a0a9b4]" aria-label="本轮创作参数">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {summaryItems.map((item) => (
                    <span
                        key={item.key}
                        title={`${item.label}：${item.value}`}
                        className="inline-flex h-6 max-w-[180px] items-center truncate rounded-md border border-[#e9ecf0] bg-white px-2 text-[11px] leading-none dark:border-[#343a43] dark:bg-[#1b1f24]"
                    >
                        {item.value}
                    </span>
                ))}
                <Popover
                    trigger="click"
                    placement="bottomLeft"
                    arrow={false}
                    content={
                        <div className="w-[min(280px,calc(100vw-56px))] py-1">
                            <p className="mb-2 text-sm font-semibold text-[#20242a] dark:text-[#f3f5f7]">本轮创作详情</p>
                            <dl className="space-y-2">
                                {items.map((item) => (
                                    <div key={item.key} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 text-xs leading-5">
                                        <dt className="text-[#8b949f] dark:text-[#7f8996]">{item.label}</dt>
                                        <dd className="min-w-0 break-words text-[#3c4652] dark:text-[#d5dae0]">{item.value}</dd>
                                    </div>
                                ))}
                                {duration ? (
                                    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 text-xs leading-5">
                                        <dt className="text-[#8b949f] dark:text-[#7f8996]">生成耗时</dt>
                                        <dd className="text-[#3c4652] dark:text-[#d5dae0]">{duration}</dd>
                                    </div>
                                ) : null}
                            </dl>
                        </div>
                    }
                >
                    <button
                        type="button"
                        className="inline-flex size-6 items-center justify-center rounded-md text-[#98a2b3] transition-colors duration-150 hover:bg-[#f4f5f7] hover:text-[#344054] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#615cff]/30 dark:text-[#7f8996] dark:hover:bg-[#252a31] dark:hover:text-white"
                        aria-label="查看本轮创作详细信息"
                    >
                        <Info className="size-3.5" />
                    </button>
                </Popover>
            </div>
        </div>
    );
}

function CreativeRunTiming({ run, time }: { run?: CreativeAgentRun; time: number }) {
    const duration = creativeRunDuration(run);
    const completedAt = run?.updatedAt || time;
    return (
        <div data-testid="creative-run-timing" className="inline-flex shrink-0 items-center gap-1 text-[11px] font-normal leading-5 text-[#98a2b3] dark:text-[#7f8996]">
            <Clock3 className="size-3" aria-hidden />
            <time aria-label={`完成时间：${formatCreativeMessageTime(completedAt)}`} dateTime={new Date(completedAt).toISOString()}>
                {formatCreativeMessageTime(completedAt)}
            </time>
            {duration ? <span aria-hidden>·</span> : null}
            {duration ? <span aria-label={`生成耗时：${duration}`}>{duration}</span> : null}
        </div>
    );
}

export function creativeReferenceAction(activeAsset: CreativeAsset | undefined, selectedAssetIds: readonly string[]) {
    if (!activeAsset || activeAsset.status !== "ready" || activeAsset.type === "text") return undefined;
    return { assetId: activeAsset.id, referenced: selectedAssetIds.includes(activeAsset.id) };
}

function CreativeRoundActions({ outputAssets, activeAsset, run, selectedAssetIds, onToggleAsset }: { outputAssets: CreativeAsset[]; activeAsset?: CreativeAsset; run?: CreativeAgentRun; selectedAssetIds: string[]; onToggleAsset: (id: string) => void }) {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [copyingPrompt, setCopyingPrompt] = useState(false);
    const downloads = agentAssetDownloads(activeAsset ? [activeAsset] : outputAssets);
    const allDownloads = agentAssetDownloads(outputAssets.filter((asset) => asset.status === "ready"));
    const referenceAction = creativeReferenceAction(activeAsset, selectedAssetIds);
    const primaryDownload = downloads[0];
    const mode = creativeRunMode(run);
    const optimizedPrompt = creativeResultPrompt(activeAsset, outputAssets, run);
    const menuItems = [
        { key: "copy-prompt", label: copyingPrompt ? "正在复制提示词" : "复制提示词", icon: <Copy className="size-4" />, disabled: copyingPrompt },
        ...(primaryDownload ? [{ key: "copy-link", label: "复制链接", icon: <Link2 className="size-4" /> }] : []),
        ...(referenceAction ? [{ key: "reference", label: referenceAction.referenced ? "取消引用" : "引用结果", icon: <Link2 className="size-4" /> }] : []),
    ];
    const actionClass =
        "!flex !h-8 !min-w-0 !items-center !justify-center !gap-1.5 !overflow-hidden !whitespace-nowrap !rounded-md !border !border-[#e4e7ec] !bg-white !px-2.5 !text-[11px] !font-medium !text-[#667085] !shadow-none hover:!border-[#d0d5dd] hover:!bg-[#f8f9fb] hover:!text-[#344054] disabled:!border-[#edf0f2] disabled:!bg-[#f8f9fa] disabled:!text-[#b3bac4] dark:!border-[#343a43] dark:!bg-[#181b20] dark:!text-[#aab2bc] dark:hover:!border-[#4a525c] dark:hover:!bg-[#22262c] dark:hover:!text-white dark:disabled:!border-[#2a2f36] dark:disabled:!bg-[#1a1d22] dark:disabled:!text-[#5f6873]";
    const downloadButton = (
        <Button className={cn(actionClass, "!w-full")} disabled={!downloads.length} icon={<Download className="size-3.5" />}>
            {mode === "video" ? "下载视频" : "下载"}
        </Button>
    );
    const copyOptimizedPrompt = async () => {
        if (copyingPrompt) return;
        setCopyingPrompt(true);
        try {
            const prompt = optimizedPrompt || (run?.id ? creativeResultPrompt(activeAsset, outputAssets, await getCreativeAgentRun(run.id)) : "");
            if (!prompt) {
                message.warning("当前结果没有可公开复制的优化提示词");
                return;
            }
            copyText(prompt, "优化提示词已复制");
        } catch {
            message.error("读取优化提示词失败，请稍后重试");
        } finally {
            setCopyingPrompt(false);
        }
    };
    return (
        <div data-active-asset-id={activeAsset?.id} className={cn("mt-2 grid w-max items-center gap-1.5", mode === "video" ? "grid-cols-[94px_32px]" : "grid-cols-[72px_32px]")} aria-label="本轮创作操作">
            {allDownloads.length > 1 ? (
                <Dropdown
                    trigger={["click"]}
                    menu={{
                        items: [
                            { key: "current", label: "下载当前结果", icon: <Download className="size-4" /> },
                            { key: "all", label: `下载全部结果（${allDownloads.length}）`, icon: <Download className="size-4" /> },
                        ],
                        onClick: ({ key }) => downloadAgentMedia(key === "all" ? allDownloads : downloads),
                    }}
                >
                    {downloadButton}
                </Dropdown>
            ) : (
                <Button className={cn(actionClass, "!w-full")} disabled={!downloads.length} icon={<Download className="size-3.5" />} onClick={() => downloadAgentMedia(downloads)}>
                    {mode === "video" ? "下载视频" : "下载"}
                </Button>
            )}
            {menuItems.length ? (
                <Dropdown
                    trigger={["click"]}
                    menu={{
                        items: menuItems,
                        onClick: ({ key }) => {
                            if (key === "copy-prompt") void copyOptimizedPrompt();
                            if (key === "copy-link" && primaryDownload) void copyText(primaryDownload.url, "链接已复制");
                            if (key === "reference" && referenceAction) onToggleAsset(referenceAction.assetId);
                        },
                    }}
                >
                    <Button className={cn(actionClass, "!w-8 !px-0")} icon={<MoreHorizontal className="size-3.5" />} aria-label="更多本轮创作操作" title="更多操作" />
                </Dropdown>
            ) : null}
        </div>
    );
}

export function creativeResultPrompt(activeAsset: CreativeAsset | undefined, outputAssets: CreativeAsset[], run?: CreativeAgentRun) {
    const asset = activeAsset || outputAssets.find((item) => item.status === "ready");
    const taskId = typeof asset?.metadata.agentTaskId === "string" ? asset.metadata.agentTaskId.trim() : asset?.sourceTaskId?.trim();
    const task = taskId ? run?.tasks.find((item) => item.id === taskId) : run?.tasks.length === 1 ? run.tasks[0] : undefined;
    return task?.optimizedPrompt?.trim() || "";
}

function assetsForAssistant(message: CreativeMessage, assetsByMessage: Map<string, CreativeAsset[]>) {
    return [...(assetsByMessage.get(message.id) || []), ...(message.runId ? assetsByMessage.get(message.runId) || [] : [])].filter((asset, index, list) => list.findIndex((current) => current.id === asset.id) === index);
}

function CreativeGenerationFailure({ message, onRetry }: { message: string; onRetry: () => Promise<boolean | void> }) {
    const [retrying, setRetrying] = useState(false);
    return (
        <div data-testid="creative-generation-failure" className="max-w-[620px] py-1">
            <div className="min-w-0">
                <p className="break-words text-[17px] font-medium leading-7 text-[#ef2b2d] dark:text-[#ff8b8d]">{message || "创作任务执行失败"}</p>
                <Button
                    type="default"
                    className="!mt-3 !h-9 !rounded-[10px] !border-[#ffd4d5] !bg-white !px-4 !text-sm !font-medium !text-[#e22b2e] hover:!border-[#ffb7b8] hover:!bg-[#fff8f8] hover:!text-[#c51f22] dark:!border-[#6b3438] dark:!bg-transparent dark:!text-[#ff9a9c] dark:hover:!border-[#9a4a4e] dark:hover:!bg-[#321e20]"
                    icon={<RotateCw className="size-4" />}
                    loading={retrying}
                    onClick={() => void runRetry(onRetry, setRetrying)}
                    aria-label="直接重试本次创作"
                >
                    直接重试
                </Button>
            </div>
        </div>
    );
}

function messageAssetIds(message: CreativeMessage) {
    const value = message.metadata.assetIds;
    return Array.isArray(value) ? Array.from(new Set(value.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))) : [];
}

function RetryAction({ onRetry, detail }: { onRetry: () => Promise<boolean | void>; detail?: string }) {
    const [retrying, setRetrying] = useState(false);
    return (
        <div className="mt-2 flex max-w-full items-center gap-2">
            {detail ? <span className="text-xs text-red-600 dark:text-red-300">{detail}</span> : null}
            <Button
                type="text"
                size="small"
                className="!h-8 !rounded-md !px-2 !text-xs !font-medium !text-red-700 hover:!bg-red-50 hover:!text-red-800 dark:!text-red-300 dark:hover:!bg-red-950/30 dark:hover:!text-red-200"
                icon={<RotateCw className="size-3.5" />}
                loading={retrying}
                onClick={() => void runRetry(onRetry, setRetrying)}
                aria-label="直接重试本次创作"
            >
                直接重试
            </Button>
        </div>
    );
}

async function runRetry(retry: () => Promise<boolean | void>, setRetrying: (value: boolean) => void) {
    setRetrying(true);
    try {
        await retry();
    } finally {
        setRetrying(false);
    }
}

function creativeRoundFailed(message: CreativeMessage, run?: CreativeAgentRun) {
    return message.status === "failed" || run?.status === "failed" || run?.tasks.some((task) => task.status === "failed") === true;
}

function ProjectHandoffAction({ handoff, project, error, loading, onMaterialize }: { handoff: CreativeProjectHandoff; project?: MaterializedCreativeProject; error?: string; loading: boolean; onMaterialize: () => void }) {
    const Icon = handoff.surface === "canvas" ? PanelsTopLeft : Clapperboard;
    const label = handoff.surface === "canvas" ? "画布项目" : "短剧项目";
    return (
        <div className="mt-4 flex min-h-14 items-center gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 dark:border-stone-700 dark:bg-stone-900">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-white text-stone-700 dark:bg-stone-800 dark:text-stone-200">
                <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{handoff.title}</span>
                <span className={cn("mt-0.5 block text-xs text-stone-500 dark:text-stone-400", error && "text-red-600 dark:text-red-300")}>{error || `${handoff.assets.length} 份资产已交接到${label}`}</span>
            </span>
            {project ? (
                <Link
                    href={project.href}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition hover:border-stone-400 hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-100 dark:hover:border-stone-500 dark:hover:bg-stone-700"
                >
                    打开 <ExternalLink className="size-3.5" />
                </Link>
            ) : (
                <Button className="!h-9 !shrink-0" loading={loading} onClick={onMaterialize}>
                    {error ? "重试" : "创建项目"}
                </Button>
            )}
        </div>
    );
}

function CreativeAssetResults({
    assets,
    messageText,
    selectedAssetIds,
    onToggleAsset,
    showItemActions = true,
    contained = false,
}: {
    assets: CreativeAsset[];
    messageText: string;
    selectedAssetIds: string[];
    onToggleAsset: (id: string) => void;
    showItemActions?: boolean;
    contained?: boolean;
}) {
    const [loadedDimensions, setLoadedDimensions] = useState<Record<string, { width: number; height: number }>>({});
    const copyText = useCopyText();
    const textAssets = assets.filter((asset) => asset.type === "text" && asset.status === "ready" && asset.textContent?.trim());
    const media = assets.filter((asset) => asset.type !== "text" && assetUrl(asset));
    const updateDimensions = useCallback((id: string, width: number, height: number) => {
        if (width <= 0 || height <= 0) return;
        setLoadedDimensions((current) => (current[id]?.width === width && current[id]?.height === height ? current : { ...current, [id]: { width, height } }));
    }, []);
    if (!textAssets.length && !media.length) return null;
    return (
        <>
            {textAssets.length ? (
                <div className="mt-3 w-full max-w-[760px] space-y-5 sm:mt-4">
                    {textAssets.map((asset, index) => (
                        <section key={asset.id} aria-label={`文本产物：${asset.title || index + 1}`} className="min-w-0 border-l border-stone-200 pl-3.5 text-[15px] leading-7 dark:border-stone-700 sm:pl-4">
                            <div className="mb-1.5 text-xs font-medium text-stone-500 dark:text-stone-400">{asset.title || `文本结果 ${index + 1}`}</div>
                            <AgentMarkdown>{formatAgentArtifactText(asset.textContent!)}</AgentMarkdown>
                        </section>
                    ))}
                </div>
            ) : null}
            {media.length ? (
                <div className={cn("flex max-w-full flex-wrap items-start gap-2 sm:gap-3", contained ? "w-fit" : "mt-3 w-full max-w-[1040px] sm:mt-4", media.length > 1 && "max-w-[420px]")}>
                    {media.map((asset) => {
                        const url = assetUrl(asset)!;
                        const selected = selectedAssetIds.includes(asset.id);
                        const featured = media.length === 1 && (asset.type === "image" || asset.type === "video");
                        const layout = creativeAssetLayout(loadedDimensions[asset.id] || asset, { variant: featured ? (asset.type === "video" ? "video-result" : "image-result") : "compact" });
                        return (
                            <div key={asset.id} style={layout?.container} className={cn("min-w-0 max-w-full flex-none", !layout && (featured ? "w-fit max-w-full" : "w-[min(100%,200px)]"), media.length > 1 && "max-[480px]:!w-[calc(50%-4px)]")}>
                                <figure className={cn("relative w-full overflow-hidden rounded-md", asset.type === "audio" && "border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900")}>
                                    {asset.type === "audio" ? (
                                        <div className="p-3 sm:p-4">
                                            <AgentMediaPreview type={asset.type} url={url} title={asset.title || "生成音频"} />
                                        </div>
                                    ) : (
                                        <div style={layout?.media} className={cn("overflow-hidden", layout || asset.type === "video" ? "w-full" : "w-fit max-w-full", !layout && asset.type === "video" && "aspect-video")}>
                                            <AgentMediaPreview
                                                type={asset.type}
                                                url={url}
                                                title={asset.title || (asset.type === "video" ? "生成视频" : "生成图片")}
                                                className={!layout && asset.type === "image" ? "w-fit max-w-full" : "size-full"}
                                                fit={!layout && asset.type === "image" ? "intrinsic" : "contain"}
                                                onDimensions={(width, height) => updateDimensions(asset.id, width, height)}
                                            />
                                        </div>
                                    )}
                                </figure>
                                {showItemActions && (asset.type === "image" || asset.type === "video") ? (
                                    <div className="mt-1 flex min-h-8 items-center justify-end gap-0.5 text-stone-500 dark:text-stone-400">
                                        {asset.status === "ready" ? (
                                            <Tooltip title={selected ? "取消引用" : "引用素材"}>
                                                <button
                                                    type="button"
                                                    aria-label={selected ? "取消引用素材" : "引用素材"}
                                                    aria-pressed={selected}
                                                    className={cn(
                                                        "grid size-8 place-items-center text-current transition hover:text-stone-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:text-white sm:size-7",
                                                        selected && "text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300",
                                                    )}
                                                    onClick={() => onToggleAsset(asset.id)}
                                                >
                                                    {selected ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
                                                </button>
                                            </Tooltip>
                                        ) : null}
                                        <Tooltip title={asset.type === "video" ? "下载视频" : "下载图片"}>
                                            <button
                                                type="button"
                                                aria-label={asset.type === "video" ? "下载视频" : "下载图片"}
                                                className="grid size-8 place-items-center text-current transition hover:text-stone-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:text-white sm:size-7"
                                                onClick={() => downloadAgentMedia([agentAssetDownload(asset)])}
                                            >
                                                <Download className="size-3.5" />
                                            </button>
                                        </Tooltip>
                                        {messageText.trim() ? (
                                            <Tooltip title="复制消息">
                                                <button
                                                    type="button"
                                                    aria-label="复制消息"
                                                    className="grid size-8 place-items-center text-current transition hover:text-stone-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:text-white sm:size-7"
                                                    onClick={() => copyText(messageText, "消息已复制")}
                                                >
                                                    <Copy className="size-3.5" />
                                                </button>
                                            </Tooltip>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </>
    );
}

function assetUrl(asset: CreativeAsset) {
    return asset.serverUrl || asset.remoteUrl || "";
}

function agentAssetDownloads(assets: CreativeAsset[]): AgentMediaDownload[] {
    return assets.flatMap((asset) => {
        const url = assetUrl(asset);
        return url && (asset.type === "image" || asset.type === "video") ? [{ type: asset.type, url, title: asset.title || (asset.type === "video" ? "生成视频" : "生成图片"), mimeType: asset.mimeType }] : [];
    });
}

function agentAssetDownload(asset: CreativeAsset): AgentMediaDownload {
    return {
        type: asset.type === "video" ? "video" : "image",
        url: assetUrl(asset)!,
        title: asset.title || (asset.type === "video" ? "生成视频" : "生成图片"),
        mimeType: asset.mimeType,
    };
}
