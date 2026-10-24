import { createHash } from "node:crypto";

import { readAuthDb } from "@/lib/auth/store-repository";
import { listDataDirectory, readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "./data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "./database";
import { ModelPricingShadowRepository } from "./database/model-pricing-shadow-repository";
import type { ShadowPriceReceipt } from "./model-pricing-shadow-service";
import type { ShadowTextCall } from "./model-pricing-shadow-call";
import type { ShadowImageCall } from "./model-pricing-shadow-image-call";

import type { ShadowVideoCall } from "./model-pricing-shadow-video-call";
import type { ShadowAudioCall } from "./model-pricing-shadow-audio-call";

export type ShadowCall = ShadowTextCall | ShadowImageCall | ShadowVideoCall | ShadowAudioCall;

export type ShadowPriceMutationState = { exactPoints: string; charge?: ShadowPriceReceipt; reversal?: ShadowPriceReceipt };
type FileAccount = { exactPoints: string; receipts: ShadowPriceReceipt[]; calls: ShadowCall[] };
const EMPTY_ACCOUNT: FileAccount = { exactPoints: "0", receipts: [], calls: [] };
const accountFile = (userId: string) => `model-pricing-shadow/${createHash("sha256").update(userId).digest("hex")}.json`;

export async function getShadowPriceExactTotal(userId: string) {
    if (getDatabaseProvider() !== "postgres") return (await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT)).exactPoints;
    await ensurePostgresSchema();
    return new ModelPricingShadowRepository({ query: postgresQuery }).getExactTotal(userId);
}

export async function hasShadowPriceReversal(userId: string, requestId: string) {
    if (getDatabaseProvider() !== "postgres") return (await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT)).receipts.some((item) => item.requestId === requestId && item.kind === "reversal");
    await ensurePostgresSchema();
    return new ModelPricingShadowRepository({ query: postgresQuery }).hasReversal(userId, requestId);
}

export async function mutateShadowPriceReceipt(userId: string, requestId: string, kind: ShadowPriceReceipt["kind"], build: (state: ShadowPriceMutationState) => ShadowPriceReceipt) {
    if (getDatabaseProvider() !== "postgres")
        return withJsonDataFileLock(accountFile(userId), async () => {
            const account = await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT);
            const records = account.receipts.filter((item) => item.requestId === requestId);
            const state = { exactPoints: account.exactPoints, charge: records.find((item) => item.kind === "charge"), reversal: records.find((item) => item.kind === "reversal") };
            const receipt = build(state);
            if (!state[kind]) await writeJsonDataFile(accountFile(userId), { ...account, exactPoints: receipt.accrual.exactPoints, receipts: [...account.receipts, receipt] });
            return receipt;
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const repository = new ModelPricingShadowRepository(client);
        const state = await repository.lockRequest(userId, requestId);
        const receipt = build(state);
        if (!state[kind]) await repository.append(receipt);
        return receipt;
    });
}

async function getShadowCall<T extends ShadowCall>(userId: string, requestId: string): Promise<T | undefined> {
    if (getDatabaseProvider() !== "postgres") return (await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT)).calls.find((item) => item.requestId === requestId) as T | undefined;
    await ensurePostgresSchema();
    return new ModelPricingShadowRepository({ query: postgresQuery }).getCall<T>(userId, requestId);
}

async function mutateShadowCall<T extends ShadowCall>(userId: string, requestId: string, build: (call: T | undefined, state: ShadowPriceMutationState) => { call: T; receipt?: ShadowPriceReceipt }) {
    if (getDatabaseProvider() !== "postgres")
        return withJsonDataFileLock(accountFile(userId), async () => {
            const account = await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT);
            const state = {
                exactPoints: account.exactPoints,
                charge: account.receipts.find((item) => item.requestId === requestId && item.kind === "charge"),
                reversal: account.receipts.find((item) => item.requestId === requestId && item.kind === "reversal"),
            };
            const next = build(account.calls.find((item) => item.requestId === requestId) as T | undefined, state);
            const appended = next.receipt && !state.charge ? next.receipt : undefined;
            await writeJsonDataFile(accountFile(userId), {
                exactPoints: appended?.accrual.exactPoints || account.exactPoints,
                receipts: appended ? [...account.receipts, appended] : account.receipts,
                calls: [...account.calls.filter((item) => item.requestId !== requestId), next.call],
            });
            return next.call;
        });
    await ensurePostgresSchema();
    return withPostgresTransaction(async (client) => {
        const repository = new ModelPricingShadowRepository(client);
        const state = await repository.lockRequest(userId, requestId);
        const next = build(await repository.getCall<T>(userId, requestId), state);
        if (next.receipt && !state.charge) await repository.append(next.receipt);
        await repository.saveCall(next.call);
        return next.call;
    });
}

