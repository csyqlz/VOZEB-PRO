"use client";

import { useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Pagination, Segmented, Select } from "antd";
import { BookOpenText, CheckCircle2, CircleDashed, FileText, Loader2, Search, Sparkles, XCircle } from "lucide-react";
import { nanoid } from "nanoid";

import { splitDramaSource, type DramaSourceEpisodeDraft } from "@/lib/drama-source-splitter";
import { readDramaSourceFile } from "@/lib/drama-source-reader";
import type { DramaProject } from "../types";
import { useDramaStore } from "../stores/use-drama-store";
import type { DramaOrganizeModelOption } from "./drama-project-sections";

const IMPORT_PAGE_SIZE = 20;

type ChapterStatus = "pending" | "running" | "success" | "failed";

export function DramaSourceImport({ project, onImported, organizeModels = [], organizeModel = "", onOrganizeModelChange }: { project: DramaProject; onImported: () => void; organizeModels?: DramaOrganizeModelOption[]; organizeModel?: string; onOrganizeModelChange?: (model: string) => void }) {
    const { message } = App.useApp();
    const importEpisodes = useDramaStore((state) => state.importEpisodes);
    const createVersion = useDramaStore((state) => state.createVersion);
    const inputRef = useRef<HTMLInputElement>(null);
    const [drafts, setDrafts] = useState<DramaSourceEpisodeDraft[]>([]);
    const [fileName, setFileName] = useState("");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [importing, setImporting] = useState(false);
    const [mode, setMode] = useState<"direct" | "adapt">("direct");
    const [statuses, setStatuses] = useState<ChapterStatus[]>([]);
    const [adaptError, setAdaptError] = useState("");
    const [adaptPaused, setAdaptPaused] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const adaptedRef = useRef<DramaSourceEpisodeDraft[]>([]);
    const cursorRef = useRef(0);
    const summaryRef = useRef("");
    const open = drafts.length > 0;
    const adapting = statuses.some((status) => status === "running");
    const totalCharacters = useMemo(() => drafts.reduce((total, draft) => total + draft.script.length, 0), [drafts]);
    const filtered = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        if (!keyword) return drafts.map((draft, index) => ({ draft, index }));
        return drafts.flatMap((draft, index) => (`${draft.title} ${draft.sourceRange}`.toLocaleLowerCase().includes(keyword) ? [{ draft, index }] : []));
    }, [drafts, query]);
    const visible = filtered.slice((page - 1) * IMPORT_PAGE_SIZE, page * IMPORT_PAGE_SIZE);
    const successCount = statuses.filter((status) => status === "success").length;

    const close = () => {
        if (adapting) return;
        abortRef.current?.abort();
        abortRef.current = null;
        setDrafts([]);
        setFileName("");
        setQuery("");
        setPage(1);
        setMode("direct");
        setStatuses([]);
        setAdaptError("");
        setAdaptPaused(false);
        adaptedRef.current = [];
        cursorRef.current = 0;
        summaryRef.current = "";
    };

    const readSource = async (file?: File) => {
        if (!file) return;
        try {
            const nextDrafts = splitDramaSource(await readDramaSourceFile(file));
            if (!nextDrafts.length) return message.warning("导入文件没有可识别的文本内容");
            setDrafts(nextDrafts);
            setFileName(file.name);
            setQuery("");
            setPage(1);
            setStatuses([]);
            setAdaptError("");
            setAdaptPaused(false);
            adaptedRef.current = [];
            cursorRef.current = 0;
            summaryRef.current = "";
        } catch (error) {
            message.error(error instanceof Error ? error.message : "整本导入失败");
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    const confirmImport = async () => {
        setImporting(true);
        try {
            await createVersion(project, "整本导入前");
            importEpisodes(project.id, drafts);
            close();
            onImported();
            message.success(`已导入 ${drafts.length} 集，请逐集检查并提取内容结构`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "整本导入失败");
        } finally {
            setImporting(false);
        }
    };

    const finishAdaptedImport = async () => {
        setImporting(true);
        try {
            await createVersion(project, "整本导入前");
            importEpisodes(project.id, adaptedRef.current);
            close();
            onImported();
            message.success(`已导入 ${adaptedRef.current.length} 集 AI 改编剧本，请逐集检查`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入改编剧本失败");
        } finally {
            setImporting(false);
        }
    };

    const adaptChapter = async (index: number, controller: AbortController) => {
        const draft = drafts[index];
        setStatuses((prev) => prev.map((status, position) => (position === index ? "running" : status)));
        const response = await fetch("/api/drama/novel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                requestId: `novel-adapt:${project.id}:${index}:${nanoid()}`,
                textModel: organizeModel,
                chapterTitle: draft.sourceRange || draft.title,
                chapterText: draft.script,
                previousSummary: summaryRef.current,
                style: project.style,
            }),
        });
        const payload = (await response.json().catch(() => ({}))) as { code?: number; data?: { script?: string; summary?: string }; msg?: string };
        if (!response.ok || payload.code !== 0 || !payload.data?.script) throw new Error(payload.msg || "章节改编失败");
        summaryRef.current = payload.data.summary || summaryRef.current;
        adaptedRef.current[index] = { ...draft, script: payload.data.script };
        setStatuses((prev) => prev.map((status, position) => (position === index ? "success" : status)));
    };

    const runAdaptation = async (resume = false) => {
        if (!organizeModel.trim()) return message.warning("请先选择改编使用的文本模型");
        if (!resume) {
            setStatuses(drafts.map(() => "pending"));
            setAdaptError("");
            setAdaptPaused(false);
            adaptedRef.current = [];
            cursorRef.current = 0;
            summaryRef.current = "";
        }
        const controller = new AbortController();
        abortRef.current = controller;
        for (let index = cursorRef.current; index < drafts.length; index += 1) {
            cursorRef.current = index;
            try {
                await adaptChapter(index, controller);
            } catch (error) {
                abortRef.current = null;
                if (controller.signal.aborted) return;
                const reason = error instanceof Error ? error.message : "章节改编失败";
                setStatuses((prev) => prev.map((status, position) => (position === index ? "failed" : status)));
                setAdaptError(`第 ${index + 1} 集改编失败：${reason}`);
                setAdaptPaused(true);
                return;
            }
        }
        abortRef.current = null;
        setAdaptPaused(false);
        setAdaptError("");
        await finishAdaptedImport();
    };

    const retryFailed = () => void runAdaptation(true);

    const skipFailed = async () => {
        const index = cursorRef.current;
        if (index < drafts.length) {
            adaptedRef.current[index] = drafts[index];
            setStatuses((prev) => prev.map((status, position) => (position === index ? "success" : position > index && status === "pending" ? "pending" : status)));
            cursorRef.current = index + 1;
        }
        setAdaptPaused(false);
        setAdaptError("");
        await runAdaptation(true);
    };

    const cancelAdaptation = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setAdaptPaused(false);
        setStatuses((prev) => prev.map((status) => (status === "running" ? "pending" : status)));
    };

    const adaptModeReady = mode === "adapt" && organizeModel.trim() && !adaptPaused;

    return (
        <>
            <Button className="!h-8 !px-2.5" size="small" icon={<BookOpenText className="size-3.5" />} onClick={() => inputRef.current?.click()}>
                导入剧本/小说
            </Button>
            <input ref={inputRef} type="file" accept=".txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={(event) => void readSource(event.target.files?.[0])} />
            <Modal
                title="导入整本剧本 / 小说"
                open={open}
                width={720}
                centered
                destroyOnHidden
                mask={{ closable: !importing && !adapting }}
                closable={!importing && !adapting}
                okText={mode === "adapt" ? (adaptPaused ? "重试失败章节" : `开始改编并导入 ${drafts.length} 集`) : `确认导入 ${drafts.length} 集`}
                cancelText={mode === "adapt" && adapting ? "停止改编" : "取消"}
                okButtonProps={{ loading: importing, disabled: adapting || (mode === "adapt" && !organizeModel.trim()) }}
                cancelButtonProps={{ disabled: importing }}
                onOk={() => {
                    if (mode === "direct") return void confirmImport();
                    if (adaptPaused) return retryFailed();
                    return void runAdaptation();
                }}
                onCancel={() => {
                    if (adapting) return cancelAdaptation();
                    close();
                }}
                styles={{ container: { maxWidth: "calc(100vw - 24px)" }, body: { padding: 0 } }}
            >
                <div className="flex max-h-[min(68vh,640px)] min-h-0 flex-col overflow-hidden">
                    <div className="shrink-0 border-b border-border px-5 py-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                            <span className="flex min-w-0 items-center gap-1.5" title={fileName}>
                                <FileText className="size-3.5 shrink-0" />
                                <span className="max-w-60 truncate text-foreground">{fileName}</span>
                            </span>
                            <span>{drafts.length.toLocaleString("zh-CN")} 集</span>
                            <span>{totalCharacters.toLocaleString("zh-CN")} 字</span>
                            <span>将替换当前 {project.episodes.length} 集，并自动创建恢复版本</span>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Segmented
                                size="small"
                                value={mode}
                                onChange={(value) => setMode(value as "direct" | "adapt")}
                                options={[
                                    { value: "direct", label: "直接导入" },
                                    { value: "adapt", label: "AI 改编为剧本", icon: <Sparkles className="size-3" /> },
                                ]}
                            />
                            {mode === "adapt" ? (
                                <Select
                                    size="small"
                                    className="!w-[168px]"
                                    placeholder="选择改编模型"
                                    value={organizeModel || undefined}
                                    onChange={(value) => onOrganizeModelChange?.(value)}
                                    disabled={adapting}
                                    showSearch
                                    optionFilterProp="label"
                                    options={organizeModels.map((item) => ({ value: item.id, label: item.name }))}
                                    notFoundContent={!organizeModels.length ? "暂无可用文本模型" : undefined}
                                />
                            ) : null}
                            {mode === "adapt" && statuses.length ? (
                                <span className="text-xs text-muted-foreground">
                                    已改编 {successCount} / {drafts.length} 集
                                </span>
                            ) : null}
                        </div>
                        {adaptError ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#ef4444]">{adaptError}{adaptPaused ? <Button size="small" className="!h-6 !px-2 !text-xs" onClick={() => void skipFailed()}>跳过本章继续</Button> : null}</div> : null}
                        <Input
                            className="!mt-3 !h-8"
                            allowClear
                            prefix={<Search className="size-3.5 text-muted-foreground" />}
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setPage(1);
                            }}
                            placeholder="搜索分集标题或来源范围"
                            aria-label="搜索待导入分集"
                        />
                    </div>
                    <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2" data-drama-import-preview>
                        {visible.length ? (
                            <div className="divide-y divide-border">
                                {visible.map(({ draft, index }) => (
                                    <div key={`${index}-${draft.title}`} className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto_auto] items-center gap-2 px-2 py-2.5">
                                        <span className="text-xs font-medium tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-medium">{draft.title || `第 ${index + 1} 集`}</span>
                                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{draft.sourceRange || "按正文长度自动划分"}</span>
                                        </span>
                                        <span className="text-xs tabular-nums text-muted-foreground">
                                            {mode === "adapt" && adaptedRef.current[index] ? `${adaptedRef.current[index].script.length.toLocaleString("zh-CN")} 字` : `${draft.script.length.toLocaleString("zh-CN")} 字`}
                                        </span>
                                        {mode === "adapt" && statuses[index] ? (
                                            <span className="flex items-center" aria-label={statuses[index] === "success" ? "改编完成" : statuses[index] === "running" ? "改编中" : statuses[index] === "failed" ? "改编失败" : "待改编"}>
                                                {statuses[index] === "success" ? <CheckCircle2 className="size-4 text-emerald-500" /> : statuses[index] === "running" ? <Loader2 className="size-4 animate-spin text-violet-500" /> : statuses[index] === "failed" ? <XCircle className="size-4 text-[#ef4444]" /> : <CircleDashed className="size-4 text-muted-foreground/50" />}
                                            </span>
                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="grid min-h-40 place-items-center text-sm text-muted-foreground">没有匹配的分集</div>
                        )}
                    </div>
                    {filtered.length > IMPORT_PAGE_SIZE ? (
                        <div className="flex shrink-0 justify-end border-t border-border px-4 py-2.5">
                            <Pagination size="small" current={page} pageSize={IMPORT_PAGE_SIZE} total={filtered.length} showSizeChanger={false} showLessItems onChange={setPage} />
                        </div>
                    ) : null}
                </div>
            </Modal>
        </>
    );
}
