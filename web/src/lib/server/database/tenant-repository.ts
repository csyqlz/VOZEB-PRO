import type { TenantRole } from "@/lib/tenant-permissions";
import type { TenantContext, TenantListItem, TenantMemberItem, TenantMembershipRecord, TenantMembershipStatus, TenantOverviewAggregate, TenantOverviewBucket, TenantRecord } from "@/lib/tenant";

import type { QueryExecutor } from "./postgres";
import type { PageInput, PageResult } from "./repository-types";
import { isoValue, normalizePage, normalizePageSize, numberValue, optionalString, pageResult, stringValue } from "./repository-utils";

export class TenantRepository {
    constructor(private readonly db: QueryExecutor) {}

    async findContextByUserId(userId: string): Promise<TenantContext | null> {
        const result = await this.db.query(
            `SELECT memberships.tenant_id, tenants.name AS tenant_name, memberships.user_id, memberships.role, memberships.status
             FROM tenant_memberships AS memberships
             INNER JOIN tenants ON tenants.id = memberships.tenant_id
             INNER JOIN users ON users.id = memberships.user_id
             WHERE memberships.user_id = $1
               AND memberships.status = 'active'
               AND users.status = 'active'
             LIMIT 1`,
            [userId],
        );
        return result.rows[0] ? mapTenantContext(result.rows[0]) : null;
    }

    async listTenants(input: PageInput & { keyword?: string; callsStartAt?: string } = {}): Promise<PageResult<TenantListItem>> {
        const page = normalizePage(input.page);
        const pageSize = normalizePageSize(input.pageSize);
        const keyword = input.keyword?.trim().toLowerCase() || "";
        const result = await this.db.query(
            `SELECT tenants.*, owner.username AS owner_username, owner.display_name AS owner_display_name,
                    count(*) OVER() AS total_count,
                    (SELECT count(*) FROM tenant_memberships memberships
                     INNER JOIN users member_users ON member_users.id = memberships.user_id
                     WHERE memberships.tenant_id = tenants.id AND memberships.status = 'active' AND member_users.status = 'active') AS active_members,
                    (SELECT count(*) FROM generation_logs logs
                     INNER JOIN tenant_memberships memberships ON memberships.user_id = logs.user_id
                     WHERE memberships.tenant_id = tenants.id AND ($3::timestamptz IS NULL OR logs.created_at >= $3)) AS recent_calls
             FROM tenants
             INNER JOIN users owner ON owner.id = tenants.owner_user_id
             WHERE ($1 = '' OR lower(tenants.name) LIKE $2 OR lower(tenants.slug) LIKE $2 OR lower(owner.username) LIKE $2)
             ORDER BY tenants.created_at DESC, tenants.id ASC
             LIMIT $4 OFFSET $5`,
            [keyword, `%${keyword}%`, input.callsStartAt || null, pageSize, (page - 1) * pageSize],
        );
        return pageResult(result.rows.map(mapTenantListItem), numberValue(result.rows[0]?.total_count), page, pageSize);
    }

    async createTenant(record: TenantRecord): Promise<TenantRecord> {
        const result = await this.db.query(
            `INSERT INTO tenants (id, slug, name, owner_user_id, created_by_user_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [record.id, record.slug, record.name, record.ownerUserId, record.createdByUserId || null, record.createdAt, record.updatedAt],
        );
        return mapTenant(result.rows[0]);
    }

    async updateName(tenantId: string, name: string, updatedAt: string): Promise<TenantRecord | null> {
        const result = await this.db.query("UPDATE tenants SET name = $2, updated_at = $3 WHERE id = $1 RETURNING *", [tenantId, name, updatedAt]);
        return result.rows[0] ? mapTenant(result.rows[0]) : null;
    }

    async lockTenant(tenantId: string): Promise<TenantRecord | null> {
        const result = await this.db.query("SELECT * FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
        return result.rows[0] ? mapTenant(result.rows[0]) : null;
    }

    async addMembership(record: TenantMembershipRecord): Promise<TenantMembershipRecord> {
        const result = await this.db.query(
            `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_by_user_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [record.tenantId, record.userId, record.role, record.status, record.createdByUserId || null, record.createdAt, record.updatedAt],
        );
        return mapMembership(result.rows[0]);
    }

