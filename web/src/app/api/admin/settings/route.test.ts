import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getFreshAuthSettings: vi.fn(),
    setAuthSettings: vi.fn(),
    safeRecordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/auth/store")>();
    return { ...actual, getFreshAuthSettings: mocks.getFreshAuthSettings, setAuthSettings: mocks.setAuthSettings };
});
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.safeRecordAuditLog }));

import { GET, PATCH } from "./route";
import { DEFAULT_SITE_SETTINGS } from "@/lib/auth/store";

const savedSettings = {
    systemChannels: [{ id: "one", name: "主渠道", baseUrl: "https://api.example.com/v1", apiKey: "saved-secret", webhookSecret: "0123456789abcdef0123456789abcdef", apiFormat: "openai", models: ["vendor/writer"], enabled: true }],
    logicalModels: [{ id: "writer", name: "Writer", capability: "text", enabled: true, bindings: [{ id: "binding", channelId: "one", upstreamModel: "vendor/writer", enabled: true, priority: 1 }] }],
    defaultModels: { textModel: "writer", imageModel: "", videoModel: "", audioModel: "" },
};

describe("admin settings model routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["system.manage", "billing.manage", "upstream.manage"] });
        mocks.getFreshAuthSettings.mockResolvedValue(savedSettings);
        mocks.setAuthSettings.mockImplementation(async (patch) => ({ ...savedSettings, ...patch }));
    });

    it("saves a consistent channel, logical model, and default snapshot", async () => {
        const response = await PATCH(
            request({
                systemChannels: [{ ...savedSettings.systemChannels[0], apiKey: "", webhookSecret: "", hasApiKey: true, hasWebhookSecret: true }],
                logicalModels: savedSettings.logicalModels,
                defaultModels: savedSettings.defaultModels,
            }),
        );
        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                systemChannels: [expect.objectContaining({ id: "one", apiKey: "saved-secret", webhookSecret: savedSettings.systemChannels[0].webhookSecret })],
                logicalModels: [expect.objectContaining({ id: "writer", name: "Writer", bindings: savedSettings.logicalModels[0].bindings })],
                defaultModels: savedSettings.defaultModels,
            }),
        );
        expect(mocks.safeRecordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.settings.update", metadata: { fields: expect.arrayContaining(["systemChannels", "logicalModels", "defaultModels"]) } }));
    });

    it("deletes a channel together with stale logical bindings and defaults", async () => {
        const response = await PATCH(request({ systemChannels: [], logicalModels: savedSettings.logicalModels, defaultModels: savedSettings.defaultModels }));
        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(expect.objectContaining({ systemChannels: [], logicalModels: [], defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" } }));
    });

    it("keeps channel deletion and addition visible to an immediate fresh read", async () => {
        let persisted = structuredClone(savedSettings);
        mocks.getFreshAuthSettings.mockImplementation(async () => persisted);
        mocks.setAuthSettings.mockImplementation(async (patch) => {
            persisted = { ...persisted, ...patch };
            return persisted;
        });

        const deleted = await PATCH(request({ systemChannels: [], logicalModels: [], defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" } }));
        expect(deleted.status).toBe(200);
        const afterDelete = (await (await GET()).json()) as { settings: typeof savedSettings };
        expect(afterDelete.settings.systemChannels).toEqual([]);

        const addedChannel = { id: "two", name: "备用渠道", baseUrl: "https://backup.example.com/v1", apiKey: "new-secret", apiFormat: "openai", models: ["vendor/backup"], enabled: true };
        const added = await PATCH(request({ systemChannels: [addedChannel], logicalModels: [], defaultModels: { textModel: "", imageModel: "", videoModel: "", audioModel: "" } }));
        expect(added.status).toBe(200);
        const afterAdd = (await (await GET()).json()) as { settings: typeof savedSettings };
        expect(afterAdd.settings.systemChannels).toEqual([expect.objectContaining({ id: "two", name: "备用渠道" })]);
    });

    it("rebuilds an explicitly empty logical model catalog from channels", async () => {
        const response = await PATCH(request({ logicalModels: [], defaultModels: { ...savedSettings.defaultModels, textModel: "" } }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(expect.objectContaining({ logicalModels: [expect.objectContaining({ id: "vendor/writer", bindings: [expect.objectContaining({ channelId: "one", upstreamModel: "vendor/writer" })] })] }));
    });

    it("recreates channel-backed logical models during a later channel-only save", async () => {
        mocks.getFreshAuthSettings.mockResolvedValue({ ...savedSettings, logicalModels: [], defaultModels: { ...savedSettings.defaultModels, textModel: "" } });

        const response = await PATCH(request({ systemChannels: savedSettings.systemChannels }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(expect.objectContaining({ logicalModels: [expect.objectContaining({ id: "vendor/writer" })] }));
    });

    it("saves a disabled channel after clearing its now-unresolvable default", async () => {
        const response = await PATCH(
            request({
                systemChannels: [{ ...savedSettings.systemChannels[0], enabled: false, apiKey: "", hasApiKey: true }],
                logicalModels: savedSettings.logicalModels,
                defaultModels: savedSettings.defaultModels,
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultModels: expect.objectContaining({ textModel: "" }) }));
    });

    it("rejects a newly submitted short webhook secret instead of silently keeping the old value", async () => {
        const response = await PATCH(request({ systemChannels: [{ ...savedSettings.systemChannels[0], apiKey: "", webhookSecret: "short", hasApiKey: true, hasWebhookSecret: true }] }));

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("至少需要 32 个字符") }));
        expect(mocks.setAuthSettings).not.toHaveBeenCalled();
    });

    it("accepts administrator-configured generation cost controls", async () => {
        const generationCostControl = { maxPointsPerTask: 8.5, dailyUserPointSpend: 40, dailyTotalPointSpend: 200 };

        const response = await PATCH(request({ generationCostControl }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({ generationCostControl });
        expect(mocks.safeRecordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: { fields: ["generationCostControl"] } }));
    });

    it("accepts administrator-configured technical data lifecycle controls", async () => {
        const dataLifecycle = { cleanupExpiredSessions: true, cleanupExpiredEmailCodes: true, cleanupExpiredGenerationTasks: false, cleanupExpiredTemporaryMedia: true, maintenanceBatchSize: 80 };

        const response = await PATCH(request({ dataLifecycle }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({ dataLifecycle });
        expect(mocks.safeRecordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: { fields: ["dataLifecycle"] } }));
    });

    it("accepts common social address formats without silently deleting them", async () => {
        const site = {
            ...DEFAULT_SITE_SETTINGS,
            socials: {
                ...DEFAULT_SITE_SETTINGS.socials,
                telegram: { enabled: true, label: "Telegram", url: "t.me/vozeb_group" },
                x: { enabled: true, label: "X", url: "@vozeb_pro" },
                instagram: { enabled: true, label: "Instagram", url: "instagram.com/vozeb.pro" },
            },
        };

        const response = await PATCH(request({ site }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({ site });
    });

    it("rejects an invalid non-empty social address instead of reporting a destructive save as successful", async () => {
        const site = {
            ...DEFAULT_SITE_SETTINGS,
            socials: { ...DEFAULT_SITE_SETTINGS.socials, x: { enabled: true, label: "X", url: "not a social address" } },
        };

        const response = await PATCH(request({ site }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "X 地址无效，请填写完整链接或 @用户名" });
        expect(mocks.setAuthSettings).not.toHaveBeenCalled();
    });

    it("allows a system administrator to save only system settings", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "system-admin", role: "admin", status: "active", adminPermissions: ["system.manage"] });
        const dataLifecycle = { cleanupExpiredSessions: true, cleanupExpiredEmailCodes: true, cleanupExpiredGenerationTasks: true, cleanupExpiredTemporaryMedia: true, maintenanceBatchSize: 60 };

        const response = await PATCH(request({ registrationEnabled: false, dataLifecycle }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({ registrationEnabled: false, dataLifecycle });
    });

    it("allows an upstream administrator to save only generation settings", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "upstream-admin", role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        const generationConcurrency = { agent: 2, image: 2, video: 1, audio: 2, text: 4, render: 1 };

        const response = await PATCH(request({ generationConcurrency }));

        expect(response.status).toBe(200);
        expect(mocks.setAuthSettings).toHaveBeenCalledWith({ generationConcurrency });
    });

    it("rejects a mixed settings patch when the administrator lacks one required duty", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "system-admin", role: "admin", status: "active", adminPermissions: ["system.manage"] });

        const response = await PATCH(request({ registrationEnabled: false, generationConcurrency: { agent: 2 } }));

        expect(response.status).toBe(403);
        expect(mocks.getFreshAuthSettings).not.toHaveBeenCalled();
        expect(mocks.setAuthSettings).not.toHaveBeenCalled();
    });

    it("rejects accounts without an administrator duty before reading settings", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "user", role: "user", status: "active", adminPermissions: [] });

        const response = await PATCH(request({ registrationEnabled: false }));

        expect(response.status).toBe(403);
        expect(mocks.getFreshAuthSettings).not.toHaveBeenCalled();
        expect(mocks.setAuthSettings).not.toHaveBeenCalled();
    });

    it("does not return full upstream configuration to a system-only administrator", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "system-admin", role: "admin", status: "active", adminPermissions: ["system.manage"] });

        const response = await GET();
        const payload = (await response.json()) as { settings: { systemChannels: Array<{ baseUrl: string; advancedConfig?: unknown }>; agentSkills: unknown[] } };

        expect(response.status).toBe(200);
        expect(payload.settings.systemChannels[0]).toMatchObject({ baseUrl: "" });
        expect(payload.settings.systemChannels[0].advancedConfig).toBeUndefined();
        expect(payload.settings.agentSkills).toEqual([]);
    });

    it("does not return system mail configuration to an upstream-only administrator", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "upstream-admin", role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        mocks.getFreshAuthSettings.mockResolvedValue({ ...savedSettings, mail: { provider: "SMTP", host: "smtp.internal", port: 465, secure: true, username: "admin", password: "mail-secret", fromEmail: "admin@example.com", fromName: "Admin" } });

        const response = await GET();
        const payload = (await response.json()) as { settings: { mail: { host: string; password: string } } };

        expect(response.status).toBe(200);
        expect(payload.settings.mail.host).not.toBe("smtp.internal");
        expect(payload.settings.mail.password).toBe("");
    });
});

function request(body: unknown) {
    return new Request("http://localhost/api/admin/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
