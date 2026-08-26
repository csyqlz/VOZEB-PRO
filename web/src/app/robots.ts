import type { MetadataRoute } from "next";

import { absoluteSiteUrl, siteMetadataBase } from "@/lib/server/site-metadata";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
    const base = siteMetadataBase();
    return {
        rules: {
            userAgent: "*",
            allow: ["/", "/gallery", "/share/", "/terms", "/privacy"],
            disallow: ["/api/", "/admin", "/assets", "/billing", "/canvas", "/create", "/drama", "/image", "/install", "/login", "/my-prompts", "/profile", "/prompts", "/register", "/video", "/works"],
        },
        sitemap: absoluteSiteUrl("/sitemap.xml", base),
    };
}
