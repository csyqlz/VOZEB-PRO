import { randomUUID } from "node:crypto";

import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction } from "@/lib/server/database";
import { collectLocalMediaStorageKeys } from "@/lib/server/local-media-references";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";
import {
    defaultSummary,
    mutateGenerationLogDb,
    normalizeAssets,
    normalizeGenerationLogRequestSnapshot,
    normalizeModelName,
    normalizeNonNegativeNumber,
    normalizePositiveInteger,
    normalizeStoredLog,
    normalizeText,
    normalizeTime,
    stableAssetUrl,
} from "@/lib/server/generation-log-repository";
import { recordGenerationLog } from "@/lib/server/generation-log-store";
import type { GenerationLogAsset, GenerationLogInput, GenerationTaskLogResultInput, StoredGenerationLog } from "@/lib/server/generation-log-types";

export class GenerationLogOwnershipError extends Error {
    constructor() {
        super("generation log not found");
        this.name = "GenerationLogOwnershipError";
    }
}

export class GenerationLogDraftValidationError extends Error {
    constructor() {
        super("生成记录必须包含待处理请求槽");
        this.name = "GenerationLogDraftValidationError";
    }
}

export async function recordGenerationLogDraft(input: GenerationLogInput) {
    const id = normalizeText(input.id, randomUUID(), 120);
    const requestSnapshot = normalizeGenerationLogRequestSnapshot(input.requestSnapshot);
    if (!requestSnapshot?.slots.some((slot) => slot.status === "pending" && slot.clientRequestId)) throw new GenerationLogDraftValidationError();
    return mutateOwnedGenerationLog(id, input.userId, (existing) => buildGenerationLogDraft({ ...input, requestSnapshot }, id, existing));
}

export async function recordGenerationTaskLogResult(input: GenerationTaskLogResultInput): Promise<{ log?: StoredGenerationLog; asset?: GenerationLogAsset; assets?: GenerationLogAsset[] }> {
    const logId = optionalText(input.logId, 120);
    const slotId = optionalText(input.slotId, 200);
    if (!logId || !slotId) {
        const log = await recordStandaloneGenerationTaskLog(input);
        return { log, asset: log.assets[0], assets: log.assets };
    }

    let missing = false;
    let asset: GenerationLogAsset | undefined;
    let assets: GenerationLogAsset[] = [];
    const log = await mutateOwnedGenerationLog(logId, input.userId, async (current) => {
        if (!current) {
            missing = true;
            return undefined;
        }
        const slot = findGenerationLogSlot(current, slotId, input.clientRequestId);
        if (!slot) return current;
        if (slot.status === "success") {
            if (slot.taskId === input.taskId && slot.assetIndex !== undefined) asset = current.assets[slot.assetIndex];
            return current;
        }
        assets = await normalizeTaskResultAssets(input, current);
        [asset] = assets;
        return applyGenerationTaskLogResult(current, input, slot.id, assets);
    });
    if (missing) {
        assets = await normalizeTaskResultAssets(input);
        [asset] = assets;
    }
    return { log: log || undefined, asset, assets };
}

export function renameGenerationLogForUser(userId: string, id: string, title: string) {
    const normalizedTitle = normalizeText(title, "", 80);
    if (!normalizedTitle) return Promise.resolve<StoredGenerationLog | null>(null);
    return mutateOwnedGenerationLog(normalizeText(id, "", 120), userId, (current) => (current ? { ...current, title: normalizedTitle, updatedAt: new Date().toISOString() } : undefined));
}

