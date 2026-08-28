import { describe, expect, it } from "vitest";

import { ADMIN_HELP_ARTICLE_IDS, adminHelpArticles, findAdminHelpArticle, searchAdminHelpArticles } from "./admin-help-content";
import { adminHelpGuidance } from "./admin-help-guidance";

describe("admin help center content", () => {
    it("keeps a complete and unique administrator article set", () => {
        expect(adminHelpArticles.map((article) => article.id)).toEqual([...ADMIN_HELP_ARTICLE_IDS]);
        expect(new Set(adminHelpArticles.map((article) => article.id)).size).toBe(adminHelpArticles.length);

        for (const article of adminHelpArticles) {
            const guidance = adminHelpGuidance[article.id];
            expect(article.steps.length).toBeGreaterThanOrEqual(3);
            expect(guidance.stepActions).toHaveLength(article.steps.length);
            expect(guidance.stepActions.every((actions) => actions.length >= 2)).toBe(true);
            expect(guidance.troubleshooting.length).toBeGreaterThanOrEqual(3);
            expect(article.checks.length).toBeGreaterThanOrEqual(3);
            expect(article.links.length).toBeGreaterThanOrEqual(2);
            for (const link of article.links) {
                if (link.href) expect(link.href).toMatch(/^\/admin(?:\/|\?|$)/);
                if (link.section) expect(link.section).not.toBe("adminHelp");
            }
        }
    });

    it("finds administrator-only instructions without using user help content", () => {
        expect(findAdminHelpArticle("commerce")?.title).toContain("优惠券");
        expect(searchAdminHelpArticles("API Key").map((article) => article.id)).toContain("models");
        expect(searchAdminHelpArticles("删除线").map((article) => article.id)).toContain("commerce");
        expect(searchAdminHelpArticles("邀请 冷静期").map((article) => article.id)).toContain("commerce");
        expect(searchAdminHelpArticles("媒体 引用").map((article) => article.id)).toContain("storage");
        expect(searchAdminHelpArticles("页面没有变化").map((article) => article.id)).toContain("maintenance");
        expect(searchAdminHelpArticles("旧品牌图标").map((article) => article.id)).toContain("system");
        expect(searchAdminHelpArticles("不存在的后台配置")).toEqual([]);
        expect(searchAdminHelpArticles("")).toHaveLength(adminHelpArticles.length);
    });
});
