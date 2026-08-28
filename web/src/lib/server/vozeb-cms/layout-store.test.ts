import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    database: { version: 1, layouts: [], revisions: [], publications: [] } as { version: 1; layouts: unknown[]; revisions: unknown[]; publications: unknown[] },
}));

vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async () => mocks.database),
    writeJsonDataFile: vi.fn(async (_name: string, value: typeof mocks.database) => {
        mocks.database = value;
    }),
    withJsonDataFileLock: vi.fn(async (_name: string, operation: () => unknown) => operation()),
}));
vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: () => "file",
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));

import { createVozebCmsLayout, getPublishedVozebCmsLayout, getPublishedVozebCmsSiteLayout, publishVozebCmsLayout, rollbackVozebCmsLayout, saveVozebCmsLayoutDraft } from "./layout-store";
import { createVozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";

describe("VOZEBCMS layout store", () => {
    beforeEach(() => {
        mocks.database = { version: 1, layouts: [], revisions: [], publications: [] };
    });

    it("keeps draft revisions, publishes an immutable snapshot and rolls back into a new draft", async () => {
        const initial = createVozebCmsLayoutDefinition("user-one", { id: "layout-one", name: "创作页", nodes: [{ id: "header", componentId: "module.header", props: {} }] });
        await createVozebCmsLayout(initial);
        const draft = await saveVozebCmsLayoutDraft("user-one", "layout-one", 1, { ...initial, name: "创作页 2", revision: 1 }, "mutation-one");
        expect(draft).toMatchObject({ revision: 2, status: "draft", lastMutationId: "mutation-one" });
        const published = await publishVozebCmsLayout("user-one", "layout-one", 2, "user-one");
        expect(published).toMatchObject({ status: "published", publishedRevision: 2 });
        const nextDraft = await saveVozebCmsLayoutDraft("user-one", "layout-one", 2, { ...published, name: "创作页 3", revision: 2 }, "mutation-two");
        expect(nextDraft).toMatchObject({ revision: 3, status: "draft", publishedRevision: 2 });
        const rolledBack = await rollbackVozebCmsLayout("user-one", "layout-one", 2, 3, "user-one");
        expect(rolledBack).toMatchObject({ revision: 4, status: "draft", name: "创作页 2", publishedRevision: 2 });
        await expect(getPublishedVozebCmsLayout("user-one", "layout-one")).resolves.toMatchObject({ status: "published", name: "创作页 2", revision: 2 });
    });

    it("reads only a published site snapshot and never exposes a newer draft", async () => {
        const initial = createVozebCmsLayoutDefinition("admin-one", { id: "home-one", name: "首页", site: { path: "/", title: "首页" }, nodes: [{ id: "hero", componentId: "site.hero", region: "main", props: { title: "线上标题" } }] });
        await createVozebCmsLayout(initial);
        await expect(getPublishedVozebCmsSiteLayout("/")).resolves.toBeNull();
        const published = await publishVozebCmsLayout("admin-one", initial.id, initial.revision, "admin-one");
        await saveVozebCmsLayoutDraft("admin-one", initial.id, published.revision, { ...published, nodes: [{ ...published.nodes[0], props: { ...published.nodes[0].props, title: "未发布标题" } }] }, "new-draft");
        const publicLayout = await getPublishedVozebCmsSiteLayout("/");
        expect(publicLayout?.nodes[0].props.title).toBe("线上标题");
    });

    it("atomically switches the authoritative publication for one site path", async () => {
        const first = createVozebCmsLayoutDefinition("admin-one", { id: "home-one", name: "首页 A", site: { path: "/", title: "首页 A" }, nodes: [{ id: "hero-a", componentId: "site.hero", region: "main", props: { title: "首页 A" } }] });
        const second = createVozebCmsLayoutDefinition("admin-two", { id: "home-two", name: "首页 B", site: { path: "/", title: "首页 B" }, nodes: [{ id: "hero-b", componentId: "site.hero", region: "main", props: { title: "首页 B" } }] });
        await createVozebCmsLayout(first);
        await createVozebCmsLayout(second);

        await publishVozebCmsLayout("admin-one", first.id, first.revision, "admin-one");
        await expect(getPublishedVozebCmsSiteLayout("/")).resolves.toMatchObject({ id: first.id });
        await publishVozebCmsLayout("admin-two", second.id, second.revision, "admin-two");

        await expect(getPublishedVozebCmsSiteLayout("/")).resolves.toMatchObject({ id: second.id });
        await expect(getPublishedVozebCmsLayout("admin-one", first.id)).resolves.toMatchObject({ id: first.id, publishedRevision: first.revision });
        expect(mocks.database.publications).toEqual([expect.objectContaining({ path: "/", layoutId: second.id, revision: second.revision })]);
    });
});
