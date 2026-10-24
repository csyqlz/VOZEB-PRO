import { randomBytes, randomUUID } from "node:crypto";

import { lockAuthMutation } from "@/lib/server/auth-mutation-lock";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction, type QueryExecutor } from "@/lib/server/database";
import { adjustPermanentPointsInAuthDb, adjustPermanentPointsInPostgresTransaction, walletClock } from "@/lib/server/points-wallet-service";
import { consumePostgresEmailCode } from "./postgres-email-code-service";
import { hashPassword, verifyPassword } from "./password";
import { AuthInputError, SESSION_MAX_AGE_SECONDS } from "./store-foundation";
import { consumeEmailCode, countActiveAdmins, countActiveFullAdmins, hashToken, normalizeDisplayName, normalizeEmail, normalizePoints, normalizeUserBio, parseSessionCookie, resolvePlanById, validateEmail, validatePassword } from "./store-normalizers";
import { mutateAuthDb, readAuthDb, readPostgresAuthSettings } from "./store-repository";
import type { PublicUser, StoredUser, UserRole, UserStatus } from "./store-types";
import { publicUserFromAuthenticatedRecord, toPublicUser } from "./store-user-projection";
import { ALL_ADMIN_PERMISSIONS, hasAdminPermission, hasAllAdminPermissions, isFullAdminPermissions, normalizeAdminPermissions, type AdminPermission } from "@/lib/admin-permissions";

export async function updateOwnProfile(userId: string, input: { displayName?: string; bio?: string; email?: string; emailCode?: string }) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        const outcome = await withPostgresTransaction(async (client) => {
            const repos = createPostgresRepositories(client);
            const users = repos.users;
            const current = await users.getById(userId, true);
            if (!current || current.status !== "active") throw new AuthInputError("用户不可用");
            const patch: { displayName?: string; bio?: string; email?: string } = {
                displayName: input.displayName === undefined ? undefined : normalizeDisplayName(input.displayName || current.username),
                bio: input.bio === undefined ? undefined : normalizeUserBio(input.bio),
            };
            if (input.email !== undefined) {
                const email = normalizeEmail(input.email);
                if (!email) throw new AuthInputError("请填写邮箱地址");
                validateEmail(email);
                if (email !== (current.email || "").toLowerCase()) {
                    if (await users.findIdentityConflict({ email, excludingUserId: userId })) throw new AuthInputError("邮箱已被注册");
                    const consumed = await consumePostgresEmailCode(client, { purpose: "email-change", email, code: input.emailCode, userId });
                    if (!consumed.ok) return consumed;
                    patch.email = email;
                }
            }
            await users.update(userId, patch);
            const record = (await users.getPublicDetails([userId], { now: clock.now.toISOString(), date: clock.date }))[0];
            if (!record) throw new AuthInputError("用户不可用");
            return { ok: true as const, record };
        });
        if (!outcome.ok) throw outcome.error;
        return publicUserFromAuthenticatedRecord(outcome.record, clock.expiresAt);
    }
    return mutateAuthDb((db) => {
        const user = db.users.find((item) => item.id === userId);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");

        if (input.displayName !== undefined) user.displayName = normalizeDisplayName(input.displayName || user.username);
        if (input.bio !== undefined) user.bio = normalizeUserBio(input.bio);

        if (input.email !== undefined) {
            const email = normalizeEmail(input.email);
            if (!email) throw new AuthInputError("请填写邮箱地址");
            validateEmail(email);
            if (email !== (user.email || "").toLowerCase()) {
                if (db.users.some((item) => item.id !== user.id && item.email?.toLowerCase() === email)) throw new AuthInputError("邮箱已被注册");
                consumeEmailCode(db, { purpose: "email-change", email, code: input.emailCode, userId });
                user.email = email;
            }
        }

        user.updatedAt = new Date().toISOString();
        return toPublicUser(user, db);
    });
}

