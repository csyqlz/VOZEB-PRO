"use client";

import { Button, Checkbox, Popconfirm, Tag } from "antd";
import { Eye, Film, Image as ImageIcon, ListChecks, ScanSearch, ShieldCheck, Trash2 } from "lucide-react";

import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { AdminAccountId } from "@/components/admin/admin-user-identity";
import { imagePreviewUrl } from "@/lib/media-image-url";
import type { StoredGenerationLog } from "@/lib/server/generation-log-store";
import type { EcommerceGenerationTrace, EcommerceGenerationTraceStage } from "@/lib/server/ecommerce-generation-trace";

export function GenerationLogAssetPreview({ log }: { log: StoredGenerationLog }) {
    const asset = log.assets[0];
    const assetUrl = asset ? generationLogAssetAccessUrl(asset) : "";
    if (!assetUrl) {
        return (
            <div className="flex size-12 items-center justify-center rounded-lg border border-stone-200 bg-stone-100 text-stone-400 dark:border-stone-800 dark:bg-stone-900">
                {log.kind === "video" ? <Film className="size-4" /> : <ImageIcon className="size-4" />}
            </div>
        );
    }
    if (asset.type === "video") {
        return <video className="size-12 rounded-lg border border-stone-200 bg-stone-100 object-cover dark:border-stone-800 dark:bg-stone-900" src={assetUrl} muted playsInline preload="metadata" />;
    }
    return <img className="size-12 rounded-lg border border-stone-200 bg-stone-100 object-cover dark:border-stone-800 dark:bg-stone-900" src={imagePreviewUrl(assetUrl, 256)} alt="" loading="lazy" referrerPolicy="no-referrer" />;
}

export function GenerationLogMobileCard({ log, selected, onSelectedChange, onView, onDelete }: { log: StoredGenerationLog; selected: boolean; onSelectedChange: (checked: boolean) => void; onView: () => void; onDelete: () => void }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3">
                <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Tag className="m-0" color={log.kind === "video" ? "purple" : "blue"}>
                            {generationKindLabel(log.kind)}
                        </Tag>
                        <span className={generationStatusClass(log.status)}>{generationStatusLabel(log.status)}</span>
                        <span className="text-xs text-stone-500">{generationSourceLabel(log.source)}</span>
                    </div>
                    <div className="mt-2 truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{log.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{log.prompt || log.summary}</div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                        <span>{formatAdminLogTime(log.createdAt)}</span>
                        <span>{log.displayName || log.username}</span>
                        <AdminAccountId accountId={log.accountId} />
                        <span>{formatAdminLogDuration(log.durationMs)}</span>
                    </div>
                </div>
                <GenerationLogAssetPreview log={log} />
            </div>
            <div className="mt-3 flex justify-end gap-2">
                <Button size="small" icon={<Eye className="size-3.5" />} onClick={onView}>
                    详情
                </Button>
                <Popconfirm title="删除这条生成日志？" okText="删除" cancelText="取消" onConfirm={onDelete}>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                        删除
                    </Button>
                </Popconfirm>
            </div>
        </div>
    );
}

export function GenerationLogDetail({ log }: { log: StoredGenerationLog }) {
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <InfoBox label="用户" value={`${log.displayName || log.username} / ${log.username || "-"}${log.accountId ? ` / ID：${log.accountId}` : ""}`} />
                <InfoBox label="入口" value={generationSourceLabel(log.source)} />
                <InfoBox label="类型" value={generationKindLabel(log.kind)} />
                <InfoBox label="状态" value={generationStatusLabel(log.status)} />
                <InfoBox label="时间" value={formatAdminLogTime(log.createdAt)} />
                <InfoBox label="耗时" value={formatAdminLogDuration(log.durationMs)} />
                <InfoBox label="模型" value={formatGenerationLogModel(log.model)} />
                <InfoBox label="数量" value={`成功 ${log.successCount} / 失败 ${log.failCount} / 共 ${log.count}`} />
            </div>
            <GenerationLogResultSection log={log} />
            {log.ecommerceTrace ? <EcommerceGenerationTraceSection trace={log.ecommerceTrace} /> : null}
            <div>
                <div className="mb-1 text-sm font-semibold text-stone-950 dark:text-stone-100">提示词</div>
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm leading-6 text-stone-700 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200">{log.prompt || "-"}</div>
            </div>
            {log.error ? (
                <div>
                    <div className="mb-1 text-sm font-semibold text-red-600 dark:text-red-300">错误信息</div>
                    <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{log.error}</div>
                </div>
            ) : null}
        </div>
    );
}

