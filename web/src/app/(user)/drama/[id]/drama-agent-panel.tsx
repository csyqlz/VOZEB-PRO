"use client";

import { App, Button, Drawer, Dropdown, Input, Modal, Popover, Segmented, Select, Tooltip } from "antd";
import { ArrowUp, ChevronDown, History, ImagePlus, Link2, ListChecks, LoaderCircle, MessageSquarePlus, Pause, Play, RotateCcw, Square, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SiteLogo } from "@/components/layout/site-logo";
import { MediaRetentionNotice } from "@/components/media/media-retention-notice";

import type { AgentMediaDownload } from "@/components/agent/agent-media-download";
import { CreativeAgentControls, CreativeAgentSkillCard, type CreativeAgentModelOption } from "@/components/agent/creative-agent-controls";
import { AgentMessageActions } from "@/components/agent/agent-message-actions";
import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { formatAgentMessageText, friendlyAgentError } from "@/components/agent/agent-message-format";
import { AgentMediaPreview } from "@/components/agent/agent-media-preview";
import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import type { CreativeAsset, CreativeConversation, CreativeMessage } from "@/lib/creative-runtime-contract";
import { CREATIVE_UPLOAD_MAX_BYTES, isCreativeUploadMimeType } from "@/lib/creative-upload";
import type { DramaAssetReference, DramaEpisode, DramaNamedAsset, DramaProject } from "@/lib/drama-project-contract";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { useCreativeAgentOptions } from "@/hooks/use-creative-agent-options";
import {
    controlCreativeAgentRun,
    createCreativeAgentRun,
    createCreativeConversation,
    getCreativeAgentRun,
    listCreativeAgentRuns,
    listCreativeAssets,
    listCreativeConversationPage,
    listCreativeMessages,
    retryCreativeAgentTasks,
    updateCreativeConversation,
    uploadCreativeAsset,
    watchCreativeAgentRun,
    type CreativeAgentRun,
} from "@/services/api/creative";
import { deleteDramaAgentConversation } from "@/services/api/drama-projects";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { useDramaStore } from "../stores/use-drama-store";
import { agentRequirementAcknowledgement } from "@/lib/agent-requirement-acknowledgement";
import type { DramaProjectStage } from "./drama-project-sections";
import { DramaAgentMentionPicker } from "./drama-agent-mention-picker";
import { DramaAgentHistory } from "./drama-agent-history";
import { collectDramaAgentMentionItems, dramaAgentMentionAtCursor, dramaAgentMentionCandidates, referencedDramaAgentItems, replaceDramaAgentMention, type DramaAgentMentionItem } from "./drama-agent-mention";

type PendingDramaSubmission = {
    clientRequestId: string;
    conversationId?: string;
    viewRevision: number;
    content: string;
    assetIds: string[];
    skillIds: string[];
    modelIds: string[];
    temporaryUserId: string;
    temporaryAssistantId: string;
    snapshot: ReturnType<typeof dramaSnapshot>;
};

