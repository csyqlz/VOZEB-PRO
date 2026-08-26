import { formatAccountId } from "@/lib/account-id";
import type { QueryExecutor } from "@/lib/server/database/postgres";
import type {
    AuthenticatedUserRecord,
    CdkCodeCreateRecord,
    CdkCodeRecord,
    CdkListInput,
    CdkListResult,
    CdkRedemptionRecord,
    EmailCodeRecord,
    PageInput,
    PageResult,
    PointRecord,
    PointRecordInput,
    QuotaUsageRecord,
    SessionRecord,
    UsageKind,
    UserRecord,
    UserRole,
    UserStatus,
    UserSummaryRecord,
} from "./repository-shared";
import { mapCdkCode, mapCdkRedemption, mapEmailCode, mapPointRecord, mapQuotaUsage, mapSession, mapUser } from "./repository-record-mappers";
import { jsonValue, normalizePage, normalizePageSize, numberValue, optionalString, pageResult, stringValue } from "./repository-shared";

function assignmentDailyPoints(metadata: unknown, fallback: number) {
    const value = jsonValue(metadata);
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const configured = Number(value.dailyPoints);
        if (Number.isFinite(configured)) return nonNegativeNumber(configured);
    }
    return nonNegativeNumber(fallback);
}

function nonNegativeNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

type UserUpdatePatch = Partial<Omit<UserRecord, "id" | "createdAt" | "updatedAt" | "email" | "avatarStorageKey" | "mfaSecretCiphertext" | "mfaEnabledAt">> & {
    email?: string | null;
    avatarStorageKey?: string | null;
    mfaSecretCiphertext?: string | null;
    mfaEnabledAt?: string | null;
};

export class UsersRepository {
    constructor(private readonly db: QueryExecutor) {}

    async list(input: PageInput & { keyword?: string; role?: UserRole; status?: UserStatus } = {}): Promise<PageResult<UserRecord>> {
        const page = normalizePage(input.page);
        const pageSize = normalizePageSize(input.pageSize);
        const keyword = input.keyword?.trim().toLowerCase() || "";
        const params = [keyword, `%${keyword}%`, input.role || null, input.status || null];
        const countResult = await this.db.query(
            `
            SELECT count(*) AS total
            FROM users
            WHERE (
                $1 = ''
                OR lower(username) LIKE $2
                OR lpad(account_id::text, 4, '0') LIKE $2
                OR lower(coalesce(email, '')) LIKE $2
                OR lower(display_name) LIKE $2
                OR lower(role) LIKE $2
                OR lower(status) LIKE $2
                OR CASE WHEN role = 'admin' THEN '管理员' ELSE '普通用户' END LIKE $2
                OR CASE WHEN status = 'active' THEN '可用' ELSE '禁用' END LIKE $2
            )
              AND ($3::text IS NULL OR role = $3)
              AND ($4::text IS NULL OR status = $4)
            `,
            params,
        );
        const total = numberValue(countResult.rows[0]?.total);
        const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
        const result = await this.db.query(
            `
            SELECT *
            FROM users
            WHERE (
                $1 = ''
                OR lower(username) LIKE $2
                OR lpad(account_id::text, 4, '0') LIKE $2
                OR lower(coalesce(email, '')) LIKE $2
                OR lower(display_name) LIKE $2
                OR lower(role) LIKE $2
                OR lower(status) LIKE $2
                OR CASE WHEN role = 'admin' THEN '管理员' ELSE '普通用户' END LIKE $2
                OR CASE WHEN status = 'active' THEN '可用' ELSE '禁用' END LIKE $2
            )
              AND ($3::text IS NULL OR role = $3)
              AND ($4::text IS NULL OR status = $4)
            ORDER BY created_at DESC
            LIMIT $5 OFFSET $6
            `,
            [...params, pageSize, (safePage - 1) * pageSize],
        );
        return pageResult(result.rows.map(mapUser), total, safePage, pageSize);
    }

