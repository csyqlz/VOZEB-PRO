import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/site-metadata", () => ({
    getPublicSiteSettings: vi.fn().mockResolvedValue({
        title: "星启智域",
        logoUrl: "/logo.svg",
        socials: { email: { enabled: false, label: "客服邮箱", url: "" } },
    }),
}));

import ServiceUnavailablePage from "./page";

describe("service unavailable page", () => {
    it("keeps the outage message consumer-facing and provides support", async () => {
        const markup = renderToStaticMarkup(await ServiceUnavailablePage());

        expect(markup).toContain("服务暂时不可用");
        expect(markup).toContain("重新加载");
        expect(markup).toContain("mailto:service@xingqizhiyu.cn");
        expect(markup).not.toContain("DATABASE_URL");
        expect(markup).not.toContain("PostgreSQL");
    });
});