export function DramaAgentPanel({
    project,
    episode,
    stage,
    open,
    onOpenChange,
    onConversationChange,
    selectedShotId,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    stage: DramaProjectStage;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConversationChange: (conversationId: string) => void;
    selectedShotId?: string;
}) {
    const [activated, setActivated] = useState(open);
    const [desktop, setDesktop] = useState(false);
    const [width, setWidth] = useState(404);
    const [resizing, setResizing] = useState(false);

    useEffect(() => {
        if (open) setActivated(true);
    }, [open]);

    useEffect(() => {
        const media = window.matchMedia("(min-width: 1180px)");
        const update = () => setDesktop(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    if (!activated) return null;

    const startResize = () => {
        const move = (event: MouseEvent) => setWidth(Math.min(640, Math.max(348, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", stop, { once: true });
    };

    const content = <DramaAgentContent project={project} episode={episode} stage={stage} selectedShotId={selectedShotId} onClose={() => onOpenChange(false)} onConversationChange={onConversationChange} />;

    if (!desktop)
        return (
            <Drawer
                placement="right"
                size={360}
                open={open}
                mask={false}
                closable={false}
                destroyOnHidden={false}
                onClose={() => onOpenChange(false)}
                rootClassName="drama-agent-drawer"
                styles={{ wrapper: { maxWidth: "calc(100vw - 8px)" }, body: { padding: 0 } }}
                aria-label="项目智能助手"
            >
                {content}
            </Drawer>
        );

    return (
        <div
            className={`flex h-full min-h-0 shrink-0 overflow-hidden bg-card ${resizing ? "" : "transition-opacity duration-300 ease-out"} ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
            style={{ width: open ? width : 0 }}
            data-drama-agent-panel-frame
            aria-hidden={!open}
        >
            <aside className={`relative h-full min-w-0 shrink-0 border-l border-border ${resizing ? "" : "transition-transform duration-300 ease-out"} ${open ? "translate-x-0" : "translate-x-8"}`} style={{ width: "100%" }} aria-label="项目智能助手 面板">
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整项目智能助手 面板宽度" />
                {content}
            </aside>
        </div>
    );
}

function DramaAgentContent({
    project,
    episode,
    stage,
    selectedShotId,
    onClose,
    onConversationChange,
    embedded = false,
}: {
    project: DramaProject;
    episode: DramaEpisode;
    stage: DramaProjectStage;
    selectedShotId?: string;
    onClose: () => void;
    onConversationChange: (conversationId: string) => void;
    embedded?: boolean;
}) {
    const { message, modal } = App.useApp();
    const replaceProject = useDramaStore((state) => state.replaceProject);
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { logoUrl: "/logo.svg" };
    const { skills, skillsLoading, models } = useCreativeAgentOptions("drama");
    const [messages, setMessages] = useState<CreativeMessage[]>([]);
    const [assets, setAssets] = useState<CreativeAsset[]>([]);
    const [prompt, setPrompt] = useState("");
    const [selectedSkillId, setSelectedSkillId] = useState<string>();
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [smartPlanning, setSmartPlanning] = useState(true);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [conversations, setConversations] = useState<CreativeConversation[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [runId, setRunId] = useState<string>();
    const [runStatus, setRunStatus] = useState<CreativeAgentRun["status"]>();
    const streamRef = useRef<(() => void) | null>(null);
    const assetRefreshRef = useRef<Promise<void> | null>(null);
    const queuedAssetConversationRef = useRef<string | undefined>(undefined);
    const submittingRef = useRef(false);
    const failedSubmissionsRef = useRef(new Map<string, PendingDramaSubmission>());
    const endRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const caretRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const activeConversationIdRef = useRef(project.creativeConversationId);
    const onConversationChangeRef = useRef(onConversationChange);
    const conversationLoadRef = useRef(0);
    const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
    const selectedModels = models.filter((model) => selectedModelIds.includes(model.id));
    const selectedAssets = assets.filter((asset) => selectedAssetIds.includes(asset.id));
    const mentionItems = useMemo(() => collectDramaAgentMentionItems(project, episode), [episode, project]);
    const mentionCandidates = useMemo(() => dramaAgentMentionCandidates(mentionItems, mentionQuery || ""), [mentionItems, mentionQuery]);
    const referencedProjectItems = useMemo(() => referencedDramaAgentItems(prompt, mentionItems), [mentionItems, prompt]);
    const stageGuide = DRAMA_AGENT_STAGE_GUIDES[stage];

    useEffect(() => {
        if (project.creativeConversationId) activeConversationIdRef.current = project.creativeConversationId;
    }, [project.creativeConversationId]);

    useEffect(() => {
        onConversationChangeRef.current = onConversationChange;
    }, [onConversationChange]);

    const refresh = useCallback(async (conversationId = activeConversationIdRef.current) => {
        if (!conversationId) return { messages: [] as CreativeMessage[], assets: [] as CreativeAsset[] };
        const [nextMessages, nextAssets] = await Promise.all([listCreativeMessages(conversationId), listCreativeAssets(conversationId)]);
        if (activeConversationIdRef.current === conversationId) {
            setMessages(nextMessages);
            setAssets(nextAssets);
        }
        return { messages: nextMessages, assets: nextAssets };
    }, []);

    const refreshHistory = useCallback(
        async (offset = 0) => {
            const page = await listCreativeConversationPage({ surface: "drama", source: "drama", projectId: project.id, offset, limit: 20 });
            setConversations((current) => (offset ? Array.from(new Map([...current, ...page.conversations].map((item) => [item.id, item])).values()) : page.conversations));
            setHistoryHasMore(page.hasMore);
        },
        [project.id],
    );

    const refreshAssets = useCallback((conversationId: string) => {
        if (assetRefreshRef.current) {
            queuedAssetConversationRef.current = conversationId;
            return assetRefreshRef.current;
        }
        const load = async () => {
            let nextConversationId: string | undefined = conversationId;
            do {
                const currentConversationId = nextConversationId;
                queuedAssetConversationRef.current = undefined;
                const nextAssets = await listCreativeAssets(currentConversationId);
                if (activeConversationIdRef.current === currentConversationId) setAssets(nextAssets);
                nextConversationId = queuedAssetConversationRef.current;
            } while (nextConversationId);
        };
        const request = load().finally(() => {
            if (assetRefreshRef.current === request) assetRefreshRef.current = null;
        });
        assetRefreshRef.current = request;
        return request;
    }, []);

    const updateAssistant = useCallback((id: string, content?: string, status: CreativeMessage["status"] = "running") => {
        setMessages((current) => current.map((item) => (item.id === id ? { ...item, ...(content ? { content } : {}), status, updatedAt: Date.now() } : item)));
    }, []);

    useEffect(() => {
        endRef.current?.scrollIntoView({ block: "end" });
    }, [assets.length, messages.at(-1)?.id]);

    const assetsByRun = useMemo(() => {
        const map = new Map<string, CreativeAsset[]>();
        for (const asset of assets) {
            const key = asset.messageId || asset.sourceRunId;
            if (key) map.set(key, [...(map.get(key) || []), asset]);
        }
        return map;
    }, [assets]);
    const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

    const ensureConversation = async () => {
        if (activeConversationIdRef.current) return activeConversationIdRef.current;
        const conversation = await createCreativeConversation({ surface: "drama", source: "drama", projectId: project.id, title: "新对话" });
        activeConversationIdRef.current = conversation.id;
        onConversationChange(conversation.id);
        return conversation.id;
    };

    const uploadImages = async (files: File[]) => {
        const unsupported = files.find((file) => !isCreativeUploadMimeType(file.type) || !file.type.startsWith("image/"));
        if (unsupported) return message.error(`${unsupported.name} 不是支持的图片格式`);
        const oversized = files.find((file) => file.size > CREATIVE_UPLOAD_MAX_BYTES);
        if (oversized) return message.error(`${oversized.name} 超过 20MB`);
        if (!files.length || uploading || loading) return;
        setUploading(true);
        try {
            const conversationId = await ensureConversation();
            const uploaded: CreativeAsset[] = [];
            for (const file of files) uploaded.push(await uploadCreativeAsset(conversationId, file));
            setAssets((current) => [...current, ...uploaded.filter((asset) => !current.some((item) => item.id === asset.id))]);
            setSelectedAssetIds((current) => Array.from(new Set([...current, ...uploaded.map((asset) => asset.id)])));
            message.success(`已上传 ${uploaded.length} 张参考图`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "参考图上传失败");
        } finally {
            setUploading(false);
        }
    };

    const watchRun = useCallback(
        (run: CreativeAgentRun, assistantMessageId: string) => {
            const viewRevision = conversationLoadRef.current;
            const isCurrentRun = () => viewRevision === conversationLoadRef.current && activeConversationIdRef.current === run.conversationId;
            activeConversationIdRef.current = run.conversationId;
            streamRef.current?.();
            setRunId(run.id);
            setRunStatus(run.status);
            setSending(true);
            submittingRef.current = true;
            streamRef.current = watchCreativeAgentRun(run.id, {
                onProgress: (text) => {
                    if (!isCurrentRun()) return;
                    updateAssistant(assistantMessageId, text);
                },
                onTaskCompleted: () => void refreshAssets(run.conversationId).catch(() => undefined),
                onStatus: (status) => {
                    if (isCurrentRun()) setRunStatus(status);
                },
                onProjectHandoff: () => undefined,
                onConnectionError: (text) => {
                    if (!isCurrentRun()) return;
                    updateAssistant(assistantMessageId, text);
                    streamRef.current = null;
                },
                onTerminal: (status, text) => {
                    if (!isCurrentRun()) return;
                    updateAssistant(assistantMessageId, text, status === "completed" ? "completed" : status);
                    setSending(false);
                    submittingRef.current = false;
                    setRunId(undefined);
                    setRunStatus(status);
                    streamRef.current = null;
                    void refresh(run.conversationId);
                },
            });
            return assistantMessageId;
        },
        [refresh, refreshAssets, updateAssistant],
    );

    const openConversation = useCallback(
        async (conversationId: string, updateProject = true) => {
            const requestId = ++conversationLoadRef.current;
            streamRef.current?.();
            streamRef.current = null;
            submittingRef.current = false;
            setSending(false);
            setRunId(undefined);
            setRunStatus(undefined);
            setLoading(true);
            setMessages([]);
            setAssets([]);
            setSelectedAssetIds([]);
            activeConversationIdRef.current = conversationId;
            if (updateProject) onConversationChangeRef.current(conversationId);
            try {
                const [loaded, runs] = await Promise.all([refresh(conversationId), listCreativeAgentRuns("drama", { activeOnly: true, projectId: project.id, conversationId })]);
                if (requestId !== conversationLoadRef.current || activeConversationIdRef.current !== conversationId) return;
                const activeRun = runs.find((run) => run.conversationId === conversationId && ["planning", "running", "paused"].includes(run.status));
                if (activeRun) {
                    const assistant = loaded.messages.find((item) => item.id === activeRun.assistantMessageId) || [...loaded.messages].reverse().find((item) => item.role === "assistant" && item.status === "running");
                    watchRun(activeRun, assistant?.id || activeRun.assistantMessageId);
                }
                setHistoryOpen(false);
                window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end" }));
            } finally {
                if (requestId === conversationLoadRef.current) setLoading(false);
            }
        },
        [project.id, refresh, watchRun],
    );

    const newConversation = useCallback(async () => {
        const requestId = ++conversationLoadRef.current;
        const previousConversationId = activeConversationIdRef.current;
        activeConversationIdRef.current = undefined;
        streamRef.current?.();
        streamRef.current = null;
        submittingRef.current = false;
        setHistoryOpen(false);
        setLoading(true);
        setMessages([]);
        setAssets([]);
        setSending(false);
        setRunId(undefined);
        setRunStatus(undefined);
        let conversation: CreativeConversation;
        try {
            conversation = await createCreativeConversation({ surface: "drama", source: "drama", projectId: project.id, title: "新对话" });
        } catch (error) {
            if (requestId !== conversationLoadRef.current) return;
            message.error(error instanceof Error ? error.message : "新建项目智能助手 对话失败");
            if (previousConversationId) await openConversation(previousConversationId, false);
            else setLoading(false);
            return;
        }
        if (requestId !== conversationLoadRef.current) return;
        setPrompt("");
        setMentionQuery(null);
        setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
        await openConversation(conversation.id);
        window.requestAnimationFrame(() => inputRef.current?.focus());
    }, [message, openConversation, project.id]);

    const renameConversation = useCallback(
        async (conversationId: string, title: string) => {
            try {
                const updated = await updateCreativeConversation(conversationId, { title });
                setConversations((current) => current.map((item) => (item.id === conversationId ? updated : item)));
                message.success("对话标题已修改");
            } catch (error) {
                message.error(error instanceof Error ? error.message : "对话标题修改失败");
            }
        },
        [message],
    );

    const confirmDeleteConversation = useCallback(
        (conversation: CreativeConversation) => {
            modal.confirm({
                title: "删除这条对话？",
                content: `“${conversation.title || "新对话"}”的消息、任务和生成记录将永久删除。`,
                okText: "删除",
                okButtonProps: { danger: true },
                cancelText: "取消",
                centered: true,
                onOk: async () => {
                    try {
                        const result = await deleteDramaAgentConversation(project.id, conversation.id);
                        setConversations((current) => current.filter((item) => item.id !== conversation.id));
                        if (activeConversationIdRef.current === conversation.id) {
                            replaceProject(result.project);
                            await openConversation(result.activeConversationId, false);
                        }
                        message.success("对话已删除");
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "对话删除失败");
                        throw error;
                    }
                },
            });
        },
        [message, modal, openConversation, project.id, replaceProject],
    );

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const conversationId = activeConversationIdRef.current;
        const load = async () => {
            if (!conversationId) {
                setMessages([]);
                setAssets([]);
                setLoading(false);
                return;
            }
            await openConversation(conversationId, false);
            if (cancelled) return;
        };
        void load().catch((error) => {
            if (cancelled) return;
            setLoading(false);
            message.error(friendlyAgentError(error, "项目智能助手 任务恢复失败，请稍后重试。"));
        });
        return () => {
            cancelled = true;
            streamRef.current?.();
            streamRef.current = null;
        };
    }, [message, openConversation, project.id]);

    const setHistoryVisibility = (nextOpen: boolean) => {
        setHistoryOpen(nextOpen);
        if (!nextOpen) return;
        setHistoryLoading(true);
        void refreshHistory()
            .catch((error) => message.error(error instanceof Error ? error.message : "历史对话读取失败"))
            .finally(() => setHistoryLoading(false));
    };

    const loadMoreHistory = () => {
        if (historyLoadingMore || !historyHasMore) return;
        setHistoryLoadingMore(true);
        void refreshHistory(conversations.length)
            .catch((error) => message.error(error instanceof Error ? error.message : "历史对话读取失败"))
            .finally(() => setHistoryLoadingMore(false));
    };

    const executeSubmission = async (submission: PendingDramaSubmission) => {
        const isCurrentView = () => submission.viewRevision === conversationLoadRef.current && activeConversationIdRef.current === submission.conversationId;
        let result: Awaited<ReturnType<typeof createCreativeAgentRun>>;
        try {
            result = await createCreativeAgentRun({
                clientRequestId: submission.clientRequestId,
                surface: "drama",
                conversationId: submission.conversationId,
                projectId: project.id,
                prompt: submission.content,
                assetIds: submission.assetIds,
                skillIds: submission.skillIds,
                modelIds: submission.modelIds,
                snapshot: submission.snapshot,
            });
        } catch (error) {
            if (!isCurrentView()) return false;
            failedSubmissionsRef.current.set(submission.temporaryAssistantId, submission);
            const content = friendlyAgentError(error, "项目智能助手 请求失败，请稍后重试。");
            setMessages((current) => current.map((item) => (item.id === submission.temporaryAssistantId ? { ...item, content, status: "failed", updatedAt: Date.now() } : item)));
            setSending(false);
            submittingRef.current = false;
            setRunId(undefined);
            setRunStatus(undefined);
            return false;
        }
        failedSubmissionsRef.current.delete(submission.temporaryAssistantId);
        if (!isCurrentView()) return true;
        activeConversationIdRef.current = result.run.conversationId;
        if (result.run.conversationId !== project.creativeConversationId) onConversationChangeRef.current(result.run.conversationId);
        setRunId(result.run.id);
        setRunStatus(result.run.status);
        setMessages((current) =>
            current.map((item) => {
                if (item.id === submission.temporaryUserId) return { ...item, id: result.run.inputMessageId, conversationId: result.run.conversationId, runId: result.run.id };
                if (item.id === submission.temporaryAssistantId) return { ...item, id: result.run.assistantMessageId, conversationId: result.run.conversationId, runId: result.run.id };
                return item;
            }),
        );
        watchRun(result.run, result.run.assistantMessageId);
        return true;
    };

    const submit = async () => {
        const content = prompt.trim();
        if (!content || sending || submittingRef.current || uploading || loading) return;
        submittingRef.current = true;
        setPrompt("");
        setSending(true);
        const now = Date.now();
        const sequence = messages.reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
        const temporaryUserId = `message-${nanoid()}`;
        const temporaryAssistantId = `message-${nanoid()}`;
        const assetIds = [...selectedAssetIds];
        const submission: PendingDramaSubmission = {
            clientRequestId: `drama-agent-${nanoid()}`,
            conversationId: activeConversationIdRef.current,
            viewRevision: conversationLoadRef.current,
            content,
            assetIds,
            skillIds: selectedSkillId ? [selectedSkillId] : [],
            modelIds: smartPlanning ? [] : selectedModelIds,
            temporaryUserId,
            temporaryAssistantId,
            snapshot: dramaSnapshot(project, episode, stage, selectedShotId, referencedProjectItems),
        };
        setMessages((current) => [
            ...current,
            { id: temporaryUserId, conversationId: submission.conversationId || "pending", sequence, role: "user", status: "completed", content, metadata: { assetIds }, createdAt: now, updatedAt: now },
            {
                id: temporaryAssistantId,
                conversationId: submission.conversationId || "pending",
                sequence: sequence + 1,
                role: "assistant",
                status: "running",
                content: agentRequirementAcknowledgement(content, "drama", assetIds.length > 0),
                metadata: {},
                createdAt: now,
                updatedAt: now,
            },
        ]);
        setSelectedSkillId(undefined);
        setSelectedAssetIds((current) => current.filter((id) => !assetIds.includes(id)));
        return executeSubmission(submission);
    };

    const retrySubmission = async (assistantMessageId: string) => {
        const submission = failedSubmissionsRef.current.get(assistantMessageId);
        const failedMessage = messages.find((item) => item.id === assistantMessageId);
        if ((!submission && !failedMessage?.runId) || sending || submittingRef.current) return false;
        submittingRef.current = true;
        setSending(true);
        setMessages((current) => current.map((item) => (item.id === assistantMessageId ? { ...item, content: "正在重新提交创作请求", status: "running", updatedAt: Date.now() } : item)));
        if (failedMessage?.runId) {
            try {
                const run = await getCreativeAgentRun(failedMessage.runId);
                const failedTaskIds = run.tasks.filter((task) => task.status === "failed").map((task) => task.id);
                const result = failedTaskIds.length
                    ? { run: await retryCreativeAgentTasks(failedMessage.runId, failedTaskIds, failedMessage.conversationId || activeConversationIdRef.current) }
                    : await controlCreativeAgentRun(failedMessage.runId, "retry", failedMessage.conversationId || activeConversationIdRef.current);
                await refresh(result.run.conversationId);
                watchRun(result.run, result.run.assistantMessageId || assistantMessageId);
                return true;
            } catch (error) {
                setMessages((current) => current.map((item) => (item.id === assistantMessageId ? { ...item, content: friendlyAgentError(error, "项目智能助手 重试失败，请稍后重试。"), status: "failed", updatedAt: Date.now() } : item)));
                setSending(false);
                submittingRef.current = false;
                setRunStatus("failed");
                return false;
            }
        }
        return executeSubmission(submission!);
    };

    const controlRun = async (action: "pause" | "resume" | "cancel") => {
        if (!runId) return;
        try {
            const result = await controlCreativeAgentRun(runId, action, activeConversationIdRef.current);
            setRunStatus(result.run.status);
            if (action === "cancel") {
                setSending(false);
                submittingRef.current = false;
                setRunId(undefined);
            }
        } catch (error) {
            message.error(friendlyAgentError(error, "项目智能助手 控制失败，请稍后重试。"));
        }
    };

    const toggleModel = (model: CreativeAgentModelOption) => {
        setSelectedModelIds((current) => {
            const next = current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id];
            setSmartPlanning(next.length === 0);
            return next;
        });
    };

    const enableSmartPlanning = () => {
        setSelectedModelIds([]);
        setSmartPlanning(true);
    };

    const fillStagePrompt = (prompt: string) => {
        setPrompt(prompt);
        setMentionQuery(null);
        window.requestAnimationFrame(() => inputRef.current?.focus());
    };

    const selectMention = (item: DramaAgentMentionItem) => {
        const result = replaceDramaAgentMention(prompt, caretRef.current, item.alias);
        setPrompt(result.value);
        setMentionQuery(null);
        window.requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(result.cursor, result.cursor);
        });
    };

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="flex h-12 shrink-0 items-center border-b border-border px-3.5">
                <div className="flex w-full min-w-0 items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 font-medium">
                        <SiteLogo logoUrl={site.logoUrl} className="size-5" />
                        <span className="truncate">{stageGuide.label}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                        <Tooltip title="新建对话">
                            <Button
                                type="text"
                                shape="circle"
                                className="!size-8 !min-w-8"
                                icon={<MessageSquarePlus className="size-4" />}
                                disabled={loading}
                                onClick={() => void newConversation().catch((error) => message.error(error instanceof Error ? error.message : "新建对话失败"))}
                                aria-label="新建项目智能助手 对话"
                            />
                        </Tooltip>
                        <Popover
                            trigger="click"
                            placement="bottomRight"
                            arrow={false}
                            open={historyOpen}
                            onOpenChange={setHistoryVisibility}
                            styles={{ container: { padding: 4, borderRadius: 10 } }}
                            content={
                                <DramaAgentHistory
                                    items={conversations}
                                    activeId={activeConversationIdRef.current}
                                    loading={historyLoading}
                                    hasMore={historyHasMore}
                                    loadingMore={historyLoadingMore}
                                    onOpen={(conversationId) => void openConversation(conversationId).catch((error) => message.error(error instanceof Error ? error.message : "对话恢复失败"))}
                                    onRename={(conversationId, title) => void renameConversation(conversationId, title)}
                                    onDelete={confirmDeleteConversation}
                                    onLoadMore={loadMoreHistory}
                                />
                            }
                        >
                            <Tooltip title="历史对话">
                                <Button
                                    type="text"
                                    shape="circle"
                                    className={`!size-8 !min-w-8 ${historyOpen ? "!bg-primary/10 !text-primary" : ""}`}
                                    icon={<History className="size-4" />}
                                    aria-label="打开项目智能助手 历史对话"
                                    aria-expanded={historyOpen}
                                />
                            </Tooltip>
                        </Popover>
                        {!embedded ? (
                            <Tooltip title="收起项目智能助手">
                                <Button type="text" shape="circle" className="!size-8 !min-w-8" icon={<X className="size-4" />} onClick={onClose} aria-label="收起项目智能助手" />
                            </Tooltip>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className="hide-scrollbar min-h-0 min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-3.5 py-3" data-drama-agent-message-scroll>
                {loading ? (
                    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" data-drama-agent-loading>
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                            正在恢复对话
                        </div>
                    </div>
                ) : null}
                {!loading && !messages.length ? (
                    <div data-drama-agent-empty data-drama-agent-quick-actions>
                        <Dropdown
                            trigger={["click"]}
                            placement="bottomLeft"
                            menu={{
                                items: stageGuide.prompts.map((item, index) => ({ key: String(index), label: item.label })),
                                onClick: ({ key }) => {
                                    const item = stageGuide.prompts[Number(key)];
                                    if (item) fillStagePrompt(item.prompt);
                                },
                            }}
                        >
                            <Button
                                block
                                className="!flex !h-8 !items-center !justify-start !gap-1.5 !px-2.5 !text-xs !text-muted-foreground hover:!border-foreground/20 hover:!text-foreground"
                                icon={<ListChecks className="size-3.5" aria-hidden />}
                                disabled={sending}
                                aria-label="打开本阶段智能助手建议"
                            >
                                <span className="min-w-0 flex-1 truncate text-left">本阶段建议</span>
                                <span className="text-[11px] tabular-nums opacity-65">{stageGuide.prompts.length} 项</span>
                                <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
                            </Button>
                        </Dropdown>
                    </div>
                ) : null}
                {messages.map((message) => {
                    const referencedAssets = message.role === "user" ? messageAssetIds(message).flatMap((id) => assetById.get(id) || []) : [];
                    const messageAssets = [...(assetsByRun.get(message.id) || []), ...(message.runId ? assetsByRun.get(message.runId) || [] : [])].filter((asset, index, list) => list.findIndex((item) => item.id === asset.id) === index);
                    const displayContent = message.status === "failed" ? friendlyAgentError(message.content) : formatAgentMessageText(message.content);
                    return (
                        <div key={message.id} className={`group/message min-w-0 ${message.role === "user" ? "pl-8 text-right" : "pr-2"}`}>
                            {referencedAssets.length ? <DramaMessageReferences assets={referencedAssets} /> : null}
                            <div className={`min-w-0 break-words text-sm leading-6 [overflow-wrap:anywhere] ${message.status === "failed" ? "text-red-500" : "text-foreground"}`}>
                                {message.status === "running" ? <LoaderCircle className="mr-1 inline size-3.5 animate-spin" /> : null}
                                {message.role === "assistant" && message.status === "completed" ? <AgentMarkdown>{displayContent}</AgentMarkdown> : <span className="whitespace-pre-wrap">{displayContent}</span>}
                            </div>
                            {messageAssets.length ? <DramaAgentAssets assets={messageAssets} project={project} episode={episode} /> : null}
                            {message.role === "assistant" && message.status === "failed" ? (
                                <Button
                                    type="text"
                                    size="small"
                                    className="!mt-1 !h-7 !px-1.5 !text-xs !text-red-600 hover:!bg-red-50 hover:!text-red-700 dark:!text-red-300 dark:hover:!bg-red-950/30 dark:hover:!text-red-200"
                                    icon={<RotateCcw className="size-3.5" />}
                                    onClick={() => void retrySubmission(message.id)}
                                    aria-label="重试本次项目智能助手 请求"
                                >
                                    重试
                                </Button>
                            ) : null}
                            {message.status !== "running" ? (
                                <AgentMessageActions
                                    text={displayContent}
                                    downloads={agentAssetDownloads(messageAssets)}
                                    onEdit={
                                        message.role === "user" && !sending
                                            ? (text) => {
                                                  setPrompt(text);
                                                  setSelectedAssetIds(messageAssetIds(message).filter((id) => assets.some((asset) => asset.id === id)));
                                                  window.requestAnimationFrame(() => inputRef.current?.focus());
                                              }
                                            : undefined
                                    }
                                    align={message.role === "user" ? "end" : "start"}
                                />
                            ) : null}
                        </div>
                    );
                })}
                <div ref={endRef} />
            </div>
            <div className="mx-3 mb-3 mt-2 min-w-0 shrink-0 rounded-2xl border border-border bg-background px-3.5 pb-3.5 pt-3.5 shadow-sm" data-drama-agent-composer onWheelCapture={(event) => event.stopPropagation()}>
                {selectedSkill ? <CreativeAgentSkillCard skill={selectedSkill} onRemove={() => setSelectedSkillId(undefined)} className="pb-1" /> : null}
                <div className="flex min-w-0 items-start gap-2" data-drama-agent-input-row>
                    {selectedAssets.length || !sending ? (
                        <div className="hide-scrollbar flex max-w-[44%] shrink-0 items-start gap-1 overflow-x-auto overflow-y-hidden px-0.5 py-1" aria-label="本轮参考素材" aria-live="polite">
                            {selectedAssets.map((asset) => {
                                const url = asset.serverUrl || asset.remoteUrl || "";
                                return (
                                    <div key={asset.id} className="group relative size-10 shrink-0 overflow-visible rounded-md border border-border bg-muted">
                                        <div className="size-full overflow-hidden rounded-[5px]">
                                            {url ? <AgentMediaPreview type="image" url={url} title={asset.title || "参考图"} className="size-full" /> : <ImagePlus className="m-auto size-4 text-muted-foreground" />}
                                        </div>
                                        <button
                                            type="button"
                                            className="absolute right-0 top-0 z-10 flex size-7 items-start justify-end rounded-full bg-transparent p-0.5 text-muted-foreground transition hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                            onClick={() => setSelectedAssetIds((current) => current.filter((id) => id !== asset.id))}
                                            aria-label={`移除参考图：${asset.title}`}
                                        >
                                            <span className="grid size-4 place-items-center rounded-full border border-border bg-background/95 shadow-sm">
                                                <X className="size-2" />
                                            </span>
                                        </button>
                                    </div>
                                );
                            })}
                            <Button
                                type="text"
                                className="!size-10 !min-w-10 !shrink-0 !rounded-lg !border !border-border !p-0"
                                icon={uploading ? <LoaderCircle className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
                                disabled={sending || loading}
                                loading={uploading}
                                onClick={() => fileInputRef.current?.click()}
                                aria-label={selectedAssets.length ? "继续添加参考图" : "添加参考图"}
                            />
                        </div>
                    ) : null}
                    <Popover
                        trigger={[]}
                        placement="topLeft"
                        autoAdjustOverflow={{ adjustX: 1, adjustY: 1 }}
                        arrow={false}
                        open={mentionQuery !== null}
                        onOpenChange={(nextOpen) => {
                            if (!nextOpen) setMentionQuery(null);
                        }}
                        styles={{ container: { padding: 0, borderRadius: 10, overflow: "hidden" } }}
                        content={<DramaAgentMentionPicker items={mentionCandidates} selectedIds={new Set(referencedProjectItems.map((item) => item.id))} onSelect={selectMention} />}
                    >
                        <textarea
                            ref={inputRef}
                            value={prompt}
                            rows={3}
                            placeholder="告诉智能助手下一步要做什么"
                            disabled={sending || loading}
                            className="hide-scrollbar min-h-20 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-0 focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
                            onChange={(event) => {
                                caretRef.current = event.target.selectionStart;
                                setPrompt(event.target.value);
                                setMentionQuery(dramaAgentMentionAtCursor(event.target.value, event.target.selectionStart)?.query ?? null);
                            }}
                            onClick={(event) => {
                                caretRef.current = event.currentTarget.selectionStart;
                                setMentionQuery(dramaAgentMentionAtCursor(event.currentTarget.value, event.currentTarget.selectionStart)?.query ?? null);
                            }}
                            onPaste={(event) => {
                                const files = clipboardImageFiles(event.clipboardData);
                                if (!files.length) return;
                                event.preventDefault();
                                void uploadImages(files);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Escape" && mentionQuery !== null) {
                                    event.preventDefault();
                                    setMentionQuery(null);
                                    return;
                                }
                                if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
                                event.preventDefault();
                                if (mentionQuery !== null && mentionCandidates.length) return selectMention(mentionCandidates[0]);
                                void submit();
                            }}
                        />
                    </Popover>
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-2.5 border-t border-border pt-2" data-drama-agent-toolbar>
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden py-0.5">
                        <input
                            ref={fileInputRef}
                            hidden
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            multiple
                            onChange={(event) => {
                                void uploadImages(Array.from(event.target.files || []));
                                event.target.value = "";
                            }}
                        />
                        <CreativeAgentControls
                            compact
                            skills={skills}
                            skillsLoading={skillsLoading}
                            selectedSkill={selectedSkill}
                            models={models}
                            selectedModels={selectedModels}
                            smartPlanning={smartPlanning}
                            onSelectSkill={(skill) => setSelectedSkillId(skill.id)}
                            onToggleModel={toggleModel}
                            onClearModels={enableSmartPlanning}
                            onSmartPlanningChange={(enabled) => (enabled ? enableSmartPlanning() : setSmartPlanning(false))}
                        />
                    </div>
                    {sending && runId ? (
                        <div className="flex items-center gap-1">
                            {runStatus === "paused" ? (
                                <Button type="text" shape="circle" icon={<Play className="size-3.5" />} onClick={() => void controlRun("resume")} aria-label="继续项目智能助手" />
                            ) : (
                                <Button type="text" shape="circle" icon={<Pause className="size-3.5" />} onClick={() => void controlRun("pause")} aria-label="暂停项目智能助手" />
                            )}
                            <Button danger shape="circle" icon={<Square className="size-3.5" />} onClick={() => void controlRun("cancel")} aria-label="停止项目智能助手" />
                        </div>
                    ) : (
                        <Button type="primary" shape="circle" className="!size-10 !min-w-10 !shrink-0" icon={<ArrowUp className="size-4" />} disabled={!prompt.trim() || uploading || loading} onClick={() => void submit()} aria-label="发送给项目智能助手" />
                    )}
                </div>
            </div>
        </div>
    );
}

function DramaMessageReferences({ assets }: { assets: CreativeAsset[] }) {
    let imageIndex = 0;
    return (
        <div className="mb-1.5 flex max-w-full flex-wrap justify-end gap-1.5" aria-label="本轮参考素材">
            {assets.flatMap((asset) => {
                const url = asset.serverUrl || asset.remoteUrl || "";
                if (asset.type !== "image" || !url) return [];
                return (
                    <div key={asset.id} className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted" title={asset.title || "参考图"}>
                        <AgentMediaPreview type="image" url={url} title={asset.title || "参考图"} className="size-full" />
                        <span className="absolute left-1 top-1 rounded bg-black/65 px-1 py-0.5 text-[9px] font-medium leading-none text-white">{imageReferenceLabel(imageIndex++)}</span>
                    </div>
                );
            })}
        </div>
    );
}

function messageAssetIds(message: CreativeMessage) {
    const value = message.metadata.assetIds;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function DramaAgentAssets({ assets, project, episode }: { assets: CreativeAsset[]; project: DramaProject; episode: DramaEpisode }) {
    const { message } = App.useApp();
    const updateShot = useDramaStore((state) => state.updateShot);
    const updateAsset = useDramaStore((state) => state.updateAsset);
    const addCharacter = useDramaStore((state) => state.addCharacter);
    const addScene = useDramaStore((state) => state.addScene);
    const addProp = useDramaStore((state) => state.addProp);
    const addClue = useDramaStore((state) => state.addClue);
    const [referenceAsset, setReferenceAsset] = useState<CreativeAsset>();
    const [visualAsset, setVisualAsset] = useState<CreativeAsset>();
    const [shotId, setShotId] = useState(episode.shots[0]?.id || "");
    const [frameKind, setFrameKind] = useState<"start" | "end">("start");
    const [visualKind, setVisualKind] = useState<VisualAssetKind>("characters");
    const [visualAssetId, setVisualAssetId] = useState("");
    const [newVisualAssetName, setNewVisualAssetName] = useState("");
    const applyReference = () => {
        const shot = episode.shots.find((item) => item.id === shotId);
        const url = referenceAsset?.serverUrl || referenceAsset?.remoteUrl || "";
        if (!shot || !url) return;
        updateShot(project.id, episode.id, shot.id, {
            ...(frameKind === "start"
                ? { storyboardStatus: "success" as const, storyboardTaskId: undefined, storyboardError: undefined, storyboardImageUrl: url, storyboardImageWidth: referenceAsset?.width, storyboardImageHeight: referenceAsset?.height }
                : {
                      storyboardFrameMode: "first_last" as const,
                      storyboardEndStatus: "success" as const,
                      storyboardEndTaskId: undefined,
                      storyboardEndError: undefined,
                      storyboardEndImageUrl: url,
                      storyboardEndImageWidth: referenceAsset?.width,
                      storyboardEndImageHeight: referenceAsset?.height,
                  }),
            generationStatus: "idle",
            generationTaskId: undefined,
            generationError: undefined,
            videoUrl: undefined,
            audioStatus: "idle",
            audioTaskId: undefined,
            audioError: undefined,
            audioUrl: undefined,
        });
        setReferenceAsset(undefined);
        message.success(`已引用为${shot.title}的${frameKind === "start" ? "起始帧" : "结束帧"}`);
    };

    const applyVisualAsset = () => {
        const sourceAsset = visualAsset;
        const url = sourceAsset?.serverUrl || sourceAsset?.remoteUrl || "";
        if (!sourceAsset || !url) return;
        const reference: DramaAssetReference = {
            id: `reference-${nanoid()}`,
            url,
            storageKey: sourceAsset.storageKey,
            source: "generated",
            label: sourceAsset.title || "智能助手生成图",
            width: sourceAsset.width,
            height: sourceAsset.height,
            createdAt: new Date().toISOString(),
        };
        const selected = project[visualKind].find((item) => item.id === visualAssetId);
        const name = newVisualAssetName.trim() || sourceAsset.title.trim() || `${visualKind === "characters" ? "角色" : visualKind === "scenes" ? "场景" : visualKind === "props" ? "道具" : "线索"}参考`;
        if (selected) {
            const references = [...(selected.references || []), reference];
            updateAsset(project.id, visualKind, selected.id, { references, primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已加入${selected.name}的视觉参考图`);
        } else if (visualKind === "characters") {
            addCharacter(project.id, {
                name,
                description: "来自项目智能助手 的视觉参考",
                profile: emptyAssetProfile(),
                references: [reference],
                primaryReferenceId: reference.id,
                referenceImageUrl: reference.url,
                referenceStorageKey: reference.storageKey,
            });
            message.success(`已创建角色“${name}”并加入参考图`);
        } else if (visualKind === "scenes") {
            addScene(project.id, { name, description: "来自项目智能助手 的视觉参考", profile: emptyAssetProfile(), references: [reference], primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已创建场景“${name}”并加入参考图`);
        } else if (visualKind === "props") {
            addProp(project.id, { name, description: "来自项目智能助手 的视觉参考", profile: emptyAssetProfile(), references: [reference], primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已创建道具“${name}”并加入参考图`);
        } else {
            addClue(project.id, {
                name,
                description: "来自项目智能助手 的视觉参考",
                payoff: "",
                profile: emptyAssetProfile(),
                references: [reference],
                primaryReferenceId: reference.id,
                referenceImageUrl: reference.url,
                referenceStorageKey: reference.storageKey,
            });
            message.success(`已创建线索“${name}”并加入参考图`);
        }
        setVisualAsset(undefined);
        setVisualAssetId("");
        setNewVisualAssetName("");
    };

    return (
        <>
            <div className="mt-3 grid gap-2">
            {assets
                    .filter((asset) => asset.type !== "text")
                    .map((asset) => {
                        const url = asset.serverUrl || asset.remoteUrl || "";
                        if (!url) return null;
                        return (
                            <div key={asset.id} className="min-w-0">
                                <AgentMediaPreview type={asset.type} url={url} title={asset.title || "智能助手生成媒体"} className={asset.type === "image" ? "max-h-64 rounded-md" : asset.type === "video" ? "aspect-video rounded-md" : undefined} />
                                {asset.type === "image" ? (
                                    <div className="mt-2 flex min-w-0 items-center rounded-lg border border-border/70 bg-muted/30 p-1">
                                        <Button
                                            type="text"
                                            className="!h-7 !min-w-0 !flex-1 !justify-center !px-2 !text-xs !text-foreground hover:!bg-background/80"
                                            size="small"
                                            icon={<Link2 className="size-3.5" />}
                                            disabled={!episode.shots.length}
                                            onClick={() => setReferenceAsset(asset)}
                                        >
                                            引用到分镜
                                        </Button>
                                        <span className="h-4 w-px shrink-0 bg-border" />
                                        <Button
                                            type="text"
                                            className="!h-7 !min-w-0 !flex-1 !justify-center !px-2 !text-xs !text-foreground hover:!bg-background/80"
                                            size="small"
                                            icon={<ImagePlus className="size-3.5" />}
                                            onClick={() => setVisualAsset(asset)}
                                        >
                                            加入视觉资产
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
            </div>
            {assets.some((asset) => asset.type !== "text" && Boolean(asset.serverUrl || asset.remoteUrl)) ? <MediaRetentionNotice className="max-w-full" /> : null}
            <Modal title="引用图片到分镜" open={Boolean(referenceAsset)} width={420} centered destroyOnHidden okText="确认引用" cancelText="取消" okButtonProps={{ disabled: !shotId }} onCancel={() => setReferenceAsset(undefined)} onOk={applyReference}>
                <div className="grid gap-4 pt-2">
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">目标镜头</span>
                        <Select
                            value={shotId || undefined}
                            placeholder="选择要引用的镜头"
                            optionFilterProp="label"
                            options={episode.shots.map((shot) => ({ value: shot.id, label: `${String(shot.order).padStart(2, "0")} · ${shot.title}` }))}
                            onChange={setShotId}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">引用位置</span>
                        <Segmented
                            block
                            value={frameKind}
                            options={[
                                { label: "起始帧", value: "start" },
                                { label: "结束帧", value: "end" },
                            ]}
                            onChange={(value) => setFrameKind(value as "start" | "end")}
                        />
                    </label>
                    <p className="text-xs leading-5 text-muted-foreground">引用后会替换该位置现有图片；如镜头已有视频，需要重新生成以应用新画面。</p>
                </div>
            </Modal>
            <Modal
                title="加入视觉资产"
                open={Boolean(visualAsset)}
                width={460}
                centered
                destroyOnHidden
                okText="保存到视觉资产"
                cancelText="取消"
                okButtonProps={{ disabled: !visualAsset || (!visualAssetId && !newVisualAssetName.trim()) }}
                onCancel={() => {
                    setVisualAsset(undefined);
                    setVisualAssetId("");
                    setNewVisualAssetName("");
                }}
                onOk={applyVisualAsset}
            >
                <div className="grid gap-4 pt-2">
                    <p className="text-sm leading-6 text-muted-foreground">这张智能助手图片会直接保存为角色、场景、道具或线索的参考图，不需要下载后重新上传。</p>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">资产类型</span>
                        <Segmented
                            block
                            value={visualKind}
                            options={visualAssetKinds.map((item) => ({ label: item.label, value: item.value }))}
                            onChange={(value) => {
                                setVisualKind(value as VisualAssetKind);
                                setVisualAssetId("");
                            }}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">加入已有资产</span>
                        <Select
                            allowClear
                            value={visualAssetId || undefined}
                            placeholder="选择已有角色、场景、道具或线索"
                            options={project[visualKind].map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(value) => {
                                setVisualAssetId(value || "");
                                if (value) setNewVisualAssetName("");
                            }}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">或新建资产名称</span>
                        <Input
                            value={newVisualAssetName}
                            onChange={(event) => {
                                setNewVisualAssetName(event.target.value);
                                if (event.target.value.trim()) setVisualAssetId("");
                            }}
                            placeholder={`例如：${visualAssetKinds.find((item) => item.value === visualKind)?.placeholder || "关键资产"}`}
                        />
                    </label>
                </div>
            </Modal>
        </>
    );
}

type VisualAssetKind = "characters" | "scenes" | "props" | "clues";

const DRAMA_AGENT_STAGE_GUIDES: Record<DramaProjectStage, { label: string; prompts: Array<{ label: string; prompt: string }> }> = {
    script: {
        label: "剧本协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前集剧本是否具备进入内容审核的条件，按已完成、待补充、阻塞项列出结果。" },
            { label: "检查缺失资产", prompt: "从当前剧本中找出尚未登记的角色、场景、道具和线索，只给出资产清单与优先级。" },
            { label: "检查一致性", prompt: "检查当前集的人物动机、时间线、冲突、情绪递进和结尾钩子是否一致，列出最小修改建议。" },
            { label: "建议下一步", prompt: "根据当前剧本与项目状态，只建议一个最值得立即执行的下一步，并说明完成标准。" },
        ],
    },
    review: {
        label: "内容审核协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前内容审核是否具备确认条件，按镜头列出已完成、待确认和阻塞项。" },
            { label: "检查缺失资产", prompt: "检查审核结果是否遗漏角色、场景、道具、线索或对应稳定引用，列出缺失项。" },
            { label: "检查一致性", prompt: "核对镜头与原剧本的对白、旁白、角色、场景、道具、线索和镜头边界，列出不一致项。" },
            { label: "建议下一步", prompt: "根据当前审核状态，只建议一个最值得立即执行的下一步，并说明完成标准。" },
        ],
    },
    storyboard: {
        label: "分镜协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前集分镜是否具备进入镜头生成的条件，按镜头列出完成、待补和阻塞项。" },
            { label: "检查缺失资产", prompt: "检查分镜图片与视频提示词是否缺少稳定角色、场景、道具、线索或参考图引用。" },
            { label: "检查一致性", prompt: "检查当前集分镜的景别、轴线、视线、动作承接、场景连续性和资产一致性，给出逐镜头建议。" },
            { label: "建议下一步", prompt: "根据当前分镜状态，只建议一个最值得立即修正的镜头，并说明完成标准。" },
        ],
    },
    generate: {
        label: "生成协作",
        prompts: [
            { label: "检查阶段完成度", prompt: "检查当前集镜头、配音与整集合成的完成度，按可生成、生成中、失败和已完成分类。" },
            { label: "检查缺失资产", prompt: "检查待生成镜头的提示词、参考资产、画幅、时长、首尾帧和配音依赖是否完整。" },
            { label: "检查一致性", prompt: "检查当前生成结果的角色、场景、动作、镜头衔接、音画与字幕一致性，归纳需修正项。" },
            { label: "建议下一步", prompt: "根据当前任务状态与错误信息，只建议一个最值得立即执行的下一步，不自动重试或生成。" },
        ],
    },
};

const visualAssetKinds: Array<{ value: VisualAssetKind; label: string; placeholder: string }> = [
    { value: "characters", label: "角色", placeholder: "女主角" },
    { value: "scenes", label: "场景", placeholder: "医院走廊" },
    { value: "props", label: "道具", placeholder: "旧手机" },
    { value: "clues", label: "线索", placeholder: "染血的手帕" },
];

function emptyAssetProfile() {
    return { visualIdentity: "", styling: "", colorPalette: "", consistencyRules: "" };
}

function agentAssetSnapshot(asset: DramaNamedAsset) {
    return {
        id: asset.id,
        name: asset.name,
        description: asset.description,
        profile: asset.profile,
        primaryReferenceId: asset.primaryReferenceId,
        referenceImageUrl: asset.referenceImageUrl,
    };
}

function dramaSnapshot(project: DramaProject, episode: DramaEpisode, stage: DramaProjectStage, selectedShotId?: string, projectReferences: DramaAgentMentionItem[] = []) {
    return {
        currentStage: stage,
        project: {
            id: project.id,
            title: project.title,
            summary: project.summary,
            style: project.style,
            ratio: project.ratio,
            defaultVideoMode: project.defaultVideoMode,
        },
        episode: {
            id: episode.id,
            title: episode.title,
            script: episode.script,
            outline: episode.outline,
            hook: episode.hook,
            nextPreview: episode.nextPreview,
            sourceRange: episode.sourceRange,
            reviewStatus: episode.reviewStatus,
        },
        selectedShotId,
        currentTurnReferences: projectReferences.map(({ id, kind, title, alias }) => ({ id, kind, title, alias: `@${alias}` })),
        sourceAssets: project.sourceAssets?.map((asset) => ({
            id: asset.id,
            type: asset.type,
            title: asset.title,
            textContent: asset.textContent,
            serverUrl: asset.serverUrl,
            remoteUrl: asset.remoteUrl,
        })),
        characters: project.characters.map((asset) => ({ ...agentAssetSnapshot(asset), voiceProfile: asset.voiceProfile })),
        scenes: project.scenes.map(agentAssetSnapshot),
        props: project.props.map(agentAssetSnapshot),
        clues: project.clues.map((asset) => ({ ...agentAssetSnapshot(asset), payoff: asset.payoff })),
        shots: episode.shots.map((shot) => ({
            id: shot.id,
            order: shot.order,
            title: shot.title,
            description: shot.description,
            sourceText: shot.sourceText,
            shotBoundary: shot.shotBoundary,
            dialogue: shot.dialogue,
            narration: shot.narration,
            utterances: shot.utterances,
            imagePrompt: shot.imagePrompt,
            videoPrompt: shot.videoPrompt,
            cameraMotion: shot.cameraMotion,
            startFramePrompt: shot.startFramePrompt,
            endFramePrompt: shot.endFramePrompt,
            negativePrompt: shot.negativePrompt,
            continuity: shot.continuity,
            duration: shot.duration,
            characterIds: shot.characterIds,
            sceneId: shot.sceneId,
            propIds: shot.propIds,
            clueIds: shot.clueIds,
            videoMode: shot.videoMode,
            storyboardFrameMode: shot.storyboardFrameMode,
            storyboardStatus: shot.storyboardStatus,
            storyboardError: shot.storyboardError,
            storyboardImageUrl: shot.storyboardImageUrl,
            storyboardEndStatus: shot.storyboardEndStatus,
            storyboardEndError: shot.storyboardEndError,
            storyboardEndImageUrl: shot.storyboardEndImageUrl,
            generationStatus: shot.generationStatus,
            generationError: shot.generationError,
            videoUrl: shot.videoUrl,
            subtitle: shot.subtitle,
            audioMode: shot.audioMode,
            audioStatus: shot.audioStatus,
            audioError: shot.audioError,
            audioUrl: shot.audioUrl,
        })),
    };
}

function agentAssetDownloads(assets: CreativeAsset[]): AgentMediaDownload[] {
    return assets.flatMap((asset) => {
        const url = asset.serverUrl || asset.remoteUrl || "";
        return url && (asset.type === "image" || asset.type === "video") ? [{ type: asset.type, url, title: asset.title || (asset.type === "video" ? "生成视频" : "生成图片"), mimeType: asset.mimeType }] : [];
    });
}
