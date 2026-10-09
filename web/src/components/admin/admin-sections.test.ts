import { describe, expect, it } from "vitest";

import { adminSectionHref, allowedAdminSections, canAccessAdminSection, parseAdminSection, resolveAdminSection } from "./admin-sections";

describe("admin sections", () => {
    it("parses a valid section and falls back to overview", () => {
        expect(parseAdminSection("channels")).toBe("channels");
        expect(parseAdminSection(["skills", "channels"])).toBe("skills");
        expect(parseAdminSection("missing")).toBe("overview");
    });

    it("keeps unrelated query parameters while updating the current section", () => {
        expect(adminSectionHref("channels", "https://example.com/admin?from=notice#top")).toBe("/admin?from=notice&section=channels#top");
        expect(adminSectionHref("overview", "https://example.com/admin?section=channels&from=notice#top")).toBe("/admin?from=notice#top");
    });

    it("shows only sections allowed by the administrator duties", () => {
        const auditor = { role: "admin", status: "active", adminPermissions: ["audit.read"] };

        expect(canAccessAdminSection(auditor, "backup")).toBe(false);
        expect(allowedAdminSections(auditor)).toEqual(["updates", "adminHelp"]);
        expect(resolveAdminSection(auditor, "backup")).toBe("updates");
    });

    it("exposes tenant management only to tenant operators", () => {
        const reader = { role: "admin", status: "active", adminPermissions: ["tenants.read"] };
        expect(canAccessAdminSection(reader, "tenants")).toBe(true);
        expect(allowedAdminSections(reader)).toContain("tenants");
    });
});
