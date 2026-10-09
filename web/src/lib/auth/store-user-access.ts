import { randomUUID } from "node:crypto";

import { formatAccountId } from "@/lib/account-id";
import { BillingInputError } from "@/lib/server/billing-errors";
import { lockAuthMutation } from "@/lib/server/auth-mutation-lock";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, withPostgresTransaction } from "@/lib/server/database";
import { assertInstallToken, InstallTokenError } from "@/lib/server/install-token";
import { adjustPermanentPointsInAuthDb, adjustPermanentPointsInPostgresTransaction, walletClock } from "@/lib/server/points-wallet-service";
import { bindReferralRelationshipAfterRegistration, normalizeReferralCode } from "@/lib/server/referral-service";
import { createRegistrationPolicyConsent } from "@/lib/registration-consent";
import { verifyAdminMfaForLogin } from "@/lib/server/admin-mfa-service";
import { isTenantMvpEnabled } from "@/lib/server/tenant-context";
import { ALL_ADMIN_PERMISSIONS, hasAdminPermission, hasAllAdminPermissions, normalizeAdminPermissions, type AdminPermission } from "@/lib/admin-permissions";

import { hashPassword, verifyPasswordWithDummy } from "./password";
import { consumePostgresEmailCode } from "./postgres-email-code-service";
import { AuthInputError, EMAIL_CODE_MAX_AGE_MS, EMAIL_CODE_RESEND_COOLDOWN_MS } from "./store-foundation";
import {
    consumeEmailCode,
    hashToken,
    normalizeDisplayName,
    normalizeEmail,
    normalizePoints,
    normalizeUsername,
    randomNumericCode,
    resolveDefaultPlan,
    resolveInitialUserPoints,
    resolvePlanById,
    validateEmail,
    validatePassword,
    validateUsername,
} from "./store-normalizers";
import { mutateAuthDb, readAuthDb, readPostgresAuthSettings } from "./store-repository";
import { publicUserFromAuthenticatedRecord, toPublicUser } from "./store-user-projection";
import { type AuthDatabase, type EmailCodePurpose, type StoredUser, type UserRole, type UserStatus } from "./store-types";

