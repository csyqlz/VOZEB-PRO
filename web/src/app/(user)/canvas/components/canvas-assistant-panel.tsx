"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Bot, Files, History, ImagePlus, Layers3, LayoutPanelTop, PanelRightClose, Pause, PenLine, Play, Plus, Sparkles, Square, WandSparkles } from "lucide-react";
import { App, Button, Modal, Tooltip } from "antd";
import { motion } from "motion/react";

import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { controlCreativeAgentRun, createCreativeAgentRun, listCreativeAgentRuns, retryCreativeAgentTask } from "@/services/api/creative";
import { updateCreativeConversation } from "@/services/api/creative";
import { deleteCanvasAssistantConversations } from "@/services/api/canvas-projects";
import { refreshUserPointsIfSystem } from "@/services/api/points";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { CREATIVE_RUN_MODEL_LIMIT, type CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { CreativeAgentControls, CreativeAgentSkillCard, type CreativeAgentModelOption } from "@/components/agent/creative-agent-controls";
import { useCreativeAgentOptions } from "@/hooks/use-creative-agent-options";
import { watchCanvasAgentRun } from "./canvas-agent-run-client";
import { withCanvasAgentRunWatch } from "./canvas-agent-run-watch-guard";
import type { CanvasAgentRunStage } from "./canvas-agent-progress";
import { friendlyAgentError } from "@/components/agent/agent-message-format";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentWorkingMessage } from "./canvas-agent-chat-ui";
import { useCanvasAgentAttachments } from "./use-canvas-agent-attachments";
import { useCanvasAgentMessageScroll } from "./use-canvas-agent-message-scroll";
import { CANVAS_AGENT_PANEL_MOTION_MS } from "./canvas-agent-panel-motion";
import { reconcileCreativeGenerationPreferences } from "@/lib/creative-model-capabilities";
import { clearCanvasAssistantRun, findCanvasAssistantRunSession, patchCanvasAssistantRun, setCanvasAssistantRun, type CanvasAssistantRunState, type CanvasAssistantRunStates } from "./canvas-assistant-run-state";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasNodeData } from "../types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import { canvasAgentReferenceAliases, collectCanvasAgentMentionAssets, remapCanvasAgentReferences } from "./canvas-agent-mention";
import { CanvasAgentGenerationSettings } from "./canvas-agent-generation-settings";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;
const DEFAULT_PANEL_WIDTH = 404;
const MIN_PANEL_WIDTH = 348;
const MAX_PANEL_WIDTH = 640;
type OnlineAgentTab = "chat" | "history";

type CanvasAssistantPanelProps = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    snapshot: CanvasAgentSnapshot;
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    onSelectNodeIds: (ids: Set<string>) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onApplyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot;
    onLocateNode: (nodeId: string) => void;
    onPasteImage: (file: File) => Promise<string>;
    closing: boolean;
    onCollapse: () => void;
};

import { AssistantHistory, AssistantReferenceChip, assistantMessageToChatMessage, buildAssistantReferences, compactSnapshot, canvasRunSelectedNodeIds, createSession, removeCanvasAssistantSessions } from "./canvas-assistant-elements";