export async function updateOwnPassword(userId: string, input: { currentPassword: string; newPassword: string }) {
    if (isPostgresDatabaseEnabled()) {
        validatePassword(input.newPassword);
        await ensurePostgresSchema();
        const clock = walletClock();
        return withPostgresTransaction(async (client) => {
            const repos = createPostgresRepositories(client);
            const user = await repos.users.getById(userId, true);
            if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
            if (!(await verifyPassword(input.currentPassword, user.passwordHash))) throw new AuthInputError("当前密码不正确");
            await repos.users.update(userId, { passwordHash: await hashPassword(input.newPassword) });
            await repos.sessions.deleteByUserId(userId);
            const record = (await repos.users.getPublicDetails([userId], { now: clock.now.toISOString(), date: clock.date }))[0];
            if (!record) throw new AuthInputError("用户不可用");
            return publicUserFromAuthenticatedRecord(record, clock.expiresAt);
        });
    }
    return mutateAuthDb(async (db) => {
        const user = db.users.find((item) => item.id === userId);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
        if (!(await verifyPassword(input.currentPassword, user.passwordHash))) throw new AuthInputError("当前密码不正确");
        validatePassword(input.newPassword);
        user.passwordHash = await hashPassword(input.newPassword);
        user.updatedAt = new Date().toISOString();
        db.sessions = db.sessions.filter((session) => session.userId !== user.id);
        return toPublicUser(user, db);
    });
}

export async function verifyUserPasswordForSensitiveAction(userId: string, password: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const user = await createPostgresRepositories().users.getById(userId);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
        if (!(await verifyPassword(password, user.passwordHash))) throw new AuthInputError("当前密码不正确");
        return;
    }
    const db = await readAuthDb();
    const user = db.users.find((item) => item.id === userId);
    if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
    if (!(await verifyPassword(password, user.passwordHash))) throw new AuthInputError("当前密码不正确");
}

export async function resetPasswordByEmail(input: { email: string; code?: string; newPassword: string }) {
    const email = normalizeEmail(input.email);
    validateEmail(email);
    validatePassword(input.newPassword);
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        const outcome = await withPostgresTransaction(async (client) => {
            const repos = createPostgresRepositories(client);
            const user = await repos.users.getByEmail(email, true);
            if (!user || user.status !== "active") throw new AuthInputError("邮箱验证码不正确或已过期");
            const consumed = await consumePostgresEmailCode(client, { purpose: "password-reset", email, code: input.code });
            if (!consumed.ok) return consumed;
            await repos.users.update(user.id, { passwordHash: await hashPassword(input.newPassword) });
            await repos.sessions.deleteByUserId(user.id);
            const record = (await repos.users.getPublicDetails([user.id], { now: clock.now.toISOString(), date: clock.date }))[0];
            if (!record) throw new AuthInputError("没有找到可用账号");
            return { ok: true as const, record };
        });
        if (!outcome.ok) throw outcome.error;
        return publicUserFromAuthenticatedRecord(outcome.record, clock.expiresAt);
    }
    return mutateAuthDb(async (db) => {
        const user = db.users.find((item) => item.email?.toLowerCase() === email);
        if (!user || user.status !== "active") throw new AuthInputError("邮箱验证码不正确或已过期");
        consumeEmailCode(db, { purpose: "password-reset", email, code: input.code });
        user.passwordHash = await hashPassword(input.newPassword);
        user.updatedAt = new Date().toISOString();
        db.sessions = db.sessions.filter((session) => session.userId !== user.id);
        return toPublicUser(user, db);
    });
}

export async function createSession(userId: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const now = new Date();
        const sessionId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        await withPostgresTransaction(async (client) => {
            const repos = createPostgresRepositories(client);
            const user = await repos.users.getById(userId, true);
            if (!user || user.status !== "active") throw new AuthInputError("用户不可用");
            await repos.sessions.create({
                id: sessionId,
                userId,
                tokenHash: hashToken(token),
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
            });
        });
        return `${sessionId}.${token}`;
    }
    return mutateAuthDb((db) => {
        const user = db.users.find((item) => item.id === userId);
        if (!user || user.status !== "active") throw new AuthInputError("用户不可用");

        const now = new Date();
        const sessionId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        db.sessions.push({
            id: sessionId,
            userId,
            tokenHash: hashToken(token),
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
        });
        return `${sessionId}.${token}`;
    });
}

