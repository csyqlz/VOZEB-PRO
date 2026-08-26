import { nanoid } from "nanoid";

import type { CanvasProject, CanvasProjectMutation, CanvasProjectSaveAck, CreateCanvasProjectInput } from "@/lib/canvas-project-contract";
import { createCanvasProject, CanvasProjectStoreError, getCanvasProject, listCanvasProjectSummaries, updateCanvasProject, updateCanvasProjectMutationPatch } from "@/lib/server/canvas-project-store";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";
import { createCreativeConversation } from "@/lib/server/creative-runtime-store";
import { CreativeEntityDeletionConflict, deleteCanvasAssistantConversationAggregates, deleteCanvasProjectAggregates } from "@/lib/server/creative-entity-deletion-store";

const MAX_PROJECT_BYTES = 5 * 1024 * 1024;

export class CanvasProjectServiceError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export function listCanvasProjectsForUser(userId: string, input: { page?: unknown; pageSize?: unknown } = {}) {
    return listCanvasProjectSummaries(userId, {
        page: positiveInteger(input.page, 1, 1_000_000),
        pageSize: positiveInteger(input.pageSize, 12, 100),
    });
}

export async function getCanvasProjectForUser(userId: string, id: string) {
    const project = await getCanvasProject(text(id, 160), userId);
    if (!project) throw new CanvasProjectServiceError("画布项目不存在", 404);
    return project;
}

export async function createCanvasProjectForUser(userId: string, value: unknown) {
    const input = object(value) as CreateCanvasProjectInput;
    const source = object(input.project);
    const sourceHandoffId = text(input.sourceHandoffId || source.sourceHandoffId, 160);
    const id = sourceHandoffId ? `canvas-${sourceHandoffId}` : `canvas-${nanoid()}`;
    if (sourceHandoffId) {
        const existing = await getCanvasProject(id, userId);
        if (existing) return existing;
    }
    const title = text(input.title || source.title, 120) || "未命名画布";
    const now = new Date().toISOString();
    const conversation = await createCreativeConversation(userId, { surface: "canvas", projectId: id, title });
    const project = normalizeProject(source, {
        id,
        sourceHandoffId: sourceHandoffId || undefined,
        creativeConversationId: conversation.id,
        title,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    });
    try {
        return await createCanvasProject(userId, project);
    } catch (error) {
        await deleteCanvasProjectAggregates(userId, [id]).catch(() => null);
        throw error;
    }
}

export async function updateCanvasProjectForUser(userId: string, id: string, value: unknown) {
    const input = object(value);
    const mutation = object(input.mutation);
    if (Object.keys(mutation).length) return updateCanvasProjectMutationForUser(userId, id, mutation);
    const expectedUpdatedAt = isoTimestamp(input.expectedUpdatedAt);
    if (!expectedUpdatedAt) throw new CanvasProjectServiceError("缺少画布项目版本，请刷新后重试", 400);
    const current = await getCanvasProject(text(id, 160), userId);
    if (!current) throw new CanvasProjectServiceError("画布项目不存在", 404);
    const project = normalizeProject(object(input.project), current);
    return updateCanvasProject(userId, project, expectedUpdatedAt);
}

async function updateCanvasProjectMutationForUser(userId: string, id: string, input: Record<string, unknown>): Promise<CanvasProjectSaveAck> {
    const mutationId = text(input.mutationId, 160);
    const baseUpdatedAt = isoTimestamp(input.baseUpdatedAt);
    if (!mutationId || !baseUpdatedAt) throw new CanvasProjectServiceError("缺少画布项目版本或操作标识，请刷新后重试", 400);
    const mutation = normalizeMutation(input, mutationId, baseUpdatedAt);
    return updateCanvasProjectMutationPatch(userId, text(id, 160), mutation);
}

export async function deleteCanvasProjectsForUser(userId: string, value: unknown) {
    const ids = Array.isArray(value) ? value.map((id) => text(id, 160)).filter(Boolean) : [];
    const result = await deleteCanvasProjectAggregates(userId, ids);
    await deleteUserMediaAssetsCascade(userId, result.mediaStorageKeys);
    return result.deletedProjects;
}

export async function deleteCanvasAssistantConversationsForUser(userId: string, projectId: string, value: unknown) {
    const ids = normalizeEntityDeletes(Array.isArray(value) ? value : []);
    const project = await getCanvasProjectForUser(userId, projectId);
    if (!ids.length) return { deleted: 0, chatSessions: project.chatSessions, activeChatId: project.activeChatId };
    let result: Awaited<ReturnType<typeof deleteCanvasAssistantConversationAggregates>>;
    try {
        result = await deleteCanvasAssistantConversationAggregates(userId, projectId, ids);
    } catch (error) {
        if (error instanceof CreativeEntityDeletionConflict) throw new CanvasProjectServiceError(error.message, 409);
        throw error;
    }
    await deleteUserMediaAssetsCascade(userId, result.mediaStorageKeys);
    return { deleted: result.deletedConversations, chatSessions: result.canvasAssistantState?.chatSessions || [], activeChatId: result.canvasAssistantState?.activeChatId || null };
}