export async function deleteGenerationLogResultsForUser(userId: string, id: string, slotIds: string[]) {
    const selected = new Set(slotIds.map((slotId) => normalizeText(slotId, "", 200)).filter(Boolean));
    if (!selected.size) return null;
    let removedAssets: GenerationLogAsset[] = [];
    const log = await mutateOwnedGenerationLog(normalizeText(id, "", 120), userId, (current) => {
        if (!current?.requestSnapshot) return current;
        const snapshot = current.requestSnapshot;
        const removedSlots = snapshot.slots.filter((slot) => selected.has(slot.id));
        const remainingSlots = snapshot.slots.filter((slot) => !selected.has(slot.id));
        const keptAssetIndexes = new Set(remainingSlots.flatMap((slot) => (slot.assetIndex === undefined ? [] : [slot.assetIndex])));
        const removedAssetIndexes = new Set(removedSlots.flatMap((slot) => (slot.assetIndex === undefined || keptAssetIndexes.has(slot.assetIndex) ? [] : [slot.assetIndex])));
        removedAssets = current.assets.filter((_, index) => removedAssetIndexes.has(index));
        const indexMap = new Map<number, number>();
        const assets = current.assets.filter((_, index) => {
            if (removedAssetIndexes.has(index)) return false;
            indexMap.set(index, indexMap.size);
            return true;
        });
        const slots = remainingSlots.map((slot) => ({ ...slot, assetIndex: slot.assetIndex === undefined ? undefined : indexMap.get(slot.assetIndex) }));
        return finalizeGenerationLog({ ...current, assets, requestSnapshot: { ...snapshot, slots } }, slots);
    });
    if (removedAssets.length) await deleteUserMediaAssetsCascade(userId, Array.from(collectLocalMediaStorageKeys(removedAssets)));
    return log;
}

async function mutateOwnedGenerationLog(id: string, userId: string, mutate: (current: StoredGenerationLog | undefined) => StoredGenerationLog | undefined | Promise<StoredGenerationLog | undefined>): Promise<StoredGenerationLog | null> {
    if (!id || !userId) return null;
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const repository = createPostgresRepositories(client).generationLogs;
            const record = await repository.getById(id, true);
            const current = record ? normalizeStoredLog(record as Partial<StoredGenerationLog>) : undefined;
            if (current && current.userId !== userId) throw new GenerationLogOwnershipError();
            const next = await mutate(current);
            return next ? normalizeStoredLog((await repository.upsert(next)) as Partial<StoredGenerationLog>) : null;
        });
    }
    return mutateGenerationLogDb(async (db) => {
        const current = db.logs.find((log) => log.id === id);
        if (current && current.userId !== userId) throw new GenerationLogOwnershipError();
        const next = await mutate(current);
        if (!next) return null;
        db.logs = [next, ...db.logs.filter((log) => log.id !== id)];
        return next;
    });
}

function buildGenerationLogDraft(input: GenerationLogInput, id: string, existing?: StoredGenerationLog) {
    const now = new Date().toISOString();
    const requestSnapshot = mergeGenerationLogDraftSnapshot(existing?.requestSnapshot, input.requestSnapshot);
    if (existing) return finalizeGenerationLog({ ...existing, requestSnapshot, count: Math.max(existing.count, requestSnapshot?.slots.length || 0, 1), updatedAt: now }, requestSnapshot?.slots || []);
    return normalizeStoredLog({
        id,
        userId: input.userId,
        username: input.username,
        displayName: input.displayName,
        conversationId: input.conversationId,
        kind: input.kind,
        source: input.source || "unknown",
        status: "pending",
        title: normalizeText(input.title, input.prompt || "未命名记录", 80),
        prompt: normalizeText(input.prompt, "", 5000),
        model: normalizeModelName(input.model),
        summary: defaultSummary(input.kind, "pending"),
        durationMs: normalizeNonNegativeNumber(input.durationMs, 0),
        count: normalizePositiveInteger(input.count, Math.max(1, requestSnapshot?.slots.length || 1)),
        successCount: 0,
        failCount: 0,
        assets: [],
        requestSnapshot,
        createdAt: normalizeTime(input.createdAt, now),
        updatedAt: now,
    });
}