function EcommerceGenerationTraceSection({ trace }: { trace: EcommerceGenerationTrace }) {
    return (
        <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">电商执行流水</div>
                <Tag className="m-0" color={trace.finalStatus === "passed" ? "success" : trace.finalStatus === "needs_adjustment" ? "warning" : "error"}>
                    {traceStatusLabel(trace.finalStatus)}
                </Tag>
            </div>
            <div className="mb-3 grid gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400 sm:grid-cols-2">
                <span className="min-w-0 break-all">Run：{trace.runId}</span>
                <span className="min-w-0 break-all">图片任务：{trace.imageTaskIds.join("、") || "-"}</span>
            </div>
            <div className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                {trace.stages.map((stage) => (
                    <TraceStage key={stage.key} stage={stage} />
                ))}
            </div>
        </section>
    );
}

function TraceStage({ stage }: { stage: EcommerceGenerationTraceStage }) {
    const Icon = stage.key === "visual_analysis" ? ScanSearch : stage.key === "edit_planning" ? ListChecks : stage.key === "image_generation" ? ImageIcon : ShieldCheck;
    const model = [stage.model?.logicalModelId, stage.model?.upstreamModel].filter(Boolean).join(" → ") || "未执行";
    return (
        <div className="py-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2.5">
                    <Icon className="mt-0.5 size-4 shrink-0 text-stone-500 dark:text-stone-400" />
                    <div className="min-w-0">
                        <div className="text-sm font-medium text-stone-900 dark:text-stone-100">{traceStageLabel(stage.key)}</div>
                        <div className="mt-1 break-all text-xs text-stone-500 dark:text-stone-400">{model}</div>
                        {stage.model?.channelId ? <div className="mt-0.5 break-all text-xs text-stone-400 dark:text-stone-500">渠道：{stage.model.channelId}</div> : null}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {stage.completedAt !== undefined ? <span className="text-xs tabular-nums text-stone-400">{formatTraceTime(stage.completedAt)}</span> : null}
                    <Tag className="m-0" color={traceStatusTone(stage.status)}>
                        {traceStatusLabel(stage.status)}
                    </Tag>
                </div>
            </div>
            <details className="mt-2 pl-6">
                <summary className="cursor-pointer select-none text-xs font-medium text-stone-600 dark:text-stone-300">结构化输出</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all border-l-2 border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200">
                    {JSON.stringify(stage.output, null, 2)}
                </pre>
            </details>
        </div>
    );
}

function traceStageLabel(key: EcommerceGenerationTraceStage["key"]) {
    if (key === "visual_analysis") return "视觉分析";
    if (key === "edit_planning") return "编辑规划";
    if (key === "image_generation") return "图片生成";
    return "结果验收";
}

function traceStatusLabel(status: string) {
    if (status === "completed") return "已完成";
    if (status === "passed") return "通过";
    if (status === "needs_adjustment") return "待调整";
    if (status === "blocked" || status === "needs_review") return "待复核";
    if (status === "unavailable") return "不可用";
    if (status === "failed") return "失败";
    if (status === "not_run") return "未执行";
    return status || "-";
}

function traceStatusTone(status: string) {
    if (status === "completed" || status === "passed") return "success";
    if (status === "needs_adjustment") return "warning";
    if (status === "not_run") return "default";
    return "error";
}

function formatTraceTime(value: number) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}

