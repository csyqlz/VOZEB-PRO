import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createVozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";
import { ensurePostgresSchema, postgresQuery } from "@/lib/server/database";

import { createVozebCmsLayout, getPublishedVozebCmsSiteLayout, publishVozebCmsLayout } from "./layout-store";

const postgresIt = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;

describe("VOZEBCMS site publication PostgreSQL integration", () => {
    postgresIt("keeps exactly one authoritative snapshot when the same path is published concurrently", async () => {
        await ensurePostgresSchema();
        const suffix = randomUUID().replaceAll("-", "");
        const userId = `layout-publication-${suffix}`;
        const path = "/";
        const plan = await postgresQuery<{ id: string }>("SELECT id FROM entitlement_plans ORDER BY sort_order ASC LIMIT 1");
        const previous = await postgresQuery<{ path: string; layout_id: string; revision: number; published_by: string; published_at: Date }>("SELECT path, layout_id, revision, published_by, published_at FROM vozeb_site_publications WHERE path = $1", [
            path,
        ]);
        if (!plan.rows[0]?.id) throw new Error("No entitlement plan is available for the layout publication integration test");
        try {
            await postgresQuery("INSERT INTO users (id, username, display_name, password_hash, status, plan_id) VALUES ($1, $2, '站点发布测试', 'integration-test-only', 'active', $3)", [userId, `layout_${suffix.slice(0, 16)}`, plan.rows[0].id]);
            const layouts = ["one", "two"].map((name) =>
                createVozebCmsLayoutDefinition(userId, {
                    id: `layout-${name}-${suffix}`,
                    name: `首页 ${name}`,
                    site: { path, title: `首页 ${name}` },
                    nodes: [{ id: `hero-${name}`, componentId: "site.hero", region: "main", props: { title: `首页 ${name}` } }],
                }),
            );
            await Promise.all(layouts.map(createVozebCmsLayout));
            await Promise.all(layouts.map((layout) => publishVozebCmsLayout(userId, layout.id, layout.revision, userId)));

            const publication = await postgresQuery<{ total: string; layout_id: string; revision: number }>("SELECT count(*) OVER ()::text AS total, layout_id, revision FROM vozeb_site_publications WHERE path = $1", [path]);
            expect(publication.rows).toHaveLength(1);
            expect(publication.rows[0]?.total).toBe("1");
            expect(layouts.map((layout) => layout.id)).toContain(publication.rows[0]?.layout_id);
            await expect(getPublishedVozebCmsSiteLayout(path)).resolves.toMatchObject({ id: publication.rows[0]?.layout_id, revision: publication.rows[0]?.revision });
        } finally {
            await postgresQuery("DELETE FROM users WHERE id = $1", [userId]);
            const publication = previous.rows[0];
            if (publication) {
                await postgresQuery(
                    `INSERT INTO vozeb_site_publications (path, layout_id, revision, published_by, published_at)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (path) DO UPDATE SET layout_id = EXCLUDED.layout_id, revision = EXCLUDED.revision, published_by = EXCLUDED.published_by, published_at = EXCLUDED.published_at`,
                    [publication.path, publication.layout_id, publication.revision, publication.published_by, publication.published_at],
                );
            }
        }
    });
});
