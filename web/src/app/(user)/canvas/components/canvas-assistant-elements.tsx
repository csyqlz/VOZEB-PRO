"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Bot, History, PanelRightClose, Pause, Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";
import { motion } from "motion/react";

import { modelOptionLabel, modelOptionName, selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { refreshUserPointsIfSystem } from "@/services/api/points";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { serverMediaUrl } from "@/services/server-media-storage";
import { DiaTextReveal } from "@/components/ui/dia-text-reveal";
import { ModelIcon } from "@/components/model-picker";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { watchCanvasAgentRun } from "./canvas-agent-run-client";
import type { CanvasAgentRunStage } from "./canvas-agent-progress";
import { formatAgentMessageText, friendlyAgentError } from "@/components/agent/agent-message-format";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentWorkingMessage, type CanvasAgentChatMessage } from "./canvas-agent-chat-ui";
import { CANVAS_AGENT_PANEL_MOTION_MS } from "./canvas-agent-panel-motion";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasNodeData } from "../types";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "../utils/canvas-agent-ops";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;
export function AgentTextModelPicker({ config, value, onChange }: { config: AiConfig; value: string; onChange: (model: string) => void }) {
    const options = useMemo(() => Array.from(new Set([value, ...selectableModelsByCapability(config, "text")].filter(Boolean))), [config, value]);
    const current = value || "";
    return (
        <Select value={current} onValueChange={onChange}>
            <SelectTrigger
                hideChevron
                className="h-7 min-w-0 max-w-[220px] gap-1.5 border-0 bg-transparent px-1 py-0 text-xs font-normal shadow-none hover:bg-transparent hover:opacity-75 focus-visible:border-transparent focus-visible:ring-0 data-[state=open]:ring-0 dark:bg-transparent dark:hover:bg-transparent"
                title={current ? modelOptionLabel(config, current) : "选择文本模型"}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <ModelIcon model={current} />
                <span className="min-w-0 truncate">{current ? modelOptionName(current) : "选择文本模型"}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-72 max-w-[calc(100vw-24px)]"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((model) => (
                        <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                            <span className="flex min-w-0 items-center gap-2">
                                <ModelIcon model={model} />
                                <span className="min-w-0 flex-1 truncate">{modelOptionName(model)}</span>
                            </span>
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty_text_model__" disabled>
                        暂无文本模型
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

export function AssistantHistory({
    sessions,
    activeSession,
    onOpen,
    onDelete,
    onRename,
}: {
    sessions: CanvasAssistantSession[];
    activeSession: CanvasAssistantSession | null;
    onOpen: (id: string) => void;
    onDelete: (ids: string[]) => void;
    onRename: (id: string, title: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [titleDraft, setTitleDraft] = useState("");
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const sessionIdsKey = sessions.map((session) => session.id).join("|");
    const sessionIds = useMemo(() => new Set(sessionIdsKey.split("|").filter(Boolean)), [sessionIdsKey]);
    const allSelected = sessions.length > 0 && selectedIds.length === sessions.length;

    useEffect(() => {
        setSelectedIds((current) => current.filter((id) => sessionIds.has(id)));
        if (editingId && !sessionIds.has(editingId)) setEditingId(null);
    }, [editingId, sessionIds]);

    const startRename = (session: CanvasAssistantSession) => {
        setEditingId(session.id);
        setTitleDraft(session.title);
    };

    const finishRename = () => {
        if (!editingId) return;
        const title = titleDraft.trim();
        if (title) onRename(editingId, title);
        setEditingId(null);
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <div className="text-sm font-semibold" style={{ color: theme.node.text }}>
                        历史对话
                    </div>
                    <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>
                        {sessions.length ? `${sessions.length} 条记录` : "暂无历史"}
                    </div>
                </div>
                {sessions.length ? (
                    <div className="flex items-center gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                            <input type="checkbox" checked={allSelected} onChange={(event) => setSelectedIds(event.target.checked ? sessions.map((session) => session.id) : [])} className="size-3.5 accent-current" aria-label="全选历史对话" />
                            全选
                        </label>
                        {selectedIds.length ? (
                            <button
                                type="button"
                                className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition hover:opacity-80"
                                style={{ color: theme.node.danger, background: theme.node.dangerSurface }}
                                onClick={() => onDelete(selectedIds)}
                            >
                                <Trash2 className="size-3.5" />
                                删除所选 ({selectedIds.length})
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>
            {sessions.map((session) => (
                <div
                    key={session.id}
                    className="rounded-xl border px-3 py-2.5 transition"
                    style={{ borderColor: session.id === activeSession?.id ? theme.node.activeStroke : theme.node.stroke, background: session.id === activeSession?.id ? theme.node.fill : theme.toolbar.panel, color: theme.node.text }}
                >
                    <div className="flex min-w-0 items-center gap-2.5">
                        <input
                            type="checkbox"
                            checked={selectedSet.has(session.id)}
                            onChange={(event) => setSelectedIds((current) => (event.target.checked ? [...current, session.id] : current.filter((id) => id !== session.id)))}
                            className="size-4 shrink-0 accent-current"
                            aria-label={`选择对话：${session.title}`}
                        />
                        <div className="min-w-0 flex-1">
                            {editingId === session.id ? (
                                <input
                                    autoFocus
                                    value={titleDraft}
                                    onChange={(event) => setTitleDraft(event.target.value)}
                                    onBlur={finishRename}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") finishRename();
                                        if (event.key === "Escape") setEditingId(null);
                                    }}
                                    className="w-full rounded-md border bg-transparent px-1.5 py-1 text-sm font-semibold outline-none"
                                    style={{ borderColor: theme.node.activeStroke, color: theme.node.text }}
                                    aria-label="编辑对话标题"
                                />
                            ) : (
                                <button type="button" className="block w-full truncate text-left text-sm font-semibold leading-7" onDoubleClick={() => startRename(session)} title="双击修改标题">
                                    {session.title}
                                </button>
                            )}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                            <Tooltip title="修改标题">
                                <Button type="text" size="small" className="!h-7 !w-7 !min-w-7" icon={<Pencil className="size-3.5" />} onClick={() => startRename(session)} aria-label={`修改标题：${session.title}`} />
                            </Tooltip>
                            <Tooltip title="进入对话">
                                <Button type="text" size="small" className="!h-7 !w-7 !min-w-7" icon={<ArrowRight className="size-3.5" />} onClick={() => onOpen(session.id)} aria-label={`进入对话：${session.title}`} />
                            </Tooltip>
                            <Tooltip title="删除记录">
                                <Button size="small" danger type="text" className="!h-7 !w-7 !min-w-7" icon={<Trash2 className="size-3.5" />} onClick={() => onDelete([session.id])} aria-label={`删除对话：${session.title}`} />
                            </Tooltip>
                        </div>
                    </div>
                </div>
            ))}
            {!sessions.length ? (
                <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                    网站 Agent 的对话记录会显示在这里
                </div>
            ) : null}
        </div>
    );
}

export function AssistantReferenceChip({ item, label, onRemove }: { item: CanvasAssistantReference; label?: string; onRemove?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const text = (item.text || item.title).replace(/\s+/g, " ").trim().slice(0, 1) || "文";
    return (
        <div className="group/chip relative inline-flex h-8 max-w-[150px] shrink-0 items-center gap-1.5 rounded-lg text-sm" style={{ color: theme.node.text }}>
            {item.dataUrl ? (
                <span className="relative block size-8 shrink-0">
                    <img src={imagePreviewUrl(item.dataUrl, 96)} alt="" className="size-8 rounded-lg object-cover" />
                    {label ? <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-medium leading-none text-white">{label}</span> : null}
                </span>
            ) : (
                <span className="grid size-8 place-items-center rounded-lg border text-sm font-medium" style={{ background: theme.node.panel, borderColor: theme.node.activeStroke }}>
                    {text}
                </span>
            )}
            {onRemove ? (
                <button
                    type="button"
                    className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover/chip:opacity-100"
                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}
                    onClick={onRemove}
                    aria-label="移除引用"
                >
                    <X className="size-3" />
                </button>
            ) : null}
        </div>
    );
}

export function assistantImageReferenceLabel(references: CanvasAssistantReference[], index: number) {
    if (!references[index]?.dataUrl) return undefined;
    const imageIndex = references.slice(0, index + 1).filter((item) => item.dataUrl).length - 1;
    return imageIndex >= 0 ? imageReferenceLabel(imageIndex) : undefined;
}

export function assistantMessageToChatMessage(message: CanvasAssistantMessage): CanvasAgentChatMessage {
    const attachments = message.references?.flatMap((item) => (item.dataUrl ? [{ id: item.id, name: item.title, url: item.dataUrl, type: item.type === CanvasNodeType.Video ? ("video" as const) : ("image" as const) }] : []));
    return {
        id: message.id,
        role: message.role,
        title: message.title,
        text: message.role === "error" ? friendlyAgentError(message.text) : formatAgentMessageText(message.text),
        meta: message.meta,
        detail: message.detail,
        ...(attachments?.length ? { attachments } : {}),
    };
}

export function nodeToReference(node: CanvasNodeData): CanvasAssistantReference | null {
    const mediaUrl = [node.metadata?.content, node.metadata?.serverUrl, node.metadata?.remoteUrl].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if ((isCanvasImageNodeType(node.type) || node.type === CanvasNodeType.Video) && mediaUrl) {
        return { id: node.id, type: node.type, title: node.title, dataUrl: mediaUrl, storageKey: node.metadata?.storageKey };
    }
    if (node.type === CanvasNodeType.Text && node.metadata?.content) {
        return { id: node.id, type: node.type, title: node.title, text: node.metadata.content };
    }
    return null;
}

export function buildAssistantReferences(nodes: CanvasNodeData[], selectedNodeIds: Set<string>) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return Array.from(selectedNodeIds)
        .map((id) => nodeById.get(id))
        .filter((node): node is CanvasNodeData => Boolean(node))
        .map(nodeToReference)
        .filter((item): item is CanvasAssistantReference => Boolean(item));
}

export function compactSnapshot(snapshot: CanvasAgentSnapshot) {
    const selected = new Set(snapshot.selectedNodeIds);
    const connections = selected.size ? snapshot.connections.filter((connection) => selected.has(connection.fromNodeId) || selected.has(connection.toNodeId)) : snapshot.connections;
    if (selected.size) {
        connections.forEach((connection) => {
            selected.add(connection.fromNodeId);
            selected.add(connection.toNodeId);
        });
    }
    return {
        title: snapshot.title,
        imageSize: snapshot.imageSize,
        selectedNodeIds: snapshot.selectedNodeIds,
        nodes: snapshot.nodes
            .filter((node) => !selected.size || selected.has(node.id) || node.type === CanvasNodeType.Config)
            .map((node) => ({
                id: node.id,
                type: node.type,
                title: node.title,
                width: node.width,
                height: node.height,
                metadata: compactMetadata(node.type, node.metadata || {}),
            })),
        connections,
    };
}

export function canvasRunSelectedNodeIds(snapshot: CanvasAgentSnapshot, submittedReferenceIds: Set<string>) {
    const mediaNodeIds = new Set(snapshot.nodes.filter((node) => isCanvasImageNodeType(node.type) || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio).map((node) => node.id));
    return Array.from(new Set([...snapshot.selectedNodeIds.filter((id) => !mediaNodeIds.has(id)), ...submittedReferenceIds]));
}

export function compactMetadata(type: CanvasNodeType, metadata: CanvasNodeData["metadata"]) {
    const content = compactNodeContent(type, metadata);
    const fallbackUrl = [metadata?.serverUrl, metadata?.content, metadata?.remoteUrl].find((value) => typeof value === "string" && value && !value.startsWith("data:") && !value.startsWith("blob:"));
    const mediaUrl = serverMediaUrl(metadata?.storageKey, fallbackUrl || "");
    return {
        content: content || undefined,
        size: metadata?.size,
        naturalWidth: metadata?.naturalWidth,
        naturalHeight: metadata?.naturalHeight,
        url: isStableCanvasMediaUrl(mediaUrl) ? mediaUrl : undefined,
    };
}

function compactNodeContent(type: CanvasNodeType, metadata: CanvasNodeData["metadata"]) {
    const values =
        type === CanvasNodeType.Config
            ? [metadata?.composerContent, metadata?.prompt, metadata?.content]
            : isCanvasImageNodeType(type) || type === CanvasNodeType.Video || type === CanvasNodeType.Audio
              ? [metadata?.prompt, metadata?.composerContent]
              : [metadata?.content, metadata?.prompt, metadata?.composerContent];
    return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isStableCanvasMediaUrl(value: string) {
    return value.startsWith("/api/reference-assets/") || value.startsWith("/api/generation-log-assets/");
}

export function createSession(): CanvasAssistantSession {
    const now = new Date().toISOString();
    return { id: nanoid(), title: "新对话", messages: [], createdAt: now, updatedAt: now };
}

export function removeCanvasAssistantSessions(sessions: CanvasAssistantSession[], activeSessionId: string | null, removedIds: Iterable<string>) {
    const removed = new Set(removedIds);
    const remaining = sessions.filter((session) => !removed.has(session.id));
    if (!remaining.length) {
        const session = createSession();
        return { sessions: [session], activeSessionId: session.id };
    }
    const nextActiveId = activeSessionId && !removed.has(activeSessionId) && remaining.some((session) => session.id === activeSessionId) ? activeSessionId : remaining[0].id;
    return { sessions: remaining, activeSessionId: nextActiveId };
}
