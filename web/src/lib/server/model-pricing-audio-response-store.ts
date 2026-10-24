import type { AudioPriceReview } from "./model-pricing-audio-review";
import { createHash } from "node:crypto";
import { access, opendir, rm } from "node:fs/promises";
import { readJsonDataFile, resolveDataPath, writeJsonDataFile } from "./data-adapter";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery, type QueryExecutor } from "./database";
import { ModelPricingAudioResponseRepository } from "./database/model-pricing-audio-response-repository";
import type { AudioPriceResponseReceipt } from "./model-pricing-audio-response";

function fileName(userId: string, requestId: string, review = false) {
    return `pricing-audio-${review ? "reviews" : "responses"}/${createHash("sha256").update(userId).digest("hex")}/${createHash("sha256")
        .update(JSON.stringify([userId, requestId]))
        .digest("hex")}.json`;
}

export async function readAudioPriceResponseReceipt(userId: string, requestId: string, executor?: QueryExecutor) {
    if (!isPostgresDatabaseEnabled()) return readJsonDataFile<AudioPriceResponseReceipt | undefined>(fileName(userId, requestId), undefined);
    if (!executor) await ensurePostgresSchema();
    return new ModelPricingAudioResponseRepository(executor || { query: postgresQuery }).get(userId, requestId);
}

export async function hasAudioPriceResponseReceipt(userId: string, requestId: string, executor?: QueryExecutor) {
    if (isPostgresDatabaseEnabled()) {
        if (!executor) await ensurePostgresSchema();
        return new ModelPricingAudioResponseRepository(executor || { query: postgresQuery }).exists(userId, requestId);
    }
    try {
        await access(resolveDataPath(fileName(userId, requestId)));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Caller must hold the wallet lock and check immutability first. */
export async function insertAudioPriceResponseReceipt(receipt: AudioPriceResponseReceipt, executor?: QueryExecutor) {
    if (!isPostgresDatabaseEnabled()) return writeJsonDataFile(fileName(receipt.userId, receipt.requestId), receipt);
    if (!executor) throw new Error("音频响应写入需要钱包事务");
    await new ModelPricingAudioResponseRepository(executor).insert(receipt);
}

export async function readAudioPriceReview(userId: string, requestId: string, executor?: QueryExecutor) {
    if (!isPostgresDatabaseEnabled()) return readJsonDataFile<AudioPriceReview | undefined>(fileName(userId, requestId, true), undefined);
    if (!executor) await ensurePostgresSchema();
    return new ModelPricingAudioResponseRepository(executor || { query: postgresQuery }).getReview(userId, requestId);
}

/** The wallet lock serializes this immutable decision with original response writes. */
export async function insertAudioPriceReview(review: AudioPriceReview, executor?: QueryExecutor) {
    if (!isPostgresDatabaseEnabled()) return writeJsonDataFile(fileName(review.userId, review.requestId, true), review);
    if (!executor) throw new Error("音频审核写入需要钱包事务");
    await new ModelPricingAudioResponseRepository(executor).insertReview(review);
}

/** Keep audit fields and the original digest; an explicit marker prevents recovery/repopulation. */
export async function purgeAudioPriceMedia(userId: string, requestId: string, now: string, executor?: QueryExecutor) {
    if (isPostgresDatabaseEnabled()) {
        if (!executor) throw new Error("音频媒体清理需要钱包事务");
        await new ModelPricingAudioResponseRepository(executor).purgeMedia(userId, requestId, now);
        return;
    }
    const clear = (receipt: AudioPriceResponseReceipt): AudioPriceResponseReceipt => ({ ...receipt, mediaPurgedAt: now, audio: receipt.audio.map((part) => ({ ...part, data: "" })) });
    const receipt = await readAudioPriceResponseReceipt(userId, requestId);
    if (receipt && !receipt.mediaPurgedAt) await writeJsonDataFile(fileName(userId, requestId), clear(receipt));
    const review = await readAudioPriceReview(userId, requestId);
    if (review?.response && !review.response.mediaPurgedAt) await writeJsonDataFile(fileName(userId, requestId, true), { ...review, response: clear(review.response) });
}

/** Called under the file auth lock; removed accounts have no reservation left to drive cleanup. */
export async function removeOrphanAudioPriceFiles(userIds: string[], limit: number) {
    const owners = new Set(userIds.map((id) => createHash("sha256").update(id).digest("hex")));
    let deleted = 0;
    for (const root of ["pricing-audio-responses", "pricing-audio-reviews"]) {
        let directories;
        try {
            directories = await opendir(resolveDataPath(root));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
        for await (const owner of directories) {
            if (!owner.isDirectory() || !/^[a-f0-9]{64}$/.test(owner.name) || owners.has(owner.name)) continue;
            const files = await opendir(resolveDataPath(`${root}/${owner.name}`));
            for await (const file of files) {
                if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
                if (deleted === limit) return deleted;
                await rm(resolveDataPath(`${root}/${owner.name}/${file.name}`), { force: true });
                deleted++;
            }
        }
    }
    return deleted;
}
