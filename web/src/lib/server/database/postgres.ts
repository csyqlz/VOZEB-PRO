import { Client, Pool, type QueryResult, type QueryResultRow } from "pg";

import { POSTGRESQL_SCHEMA_SQL } from "@/lib/server/database/schema";

type DatabaseProvider = "file" | "postgres";

export type QueryExecutor = {
    query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
};

const POSTGRES_TABLE_PREFIX = "vozeb_pro_";
const POSTGRES_TABLES = [
    "schema_migrations",
    "app_settings",
    "system_model_channels",
    "entitlement_plans",
    "users",
    "sessions",
    "account_deletion_requests",
    "rate_limits",
    "email_codes",
    "quota_usage",
    "point_records",
    "daily_plan_point_wallets",
    "billing_products",
    "promotion_campaigns",
    "promotion_products",
    "coupon_templates",
    "coupon_template_products",
    "billing_orders",
    "user_coupons",
    "coupon_redemptions",
    "payment_transactions",
    "billing_refund_jobs",
    "referral_programs",
    "referral_codes",
    "referral_relationships",
    "referral_rewards",
    "published_works",
    "published_work_versions",
    "published_work_assets",
    "published_work_cases",
    "published_work_likes",
    "user_follows",
    "user_blocks",
    "user_notifications",
    "billing_reconciliation_runs",
    "billing_reconciliation_rows",
    "user_plan_assignments",
    "payment_provider_events",
    "cdk_codes",
    "cdk_redemptions",
    "announcements",
    "prompts",
    "prompt_seed_sources",
    "generation_logs",
    "generation_log_assets",
    "generation_tasks",
    "generation_concurrency_reservations",
    "generation_worker_heartbeats",
    "generation_webhook_events",
    "creative_conversations",
    "creative_messages",
    "creative_assets",
    "local_media_assets",
    "object_storage_settings",
    "canvas_projects",
    "library_assets",
    "drama_projects",
    "drama_project_versions",
    "creative_run_events",
    "audit_logs",
    "check_ins",
] as const;