export async function getUserBySession(cookieValue: string | undefined) {
    const sessionParts = parseSessionCookie(cookieValue);
    if (!sessionParts) return null;

    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        const snapshot = await createPostgresRepositories().sessions.getAuthenticatedUser({
            sessionId: sessionParts.id,
            tokenHash: hashToken(sessionParts.token),
            now: clock.now.toISOString(),
            date: clock.date,
        });
        if (!snapshot) return null;
        return publicUserFromAuthenticatedRecord(snapshot, clock.expiresAt);
    }

    const db = await readAuthDb();
    const session = db.sessions.find((item) => item.id === sessionParts.id);
    if (!session || session.tokenHash !== hashToken(sessionParts.token) || Date.parse(session.expiresAt) <= Date.now()) return null;
    const user = db.users.find((item) => item.id === session.userId);
    if (!user || user.status !== "active") return null;
    return toPublicUser(user, db);
}

export async function deleteSession(cookieValue: string | undefined) {
    const sessionParts = parseSessionCookie(cookieValue);
    if (!sessionParts) return;
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        await createPostgresRepositories().sessions.deleteById(sessionParts.id);
        return;
    }
    await mutateAuthDb((db) => {
        db.sessions = db.sessions.filter((item) => item.id !== sessionParts.id);
    });
}

type AdminUserPatch = Partial<Pick<PublicUser, "displayName" | "email" | "role" | "adminPermissions" | "status" | "pointsBalance" | "planId">> & { password?: string };