export async function createUser(input: { username: string; email?: string; emailCode?: string; displayName?: string; password: string; policyAccepted: boolean; referralCode?: string; referralSource?: string; referralClientIp?: string }) {
    const referralCode = normalizeReferralCode(input.referralCode);
    if (referralCode && !isPostgresDatabaseEnabled()) throw new AuthInputError("邀请功能需要启用 PostgreSQL", 501);
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName || username);
    validateUsername(username);
    validatePassword(input.password);
    if (email) validateEmail(email);

    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        const outcome = await withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const repos = createPostgresRepositories(client);
            const settings = await readPostgresAuthSettings(client);
            if ((await repos.users.count()) === 0) throw new AuthInputError("请先通过安装向导创建管理员", 503);
            if (!settings.registrationEnabled) throw new AuthInputError("注册已关闭");
            if (!input.policyAccepted) throw new AuthInputError("请先阅读并同意服务条款和隐私政策");
            if (settings.emailRegistrationEnabled && !email) throw new AuthInputError("请填写邮箱地址");
            assertNoIdentityConflict(await repos.users.findIdentityConflict({ username, email: email || undefined }), username, email);
            if (settings.emailRegistrationEnabled) {
                const consumed = await consumePostgresEmailCode(client, { purpose: "register", email, code: input.emailCode });
                if (!consumed.ok) return consumed;
            }

            const now = clock.now.toISOString();
            const user = await repos.users.createWithNextAccountId({
                id: randomUUID(),
                username,
                email: email || undefined,
                displayName,
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId: resolveDefaultPlan(settings.entitlements).id,
                pointsBalance: 0,
                passwordHash: await hashPassword(input.password),
                registrationConsent: createRegistrationPolicyConsent(
                    {
                        termsVersion: settings.site.termsVersion,
                        termsUrl: settings.site.termsUrl,
                        privacyVersion: settings.site.privacyVersion,
                        privacyUrl: settings.site.privacyUrl,
                    },
                    now,
                ),
                createdAt: now,
                updatedAt: now,
            });
            if (isTenantMvpEnabled()) await createPersonalTenant(repos, user, now, user.id);
            if (referralCode) {
                try {
                    await bindReferralRelationshipAfterRegistration(client, {
                        inviteeUserId: user.id,
                        referralCode,
                        attributionSource: input.referralSource,
                        clientIp: input.referralClientIp,
                        strict: true,
                    });
                } catch (error) {
                    if (error instanceof BillingInputError) throw new AuthInputError(error.message, error.status);
                    throw error;
                }
            }
            const record = (await repos.users.getPublicDetails([user.id], { now, date: clock.date }))[0];
            if (!record) throw new AuthInputError("用户创建失败");
            return { ok: true as const, user: publicUserFromAuthenticatedRecord(record, clock.expiresAt) };
        });
        if (!outcome.ok) throw outcome.error;
        return outcome.user;
    }

    return mutateAuthDb(async (db) => {
        if (db.users.length === 0) throw new AuthInputError("请先通过安装向导创建管理员", 503);
        if (!db.settings.registrationEnabled) throw new AuthInputError("注册已关闭");
        if (!input.policyAccepted) throw new AuthInputError("请先阅读并同意服务条款和隐私政策");
        if (db.settings.emailRegistrationEnabled && !email) throw new AuthInputError("请填写邮箱地址");
        if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new AuthInputError("用户名已存在");
        if (email && db.users.some((user) => user.email?.toLowerCase() === email.toLowerCase())) throw new AuthInputError("邮箱已被注册");
        if (db.settings.emailRegistrationEnabled) consumeEmailCode(db, { purpose: "register", email, code: input.emailCode });

        const now = new Date().toISOString();
        const user: StoredUser = {
            id: randomUUID(),
            accountId: takeNextFileAccountId(db),
            username,
            email: email || undefined,
            displayName,
            bio: "",
            role: "user",
            adminPermissions: [],
            status: "active",
            planId: resolveDefaultPlan(db.settings.entitlements).id,
            pointsBalance: 0,
            passwordHash: await hashPassword(input.password),
            registrationConsent: createRegistrationPolicyConsent(
                {
                    termsVersion: db.settings.site.termsVersion,
                    termsUrl: db.settings.site.termsUrl,
                    privacyVersion: db.settings.site.privacyVersion,
                    privacyUrl: db.settings.site.privacyUrl,
                },
                now,
            ),
            createdAt: now,
            updatedAt: now,
        };
        db.users.push(user);
        return toPublicUser(user, db);
    });
}

export async function createFirstAdmin(input: { username: string; email?: string; displayName?: string; password: string; installToken: unknown }) {
    try {
        assertInstallToken(input.installToken);
    } catch (error) {
        if (error instanceof InstallTokenError) throw new AuthInputError(error.message, error.status);
        throw error;
    }

    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName || username);
    validateUsername(username);
    validatePassword(input.password);
    if (email) validateEmail(email);

    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        return withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const repos = createPostgresRepositories(client);
            if ((await repos.users.count()) !== 0) throw new AuthInputError("项目已完成安装，禁止重复创建首个管理员", 409);
            const settings = await readPostgresAuthSettings(client);
            assertNoIdentityConflict(await repos.users.findIdentityConflict({ username, email: email || undefined }), username, email);
            const now = clock.now.toISOString();
            const user = await repos.users.createWithNextAccountId({
                id: randomUUID(),
                username,
                email: email || undefined,
                displayName,
                bio: "",
                role: "admin",
                adminPermissions: [...ALL_ADMIN_PERMISSIONS],
                status: "active",
                planId: resolveDefaultPlan(settings.entitlements).id,
                pointsBalance: 0,
                passwordHash: await hashPassword(input.password),
                createdAt: now,
                updatedAt: now,
            });
            const record = (await repos.users.getPublicDetails([user.id], { now, date: clock.date }))[0];
            if (!record) throw new AuthInputError("管理员创建失败");
            return publicUserFromAuthenticatedRecord(record, clock.expiresAt);
        });
    }

    return mutateAuthDb(async (db) => {
        if (db.users.length !== 0) throw new AuthInputError("项目已完成安装，禁止重复创建首个管理员", 409);
        const now = new Date().toISOString();
        const user: StoredUser = {
            id: randomUUID(),
            accountId: takeNextFileAccountId(db),
            username,
            email: email || undefined,
            displayName,
            bio: "",
            role: "admin",
            adminPermissions: [...ALL_ADMIN_PERMISSIONS],
            status: "active",
            planId: resolveDefaultPlan(db.settings.entitlements).id,
            pointsBalance: 0,
            passwordHash: await hashPassword(input.password),
            createdAt: now,
            updatedAt: now,
        };
        db.users.push(user);
        return toPublicUser(user, db);
    });
}