export function CanvasAssistantPanel({ nodes, selectedNodeIds, snapshot, sessions, activeSessionId, onSelectNodeIds, onSessionsChange, onApplyOps, onLocateNode, onPasteImage, closing, onCollapse }: CanvasAssistantPanelProps) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const { skills, skillsLoading, models } = useCreativeAgentOptions("canvas");
    const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
    const [view, setView] = useState<OnlineAgentTab>("chat");
    const [prompt, setPrompt] = useState("");
    const [selectedSkillId, setSelectedSkillId] = useState<string>();
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
    const [smartPlanning, setSmartPlanning] = useState(true);
    const [generationPreferences, setGenerationPreferences] = useState<CreativeGenerationPreferences>({});
    const [runStatesBySession, setRunStatesBySession] = useState<CanvasAssistantRunStates>({});
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [deletingChats, setDeletingChats] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [removedReferenceIds, setRemovedReferenceIds] = useState<Set<string>>(new Set());
    const [localSessions, setLocalSessions] = useState<CanvasAssistantSession[]>(sessions);
    const [localActiveSessionId, setLocalActiveSessionId] = useState<string | null>(activeSessionId);
    const snapshotRef = useRef(snapshot);
    const localSessionsRef = useRef(localSessions);
    const localActiveSessionIdRef = useRef(localActiveSessionId);
    const restoredProjectRef = useRef("");
    const restoredRunIdsRef = useRef(new Set<string>());
    const watchingRunIdsRef = useRef(new Set<string>());
    const runWatchControllersRef = useRef(new Map<string, AbortController>());
    const previousMediaReferenceIdsRef = useRef<string[]>([]);

    const commitSessionState = useCallback(
        (nextSessions: CanvasAssistantSession[], nextActiveSessionId: string | null) => {
            localSessionsRef.current = nextSessions;
            localActiveSessionIdRef.current = nextActiveSessionId;
            setLocalSessions(nextSessions);
            setLocalActiveSessionId(nextActiveSessionId);
            onSessionsChange(nextSessions, nextActiveSessionId);
        },
        [onSessionsChange],
    );

    useEffect(() => {
        localSessionsRef.current = sessions;
        localActiveSessionIdRef.current = activeSessionId;
        setLocalSessions(sessions);
        setLocalActiveSessionId(activeSessionId);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);

    const activeSession = useMemo(() => localSessions.find((session) => session.id === localActiveSessionId) || localSessions[0] || null, [localActiveSessionId, localSessions]);
    const activeRunState = activeSession ? runStatesBySession[activeSession.id] : undefined;
    const isRunning = Boolean(activeRunState);
    const runPaused = Boolean(activeRunState?.paused);
    const runStage = activeRunState?.stage || ({ key: "planning", text: "正在理解你的需求" } satisfies CanvasAgentRunStage);
    const historySessions = localSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const selectedNodeKey = useMemo(() => Array.from(selectedNodeIds).sort().join(","), [selectedNodeIds]);
    const allSelectedReferences = useMemo(() => buildAssistantReferences(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const selectedReferences = useMemo(() => allSelectedReferences.filter((item) => !removedReferenceIds.has(item.id)), [allSelectedReferences, removedReferenceIds]);
    const mentionAssets = useMemo(() => collectCanvasAgentMentionAssets(nodes), [nodes]);
    const selectedMediaReferences = useMemo(() => selectedReferences.filter((item) => item.dataUrl && (isCanvasImageNodeType(item.type) || item.type === CanvasNodeType.Video)), [selectedReferences]);
    const selectedMediaReferenceIds = useMemo(() => selectedMediaReferences.map((item) => item.id), [selectedMediaReferences]);
    const referenceAliases = useMemo(() => canvasAgentReferenceAliases(mentionAssets, selectedMediaReferenceIds), [mentionAssets, selectedMediaReferenceIds]);
    const selectedTextReferences = selectedReferences.filter((item) => !item.dataUrl);
    const readyReferenceIds = useMemo(() => allSelectedReferences.map((item) => item.id), [allSelectedReferences]);
    const { uploads, addFiles, retryUpload, removeUpload } = useCanvasAgentAttachments(onPasteImage, readyReferenceIds);
    const composerAttachments = [
        ...selectedMediaReferences.map((item) => ({ id: item.id, name: item.title, url: item.dataUrl!, type: item.type === CanvasNodeType.Video ? ("video" as const) : ("image" as const), label: referenceAliases.get(item.id), status: "ready" as const })),
        ...uploads.filter((item) => !item.nodeId || !readyReferenceIds.includes(item.nodeId)),
    ];
    const messageScrollKey = messages.map((item) => `${item.id}:${item.text.length}`).join("|") + `:${isRunning}:${runStage.key}`;
    const { scrollRef, showLatestButton, requestLatest, scrollToLatest, handleScroll } = useCanvasAgentMessageScroll(view === "chat", messageScrollKey, messages.length ? "latest" : "top");
    const selectedSkill = skills.find((skill) => skill.id === selectedSkillId);
    const selectedModels = models.filter((model) => selectedModelIds.includes(model.id));
    const iconButtonStyle = { color: theme.node.muted };
    const controlTheme = { panel: theme.toolbar.panel, border: theme.node.stroke, text: theme.node.text, muted: theme.node.muted, activeBackground: theme.toolbar.activeBg, activeText: theme.toolbar.activeText };

    useEffect(() => {
        setRemovedReferenceIds(new Set());
    }, [selectedNodeKey]);

    useEffect(() => {
        const previousIds = previousMediaReferenceIdsRef.current;
        const nextIds = selectedMediaReferenceIds;
        if (previousIds.join("|") !== nextIds.join("|")) {
            setPrompt((current) => remapCanvasAgentReferences(current, mentionAssets, previousIds, nextIds));
            previousMediaReferenceIdsRef.current = nextIds;
        }
    }, [mentionAssets, selectedMediaReferenceIds]);

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        const nextSessions = localSessionsRef.current.map((session) => (session.id === sessionId ? updater(session) : session));
        commitSessionState(nextSessions, localActiveSessionIdRef.current);
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };

    const upsertMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => {
            const exists = session.messages.some((item) => item.id === message.id);
            return {
                ...session,
                title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
                messages: exists ? session.messages.map((item) => (item.id === message.id ? { ...item, ...message } : item)) : [...session.messages, message],
                updatedAt: new Date().toISOString(),
            };
        });
    };

    const bindSessionRun = useCallback((sessionId: string, run: CanvasAssistantRunState) => {
        setRunStatesBySession((current) => setCanvasAssistantRun(current, sessionId, run));
    }, []);

    const updateSessionRun = useCallback((sessionId: string, runId: string, patch: Partial<CanvasAssistantRunState>) => {
        setRunStatesBySession((current) => patchCanvasAssistantRun(current, sessionId, runId, patch));
    }, []);

    const releaseSessionRun = useCallback((sessionId: string, identity: string) => {
        setRunStatesBySession((current) => clearCanvasAssistantRun(current, sessionId, identity));
    }, []);

    const startChatSession = () => {
        requestLatest();
        setSelectedSkillId(undefined);
        setSelectedModelIds([]);
        setSmartPlanning(true);
        if (activeSession && activeSession.messages.length === 0) {
            commitSessionState(localSessionsRef.current, activeSession.id);
            return;
        }
        const session = createSession();
        commitSessionState([session, ...localSessionsRef.current], session.id);
    };

    const removeSessions = async (ids: string[]) => {
        const runningIds = ids.filter((id) => runStatesBySession[id]);
        if (runningIds.length) message.warning("运行中的对话需先取消任务再删除");
        const removableIds = ids.filter((id) => !runStatesBySession[id]);
        if (!removableIds.length) return false;
        const currentSessions = localSessionsRef.current;
        const removableSessions = currentSessions.filter((session) => removableIds.includes(session.id));
        const conversationIds = removableSessions.filter((session) => session.conversationId).map((session) => session.conversationId!);
        let persistedState: Awaited<ReturnType<typeof deleteCanvasAssistantConversations>> | undefined;
        try {
            if (conversationIds.length) persistedState = await deleteCanvasAssistantConversations(snapshotRef.current.projectId, conversationIds);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "Agent 对话删除失败");
            return false;
        }
        const removedActiveSession = Boolean(activeSession && removableIds.includes(activeSession.id));
        let next = removeCanvasAssistantSessions(currentSessions, localActiveSessionIdRef.current, removableIds);
        const removedLocalOnlySession = removableSessions.some((session) => !session.conversationId);
        const createdLocalReplacement = next.sessions.length === 1 && !currentSessions.some((session) => session.id === next.sessions[0].id);
        if (persistedState && createdLocalReplacement && !removedLocalOnlySession && persistedState.chatSessions.length) {
            next = { sessions: persistedState.chatSessions, activeSessionId: persistedState.activeChatId || persistedState.chatSessions[0].id };
        }
        commitSessionState(next.sessions, next.activeSessionId);
        if (removedActiveSession || removableIds.length >= currentSessions.length) {
            setView("chat");
            requestLatest();
        }
        return true;
    };

    const clearSessions = () => {
        return removeSessions(localSessionsRef.current.map((session) => session.id));
    };

    const renameSession = async (id: string, title: string) => {
        const session = localSessionsRef.current.find((item) => item.id === id);
        if (!session) return;
        try {
            if (session.conversationId) await updateCreativeConversation(session.conversationId, { title });
            updateSession(id, (current) => ({ ...current, title, updatedAt: new Date().toISOString() }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "对话标题修改失败");
        }
    };

    const sendMessage = async (text: string, savedReferences?: CanvasAssistantReference[]) => {
        const session = activeSession || createSession();
        if (!activeSession) {
            commitSessionState([session], session.id);
        }

        const refs = savedReferences || selectedReferences;
        const submittedReferenceIds = new Set(refs.map((item) => item.id));
        const runSnapshot = compactSnapshot(snapshotRef.current);
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text, references: refs };
        const assistantId = nanoid();
        const planningStage = { key: "planning" as const, text: "正在理解你的需求" };
        requestLatest();
        appendMessage(session.id, userMessage);
        if (submittedReferenceIds.size) {
            setRemovedReferenceIds((current) => new Set([...current, ...submittedReferenceIds]));
            onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((id) => !submittedReferenceIds.has(id))));
        }
        upsertMessage(session.id, { id: assistantId, role: "assistant", text: submittedReferenceIds.size ? "收到，我会基于当前选中素材处理这次创作需求。" : "收到，我会结合当前画布处理这次创作需求。" });
        bindSessionRun(session.id, { assistantMessageId: assistantId, paused: false, stage: planningStage });
        let createdRunId = "";
        try {
            const payload = await createCreativeAgentRun({
                clientRequestId: nanoid(),
                surface: "canvas",
                conversationId: session.conversationId,
                projectId: snapshotRef.current.projectId,
                prompt: text,
                snapshot: { ...runSnapshot, selectedNodeIds: canvasRunSelectedNodeIds(snapshotRef.current, submittedReferenceIds) },
                assetIds: [],
                skillIds: selectedSkillId ? [selectedSkillId] : [],
                modelIds: smartPlanning ? [] : selectedModelIds,
                preferences: generationPreferences.mode ? generationPreferences : undefined,
            });
            const run = payload.run;
            createdRunId = run.id;
            restoredRunIdsRef.current.add(run.id);
            updateSession(session.id, (current) => ({ ...current, conversationId: run.conversationId }));
            upsertMessage(session.id, { id: assistantId, runId: run.id, role: "assistant", text: submittedReferenceIds.size ? "收到，我会基于当前选中素材处理这次创作需求。" : "收到，我会结合当前画布处理这次创作需求。" });
            bindSessionRun(session.id, { runId: run.id, assistantMessageId: assistantId, paused: false, stage: planningStage });
            setSelectedSkillId(undefined);
            await waitForBackendAgent(run.id, session.id, assistantId);
        } catch (error) {
            if (createdRunId) {
                upsertMessage(session.id, { id: assistantId, runId: createdRunId, role: "assistant", text: "实时连接暂时不可用，任务仍会在后台继续运行。" });
                updateSessionRun(session.id, createdRunId, { stage: { key: "reconnecting", resumeKey: "planning", text: "实时连接暂时不可用，任务仍在后台运行" } });
            } else {
                upsertMessage(session.id, { id: assistantId, role: "error", title: "Agent 执行失败", text: friendlyAgentError(error) });
                releaseSessionRun(session.id, assistantId);
            }
        }
    };

    const waitForBackendAgent = async (runId: string, sessionId: string, assistantId: string, retryTaskId?: string, replaceFirstFailure = false) => {
        await withCanvasAgentRunWatch(watchingRunIdsRef.current, runId, async () => {
            const controller = new AbortController();
            runWatchControllersRef.current.set(runId, controller);
            try {
                await watchCanvasAgentRun(
                    runId,
                    {
                        onPlan: (ops, reply) => {
                            onApplyOps(ops);
                            upsertMessage(sessionId, { id: assistantId, role: "assistant", text: reply });
                        },
                        onAssistant: (text, detail) => {
                            if (detail?.runId && detail.taskId) {
                                const replace = detail.taskId === retryTaskId || (replaceFirstFailure && !retryTaskId);
                                const failure = { id: replace ? assistantId : nanoid(), role: "error" as const, title: detail.title || "创作任务失败", text, detail };
                                if (replace) upsertMessage(sessionId, failure);
                                else appendMessage(sessionId, failure);
                                return;
                            }
                            upsertMessage(sessionId, { id: assistantId, role: detail?.runId ? "error" : "assistant", title: detail?.title, text, ...(detail?.nodeIds?.length || detail?.runId ? { detail } : {}) });
                        },
                        onStage: (stage) => updateSessionRun(sessionId, runId, { stage }),
                        onPaused: (paused) => updateSessionRun(sessionId, runId, { paused }),
                        onOps: onApplyOps,
                    },
                    { signal: controller.signal },
                );
            } finally {
                if (runWatchControllersRef.current.get(runId) === controller) runWatchControllersRef.current.delete(runId);
                if (!controller.signal.aborted) {
                    await refreshUserPointsIfSystem("system");
                    releaseSessionRun(sessionId, runId);
                }
            }
        });
    };

    useEffect(() => {
        const projectId = snapshot.projectId;
        if (!projectId || restoredProjectRef.current === projectId) return;
        runWatchControllersRef.current.forEach((controller) => controller.abort());
        runWatchControllersRef.current.clear();
        watchingRunIdsRef.current.clear();
        restoredRunIdsRef.current.clear();
        setRunStatesBySession({});
        restoredProjectRef.current = projectId;
        let cancelled = false;
        void listCreativeAgentRuns("canvas", { activeOnly: true, projectId })
            .then((runs) => {
                if (cancelled) return;
                let nextSessions = localSessionsRef.current;
                const watches: Array<{ runId: string; sessionId: string; assistantId: string }> = [];
                const nextRunStates: CanvasAssistantRunStates = {};
                runs.forEach((run) => {
                    if (restoredRunIdsRef.current.has(run.id)) return;
                    restoredRunIdsRef.current.add(run.id);
                    let session = findCanvasAssistantRunSession(nextSessions, run.id, run.conversationId);
                    let assistantId = session?.messages.find((item) => item.runId === run.id)?.id || [...(session?.messages || [])].reverse().find((item) => item.role === "assistant")?.id;
                    if (!session || !assistantId) {
                        session = { ...createSession(), conversationId: run.conversationId };
                        assistantId = nanoid();
                        session = {
                            ...session,
                            title: "进行中的 Agent 任务",
                            messages: [{ id: assistantId, runId: run.id, role: "assistant", text: "已恢复刷新前仍在执行的 Agent 任务。" }],
                        };
                        nextSessions = [session, ...nextSessions];
                    } else {
                        const restoredSession = {
                            ...session,
                            conversationId: run.conversationId,
                            messages: session.messages.map((item) => (item.id === assistantId ? { ...item, runId: run.id } : item)),
                        };
                        session = restoredSession;
                        nextSessions = nextSessions.map((item) => (item.id === restoredSession.id ? restoredSession : item));
                    }
                    nextRunStates[session.id] = {
                        runId: run.id,
                        assistantMessageId: assistantId,
                        paused: run.status === "paused",
                        stage: run.status === "paused" ? { key: "paused", text: "任务已暂停" } : run.status === "planning" ? { key: "planning", text: "正在理解你的需求" } : { key: "executing", text: "任务仍在后台运行，正在恢复连接" },
                    };
                    watches.push({ runId: run.id, sessionId: session.id, assistantId });
                });
                if (!watches.length) return;
                commitSessionState(nextSessions, localActiveSessionIdRef.current || nextSessions[0]?.id || null);
                setRunStatesBySession((current) => ({ ...current, ...nextRunStates }));
                watches.forEach(({ runId, sessionId, assistantId }) => {
                    void waitForBackendAgent(runId, sessionId, assistantId).catch((error) => appendMessage(sessionId, { id: nanoid(), role: "error", title: "恢复失败", text: friendlyAgentError(error, "Agent 任务恢复失败，请稍后重试。") }));
                });
            })
            .catch((error) => {
                if (!cancelled) message.error(friendlyAgentError(error, "Agent 任务恢复失败，请稍后重试。"));
            });
        return () => {
            cancelled = true;
        };
    }, [message, snapshot.projectId]);

    useEffect(
        () => () => {
            runWatchControllersRef.current.forEach((controller) => controller.abort());
            runWatchControllersRef.current.clear();
            watchingRunIdsRef.current.clear();
        },
        [],
    );

    const submit = async () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        setPrompt("");
        await sendMessage(text);
    };

    const controlRun = async (action: "pause" | "resume" | "cancel") => {
        const session = activeSession;
        const run = activeRunState;
        if (!session || !run?.runId) return;
        try {
            await controlCreativeAgentRun(run.runId, action, session.conversationId);
            if (action === "pause") updateSessionRun(session.id, run.runId, { paused: true, stage: { key: "paused", text: "任务已暂停" } });
            if (action === "resume") updateSessionRun(session.id, run.runId, { paused: false, stage: { key: "executing", text: "任务已恢复，正在继续执行" } });
        } catch (error) {
            appendMessage(session.id, { id: nanoid(), role: "error", title: "控制失败", text: friendlyAgentError(error, "Agent 任务控制失败，请稍后重试。") });
        }
    };

    const retryFailedTask = async (runId: string, taskId: string | undefined, failedMessageId: string) => {
        const session = activeSession || localSessions[0];
        if (!session || runStatesBySession[session.id]) return;
        const assistantId = failedMessageId;
        bindSessionRun(session.id, { runId, assistantMessageId: assistantId, paused: false, stage: { key: "executing", text: "正在重新执行失败任务" } });
        upsertMessage(session.id, { id: assistantId, runId, role: "assistant", title: undefined, text: "正在重新执行失败任务…", detail: undefined });
        try {
            if (taskId) await retryCreativeAgentTask(runId, taskId, session.conversationId);
            else await controlCreativeAgentRun(runId, "retry", session.conversationId);
            await waitForBackendAgent(runId, session.id, assistantId, taskId, !taskId);
        } catch (error) {
            upsertMessage(session.id, { id: assistantId, runId, role: "error", title: "重试失败", text: friendlyAgentError(error, "任务重试失败，请稍后再试。"), detail: { runId, taskId } });
            releaseSessionRun(session.id, runId);
        }
    };

    const toggleModel = (model: CreativeAgentModelOption) => {
        setSelectedModelIds((current) => {
            if (!current.includes(model.id) && current.length >= CREATIVE_RUN_MODEL_LIMIT) {
                message.warning(`一次最多选择 ${CREATIVE_RUN_MODEL_LIMIT} 个模型`);
                return current;
            }
            const next = current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id];
            setSmartPlanning(next.length === 0);
            setGenerationPreferences((preferences) =>
                reconcileCreativeGenerationPreferences(
                    preferences,
                    models.filter((option) => next.includes(option.id)),
                ),
            );
            return next;
        });
    };

    const enableSmartPlanning = () => {
        setSelectedModelIds([]);
        setSmartPlanning(true);
    };

    const changeComposerReferences = (ids: string[]) => {
        previousMediaReferenceIdsRef.current = ids;
        setRemovedReferenceIds((current) => {
            const next = new Set(current);
            selectedMediaReferenceIds.filter((id) => !ids.includes(id)).forEach((id) => next.add(id));
            ids.forEach((id) => next.delete(id));
            return next;
        });
        const mediaIds = new Set(mentionAssets.map((asset) => asset.id));
        onSelectNodeIds(new Set([...Array.from(selectedNodeIds).filter((id) => !mediaIds.has(id)), ...ids]));
    };
    const removeMediaReference = (id: string) => {
        const nextReferenceIds = selectedMediaReferenceIds.filter((nodeId) => nodeId !== id);
        setPrompt((current) => remapCanvasAgentReferences(current, mentionAssets, selectedMediaReferenceIds, nextReferenceIds));
        previousMediaReferenceIdsRef.current = nextReferenceIds;
        setRemovedReferenceIds((current) => new Set(current).add(id));
        if (selectedNodeIds.has(id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== id)));
    };

    const startResize = () => {
        const move = (event: MouseEvent) => setWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        onCollapse();
    };

    const suggestionItems = [
        { icon: <ImagePlus className="size-4" />, title: "生成一套新品发布海报", description: "营造促销氛围，突出产品亮点", prompt: "生成一套新品发布海报，突出产品亮点并保持统一视觉。" },
        { icon: <LayoutPanelTop className="size-4" />, title: "优化当前画布布局", description: "提升对齐与信息效率", prompt: "优化当前画布布局，让层级、间距和信息关系更清晰。" },
        { icon: <PenLine className="size-4" />, title: "撰写一段产品宣传文案", description: "突出卖点，吸引用户", prompt: "为当前画布撰写一段简洁有力的产品宣传文案。" },
        { icon: <WandSparkles className="size-4" />, title: "增强画面质感", description: "提升细节与光影表现", prompt: "增强当前画面的质感、光影和细节表现。" },
        { icon: <Files className="size-4" />, title: "批量替换文案与图片", description: "保持风格一致，批量应用", prompt: "批量替换当前画布中的文案与图片，同时保持整体风格一致。" },
        { icon: <Layers3 className="size-4" />, title: "生成多套设计方案", description: "提供多种风格供选择", prompt: "基于当前画布生成多套设计方案，提供不同风格供我选择。" },
    ];

    const onlineContent = (
        <>
            <AgentPanelTabs
                value={view}
                theme={theme}
                items={[
                    { value: "chat", label: "对话" },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: historySessions.length },
                ]}
                onChange={setView}
                right={
                    <Button
                        type="primary"
                        className="!h-9 !rounded-lg !px-3 !text-xs !font-medium"
                        icon={<Plus className="size-3.5" />}
                        onClick={() => {
                            startChatSession();
                            setView("chat");
                        }}
                        aria-label="新建对话"
                    >
                        新建对话
                    </Button>
                }
            />

            <div className="relative h-0 min-h-0 w-full flex-1 overflow-hidden">
                <div ref={scrollRef} data-canvas-agent-scroll className="thin-scrollbar h-full space-y-4 overflow-y-auto px-4 pb-16 pt-4" onScroll={handleScroll}>
                    {view === "history" ? (
                        <AssistantHistory
                            sessions={historySessions}
                            activeSession={activeSession}
                            onOpen={(id) => {
                                requestLatest();
                                commitSessionState(localSessionsRef.current, id);
                                setView("chat");
                            }}
                            onDelete={(ids) => setDeleteChatIds(ids)}
                            onRename={(id, title) => void renameSession(id, title)}
                        />
                    ) : messages.length ? (
                        <>
                            {messages.map((message) => (
                                <div key={message.id} className="space-y-1">
                                    <AgentChatMessage
                                        item={assistantMessageToChatMessage(message)}
                                        theme={theme}
                                        user={user}
                                        onLocateNode={onLocateNode}
                                        onRetryTask={(runId, taskId) => void retryFailedTask(runId, taskId, message.id)}
                                        onEditMessage={() => {
                                            setPrompt(message.text);
                                            setRemovedReferenceIds(new Set());
                                            onSelectNodeIds(new Set((message.references || []).map((item) => item.id).filter((id) => nodes.some((node) => node.id === id))));
                                        }}
                                    />
                                </div>
                            ))}
                            {isRunning ? (
                                <>
                                    <AgentWorkingMessage theme={theme} stage={runStage} />
                                    <div className="flex justify-end gap-2">
                                        <Button size="small" icon={runPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={() => void controlRun(runPaused ? "resume" : "pause")}>
                                            {runPaused ? "继续" : "暂停"}
                                        </Button>
                                        <Button size="small" danger icon={<Square className="size-3.5" />} onClick={() => void controlRun("cancel")}>
                                            取消
                                        </Button>
                                    </div>
                                </>
                            ) : null}
                        </>
                    ) : (
                        <div className="canvas-agent-empty space-y-5 pb-4">
                            <section data-canvas-agent-welcome className="grid min-w-0 grid-cols-[minmax(0,1fr)_64px] items-center gap-3 rounded-2xl border px-4 py-4" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                                <div className="min-w-0">
                                    <h2 className="text-base font-semibold leading-6" style={{ color: theme.node.text }}>
                                        你好，我是你的画布助手
                                    </h2>
                                    <p className="mt-2 text-xs leading-5" style={{ color: theme.node.muted }}>
                                        我可以帮你生成图像、优化布局、撰写文案、梳理思路、提取关键信息，让创意更高效实现。
                                    </p>
                                    <button
                                        type="button"
                                        className="mt-3 inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition hover:opacity-90"
                                        style={{ background: theme.node.action, color: theme.node.actionText }}
                                        onClick={() => setPrompt("请介绍一下你能如何协助我完成当前画布。")}
                                    >
                                        了解 Agent 能做什么 <ArrowRight className="size-3.5 shrink-0" />
                                    </button>
                                </div>
                                <div className="pointer-events-none grid size-16 place-items-center rounded-2xl border" style={{ borderColor: theme.node.stroke, color: theme.node.muted }} aria-hidden="true">
                                    <Sparkles className="size-8" />
                                </div>
                            </section>
                            <section data-canvas-agent-suggestions>
                                <div className="mb-2.5 flex items-center justify-between">
                                    <h3 className="text-xs font-semibold" style={{ color: theme.node.text }}>
                                        你可以试试
                                    </h3>
                                    <span className="grid size-7 place-items-center" style={{ color: theme.node.muted }} aria-hidden="true">
                                        <Sparkles className="size-3.5" />
                                    </span>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    {suggestionItems.map((item) => (
                                        <button
                                            key={item.title}
                                            type="button"
                                            className="group min-w-0 rounded-xl border px-3 py-3 text-left transition hover:-translate-y-px hover:shadow-sm"
                                            style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}
                                            onClick={() => setPrompt(item.prompt)}
                                        >
                                            <span className="grid size-7 place-items-center rounded-lg border" style={{ color: theme.node.muted, borderColor: theme.node.stroke }}>
                                                {item.icon}
                                            </span>
                                            <span className="mt-2 block truncate text-[11px] font-medium" style={{ color: theme.node.text }}>
                                                {item.title}
                                            </span>
                                            <span className="mt-1 block truncate text-[10px]" style={{ color: theme.node.muted }}>
                                                {item.description}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        </div>
                    )}
                </div>
                {view === "chat" && showLatestButton ? (
                    <Tooltip title="回到最新消息">
                        <Button
                            type="default"
                            shape="circle"
                            className="absolute bottom-10 left-1/2 z-10 !h-8 !w-8 !min-w-8 -translate-x-1/2 shadow-sm"
                            style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                            icon={<ArrowDown className="size-3.5" />}
                            onClick={scrollToLatest}
                            aria-label="回到最新消息"
                        />
                    </Tooltip>
                ) : null}
            </div>

            {view === "chat" ? (
                <>
                    {selectedTextReferences.length ? (
                        <div className="thin-scrollbar flex max-w-full gap-1.5 overflow-x-auto px-3 pb-1">
                            {selectedTextReferences.map((item) => (
                                <AssistantReferenceChip
                                    key={item.id}
                                    item={item}
                                    onRemove={() => {
                                        setRemovedReferenceIds((prev) => new Set(prev).add(item.id));
                                        if (selectedNodeIds.has(item.id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== item.id)));
                                    }}
                                />
                            ))}
                        </div>
                    ) : null}
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={composerAttachments}
                        mentionAssets={mentionAssets}
                        selectedReferenceIds={selectedMediaReferenceIds}
                        sending={isRunning}
                        placeholder="描述你想让 Agent 如何操作画布"
                        theme={theme}
                        onPromptChange={setPrompt}
                        onSubmit={submit}
                        onAddFiles={addFiles}
                        onRetryAttachment={retryUpload}
                        onRemoveAttachment={(id) => {
                            const reference = selectedMediaReferences.find((item) => item.id === id);
                            if (!reference) return removeUpload(id);
                            removeMediaReference(id);
                        }}
                        onReferenceIdsChange={changeComposerReferences}
                        beforeInput={selectedSkill ? <CreativeAgentSkillCard skill={selectedSkill} onRemove={() => setSelectedSkillId(undefined)} theme={controlTheme} className="pb-1" /> : null}
                        left={
                            <CreativeAgentControls
                                compact
                                skills={skills}
                                skillsLoading={skillsLoading}
                                selectedSkill={selectedSkill}
                                models={models}
                                selectedModels={selectedModels}
                                smartPlanning={smartPlanning}
                                middle={<CanvasAgentGenerationSettings preferences={generationPreferences} models={selectedModels} onChange={setGenerationPreferences} />}
                                onSelectSkill={(skill) => setSelectedSkillId(skill.id)}
                                onToggleModel={toggleModel}
                                onClearModels={enableSmartPlanning}
                                onSmartPlanningChange={(enabled) => (enabled ? enableSmartPlanning() : setSmartPlanning(false))}
                                theme={controlTheme}
                            />
                        }
                    />
                </>
            ) : null}

            <Modal
                title="删除对话记录？"
                open={deleteChatIds.length > 0}
                centered
                onCancel={() => setDeleteChatIds([])}
                footer={
                    <>
                        <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                        <Button
                            danger
                            type="primary"
                            loading={deletingChats}
                            onClick={async () => {
                                setDeletingChats(true);
                                try {
                                    const removed = deleteChatIds.length === historySessions.length ? await clearSessions() : await removeSessions(deleteChatIds);
                                    if (removed) setDeleteChatIds([]);
                                } finally {
                                    setDeletingChats(false);
                                }
                            }}
                        >
                            删除
                        </Button>
                    </>
                }
            >
                <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销。</p>
            </Modal>
        </>
    );

    return (
        <motion.div
            className="canvas-agent-panel-frame flex shrink-0"
            initial={false}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="canvas-agent-panel relative flex shrink-0 flex-col border-l"
                aria-label="Canvas Agent 对话面板"
                initial={false}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="canvas-agent-resize-handle absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
                <header className="flex h-16 items-center justify-between border-b px-4" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="grid size-8 place-items-center rounded-lg" style={{ color: theme.toolbar.item, background: theme.toolbar.itemHover }}>
                            <Bot className="size-4" />
                        </span>
                        <div className="min-w-0">
                            <div className="text-base font-semibold leading-5">Agent</div>
                            <div className="truncate text-xs" style={{ color: theme.node.muted }}>
                                画布助手 · 让创意落地更简单
                            </div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<PanelRightClose className="size-4" />} onClick={collapse} aria-label="收起 Agent 面板" />
                        </Tooltip>
                    </div>
                </header>
                {onlineContent}
            </motion.aside>
        </motion.div>
    );
}