function mergeGenerationLogDraftSnapshot(existing: StoredGenerationLog["requestSnapshot"], incomingValue: GenerationLogInput["requestSnapshot"]) {
    const incoming = normalizeGenerationLogRequestSnapshot(incomingValue);
    if (!incoming) return existing;
    const slots = new Map((existing?.slots || []).map((slot) => [slot.id, slot]));
    for (const candidate of incoming.slots) {
        if (candidate.status !== "pending" || !candidate.clientRequestId) continue;
        const current = slots.get(candidate.id);
        if (current?.status === "success" || (current?.status === "failed" && current.canRetry !== true)) continue;
        slots.set(candidate.id, {
            ...(current || candidate),
            id: candidate.id,
            index: candidate.index,
            status: "pending",
            prompt: candidate.prompt || current?.prompt,
            parameters: candidate.parameters || current?.parameters,
            referenceIds: candidate.referenceIds || current?.referenceIds,
            assetIndex: undefined,
            clientRequestId: candidate.clientRequestId,
            taskId: undefined,
            taskKind: candidate.taskKind || current?.taskKind,
            taskProvider: undefined,
            taskModel: candidate.taskModel || current?.taskModel,
            taskPollPath: undefined,
            taskResultUrl: undefined,
            serverTaskId: undefined,
            startedAt: candidate.startedAt || Date.now(),
            error: undefined,
            canRetry: undefined,
        });
    }
    return {
        version: 1 as const,
        userPrompt: existing?.userPrompt || incoming.userPrompt,
        parameters: Object.keys(incoming.parameters).length ? incoming.parameters : existing?.parameters || {},
        references: incoming.references.length ? incoming.references : existing?.references || [],
        slots: Array.from(slots.values()).sort((left, right) => left.index - right.index),
    };
}

function normalizeTaskResultAssets(input: GenerationTaskLogResultInput, existing?: StoredGenerationLog) {
    const assets = input.assets?.length ? input.assets : input.asset?.url ? [input.asset] : [];
    return normalizeAssets(assets, {
        ownerUserId: input.userId,
        source: input.source,
        conversationId: existing?.conversationId,
        taskId: input.taskId,
        originalName: input.title,
        targetSize: input.asset?.targetSize,
    });
}

function recordStandaloneGenerationTaskLog(input: GenerationTaskLogResultInput) {
    return recordGenerationLog({
        id: `${input.kind}-task:${input.taskId}`,
        taskId: input.taskId,
        userId: input.userId,
        username: input.username,
        displayName: input.displayName,
        kind: input.kind,
        source: input.source,
        status: input.status,
        title: input.title,
        prompt: input.prompt,
        model: input.model,
        summary: input.summary,
        durationMs: input.durationMs,
        count: Math.max(1, input.assets?.length || (input.asset?.url ? 1 : 0)),
        successCount: input.status === "success" ? Math.max(1, input.assets?.length || (input.asset?.url ? 1 : 0)) : 0,
        failCount: input.status === "failed" ? 1 : 0,
        assets: input.assets?.length ? input.assets : input.asset?.url ? [input.asset] : [],
        error: input.error,
        createdAt: input.createdAt,
        completedAt: Date.now(),
    });
}

