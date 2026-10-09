import { describe, expect, it } from "vitest";

import { ADMIN_PERMISSION_PRESETS, ALL_ADMIN_PERMISSIONS, adminPermissionSummary, allowedAdminBillingTabs, hasAdminPermission, hasAnyAdminPermission, isFullAdminPermissions, normalizeAdminPermissions, resolveAdminBillingTab } from "./admin-permissions";

describe("administrator permissions", () => {
    it("normalizes known permissions in registry order", () => {
        expect(normalizeAdminPermissions(["billing.manage", "unknown", "users.read", "billing.manage"])).toEqual(["users.read", "billing.manage"]);
    });

    it("requires an active administrator with an explicit permission", () => {
        expect(hasAdminPermission({ role: "admin", status: "active", adminPermissions: ["users.read"] }, "users.read")).toBe(true);
        expect(hasAdminPermission({ role: "admin", status: "active" }, "users.read")).toBe(false);
        expect(hasAdminPermission({ role: "admin", status: "disabled", adminPermissions: ["users.read"] }, "users.read")).toBe(false);
        expect(hasAdminPermission({ role: "user", status: "active", adminPermissions: ["users.read"] }, "users.read")).toBe(false);
    });

    it("keeps presets inside the declared permission registry", () => {
        for (const preset of ADMIN_PERMISSION_PRESETS) expect(normalizeAdminPermissions(preset.permissions)).toEqual(preset.permissions);
        expect(isFullAdminPermissions(ADMIN_PERMISSION_PRESETS[0].permissions)).toBe(true);
        expect(hasAnyAdminPermission({ role: "admin", status: "active", adminPermissions: ["audit.read"] })).toBe(true);
        expect(ALL_ADMIN_PERMISSIONS.length).toBeGreaterThan(0);
    });

    it("keeps tenant operations behind dedicated platform permissions", () => {
        expect(normalizeAdminPermissions(["tenants.read", "tenants.manage"])).toEqual(["tenants.read", "tenants.manage"]);
        expect(hasAdminPermission({ role: "admin", status: "active", adminPermissions: ["tenants.read"] }, "tenants.read")).toBe(true);
        expect(hasAdminPermission({ role: "user", status: "active", adminPermissions: ["tenants.manage"] }, "tenants.manage")).toBe(false);
    });

    it("limits financial workspace tabs to the current duties", () => {
        const finance = { role: "admin", status: "active", adminPermissions: ["billing.read"] };
        const commerce = { role: "admin", status: "active", adminPermissions: ["commerce.manage"] };

        expect(allowedAdminBillingTabs(finance)).toEqual(["orders"]);
        expect(resolveAdminBillingTab(finance, "payments")).toBe("orders");
        expect(allowedAdminBillingTabs(commerce)).toEqual(["products", "promotions", "coupons"]);
        expect(resolveAdminBillingTab(commerce, "orders")).toBe("products");
    });

    it("uses a preset label or a precise custom responsibility count", () => {
        expect(adminPermissionSummary(["users.read", "billing.read", "billing.manage"])).toBe("财务");
        expect(adminPermissionSummary(["users.read", "audit.read"])).toBe("2 项职责");
    });
});