const POSTGRES_SCHEMA_OBJECTS = [
    "user_account_id_seq",
    "users_account_id_idx",
    "users_username_lower_idx",
    "users_email_lower_idx",
    "users_plan_id_idx",
    "sessions_user_id_idx",
    "sessions_expires_at_idx",
    "account_deletion_requests_user_pending_idx",
    "account_deletion_requests_user_created_idx",
    "account_deletion_requests_status_created_idx",
    "rate_limits_reset_idx",
    "email_codes_lookup_idx",
    "quota_usage_date_idx",
    "point_records_user_created_idx",
    "point_records_idempotency_idx",
    "point_records_refund_source_idx",
    "daily_plan_point_wallets_assignment_idx",
    "billing_products_plan_idx",
    "billing_products_enabled_idx",
    "promotion_campaigns_active_idx",
    "promotion_products_product_idx",
    "coupon_templates_code_idx",
    "coupon_templates_active_idx",
    "coupon_template_products_product_idx",
    "billing_orders_user_created_idx",
    "billing_orders_status_created_idx",
    "billing_orders_created_idx",
    "billing_orders_pending_expires_idx",
    "billing_orders_provider_idx",
    "billing_orders_provider_payment_idx",
    "billing_orders_product_idx",
    "user_coupons_user_status_idx",
    "user_coupons_template_user_idx",
    "user_coupons_locked_order_idx",
    "coupon_redemptions_order_idx",
    "coupon_redemptions_coupon_idx",
    "payment_transactions_order_idx",
    "payment_transactions_user_idx",
    "payment_transactions_created_idx",
    "payment_transactions_provider_trade_idx",
    "payment_transactions_provider_payment_idx",
    "billing_refund_jobs_due_idx",
    "billing_refund_jobs_provider_refund_idx",
    "billing_reconciliation_runs_provider_file_hash_idx",
    "referral_codes_code_idx",
    "referral_relationships_inviter_idx",
    "referral_relationships_risk_idx",
    "referral_relationships_ip_idx",
    "referral_relationships_payment_idx",
    "referral_rewards_relationship_role_idx",
    "referral_rewards_trigger_order_idx",
    "referral_rewards_beneficiary_idx",
    "referral_rewards_due_idx",
    "referral_rewards_status_idx",
    "published_works_slug_idx",
    "published_works_owner_updated_idx",
    "published_works_lifecycle_idx",
    "published_works_gallery_featured_idx",
    "published_works_gallery_popular_idx",
    "published_work_versions_work_number_idx",
    "published_work_versions_moderation_idx",
    "published_work_versions_public_idx",
    "published_work_versions_public_category_idx",
    "published_work_versions_public_tags_idx",
    "published_work_versions_public_search_idx",
    "published_work_assets_unique_role",
    "published_work_assets_version_order_idx",
    "published_work_assets_storage_idx",
    "published_work_cases_open_unique_idx",
    "published_work_cases_admin_idx",
    "published_work_cases_work_idx",
    "published_work_likes_user_created_idx",
    "published_work_likes_work_created_idx",
    "user_follows_followed_created_idx",
    "user_follows_follower_created_idx",
    "user_blocks_blocked_created_idx",
    "user_notifications_dedup_idx",
    "user_notifications_user_created_idx",
    "user_notifications_unread_idx",
    "billing_reconciliation_runs_created_idx",
    "billing_reconciliation_runs_provider_created_idx",
    "billing_reconciliation_rows_run_idx",
    "billing_reconciliation_rows_issue_codes_gin_idx",
    "user_plan_assignments_user_active_idx",
    "user_plan_assignments_plan_idx",
    "user_plan_assignments_source_idx",
    "user_plan_assignments_source_unique_idx",
    "payment_provider_events_provider_created_idx",
    "payment_provider_events_provider_event_idx",
    "cdk_codes_status_idx",
    "cdk_codes_status_created_idx",
    "cdk_redemptions_user_id_idx",
    "announcements_visible_idx",
    "prompts_scope_updated_idx",
    "prompts_owner_updated_idx",
    "prompts_tags_gin_idx",
    "generation_logs_user_created_idx",
    "generation_logs_created_idx",
    "generation_logs_admin_filter_idx",
    "generation_logs_conversation_idx",
    "generation_log_assets_log_idx",
    "generation_tasks_user_status_idx",
    "generation_tasks_expires_idx",
    "generation_tasks_user_client_request_idx",
    "generation_tasks_channel_upstream_idx",
    "generation_tasks_conversation_idx",
    "generation_tasks_run_idx",
    "generation_tasks_user_project_idx",
    "generation_tasks_recovery_due_idx",
    "generation_concurrency_reservations_expires_idx",
    "generation_worker_heartbeats_seen_idx",
    "generation_webhook_events_received_idx",
    "creative_conversations_user_updated_idx",
    "creative_conversations_user_source_idx",
    "creative_conversations_project_idx",
    "creative_messages_conversation_sequence_idx",
    "creative_messages_run_idx",
    "creative_assets_conversation_idx",
    "creative_assets_run_idx",
    "local_media_assets_owner_created_idx",
    "local_media_assets_source_idx",
    "local_media_assets_expires_idx",
    "local_media_assets_local_created_idx",
    "local_media_assets_local_filter_idx",
    "local_media_assets_storage_provider_check",
    "local_media_assets_external_object_idx",
    "canvas_projects_user_updated_idx",
    "library_assets_user_updated_idx",
    "drama_projects_user_updated_idx",
    "drama_project_versions_user_created_idx",
    "creative_run_events_run_id_idx",
    "audit_logs_created_idx",
    "audit_logs_action_idx",
    "audit_logs_actor_user_idx",
    "audit_logs_target_idx",
    "entitlement_plans_set_updated_at",
    "app_settings_set_updated_at",
    "system_model_channels_set_updated_at",
    "users_set_updated_at",
    "daily_plan_point_wallets_set_updated_at",
    "billing_products_set_updated_at",
    "promotion_campaigns_set_updated_at",
    "coupon_templates_set_updated_at",
    "billing_orders_set_updated_at",
    "user_coupons_set_updated_at",
    "coupon_redemptions_set_updated_at",
    "payment_transactions_set_updated_at",
    "referral_programs_set_updated_at",
    "referral_codes_set_updated_at",
    "referral_relationships_set_updated_at",
    "referral_rewards_set_updated_at",
    "published_works_set_updated_at",
    "published_work_versions_set_updated_at",
    "published_work_cases_set_updated_at",
    "billing_reconciliation_runs_set_updated_at",
    "billing_reconciliation_rows_set_updated_at",
    "user_plan_assignments_set_updated_at",
    "payment_provider_events_set_updated_at",
    "cdk_codes_set_updated_at",
    "announcements_set_updated_at",
    "prompts_set_updated_at",
    "generation_logs_set_updated_at",
    "drama_projects_set_updated_at",
    "object_storage_settings_set_updated_at",
] as const;