export async function updateUserByAdmin(actorId: string, userId: string, patch: AdminUserPatch) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        return withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const repos = createPostgresRepositories(client);
            const actor = await repos.users.getById(actorId, true);
            const user = await repos.users.getById(userId, true);
            if (!user) throw new AuthInputError("用户不存在");
            assertCanUpdateManagedUser(actor, user, patch);
            if (user.id === actorId && patch.status === "disabled") throw new AuthInputError("不能禁用当前登录的管理员账号");

            const nextRole = patch.role || user.role;
            const nextStatus = patch.status || user.status;
            const nextAdminPermissions = nextRole === "admin" ? normalizeAdminPermissions(patch.adminPermissions ?? user.adminPermissions) : [];
            if (user.role === "admin" && (nextRole !== "admin" || nextStatus !== "active")) {
                const activeAdminIds = await repos.users.lockActiveAdminIds();
                if (!activeAdminIds.some((id) => id !== user.id)) throw new AuthInputError("至少需要保留一个可用管理员");
            }

            if (isFullAdminPermissions(user.adminPermissions) && (nextRole !== "admin" || nextStatus !== "active" || !isFullAdminPermissions(nextAdminPermissions))) {
                const activeFullAdminIds = await repos.users.lockActiveFullAdminIds(ALL_ADMIN_PERMISSIONS);
                if (!activeFullAdminIds.some((id) => id !== user.id)) throw new AuthInputError("至少需要保留一个可用的全权限管理员");
            }

            const userPatch: { displayName?: string; email?: string | null; role?: UserRole; adminPermissions?: AdminPermission[]; status?: UserStatus; planId?: string; passwordHash?: string } = {
                displayName: patch.displayName === undefined ? undefined : normalizeDisplayName(patch.displayName || user.username),
                role: nextRole,
                adminPermissions: nextAdminPermissions,
                status: patch.pointsBalance !== undefined && nextStatus === "active" ? "active" : nextStatus,
            };
            if (patch.email !== undefined) {
                const email = normalizeEmail(patch.email);
                if (email) {
                    validateEmail(email);
                    if (await repos.users.findIdentityConflict({ email, excludingUserId: user.id })) throw new AuthInputError("邮箱已被注册");
                    userPatch.email = email;
                } else {
                    userPatch.email = null;
                }
            }
            if (patch.password) {
                validatePassword(patch.password);
                userPatch.passwordHash = await hashPassword(patch.password);
            }
            if (patch.planId !== undefined) {
                const settings = await readPostgresAuthSettings(client);
                userPatch.planId = resolvePlanById(settings.entitlements, patch.planId).id;
            }
            await repos.users.update(user.id, userPatch);

            let walletPointsBalance: number | undefined;
            if (patch.pointsBalance !== undefined) {
                const delta = normalizePoints(patch.pointsBalance, user.pointsBalance) - normalizePoints(user.pointsBalance, 0);
                const wallet = await adjustPermanentPointsInPostgresTransaction(client, {
                    userId: user.id,
                    amount: delta,
                    description: "管理员后台调整",
                    idempotencyKey: `admin-adjust:${user.id}:${randomUUID()}`,
                    type: "admin-adjust",
                    now: clock.now,
                });
                walletPointsBalance = wallet?.snapshot.totalPoints;
            }
            if (patch.password || nextStatus !== "active") await repos.sessions.deleteByUserId(user.id);
            const record = (await repos.users.getPublicDetails([user.id], { now: clock.now.toISOString(), date: clock.date }))[0];
            if (!record) throw new AuthInputError("用户不存在");
            return { ...publicUserFromAuthenticatedRecord(record, clock.expiresAt), ...(walletPointsBalance === undefined ? {} : { pointsBalance: walletPointsBalance }) };
        });
    }
    return mutateAuthDb(async (db) => {
        const user = db.users.find((item) => item.id === userId);
        if (!user) throw new AuthInputError("用户不存在");
        const actor = db.users.find((item) => item.id === actorId);
        assertCanUpdateManagedUser(actor, user, patch);
        if (user.id === actorId && patch.status === "disabled") throw new AuthInputError("不能禁用当前登录的管理员账号");

        const nextRole = patch.role || user.role;
        const nextStatus = patch.status || user.status;
        const nextAdminPermissions = nextRole === "admin" ? normalizeAdminPermissions(patch.adminPermissions ?? user.adminPermissions) : [];
        if (user.role === "admin" && nextRole !== "admin" && countActiveAdmins(db, user.id) === 0) throw new AuthInputError("至少需要保留一个管理员");
        if (user.role === "admin" && nextStatus !== "active" && countActiveAdmins(db, user.id) === 0) throw new AuthInputError("至少需要保留一个可用管理员");
        if (isFullAdminPermissions(user.adminPermissions) && (nextRole !== "admin" || nextStatus !== "active" || !isFullAdminPermissions(nextAdminPermissions)) && countActiveFullAdmins(db, user.id) === 0) {
            throw new AuthInputError("至少需要保留一个可用的全权限管理员");
        }

        if (patch.displayName !== undefined) user.displayName = normalizeDisplayName(patch.displayName || user.username);
        if (patch.email !== undefined) {
            const email = normalizeEmail(patch.email);
            if (email) {
                validateEmail(email);
                if (db.users.some((item) => item.id !== user.id && item.email?.toLowerCase() === email)) throw new AuthInputError("邮箱已被注册");
                user.email = email;
            } else {
                user.email = undefined;
            }
        }
        if (patch.password) {
            validatePassword(patch.password);
            user.passwordHash = await hashPassword(patch.password);
            db.sessions = db.sessions.filter((session) => session.userId !== user.id);
        }
        user.role = nextRole;
        user.adminPermissions = nextAdminPermissions;
        if (patch.planId !== undefined) user.planId = resolvePlanById(db.settings.entitlements, patch.planId).id;
        let walletPointsBalance: number | undefined;
        if (patch.pointsBalance !== undefined) {
            const previousBalance = normalizePoints(user.pointsBalance, 0);
            const delta = normalizePoints(patch.pointsBalance, user.pointsBalance) - previousBalance;
            if (nextStatus === "active") user.status = "active";
            const wallet = adjustPermanentPointsInAuthDb(db, {
                userId: user.id,
                amount: delta,
                description: "管理员后台调整",
                idempotencyKey: `admin-adjust:${user.id}:${randomUUID()}`,
            });
            walletPointsBalance = wallet?.snapshot.totalPoints;
        }
        user.status = nextStatus;
        user.updatedAt = new Date().toISOString();
        if (user.status !== "active") db.sessions = db.sessions.filter((session) => session.userId !== user.id);
        return { ...toPublicUser(user, db), ...(walletPointsBalance === undefined ? {} : { pointsBalance: walletPointsBalance }) };
    });
}

export type BeforeAdminUserDelete = (client: QueryExecutor, userId: string) => Promise<void>;

