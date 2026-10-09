"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isCreativeProjectHandoff, type CreativeAsset, type CreativeConversation, type CreativeGenerationPreferences, type CreativeMessage, type CreativeProjectHandoff, type CreativeReferenceRecovery } from "@/lib/creative-runtime-contract";
import {
    deleteCreativeConversations,
    controlCreativeAgentRun,
    createCreativeAgentRun,
    createCreativeConversation,
    getCreativeConversation,
    getCreativeAgentRun,
    listCreativeAgentRuns,
    listCreativeAssets,
    listCreativeConversationPage,
    listCreativeMessages,
    retryCreativeAgentTask,
    retryCreativeAgentTasks,
    updateCreativeConversation,
    uploadCreativeAsset,
    watchCreativeAgentRun,
    type CreativeAgentRun,
    type CreativeSceneSelection,
} from "@/services/api/creative";
import { getMaterializedCreativeProject, materializeCreativeProjectHandoff, type MaterializedCreativeProject } from "@/services/creative-project-handoff";
import { agentRequirementAcknowledgement } from "@/lib/agent-requirement-acknowledgement";

import { createConversationIdFromSearch, latestResumableAgentRun } from "./create-conversation-navigation";
import { getCreateDraftAttachment, useCreateDraftAttachmentsStore } from "./use-create-draft-attachments-store";

type PendingCreateSubmission = {
    clientRequestId: string;
    generation: number;
    conversationId?: string;
    content: string;
    executionPrompt: string;
    assetIds: string[];
    skillIds: string[];
    modelIds: string[];
    preferences?: CreativeGenerationPreferences;
    temporaryUserId: string;
    temporaryAssistantId: string;
};

type CreateSubmitOptions = {
    publicPrompt?: string;
    assetIds?: string[];
    skillIds?: string[];
    modelIds?: string[];
    preferences?: CreativeGenerationPreferences;
};

const MESSAGE_PAGE_SIZE = 50;

