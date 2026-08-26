import { afterEach, describe, expect, it, vi } from "vitest";

import { applyPublicSiteSettings, loadPublicSession, notifyPublicSettingsChanged, PUBLIC_SETTINGS_CHANGED_STORAGE_KEY, resetPublicSession, usePublicSessionStore } from "@/stores/use-public-session-store";

afterEach(() => {
    resetPublicSession();
    vi.unstubAllGlobals();
});

describe("public session refresh", () => {
    it("applies the administrator save response immediately while preserving the current session", () => {
        usePublicSessionStore.setState({
            ready: true,
            payload: { user: { id: "user-1" } as never, settings: { site: { title: "旧标题", logoUrl: "/old.svg" }, logicalModels: [] } },
        });

        applyPublicSiteSettings({ title: "新标题", logoUrl: "/new.svg" });

        expect(usePublicSessionStore.getState().payload).toMatchObject({
            user: { id: "user-1" },
            settings: { site: { title: "新标题", logoUrl: "/new.svg" }, logicalModels: [] },
        });
    });

    it("can replace a cached model catalog after an administrator saves settings", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ user: null, settings: { logicalModels: [] } }))
            .mockResolvedValueOnce(Response.json({ user: null, settings: { logicalModels: [{ id: "video-one", name: "视频一", capability: "video", enabled: true, bindings: [] }] } }));
        vi.stubGlobal("fetch", fetchMock);

        expect((await loadPublicSession()).settings?.logicalModels).toEqual([]);
        expect((await loadPublicSession()).settings?.logicalModels).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const refreshed = await loadPublicSession({ force: true });

        expect(refreshed.settings?.logicalModels?.map((model) => model.id)).toEqual(["video-one"]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(usePublicSessionStore.getState().payload).toEqual(refreshed);
    });

    it("broadcasts settings changes to other browser tabs", () => {
        const storage = new Map<string, string>();
        vi.stubGlobal("window", {
            dispatchEvent: vi.fn(),
            localStorage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) || null },
        });
        notifyPublicSettingsChanged();

        expect(storage.get(PUBLIC_SETTINGS_CHANGED_STORAGE_KEY)).toMatch(/\d+/);
    });
});