export async function deleteUserByAdmin(actorId: string, userId: string, options: { beforeDelete?: BeforeAdminUserDelete } = {}) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const users = createPostgresRepositories(client).users;
            const actor = await users.getById(actorId, true);
            const user = await users.getById(userId, true);
            if (!user) throw new AuthInputError("用户不存在");
            assertCanDeleteManagedUser(actor, user);
            if (user.id === actorId) throw new AuthInputError("不能删除当前登录的管理员账号");
            if (user.role === "admin") {
                const activeAdminIds = await users.lockActiveAdminIds();
                if (!activeAdminIds.some((id) => id !== user.id)) throw new AuthInputError("至少需要保留一个管理员");
            }
            if (isFullAdminPermissions(user.adminPermissions)) {
                const activeFullAdminIds = await users.lockActiveFullAdminIds(ALL_ADMIN_PERMISSIONS);
                if (!activeFullAdminIds.some((id) => id !== user.id)) throw new AuthInputError("至少需要保留一个可用的全权限管理员");
            }
            await options.beforeDelete?.(client, user.id);
            await users.delete(user.id);
            return { ok: true };
        });
    }
    return mutateAuthDb((db) => {
        const user = db.users.find((item) => item.id === userId);
        if (!user) throw new AuthInputError("用户不存在");
        const actor = db.users.find((item) => item.id === actorId);
        assertCanDeleteManagedUser(actor, user);
        if (user.id === actorId) throw new AuthInputError("不能删除当前登录的管理员账号");
        if (user.role === "admin" && countActiveAdmins(db, user.id) === 0) throw new AuthInputError("至少需要保留一个管理员");
        if (isFullAdminPermissions(user.adminPermissions) && countActiveFullAdmins(db, user.id) === 0) throw new AuthInputError("至少需要保留一个可用的全权限管理员");
        db.users = db.users.filter((item) => item.id !== user.id);
        db.pricingReservations = db.pricingReservations.filter((item) => item.userId !== user.id);
        db.pricingAccruals = db.pricingAccruals.filter((item) => item.userId !== user.id);
        db.pricingRefunds = db.pricingRefunds.filter((item) => item.userId !== user.id);
        db.sessions = db.sessions.filter((session) => session.userId !== user.id);
        db.quotaUsage = db.quotaUsage.filter((usage) => !usage || typeof usage !== "object" || (usage as { userId?: unknown }).userId !== user.id);
        db.emailCodes = db.emailCodes.filter((code) => code.userId !== user.id);
        return { ok: true };
    });
}

function assertCanUpdateManagedUser(actor: StoredUser | null | undefined, user: StoredUser, patch: AdminUserPatch) {
    const nextRole = patch.role || user.role;
    const touchesAdministrator = user.role === "admin" || nextRole === "admin" || patch.adminPermissions !== undefined;
    assertAdminPermission(actor, touchesAdministrator ? "administrators.manage" : "users.manage");
    if (user.role === "admin" && !hasAllAdminPermissions(actor, user.adminPermissions)) throw new AuthInputError("不能管理职责范围高于当前账号的管理员", 403);
    if (patch.pointsBalance !== undefined || patch.planId !== undefined) assertAdminPermission(actor, "billing.manage");
    if (nextRole === "admin") {
        const permissions = normalizeAdminPermissions(patch.adminPermissions ?? user.adminPermissions);
        if (!permissions.length) throw new AuthInputError("管理员至少需要一项职责权限");
        if (!hasAllAdminPermissions(actor, permissions)) throw new AuthInputError("不能授予超出当前管理员职责范围的权限", 403);
    }
}

function assertCanDeleteManagedUser(actor: StoredUser | null | undefined, user: StoredUser) {
    assertAdminPermission(actor, user.role === "admin" ? "administrators.manage" : "users.manage");
    if (user.role === "admin" && !hasAllAdminPermissions(actor, user.adminPermissions)) throw new AuthInputError("不能删除职责范围高于当前账号的管理员", 403);
}

function assertAdminPermission(actor: StoredUser | null | undefined, permission: AdminPermission) {
    if (!hasAdminPermission(actor, permission)) throw new AuthInputError("当前管理员没有执行此操作的职责权限", 403);
}
