import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    connect: vi.fn(),
    pool: vi.fn(),
}));

vi.mock("pg", () => ({
    Pool: mocks.pool,
}));

import { ensurePostgresSchema, initializePostgresSchema, postgresQuery, withPostgresTransaction } from "./postgres";

describe("PostgreSQL schema lifecycle", () => {
    beforeEach(() => {
        delete (globalThis as Record<string, unknown>).__vozebProPostgresPool;
        delete (globalThis as Record<string, unknown>).__vozebProPostgresSchemaReady;
        process.env.DATABASE_URL = "postgres://vozeb:test@localhost:5432/vozeb";
        delete process.env.VOZEB_PRO_DATABASE_SSL;
        delete process.env.VOZEB_PRO_DATABASE_SSL_CA;
        delete process.env.VOZEB_PRO_DATABASE_SSL_REJECT_UNAUTHORIZED;
        mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
        mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: vi.fn() });
        mocks.pool.mockReset().mockImplementation(function PoolMock() {
            return { query: mocks.query, connect: mocks.connect };
        });
    });

    it("verifies PostgreSQL TLS certificates by default and accepts an explicit CA", async () => {
        process.env.VOZEB_PRO_DATABASE_SSL = "1";
        process.env.VOZEB_PRO_DATABASE_SSL_CA = "-----BEGIN CERTIFICATE-----\\ncertificate\\n-----END CERTIFICATE-----";
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

        await expect(ensurePostgresSchema()).rejects.toThrow("PostgreSQL schema has not been initialized");

        expect(mocks.pool).toHaveBeenCalledWith(
            expect.objectContaining({
                ssl: {
                    rejectUnauthorized: true,
                    ca: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
                },
            }),
        );
    });

    it("only disables PostgreSQL certificate verification through an explicit override", async () => {
        process.env.VOZEB_PRO_DATABASE_SSL = "1";
        process.env.VOZEB_PRO_DATABASE_SSL_REJECT_UNAUTHORIZED = "0";
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

        await expect(ensurePostgresSchema()).rejects.toThrow("PostgreSQL schema has not been initialized");

        expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: false } }));
    });

    it("serializes concurrent repository queries on one transaction client", async () => {
        let active = false;
        const statements: string[] = [];
        const release = vi.fn();
        const clientQuery = vi.fn(async (statement: string) => {
            statements.push(statement);
            if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") return { rows: [], rowCount: 0 };
            if (active) throw new Error("transaction client received concurrent queries");
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 0));
            active = false;
            return { rows: [], rowCount: 0 };
        });
        mocks.connect.mockResolvedValue({ query: clientQuery, release });

        await withPostgresTransaction(async (client) => {
            await Promise.all([client.query("SELECT 1"), client.query("SELECT 2"), client.query("SELECT 3")]);
        });

        expect(statements).toEqual(["BEGIN", "SELECT 1", "SELECT 2", "SELECT 3", "COMMIT"]);
        expect(release).toHaveBeenCalledOnce();
    });

    it("does not execute schema DDL when an ordinary caller reaches an empty database", async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: null }] });

        await expect(ensurePostgresSchema()).rejects.toThrow("PostgreSQL schema has not been initialized");

        expect(mocks.query).toHaveBeenCalledTimes(1);
        expect(mocks.query.mock.calls[0]?.[0]).toContain("to_regclass");
        expect(mocks.query.mock.calls[0]?.[0]).not.toContain("CREATE TABLE");
    });

    it("prefixes SQL identifiers without rewriting ordinary string literals", async () => {
        await postgresQuery("SELECT 'users' AS target_type, $$users.read$$ AS permission FROM users WHERE action = 'users.read'");

        expect(mocks.query).toHaveBeenCalledWith("SELECT 'users' AS target_type, $$users.read$$ AS permission FROM vozeb_pro_users WHERE action = 'users.read'", undefined);
    });

    it("executes schema DDL only through explicit initialization", async () => {
        await initializePostgresSchema();

        expect(mocks.query).toHaveBeenCalledTimes(4);
        expect(mocks.query.mock.calls[0]?.[0]).toBe("BEGIN");
        expect(mocks.query.mock.calls[1]).toEqual(["SELECT pg_advisory_xact_lock(hashtext($1))", ["vozeb-pro:schema"]]);
        const ddl = String(mocks.query.mock.calls[2]?.[0]);
        expect(mocks.query.mock.calls[3]?.[0]).toBe("COMMIT");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS vozeb_pro_schema_migrations");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS vozeb_pro_generation_worker_heartbeats");
        expect(ddl).toContain("CREATE SEQUENCE IF NOT EXISTS vozeb_pro_user_account_id_seq");
        expect(ddl).toContain("account_id bigint NOT NULL DEFAULT nextval('vozeb_pro_user_account_id_seq')");
        expect(ddl).toMatch(/SELECT setval\(\s*'vozeb_pro_user_account_id_seq'/);
        expect(ddl).toContain("users.read");
        expect(ddl).toContain("users.manage");
        expect(ddl).not.toContain("vozeb_pro_users.read");
        expect(ddl).not.toContain("vozeb_pro_users.manage");
        expect(ddl).toContain("terms_version text");
        expect(ddl).toContain("policy_accepted_at timestamptz");
        expect(ddl).toContain("mfa_secret_ciphertext text");
        expect(ddl).toContain("CONSTRAINT users_mfa_enabled_secret CHECK");
        expect(ddl).toContain("CONSTRAINT users_registration_consent_complete CHECK");
        expect(ddl).toContain("ALTER TABLE vozeb_pro_users ADD CONSTRAINT users_admin_permissions_array");
        expect(ddl).toContain("conname = 'vozeb_pro_local_media_assets_storage_provider_check'");
        expect(ddl).toContain("ADD CONSTRAINT vozeb_pro_local_media_assets_storage_provider_check CHECK");
        expect(ddl).toContain("CREATE UNIQUE INDEX IF NOT EXISTS vozeb_pro_users_account_id_idx ON vozeb_pro_users (account_id)");
        expect(ddl).toContain("CREATE INDEX IF NOT EXISTS vozeb_pro_billing_orders_provider_payment_idx ON vozeb_pro_billing_orders (provider, provider_payment_id)");
        expect(ddl).toContain("webhook_secret_ciphertext text NOT NULL DEFAULT ''");
        expect(ddl).toContain("CREATE UNIQUE INDEX IF NOT EXISTS vozeb_pro_generation_tasks_channel_upstream_idx ON vozeb_pro_generation_tasks (channel_id, upstream_task_id)");
        expect(ddl).toContain("CREATE OR REPLACE FUNCTION vozeb_pro_notify_generation_task_change()");
        expect(ddl).toContain("CREATE TRIGGER vozeb_pro_generation_tasks_event_notify AFTER INSERT OR UPDATE OR DELETE ON vozeb_pro_generation_tasks");
        expect(ddl).toContain("pg_notify('vozeb_pro_generation_task_events'");
        expect(ddl).toContain("signature_timestamp timestamptz NOT NULL");
        expect(ddl).toContain("conflict_count integer NOT NULL DEFAULT 0");
        expect(ddl).toContain("user_id text NOT NULL REFERENCES vozeb_pro_users(id) ON DELETE CASCADE");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS vozeb_pro_account_deletion_requests");
        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS vozeb_module_states");
        expect(ddl).toContain("'review_pending', 'reviewing', 'review_unavailable'");
        expect(ddl).toContain("task_type = 'agent' AND status = 'success' AND execution_phase IN ('review_pending', 'reviewing')");

        const tableNames = [...ddl.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z][a-z0-9_]*)/gi)].map((match) => match[1]).sort();
        expect(tableNames).toHaveLength(67);
        expect(tableNames).toContain("vozeb_module_states");
        expect(tableNames).toContain("vozeb_workflows");
        expect(tableNames).toContain("vozeb_workflow_runs");
        expect(tableNames).toContain("vozeb_workflow_events");
        expect(tableNames).toContain("vozeb_layouts");
        expect(tableNames).toContain("vozeb_layout_revisions");
        expect(tableNames).toContain("vozeb_site_publications");
        expect(tableNames).toContain("vozeb_pro_generation_concurrency_reservations");
        expect(
            tableNames
                .filter((name) => !["vozeb_module_states", "vozeb_workflows", "vozeb_workflow_runs", "vozeb_workflow_events", "vozeb_layouts", "vozeb_layout_revisions", "vozeb_site_publications"].includes(name))
                .every((name) => name.startsWith("vozeb_pro_")),
        ).toBe(true);
        expect(tableNames).not.toContain("vozeb_pro_check_ins");
        expect(ddl).toContain("DROP TABLE IF EXISTS vozeb_pro_check_ins");
        expect(ddl).not.toContain("20260731_generation_task_recovery");

        const indexNames = [...ddl.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)/gi)].map((match) => match[1]);
        expect(indexNames.length).toBeGreaterThan(0);
        expect(
            indexNames
                .filter(
                    (name) =>
                        ![
                            "vozeb_module_states_updated_idx",
                            "vozeb_workflows_user_project_idx",
                            "vozeb_workflow_runs_idempotency_idx",
                            "vozeb_workflow_runs_user_updated_idx",
                            "vozeb_workflow_runs_workflow_updated_idx",
                            "vozeb_workflow_runs_lease_idx",
                            "vozeb_workflow_events_run_idx",
                            "vozeb_layouts_user_project_idx",
                            "vozeb_layouts_site_path_published_idx",
                            "vozeb_layout_revisions_created_idx",
                            "vozeb_site_publications_layout_idx",
                        ].includes(name),
                )
                .every((name) => name.startsWith("vozeb_pro_")),
        ).toBe(true);

        const uniqueConstraintNames = [...ddl.matchAll(/CONSTRAINT\s+([a-z][a-z0-9_]*)\s+UNIQUE\b/gi)].map((match) => match[1]);
        expect(uniqueConstraintNames.length).toBeGreaterThan(0);
        expect(uniqueConstraintNames.every((name) => name.startsWith("vozeb_pro_"))).toBe(true);
    });

    it("continues applying additive schema updates after the sentinel table exists", async () => {
        mocks.query.mockResolvedValueOnce({ rows: [{ table_name: "vozeb_pro_users" }] });

        await ensurePostgresSchema();

        expect(mocks.query).toHaveBeenCalledTimes(5);
        expect(mocks.query.mock.calls[0]?.[0]).toContain("to_regclass");
        expect(mocks.query.mock.calls[2]).toEqual(["SELECT pg_advisory_xact_lock(hashtext($1))", ["vozeb-pro:schema"]]);
        expect(mocks.query.mock.calls[3]?.[0]).toContain("CREATE TABLE IF NOT EXISTS vozeb_pro_schema_migrations");
    });
});
