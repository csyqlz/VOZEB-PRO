import { PricingInputError } from "@/lib/model-pricing";
import type { StoredPointRecord } from "@/lib/auth/store-types";
import { readJsonDataFile } from "./data-adapter";
import { createPostgresRepositories, ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "./database";
import { ModelPricingShadowRepository } from "./database/model-pricing-shadow-repository";
import { getShadowMediaCall, hasShadowPriceReversal } from "./model-pricing-shadow-store";
import { reverseShadowPrice } from "./model-pricing-shadow-service";

type Source = Pick<StoredPointRecord, "id" | "userId" | "type" | "idempotencyKey" | "requestFingerprint" | "model">;
const systemRequest = (value?: string) => Boolean(value?.startsWith("system-ai:"));

export async function getShadowBillingSource(key: { recordId: string } | { requestId: string }): Promise<Source | undefined> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const points = createPostgresRepositories().points;
        return ("recordId" in key ? await points.getRecordById(key.recordId) : await points.getRecordByIdempotencyKey(key.requestId)) || undefined;
    }
    const db = await readJsonDataFile<{ pointRecords: StoredPointRecord[] }>("auth.json", { pointRecords: [] });
    return db.pointRecords.find((item) => ("recordId" in key ? item.id === key.recordId : item.idempotencyKey === key.requestId));
}

export async function hasRefundedShadowBillingSource(source: Source) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return Boolean(await createPostgresRepositories().points.getRefundRecordBySourceRecordId(source.id));
    }
    const db = await readJsonDataFile<{ pointRecords: StoredPointRecord[] }>("auth.json", { pointRecords: [] });
    return db.pointRecords.some((item) => item.type === "refund" && item.userId === source.userId && item.sourceRecordId === source.id);
}

function matchesSource(call: Awaited<ReturnType<typeof getShadowMediaCall>>, source: Source) {
    const usageKind =
        call?.protocol === "openai-images" && "operation" in call
            ? "image"
            : (call?.protocol === "minimax-video-v2" || call?.protocol === "minimax-hailuo-v1") && "kind" in call && call.kind === "video"
              ? "video"
              : (call?.protocol === "gemini-tts" || call?.protocol === "openai-chat-audio") && "kind" in call && call.kind === "audio"
                ? "audio"
                : undefined;
    return Boolean(usageKind && (call?.result?.status === "priced" || (call && "revaluation" in call && call.revaluation)) && call?.requestFingerprint === source.requestFingerprint && call.modelId === source.model);
}

async function reconcile(userId: string, source: Source | undefined) {
    if (!source || source.userId !== userId || source.type !== "consume" || !systemRequest(source.idempotencyKey)) return false;
    const requestId = source.idempotencyKey!;
    const call = await getShadowMediaCall(userId, requestId);
    if (!matchesSource(call, source)) return false;
    if (await hasShadowPriceReversal(userId, requestId)) return false;
    const refund =
        getDatabaseProvider() === "postgres"
            ? await createPostgresRepositories().points.getRefundRecordBySourceRecordId(source.id)
            : (await readJsonDataFile<{ pointRecords: StoredPointRecord[] }>("auth.json", { pointRecords: [] })).pointRecords.find((item) => item.type === "refund" && item.sourceRecordId === source.id);
    if (!refund || refund.userId !== userId || refund.type !== "refund" || refund.sourceRecordId !== source.id) return false;
    await reverseShadowPrice(userId, requestId);
    return true;
}

/** Runs after wallet/shadow commits, never inside their locks or database transactions. */
export async function observeFixedMediaRefund(userId: string, sourceRecordId: string) {
    try {
        return await reconcile(userId, await getShadowBillingSource({ recordId: sourceRecordId }));
    } catch (error) {
        logFailure(userId, error);
        return false;
    }
}

export async function observeMediaShadowRefund(userId: string, requestId: string) {
    if (!systemRequest(requestId)) return false;
    try {
        return await reconcile(userId, await getShadowBillingSource({ requestId }));
    } catch (error) {
        logFailure(userId, error);
        return false;
    }
}

function logFailure(userId: string, error: unknown) {
    console.error("Media shadow refund reconciliation unavailable", { userId, errorType: error instanceof Error ? error.name : "unknown" });
}

/** Durable fixed refund rows are the recovery source; no timeout or retry-count guessing. */
export async function reconcileMediaShadowRefundBatch(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new PricingInputError("影子退款维护批次必须为正整数");
    const candidates: Array<{ userId: string; requestId: string }> = [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        candidates.push(...(await new ModelPricingShadowRepository({ query: postgresQuery }).listRefundedMediaCalls(limit)));
    } else {
        const db = await readJsonDataFile<{ pointRecords: StoredPointRecord[] }>("auth.json", { pointRecords: [] });
        const sources = new Map(db.pointRecords.filter((item) => item.type === "consume" && systemRequest(item.idempotencyKey)).map((item) => [item.id, item]));
        for (const refund of db.pointRecords.filter((item) => item.type === "refund").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
            const source = sources.get(refund.sourceRecordId || "");
            if (!source || source.userId !== refund.userId) continue;
            const requestId = source.idempotencyKey!;
            const call = await getShadowMediaCall(source.userId, requestId);
            if (!matchesSource(call, source) || (await hasShadowPriceReversal(source.userId, requestId))) continue;
            candidates.push({ userId: source.userId, requestId });
            if (candidates.length === limit) break;
        }
    }
    let reversed = 0;
    let failed = 0;
    for (const candidate of candidates) {
        try {
            if (await reconcile(candidate.userId, await getShadowBillingSource({ requestId: candidate.requestId }))) reversed++;
        } catch (error) {
            failed++;
            logFailure(candidate.userId, error);
        }
    }
    return { checked: candidates.length, reversed, failed };
}
