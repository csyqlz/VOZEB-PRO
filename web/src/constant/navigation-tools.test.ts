import { describe, expect, it } from "vitest";

import { defaultWorkspaceHref, navigationGroupsForModules } from "./navigation-tools";

describe("module-aware workspace navigation", () => {
    it("removes disabled module entries and empty navigation groups", () => {
        const groups = navigationGroupsForModules(["canvas", "drama"]);

        expect(groups.map((group) => group.id)).not.toContain("create");
        expect(groups.flatMap((group) => group.tools.map((tool) => tool.slug))).not.toContain("create");
        expect(groups.flatMap((group) => group.tools.map((tool) => tool.slug))).toEqual(expect.arrayContaining(["canvas", "drama", "assets"]));
    });

    it("uses the first enabled production workspace instead of a disabled create route", () => {
        expect(defaultWorkspaceHref(["canvas", "drama"])).toBe("/canvas");
        expect(defaultWorkspaceHref(["drama"])).toBe("/drama");
        expect(defaultWorkspaceHref([])).toBe("/assets");
    });
});