function normalizeProject(value: Record<string, unknown>, current: CanvasProject): CanvasProject {
    const sanitized = sanitizeProjectPayload(value);
    const nodes = Array.isArray(sanitized.nodes) ? sanitized.nodes : current.nodes;
    const connections = Array.isArray(sanitized.connections) ? sanitized.connections : current.connections;
    const chatSessions = Array.isArray(sanitized.chatSessions) ? sanitized.chatSessions : current.chatSessions;
    return {
        ...current,
        title: text(sanitized.title, 120) || current.title,
        nodes: nodes as CanvasProject["nodes"],
        connections: connections as CanvasProject["connections"],
        chatSessions: chatSessions as CanvasProject["chatSessions"],
        activeChatId: typeof sanitized.activeChatId === "string" ? sanitized.activeChatId.slice(0, 160) : sanitized.activeChatId === null ? null : current.activeChatId,
        backgroundMode: sanitized.backgroundMode === "dots" || sanitized.backgroundMode === "blank" ? sanitized.backgroundMode : "lines",
        showImageInfo: sanitized.showImageInfo === true,
        viewport: normalizeViewport(sanitized.viewport, current.viewport),
        createdAt: current.createdAt,
        updatedAt: nextProjectVersion(current.updatedAt),
        id: current.id,
        sourceHandoffId: current.sourceHandoffId,
        creativeConversationId: current.creativeConversationId,
    };
}

function normalizeMutation(input: Record<string, unknown>, mutationId: string, baseUpdatedAt: string): CanvasProjectMutation {
    const sanitized = sanitizeProjectPayload(input);
    const mutation: CanvasProjectMutation = { mutationId, baseUpdatedAt };
    const title = text(sanitized.title, 120);
    const creativeConversationId = text(sanitized.creativeConversationId, 160);
    if (title) mutation.title = title;
    if (creativeConversationId) mutation.creativeConversationId = creativeConversationId;
    if (typeof sanitized.activeChatId === "string" || sanitized.activeChatId === null) mutation.activeChatId = sanitized.activeChatId === null ? null : text(sanitized.activeChatId, 160);
    if (sanitized.backgroundMode === "dots" || sanitized.backgroundMode === "lines" || sanitized.backgroundMode === "blank") mutation.backgroundMode = sanitized.backgroundMode;
    if (typeof sanitized.showImageInfo === "boolean") mutation.showImageInfo = sanitized.showImageInfo;
    const viewport = normalizeMutationViewport(sanitized.viewport);
    if (viewport) mutation.viewport = viewport;
    if (Array.isArray(sanitized.nodeUpserts)) mutation.nodeUpserts = normalizeEntityUpserts<CanvasProject["nodes"][number]>(sanitized.nodeUpserts);
    if (Array.isArray(sanitized.nodeDeletes)) mutation.nodeDeletes = normalizeEntityDeletes(sanitized.nodeDeletes);
    if (Array.isArray(sanitized.connectionUpserts)) mutation.connectionUpserts = normalizeEntityUpserts<CanvasProject["connections"][number]>(sanitized.connectionUpserts);
    if (Array.isArray(sanitized.connectionDeletes)) mutation.connectionDeletes = normalizeEntityDeletes(sanitized.connectionDeletes);
    if (Array.isArray(sanitized.chatSessionUpserts)) mutation.chatSessionUpserts = normalizeEntityUpserts<CanvasProject["chatSessions"][number]>(sanitized.chatSessionUpserts);
    if (Array.isArray(sanitized.chatSessionDeletes)) mutation.chatSessionDeletes = normalizeEntityDeletes(sanitized.chatSessionDeletes);
    return mutation;
}

function sanitizeProjectPayload(value: Record<string, unknown>) {
    const sanitized = JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "string" && (item.startsWith("data:") || item.startsWith("blob:")) ? "" : item))) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(sanitized)) > MAX_PROJECT_BYTES) throw new CanvasProjectServiceError("画布项目数据过大", 413);
    return sanitized;
}

function normalizeViewport(value: unknown, fallback: CanvasProject["viewport"]) {
    const input = object(value);
    const x = Number(input.x);
    const y = Number(input.y);
    const k = Number(input.k);
    return { x: Number.isFinite(x) ? x : fallback.x, y: Number.isFinite(y) ? y : fallback.y, k: Number.isFinite(k) ? Math.max(0.05, Math.min(8, k)) : fallback.k };
}

function normalizeMutationViewport(value: unknown) {
    const input = object(value);
    const x = Number(input.x);
    const y = Number(input.y);
    const k = Number(input.k);
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(k) ? { x, y, k: Math.max(0.05, Math.min(8, k)) } : null;
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeEntityUpserts<T extends { id: string }>(value: unknown[]): T[] {
    const byId = new Map<string, T>();
    value.forEach((item) => {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return;
        const id = text(item.id, 160);
        if (id) byId.set(id, { ...item, id } as T);
    });
    return Array.from(byId.values());
}

function normalizeEntityDeletes(value: unknown[]) {
    return Array.from(new Set(value.map((item) => text(item, 160)).filter(Boolean)));
}

function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function positiveInteger(value: unknown, fallback: number, max: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function isoTimestamp(value: unknown) {
    if (typeof value !== "string") return "";
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function nextProjectVersion(current: string) {
    const previous = Date.parse(current);
    return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}

export function canvasProjectError(error: unknown) {
    if (error instanceof CanvasProjectServiceError) return error;
    if (error instanceof CanvasProjectStoreError) return new CanvasProjectServiceError(error.message, error.status);
    return null;
}
