import type { MetadataRoute } from "next";

import { absoluteSiteUrl, siteMetadataBase } from "@/lib/server/site-metadata";
import { listPublicWorkSitemapEntries } from "@/lib/server/work-governance-service";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const base = siteMetadataBase();
    const staticEntries: MetadataRoute.Sitemap = ["/", "/gallery", "/announcements", "/terms", "/privacy"].map((path) => ({
        url: absoluteSiteUrl(path, base),
        changeFrequency: path === "/" || path === "/gallery" ? "daily" : path === "/announcements" ? "weekly" : "yearly",
        priority: path === "/" ? 1 : path === "/gallery" ? 0.8 : path === "/announcements" ? 0.6 : 0.3,
    }));
    try {
        const works = await listPublicWorkSitemapEntries();
        return [...staticEntries, ...works.map((work) => ({ url: absoluteSiteUrl(`/share/${encodeURIComponent(work.slug)}`, base), lastModified: work.updatedAt, changeFrequency: "weekly" as const, priority: 0.6 }))];
    } catch {
        return staticEntries;
    }
}
