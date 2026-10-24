import { describe, expect, it } from "vitest";

import { emptyDb } from "@/lib/auth/store-normalizers";
import type { StoredUser } from "@/lib/auth/store-types";

import { mergeAccountConfigBackup, type AdminBackupData } from "./admin-backup-merge";

const now = "2026-08-01T00:00:00.000Z";

describe("admin account-config backup merge", () => {
    it("refuses to merge account balances separately from live priced wallet state", () => {
        const current = backup({ users: [user("user-a", "admin", 10)], prompts: [], logs: [], deletionRequests: [] });
        const imported = backup({ users: [user("user-a", "admin", 20)], prompts: [], logs: [], deletionRequests: [] });
        current.auth.pricingAccruals.push({ userId: "user-a", sourceKey: "permanent", exactPoints: "1/250" });
        expect(() => mergeAccountConfigBackup(current, imported)).toThrow("完整数据库");
        expect(() => mergeAccountConfigBackup(imported, current)).toThrow("完整数据库");
        expect(current.auth.users[0].pointsBalance).toBe(10);
    });
    it("updates imported records while retaining users and related data absent from the backup", () => {
        const current = backup({
            users: [user("user-a", "admin", 10), user("user-b", "member", 20)],
            prompts: [{ id: "prompt-b", title: "保留提示词" }],
            logs: [{ id: "log-b", userId: "user-b", title: "保留记录" }],
            deletionRequests: [{ id: "delete-b", userId: "user-b", status: "pending", note: "保留申请" }],
        });
        current.auth.sessions.push({ id: "session-b", userId: "user-b", tokenHash: "token-b", createdAt: now, expiresAt: now });
        current.auth.pointRecords.push({
            id: "points-b",
            userId: "user-b",
            type: "credit",
            amount: 20,
            balanceAfter: 20,
            permanentAmount: 20,
            dailyAmount: 0,
            permanentBalanceAfter: 20,
            dailyBalanceAfter: 0,
            description: "保留流水",
            createdAt: now,
        });
        const imported = backup({
            users: [user("user-a", "admin", 99)],
            prompts: [{ id: "prompt-a", title: "导入提示词" }],
            logs: [{ id: "log-a", userId: "user-a", title: "导入记录" }],
            deletionRequests: [{ id: "delete-a", userId: "user-a", status: "accepted", note: "导入申请" }],
        });

        const merged = mergeAccountConfigBackup(current, imported);

        expect(merged.auth.users).toEqual([expect.objectContaining({ id: "user-a", pointsBalance: 99 }), expect.objectContaining({ id: "user-b", pointsBalance: 20 })]);
        expect(merged.auth.sessions).toEqual(current.auth.sessions);
        expect(merged.auth.pointRecords).toEqual(current.auth.pointRecords);
        expect(merged.prompts.prompts.map((prompt) => prompt.id)).toEqual(["prompt-b", "prompt-a"]);
        expect(merged.generationLogs.logs.map((log) => log.id)).toEqual(["log-b", "log-a"]);
        expect(merged.accountDeletionRequests.requests.map((request) => request.id)).toEqual(["delete-b", "delete-a"]);
    });
});

function backup(input: {
    users: StoredUser[];
    prompts: Array<{ id: string; title: string }>;
    logs: Array<{ id: string; userId: string; title: string }>;
    deletionRequests: Array<{ id: string; userId: string; status: "pending" | "accepted"; note: string }>;
}): AdminBackupData {
    const auth = emptyDb();
    auth.users = input.users;
    auth.nextUserAccountId = input.users.length + 1;
    return {
        auth,
        prompts: {
            version: 1,
            prompts: input.prompts.map((prompt) => ({ ...prompt, scope: "library", coverUrl: "", prompt: prompt.title, tags: [], category: "", preview: "", createdAt: now, updatedAt: now })),
            seedSources: [],
        },
        generationLogs: {
            version: 1,
            logs: input.logs.map((log) => ({
                ...log,
                username: log.userId,
                displayName: log.userId,
                kind: "image",
                source: "image-workbench",
                status: "success",
                prompt: log.title,
                model: "model",
                summary: "",
                durationMs: 1,
                count: 1,
                successCount: 1,
                failCount: 0,
                assets: [],
                createdAt: now,
                updatedAt: now,
                completedAt: now,
            })),
        },
        accountDeletionRequests: {
            version: 1,
            requests: input.deletionRequests.map((request) => ({
                ...request,
                username: request.userId,
                displayName: request.userId,
                reviewNote: "",
                requestedAt: now,
                updatedAt: now,
            })),
        },
    };
}

function user(id: string, username: string, pointsBalance: number): StoredUser {
    return {
        id,
        accountId: id === "user-a" ? "1" : "2",
        username,
        email: `${username}@example.com`,
        displayName: username,
        bio: "",
        role: username === "admin" ? "admin" : "user",
        adminPermissions: username === "admin" ? ["system.manage"] : [],
        status: "active",
        planId: "free",
        pointsBalance,
        passwordHash: `${id}-hash`,
        createdAt: now,
        updatedAt: now,
    };
}