async function createPersonalTenant(repos: ReturnType<typeof createPostgresRepositories>, user: { id: string; username: string; displayName: string }, now: string, createdByUserId: string) {
    const tenant = await repos.tenants.createTenant({
        id: randomUUID(),
        slug: `personal-${user.id}`,
        name: `${user.displayName || user.username}的团队`.slice(0, 80),
        ownerUserId: user.id,
        createdByUserId,
        createdAt: now,
        updatedAt: now,
    });
    await repos.tenants.addMembership({ tenantId: tenant.id, userId: user.id, role: "owner", status: "active", createdByUserId, createdAt: now, updatedAt: now });
}

export async function createUserByAdmin(input: {
    actorId: string;
    username: string;
    email?: string;
    displayName?: string;
    password: string;
    role?: UserRole;
    adminPermissions?: AdminPermission[];
    status?: UserStatus;
    pointsBalance?: number;
    planId?: string;
}) {
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName || username);
    validateUsername(username);
    validatePassword(input.password);
    if (email) validateEmail(email);

    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const clock = walletClock();
        return withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const repos = createPostgresRepositories(client);
            const actor = await repos.users.getById(input.actorId, true);
            assertCanCreateManagedUser(actor, input);
            const settings = await readPostgresAuthSettings(client);
            assertNoIdentityConflict(await repos.users.findIdentityConflict({ username, email: email || undefined }), username, email);
            const plan = resolvePlanById(settings.entitlements, input.planId);
            const pointsBalance = normalizePoints(input.pointsBalance, resolveInitialUserPoints({ settings }, plan));
            const intendedStatus = input.status === "disabled" ? "disabled" : "active";
            const now = clock.now.toISOString();
            const user = await repos.users.createWithNextAccountId({
                id: randomUUID(),
                username,
                email: email || undefined,
                displayName,
                bio: "",
                role: input.role === "admin" ? "admin" : "user",
                adminPermissions: input.role === "admin" ? normalizeAdminPermissions(input.adminPermissions) : [],
                status: "active",
                planId: plan.id,
                pointsBalance: 0,
                passwordHash: await hashPassword(input.password),
                createdAt: now,
                updatedAt: now,
            });
            if (isTenantMvpEnabled() && user.role === "user") await createPersonalTenant(repos, user, now, input.actorId);
            if (pointsBalance) {
                await adjustPermanentPointsInPostgresTransaction(client, {
                    userId: user.id,
                    amount: pointsBalance,
                    description: "管理员创建用户",
                    idempotencyKey: `admin-create:${user.id}`,
                    type: "admin-adjust",
                    now: clock.now,
                });
            }
            if (intendedStatus !== "active") await repos.users.update(user.id, { status: intendedStatus });
            const record = (await repos.users.getPublicDetails([user.id], { now, date: clock.date }))[0];
            if (!record) throw new AuthInputError("用户创建失败");
            return publicUserFromAuthenticatedRecord(record, clock.expiresAt);
        });
    }

    return mutateAuthDb(async (db) => {
        const actor = db.users.find((user) => user.id === input.actorId);
        assertCanCreateManagedUser(actor, input);
        if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new AuthInputError("用户名已存在");
        if (email && db.users.some((user) => user.email?.toLowerCase() === email.toLowerCase())) throw new AuthInputError("邮箱已被注册");

        const now = new Date().toISOString();
        const plan = resolvePlanById(db.settings.entitlements, input.planId);
        const pointsBalance = normalizePoints(input.pointsBalance, resolveInitialUserPoints(db, plan));
        const intendedStatus = input.status === "disabled" ? "disabled" : "active";
        const user: StoredUser = {
            id: randomUUID(),
            accountId: takeNextFileAccountId(db),
            username,
            email: email || undefined,
            displayName,
            bio: "",
            role: input.role === "admin" ? "admin" : "user",
            adminPermissions: input.role === "admin" ? normalizeAdminPermissions(input.adminPermissions) : [],
            status: "active",
            planId: plan.id,
            pointsBalance: 0,
            passwordHash: await hashPassword(input.password),
            createdAt: now,
            updatedAt: now,
        };
        db.users.push(user);
        const wallet = pointsBalance ? adjustPermanentPointsInAuthDb(db, { userId: user.id, amount: pointsBalance, description: "管理员创建用户", idempotencyKey: `admin-create:${user.id}`, now: new Date(now) }) : null;
        user.status = intendedStatus;
        return { ...toPublicUser(user, db), pointsBalance: wallet?.snapshot.totalPoints || 0 };
    });
}

