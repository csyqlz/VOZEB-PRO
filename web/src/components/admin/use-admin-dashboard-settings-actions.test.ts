import { describe, expect, it, vi } from "vitest";

import type { AuthSettings, SystemModelChannel } from "@/lib/auth/store";
import { DEFAULT_SETTINGS } from "@/lib/auth/store";
import type { AdminDashboardDataActions } from "./use-admin-dashboard-data-actions";
import { useAdminDashboardSettingsActions } from "./use-admin-dashboard-settings-actions";
import type { AdminDashboardState } from "./use-admin-dashboard-state";

function channel(id: string): SystemModelChannel {
    return { id, name: id, baseUrl: `https://${id}.example.com/v1`, apiKey: "", apiFormat: "openai", models: [`vendor/${id}`], enabled: true };
}

describe("useAdminDashboardSettingsActions", () => {
    it("builds a channel deletion from the latest settings snapshot", async () => {
        const stale = structuredClone(DEFAULT_SETTINGS);
        stale.systemChannels = [channel("stale")];
        const latest = structuredClone(stale);
        latest.systemChannels = [...stale.systemChannels, channel("latest")];
        const saveSettings = vi.fn(async (input: Partial<AuthSettings> | ((current: AuthSettings) => Partial<AuthSettings>)) => {
            const patch = typeof input === "function" ? input(latest) : input;
            expect(patch.systemChannels?.map((item) => item.id)).toEqual(["latest"]);
            return true;
        });
        const state = {
            settings: stale,
            getSettings: () => latest,
            setSettings: vi.fn(),
            message: {},
        } as unknown as AdminDashboardState;

        const actions = useAdminDashboardSettingsActions({ state, data: { saveSettings } as unknown as AdminDashboardDataActions });

        await expect(actions.deleteChannel("stale")).resolves.toBe(true);
        expect(saveSettings).toHaveBeenCalledOnce();
    });
});
