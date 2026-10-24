import type { AuthDatabase, AuthSettings, LogicalModel, SystemModelChannel } from "@/lib/auth/store-types";
import type { PromptDatabase } from "@/lib/prompts/store";
import type { AccountDeletionRequestDatabase, StoredAccountDeletionRequest } from "@/lib/server/database/account-deletion-request-repository";
import type { GenerationLogDatabase } from "@/lib/server/generation-log-types";

export type AdminBackupData = {
    auth: AuthDatabase;
    prompts: PromptDatabase;
    generationLogs: GenerationLogDatabase;
    accountDeletionRequests: AccountDeletionRequestDatabase;
};

export function mergeAccountConfigBackup(current: AdminBackupData, imported: AdminBackupData): AdminBackupData {
    return {
        auth: mergeAuthDatabase(current.auth, imported.auth),
        prompts: {
            version: 1,
            prompts: mergeRecords(current.prompts.prompts, imported.prompts.prompts, (prompt) => prompt.id),
            seedSources: uniqueStrings(current.prompts.seedSources, imported.prompts.seedSources),
        },
        generationLogs: {
            version: 1,
            logs: mergeRecords(current.generationLogs.logs, imported.generationLogs.logs, (log) => log.id),
        },
        accountDeletionRequests: {
            version: 1,
            requests: mergeAccountDeletionRequests(current.accountDeletionRequests.requests, imported.accountDeletionRequests.requests),
        },
    };
}

function mergeAuthDatabase(current: AuthDatabase, imported: AuthDatabase): AuthDatabase {
    if (current.pricingRefunds.length || imported.pricingRefunds.length || current.pricingReservations.length || imported.pricingReservations.length || current.pricingAccruals.length || imported.pricingAccruals.length)
        throw new Error("存在按用量计费钱包时不能合并账户配置备份，请使用完整数据库灾难恢复以保留余额与预留的一致性");
    return {
        ...current,
        ...imported,
        version: 1,
        nextUserAccountId: Math.max(current.nextUserAccountId, imported.nextUserAccountId),
        users: mergeUsers(current.users, imported.users),
        sessions: mergeRecords(current.sessions, imported.sessions, (session) => session.id),
        quotaUsage: mergeRecords(current.quotaUsage, imported.quotaUsage, (usage) => `${usage.userId}\u0000${usage.date}\u0000${usage.usageKind}`),
        pointRecords: mergePointRecords(current.pointRecords, imported.pointRecords),
        dailyPlanPointWallets: mergeRecords(current.dailyPlanPointWallets, imported.dailyPlanPointWallets, (wallet) => `${wallet.userId}\u0000${wallet.date}`),
        emailCodes: mergeRecords(current.emailCodes, imported.emailCodes, (code) => code.id),
        cdkCodes: mergeRecords(current.cdkCodes, imported.cdkCodes, (code) => code.id),
        announcements: mergeRecords(current.announcements, imported.announcements, (announcement) => announcement.id),
        settings: mergeSettings(current.settings, imported.settings),
    };
}

function mergeSettings(current: AuthSettings, imported: AuthSettings): AuthSettings {
    return {
        ...current,
        ...imported,
        site: {
            ...current.site,
            ...imported.site,
            friendLinks: mergeRecords(current.site.friendLinks, imported.site.friendLinks, (item) => item.id),
            socials: { ...current.site.socials, ...imported.site.socials },
        },
        mail: { ...current.mail, ...imported.mail },
        modelPointCosts: { ...current.modelPointCosts, ...imported.modelPointCosts },
        generationPointMultipliers: {
            imageQuality: { ...current.generationPointMultipliers.imageQuality, ...imported.generationPointMultipliers.imageQuality },
            videoQuality: { ...current.generationPointMultipliers.videoQuality, ...imported.generationPointMultipliers.videoQuality },
            videoSeconds: { ...current.generationPointMultipliers.videoSeconds, ...imported.generationPointMultipliers.videoSeconds },
        },
        entitlements: {
            ...current.entitlements,
            ...imported.entitlements,
            plans: mergeRecords(current.entitlements.plans, imported.entitlements.plans, (plan) => plan.id),
        },
        generationConcurrency: { ...current.generationConcurrency, ...imported.generationConcurrency },
        generationDefaults: {
            ...current.generationDefaults,
            ...imported.generationDefaults,
        },
        systemChannels: mergeRecords(current.systemChannels, imported.systemChannels, (channel) => channel.id, mergeSystemChannel),
        logicalModels: mergeRecords(current.logicalModels, imported.logicalModels, (model) => model.id, mergeLogicalModel),
        defaultModels: { ...current.defaultModels, ...imported.defaultModels },
        agentSkills: mergeRecords(current.agentSkills, imported.agentSkills, (skill) => skill.id),
    };
}