export async function authenticateUser(input: { username: string; password: string; totpCode?: string }) {
    const account = normalizeUsername(input.username);
    const accountEmail = normalizeEmail(input.username);
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const repos = createPostgresRepositories();
        const user = await repos.users.getByLogin(account, accountEmail || undefined);
        const passwordMatches = await verifyPasswordWithDummy(input.password, user?.passwordHash);
        if (!user || !passwordMatches) throw new AuthInputError("用户名或密码不正确");
        if (user.status !== "active") throw new AuthInputError("账号已被禁用");
        if (isTenantMvpEnabled() && user.role === "user" && !(await repos.tenants.findContextByUserId(user.id))) throw new AuthInputError("账号已被租户禁用");
        verifyAdminMfaForLogin(user, input.totpCode);

        const lastLoginAt = new Date().toISOString();
        await repos.users.update(user.id, { lastLoginAt });
        const clock = walletClock();
        const details = await repos.users.getPublicDetails([user.id], { now: clock.now.toISOString(), date: clock.date });
        const snapshot = details[0];
        return snapshot ? publicUserFromAuthenticatedRecord(snapshot, clock.expiresAt) : toPublicUser({ ...user, lastLoginAt });
    }
    const db = await readAuthDb();
    const user = db.users.find((item) => item.username.toLowerCase() === account.toLowerCase() || (accountEmail && item.email?.toLowerCase() === accountEmail));
    const passwordMatches = await verifyPasswordWithDummy(input.password, user?.passwordHash);
    if (!user || !passwordMatches) throw new AuthInputError("用户名或密码不正确");
    if (user.status !== "active") throw new AuthInputError("账号已被禁用");
    verifyAdminMfaForLogin(user, input.totpCode);

    await mutateAuthDb((nextDb) => {
        const nextUser = nextDb.users.find((item) => item.id === user.id);
        if (nextUser) {
            nextUser.lastLoginAt = new Date().toISOString();
            nextUser.updatedAt = nextUser.lastLoginAt;
        }
    });

    return toPublicUser({ ...user, lastLoginAt: new Date().toISOString() }, db);
}

