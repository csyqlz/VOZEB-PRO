"use client";

import { useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Pagination } from "antd";
import { BookOpenText, FileText, Search } from "lucide-react";

import { DRAMA_PROJECT_MAX_BYTES } from "@/lib/drama-project-contract";
import { splitDramaSource, type DramaSourceEpisodeDraft } from "@/lib/drama-source-splitter";
import { readDramaSourceFile } from "@/lib/drama-source-reader";
import type { DramaProject } from "../types";
import { projectWithImportedEpisodes, useDramaStore } from "../stores/use-drama-store";

const IMPORT_PAGE_SIZE = 20;
const MAX_PROJECT_LABEL = `${DRAMA_PROJECT_MAX_BYTES / 1024 / 1024} MB`;

export function DramaSourceImport({ project, onImported }: { project: DramaProject; onImported: () => void }) {
    const { message } = App.useApp();
    const importEpisodes = useDramaStore((state) => state.importEpisodes);
    const createVersion = useDramaStore((state) => state.createVersion);
    const inputRef = useRef<HTMLInputElement>(null);
    const [drafts, setDrafts] = useState<DramaSourceEpisodeDraft[]>([]);
    const [fileName, setFileName] = useState("");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [importing, setImporting] = useState(false);
    const open = drafts.length > 0;
    const totalCharacters = useMemo(() => drafts.reduce((total, draft) => total + draft.script.length, 0), [drafts]);
    const filtered = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        if (!keyword) return drafts.map((draft, index) => ({ draft, index }));
        return drafts.flatMap((draft, index) => (`${draft.title} ${draft.sourceRange}`.toLocaleLowerCase().includes(keyword) ? [{ draft, index }] : []));
    }, [drafts, query]);
    const visible = filtered.slice((page - 1) * IMPORT_PAGE_SIZE, page * IMPORT_PAGE_SIZE);

    const close = () => {
        setDrafts([]);
        setFileName("");
        setQuery("");
        setPage(1);
    };

    const readSource = async (file?: File) => {
        if (!file) return;
        try {
            if (file.size > DRAMA_PROJECT_MAX_BYTES) throw new Error(`剧本文件超过 ${MAX_PROJECT_LABEL}，请拆分后重新上传`);
            const nextDrafts = splitDramaSource(await readDramaSourceFile(file));
            if (!nextDrafts.length) return message.warning("导入文件没有可识别的文本内容");
            const preview = projectWithImportedEpisodes(project, nextDrafts, () => `episode-${"x".repeat(21)}`);
            if (new TextEncoder().encode(JSON.stringify(preview)).byteLength > DRAMA_PROJECT_MAX_BYTES) throw new Error(`导入后的短剧项目超过 ${MAX_PROJECT_LABEL}，请拆分剧本后重新上传`);
            setDrafts(nextDrafts);
            setFileName(file.name);
            setQuery("");
            setPage(1);
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
            await importEpisodes(project.id, drafts);
            close();
            onImported();
            message.success(`已导入 ${drafts.length} 集，请逐集检查并提取内容结构`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "整本导入失败");
        } finally {
            setImporting(false);
        }
    };

    return (
        <>
            <Button className="!h-8 !px-2.5" size="small" icon={<BookOpenText className="size-3.5" />} onClick={() => inputRef.current?.click()}>
                导入剧本
            </Button>
            <input ref={inputRef} type="file" accept=".txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={(event) => void readSource(event.target.files?.[0])} />
            <Modal
                title="导入整本剧本"
                open={open}
                width={720}
                centered
                destroyOnHidden
                mask={{ closable: !importing }}
                closable={!importing}
                okText={`确认导入 ${drafts.length} 集`}
                cancelText="取消"
                okButtonProps={{ loading: importing }}
                cancelButtonProps={{ disabled: importing }}
                onOk={() => void confirmImport()}
                onCancel={close}
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
                            <span>按章节生成分集；无章节标题时按正文长度分段，将替换当前 {project.episodes.length} 集，并自动创建恢复版本</span>
                        </div>
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
                                    <div key={`${index}-${draft.title}`} className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-2 px-2 py-2.5">
                                        <span className="text-xs font-medium tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-medium">{draft.title || `第 ${index + 1} 集`}</span>
                                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{draft.sourceRange || "按正文长度自动划分"}</span>
                                        </span>
                                        <span className="text-xs tabular-nums text-muted-foreground">{draft.script.length.toLocaleString("zh-CN")} 字</span>
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
