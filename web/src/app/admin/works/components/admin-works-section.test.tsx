import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminWorksSection } from "./admin-works-section";

describe("admin works table layout", () => {
    it("uses compact filters, a desktop table and no removed comment governance entry", () => {
        const markup = renderToStaticMarkup(
            <App>
                <AdminWorksSection />
            </App>,
        );

        expect(markup).toContain('data-testid="admin-work-filters"');
        expect(markup.match(/>全部</g)).toHaveLength(2);
        expect(markup).toContain("admin-work-table");
        expect(markup).toContain("admin-page-panel");
        expect(markup).toContain("作品管理");
        expect(markup).toContain('aria-label="切换作品管理视图"');
        expect(markup).toContain("作品审核");
        expect(markup).toContain("举报申诉");
        expect(markup).not.toContain("评论治理");
    });
});