    async getPublicDetails(userIds: string[], input: { now: string; date: string }): Promise<AuthenticatedUserRecord[]> {
        if (!userIds.length) return [];
        const result = await this.db.query(
            `
            SELECT
                users.*,
                resolved_plan.id AS resolved_plan_id,
                resolved_plan.name AS resolved_plan_name,
                resolved_plan.daily_points AS resolved_plan_daily_points,
                active_assignment.id AS active_assignment_id,
                active_assignment.metadata AS active_assignment_metadata,
                app_settings.free_daily_points_enabled,
                app_settings.free_daily_points,
                daily_wallet.user_id AS daily_wallet_user_id,
                daily_wallet.plan_id AS daily_wallet_plan_id,
                daily_wallet.assignment_id AS daily_wallet_assignment_id,
                daily_wallet.granted_points AS daily_wallet_granted_points,
                daily_wallet.remaining_points AS daily_wallet_remaining_points
            FROM users
            LEFT JOIN app_settings ON app_settings.id = 'default'
            LEFT JOIN LATERAL (
                SELECT assignments.id, assignments.plan_id, assignments.metadata
                FROM user_plan_assignments AS assignments
                INNER JOIN entitlement_plans AS assignment_plan ON assignment_plan.id = assignments.plan_id AND assignment_plan.enabled = true
                WHERE assignments.user_id = users.id
                  AND assignments.status = 'active'
                  AND assignments.starts_at <= $2
                  AND (assignments.ends_at IS NULL OR assignments.ends_at > $2)
                ORDER BY assignments.starts_at DESC, assignments.created_at DESC, assignments.id DESC
                LIMIT 1
            ) AS active_assignment ON true
            LEFT JOIN LATERAL (
                SELECT entitlement_plans.id, entitlement_plans.name, entitlement_plans.daily_points
                FROM entitlement_plans
                WHERE entitlement_plans.enabled = true
                ORDER BY
                    CASE
                        WHEN entitlement_plans.id = active_assignment.plan_id THEN 0
                        WHEN entitlement_plans.id = users.plan_id THEN 1
                        WHEN entitlement_plans.id = app_settings.default_plan_id THEN 2
                        ELSE 3
                    END,
                    entitlement_plans.sort_order ASC,
                    entitlement_plans.created_at ASC
                LIMIT 1
            ) AS resolved_plan ON true
            LEFT JOIN daily_plan_point_wallets AS daily_wallet
                ON daily_wallet.user_id = users.id AND daily_wallet.date = $3
            WHERE users.id = ANY($1::text[])
            `,
            [userIds, input.now, input.date],
        );
        return result.rows.map(mapAuthenticatedUser);
    }

    async summarize(input: { now: string; date: string }): Promise<UserSummaryRecord> {
        const result = await this.db.query(
            `
            WITH resolved_users AS (
                SELECT
                    users.id,
                    users.role,
                    users.status,
                    users.points_balance,
                    app_settings.default_plan_id,
                    app_settings.free_daily_points_enabled,
                    app_settings.free_daily_points,
                    resolved_plan.id AS resolved_plan_id,
                    resolved_plan.daily_points AS resolved_plan_daily_points,
                    active_assignment.id AS active_assignment_id,
                    active_assignment.metadata AS active_assignment_metadata,
                    daily_wallet.plan_id AS daily_wallet_plan_id,
                    daily_wallet.assignment_id AS daily_wallet_assignment_id,
                    daily_wallet.remaining_points AS daily_wallet_remaining_points
                FROM users
                LEFT JOIN app_settings ON app_settings.id = 'default'
                LEFT JOIN LATERAL (
                    SELECT assignments.id, assignments.plan_id, assignments.metadata
                    FROM user_plan_assignments AS assignments
                    INNER JOIN entitlement_plans AS assignment_plan ON assignment_plan.id = assignments.plan_id AND assignment_plan.enabled = true
                    WHERE assignments.user_id = users.id
                      AND assignments.status = 'active'
                      AND assignments.starts_at <= $1
                      AND (assignments.ends_at IS NULL OR assignments.ends_at > $1)
                    ORDER BY assignments.starts_at DESC, assignments.created_at DESC, assignments.id DESC
                    LIMIT 1
                ) AS active_assignment ON true
                LEFT JOIN LATERAL (
                    SELECT entitlement_plans.id, entitlement_plans.daily_points
                    FROM entitlement_plans
                    WHERE entitlement_plans.enabled = true
                    ORDER BY
                        CASE
                            WHEN entitlement_plans.id = active_assignment.plan_id THEN 0
                            WHEN entitlement_plans.id = users.plan_id THEN 1
                            WHEN entitlement_plans.id = app_settings.default_plan_id THEN 2
                            ELSE 3
                        END,
                        entitlement_plans.sort_order ASC,
                        entitlement_plans.created_at ASC
                    LIMIT 1
                ) AS resolved_plan ON true
                LEFT JOIN daily_plan_point_wallets AS daily_wallet
                    ON daily_wallet.user_id = users.id AND daily_wallet.date = $2
            )
            SELECT
                count(*) AS total,
                count(*) FILTER (WHERE status = 'active') AS active,
                count(*) FILTER (WHERE status = 'disabled') AS disabled,
                count(*) FILTER (WHERE role = 'admin') AS admins,
                count(*) FILTER (WHERE role = 'admin' AND status = 'active') AS active_admins,
                count(*) FILTER (WHERE active_assignment_id IS NOT NULL) AS users_with_plan,
                coalesce(sum(greatest(0, points_balance + CASE
                    WHEN resolved_plan_id IS NULL THEN 0
                    WHEN active_assignment_id IS NOT NULL THEN
                        CASE
                            WHEN daily_wallet_plan_id = resolved_plan_id AND coalesce(daily_wallet_assignment_id, '') = active_assignment_id
                                THEN greatest(0, coalesce(daily_wallet_remaining_points, 0))
                            WHEN active_assignment_metadata->>'dailyPoints' ~ '^-?[0-9]+([.][0-9]+)?$'
                                THEN greatest(0, (active_assignment_metadata->>'dailyPoints')::numeric)
                            ELSE greatest(0, coalesce(resolved_plan_daily_points, 0))
                        END
                    WHEN free_daily_points_enabled IS NOT FALSE THEN
                        CASE
                            WHEN daily_wallet_plan_id = resolved_plan_id AND daily_wallet_assignment_id IS NULL
                                THEN greatest(0, coalesce(daily_wallet_remaining_points, 0))
                            ELSE greatest(0, coalesce(free_daily_points, 0))
                        END
                    ELSE 0
                END)), 0) AS total_points_balance
            FROM resolved_users
            `,
            [input.now, input.date],
        );
        const row = result.rows[0] || {};
        return {
            total: numberValue(row.total),
            active: numberValue(row.active),
            disabled: numberValue(row.disabled),
            admins: numberValue(row.admins),
            activeAdmins: numberValue(row.active_admins),
            usersWithPlan: numberValue(row.users_with_plan),
            totalPointsBalance: numberValue(row.total_points_balance),
        };
    }