export async function createEmailVerificationCode(input: { purpose: EmailCodePurpose; email: string; userId?: string }) {
    if (isPostgresDatabaseEnabled()) {
        const email = normalizeEmail(input.email);
        validateEmail(email);
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            await lockAuthMutation(client);
            const repos = createPostgresRepositories(client);
            const settings = await readPostgresAuthSettings(client);
            const now = new Date();

            if (input.purpose === "register") {
                if (!settings.emailRegistrationEnabled) throw new AuthInputError("当前未开启邮箱注册");
                if (await repos.users.getByEmail(email)) throw new AuthInputError("邮箱已被注册");
            }
            if (input.purpose === "email-change") {
                if (!input.userId) throw new AuthInputError("请先登录");
                if (await repos.users.findIdentityConflict({ email, excludingUserId: input.userId })) throw new AuthInputError("邮箱已被注册");
            }
            const code = randomNumericCode();
            if (input.purpose === "password-reset" && !(await repos.users.getByEmail(email))) return { code, email, deliverEmail: false };

            const activeCode = await repos.emailCodes.findActive({ purpose: input.purpose, email, userId: input.userId, now: now.toISOString() }, true);
            if (activeCode && now.getTime() - Date.parse(activeCode.createdAt) < EMAIL_CODE_RESEND_COOLDOWN_MS) throw new AuthInputError("验证码发送过于频繁，请 60 秒后再试");

            await repos.emailCodes.deleteUnconsumed({ purpose: input.purpose, email, userId: input.userId });
            await repos.emailCodes.create({
                id: randomUUID(),
                purpose: input.purpose,
                email,
                userId: input.userId,
                codeHash: hashToken(code),
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + EMAIL_CODE_MAX_AGE_MS).toISOString(),
                attempts: 0,
            });
            return { code, email, deliverEmail: true };
        });
    }
    return mutateAuthDb((db) => {
        const email = normalizeEmail(input.email);
        validateEmail(email);
        const now = new Date();

        if (input.purpose === "register") {
            if (!db.settings.emailRegistrationEnabled) throw new AuthInputError("当前未开启邮箱注册");
            if (db.users.some((user) => user.email?.toLowerCase() === email.toLowerCase())) throw new AuthInputError("邮箱已被注册");
        }

        if (input.purpose === "email-change") {
            if (!input.userId) throw new AuthInputError("请先登录");
            if (db.users.some((user) => user.id !== input.userId && user.email?.toLowerCase() === email.toLowerCase())) throw new AuthInputError("邮箱已被注册");
        }

        const code = randomNumericCode();
        if (input.purpose === "password-reset" && !db.users.some((user) => user.email?.toLowerCase() === email.toLowerCase())) return { code, email, deliverEmail: false };
        const activeCode = db.emailCodes.find((item) => item.purpose === input.purpose && item.email === email && item.userId === input.userId && !item.consumedAt && Date.parse(item.expiresAt) > now.getTime());
        if (activeCode && now.getTime() - Date.parse(activeCode.createdAt) < EMAIL_CODE_RESEND_COOLDOWN_MS) {
            throw new AuthInputError("验证码发送过于频繁，请 60 秒后再试");
        }
        db.emailCodes = db.emailCodes.filter((item) => !(item.purpose === input.purpose && item.email === email && item.userId === input.userId && !item.consumedAt));
        db.emailCodes.push({
            id: randomUUID(),
            purpose: input.purpose,
            email,
            userId: input.userId,
            codeHash: hashToken(code),
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + EMAIL_CODE_MAX_AGE_MS).toISOString(),
            attempts: 0,
        });
        return { code, email, deliverEmail: true };
    });
}

function takeNextFileAccountId(db: AuthDatabase) {
    const accountId = Math.max(1, Math.floor(db.nextUserAccountId || 1));
    db.nextUserAccountId = accountId + 1;
    return formatAccountId(accountId);
}

function assertNoIdentityConflict(conflict: StoredUser | null, username: string, email: string) {
    if (!conflict) return;
    if (conflict.username.toLowerCase() === username.toLowerCase()) throw new AuthInputError("用户名已存在");
    if (email && conflict.email?.toLowerCase() === email.toLowerCase()) throw new AuthInputError("邮箱已被注册");
}

function assertCanCreateManagedUser(actor: StoredUser | null | undefined, input: { role?: UserRole; adminPermissions?: AdminPermission[]; pointsBalance?: number; planId?: string }) {
    if (input.role === "admin") {
        assertAdminPermission(actor, "administrators.manage");
        const permissions = normalizeAdminPermissions(input.adminPermissions);
        if (!permissions.length) throw new AuthInputError("管理员至少需要一项职责权限");
        if (!hasAllAdminPermissions(actor, permissions)) throw new AuthInputError("不能授予超出当前管理员职责范围的权限", 403);
    } else {
        assertAdminPermission(actor, "users.manage");
    }
    if ((Number(input.pointsBalance) || 0) !== 0 || input.planId !== undefined) assertAdminPermission(actor, "billing.manage");
}

function assertAdminPermission(actor: StoredUser | null | undefined, permission: AdminPermission) {
    if (!hasAdminPermission(actor, permission)) throw new AuthInputError("当前管理员没有执行此操作的职责权限", 403);
}
