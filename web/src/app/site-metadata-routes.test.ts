import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getPublicSiteSettings: vi.fn(),
    siteMetadataBase: vi.fn(() => new URL("https://example.com")),
    absoluteSiteUrl: vi.fn((value: string, base = new URL("https://example.com")) => new URL(value, base).toString()),
    browserIconHref: vi.fn((site: { iconUrl?: string; logoUrl?: string }) => site.iconUrl || site.logoUrl || "/sub2-logo.png"),
    listPublicWorkSitemapEntries: vi.fn(),
}));

vi.mock("@/lib/server/site-metadata", () => mocks);
vi.mock("@/lib/server/work-governance-service", () => ({ listPublicWorkSitemapEntries: mocks.listPublicWorkSitemapEntries }));

import manifest from "./manifest";
import robots from "./robots";
import sitemap from "./sitemap";
import nextConfig from "../../next.config";
import { GET as favicon } from "./api/site-icon/route";

describe("site metadata routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getPublicSiteSettings.mockResolvedValue({ title: "自定义站点", iconUrl: "https://cdn.example.com/favicon.ico", seoDescription: "站点摘要" });
        mocks.listPublicWorkSitemapEntries.mockResolvedValue([{ slug: "public-work", updatedAt: "2026-07-27T00:00:00.000Z" }]);
    });

    it("keeps private workspaces out of robots and points to the sitemap", () => {
        const result = robots();
        const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;

        expect(rules.disallow).toEqual(expect.arrayContaining(["/api/", "/admin", "/create", "/canvas", "/drama"]));
        expect(result.sitemap).toBe("https://example.com/sitemap.xml");
    });

    it("publishes only crawlable public pages and approved works", async () => {
        expect((await sitemap()).map((entry) => entry.url)).toEqual([
            "https://example.com/",
            "https://example.com/gallery",
            "https://example.com/announcements",
            "https://example.com/terms",
            "https://example.com/privacy",
            "https://example.com/share/public-work",
        ]);
    });

    it("routes the web manifest icon through the backend-controlled favicon", async () => {
        const result = await manifest();

        expect(result.name).toBe("自定义站点");
        expect(result.icons).toEqual([{ src: "/sub2-logo.png", sizes: "512x512", type: "image/png", purpose: "maskable" }]);
    });

    it("rewrites the reserved favicon path to the dynamic site icon route before static files", async () => {
        const rewrites = await nextConfig("phase-production-build").rewrites?.();

        expect(rewrites).toEqual({
            beforeFiles: [{ source: "/favicon.ico", destination: "/api/site-icon" }],
            afterFiles: [],
            fallback: [],
        });
    });

    it("redirects the standard favicon route to the configured browser icon", async () => {
        const response = await favicon(new Request("http://localhost:3000/api/site-icon"));

        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe("https://cdn.example.com/favicon.ico");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    });

    it("keeps a site-local icon relative to the current host", async () => {
        mocks.getPublicSiteSettings.mockResolvedValue({ title: "默认站点", iconUrl: "/sub2-logo.png", logoUrl: "/logo.svg" });

        const response = await favicon(new Request("http://localhost:3000/api/site-icon"));

        expect(response.headers.get("location")).toBe("/sub2-logo.png");
    });

    it("falls back to the infinite-evolution icon when favicon points back to itself", async () => {
        mocks.getPublicSiteSettings.mockResolvedValue({ title: "默认站点", iconUrl: "/favicon.ico", logoUrl: "/logo.svg" });

        const response = await favicon(new Request("http://localhost:3000/api/site-icon"));

        expect(response.headers.get("location")).toBe("/sub2-logo.png");
    });
});