function applyGenerationTaskLogResult(current: StoredGenerationLog | undefined, input: GenerationTaskLogResultInput, slotId: string, resultAssets: GenerationLogAsset[]) {
    if (!current?.requestSnapshot) return current;
    const snapshot = current.requestSnapshot;
    const slotIndex = snapshot.slots.findIndex((slot) => slot.id === slotId || (input.clientRequestId && slot.clientRequestId === input.clientRequestId));
    if (slotIndex < 0) return current;
    const previous = snapshot.slots[slotIndex];
    if (previous.status === "success" && (previous.taskId === input.taskId || input.status === "failed")) return current;

    const assets = [...current.assets];
    let assetIndex = previous.assetIndex;
    const resultAssetIndexes: number[] = [];
    if (input.status === "success") {
        for (const [resultIndex, asset] of resultAssets.entries()) {
            const existingAssetIndex = assets.findIndex((candidate) => stableAssetUrl(candidate) === stableAssetUrl(asset));
            let nextIndex = existingAssetIndex;
            if (nextIndex < 0 && resultIndex === 0 && assetIndex !== undefined && assets[assetIndex]) {
                assets[assetIndex] = asset;
                nextIndex = assetIndex;
            } else if (nextIndex < 0) {
                nextIndex = assets.length;
                assets.push(asset);
            }
            resultAssetIndexes.push(nextIndex);
        }
        assetIndex = resultAssetIndexes[0];
    }
    let slots = snapshot.slots.map((slot, index) =>
        index === slotIndex
            ? {
                  ...slot,
                  status: input.status,
                  assetIndex: input.status === "success" ? assetIndex : undefined,
                  clientRequestId: input.clientRequestId || slot.clientRequestId,
                  taskId: input.taskId,
                  taskKind: input.taskKind || slot.taskKind,
                  taskProvider: input.taskProvider || slot.taskProvider,
                  taskModel: input.model || slot.taskModel,
                  taskPollPath: input.taskPollPath || slot.taskPollPath,
                  serverTaskId: input.serverTaskId || slot.serverTaskId,
                  error: input.status === "failed" ? input.error || "生成失败" : undefined,
                  canRetry: input.status === "failed" && input.canRetry === true ? true : undefined,
              }
            : slot,
    );
    if (input.status === "success" && resultAssetIndexes.length > 1) {
        const nextIndex = Math.max(-1, ...slots.map((slot) => slot.index)) + 1;
        const extraSlots = resultAssetIndexes.slice(1).map((resultAssetIndex, offset) => ({
            ...previous,
            id: `${previous.id}:output:${offset + 2}`,
            index: nextIndex + offset,
            status: "success" as const,
            assetIndex: resultAssetIndex,
            clientRequestId: undefined,
            taskId: input.taskId,
            taskModel: input.model || previous.taskModel,
            startedAt: previous.startedAt,
            error: undefined,
            canRetry: undefined,
        }));
        const extraIds = new Set(extraSlots.map((slot) => slot.id));
        slots = [...slots.filter((slot) => !extraIds.has(slot.id)), ...extraSlots].sort((left, right) => left.index - right.index);
    }
    return finalizeGenerationLog(
        { ...current, assets, taskId: current.taskId || input.taskId, durationMs: Math.max(current.durationMs, input.durationMs), requestSnapshot: { ...snapshot, slots }, updatedAt: new Date().toISOString() },
        slots,
        input.summary,
    );
}

function findGenerationLogSlot(current: StoredGenerationLog, slotId: string, clientRequestId?: string) {
    return current.requestSnapshot?.slots.find((slot) => slot.id === slotId || (clientRequestId && slot.clientRequestId === clientRequestId));
}

function finalizeGenerationLog(current: StoredGenerationLog, slots: NonNullable<StoredGenerationLog["requestSnapshot"]>["slots"], completedSummary?: string): StoredGenerationLog {
    const pendingCount = slots.filter((slot) => slot.status === "pending").length;
    const successCount = slots.filter((slot) => slot.status === "success").length;
    const failCount = slots.filter((slot) => slot.status === "failed").length;
    const status = pendingCount ? "pending" : successCount ? "success" : slots.length ? "failed" : current.status === "success" ? "success" : "failed";
    const now = new Date().toISOString();
    return {
        ...current,
        status,
        count: Math.max(current.count, slots.length, 1),
        successCount,
        failCount,
        summary: pendingCount ? defaultSummary(current.kind, "pending") : completedSummary || (slots.length ? defaultSummary(current.kind, status) : "结果已移除"),
        error: status === "failed" ? slots.find((slot) => slot.status === "failed")?.error || current.error : undefined,
        updatedAt: now,
        completedAt: pendingCount ? undefined : current.completedAt || now,
    };
}

function optionalText(value: unknown, maxLength: number) {
    return normalizeText(value, "", maxLength) || undefined;
}