    async getMember(tenantId: string, userId: string, forUpdate = false): Promise<TenantMemberItem | null> {
        const result = await this.db.query(
            `SELECT memberships.*, memberships.status AS membership_status, users.account_id, users.username, users.email,
                    users.display_name, users.status AS user_status
             FROM tenant_memberships memberships
             INNER JOIN users ON users.id = memberships.user_id
             WHERE memberships.tenant_id = $1 AND memberships.user_id = $2${forUpdate ? " FOR UPDATE OF memberships" : ""}`,
            [tenantId, userId],
        );
        return result.rows[0] ? mapTenantMember(result.rows[0]) : null;
    }

    async listMembers(tenantId: string, input: PageInput & { keyword?: string; status?: TenantMembershipStatus } = {}): Promise<PageResult<TenantMemberItem>> {
        const page = normalizePage(input.page);
        const pageSize = normalizePageSize(input.pageSize);
        const keyword = input.keyword?.trim().toLowerCase() || "";
        const result = await this.db.query(
            `SELECT memberships.*, memberships.status AS membership_status, users.account_id, users.username, users.email,
                    users.display_name, users.status AS user_status, count(*) OVER() AS total_count
             FROM tenant_memberships memberships
             INNER JOIN users ON users.id = memberships.user_id
             WHERE memberships.tenant_id = $1
               AND ($2 = '' OR lower(users.username) LIKE $3 OR lower(users.display_name) LIKE $3 OR lower(coalesce(users.email, '')) LIKE $3)
               AND ($4::text IS NULL OR memberships.status = $4)
             ORDER BY CASE memberships.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, memberships.created_at ASC
             LIMIT $5 OFFSET $6`,
            [tenantId, keyword, `%${keyword}%`, input.status || null, pageSize, (page - 1) * pageSize],
        );
        return pageResult(result.rows.map(mapTenantMember), numberValue(result.rows[0]?.total_count), page, pageSize);
    }

    async updateMemberRole(tenantId: string, userId: string, role: TenantRole, updatedAt: string): Promise<TenantMembershipRecord | null> {
        const result = await this.db.query("UPDATE tenant_memberships SET role = $3, updated_at = $4 WHERE tenant_id = $1 AND user_id = $2 RETURNING *", [tenantId, userId, role, updatedAt]);
        return result.rows[0] ? mapMembership(result.rows[0]) : null;
    }

    async updateMemberStatus(tenantId: string, userId: string, status: TenantMembershipStatus, updatedAt: string): Promise<TenantMembershipRecord | null> {
        const result = await this.db.query("UPDATE tenant_memberships SET status = $3, updated_at = $4 WHERE tenant_id = $1 AND user_id = $2 RETURNING *", [tenantId, userId, status, updatedAt]);
        return result.rows[0] ? mapMembership(result.rows[0]) : null;
    }