const POSTGRES_RELATION_NAMES = new Set<string>([...POSTGRES_TABLES, ...POSTGRES_SCHEMA_OBJECTS]);
const POSTGRES_IDENTIFIER_PATTERN = new RegExp(`(?<!${POSTGRES_TABLE_PREFIX})\\b(${[...POSTGRES_SCHEMA_OBJECTS, ...POSTGRES_TABLES].join("|")})\\b`, "g");
const POSTGRES_RELATION_LITERAL_FUNCTIONS = new Set<string>(["currval", "nextval", "pg_get_serial_sequence", "setval", "to_regclass"]);
const POSTGRES_CATALOG_OBJECT_NAME_COLUMNS = new Set<string>(["conname", "indexname", "proname", "relname", "sequencename", "tgname"]);

const globalForPostgres = globalThis as typeof globalThis & {
    __vozebProPostgresPool?: Pool;
    __vozebProPostgresSchemaReady?: Promise<void>;
    __vozebProPostgresNotifications?: PostgresNotificationState;
};

type PostgresNotificationListener = (payload: string) => void;
const POSTGRES_SCHEMA_LOCK_KEY = "vozeb-pro:schema";
type PostgresNotificationState = {
    client?: Client;
    connecting?: Promise<void>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    listeners: Map<string, Set<PostgresNotificationListener>>;
};

export function getDatabaseProvider(): DatabaseProvider {
    return process.env.VOZEB_PRO_DATABASE_PROVIDER?.trim().toLowerCase() === "file" ? "file" : "postgres";
}

export function isPostgresDatabaseEnabled() {
    return getDatabaseProvider() === "postgres";
}

export function getPostgresConnectionString() {
    return process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim() || "";
}

function getPostgresPool() {
    const connectionString = getPostgresConnectionString();
    if (!connectionString) throw new Error("DATABASE_URL is required when VOZEB_PRO_DATABASE_PROVIDER=postgres");

    if (!globalForPostgres.__vozebProPostgresPool) {
        globalForPostgres.__vozebProPostgresPool = new Pool({
            connectionString,
            max: normalizePoolMax(process.env.VOZEB_PRO_DATABASE_POOL_MAX),
            ssl: postgresSslConfig(),
        });
    }

    return globalForPostgres.__vozebProPostgresPool;
}

export async function postgresQuery<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    return getPostgresPool().query<T>(prefixPostgresSql(text), values);
}

export async function withPostgresTransaction<T>(handler: (client: QueryExecutor) => Promise<T>) {
    const client = await getPostgresPool().connect();
    let queryQueue = Promise.resolve();
    let queryFailed = false;
    let queryError: unknown;
    const executor: QueryExecutor = {
        query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
            const pending = queryQueue.then(async () => {
                if (queryFailed) throw queryError;
                try {
                    return await client.query<T>(prefixPostgresSql(text), values);
                } catch (error) {
                    queryFailed = true;
                    queryError = error;
                    throw error;
                }
            });
            queryQueue = pending.then(
                () => undefined,
                () => undefined,
            );
            return pending;
        },
    };
    try {
        await client.query("BEGIN");
        const result = await handler(executor);
        await queryQueue;
        if (queryFailed) throw queryError;
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await queryQueue;
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function subscribePostgresNotification(channel: string, listener: PostgresNotificationListener) {
    const name = normalizeNotificationChannel(channel);
    const state: PostgresNotificationState = globalForPostgres.__vozebProPostgresNotifications ?? (globalForPostgres.__vozebProPostgresNotifications = { listeners: new Map() });
    const existing = state.listeners.get(name);
    const listeners = existing || new Set<PostgresNotificationListener>();
    listeners.add(listener);
    state.listeners.set(name, listeners);
    if (state.client && !existing) await state.client.query(`LISTEN ${name}`);
    else await ensurePostgresNotificationClient(state);
    return () => {
        const current = state.listeners.get(name);
        current?.delete(listener);
        if (!current?.size) state.listeners.delete(name);
    };
}

async function ensurePostgresNotificationClient(state: PostgresNotificationState) {
    if (state.client) return;
    if (state.connecting) return state.connecting;
    const connectionString = getPostgresConnectionString();
    if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL notifications");
    const client = new Client({ connectionString, ssl: postgresSslConfig() });
    state.connecting = (async () => {
        await client.connect();
        client.on("notification", (message) => {
            for (const listener of [...(state.listeners.get(message.channel) || [])]) listener(message.payload || "");
        });
        client.on("error", () => reconnectPostgresNotifications(state, client));
        for (const channel of state.listeners.keys()) await client.query(`LISTEN ${channel}`);
        state.client = client;
    })().finally(() => {
        state.connecting = undefined;
    });
    return state.connecting;
}

function reconnectPostgresNotifications(state: PostgresNotificationState, client: Client) {
    if (state.client === client) state.client = undefined;
    void client.end().catch(() => undefined);
    if (!state.listeners.size || state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = undefined;
        void ensurePostgresNotificationClient(state).catch(() => reconnectPostgresNotifications(state, client));
    }, 1_000);
    state.reconnectTimer.unref?.();
}

