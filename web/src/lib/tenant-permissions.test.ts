import { describe, expect, it } from "vitest";

import { canAccessTenantConsole, canManageTenantMember, isTenantManager } from "./tenant-permissions";

describe("tenant permissions", () => {
    it("allows tenant administrators to manage members without granting owner control", () => {
        expect(isTenantManager("admin")).toBe(true);
        expect(canAccessTenantConsole("admin")).toBe(true);
        expect(canManageTenantMember("admin", "member")).toBe(true);
        expect(canManageTenantMember("admin", "admin")).toBe(false);
        expect(canManageTenantMember("admin", "owner")).toBe(false);
    });

    it("keeps ordinary members outside the tenant console", () => {
        expect(isTenantManager("member")).toBe(false);
        expect(canAccessTenantConsole("member")).toBe(false);
        expect(canManageTenantMember("member", "member")).toBe(false);
    });

    it("protects the owner from every membership mutation", () => {
        expect(canManageTenantMember("owner", "owner")).toBe(false);
        expect(canManageTenantMember("owner", "admin")).toBe(true);
        expect(canManageTenantMember("owner", "member")).toBe(true);
    });
});