    async getOverview(tenantId: string, input: { startAt: string; endAt: string; timeZone: string }): Promise<TenantOverviewAggregate> {
        const result = await this.db.query<Record<string, unknown>>(
            `WITH tenant_members AS MATERIALIZED (
                 SELECT memberships.user_id, memberships.role, memberships.status AS membership_status, users.status AS user_status
                 FROM tenant_memberships memberships
                 INNER JOIN users ON users.id = memberships.user_id
                 WHERE memberships.tenant_id = $1
             ), scoped AS MATERIALIZED (
                 SELECT logs.user_id, logs.status,
                        coalesce(nullif(btrim(logs.model), ''), '未记录模型') AS model_key,
                        logs.source AS source_key, logs.kind AS kind_key,
                        to_char(logs.created_at AT TIME ZONE $4::text, 'YYYY-MM-DD') AS day_key
                 FROM generation_logs logs
                 INNER JOIN tenant_members members ON members.user_id = logs.user_id
                 WHERE logs.created_at >= $2::timestamptz AND logs.created_at < $3::timestamptz
             )
             SELECT
                 (SELECT count(*) FROM tenant_members)::int AS member_total,
                 (SELECT count(*) FROM tenant_members WHERE membership_status = 'active' AND user_status = 'active')::int AS active_members,
                 (SELECT count(*) FROM tenant_members WHERE membership_status = 'active' AND user_status = 'active' AND role IN ('owner', 'admin'))::int AS admin_count,
                 (SELECT count(*) FROM scoped)::int AS total_calls,
                 (SELECT count(*) FROM scoped WHERE status = 'success')::int AS success_calls,
                 (SELECT count(*) FROM scoped WHERE status = 'failed')::int AS failed_calls,
                 (SELECT count(DISTINCT scoped.user_id) FROM scoped INNER JOIN tenant_members members ON members.user_id = scoped.user_id WHERE members.membership_status = 'active' AND members.user_status = 'active')::int AS active_creators,
                 (SELECT coalesce(jsonb_agg(jsonb_build_object('key', bucket_key, 'value', bucket_value) ORDER BY bucket_key), '[]'::jsonb) FROM (SELECT day_key AS bucket_key, count(*)::int AS bucket_value FROM scoped GROUP BY day_key) buckets) AS daily,
                 (SELECT coalesce(jsonb_agg(jsonb_build_object('key', bucket_key, 'value', bucket_value) ORDER BY bucket_value DESC, bucket_key), '[]'::jsonb) FROM (SELECT model_key AS bucket_key, count(*)::int AS bucket_value FROM scoped GROUP BY model_key ORDER BY bucket_value DESC, bucket_key LIMIT 6) buckets) AS models,
                 (SELECT coalesce(jsonb_agg(jsonb_build_object('key', bucket_key, 'value', bucket_value) ORDER BY bucket_value DESC, bucket_key), '[]'::jsonb) FROM (SELECT source_key AS bucket_key, count(*)::int AS bucket_value FROM scoped GROUP BY source_key) buckets) AS sources,
                 (SELECT coalesce(jsonb_agg(jsonb_build_object('key', bucket_key, 'value', bucket_value) ORDER BY bucket_value DESC, bucket_key), '[]'::jsonb) FROM (SELECT kind_key AS bucket_key, count(*)::int AS bucket_value FROM scoped GROUP BY kind_key) buckets) AS kinds`,
            [tenantId, input.startAt, input.endAt, input.timeZone],
        );
        const row = result.rows[0] || {};
        return {
            memberTotal: numberValue(row.member_total),
            activeMembers: numberValue(row.active_members),
            adminCount: numberValue(row.admin_count),
            totalCalls: numberValue(row.total_calls),
            successCalls: numberValue(row.success_calls),
            failedCalls: numberValue(row.failed_calls),
            activeCreators: numberValue(row.active_creators),
            daily: mapBuckets(row.daily),
            models: mapBuckets(row.models),
            sources: mapBuckets(row.sources),
            kinds: mapBuckets(row.kinds),
        };
    }
}

function roleValue(value: unknown): TenantRole {
    return value === "owner" || value === "admin" ? value : "member";
}

function membershipStatusValue(value: unknown): TenantMembershipStatus {
    return value === "disabled" ? "disabled" : "active";
}

function mapTenant(row: Record<string, unknown>): TenantRecord {
    return {
        id: stringValue(row.id),
        slug: stringValue(row.slug),
        name: stringValue(row.name),
        ownerUserId: stringValue(row.owner_user_id),
        createdByUserId: optionalString(row.created_by_user_id),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

function mapTenantContext(row: Record<string, unknown>): TenantContext {
    return { tenantId: stringValue(row.tenant_id), tenantName: stringValue(row.tenant_name), userId: stringValue(row.user_id), role: roleValue(row.role) };
}

function mapMembership(row: Record<string, unknown>): TenantMembershipRecord {
    return {
        tenantId: stringValue(row.tenant_id),
        userId: stringValue(row.user_id),
        role: roleValue(row.role),
        status: membershipStatusValue(row.status ?? row.membership_status),
        createdByUserId: optionalString(row.created_by_user_id),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

function mapTenantMember(row: Record<string, unknown>): TenantMemberItem {
    return {
        ...mapMembership(row),
        accountId: String(row.account_id ?? "").padStart(4, "0"),
        username: stringValue(row.username),
        displayName: stringValue(row.display_name),
        email: optionalString(row.email),
        userStatus: row.user_status === "disabled" ? "disabled" : "active",
    };
}

function mapTenantListItem(row: Record<string, unknown>): TenantListItem {
    return { ...mapTenant(row), ownerUsername: stringValue(row.owner_username), ownerDisplayName: stringValue(row.owner_display_name), activeMembers: numberValue(row.active_members), recentCalls: numberValue(row.recent_calls) };
}

function mapBuckets(value: unknown): TenantOverviewBucket[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => ({ key: stringValue((item as Record<string, unknown>).key), value: numberValue((item as Record<string, unknown>).value) })).filter((item) => item.key);
}