function normalizeNotificationChannel(value: string) {
    const channel = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(channel)) throw new Error("Invalid PostgreSQL notification channel");
    return channel;
}

export async function ensurePostgresSchema() {
    if (globalForPostgres.__vozebProPostgresSchemaReady) return globalForPostgres.__vozebProPostgresSchemaReady;

    const result = await getPostgresPool().query<{ table_name: string | null }>("SELECT to_regclass('public.vozeb_pro_users')::text AS table_name");
    if (!result.rows[0]?.table_name) throw new Error("PostgreSQL schema has not been initialized");

    return initializePostgresSchema();
}

export async function initializePostgresSchema() {
    if (!globalForPostgres.__vozebProPostgresSchemaReady) {
        globalForPostgres.__vozebProPostgresSchemaReady = withPostgresTransaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [POSTGRES_SCHEMA_LOCK_KEY]);
            await client.query(POSTGRESQL_SCHEMA_SQL);
        })
            .then(() => undefined)
            .catch((error) => {
                globalForPostgres.__vozebProPostgresSchemaReady = undefined;
                throw error;
            });
    }
    return globalForPostgres.__vozebProPostgresSchemaReady;
}

function prefixPostgresSql(sql: string) {
    let result = "";
    let segmentStart = 0;
    let cursor = 0;

    while (cursor < sql.length) {
        if (sql.startsWith("--", cursor)) {
            result += prefixPostgresIdentifiers(sql.slice(segmentStart, cursor));
            const commentEnd = sql.indexOf("\n", cursor + 2);
            const end = commentEnd === -1 ? sql.length : commentEnd + 1;
            result += sql.slice(cursor, end);
            cursor = end;
            segmentStart = end;
            continue;
        }
        if (sql.startsWith("/*", cursor)) {
            result += prefixPostgresIdentifiers(sql.slice(segmentStart, cursor));
            const end = findPostgresBlockCommentEnd(sql, cursor);
            result += sql.slice(cursor, end);
            cursor = end;
            segmentStart = end;
            continue;
        }
        if (sql[cursor] === "$") {
            const delimiter = readPostgresDollarDelimiter(sql, cursor);
            if (delimiter) {
                result += prefixPostgresIdentifiers(sql.slice(segmentStart, cursor));
                const bodyStart = cursor + delimiter.length;
                const closingStart = sql.indexOf(delimiter, bodyStart);
                const end = closingStart === -1 ? sql.length : closingStart + delimiter.length;
                if (closingStart !== -1 && isPostgresExecutableDollarBody(sql, cursor)) {
                    result += delimiter + prefixPostgresSql(sql.slice(bodyStart, closingStart)) + delimiter;
                } else {
                    result += sql.slice(cursor, end);
                }
                cursor = end;
                segmentStart = end;
                continue;
            }
        }
        if (sql[cursor] === "'") {
            result += prefixPostgresIdentifiers(sql.slice(segmentStart, cursor));
            const end = findPostgresStringEnd(sql, cursor);
            result += prefixPostgresRelationLiteral(sql, cursor, end);
            cursor = end;
            segmentStart = end;
            continue;
        }
        cursor += 1;
    }

    return result + prefixPostgresIdentifiers(sql.slice(segmentStart));
}

function prefixPostgresIdentifiers(sql: string) {
    return sql.replace(POSTGRES_IDENTIFIER_PATTERN, `${POSTGRES_TABLE_PREFIX}$1`);
}

function readPostgresDollarDelimiter(sql: string, start: number) {
    let cursor = start + 1;
    if (sql[cursor] === "$") return "$$";
    if (!/[a-z_]/i.test(sql[cursor] || "")) return "";
    cursor += 1;
    while (/[a-z0-9_]/i.test(sql[cursor] || "")) cursor += 1;
    return sql[cursor] === "$" ? sql.slice(start, cursor + 1) : "";
}

