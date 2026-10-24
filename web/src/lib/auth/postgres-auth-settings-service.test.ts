import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./store-foundation";

const mocks = vi.hoisted(() => ({
    lock: vi.fn(),
    updateSettings: vi.fn(),
    upsertEntitlementPlan: vi.fn(),
    removeEntitlementPlansNotIn: vi.fn(),
    upsertSystemModelChannel: vi.fn(),
    deleteSystemModelChannelsNotIn: vi.fn(),
    readSettings: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    createPostgresRepositories: vi.fn(() => ({ settings: mocks })),
    ensurePostgresSchema: vi.fn(),
    withPostgresTransaction: vi.fn(async (handler: (client: unknown) => Promise<unknown>) => handler({})),
}));

vi.mock("./store-repository", () => ({ readPostgresAuthSettings: mocks.readSettings }));

import { updatePostgresAuthSettings, updatePostgresAuthSettingsWith } from "./postgres-auth-settings-service";

describe("updatePostgresAuthSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readSettings.mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
        mocks.removeEntitlementPlansNotIn.mockResolvedValue([]);
    });

    it("updates site settings without rewriting plans or channels", async () => {
        const site = {
            ...DEFAULT_SETTINGS.site,
            title: "新站点",
            socials: {
                ...DEFAULT_SETTINGS.site.socials,
                telegram: { enabled: true, label: "Telegram", url: "https://t.me/vozeb_group" },
                x: { enabled: true, label: "X", url: "https://x.com/vozeb_pro" },
                instagram: { enabled: true, label: "Instagram", url: "https://instagram.com/vozeb.pro" },
            },
        };

        const settings = await updatePostgresAuthSettings({ site });

        expect(mocks.updateSettings).toHaveBeenCalledWith({ site: expect.objectContaining({ title: "新站点", socials: site.socials }) });
        expect(settings.site.socials).toEqual(site.socials);
        expect(mocks.upsertEntitlementPlan).not.toHaveBeenCalled();
        expect(mocks.removeEntitlementPlansNotIn).not.toHaveBeenCalled();
        expect(mocks.upsertSystemModelChannel).not.toHaveBeenCalled();
        expect(mocks.deleteSystemModelChannelsNotIn).not.toHaveBeenCalled();
    });

    it("rewrites only entitlement rows when entitlements change", async () => {
        const entitlements = structuredClone(DEFAULT_SETTINGS.entitlements);

        await updatePostgresAuthSettings({ entitlements });

        expect(mocks.updateSettings).toHaveBeenCalledWith({ entitlementsEnabled: entitlements.enabled, defaultPlanId: entitlements.defaultPlanId });
        expect(mocks.upsertEntitlementPlan).toHaveBeenCalledTimes(entitlements.plans.length);
        expect(mocks.removeEntitlementPlansNotIn).toHaveBeenCalledWith(entitlements.plans.map((plan) => plan.id));
        expect(mocks.upsertSystemModelChannel).not.toHaveBeenCalled();
        expect(mocks.deleteSystemModelChannelsNotIn).not.toHaveBeenCalled();
    });

    it("rewrites only channel rows when channels change", async () => {
        const systemChannels = [
            {
                id: "channel-one",
                name: "主渠道",
                baseUrl: "https://api.example.com/v1",
                apiKey: "",
                apiFormat: "openai" as const,
                models: ["writer"],
                enabled: true,
            },
        ];

        await updatePostgresAuthSettings({ systemChannels });

        expect(mocks.updateSettings).not.toHaveBeenCalled();
        expect(mocks.upsertSystemModelChannel).toHaveBeenCalledTimes(1);
        expect(mocks.deleteSystemModelChannelsNotIn).toHaveBeenCalledWith(["channel-one"]);
        expect(mocks.upsertEntitlementPlan).not.toHaveBeenCalled();
        expect(mocks.removeEntitlementPlansNotIn).not.toHaveBeenCalled();
    });

    it("deletes every persisted channel when the submitted channel snapshot is empty", async () => {
        const settings = await updatePostgresAuthSettings({ systemChannels: [] });

        expect(settings.systemChannels).toEqual([]);
        expect(mocks.upsertSystemModelChannel).not.toHaveBeenCalled();
        expect(mocks.deleteSystemModelChannelsNotIn).toHaveBeenCalledWith([]);
    });

    it("locks and reads the latest settings before a scoped logical-model update", async () => {
        const latest = structuredClone(DEFAULT_SETTINGS);
        latest.systemChannels = [{ id: "one", name: "One", baseUrl: "https://api.example.com/v1", apiKey: "", apiFormat: "openai", models: ["writer"], enabled: true }];
        latest.logicalModels = [{ id: "writer", name: "另一个管理员的新昵称", capability: "text", enabled: true, bindings: [{ id: "binding", channelId: "one", upstreamModel: "writer", enabled: true, priority: 3 }] }];
        const events: string[] = [];
        mocks.lock.mockImplementation(async () => {
            events.push("lock");
        });
        mocks.readSettings.mockImplementation(async () => {
            events.push("read");
            return latest;
        });

        await updatePostgresAuthSettingsWith((current) => {
            events.push("patch");
            return { logicalModels: current.logicalModels.map((model) => ({ ...model, bindings: model.bindings.map((binding) => ({ ...binding, priority: 1 })) })) };
        });

        expect(events).toEqual(["lock", "read", "patch"]);
        expect(mocks.updateSettings).toHaveBeenCalledWith({ logicalModels: [expect.objectContaining({ name: "另一个管理员的新昵称", bindings: [expect.objectContaining({ priority: 1 })] })] });
    });
});
