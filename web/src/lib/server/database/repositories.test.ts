import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { createPostgresRepositories } from "./repositories";

function mockExecutor(rows: Record<string, unknown>[][]) {
    const query = vi.fn(async () => ({ rows: rows.shift() || [], rowCount: 1 }));
    return { executor: { query } as unknown as QueryExecutor, query };
}

function queryArgs(query: ReturnType<typeof mockExecutor>["query"], index: number) {
    return (query.mock.calls as unknown[][])[index] || [];
}

describe("split Postgres repositories", () => {
    it("starts independent settings queries in parallel for pool executors", async () => {
        const resolvers: Array<() => void> = [];
        const query = vi.fn(
            () =>
                new Promise<{ rows: Record<string, unknown>[]; rowCount: number }>((resolve) => {
                    resolvers.push(() => resolve({ rows: [], rowCount: 0 }));
                }),
        );
        const loading = createPostgresRepositories({ query } as unknown as QueryExecutor).settings.getSettings();

        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3));
        resolvers.forEach((resolve) => resolve());

        await expect(loading).resolves.toEqual({ settings: undefined, plans: [], channels: [] });
    });

    it("loads settings without touching user or billing tables", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "default",
                    site: {},
                    mail: {},
                    model_point_costs: {},
                    generation_point_multipliers: {},
                    generation_concurrency: {},
                    generation_defaults: {},
                    payment_config: {},
                    default_models: {},
                    default_plan_id: "free",
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
            [
                {
                    id: "free",
                    name: "免费版",
                    enabled: true,
                    limits: {},
                    features: [],
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
            [],
        ]);

        const settings = await createPostgresRepositories(executor).settings.getSettings();

        expect(settings.settings?.defaultPlanId).toBe("free");
        expect(settings.plans).toHaveLength(1);
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls.map((_, index) => String(queryArgs(query, index)[0]))).toEqual([expect.stringContaining("FROM app_settings"), expect.stringContaining("FROM entitlement_plans"), expect.stringContaining("FROM system_model_channels")]);
    });

    it("loads wallet settings without loading model channels", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [{ id: "default", free_daily_points_enabled: true, free_daily_points: 3, default_plan_id: "free", created_at: timestamp, updated_at: timestamp }],
            [{ id: "free", name: "免费版", enabled: true, daily_points: 0, limits: {}, features: [], created_at: timestamp, updated_at: timestamp }],
        ]);

        const settings = await createPostgresRepositories(executor).settings.getWalletSettings();

        expect(settings.plans).toHaveLength(1);
        expect(query).toHaveBeenCalledTimes(2);
        expect([0, 1].map((index) => String(queryArgs(query, index)[0]))).toEqual([expect.stringContaining("FROM app_settings"), expect.stringContaining("FROM entitlement_plans")]);
        expect(String(queryArgs(query, 0)[0])).not.toContain("system_model_channels");
    });

    it("maps and updates ecommerce model role JSON", async () => {
        const timestamp = "2026-09-24T00:00:00.000Z";
        const ecommerceModelRoles = {
            vision_analysis: ["vision-fast"],
            edit_planning: ["planner-pro"],
            image_generation: ["gpt-image-2.5-flare", "nano-banana-2"],
            quality_check: ["quality-pro"],
        };
        const { executor, query } = mockExecutor([[{ id: "default", ecommerce_model_roles: ecommerceModelRoles, created_at: timestamp, updated_at: timestamp }]]);

        const settings = await createPostgresRepositories(executor).settings.updateSettings({ ecommerceModelRoles });

        expect(String(queryArgs(query, 0)[0])).toContain("ecommerce_model_roles");
        expect(queryArgs(query, 0)[1]).toEqual([JSON.stringify(ecommerceModelRoles)]);
        expect(settings.ecommerceModelRoles).toEqual(ecommerceModelRoles);
    });

    it("persists channel configuration without validation records", async () => {
        const timestamp = "2026-08-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "channel-one",
                    name: "主渠道",
                    base_url: "https://api.example.com/v1",
                    api_key_ciphertext: "ciphertext",
                    webhook_secret_ciphertext: "webhook-ciphertext",
                    api_format: "openai",
                    models: ["gpt-test"],
                    enabled: true,
                    sort_order: 0,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
        ]);

        const channel = await createPostgresRepositories(executor).settings.upsertSystemModelChannel({
            id: "channel-one",
            name: "主渠道",
            baseUrl: "https://api.example.com/v1",
            apiKeyCiphertext: "ciphertext",
            webhookSecretCiphertext: "webhook-ciphertext",
            apiFormat: "openai",
            models: ["gpt-test"],
            enabled: true,
            sortOrder: 0,
        });

        expect(String(queryArgs(query, 0)[0])).not.toContain("health_results");
        expect((queryArgs(query, 0)[1] as unknown[])[4]).toBe("webhook-ciphertext");
        expect((queryArgs(query, 0)[1] as unknown[])[9]).toBe(0);
        expect(channel.webhookSecretCiphertext).toBe("webhook-ciphertext");
    });

    it("loads an authenticated user with one targeted session query", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "user-one",
                    username: "user-one",
                    display_name: "User One",
                    role: "user",
                    status: "active",
                    plan_id: "pro",
                    points_balance: 120,
                    password_hash: "hash",
                    created_at: timestamp,
                    updated_at: timestamp,
                    resolved_plan_id: "pro",
                    resolved_plan_name: "专业版",
                },
            ],
        ]);

        const user = await createPostgresRepositories(executor).sessions.getAuthenticatedUser({ sessionId: "session-one", tokenHash: "token-hash", now: timestamp, date: "2026-01-01" });

        expect(user).toMatchObject({
            user: { id: "user-one", username: "user-one", pointsBalance: 120 },
            planId: "pro",
            planName: "专业版",
            hasActivePlan: false,
            permanentPoints: 120,
            dailyPoints: 0,
        });
        expect(query).toHaveBeenCalledTimes(1);
        expect(queryArgs(query, 0)[0]).toContain("sessions.id = $1");
        expect(queryArgs(query, 0)[0]).toContain("sessions.token_hash = $2");
        expect(queryArgs(query, 0)[0]).toContain("sessions.expires_at > $3");
        expect(queryArgs(query, 0)[0]).not.toContain("check_ins");
        expect(queryArgs(query, 0)[1]).toEqual(["session-one", "token-hash", timestamp, "2026-01-01"]);
    });

    it("looks up a login by username or email without reading the user table", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "user-one",
                    username: "user-one",
                    email: "user@example.com",
                    display_name: "User One",
                    role: "user",
                    status: "active",
                    plan_id: "free",
                    points_balance: 20,
                    password_hash: "hash",
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
        ]);

        const user = await createPostgresRepositories(executor).users.getByLogin("user-one", "user@example.com");

        expect(user).toMatchObject({ id: "user-one", email: "user@example.com" });
        expect(query).toHaveBeenCalledTimes(1);
        expect(queryArgs(query, 0)[0]).toContain("lower(username) = lower($1)");
        expect(queryArgs(query, 0)[0]).toContain("lower(coalesce(email, '')) = lower($2)");
        expect(queryArgs(query, 0)[1]).toEqual(["user-one", "user@example.com"]);
    });

    it("creates a session with one insert query", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "session-one",
                    user_id: "user-one",
                    token_hash: "token-hash",
                    created_at: timestamp,
                    expires_at: "2026-01-08T00:00:00.000Z",
                },
            ],
        ]);

        const session = await createPostgresRepositories(executor).sessions.create({
            id: "session-one",
            userId: "user-one",
            tokenHash: "token-hash",
            createdAt: timestamp,
            expiresAt: "2026-01-08T00:00:00.000Z",
        });

        expect(session).toMatchObject({ id: "session-one", userId: "user-one" });
        expect(query).toHaveBeenCalledTimes(1);
        expect(queryArgs(query, 0)[0]).toContain("INSERT INTO sessions");
        expect(queryArgs(query, 0)[1]).toEqual(["session-one", "user-one", "token-hash", timestamp, "2026-01-08T00:00:00.000Z"]);
    });

    it("updates one user row without rewriting sessions or point records", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "user-one",
                    account_id: 1,
                    username: "user-one",
                    email: null,
                    display_name: "User One",
                    role: "user",
                    status: "active",
                    plan_id: "free",
                    points_balance: 20,
                    password_hash: "hash",
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
        ]);

        await createPostgresRepositories(executor).users.update("user-one", { email: null, displayName: "User One" });

        const [sql, params] = queryArgs(query, 0) as [string, unknown[]];
        expect(sql).toContain("WHERE id = $1");
        expect(sql).toContain("email = CASE WHEN $3::boolean");
        expect(sql).not.toMatch(/DELETE FROM (sessions|point_records|quota_usage)/);
        expect(params.slice(0, 5)).toEqual(["user-one", undefined, true, null, "User One"]);
    });

    it("locks and persists one email verification attempt", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "code-one",
                    purpose: "password-reset",
                    email: "user@example.com",
                    code_hash: "hash",
                    created_at: timestamp,
                    expires_at: "2026-01-01T00:10:00.000Z",
                    attempts: 1,
                },
            ],
            [
                {
                    id: "code-one",
                    purpose: "password-reset",
                    email: "user@example.com",
                    code_hash: "hash",
                    created_at: timestamp,
                    expires_at: "2026-01-01T00:10:00.000Z",
                    attempts: 2,
                },
            ],
        ]);
        const emailCodes = createPostgresRepositories(executor).emailCodes;

        await emailCodes.findActive({ purpose: "password-reset", email: "user@example.com", now: timestamp }, true);
        await emailCodes.updateAttempt("code-one", 2);

        expect(String(queryArgs(query, 0)[0])).toContain("FOR UPDATE");
        expect(String(queryArgs(query, 1)[0])).toContain("UPDATE email_codes SET attempts = $2");
        expect(queryArgs(query, 1)[1]).toEqual(["code-one", 2, null]);
    });

    it("deletes sessions by user with one targeted statement", async () => {
        const { executor, query } = mockExecutor([[]]);

        await createPostgresRepositories(executor).sessions.deleteByUserId("user-one");

        expect(queryArgs(query, 0)).toEqual(["DELETE FROM sessions WHERE user_id = $1", ["user-one"]]);
    });

    it("paginates and searches users before loading wallet details", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const userRow = { id: "admin-one", username: "admin-one", display_name: "管理员", role: "admin", status: "active", plan_id: "pro", points_balance: 40, password_hash: "hash", created_at: timestamp, updated_at: timestamp };
        const { executor, query } = mockExecutor([
            [{ total: 41 }],
            [userRow],
            [
                {
                    ...userRow,
                    resolved_plan_id: "pro",
                    resolved_plan_name: "专业版",
                    active_assignment_id: "assignment-one",
                    active_assignment_metadata: { dailyPoints: 30 },
                    daily_wallet_user_id: "admin-one",
                    daily_wallet_plan_id: "pro",
                    daily_wallet_assignment_id: "assignment-one",
                    daily_wallet_granted_points: 30,
                    daily_wallet_remaining_points: 12,
                },
            ],
        ]);
        const users = createPostgresRepositories(executor).users;

        const page = await users.list({ page: 9, pageSize: 20, keyword: "管理员", role: "admin", status: "active" });
        const details = await users.getPublicDetails(
            page.items.map((user) => user.id),
            { now: timestamp, date: "2026-01-01" },
        );

        expect(page).toMatchObject({ total: 41, page: 3, pageSize: 20, items: [{ id: "admin-one" }] });
        expect(details[0]).toMatchObject({ planId: "pro", planName: "专业版", hasActivePlan: true, permanentPoints: 40, dailyPoints: 12 });
        expect(queryArgs(query, 0)[0]).toContain("CASE WHEN role = 'admin' THEN '管理员'");
        expect(queryArgs(query, 0)[0]).toContain("lpad(account_id::text, 4, '0') LIKE $2");
        expect(queryArgs(query, 0)[1]).toEqual(["管理员", "%管理员%", "admin", "active"]);
        expect(queryArgs(query, 1)[1]).toEqual(["管理员", "%管理员%", "admin", "active", 20, 40]);
        expect(queryArgs(query, 2)[0]).toContain("users.id = ANY($1::text[])");
        expect(queryArgs(query, 2)[1]).toEqual([["admin-one"], timestamp, "2026-01-01"]);
    });

    it("summarizes users without returning the full user table", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([[{ total: 10, active: 8, disabled: 2, admins: 2, active_admins: 1, users_with_plan: 3, total_points_balance: 980.5 }]]);

        const summary = await createPostgresRepositories(executor).users.summarize({ now: timestamp, date: "2026-01-01" });

        expect(summary).toEqual({ total: 10, active: 8, disabled: 2, admins: 2, activeAdmins: 1, usersWithPlan: 3, totalPointsBalance: 980.5 });
        expect(query).toHaveBeenCalledTimes(1);
        expect(queryArgs(query, 0)[0]).toContain("count(*) FILTER (WHERE active_assignment_id IS NOT NULL)");
        expect(queryArgs(query, 0)[1]).toEqual([timestamp, "2026-01-01"]);
    });

    it("paginates CDK codes and loads redemptions only for the current page", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [{ total: 4 }],
            [{ total: 8, redeemed: 3, unused: 4, expired: 1 }],
            [
                {
                    id: "cdk-one",
                    code_hash: "hash-one",
                    code_ciphertext: "ciphertext",
                    code_preview: "CDK-ONE",
                    points: 20,
                    max_redemptions: 1,
                    redeemed_count: 1,
                    status: "active",
                    note: "测试",
                    created_at: timestamp,
                    updated_at: timestamp,
                    redemptions: [{ cdk_code_id: "cdk-one", user_id: "user-one", redeemed_at: timestamp, account_id: 1, username: "user-one", display_name: "用户一" }],
                },
            ],
        ]);

        const page = await createPostgresRepositories(executor).cdk.list({ page: 9, pageSize: 20, keyword: "user", codeHash: "hash-user", filter: "redeemed" });

        expect(page).toMatchObject({ total: 4, page: 1, pageSize: 20, stats: { total: 8, redeemed: 3, unused: 4, expired: 1 } });
        expect(page.items[0].redemptions[0]).toMatchObject({ userId: "user-one", accountId: "0001", username: "user-one" });
        expect(query).toHaveBeenCalledTimes(3);
        expect([0, 1, 2].map((index) => String(queryArgs(query, index)[0]))).toEqual([expect.stringContaining("count(*) AS total"), expect.stringContaining("count(*) FILTER"), expect.stringContaining("LIMIT $5 OFFSET $6")]);
        expect(String(queryArgs(query, 2)[0])).not.toContain("FROM cdk_redemptions ORDER BY");
        expect(String(queryArgs(query, 2)[0])).toContain("lpad(search_users.account_id::text, 4, '0') LIKE $2");
        expect(String(queryArgs(query, 2)[0])).toContain("'account_id', users.account_id");
    });

    it("preserves a negative permanent balance in the authenticated wallet", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor } = mockExecutor([
            [
                {
                    id: "user-negative",
                    username: "user-negative",
                    display_name: "Negative Balance",
                    role: "user",
                    status: "active",
                    plan_id: "free",
                    points_balance: -80,
                    password_hash: "hash",
                    created_at: timestamp,
                    updated_at: timestamp,
                    resolved_plan_id: "free",
                    resolved_plan_name: "免费版",
                    resolved_plan_daily_points: 0,
                    free_daily_points_enabled: true,
                    free_daily_points: 20,
                },
            ],
        ]);

        const user = await createPostgresRepositories(executor).sessions.getAuthenticatedUser({ sessionId: "session-negative", tokenHash: "token-hash", now: timestamp, date: "2026-01-01" });

        expect(user).toMatchObject({ permanentPoints: -80, dailyPoints: 20 });
    });

    it("updates only the free-user daily points switch", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "default",
                    free_daily_points_enabled: false,
                    free_daily_points: 20,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
        ]);

        const settings = await createPostgresRepositories(executor).settings.updateSettings({ freeDailyPointsEnabled: false, freeDailyPoints: 20 });
        const [sql, params] = queryArgs(query, 0) as [string, unknown[]];

        expect(settings).toMatchObject({ freeDailyPointsEnabled: false, freeDailyPoints: 20 });
        expect(sql).toContain("free_daily_points_enabled");
        expect(sql).not.toContain("daily_plan_points_enabled");
        expect(sql).not.toContain("site =");
        expect(params).toEqual([false, 20]);
    });

    it("persists generation cost controls as structured settings", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const generationCostControl = { maxPointsPerTask: 2.5, dailyUserPointSpend: 20, dailyTotalPointSpend: 100 };
        const { executor, query } = mockExecutor([[{ id: "default", generation_cost_control: generationCostControl, created_at: timestamp, updated_at: timestamp }]]);

        const settings = await createPostgresRepositories(executor).settings.updateSettings({ generationCostControl });
        const [sql, params] = queryArgs(query, 0) as [string, unknown[]];

        expect(settings.generationCostControl).toEqual(generationCostControl);
        expect(sql).toContain("generation_cost_control = $1");
        expect(sql).not.toContain("site =");
        expect(params).toEqual([JSON.stringify(generationCostControl)]);
    });

    it("persists bounded technical data lifecycle settings", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const dataLifecycle = { cleanupExpiredSessions: true, cleanupExpiredEmailCodes: true, cleanupExpiredGenerationTasks: false, cleanupExpiredTemporaryMedia: true, maintenanceBatchSize: 80 };
        const { executor, query } = mockExecutor([[{ id: "default", data_lifecycle: dataLifecycle, created_at: timestamp, updated_at: timestamp }]]);

        const settings = await createPostgresRepositories(executor).settings.updateSettings({ dataLifecycle });
        const [sql, params] = queryArgs(query, 0) as [string, unknown[]];

        expect(settings.dataLifecycle).toEqual(dataLifecycle);
        expect(sql).toContain("data_lifecycle = $1");
        expect(sql).not.toContain("site =");
        expect(params).toEqual([JSON.stringify(dataLifecycle)]);
    });

    it("preserves the product list boolean contract", async () => {
        const { executor, query } = mockExecutor([
            [
                {
                    id: "product-pro",
                    plan_id: "pro",
                    name: "Pro",
                    amount_cents: 1990,
                    currency: "CNY",
                    enabled: true,
                    created_at: "2026-01-01T00:00:00.000Z",
                    updated_at: "2026-01-01T00:00:00.000Z",
                },
            ],
        ]);

        const products = await createPostgresRepositories(executor).billing.listProducts(true);

        expect(products).toHaveLength(1);
        expect(products[0]).toMatchObject({ id: "product-pro", planId: "pro" });
        expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM billing_products"), [true]);
    });

    it("only deletes billing products without order references", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([[{ id: "unused", plan_id: "creator", name: "Unused", amount_cents: 100, currency: "CNY", enabled: true, created_at: timestamp, updated_at: timestamp }]]);

        const deleted = await createPostgresRepositories(executor).billing.deleteProductIfUnused("unused");

        expect(deleted?.id).toBe("unused");
        expect(queryArgs(query, 0)[0]).toContain("NOT EXISTS");
        expect(queryArgs(query, 0)[1]).toEqual(["unused"]);
    });

    it("keeps boolean row locking for billing orders", async () => {
        const { executor, query } = mockExecutor([[{ id: "order-one", status: "pending", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }]]);

        await createPostgresRepositories(executor).billing.getOrderById("order-one", true);

        expect(queryArgs(query, 0)[0]).toContain("FOR UPDATE");
        expect(queryArgs(query, 0)[1]).toEqual(["order-one"]);
    });

    it("atomically closes expired pending orders with skip-locked batching", async () => {
        const timestamp = "2026-07-25T00:00:00.000Z";
        const { executor, query } = mockExecutor([[{ id: "order-one", status: "closed", expires_at: timestamp, closed_at: timestamp, metadata: { close: { source: "expiration-job" } }, created_at: timestamp, updated_at: timestamp }]]);

        const expired = await createPostgresRepositories(executor).billing.expirePendingOrders({ expiredAt: timestamp, limit: 100 });

        expect(expired).toHaveLength(1);
        expect(queryArgs(query, 0)[0]).toContain("FOR UPDATE SKIP LOCKED");
        expect(queryArgs(query, 0)[0]).toContain("orders.status = 'pending'");
        expect(queryArgs(query, 0)[1]).toEqual([timestamp, 100, null, "订单超时自动关闭", "expiration-job"]);
    });

    it("locks wallet rows and resolves point records by idempotency and refund source", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [{ id: "user-one", username: "user-one", display_name: "User One", role: "user", status: "active", plan_id: "pro", points_balance: 80, password_hash: "hash", created_at: timestamp, updated_at: timestamp }],
            [
                {
                    id: "point-one",
                    user_id: "user-one",
                    type: "consume",
                    amount: -20,
                    balance_after: 60,
                    permanent_amount: -10,
                    daily_amount: -10,
                    permanent_balance_after: 40,
                    daily_balance_after: 20,
                    description: "生成图片",
                    idempotency_key: "image:task-one",
                    request_fingerprint: "a".repeat(64),
                    source_date: "2026-01-01",
                    created_at: timestamp,
                },
            ],
            [
                {
                    id: "refund-one",
                    user_id: "user-one",
                    type: "refund",
                    amount: 20,
                    balance_after: 80,
                    permanent_amount: 10,
                    daily_amount: 10,
                    permanent_balance_after: 50,
                    daily_balance_after: 30,
                    description: "生成失败退回",
                    source_record_id: "point-one",
                    source_date: "2026-01-01",
                    created_at: timestamp,
                },
            ],
        ]);
        const repos = createPostgresRepositories(executor);

        await repos.users.getById("user-one", true);
        const record = await repos.points.getRecordByIdempotencyKey("image:task-one");
        const refund = await repos.points.getRefundRecordBySourceRecordId("point-one");

        expect(record).toMatchObject({ id: "point-one", permanentAmount: -10, dailyAmount: -10, idempotencyKey: "image:task-one", requestFingerprint: "a".repeat(64) });
        expect(refund).toMatchObject({ id: "refund-one", sourceRecordId: "point-one" });
        expect(queryArgs(query, 0)[0]).toContain("FOR UPDATE");
        expect(queryArgs(query, 0)[1]).toEqual(["user-one"]);
        expect(queryArgs(query, 1)[0]).toContain("WHERE idempotency_key = $1");
        expect(queryArgs(query, 1)[1]).toEqual(["image:task-one"]);
        expect(queryArgs(query, 2)[0]).toContain("type = 'refund'");
        expect(queryArgs(query, 2)[1]).toEqual(["point-one"]);
    });

    it("filters and paginates debit point records in PostgreSQL", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "point-one",
                    user_id: "user-one",
                    type: "consume",
                    amount: -20,
                    balance_after: 60,
                    permanent_amount: -20,
                    daily_amount: 0,
                    permanent_balance_after: 60,
                    daily_balance_after: 0,
                    description: "生成视频",
                    created_at: timestamp,
                    total_count: "17",
                },
            ],
        ]);

        const result = await createPostgresRepositories(executor).points.listRecords("user-one", { direction: "debit", page: 2, pageSize: 8 });

        expect(result).toMatchObject({ total: 17, page: 2, pageSize: 8, items: [{ id: "point-one", amount: -20 }] });
        expect(queryArgs(query, 0)[0]).toContain("$2 = 'debit' AND amount < 0");
        expect(queryArgs(query, 0)[1]).toEqual(["user-one", "debit", 8, 8]);
    });

    it("creates one daily plan wallet and can lock the existing row", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const walletRow = { user_id: "user-one", date: "2026-01-01", plan_id: "pro", assignment_id: "assignment-one", granted_points: 100, remaining_points: 100, created_at: timestamp, updated_at: timestamp };
        const { executor, query } = mockExecutor([[walletRow], [walletRow]]);
        const wallet = createPostgresRepositories(executor).pointsWallet;

        const created = await wallet.createDailyWallet({ userId: "user-one", date: "2026-01-01", planId: "pro", assignmentId: "assignment-one", grantedPoints: 100, remainingPoints: 100, createdAt: timestamp, updatedAt: timestamp });
        const locked = await wallet.getDailyWallet("user-one", "2026-01-01", true);

        expect(created).toMatchObject({ userId: "user-one", planId: "pro", grantedPoints: 100, remainingPoints: 100 });
        expect(locked?.assignmentId).toBe("assignment-one");
        expect(queryArgs(query, 0)[0]).toContain("ON CONFLICT (user_id, date) DO NOTHING");
        expect(queryArgs(query, 1)[0]).toContain("FOR UPDATE");
        expect(queryArgs(query, 1)[1]).toEqual(["user-one", "2026-01-01"]);
    });

    it("casts decimal daily wallet balances to PostgreSQL numeric", async () => {
        const walletRow = { user_id: "user-one", date: "2026-01-01", plan_id: "pro", assignment_id: null, granted_points: 2, remaining_points: 1.7 };
        const { executor, query } = mockExecutor([[walletRow]]);

        const updated = await createPostgresRepositories(executor).pointsWallet.updateRemaining("user-one", "2026-01-01", 1.7);

        expect(updated?.remainingPoints).toBe(1.7);
        expect(queryArgs(query, 0)[0]).toContain("SET remaining_points = $3::numeric");
        expect(queryArgs(query, 0)[0]).toContain("$3::numeric >= 0::numeric");
        expect(queryArgs(query, 0)[1]).toEqual(["user-one", "2026-01-01", 1.7]);
    });

    it("selects one current assignment with stable ordering", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([[{ id: "assignment-one", user_id: "user-one", plan_id: "pro", status: "active", source: "order", starts_at: timestamp, created_at: timestamp, updated_at: timestamp }]]);

        const assignment = await createPostgresRepositories(executor).billing.getActivePlanAssignment("user-one", new Date(timestamp), true);

        expect(assignment?.id).toBe("assignment-one");
        expect(queryArgs(query, 0)[0]).toContain("ORDER BY starts_at DESC, created_at DESC, id DESC");
        expect(queryArgs(query, 0)[0]).toContain("FOR UPDATE");
        expect(queryArgs(query, 0)[1]).toEqual(["user-one", timestamp]);
    });

    it("writes plan assignments and provider events to the established tables", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [{ id: "assignment-one", user_id: "user-one", plan_id: "pro", status: "active", source: "order", source_id: "order-one", starts_at: timestamp, created_at: timestamp, updated_at: timestamp }],
            [{ id: "event-one", provider: "stripe", event_id: "evt-one", event_type: "paid", signature_valid: true, created_at: timestamp, updated_at: timestamp }],
        ]);
        const billing = createPostgresRepositories(executor).billing;

        await billing.createPlanAssignment({
            id: "assignment-one",
            userId: "user-one",
            planId: "pro",
            status: "active",
            source: "order",
            sourceId: "order-one",
            startsAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        await billing.upsertProviderEvent({
            id: "event-one",
            provider: "stripe",
            eventId: "evt-one",
            eventType: "paid",
            signatureValid: true,
            createdAt: timestamp,
            updatedAt: timestamp,
        });

        expect(queryArgs(query, 0)[0]).toContain("INSERT INTO user_plan_assignments");
        expect(queryArgs(query, 1)[0]).toContain("INSERT INTO payment_provider_events");
    });

    it("atomically deduplicates and claims payment provider events", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const eventRow = { id: "event-one", provider: "stripe", event_id: "evt-one", event_type: "paid", signature_valid: true, created_at: timestamp, updated_at: timestamp };
        const { executor, query } = mockExecutor([[eventRow], [{ ...eventRow, processing_at: timestamp }]]);
        const billing = createPostgresRepositories(executor).billing;

        const recorded = await billing.upsertProviderEvent({
            id: "event-one",
            provider: "stripe",
            eventId: "evt-one",
            eventType: "paid",
            signatureValid: true,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        const claimed = await billing.claimProviderEvent("event-one");

        expect(recorded).toMatchObject({ event: { id: "event-one" }, conflict: false });
        expect(claimed?.processingAt).toBe(timestamp);
        expect(queryArgs(query, 0)[0]).toContain("ON CONFLICT (provider, event_id)");
        expect(queryArgs(query, 0)[0]).toContain("DO NOTHING");
        expect(queryArgs(query, 0)[0]).toContain("RETURNING *");
        expect(queryArgs(query, 1)[0]).toContain("processed_at IS NULL");
        expect(queryArgs(query, 1)[0]).toContain("processing_at IS NULL OR processing_at < now() - interval '5 minutes'");
        expect(queryArgs(query, 1)[0]).toContain("RETURNING *");
        expect(queryArgs(query, 1)[1]).toEqual(["event-one"]);
    });

    it("preserves the original payment and event record when a duplicate identity conflicts", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const paymentRow = {
            id: "payment-one",
            order_id: "order-one",
            user_id: "user-one",
            provider: "stripe",
            channel: "webhook",
            status: "succeeded",
            amount_cents: 1299,
            currency: "CNY",
            provider_trade_id: "trade-one",
            created_at: timestamp,
            updated_at: timestamp,
        };
        const eventRow = { id: "event-one", provider: "stripe", event_id: "evt-one", event_type: "paid", order_id: "order-one", signature_valid: true, payload: { amountCents: 1299 }, created_at: timestamp, updated_at: timestamp };
        const { executor, query } = mockExecutor([[], [paymentRow], [], [eventRow]]);
        const billing = createPostgresRepositories(executor).billing;

        const payment = await billing.upsertPayment({
            id: "payment-one",
            orderId: "order-two",
            userId: "user-two",
            provider: "stripe",
            channel: "webhook",
            status: "succeeded",
            amountCents: 1299,
            currency: "CNY",
            providerTradeId: "trade-one",
            createdAt: timestamp,
            updatedAt: timestamp,
        });
        const event = await billing.upsertProviderEvent({
            id: "event-two",
            provider: "stripe",
            eventId: "evt-one",
            eventType: "paid",
            orderId: "order-two",
            signatureValid: true,
            payload: { amountCents: 1299 },
            createdAt: timestamp,
            updatedAt: timestamp,
        });

        expect(payment).toMatchObject({ orderId: "order-one", userId: "user-one" });
        expect(event).toMatchObject({ event: { id: "event-one", orderId: "order-one" }, conflict: true });
        expect(queryArgs(query, 0)[0]).toContain("ON CONFLICT (id) DO NOTHING");
        expect(queryArgs(query, 1)[0]).toContain("SELECT * FROM payment_transactions WHERE id = $1");
        expect(queryArgs(query, 2)[0]).toContain("ON CONFLICT (provider, event_id)");
        expect(queryArgs(query, 3)[0]).toContain("SELECT * FROM payment_provider_events");
    });

    it("updates payment state without allowing transaction ownership fields to change", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const refundedAt = "2026-01-02T00:00:00.000Z";
        const paymentRow = {
            id: "payment-one",
            order_id: "order-one",
            user_id: "user-one",
            provider: "stripe",
            channel: "webhook",
            status: "refunded",
            amount_cents: 1299,
            currency: "CNY",
            provider_trade_id: "trade-one",
            refunded_at: refundedAt,
            created_at: timestamp,
            updated_at: refundedAt,
        };
        const { executor, query } = mockExecutor([[paymentRow]]);

        const payment = await createPostgresRepositories(executor).billing.updatePaymentState({
            id: "payment-one",
            orderId: "order-one",
            userId: "different-user-is-ignored",
            provider: "stripe",
            channel: "different-channel-is-ignored",
            status: "refunded",
            amountCents: 1,
            currency: "USD",
            providerTradeId: "different-trade-is-ignored",
            refundedAt,
            createdAt: timestamp,
            updatedAt: refundedAt,
        });

        expect(payment).toMatchObject({ orderId: "order-one", userId: "user-one", providerTradeId: "trade-one", amountCents: 1299, currency: "CNY", status: "refunded" });
        expect(queryArgs(query, 0)[0]).toContain("WHERE id = $1 AND order_id = $2 AND provider = $3");
        expect(queryArgs(query, 0)[0]).not.toContain("user_id =");
        expect(queryArgs(query, 0)[0]).not.toContain("provider_trade_id =");
    });

    it("replaces generation assets during upsert", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([[{ id: "log-one", user_id: "user-one", kind: "image", status: "success", created_at: timestamp, updated_at: timestamp }], [], []]);
        const asset = { type: "image" as const, url: "/api/media/file-one", mimeType: "image/png" };

        const saved = await createPostgresRepositories(executor).generationLogs.upsert({
            id: "log-one",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "image",
            source: "create",
            status: "success",
            title: "Image",
            prompt: "prompt",
            model: "image-model",
            summary: "done",
            durationMs: 1,
            count: 1,
            successCount: 1,
            failCount: 0,
            assets: [asset],
            createdAt: timestamp,
            updatedAt: timestamp,
        });

        expect(saved.assets).toEqual([asset]);
        expect(queryArgs(query, 1)[0]).toContain("DELETE FROM generation_log_assets");
        expect(queryArgs(query, 2)[0]).toContain("INSERT INTO generation_log_assets");
        expect(query.mock.calls.map((_, index) => String(queryArgs(query, index)[0])).some((statement) => statement.includes("DELETE FROM generation_logs"))).toBe(false);
    });

    it("rejects a generation log upsert when the id belongs to another user", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([[]]);

        await expect(
            createPostgresRepositories(executor).generationLogs.upsert({
                id: "shared-log",
                userId: "user-two",
                username: "user-two",
                displayName: "User Two",
                kind: "image",
                source: "unknown",
                status: "success",
                title: "Image",
                prompt: "prompt",
                model: "image-model",
                summary: "done",
                durationMs: 1,
                count: 1,
                successCount: 1,
                failCount: 0,
                assets: [],
                createdAt: timestamp,
                updatedAt: timestamp,
            }),
        ).rejects.toThrow("belongs to another user");

        expect(query).toHaveBeenCalledTimes(1);
        expect(queryArgs(query, 0)[0]).toContain("WHERE generation_logs.user_id = EXCLUDED.user_id");
    });

    it("deletes only the requested generation log ids", async () => {
        const { executor, query } = mockExecutor([[]]);

        const deleted = await createPostgresRepositories(executor).generationLogs.delete(["log-one", "log-three"]);

        expect(deleted).toBe(1);
        expect(query).toHaveBeenCalledWith("DELETE FROM generation_logs WHERE id = ANY($1::text[])", [["log-one", "log-three"]]);
    });

    it("attaches one private ecommerce trace to the exact image task ids", async () => {
        const { executor, query } = mockExecutor([[]]);
        const trace = { version: "ecommerce-generation-trace.v1", runId: "agent-run-one", stages: [] };

        const updated = await createPostgresRepositories(executor).generationLogs.updateEcommerceTraceByTaskIds([" image-one ", "image-one", "image-two"], trace);

        expect(updated).toBe(1);
        const [statement, params] = queryArgs(query, 0);
        expect(String(statement)).toContain("SET ecommerce_trace = $2::jsonb");
        expect(String(statement)).toContain("WHERE task_id = ANY($1::text[])");
        expect(params).toEqual([["image-one", "image-two"], JSON.stringify(trace)]);
    });

    it.each([null, { version: "ecommerce-generation-trace.v1", finalStatus: "completed" }])("compares the previous log trace before reconciliation (%j)", async (expectedTrace) => {
        const { executor, query } = mockExecutor([[]]);
        const trace = { finalStatus: "completed" };
        await createPostgresRepositories(executor).generationLogs.updateEcommerceTraceByTaskIds(["image-one"], trace, expectedTrace);
        const [statement, params] = queryArgs(query, 0);
        expect(String(statement)).toContain("ecommerce_trace IS NOT DISTINCT FROM $3::jsonb");
        expect(params).toEqual([["image-one"], JSON.stringify(trace), expectedTrace === null ? null : JSON.stringify(expectedTrace)]);
    });

    it("loads one stable, parameterized generation-log deletion batch with its assets", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                { id: "log-b", user_id: "user-one", kind: "image", status: "success", created_at: timestamp, updated_at: timestamp },
                { id: "log-a", user_id: "user-one", kind: "image", status: "success", created_at: timestamp, updated_at: timestamp },
            ],
            [{ generation_log_id: "log-b", type: "image", url: "/api/generation-log-assets/one.webp", sort_order: 0 }],
        ]);

        const logs = await createPostgresRepositories(executor).generationLogs.listByUserIdBatch(" user-one ", 24, true);

        expect(logs).toHaveLength(2);
        expect(logs[0]?.id).toBe("log-b");
        expect(logs[0]?.assets).toHaveLength(1);
        expect(query).toHaveBeenCalledTimes(2);
        const [statement, params] = queryArgs(query, 0);
        expect(String(statement)).toContain("WHERE user_id = $1");
        expect(String(statement)).toContain("ORDER BY created_at DESC, id ASC");
        expect(String(statement)).toContain("LIMIT $2::integer");
        expect(String(statement)).toContain("FOR UPDATE");
        expect(params).toEqual(["user-one", 24]);
    });

    it("rejects an unbounded or invalid generation-log deletion batch", async () => {
        const { executor, query } = mockExecutor([]);
        const repository = createPostgresRepositories(executor).generationLogs;

        await expect(repository.listByUserIdBatch("user-one", 0, true)).rejects.toThrow("positive safe integer");
        expect(query).not.toHaveBeenCalled();
    });

    it("aggregates the generation overview in one bounded query without loading log payloads or assets", async () => {
        const { executor, query } = mockExecutor([
            [
                {
                    total_calls: 8,
                    success_calls: 6,
                    failed_calls: 1,
                    active_users: 3,
                    daily: [{ key: "2026-07-25", value: 3 }],
                    models: [{ key: "image-pro", value: 5 }],
                    sources: [{ key: "canvas", value: 4 }],
                    kinds: [{ key: "image", value: 6 }],
                },
            ],
        ]);

        const summary = await createPostgresRepositories(executor).generationLogs.getOverviewAggregate({
            startAt: "2026-07-19T16:00:00.000Z",
            endAt: "2026-07-26T16:00:00.000Z",
            timeZone: "Asia/Shanghai",
        });

        expect(summary).toMatchObject({ totalCalls: 8, successCalls: 6, failedCalls: 1, activeUsers: 3, models: [{ key: "image-pro", value: 5 }] });
        expect(query).toHaveBeenCalledTimes(1);
        const [statement, params] = queryArgs(query, 0);
        expect(String(statement)).toContain("WITH scoped AS MATERIALIZED");
        expect(String(statement)).toContain("created_at >= $1::timestamptz AND created_at < $2::timestamptz");
        expect(String(statement)).not.toMatch(/\bprompt\b|\berror\b|generation_log_assets|SELECT\s+\*/i);
        expect(params).toEqual(["2026-07-19T16:00:00.000Z", "2026-07-26T16:00:00.000Z", "Asia/Shanghai"]);
    });

    it("loads the create workbench summary in one bounded query", async () => {
        const timestamp = "2026-07-26T12:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    running_tasks: [{ id: "pending-one", kind: "video", source: "agent", title: "生成短片", createdAt: timestamp }],
                    recent_assets: [{ id: "success-one-0", kind: "image", title: "商品图", url: "/api/media/image.webp", createdAt: timestamp }],
                },
            ],
        ]);

        const overview = await createPostgresRepositories(executor).generationLogs.getCreateOverview("user-one");

        expect(overview).toEqual({
            runningTasks: [{ id: "pending-one", kind: "video", source: "agent", title: "生成短片", createdAt: timestamp }],
            recentAssets: [{ id: "success-one-0", kind: "image", title: "商品图", url: "/api/media/image.webp", createdAt: timestamp }],
        });
        expect(query).toHaveBeenCalledTimes(1);
        const [statement, params] = queryArgs(query, 0);
        expect(String(statement)).toContain("LIMIT 4");
        expect(String(statement)).toContain("LIMIT $2::integer");
        expect(String(statement)).toContain("LEFT JOIN generation_tasks image_task");
        expect(String(statement)).toContain("image_task.user_id = log.user_id");
        expect(String(statement)).toContain("image_task.id = log.task_id");
        expect(String(statement)).toContain("'{ecommerceTrace,finalStatus}'");
        expect(String(statement)).toContain("'ecommerceExecution'");
        expect(String(statement)).toContain("trace ->> 'mode' = 'shadow'");
        expect(String(statement)).toContain("jsonb_typeof(trace -> 'stages') = 'array'");
        expect(String(statement)).toContain("= 'passed'");
        expect(String(statement)).not.toMatch(/SELECT\s+\*|\bprompt\b|\berror\b/i);
        expect(params).toEqual(["user-one", 8]);
    });

    it("pushes prompt filtering and pagination into PostgreSQL", async () => {
        const timestamp = "2026-01-01T00:00:00.000Z";
        const { executor, query } = mockExecutor([
            [
                {
                    id: "prompt-one",
                    scope: "user",
                    owner_user_id: "user-one",
                    title: "角色设定",
                    cover_url: "",
                    prompt: "电影角色",
                    tags: ["角色"],
                    category: "人物",
                    preview: "",
                    created_at: timestamp,
                    updated_at: timestamp,
                    total_count: "3",
                },
            ],
        ]);

        const result = await createPostgresRepositories(executor).prompts.list({ scope: "user", ownerUserId: "user-one", keyword: "角色", category: "人物", tags: ["角色"], page: 2, pageSize: 10 });

        expect(result).toMatchObject({ page: 2, pageSize: 10, total: 3 });
        expect(result.items[0]).toMatchObject({ id: "prompt-one", ownerUserId: "user-one" });
        expect(queryArgs(query, 0)[0]).toContain("count(*) OVER()");
        expect(queryArgs(query, 0)[0]).toContain("jsonb_array_elements_text(tags)");
        expect(queryArgs(query, 0)[0]).toContain("$1 = 'library' OR owner_user_id = $2");
        expect(queryArgs(query, 0)[1]).toEqual(["user", "user-one", "角色", "%角色%", "人物", ["角色"], 10, 10]);
    });

    it("requires an owner when listing user prompts", async () => {
        const { executor, query } = mockExecutor([[]]);

        await createPostgresRepositories(executor).prompts.list({ scope: "user", page: 1, pageSize: 20 });

        expect(queryArgs(query, 0)[1]).toEqual(["user", null, "", "%%", "", null, 20, 0]);
        expect(queryArgs(query, 0)[0]).toContain("$1 = 'library' OR owner_user_id = $2");
    });
});
