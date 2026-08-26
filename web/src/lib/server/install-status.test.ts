import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    provider: "postgres" as "file" | "postgres",
    connectionString: "postgres://vozeb:test@localhost:5432/vozeb",
    ensurePostgresSchema: vi.fn(),
    initializePostgresSchema: vi.fn(),
    postgresQuery: vi.fn(),
    getPublicUserSummary: vi.fn(),
    encryption: { ready: true, message: "加密密钥已就绪。" },
}));

vi.mock("@/lib/auth/store", () => ({
    DEFAULT_SITE_SETTINGS: { title: "星启智域", logoUrl: "/logo.svg" },
    getPublicUserSummary: mocks.getPublicUserSummary,
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: mocks.ensurePostgresSchema,
    initializePostgresSchema: mocks.initializePostgresSchema,
    getDatabaseProvider: () => mocks.provider,
    getPostgresConnectionString: () => mocks.connectionString,
    postgresQuery: mocks.postgresQuery,
}));

vi.mock("@/lib/server/secret-crypto", () => ({
    getEncryptionKeyStatus: () => mocks.encryption,
}));

import { getInstallStatus, initializeInstallDatabase, InstallInitializationError, invalidateInstallStatusCache } from "./install-status";

describe("install status cache", () => {
    beforeEach(() => {
        vi.stubEnv("VOZEB_PRO_INSTALL_TOKEN", "install-token-".padEnd(48, "x"));
        invalidateInstallStatusCache();
        mocks.provider = "postgres";
        mocks.connectionString = "postgres://vozeb:test@localhost:5432/vozeb";
        mocks.ensurePostgresSchema.mockReset().mockResolvedValue(undefined);
        mocks.initializePostgresSchema.mockReset().mockResolvedValue(undefined);
        mocks.postgresQuery.mockReset();
        mocks.getPublicUserSummary.mockReset();
        mocks.encryption = { ready: true, message: "加密密钥已就绪。" };
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("reuses a completed healthy installation check", async () => {
        mockHealthySchema(["3"]);

        const first = await getInstallStatus();
        const second = await getInstallStatus();

        expect(first.ready).toBe(true);
        expect(second).toBe(first);
        expect(mocks.postgresQuery).toHaveBeenCalledTimes(3);
        expect(mocks.ensurePostgresSchema).not.toHaveBeenCalled();
        expect(mocks.postgresQuery.mock.calls.map(([statement]) => String(statement))).toEqual(["SELECT 1", expect.stringContaining("to_regclass"), expect.stringContaining("count(*)")]);
    });

    it("does not retain the first-admin-required result", async () => {
        mockHealthySchema(["0", "1"]);

        expect((await getInstallStatus()).firstAdminRequired).toBe(true);
        expect((await getInstallStatus()).ready).toBe(true);
        expect(mocks.postgresQuery).toHaveBeenCalledTimes(6);
    });

    it("coalesces concurrent installation checks", async () => {
        let resolveConnection: ((value: { rows: Array<Record<string, unknown>> }) => void) | undefined;
        const connection = new Promise<{ rows: Array<Record<string, unknown>> }>((resolve) => {
            resolveConnection = resolve;
        });
        mocks.postgresQuery.mockImplementation(async (statement: string) => {
            if (statement === "SELECT 1") return connection;
            if (statement.includes("to_regclass")) return { rows: [{ table_name: "users" }] };
            return { rows: [{ total: "2" }] };
        });

        const first = getInstallStatus();
        const second = getInstallStatus();
        resolveConnection?.({ rows: [{ connected: 1 }] });

        await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ ready: true }), expect.objectContaining({ ready: true })]);
        expect(mocks.postgresQuery).toHaveBeenCalledTimes(3);
    });

    it("runs schema DDL only through the explicit initializer", async () => {
        mockHealthySchema(["0"]);

        await expect(initializeInstallDatabase(process.env.VOZEB_PRO_INSTALL_TOKEN)).resolves.toMatchObject({ firstAdminRequired: true, database: { schemaReady: true } });

        expect(mocks.initializePostgresSchema).toHaveBeenCalledTimes(1);
        expect(mocks.ensurePostgresSchema).not.toHaveBeenCalled();
    });

    it("allows an empty database to be initialized", async () => {
        let schemaReady = false;
        mocks.initializePostgresSchema.mockImplementation(async () => {
            schemaReady = true;
        });
        mocks.postgresQuery.mockImplementation(async (statement: string) => {
            if (statement === "SELECT 1") return { rows: [{ connected: 1 }] };
            if (statement.includes("to_regclass")) return { rows: [{ table_name: schemaReady ? "users" : null }] };
            return { rows: [{ total: "0" }] };
        });

        await expect(initializeInstallDatabase(process.env.VOZEB_PRO_INSTALL_TOKEN)).resolves.toMatchObject({ firstAdminRequired: true, database: { schemaReady: true } });
        expect(mocks.initializePostgresSchema).toHaveBeenCalledTimes(1);
    });

    it("rejects repeated initialization after the first user exists", async () => {
        mockHealthySchema(["1"]);

        await expect(initializeInstallDatabase(process.env.VOZEB_PRO_INSTALL_TOKEN)).rejects.toEqual(
            expect.objectContaining<Partial<InstallInitializationError>>({
                message: "项目已完成安装，禁止重复初始化数据库",
                status: 409,
            }),
        );
        expect(mocks.initializePostgresSchema).not.toHaveBeenCalled();
    });

    it("rejects a missing or incorrect install token before schema DDL", async () => {
        mockHealthySchema(["0", "0"]);

        await expect(initializeInstallDatabase(undefined)).rejects.toMatchObject({ status: 403 });
        invalidateInstallStatusCache();
        await expect(initializeInstallDatabase("wrong-token".padEnd(48, "x"))).rejects.toMatchObject({ status: 403 });
        expect(mocks.initializePostgresSchema).not.toHaveBeenCalled();
    });
});

function mockHealthySchema(userCounts: string[]) {
    mocks.postgresQuery.mockImplementation(async (statement: string) => {
        if (statement === "SELECT 1") return { rows: [{ connected: 1 }] };
        if (statement.includes("to_regclass")) return { rows: [{ table_name: "users" }] };
        return { rows: [{ total: userCounts.shift() || "0" }] };
    });
}
