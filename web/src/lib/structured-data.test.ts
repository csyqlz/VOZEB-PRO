import { describe, expect, it } from "vitest";

import { buildCreativeWorkStructuredData, buildWebsiteStructuredData, serializeStructuredData } from "./structured-data";

describe("structured data", () => {
    it("builds the public website identity with its configured logo", () => {
        expect(
            buildWebsiteStructuredData({
                name: "星启智域",
                description: "视觉创作平台",
                url: "https://example.com/",
                logoUrl: "https://example.com/logo.svg",
            }),
        ).toMatchObject({
            "@type": "WebSite",
            "@id": "https://example.com/#website",
            publisher: { "@type": "Organization", logo: { url: "https://example.com/logo.svg" } },
        });
    });

    it("escapes script-closing content while preserving valid JSON", () => {
        const serialized = serializeStructuredData({ description: '</script><script>alert("x")</script>' });

        expect(serialized).not.toContain("<");
        expect(JSON.parse(serialized)).toEqual({ description: '</script><script>alert("x")</script>' });
    });

    it("only exposes the approved CreativeWork fields for public works", () => {
        const data = buildCreativeWorkStructuredData({
            visibility: "public",
            url: "https://example.com/share/public-work",
            websiteId: "https://example.com/#website",
            title: "公开作品",
            description: "作品说明",
            publishedAt: "2026-07-27T00:00:00.000Z",
            category: "电商",
            tags: ["产品"],
            authorName: "创作者",
            imageUrl: "https://example.com/api/public/works/public-work/media/cover",
        });

        expect(data).toMatchObject({ "@type": "CreativeWork", name: "公开作品", author: { name: "创作者" }, keywords: ["产品"] });
        expect(JSON.stringify(data)).not.toMatch(/userId|owner|model|metadata/);
    });

    it.each(["unlisted", "private"] as const)("does not produce CreativeWork data for %s works", (visibility) => {
        expect(
            buildCreativeWorkStructuredData({
                visibility,
                url: "https://example.com/share/private-work",
                websiteId: "https://example.com/#website",
                title: "非公开作品",
                description: "",
                publishedAt: "2026-07-27T00:00:00.000Z",
                category: "其他",
                tags: [],
            }),
        ).toBeNull();
    });
});
