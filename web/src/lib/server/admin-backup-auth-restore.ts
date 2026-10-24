import { encryptAuthDbSecretsForStorage } from "@/lib/auth/store-normalizers";
import {
    insertPostgresAnnouncements,
    insertPostgresCdkCodes,
    insertPostgresDailyPlanPointWallets,
    insertPostgresEmailCodes,
    insertPostgresPointRecords,
    insertPostgresQuotaUsage,
    insertPostgresSessions,
    insertPostgresUsers,
    upsertPostgresEntitlementPlans,
    upsertPostgresSettings,
    upsertPostgresSystemChannels,
} from "@/lib/auth/store-repository";
import type { AuthDatabase } from "@/lib/auth/store-types";
import type { QueryExecutor } from "@/lib/server/database";

/** Upserts an account/config snapshot without deleting entities absent from the backup. */
export async function restorePostgresAuthSnapshot(client: QueryExecutor, db: AuthDatabase) {
    const normalized = encryptAuthDbSecretsForStorage(db);
    if (normalized.pricingRefunds.length || normalized.pricingReservations.length || normalized.pricingAccruals.length) throw new Error("按用量计费钱包必须通过完整数据库灾难恢复，不能合并账户配置快照");
    const userIds = new Set(normalized.users.map((user) => user.id));
    const cdkCodes = normalized.cdkCodes.map((code) => ({ ...code, redemptions: code.redemptions.filter((redemption) => userIds.has(redemption.userId)) }));

    await upsertPostgresEntitlementPlans(client, normalized.settings.entitlements.plans);
    await upsertPostgresSettings(client, normalized.settings);
    await upsertPostgresSystemChannels(client, normalized.settings.systemChannels);
    await insertPostgresUsers(client, normalized.users);
    await syncPostgresUserAccountIdSequence(client);
    await insertPostgresSessions(
        client,
        normalized.sessions.filter((session) => userIds.has(session.userId)),
    );
    await insertPostgresEmailCodes(
        client,
        normalized.emailCodes.filter((code) => !code.userId || userIds.has(code.userId)),
    );
    await insertPostgresQuotaUsage(
        client,
        normalized.quotaUsage.filter((usage) => userIds.has(usage.userId)),
    );
    await insertPostgresPointRecords(
        client,
        normalized.pointRecords.filter((record) => userIds.has(record.userId)),
    );
    await insertPostgresDailyPlanPointWallets(
        client,
        normalized.dailyPlanPointWallets.filter((wallet) => userIds.has(wallet.userId)),
    );
    await insertPostgresCdkCodes(client, cdkCodes);
    await insertPostgresAnnouncements(client, normalized.announcements);
}

async function syncPostgresUserAccountIdSequence(db: QueryExecutor) {
    await db.query(`
        SELECT setval(
            'user_account_id_seq',
            greatest((SELECT last_value FROM user_account_id_seq), coalesce((SELECT max(account_id) FROM users), 1)),
            (SELECT is_called FROM user_account_id_seq) OR EXISTS (SELECT 1 FROM users)
        )
    `);
}