function GenerationLogResultSection({ log }: { log: StoredGenerationLog }) {
    const assets = (log.assets || []).filter((asset) => Boolean(generationLogAssetAccessUrl(asset)));
    if (!assets.length) {
        return (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 dark:border-stone-700 dark:bg-stone-900/70">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                    {log.kind === "video" ? <Film className="size-4" /> : <ImageIcon className="size-4" />}
                    生成结果
                </div>
                <div className="text-sm leading-6 text-stone-500 dark:text-stone-400">{log.status === "success" ? "这条日志没有可访问的媒体文件。" : "这条日志没有成功结果，暂无可预览的图片或视频。"}</div>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">生成结果</div>
                <Tag className="m-0" color={log.kind === "video" ? "purple" : "blue"}>
                    {assets.length} 个结果
                </Tag>
            </div>
            <div className="space-y-3">
                {assets.map((asset, index) => {
                    const assetUrl = generationLogAssetAccessUrl(asset);
                    return (
                        <div key={`${asset.url}-${index}`} className="grid min-w-0 items-start gap-3 rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950/60 sm:grid-cols-[156px_minmax(0,1fr)]">
                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                                    <span>{asset.type === "video" ? `视频 ${index + 1}` : `图片 ${index + 1}`}</span>
                                    {asset.width || asset.height ? <span className="shrink-0 tabular-nums">{[asset.width, asset.height].filter(Boolean).join("x")}</span> : null}
                                </div>
                                <div className="flex h-32 items-center justify-center overflow-hidden rounded-md bg-stone-100 p-2 dark:bg-stone-900 sm:h-36">
                                    {asset.type === "video" ? (
                                        <video className="h-full w-full rounded bg-black object-contain" src={assetUrl} controls playsInline preload="metadata" />
                                    ) : (
                                        <img className="h-full w-full object-contain" src={imagePreviewUrl(assetUrl, 960)} alt="" referrerPolicy="no-referrer" loading="lazy" />
                                    )}
                                </div>
                            </div>
                            <div className="min-w-0 self-center text-sm text-stone-500 dark:text-stone-400">
                                <div>{asset.type === "video" ? "视频" : "图片"}</div>
                                <div className="mt-1 text-xs">{asset.bytes ? formatAssetBytes(asset.bytes) : "大小未记录"}</div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function generationLogAssetAccessUrl(asset: StoredGenerationLog["assets"][number]) {
    const directUrl = asset.url && !asset.url.startsWith("/api/generation-log-assets/") && asset.url !== asset.serverUrl ? asset.url : "";
    const serverUrl = asset.serverUrl || (asset.url?.startsWith("/api/generation-log-assets/") ? asset.url : "");
    return browserReadableMediaUrl(asset.remoteUrl || directUrl || serverUrl || asset.serverUrl || (asset.url?.startsWith("/api/generation-log-assets/") ? asset.url : ""));
}

function formatAssetBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatGenerationLogModel(model: string) {
    const value = (model || "").trim();
    if (!value) return "-";
    const separatorIndex = value.indexOf("::");
    return separatorIndex >= 0 ? value.slice(separatorIndex + 2).trim() || value : value;
}

export function formatAdminLogTime(value: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "-";
    return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatAdminLogDuration(value: number) {
    if (!value) return "-";
    if (value < 1000) return `${Math.round(value)}ms`;
    return `${(value / 1000).toFixed(2)}s`;
}

export function generationKindLabel(value: string) {
    return value === "video" ? "视频" : "图片";
}

export function generationSourceLabel(value: string) {
    if (value === "agent") return "Agent 工作台";
    if (value === "canvas") return "画布";
    if (value === "drama") return "短剧";
    if (value === "video-workbench") return "视频生成";
    if (value === "image-workbench") return "图片生成";
    return "未知入口";
}

export function generationStatusLabel(value: string) {
    if (value === "success") return "成功";
    if (value === "failed") return "失败";
    if (value === "pending") return "生成中";
    return value || "-";
}

export function generationStatusClass(value: string) {
    if (value === "success") return "inline-flex h-6 items-center rounded-md bg-emerald-50 px-2 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-500/25";
    if (value === "failed") return "inline-flex h-6 items-center rounded-md bg-rose-50 px-2 text-xs font-medium text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-200 dark:ring-rose-500/25";
    return "inline-flex h-6 items-center rounded-md bg-sky-50 px-2 text-xs font-medium text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-500/25";
}

function InfoBox({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-800 dark:bg-stone-900">
            <div className="text-xs text-stone-500 dark:text-stone-400">{label}</div>
            <div className="mt-1 truncate text-sm font-medium text-stone-900 dark:text-stone-100" title={value}>
                {value}
            </div>
        </div>
    );
}