    async getById(id: string, forUpdate = false) {
        const result = await this.db.query(`SELECT * FROM users WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async count() {
        const result = await this.db.query("SELECT count(*) AS total FROM users");
        return numberValue(result.rows[0]?.total);
    }

    async getByUsername(username: string) {
        const result = await this.db.query("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async getByEmail(email: string, forUpdate = false) {
        const result = await this.db.query(`SELECT * FROM users WHERE lower(email) = lower($1)${forUpdate ? " FOR UPDATE" : ""}`, [email]);
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async findIdentityConflict(input: { username?: string; email?: string; excludingUserId?: string }) {
        const result = await this.db.query(
            `SELECT * FROM users
             WHERE (
                 ($1::text IS NOT NULL AND lower(username) = lower($1))
                 OR ($2::text IS NOT NULL AND lower(coalesce(email, '')) = lower($2))
             )
               AND ($3::text IS NULL OR id <> $3)
             ORDER BY created_at ASC
             LIMIT 1`,
            [input.username || null, input.email || null, input.excludingUserId || null],
        );
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async getByPublicIdentity(identity: string) {
        const result = await this.db.query(
            `SELECT * FROM users
             WHERE lower(username) = lower($1) OR id = $1
             ORDER BY CASE WHEN lower(username) = lower($1) THEN 0 ELSE 1 END
             LIMIT 1`,
            [identity],
        );
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async getByLogin(username: string, email?: string) {
        const result = await this.db.query(
            `
            SELECT *
            FROM users
            WHERE lower(username) = lower($1)
               OR ($2::text IS NOT NULL AND lower(coalesce(email, '')) = lower($2))
            ORDER BY CASE WHEN lower(username) = lower($1) THEN 0 ELSE 1 END
            LIMIT 1
            `,
            [username, email || null],
        );
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async create(user: UserRecord) {
        const result = await this.db.query(
            `
            INSERT INTO users (id, account_id, username, email, display_name, bio, avatar_storage_key, role, admin_permissions, status, plan_id, points_balance, password_hash, mfa_secret_ciphertext, mfa_enabled_at, terms_version, terms_url, privacy_version, privacy_url, policy_accepted_at, last_login_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::numeric, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
            RETURNING *
            `,
            [
                user.id,
                Number(user.accountId),
                user.username,
                user.email || null,
                user.displayName,
                user.bio,
                user.avatarStorageKey || null,
                user.role,
                JSON.stringify(user.adminPermissions),
                user.status,
                user.planId,
                user.pointsBalance,
                user.passwordHash,
                user.mfaSecretCiphertext || null,
                user.mfaEnabledAt || null,
                user.registrationConsent?.termsVersion || null,
                user.registrationConsent?.termsUrl || null,
                user.registrationConsent?.privacyVersion || null,
                user.registrationConsent?.privacyUrl || null,
                user.registrationConsent?.acceptedAt || null,
                user.lastLoginAt || null,
                user.createdAt,
                user.updatedAt,
            ],
        );
        return mapUser(result.rows[0]);
    }

    async createWithNextAccountId(user: Omit<UserRecord, "accountId">) {
        const result = await this.db.query(
            `
            INSERT INTO users (id, account_id, username, email, display_name, bio, avatar_storage_key, role, admin_permissions, status, plan_id, points_balance, password_hash, mfa_secret_ciphertext, mfa_enabled_at, terms_version, terms_url, privacy_version, privacy_url, policy_accepted_at, last_login_at, created_at, updated_at)
            VALUES ($1, nextval('user_account_id_seq'), $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::numeric, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
            RETURNING *
            `,
            [
                user.id,
                user.username,
                user.email || null,
                user.displayName,
                user.bio,
                user.avatarStorageKey || null,
                user.role,
                JSON.stringify(user.adminPermissions),
                user.status,
                user.planId,
                user.pointsBalance,
                user.passwordHash,
                user.mfaSecretCiphertext || null,
                user.mfaEnabledAt || null,
                user.registrationConsent?.termsVersion || null,
                user.registrationConsent?.termsUrl || null,
                user.registrationConsent?.privacyVersion || null,
                user.registrationConsent?.privacyUrl || null,
                user.registrationConsent?.acceptedAt || null,
                user.lastLoginAt || null,
                user.createdAt,
                user.updatedAt,
            ],
        );
        return mapUser(result.rows[0]);
    }

    async update(id: string, patch: UserUpdatePatch) {
        const hasEmail = Object.prototype.hasOwnProperty.call(patch, "email");
        const hasAvatarStorageKey = Object.prototype.hasOwnProperty.call(patch, "avatarStorageKey");
        const hasMfaSecret = Object.prototype.hasOwnProperty.call(patch, "mfaSecretCiphertext");
        const hasMfaEnabledAt = Object.prototype.hasOwnProperty.call(patch, "mfaEnabledAt");
        const hasAdminPermissions = Object.prototype.hasOwnProperty.call(patch, "adminPermissions");
        const result = await this.db.query(
            `
            UPDATE users SET
                username = COALESCE($2, username),
                email = CASE WHEN $3::boolean THEN $4 ELSE email END,
                display_name = COALESCE($5, display_name),
                bio = COALESCE($6, bio),
                avatar_storage_key = CASE WHEN $7::boolean THEN $8 ELSE avatar_storage_key END,
                role = COALESCE($9, role),
                admin_permissions = CASE WHEN $10::boolean THEN $11::jsonb ELSE admin_permissions END,
                status = COALESCE($12, status),
                plan_id = COALESCE($13, plan_id),
                points_balance = COALESCE($14::numeric, points_balance),
                password_hash = COALESCE($15, password_hash),
                last_login_at = COALESCE($16, last_login_at),
                mfa_secret_ciphertext = CASE WHEN $17::boolean THEN $18 ELSE mfa_secret_ciphertext END,
                mfa_enabled_at = CASE WHEN $19::boolean THEN $20 ELSE mfa_enabled_at END,
                updated_at = now()
            WHERE id = $1
            RETURNING *
            `,
            [
                id,
                patch.username,
                hasEmail,
                patch.email ?? null,
                patch.displayName,
                patch.bio,
                hasAvatarStorageKey,
                patch.avatarStorageKey ?? null,
                patch.role,
                hasAdminPermissions,
                JSON.stringify(patch.adminPermissions || []),
                patch.status,
                patch.planId,
                patch.pointsBalance,
                patch.passwordHash,
                patch.lastLoginAt,
                hasMfaSecret,
                patch.mfaSecretCiphertext ?? null,
                hasMfaEnabledAt,
                patch.mfaEnabledAt ?? null,
            ],
        );
        return result.rows[0] ? mapUser(result.rows[0]) : null;
    }

    async delete(id: string) {
        const result = await this.db.query("DELETE FROM users WHERE id = $1", [id]);
        return result.rowCount || 0;
    }

    async countActiveAdmins(excludingUserId?: string) {
        const result = await this.db.query("SELECT count(*) AS total FROM users WHERE role = 'admin' AND status = 'active' AND ($1::text IS NULL OR id <> $1)", [excludingUserId || null]);
        return Number(result.rows[0]?.total || 0);
    }

    async lockActiveAdminIds() {
        const result = await this.db.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE");
        return result.rows.map((row) => String(row.id));
    }

    async lockActiveFullAdminIds(requiredPermissions: readonly string[]) {
        const result = await this.db.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND admin_permissions @> $1::jsonb ORDER BY created_at ASC, id ASC FOR UPDATE", [JSON.stringify(requiredPermissions)]);
        return result.rows.map((row) => stringValue(row.id));
    }
}

export class SessionsRepository {
    constructor(private readonly db: QueryExecutor) {}

    async create(session: SessionRecord) {
        const result = await this.db.query("INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING *", [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt]);
        return mapSession(result.rows[0]);
    }

    async deleteByUserIdExcept(userId: string, sessionId: string) {
        const result = await this.db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, sessionId]);
        return result.rowCount || 0;
    }

    async getByTokenHash(tokenHash: string) {
        const result = await this.db.query("SELECT * FROM sessions WHERE token_hash = $1", [tokenHash]);
        return result.rows[0] ? mapSession(result.rows[0]) : null;
    }

    async getAuthenticatedUser(input: { sessionId: string; tokenHash: string; now: string; date: string }): Promise<AuthenticatedUserRecord | null> {
        const result = await this.db.query(
            `
            SELECT
                users.*,
                resolved_plan.id AS resolved_plan_id,
                resolved_plan.name AS resolved_plan_name,
                resolved_plan.daily_points AS resolved_plan_daily_points,
                active_assignment.id AS active_assignment_id,
                active_assignment.metadata AS active_assignment_metadata,
                app_settings.free_daily_points_enabled,
                app_settings.free_daily_points,
                daily_wallet.user_id AS daily_wallet_user_id,
                daily_wallet.plan_id AS daily_wallet_plan_id,
                daily_wallet.assignment_id AS daily_wallet_assignment_id,
                daily_wallet.granted_points AS daily_wallet_granted_points,
                daily_wallet.remaining_points AS daily_wallet_remaining_points
            FROM sessions
            INNER JOIN users ON users.id = sessions.user_id
            LEFT JOIN app_settings ON app_settings.id = 'default'
            LEFT JOIN LATERAL (
                SELECT assignments.id, assignments.plan_id, assignments.metadata
                FROM user_plan_assignments AS assignments
                INNER JOIN entitlement_plans AS assignment_plan ON assignment_plan.id = assignments.plan_id AND assignment_plan.enabled = true
                WHERE assignments.user_id = users.id
                  AND assignments.status = 'active'
                  AND assignments.starts_at <= $3
                  AND (assignments.ends_at IS NULL OR assignments.ends_at > $3)
                ORDER BY assignments.starts_at DESC, assignments.created_at DESC, assignments.id DESC
                LIMIT 1
            ) AS active_assignment ON true
            LEFT JOIN LATERAL (
                SELECT entitlement_plans.id, entitlement_plans.name, entitlement_plans.daily_points
                FROM entitlement_plans
                WHERE entitlement_plans.enabled = true
                ORDER BY
                    CASE
                        WHEN entitlement_plans.id = active_assignment.plan_id THEN 0
                        WHEN entitlement_plans.id = users.plan_id THEN 1
                        WHEN entitlement_plans.id = app_settings.default_plan_id THEN 2
                        ELSE 3
                    END,
                    entitlement_plans.sort_order ASC,
                    entitlement_plans.created_at ASC
                LIMIT 1
            ) AS resolved_plan ON true
            LEFT JOIN daily_plan_point_wallets AS daily_wallet
                ON daily_wallet.user_id = users.id AND daily_wallet.date = $4
            WHERE sessions.id = $1
              AND sessions.token_hash = $2
              AND sessions.expires_at > $3
              AND users.status = 'active'
            LIMIT 1
            `,
            [input.sessionId, input.tokenHash, input.now, input.date],
        );
        return result.rows[0] ? mapAuthenticatedUser(result.rows[0]) : null;
    }

    async deleteByTokenHash(tokenHash: string) {
        const result = await this.db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
        return result.rowCount || 0;
    }

    async deleteById(id: string) {
        const result = await this.db.query("DELETE FROM sessions WHERE id = $1", [id]);
        return result.rowCount || 0;
    }

    async deleteByUserId(userId: string) {
        const result = await this.db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
        return result.rowCount || 0;
    }

    async pruneExpired(now: Date, limit: number) {
        const result = await this.db.query(
            `WITH candidates AS (
                SELECT id FROM sessions
                WHERE expires_at <= $1
                ORDER BY expires_at ASC, id ASC
                LIMIT $2
            )
            DELETE FROM sessions
            USING candidates
            WHERE sessions.id = candidates.id`,
            [now.toISOString(), limit],
        );
        return result.rowCount || 0;
    }
}

export class EmailCodesRepository {
    constructor(private readonly db: QueryExecutor) {}

    async findActive(input: { purpose: EmailCodeRecord["purpose"]; email: string; userId?: string; now: string }, forUpdate = false) {
        const result = await this.db.query(
            `SELECT * FROM email_codes
             WHERE purpose = $1
               AND lower(email) = lower($2)
               AND user_id IS NOT DISTINCT FROM $3::text
               AND consumed_at IS NULL
               AND expires_at > $4
             ORDER BY created_at DESC
             LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
            [input.purpose, input.email, input.userId || null, input.now],
        );
        return result.rows[0] ? mapEmailCode(result.rows[0]) : null;
    }

    async create(code: EmailCodeRecord) {
        const result = await this.db.query("INSERT INTO email_codes (id, purpose, email, user_id, code_hash, created_at, expires_at, consumed_at, attempts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *", [
            code.id,
            code.purpose,
            code.email,
            code.userId || null,
            code.codeHash,
            code.createdAt,
            code.expiresAt,
            code.consumedAt || null,
            code.attempts,
        ]);
        return mapEmailCode(result.rows[0]);
    }

    async deleteUnconsumed(input: { purpose: EmailCodeRecord["purpose"]; email: string; userId?: string }) {
        const result = await this.db.query("DELETE FROM email_codes WHERE purpose = $1 AND lower(email) = lower($2) AND user_id IS NOT DISTINCT FROM $3::text AND consumed_at IS NULL", [input.purpose, input.email, input.userId || null]);
        return result.rowCount || 0;
    }

    async updateAttempt(id: string, attempts: number, consumedAt?: string) {
        const result = await this.db.query("UPDATE email_codes SET attempts = $2, consumed_at = $3 WHERE id = $1 RETURNING *", [id, attempts, consumedAt || null]);
        return result.rows[0] ? mapEmailCode(result.rows[0]) : null;
    }

    async pruneExpired(now: Date, limit: number) {
        const result = await this.db.query(
            `WITH candidates AS (
                SELECT id FROM email_codes
                WHERE expires_at <= $1 OR consumed_at IS NOT NULL
                ORDER BY COALESCE(consumed_at, expires_at) ASC, id ASC
                LIMIT $2
            )
            DELETE FROM email_codes
            USING candidates
            WHERE email_codes.id = candidates.id`,
            [now.toISOString(), limit],
        );
        return result.rowCount || 0;
    }
}

function mapAuthenticatedUser(row: Record<string, unknown>): AuthenticatedUserRecord {
    const user = mapUser(row);
    const planId = stringValue(row.resolved_plan_id) || user.planId;
    const assignmentId = optionalString(row.active_assignment_id);
    const configuredDailyPoints = assignmentId ? assignmentDailyPoints(row.active_assignment_metadata, numberValue(row.resolved_plan_daily_points)) : row.free_daily_points_enabled === false ? 0 : nonNegativeNumber(row.free_daily_points);
    const walletExists = row.daily_wallet_user_id !== null && row.daily_wallet_user_id !== undefined;
    const walletMatches = walletExists && stringValue(row.daily_wallet_plan_id) === planId && (optionalString(row.daily_wallet_assignment_id) || "") === (assignmentId || "");
    const consumedDailyPoints = walletMatches ? Math.max(0, nonNegativeNumber(row.daily_wallet_granted_points) - nonNegativeNumber(row.daily_wallet_remaining_points)) : 0;
    return {
        user,
        planId,
        planName: stringValue(row.resolved_plan_name),
        hasActivePlan: Boolean(assignmentId),
        permanentPoints: numberValue(user.pointsBalance),
        dailyPoints: configuredDailyPoints > 0 ? Math.max(0, configuredDailyPoints - consumedDailyPoints) : 0,
    };
}

export class PointsRepository {
    constructor(private readonly db: QueryExecutor) {}

    async addRecord(record: PointRecordInput) {
        const permanentAmount = record.permanentAmount ?? record.amount;
        const dailyAmount = record.dailyAmount ?? 0;
        const permanentBalanceAfter = record.permanentBalanceAfter ?? record.balanceAfter;
        const dailyBalanceAfter = record.dailyBalanceAfter ?? 0;
        const result = await this.db.query(
            "INSERT INTO point_records (id, user_id, type, amount, balance_after, permanent_amount, daily_amount, permanent_balance_after, daily_balance_after, description, model, usage_kind, units, billing_detail, idempotency_key, request_fingerprint, source_record_id, source_date, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *",
            [
                record.id,
                record.userId,
                record.type,
                record.amount,
                record.balanceAfter,
                permanentAmount,
                dailyAmount,
                permanentBalanceAfter,
                dailyBalanceAfter,
                record.description,
                record.model || null,
                record.usageKind || null,
                record.units ?? null,
                record.billingDetail ? JSON.stringify(record.billingDetail) : null,
                record.idempotencyKey || null,
                record.requestFingerprint || null,
                record.sourceRecordId || null,
                record.sourceDate || null,
                record.createdAt,
            ],
        );
        return mapPointRecord(result.rows[0]);
    }

    async listRecords(userId: string, input: PageInput & { direction?: "credit" | "debit"; view?: "balance" | "consumption" } = {}): Promise<PageResult<PointRecord>> {
        const page = normalizePage(input.page);
        const pageSize = normalizePageSize(input.pageSize);
        const direction = input.direction === "credit" || input.direction === "debit" ? input.direction : null;
        const view = input.view === "consumption" ? input.view : null;
        const result = await this.db.query(
            `SELECT *, count(*) OVER() AS total_count
             FROM point_records
             WHERE user_id = $1
               AND ($2::text IS NULL OR ($2 = 'credit' AND amount > 0) OR ($2 = 'debit' AND amount < 0))
               AND ($3::text IS NULL OR NOT (COALESCE(billing_detail->>'estimated', 'false') = 'true' AND COALESCE(billing_detail->>'settlementStatus', '') = 'settled'))
             ORDER BY created_at DESC
             LIMIT $4 OFFSET $5`,
            [userId, direction, view, pageSize, (page - 1) * pageSize],
        );
        return pageResult(result.rows.map(mapPointRecord), Number(result.rows[0]?.total_count || 0), page, pageSize);
    }

    async getRecordById(id: string) {
        const result = await this.db.query("SELECT * FROM point_records WHERE id = $1", [id]);
        return result.rows[0] ? mapPointRecord(result.rows[0]) : null;
    }

    async updateBillingDetail(id: string, userId: string, billingDetail: PointRecord["billingDetail"]) {
        const result = await this.db.query("UPDATE point_records SET billing_detail = $3 WHERE id = $1 AND user_id = $2 RETURNING *", [id, userId, billingDetail ? JSON.stringify(billingDetail) : null]);
        return result.rows[0] ? mapPointRecord(result.rows[0]) : null;
    }

    async getRecordByIdempotencyKey(idempotencyKey: string) {
        const result = await this.db.query("SELECT * FROM point_records WHERE idempotency_key = $1", [idempotencyKey]);
        return result.rows[0] ? mapPointRecord(result.rows[0]) : null;
    }

    async getRefundRecordBySourceRecordId(sourceRecordId: string) {
        const result = await this.db.query("SELECT * FROM point_records WHERE type = 'refund' AND source_record_id = $1 LIMIT 1", [sourceRecordId]);
        return result.rows[0] ? mapPointRecord(result.rows[0]) : null;
    }

    async getQuotaUsage(userId: string, date: string, usageKind: UsageKind) {
        const result = await this.db.query("SELECT * FROM quota_usage WHERE user_id = $1 AND date = $2 AND usage_kind = $3", [userId, date, usageKind]);
        return result.rows[0] ? mapQuotaUsage(result.rows[0]) : null;
    }

    async upsertQuotaUsage(usage: QuotaUsageRecord) {
        const result = await this.db.query(
            `
            INSERT INTO quota_usage (user_id, date, usage_kind, points_spent, units, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_id, date, usage_kind) DO UPDATE SET
                points_spent = EXCLUDED.points_spent,
                units = EXCLUDED.units,
                updated_at = EXCLUDED.updated_at
            RETURNING *
            `,
            [usage.userId, usage.date, usage.usageKind, usage.pointsSpent, usage.units, usage.updatedAt],
        );
        return mapQuotaUsage(result.rows[0]);
    }
}

export class CdkRepository {
    constructor(private readonly db: QueryExecutor) {}

    async list(input: CdkListInput = {}): Promise<CdkListResult> {
        const page = normalizePage(input.page);
        const pageSize = normalizePageSize(input.pageSize);
        const keyword = input.keyword?.trim().toLowerCase() || "";
        const codeHash = input.codeHash?.trim() || "";
        const filter = input.filter === "redeemed" || input.filter === "unused" || input.filter === "expired" ? input.filter : "all";
        const params = [keyword, `%${keyword}%`, codeHash, filter];
        const where = `
            WHERE codes.status = 'active'
              AND codes.code_ciphertext <> ''
              AND (
                  $1 = ''
                  OR lower(codes.code_preview) LIKE $2
                  OR lower(codes.note) LIKE $2
                  OR codes.code_hash = $3
                  OR EXISTS (
                      SELECT 1
                      FROM cdk_redemptions AS search_redemptions
                      INNER JOIN users AS search_users ON search_users.id = search_redemptions.user_id
                      WHERE search_redemptions.cdk_code_id = codes.id
                        AND (
                            lower(search_users.username) LIKE $2
                            OR lower(coalesce(search_users.display_name, '')) LIKE $2
                            OR lpad(search_users.account_id::text, 4, '0') LIKE $2
                        )
                  )
              )
              AND (
                  $4 = 'all'
                  OR ($4 = 'redeemed' AND codes.redeemed_count > 0)
                  OR ($4 = 'unused' AND codes.redeemed_count <= 0 AND (codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP))
                  OR ($4 = 'expired' AND codes.expires_at IS NOT NULL AND codes.expires_at <= CURRENT_TIMESTAMP)
              )
        `;
        const [countResult, statsResult] = await Promise.all([
            this.db.query(`SELECT count(*) AS total FROM cdk_codes AS codes ${where}`, params),
            this.db.query(
                `
                SELECT
                    count(*) AS total,
                    count(*) FILTER (WHERE redeemed_count > 0) AS redeemed,
                    count(*) FILTER (WHERE redeemed_count <= 0 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)) AS unused,
                    count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS expired
                FROM cdk_codes
                WHERE status = 'active'
                  AND code_ciphertext <> ''
                `,
            ),
        ]);
        const total = numberValue(countResult.rows[0]?.total);
        const safePage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
        const result = await this.db.query(
            `
            SELECT codes.*, COALESCE(redemption_data.redemptions, '[]'::json) AS redemptions
            FROM cdk_codes AS codes
            LEFT JOIN LATERAL (
                SELECT json_agg(
                    json_build_object(
                        'cdk_code_id', redemptions.cdk_code_id,
                        'user_id', redemptions.user_id,
                        'redeemed_at', redemptions.redeemed_at,
                        'account_id', users.account_id,
                        'username', users.username,
                        'display_name', users.display_name
                    ) ORDER BY redemptions.redeemed_at ASC
                ) AS redemptions
                FROM cdk_redemptions AS redemptions
                LEFT JOIN users ON users.id = redemptions.user_id
                WHERE redemptions.cdk_code_id = codes.id
            ) AS redemption_data ON true
            ${where}
            ORDER BY codes.created_at DESC
            LIMIT $5 OFFSET $6
            `,
            [...params, pageSize, (safePage - 1) * pageSize],
        );
        const statsRow = statsResult.rows[0] || {};
        return {
            items: result.rows.map(mapCdkListCode),
            total,
            page: safePage,
            pageSize,
            stats: {
                total: numberValue(statsRow.total),
                redeemed: numberValue(statsRow.redeemed),
                unused: numberValue(statsRow.unused),
                expired: numberValue(statsRow.expired),
            },
        };
    }

    async getById(id: string, forUpdate = false) {
        const result = await this.db.query(`SELECT * FROM cdk_codes WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
        return result.rows[0] ? mapCdkCode(result.rows[0]) : null;
    }

    async getDetailsById(id: string, forUpdate = false) {
        const result = await this.db.query(
            `SELECT codes.*, COALESCE(redemption_data.redemptions, '[]'::json) AS redemptions
             FROM cdk_codes AS codes
             LEFT JOIN LATERAL (
                 SELECT json_agg(
                     json_build_object(
                         'cdk_code_id', redemptions.cdk_code_id,
                         'user_id', redemptions.user_id,
                         'redeemed_at', redemptions.redeemed_at,
                         'account_id', users.account_id,
                         'username', users.username,
                         'display_name', users.display_name
                     ) ORDER BY redemptions.redeemed_at ASC
                 ) AS redemptions
                 FROM cdk_redemptions AS redemptions
                 LEFT JOIN users ON users.id = redemptions.user_id
                 WHERE redemptions.cdk_code_id = codes.id
             ) AS redemption_data ON true
             WHERE codes.id = $1${forUpdate ? " FOR UPDATE OF codes" : ""}`,
            [id],
        );
        return result.rows[0] ? mapCdkListCode(result.rows[0]) : null;
    }

    async getByCodeHash(codeHash: string, forUpdate = false) {
        const result = await this.db.query(`SELECT * FROM cdk_codes WHERE code_hash = $1${forUpdate ? " FOR UPDATE" : ""}`, [codeHash]);
        return result.rows[0] ? mapCdkCode(result.rows[0]) : null;
    }

    async create(code: CdkCodeCreateRecord) {
        const result = await this.db.query(
            `
            INSERT INTO cdk_codes (id, code_hash, code_ciphertext, code_preview, points, max_redemptions, redeemed_count, status, note, expires_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
            `,
            [code.id, code.codeHash, code.codeCiphertext, code.codePreview, code.points, code.maxRedemptions, code.redeemedCount, code.status, code.note, code.expiresAt || null, code.createdAt, code.updatedAt],
        );
        return mapCdkCode(result.rows[0]);
    }

    async update(code: CdkCodeRecord) {
        const result = await this.db.query(
            `UPDATE cdk_codes SET
                points = $2,
                max_redemptions = $3,
                status = $4,
                note = $5,
                expires_at = $6,
                updated_at = $7
             WHERE id = $1
             RETURNING *`,
            [code.id, code.points, code.maxRedemptions, code.status, code.note, code.expiresAt || null, code.updatedAt],
        );
        return result.rows[0] ? mapCdkCode(result.rows[0]) : null;
    }

    async delete(ids: string[]) {
        if (!ids.length) return 0;
        const result = await this.db.query("DELETE FROM cdk_codes WHERE id = ANY($1::text[])", [ids]);
        return result.rowCount || 0;
    }

    async addRedemption(redemption: CdkRedemptionRecord) {
        const result = await this.db.query("INSERT INTO cdk_redemptions (cdk_code_id, user_id, redeemed_at) VALUES ($1, $2, $3) ON CONFLICT (cdk_code_id, user_id) DO NOTHING RETURNING *", [redemption.cdkCodeId, redemption.userId, redemption.redeemedAt]);
        return result.rows[0] ? mapCdkRedemption(result.rows[0]) : null;
    }

    async incrementRedemptionCount(id: string, updatedAt: string) {
        const result = await this.db.query("UPDATE cdk_codes SET redeemed_count = redeemed_count + 1, updated_at = $2 WHERE id = $1 RETURNING *", [id, updatedAt]);
        return result.rows[0] ? mapCdkCode(result.rows[0]) : null;
    }
}

function mapCdkListCode(row: Record<string, unknown>) {
    const redemptionsValue = jsonValue(row.redemptions);
    const redemptions = Array.isArray(redemptionsValue)
        ? redemptionsValue.flatMap((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return [];
              const item = value as Record<string, unknown>;
              return [
                  {
                      cdkCodeId: stringValue(item.cdk_code_id),
                      userId: stringValue(item.user_id),
                      redeemedAt: stringValue(item.redeemed_at),
                      accountId: item.account_id === undefined || item.account_id === null ? undefined : formatAccountId(item.account_id),
                      username: optionalString(item.username),
                      displayName: optionalString(item.display_name),
                  },
              ];
          })
        : [];
    return {
        ...mapCdkCode(row),
        codeCiphertext: stringValue(row.code_ciphertext),
        redemptions,
    };
}
