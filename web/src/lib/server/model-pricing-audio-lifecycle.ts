import { PricingInputError } from "@/lib/model-pricing";
import { mutateAuthDb, readAuthDb } from "@/lib/auth/store-repository";
import { readJsonDataFile } from "./data-adapter";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery, withPostgresTransaction } from "./database";
import { ModelPricingAudioResponseRepository } from "./database/model-pricing-audio-response-repository";
import { ModelPricingWalletRepository } from "./database/model-pricing-wallet-repository";
import { purgeAudioPriceMedia, removeOrphanAudioPriceFiles } from "./model-pricing-audio-response-store";
import type { PricingWalletReservation } from "./model-pricing-wallet-service";

const eligible = (reservation?: PricingWalletReservation) => Boolean(reservation && reservation.status !== "reserved" && reservation.preparation?.taskType === "audio" && reservation.preparation.taskId && !reservation.audioMediaPurgedAt);
// Read physical presence: an expired task may still be pinned for billing or awaiting deletion.
const fileTaskIds = async () => new Set((await readJsonDataFile<Array<{ id: string }>>("generation-tasks.json", [])).map((task) => task.id));

/** Follow actual task deletion; the original wallet lock fences late writes without settling daily gifts. */
export async function cleanupAudioPriceMedia(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new PricingInputError("音频媒体维护批次必须为正整数");
    const postgres = isPostgresDatabaseEnabled();
    let candidates: Array<{ userId: string; requestId: string }>;
    if (postgres) {
        await ensurePostgresSchema();
        candidates = await new ModelPricingAudioResponseRepository({ query: postgresQuery }).listArchiveCandidates(limit);
    } else {
        const [db, tasks] = await Promise.all([readAuthDb(), fileTaskIds()]);
        candidates = db.pricingReservations
            .filter((item) => eligible(item) && !tasks.has(item.preparation!.taskId))
            .sort((a, b) => a.userId.localeCompare(b.userId) || a.requestId.localeCompare(b.requestId))
            .slice(0, limit);
    }
    let archived = 0;
    let failed = 0;
    for (const { userId, requestId } of candidates) {
        try {
            const now = new Date().toISOString();
            const applied = postgres
                ? await withPostgresTransaction(async (client) => {
                      if (!(await createPostgresRepositories(client).users.getById(userId, true))) return false;
                      const wallet = new ModelPricingWalletRepository(client);
                      const reservation = await wallet.get(userId, requestId);
                      if (!eligible(reservation) || (await new ModelPricingAudioResponseRepository(client).hasTask(reservation!.preparation!.taskId))) return false;
                      await purgeAudioPriceMedia(userId, requestId, now, client);
                      await wallet.save({ ...reservation!, audioMediaPurgedAt: now });
                      return true;
                  })
                : await mutateAuthDb(async (db) => {
                      const reservation = db.pricingReservations.find((item) => item.userId === userId && item.requestId === requestId);
                      if (!db.users.some((user) => user.id === userId) || !eligible(reservation) || (await fileTaskIds()).has(reservation!.preparation!.taskId)) return false;
                      await purgeAudioPriceMedia(userId, requestId, now);
                      reservation!.audioMediaPurgedAt = now;
                      return true;
                  });
            if (applied) archived++;
        } catch (error) {
            failed++;
            console.error("Audio pricing media cleanup unavailable", { userId, requestId, errorType: error instanceof Error ? error.name : "unknown" });
        }
    }
    const orphanFilesDeleted =
        !postgres && candidates.length < limit
            ? await mutateAuthDb((db) =>
                  removeOrphanAudioPriceFiles(
                      db.users.map((user) => user.id),
                      limit - candidates.length,
                  ),
              )
            : 0;
    return { checked: candidates.length, archived, failed, orphanFilesDeleted };
}