function mergeSystemChannel(current: SystemModelChannel, imported: SystemModelChannel): SystemModelChannel {
    const currentAdvanced = current.advancedConfig;
    const importedAdvanced = imported.advancedConfig;
    return {
        ...current,
        ...imported,
        models: uniqueStrings(current.models, imported.models),
        advancedConfig:
            currentAdvanced || importedAdvanced
                ? {
                      ...(currentAdvanced || importedAdvanced!),
                      ...(importedAdvanced || {}),
                      modelCatalogPaths: uniqueStrings(currentAdvanced?.modelCatalogPaths || [], importedAdvanced?.modelCatalogPaths || []),
                      modelCapabilities: { ...currentAdvanced?.modelCapabilities, ...importedAdvanced?.modelCapabilities },
                      modelConfigs: { ...currentAdvanced?.modelConfigs, ...importedAdvanced?.modelConfigs },
                      operationConfigs: { ...currentAdvanced?.operationConfigs, ...importedAdvanced?.operationConfigs },
                  }
                : undefined,
    };
}

function mergeLogicalModel(current: LogicalModel, imported: LogicalModel): LogicalModel {
    return {
        ...current,
        ...imported,
        bindings: mergeRecords(current.bindings, imported.bindings, (binding) => binding.id),
    };
}

function mergePointRecords(current: AuthDatabase["pointRecords"], imported: AuthDatabase["pointRecords"]) {
    const records = [...current];
    for (const incoming of imported) {
        const index = records.findIndex(
            (existing) =>
                existing.id === incoming.id ||
                Boolean(existing.idempotencyKey && existing.idempotencyKey === incoming.idempotencyKey) ||
                Boolean(existing.type === "refund" && incoming.type === "refund" && existing.sourceRecordId && existing.sourceRecordId === incoming.sourceRecordId),
        );
        if (index < 0) records.push(incoming);
        else records[index] = { ...records[index], ...incoming, id: records[index].id };
    }
    return records;
}

function mergeUsers(current: AuthDatabase["users"], imported: AuthDatabase["users"]) {
    const users = [...current];
    for (const incoming of imported) {
        const index = users.findIndex((existing) => existing.id === incoming.id || existing.username.toLowerCase() === incoming.username.toLowerCase());
        if (index < 0) users.push(incoming);
        else users[index] = { ...users[index], ...incoming, id: users[index].id, accountId: users[index].accountId };
    }
    return users;
}

function mergeAccountDeletionRequests(current: StoredAccountDeletionRequest[], imported: StoredAccountDeletionRequest[]) {
    return mergeRecords(current, imported, accountDeletionRequestKey, (existing, incoming) => ({ ...existing, ...incoming, id: existing.id }));
}

function accountDeletionRequestKey(request: StoredAccountDeletionRequest) {
    return request.status === "pending" ? `pending:${request.userId}` : `id:${request.id}`;
}

function mergeRecords<T extends object>(current: T[], imported: T[], keyOf: (item: T) => string, merge: (current: T, imported: T) => T = mergeObjects) {
    const values = new Map<string, T>();
    for (const item of current) values.set(keyOf(item), item);
    for (const item of imported) {
        const key = keyOf(item);
        const existing = values.get(key);
        values.set(key, existing ? merge(existing, item) : item);
    }
    return Array.from(values.values());
}

function mergeObjects<T extends object>(current: T, imported: T) {
    return { ...current, ...imported };
}

function uniqueStrings(current: string[], imported: string[]) {
    return Array.from(new Set([...current, ...imported].filter(Boolean)));
}