export const getShadowTextCall = getShadowCall<ShadowTextCall>;
export const mutateShadowTextCall = mutateShadowCall<ShadowTextCall>;
export const getShadowImageCall = getShadowCall<ShadowImageCall>;
export const mutateShadowImageCall = mutateShadowCall<ShadowImageCall>;

export const getShadowVideoCall = getShadowCall<ShadowVideoCall>;
export const mutateShadowVideoCall = mutateShadowCall<ShadowVideoCall>;
export const getShadowAudioCall = getShadowCall<ShadowAudioCall>;
export const mutateShadowAudioCall = mutateShadowCall<ShadowAudioCall>;
export const getShadowMediaCall = getShadowCall<ShadowImageCall | ShadowVideoCall | ShadowAudioCall>;

export async function getShadowTaskEvidence(userId: string, taskId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return new ModelPricingShadowRepository({ query: postgresQuery }).getTaskEvidence(userId, taskId);
    }
    const account = await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT);
    const call = account.calls.filter((item) => item.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!call) return undefined;
    return { call, receipt: account.receipts.find((item) => item.requestId === call.requestId && item.kind === "charge") || null };
}

export async function getShadowPointEvidence(userId: string, pointRecordId: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return new ModelPricingShadowRepository({ query: postgresQuery }).getPointEvidence(userId, pointRecordId);
    }
    const record = (await readAuthDb()).pointRecords.find((item) => item.id === pointRecordId && item.userId === userId && item.type === "consume");
    if (!record?.idempotencyKey) return undefined;
    const account = await readJsonDataFile(accountFile(userId), EMPTY_ACCOUNT);
    const call = account.calls.find((item) => item.requestId === record.idempotencyKey);
    return call ? { call, receipt: account.receipts.find((item) => item.requestId === call.requestId && item.kind === "charge") || null } : undefined;
}

export async function getUnpricedImageShadowCalls(modelId: string, contractIds: string[], channelId: string): Promise<ShadowImageCall[]> {
    if (!contractIds.length) return [];
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return (await new ModelPricingShadowRepository({ query: postgresQuery }).latestUnpricedImageCalls(modelId, contractIds, channelId)) as ShadowImageCall[];
    }
    const latest = new Map<string, ShadowImageCall>();
    let files: Awaited<ReturnType<typeof listDataDirectory>>;
    try {
        files = await listDataDirectory("model-pricing-shadow");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        const account = await readJsonDataFile<FileAccount>(`model-pricing-shadow/${file.name}`, EMPTY_ACCOUNT);
        for (const call of account.calls) {
            if (
                call.protocol !== "openai-images" ||
                call.modelId !== modelId ||
                call.channelId !== channelId ||
                call.result?.status !== "unpriced" ||
                call.revaluation ||
                !call.result.observation?.usageFields ||
                !call.frozen ||
                !contractIds.includes(call.frozen.contract.id)
            )
                continue;
            const fields = call.result.observation.usageFields;
            if (fields["input_tokens_details.cached_tokens"] !== "0" && fields["output_tokens_details.reasoning_tokens"] !== "0") continue;
            if (call.result.observation.unmappedUsageFields?.some((path) => !["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"].includes(path))) continue;
            const current = latest.get(call.frozen.contract.id);
            if (!current || current.startedAt < call.startedAt) latest.set(call.frozen.contract.id, call);
        }
    }
    return [...latest.values()];
}
