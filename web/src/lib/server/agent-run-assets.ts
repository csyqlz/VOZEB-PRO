import { registerCreativeAssets } from "@/lib/server/creative-runtime-store";
import { agentTaskResultItems } from "@/lib/server/agent-run-result-items";
import type { AgentRun, AgentRunTask } from "@/lib/server/agent-run-store";
import { ecommerceProductAnchorIdFromRun } from "./ecommerce-reference-roles";

export async function registerAgentTaskAssets(run: AgentRun, task: AgentRunTask, result: unknown, sourceTaskIds: string[]) {
    const records: Array<{ record: Record<string, unknown>; textContent?: string; location?: NonNullable<ReturnType<typeof persistentMediaLocation>> }> = [];
    for (const record of agentTaskResultItems(result)) {
        if (task.type === "text") {
            const textContent = typeof record.content === "string" ? record.content.trim() : "";
            if (textContent) records.push({ record, textContent });
            continue;
        }
        const location = persistentMediaLocation(record);
        if (location) records.push({ record, location });
    }
    const inputs: Parameters<typeof registerCreativeAssets>[0] = [];
    const productAnchorId = task.type === "image" ? ecommerceProductAnchorIdFromRun(run) : undefined;
    const continuity = run.ecommerceSnapshot?.continuity || run.ecommerceSnapshot?.plan?.continuity;
    const sceneRootAssetId = task.type === "image" ? run.ecommerceSnapshot?.continuity?.sceneRootAssetId : null;
    const ecommerceContinuity =
        (productAnchorId || sceneRootAssetId) && continuity
            ? {
                  productAnchorId: productAnchorId || null,
                  sceneBaselineId: run.ecommerceSnapshot?.plan?.source.currentSceneBaselineId || null,
                  parentResultId: continuity.parentResultId,
                  branchId: continuity.branchId,
                  ...(sceneRootAssetId ? { sceneRootAssetId } : {}),
                  ...(run.ecommerceSnapshot?.qualityCheck ? { qualityStatus: run.ecommerceSnapshot.qualityCheck.publicStatus } : {}),
              }
            : undefined;
    const parentAssetIds = Array.from(new Set([productAnchorId, sceneRootAssetId, task.referenceAssetId, ...(task.references || []).map((item) => item.assetId)].filter((item): item is string => Boolean(item))));
    records.forEach(({ record, textContent, location }, ordinal) => {
        const sourceTaskId = sourceTaskIds[Math.min(ordinal, Math.max(0, sourceTaskIds.length - 1))] || `direct-${run.id}-${task.id}`;
        const base = {
            userId: run.userId,
            conversationId: run.conversationId,
            messageId: run.assistantMessageId,
            sourceRunId: run.id,
            sourceTaskId,
            parentAssetId: parentAssetIds[0],
            ordinal,
            type: task.type,
            title: records.length > 1 ? `${task.title} ${ordinal + 1}` : task.title,
            metadata: { agentTaskId: task.id, model: task.model, surface: run.surface, projectId: run.projectId, parentAssetIds, ...(ecommerceContinuity ? { ecommerceContinuity } : {}), ...publicResultMetadata(record) },
        };
        if (task.type === "text") {
            if (textContent) inputs.push({ ...base, textContent });
            return;
        }
        if (!location) return;
        inputs.push({
            ...base,
            ...location,
            mimeType: cleanResultText(record.mimeType),
            width: resultNumber(record.width),
            height: resultNumber(record.height),
            durationMs: resultDurationMs(record),
            bytes: resultNumber(record.bytes),
        });
    });
    return registerCreativeAssets(inputs);
}

function persistentMediaLocation(record: Record<string, unknown>) {
    const storageKey = cleanResultText(record.storageKey);
    const explicitKind = record.storageKind === "local" || record.storageKind === "object" || record.storageKind === "remote" ? record.storageKind : undefined;
    const rawUrl = cleanPersistentUrl(record.url);
    const remoteUrl = cleanPersistentUrl(record.remoteUrl) || (rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined);
    const serverUrl = cleanPersistentUrl(record.serverUrl) || (rawUrl && !/^https?:\/\//i.test(rawUrl) ? rawUrl : undefined);
    if (!storageKey && !remoteUrl && !serverUrl) return null;
    return { storageKind: explicitKind || (storageKey ? "object" : serverUrl ? "local" : "remote"), storageKey, remoteUrl, serverUrl } as const;
}

function cleanPersistentUrl(value: unknown) {
    const text = cleanResultText(value);
    return text && !text.startsWith("data:") && !text.startsWith("blob:") ? text : undefined;
}

function cleanResultText(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 4000) || undefined : undefined;
}

function resultNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function resultDurationMs(record: Record<string, unknown>) {
    const milliseconds = resultNumber(record.durationMs);
    if (milliseconds !== undefined) return milliseconds;
    const seconds = resultNumber(record.seconds ?? record.duration);
    return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function publicResultMetadata(record: Record<string, unknown>) {
    const coverUrl = cleanPersistentUrl(record.coverUrl ?? record.posterUrl ?? record.poster ?? record.thumbnailUrl ?? record.thumbnail ?? record.firstFrame);
    const ratio = cleanResultText(record.ratio ?? record.aspectRatio ?? record.size)?.slice(0, 32);
    const resolution = cleanResultText(record.resolution)?.slice(0, 32);
    return { ...(coverUrl ? { coverUrl } : {}), ...(ratio ? { ratio } : {}), ...(resolution ? { resolution } : {}) };
}
