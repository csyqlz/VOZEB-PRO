import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPublished: vi.fn(), listModules: vi.fn() }));

vi.mock("./layout-store", () => ({ getPublishedVozebCmsSiteLayout: mocks.getPublished }));
vi.mock("./module-service", () => ({ listVozebCmsModules: mocks.listModules }));

import { getPublicVozebCmsSiteLayout } from "./public-site-layout-service";
import { createVozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";

describe("public site layout service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listModules.mockResolvedValue([
            { id: "create", name: "Agent", enabled: true, dependencies: [], routes: [], capabilities: [], permissions: [], version: "0.0.8" },
            { id: "canvas", name: "Canvas", enabled: false, dependencies: [], routes: [], capabilities: [], permissions: [], version: "0.0.8" },
        ]);
    });

    it("returns only the immutable public shape and filters disabled module blocks", async () => {
        const layout = createVozebCmsLayoutDefinition("admin-one", {
            id: "home-one",
            site: { path: "/", title: "首页" },
            nodes: [
                { id: "hero", componentId: "site.hero", region: "main", props: {} },
                { id: "agent", componentId: "agent.entry", region: "main", props: {} },
                { id: "canvas", componentId: "canvas.workspace", region: "main", props: {} },
            ],
        });
        mocks.getPublished.mockResolvedValue({ ...layout, status: "published", publishedRevision: 2, publishedAt: 100 });

        const result = await getPublicVozebCmsSiteLayout("/");
        expect(result?.nodes.map((node) => node.id)).toEqual(["hero", "agent"]);
        expect(result).not.toHaveProperty("userId");
        expect(result).not.toHaveProperty("permissions");
        expect(result?.enabledModules).toEqual(["create"]);
    });

    it("does not expose drafts or layouts for another path", async () => {
        mocks.getPublished.mockResolvedValue(null);
        await expect(getPublicVozebCmsSiteLayout("/")).resolves.toBeNull();
    });
});