export function useCreateAgent() {
    const streamRef = useRef<(() => void) | null>(null);
    const conversationGenerationRef = useRef(0);
    const activeConversationRef = useRef<string | undefined>(undefined);
    const submittingRef = useRef(false);
    const failedSubmissionsRef = useRef(new Map<string, PendingCreateSubmission>());
    const refreshRequestRef = useRef(0);
    const [conversations, setConversations] = useState<CreativeConversation[]>([]);
    const [messages, setMessages] = useState<CreativeMessage[]>([]);
    const [assets, setAssets] = useState<CreativeAsset[]>([]);
    const [conversationId, setConversationId] = useState<string>();
    const [activeRunId, setActiveRunId] = useState<string>();
    const [activeRunStatus, setActiveRunStatus] = useState<CreativeAgentRun["status"]>();
    const [runDetails, setRunDetails] = useState<Record<string, CreativeAgentRun>>({});
    const [historyLoading, setHistoryLoading] = useState(true);
    const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [conversationLoading, setConversationLoading] = useState(false);
    const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
    const [hasOlderMessages, setHasOlderMessages] = useState(false);
    const [sending, setSending] = useState(false);
    const [projectLinks, setProjectLinks] = useState<Record<string, MaterializedCreativeProject>>({});
    const [projectErrors, setProjectErrors] = useState<Record<string, string>>({});
    const [materializingProjectId, setMaterializingProjectId] = useState<string>();
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const draftAttachments = useCreateDraftAttachmentsStore((state) => state.attachments);
    const addDraftAttachments = useCreateDraftAttachmentsStore((state) => state.add);
    const removeDraftAttachments = useCreateDraftAttachmentsStore((state) => state.remove);
    const clearDraftAttachments = useCreateDraftAttachmentsStore((state) => state.clear);
    const allAssets = useMemo(() => [...assets, ...draftAttachments.map((item) => item.asset)], [assets, draftAttachments]);
    const selectedAssetIdsWithDrafts = useMemo(() => Array.from(new Set([...selectedAssetIds, ...draftAttachments.map((item) => item.asset.id)])), [draftAttachments, selectedAssetIds]);

    const stopWatching = useCallback(() => {
        streamRef.current?.();
        streamRef.current = null;
    }, []);

    const isCurrentConversation = useCallback((id: string | undefined, generation: number) => generation === conversationGenerationRef.current && activeConversationRef.current === id, []);

    const resetConversationView = useCallback((id?: string) => {
        setConversationId(id);
        setActiveRunId(undefined);
        setActiveRunStatus(undefined);
        setRunDetails({});
        setMessages([]);
        setHasOlderMessages(false);
        setOlderMessagesLoading(false);
        setAssets([]);
        setSelectedAssetIds([]);
        setProjectLinks({});
        setProjectErrors({});
        setMaterializingProjectId(undefined);
        setConversationLoading(false);
        setUploading(false);
        setSending(false);
    }, []);

    const refreshConversations = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const page = await listCreativeConversationPage({ source: "agent" });
            setConversations(page.conversations);
            setHistoryHasMore(page.hasMore);
        } finally {
            setHistoryLoading(false);
        }
    }, []);

    const refreshAssets = useCallback(async (id: string, generation = conversationGenerationRef.current) => {
        const nextAssets = await listCreativeAssets(id);
        if (generation !== conversationGenerationRef.current || activeConversationRef.current !== id) return;
        setAssets(nextAssets);
    }, []);

    const refreshConversation = useCallback(async (id: string, generation = conversationGenerationRef.current) => {
        const requestId = ++refreshRequestRef.current;
        const [nextMessages, nextAssets] = await Promise.all([listCreativeMessages(id, undefined, MESSAGE_PAGE_SIZE), listCreativeAssets(id)]);
        if (requestId !== refreshRequestRef.current || generation !== conversationGenerationRef.current || activeConversationRef.current !== id) return;
        const runIds = Array.from(new Set(nextMessages.map((item) => item.runId).filter((value): value is string => Boolean(value))));
        const runs = await Promise.all(runIds.map((runId) => getCreativeAgentRun(runId).catch(() => null)));
        if (requestId !== refreshRequestRef.current || generation !== conversationGenerationRef.current || activeConversationRef.current !== id) return;
        setMessages(uniqueMessages(nextMessages));
        setHasOlderMessages(Boolean(nextMessages[0] && nextMessages[0].sequence > 1));
        setAssets(nextAssets);
        setSelectedAssetIds([]);
        setRunDetails(Object.fromEntries(runs.filter((run): run is CreativeAgentRun => Boolean(run && run.conversationId === id)).map((run) => [run.id, run])));
        const handoffs = nextMessages
            .map((item) => item.metadata.projectHandoff)
            .filter(isCreativeProjectHandoff)
            .filter((handoff) => handoff.conversationId === id);
        const projects = await Promise.all(handoffs.map(getMaterializedCreativeProject));
        if (requestId !== refreshRequestRef.current || generation !== conversationGenerationRef.current || activeConversationRef.current !== id) return;
        setProjectLinks(() => {
            const next: Record<string, MaterializedCreativeProject> = {};
            handoffs.forEach((handoff, index) => {
                const project = projects[index];
                if (project) next[handoff.id] = project;
            });
            return next;
        });
    }, []);

    const loadMoreConversations = useCallback(async () => {
        if (historyLoadingMore || !historyHasMore) return;
        setHistoryLoadingMore(true);
        try {
            const page = await listCreativeConversationPage({ source: "agent", offset: conversations.length });
            setConversations((current) => Array.from(new Map([...current, ...page.conversations].map((item) => [item.id, item])).values()));
            setHistoryHasMore(page.hasMore);
        } finally {
            setHistoryLoadingMore(false);
        }
    }, [conversations.length, historyHasMore, historyLoadingMore]);

    const loadOlderMessages = useCallback(async () => {
        const id = activeConversationRef.current;
        const generation = conversationGenerationRef.current;
        const firstSequence = messages[0]?.sequence;
        if (!id || !firstSequence || olderMessagesLoading || !hasOlderMessages) return;
        setOlderMessagesLoading(true);
        try {
            const older = await listCreativeMessages(id, firstSequence, MESSAGE_PAGE_SIZE);
            if (!isCurrentConversation(id, generation)) return;
            setMessages((current) => uniqueMessages([...older, ...current]));
            setHasOlderMessages(Boolean(older[0] && older[0].sequence > 1));
        } finally {
            if (isCurrentConversation(id, generation)) setOlderMessagesLoading(false);
        }
    }, [hasOlderMessages, isCurrentConversation, messages, olderMessagesLoading]);

    const newConversation = useCallback(() => {
        stopWatching();
        clearDraftAttachments();
        conversationGenerationRef.current += 1;
        activeConversationRef.current = undefined;
        refreshRequestRef.current += 1;
        submittingRef.current = false;
        failedSubmissionsRef.current.clear();
        resetConversationView();
    }, [clearDraftAttachments, resetConversationView, stopWatching]);

    const openConversation = useCallback(
        async (id: string) => {
            stopWatching();
            clearDraftAttachments();
            const generation = ++conversationGenerationRef.current;
            activeConversationRef.current = id;
            submittingRef.current = false;
            failedSubmissionsRef.current.clear();
            refreshRequestRef.current += 1;
            resetConversationView(id);
            setConversationLoading(true);
            try {
                const conversation = await getCreativeConversation(id);
                if (conversation.surface !== "chat" || conversation.source !== "agent") throw new Error("该记录不属于创作 Agent 工作台");
                await refreshConversation(id, generation);
                if (isCurrentConversation(id, generation)) {
                    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)].sort((a, b) => b.updatedAt - a.updatedAt));
                }
            } catch (error) {
                if (isCurrentConversation(id, generation)) newConversation();
                throw error;
            } finally {
                if (isCurrentConversation(id, generation)) setConversationLoading(false);
            }
        },
        [clearDraftAttachments, isCurrentConversation, newConversation, refreshConversation, resetConversationView, stopWatching],
    );

    useEffect(() => {
        let active = true;
        const requestedConversationId = createConversationIdFromSearch(window.location.search);
        const conversationsRequest = refreshConversations().catch(() => undefined);
        if (!requestedConversationId) {
            void Promise.all([conversationsRequest, listCreativeAgentRuns("chat", { activeOnly: true, limit: 1 })])
                .then(([, runs]) => {
                    if (!active || activeConversationRef.current) return;
                    const resumable = latestResumableAgentRun(runs);
                    if (resumable) return openConversation(resumable.conversationId);
                })
                .catch(() => undefined);
        }
        return () => {
            active = false;
            stopWatching();
        };
    }, [openConversation, refreshConversations, stopWatching]);

    const updateAssistant = useCallback((id: string, content?: string, status: CreativeMessage["status"] = "running") => {
        setMessages((current) => current.map((item) => (item.id === id ? { ...item, content: content?.trim() || item.content, status, updatedAt: Date.now() } : item)));
    }, []);

    const materializeProject = useCallback(
        async (handoff: CreativeProjectHandoff, generation = conversationGenerationRef.current) => {
            if (!isCurrentConversation(handoff.conversationId, generation)) throw new Error("当前对话已切换");
            setMaterializingProjectId(handoff.id);
            setProjectErrors((current) => ({ ...current, [handoff.id]: "" }));
            try {
                const result = await materializeCreativeProjectHandoff(handoff);
                if (isCurrentConversation(handoff.conversationId, generation)) setProjectLinks((current) => ({ ...current, [handoff.id]: result }));
                return result;
            } catch (error) {
                if (isCurrentConversation(handoff.conversationId, generation)) {
                    const text = error instanceof Error ? error.message : "项目创建失败";
                    setProjectErrors((current) => ({ ...current, [handoff.id]: text }));
                }
                throw error;
            } finally {
                if (isCurrentConversation(handoff.conversationId, generation)) {
                    setMaterializingProjectId((current) => (current === handoff.id ? undefined : current));
                }
            }
        },
        [isCurrentConversation],
    );

    const ensureConversation = useCallback(
        async (generation = conversationGenerationRef.current) => {
            if (activeConversationRef.current) return activeConversationRef.current;
            const conversation = await createCreativeConversation({ surface: "chat", source: "agent", title: "新对话" });
            if (isCurrentConversation(undefined, generation)) {
                activeConversationRef.current = conversation.id;
                setConversationId(conversation.id);
                setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
            }
            return conversation.id;
        },
        [isCurrentConversation],
    );

    const uploadAttachments = useCallback(
        async (files: File[]) => {
            if (!files.length) return [];
            return addDraftAttachments(files, activeConversationRef.current || "");
        },
        [addDraftAttachments],
    );

    const materializeDraftAttachments = useCallback(
        async (assetIds: string[], generation: number, submissionConversationId?: string) => {
            const drafts = assetIds.map((id) => ({ id, draft: getCreateDraftAttachment(id) })).filter((item): item is { id: string; draft: NonNullable<ReturnType<typeof getCreateDraftAttachment>> } => Boolean(item.draft));
            if (!drafts.length) return { conversationId: submissionConversationId, assetIds, replacements: new Map<string, CreativeAsset>() };
            const replacements = new Map<string, CreativeAsset>();
            if (isCurrentConversation(submissionConversationId, generation)) setUploading(true);
            let materializedConversationId = submissionConversationId;
            try {
                materializedConversationId = await ensureConversation(generation);
                for (const { id, draft } of drafts) {
                    replacements.set(id, await uploadCreativeAsset(materializedConversationId, draft.file));
                }
                return { conversationId: materializedConversationId, assetIds: assetIds.map((assetId) => replacements.get(assetId)?.id || assetId), replacements };
            } finally {
                if (isCurrentConversation(materializedConversationId, generation) && replacements.size) {
                    const uploadedAssets = Array.from(replacements.values());
                    setAssets((current) => [...current, ...uploadedAssets.filter((asset) => !current.some((item) => item.id === asset.id))]);
                    setSelectedAssetIds((current) => Array.from(new Set([...current, ...uploadedAssets.map((asset) => asset.id)])));
                    removeDraftAttachments(replacements.keys());
                }
                if (isCurrentConversation(materializedConversationId, generation)) setUploading(false);
            }
        },
        [ensureConversation, isCurrentConversation, removeDraftAttachments],
    );

    const watchRun = useCallback(
        (run: CreativeAgentRun, assistantMessageId: string, generation = conversationGenerationRef.current) => {
            if (!isCurrentConversation(run.conversationId, generation)) return false;
            streamRef.current?.();
            let observedStatus = run.status;
            setSending(run.status === "planning" || run.status === "running");
            submittingRef.current = run.status === "planning" || run.status === "running";
            setActiveRunId(run.id);
            setActiveRunStatus(run.status);
            streamRef.current = watchCreativeAgentRun(run.id, {
                onProgress: (text) => {
                    if (generation === conversationGenerationRef.current && activeConversationRef.current === run.conversationId) updateAssistant(assistantMessageId, text);
                },
                onStatus: (status) => {
                    if (generation === conversationGenerationRef.current && activeConversationRef.current === run.conversationId) {
                        const statusChanged = observedStatus !== status;
                        observedStatus = status;
                        setActiveRunStatus(status);
                        setSending(status === "planning" || status === "running");
                        submittingRef.current = status === "planning" || status === "running";
                        setRunDetails((current) => ({ ...current, [run.id]: { ...(current[run.id] || run), status } }));
                        if (status === "paused" && statusChanged) {
                            void getCreativeAgentRun(run.id)
                                .then((latest) => {
                                    if (generation !== conversationGenerationRef.current || activeConversationRef.current !== run.conversationId) return;
                                    setRunDetails((current) => ({ ...current, [run.id]: latest }));
                                })
                                .catch(() => undefined);
                        }
                    }
                },
                onSnapshot: (snapshot) => {
                    if (!isCurrentConversation(run.conversationId, generation)) return;
                    setRunDetails((current) => ({
                        ...current,
                        [run.id]: { ...(current[run.id] || run), ...snapshot, tasks: snapshot.tasks || current[run.id]?.tasks || run.tasks, assetIds: snapshot.assetIds || current[run.id]?.assetIds || run.assetIds },
                    }));
                },
                onTaskCompleted: () => {
                    if (generation === conversationGenerationRef.current && activeConversationRef.current === run.conversationId) void refreshAssets(run.conversationId, generation).catch(() => undefined);
                },
                onTerminal: (status, text) => {
                    if (generation !== conversationGenerationRef.current || activeConversationRef.current !== run.conversationId) return;
                    updateAssistant(assistantMessageId, text, status === "completed" ? "completed" : status);
                    setSending(false);
                    submittingRef.current = false;
                    setActiveRunId(undefined);
                    setActiveRunStatus(undefined);
                    streamRef.current = null;
                    void Promise.all([refreshConversation(run.conversationId, generation), refreshConversations()]);
                },
                onConnectionError: (text) => {
                    if (generation !== conversationGenerationRef.current || activeConversationRef.current !== run.conversationId) return;
                    updateAssistant(assistantMessageId, text, "running");
                    streamRef.current = null;
                },
                onProjectHandoff: (handoff) => {
                    if (generation !== conversationGenerationRef.current || activeConversationRef.current !== run.conversationId) return;
                    setMessages((current) => current.map((item) => (item.id === assistantMessageId ? { ...item, metadata: { ...item.metadata, projectHandoff: handoff } } : item)));
                    void materializeProject(handoff, generation).catch(() => undefined);
                },
            });
            return true;
        },
        [isCurrentConversation, materializeProject, refreshAssets, refreshConversation, refreshConversations, updateAssistant],
    );

    useEffect(() => {
        if (!conversationId || sending || streamRef.current || activeConversationRef.current !== conversationId) return;
        const running = messages.find((item) => item.role === "assistant" && item.status === "running" && item.runId);
        if (!running?.runId) return;
        const generation = conversationGenerationRef.current;
        const expectedConversationId = conversationId;
        void getCreativeAgentRun(running.runId)
            .then((run) => {
                if (!isCurrentConversation(expectedConversationId, generation) || run.conversationId !== expectedConversationId || streamRef.current) return;
                watchRun(run, running.id, generation);
            })
            .catch(() => undefined);
    }, [conversationId, isCurrentConversation, messages, sending, watchRun]);

    const executeSubmission = useCallback(
        async (snapshot: PendingCreateSubmission) => {
            try {
                const created = await createCreativeAgentRun({
                    clientRequestId: snapshot.clientRequestId,
                    surface: "chat",
                    conversationId: snapshot.conversationId,
                    prompt: snapshot.executionPrompt,
                    publicPrompt: snapshot.content,
                    assetIds: snapshot.assetIds,
                    skillIds: snapshot.skillIds,
                    modelIds: snapshot.modelIds,
                    preferences: snapshot.preferences,
                });
                const run = created.run;
                void refreshConversations();
                const belongsToSubmission = !snapshot.conversationId || snapshot.conversationId === run.conversationId;
                const canClaimCurrentView = snapshot.generation === conversationGenerationRef.current && belongsToSubmission && (!activeConversationRef.current || activeConversationRef.current === run.conversationId);
                if (!canClaimCurrentView) return true;
                failedSubmissionsRef.current.delete(snapshot.temporaryAssistantId);
                activeConversationRef.current = run.conversationId;
                setConversationId(run.conversationId);
                setRunDetails((current) => ({ ...current, [run.id]: run }));
                setMessages((current) =>
                    current.map((item) => {
                        if (item.id === snapshot.temporaryUserId) return { ...item, id: run.inputMessageId, conversationId: run.conversationId, runId: run.id };
                        if (item.id === snapshot.temporaryAssistantId) return { ...item, id: run.assistantMessageId, conversationId: run.conversationId, runId: run.id };
                        return item;
                    }),
                );
                watchRun(run, run.assistantMessageId, snapshot.generation);
                return true;
            } catch (error) {
                if (!isCurrentConversation(snapshot.conversationId, snapshot.generation)) return false;
                failedSubmissionsRef.current.set(snapshot.temporaryAssistantId, snapshot);
                updateAssistant(snapshot.temporaryAssistantId, error instanceof Error ? error.message : "创作请求失败", "failed");
                setSending(false);
                submittingRef.current = false;
                return false;
            }
        },
        [isCurrentConversation, refreshConversations, updateAssistant, watchRun],
    );

    const submit = useCallback(
        async (prompt: string, options?: CreateSubmitOptions) => {
            const executionPrompt = prompt.trim();
            const content = (options?.publicPrompt || prompt).trim();
            if (!executionPrompt || !content || sending || submittingRef.current) return false;
            submittingRef.current = true;
            const generation = conversationGenerationRef.current;
            const submissionConversationId = activeConversationRef.current;
            stopWatching();
            setSending(true);
            const selectedIds = options?.assetIds || selectedAssetIdsWithDrafts;
            let prepared: Awaited<ReturnType<typeof materializeDraftAttachments>>;
            try {
                prepared = await materializeDraftAttachments(selectedIds, generation, submissionConversationId);
            } catch (error) {
                if (generation === conversationGenerationRef.current) {
                    setSending(false);
                    submittingRef.current = false;
                }
                throw error;
            }
            const now = Date.now();
            const sequence = messages.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
            const temporaryUserId = `message-${nanoid()}`;
            const temporaryAssistantId = `message-${nanoid()}`;
            const submittedConversationId = prepared.conversationId || submissionConversationId;
            const optimisticConversationId = submittedConversationId || "pending";
            const assetIds = prepared.assetIds;
            const preferences = remapDraftAssetIds(options?.preferences, prepared.replacements);
            const snapshot: PendingCreateSubmission = {
                clientRequestId: `create-${nanoid()}`,
                generation,
                conversationId: submittedConversationId,
                content,
                executionPrompt,
                assetIds,
                skillIds: options?.skillIds || [],
                modelIds: options?.modelIds || [],
                preferences,
                temporaryUserId,
                temporaryAssistantId,
            };
            if (isCurrentConversation(submittedConversationId, generation)) {
                setMessages((current) => [
                    ...current,
                    { id: temporaryUserId, conversationId: optimisticConversationId, sequence, role: "user", status: "completed", content, metadata: { assetIds }, createdAt: now, updatedAt: now },
                    {
                        id: temporaryAssistantId,
                        conversationId: optimisticConversationId,
                        sequence: sequence + 1,
                        role: "assistant",
                        status: "running",
                        content: agentRequirementAcknowledgement(content, "chat", assetIds.length > 0),
                        metadata: {},
                        createdAt: now,
                        updatedAt: now,
                    },
                ]);
                const consumedIds = new Set([...selectedIds, ...assetIds]);
                setSelectedAssetIds((current) => current.filter((id) => !consumedIds.has(id)));
            }
            return executeSubmission(snapshot);
        },
        [executeSubmission, isCurrentConversation, materializeDraftAttachments, messages, selectedAssetIdsWithDrafts, sending, stopWatching],
    );

    const retrySubmission = useCallback(
        async (assistantMessageId: string) => {
            const snapshot = failedSubmissionsRef.current.get(assistantMessageId);
            if (!snapshot || sending || submittingRef.current || !isCurrentConversation(snapshot.conversationId, snapshot.generation)) return false;
            submittingRef.current = true;
            stopWatching();
            setSending(true);
            updateAssistant(assistantMessageId, "正在重新提交创作请求", "running");
            return executeSubmission(snapshot);
        },
        [executeSubmission, isCurrentConversation, sending, stopWatching, updateAssistant],
    );

    const cancel = useCallback(async () => {
        const expectedConversationId = activeConversationRef.current;
        if (!activeRunId || !expectedConversationId) return;
        await controlCreativeAgentRun(activeRunId, "cancel", expectedConversationId);
    }, [activeRunId]);

    const control = useCallback(
        async (action: "pause" | "resume") => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!activeRunId || !expectedConversationId) return;
            const result = await controlCreativeAgentRun(activeRunId, action, expectedConversationId);
            if (!isCurrentConversation(expectedConversationId, generation) || result.run.conversationId !== expectedConversationId) return;
            setActiveRunStatus(result.run.status);
            if (action === "resume") {
                const assistantMessage = messages.find((item) => item.runId === result.run.id && item.role === "assistant");
                if (assistantMessage) watchRun(result.run, assistantMessage.id, generation);
            }
        },
        [activeRunId, isCurrentConversation, messages, watchRun],
    );

    const confirmSceneSelection = useCallback(
        async (runId: string, selection: CreativeSceneSelection) => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!expectedConversationId) throw new Error("当前对话已切换");
            const result = await controlCreativeAgentRun(runId, "resume", expectedConversationId, selection);
            if (!isCurrentConversation(expectedConversationId, generation) || result.run.conversationId !== expectedConversationId) return;
            setRunDetails((current) => ({ ...current, [runId]: result.run }));
            const assistantMessage = messages.find((item) => item.runId === runId && item.role === "assistant");
            if (assistantMessage) {
                updateAssistant(assistantMessage.id, "已确认修改位置，继续这次创作。", "running");
                watchRun(result.run, assistantMessage.id, generation);
            }
        },
        [isCurrentConversation, messages, updateAssistant, watchRun],
    );

    const recoverReference = useCallback(
        async (runId: string, recovery: CreativeReferenceRecovery) => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!expectedConversationId) throw new Error("当前对话已切换");
            const result = await controlCreativeAgentRun(runId, "resume", expectedConversationId, undefined, recovery);
            if (!isCurrentConversation(expectedConversationId, generation) || result.run.conversationId !== expectedConversationId) return;
            setRunDetails((current) => ({ ...current, [runId]: result.run }));
            const assistantMessage = messages.find((item) => item.runId === runId && item.role === "assistant");
            if (assistantMessage) {
                updateAssistant(assistantMessage.id, recovery.action === "confirm_purposes" ? "已确认参考用途，继续这次创作。" : recovery.action === "retry_source" ? "正在核对参考图片，继续这次创作。" : "正在重新分析参考图片。", "running");
                watchRun(result.run, assistantMessage.id, generation);
            }
        },
        [isCurrentConversation, messages, updateAssistant, watchRun],
    );

    const checkStatus = useCallback(
        async (runId: string) => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!expectedConversationId) throw new Error("当前对话已切换");
            const result = await controlCreativeAgentRun(runId, "resume", expectedConversationId);
            if (!isCurrentConversation(expectedConversationId, generation) || result.run.conversationId !== expectedConversationId) return;
            setRunDetails((current) => ({ ...current, [runId]: result.run }));
            const assistantMessage = messages.find((item) => item.runId === runId && item.role === "assistant");
            if (assistantMessage) {
                updateAssistant(assistantMessage.id, "正在检查原任务状态。", "running");
                watchRun(result.run, assistantMessage.id, generation);
            }
        },
        [isCurrentConversation, messages, updateAssistant, watchRun],
    );

    const retryTask = useCallback(
        async (runId: string, taskId: string) => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!expectedConversationId) return;
            const result = await retryCreativeAgentTask(runId, taskId, expectedConversationId);
            if (!isCurrentConversation(expectedConversationId, generation) || result.conversationId !== expectedConversationId) return;
            setRunDetails((current) => ({ ...current, [runId]: result }));
            const assistantMessage = messages.find((item) => item.runId === runId && item.role === "assistant");
            if (assistantMessage) {
                updateAssistant(assistantMessage.id, "正在重新生成图片…");
                watchRun(result, assistantMessage.id, generation);
            }
        },
        [isCurrentConversation, messages, updateAssistant, watchRun],
    );

    const retryTasks = useCallback(
        async (runId: string, taskIds: string[]) => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!expectedConversationId || !taskIds.length) return;
            const result = await retryCreativeAgentTasks(runId, taskIds, expectedConversationId);
            if (!isCurrentConversation(expectedConversationId, generation) || result.conversationId !== expectedConversationId) return;
            setRunDetails((current) => ({ ...current, [runId]: result }));
            const assistantMessage = messages.find((item) => item.runId === runId && item.role === "assistant");
            if (assistantMessage) {
                updateAssistant(assistantMessage.id, "正在重新生成图片…");
                watchRun(result, assistantMessage.id, generation);
            }
        },
        [isCurrentConversation, messages, updateAssistant, watchRun],
    );

    const retryRun = useCallback(
        async (runId: string) => {
            const expectedConversationId = activeConversationRef.current;
            const generation = conversationGenerationRef.current;
            if (!expectedConversationId) return;
            const result = await controlCreativeAgentRun(runId, "retry", expectedConversationId);
            if (!isCurrentConversation(expectedConversationId, generation) || result.run.conversationId !== expectedConversationId) return;
            setRunDetails((current) => ({ ...current, [runId]: result.run }));
            const assistantMessage = messages.find((item) => item.runId === runId && item.role === "assistant");
            if (assistantMessage) {
                updateAssistant(assistantMessage.id, "正在重新分析并执行这次请求…", "running");
                watchRun(result.run, assistantMessage.id, generation);
            }
        },
        [isCurrentConversation, messages, updateAssistant, watchRun],
    );

    const renameConversation = useCallback(async (id: string, title: string) => {
        const updated = await updateCreativeConversation(id, { title });
        setConversations((current) => current.map((item) => (item.id === id ? updated : item)).sort((a, b) => b.updatedAt - a.updatedAt));
    }, []);

    const deleteConversations = useCallback(
        async (ids: string[]) => {
            const uniqueIds = Array.from(new Set(ids));
            await deleteCreativeConversations(uniqueIds);
            if (uniqueIds.includes(activeConversationRef.current || "")) newConversation();
            await refreshConversations();
        },
        [newConversation, refreshConversations],
    );

    return {
        conversations,
        messages,
        assets,
        conversationId,
        activeRunId,
        activeRunStatus,
        runDetails,
        historyLoading,
        historyLoadingMore,
        historyHasMore,
        loadMoreConversations,
        conversationLoading,
        olderMessagesLoading,
        hasOlderMessages,
        loadOlderMessages,
        sending,
        submit,
        cancel,
        control,
        confirmSceneSelection,
        recoverReference,
        checkStatus,
        retryTask,
        retryTasks,
        retryRun,
        retrySubmission,
        openConversation,
        newConversation,
        renameConversation,
        deleteConversations,
        projectLinks,
        projectErrors,
        materializingProjectId,
        materializeProject,
        selectedAssetIds: selectedAssetIdsWithDrafts,
        selectedAssets: allAssets.filter((asset) => selectedAssetIdsWithDrafts.includes(asset.id)),
        toggleAsset: (id: string) => setSelectedAssetIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id])),
        selectAsset: (id: string) => setSelectedAssetIds((current) => (current.includes(id) ? current : [...current, id])),
        uploading,
        uploadAttachments,
        removeAttachment: (id: string) => {
            if (getCreateDraftAttachment(id)) removeDraftAttachments([id]);
            setSelectedAssetIds((current) => current.filter((item) => item !== id));
        },
        restoreAttachments: (ids: string[]) => setSelectedAssetIds(Array.from(new Set(ids.filter((id) => allAssets.some((asset) => asset.id === id))))),
    };
}

function uniqueMessages(messages: CreativeMessage[]) {
    return Array.from(new Map(messages.map((item) => [item.id, item])).values()).sort((a, b) => a.sequence - b.sequence);
}

function remapDraftAssetIds(preferences: CreativeGenerationPreferences | undefined, replacements: Map<string, CreativeAsset>) {
    if (!preferences?.video || !replacements.size) return preferences;
    const remap = (id?: string) => (id ? replacements.get(id)?.id || id : undefined);
    return {
        ...preferences,
        video: {
            ...preferences.video,
            firstFrameAssetId: remap(preferences.video.firstFrameAssetId),
            lastFrameAssetId: remap(preferences.video.lastFrameAssetId),
        },
    };
}