function isPostgresExecutableDollarBody(sql: string, start: number) {
    let cursor = start - 1;
    while (cursor >= 0 && /\s/.test(sql[cursor])) cursor -= 1;
    const wordEnd = cursor + 1;
    while (cursor >= 0 && /[a-z]/i.test(sql[cursor])) cursor -= 1;
    const precedingWord = sql.slice(cursor + 1, wordEnd).toLowerCase();
    if (precedingWord === "do") return true;
    if (precedingWord !== "as") return false;
    const statement = sql.slice(sql.lastIndexOf(";", cursor) + 1, start);
    return /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(statement);
}

function findPostgresStringEnd(sql: string, start: number) {
    const escapeBackslashes = sql[start - 1]?.toLowerCase() === "e" && !/[a-z0-9_$]/i.test(sql[start - 2] || "");
    let cursor = start + 1;
    while (cursor < sql.length) {
        if (escapeBackslashes && sql[cursor] === "\\") {
            cursor += 2;
            continue;
        }
        if (sql[cursor] !== "'") {
            cursor += 1;
            continue;
        }
        if (sql[cursor + 1] === "'") {
            cursor += 2;
            continue;
        }
        return cursor + 1;
    }
    return sql.length;
}

function findPostgresBlockCommentEnd(sql: string, start: number) {
    let depth = 1;
    let cursor = start + 2;
    while (cursor < sql.length && depth > 0) {
        if (sql.startsWith("/*", cursor)) {
            depth += 1;
            cursor += 2;
        } else if (sql.startsWith("*/", cursor)) {
            depth -= 1;
            cursor += 2;
        } else {
            cursor += 1;
        }
    }
    return cursor;
}

function prefixPostgresRelationLiteral(sql: string, start: number, end: number) {
    const literal = sql.slice(start, end);
    const shouldPrefix = isPostgresRelationLiteralContext(sql, start, end) || isPostgresCatalogObjectLiteralContext(sql, start);
    if (!shouldPrefix) return literal;

    const value = literal.slice(1, -1);
    const separator = value.lastIndexOf(".");
    const qualifier = separator === -1 ? "" : value.slice(0, separator + 1);
    const name = separator === -1 ? value : value.slice(separator + 1);
    return POSTGRES_RELATION_NAMES.has(name) ? `'${qualifier}${POSTGRES_TABLE_PREFIX}${name}'` : literal;
}

function isPostgresRelationLiteralContext(sql: string, start: number, end: number) {
    if (/^\s*::\s*(?:pg_catalog\.)?regclass\b/i.test(sql.slice(end))) return true;

    let cursor = start - 1;
    while (cursor >= 0 && /\s/.test(sql[cursor])) cursor -= 1;
    if (sql[cursor] !== "(") return false;
    cursor -= 1;
    while (cursor >= 0 && /\s/.test(sql[cursor])) cursor -= 1;
    const nameEnd = cursor + 1;
    while (cursor >= 0 && /[a-z0-9_.]/i.test(sql[cursor])) cursor -= 1;
    const functionName =
        sql
            .slice(cursor + 1, nameEnd)
            .split(".")
            .pop()
            ?.toLowerCase() || "";
    return POSTGRES_RELATION_LITERAL_FUNCTIONS.has(functionName);
}

function isPostgresCatalogObjectLiteralContext(sql: string, start: number) {
    let cursor = start - 1;
    while (cursor >= 0 && /\s/.test(sql[cursor])) cursor -= 1;
    if (sql[cursor] !== "=") return false;
    cursor -= 1;
    while (cursor >= 0 && /\s/.test(sql[cursor])) cursor -= 1;
    const nameEnd = cursor + 1;
    while (cursor >= 0 && /[a-z0-9_.]/i.test(sql[cursor])) cursor -= 1;
    const columnName =
        sql
            .slice(cursor + 1, nameEnd)
            .split(".")
            .pop()
            ?.toLowerCase() || "";
    return POSTGRES_CATALOG_OBJECT_NAME_COLUMNS.has(columnName);
}

function normalizePoolMax(value: string | undefined) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(50, Math.floor(parsed)) : 10;
}

function parseBoolean(value: string | undefined) {
    return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() || "");
}

function postgresSslConfig() {
    if (!parseBoolean(process.env.VOZEB_PRO_DATABASE_SSL)) return undefined;
    const rejectUnauthorized = !["0", "false", "no", "off"].includes(process.env.VOZEB_PRO_DATABASE_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() || "");
    const ca = process.env.VOZEB_PRO_DATABASE_SSL_CA?.trim().replace(/\\n/g, "\n") || "";
    return { rejectUnauthorized, ...(ca ? { ca } : {}) };
}
