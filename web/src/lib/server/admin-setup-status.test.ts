import { describe, expect, it } from "vitest";

import { countEnabledPaidEntitlementPlans, countEnabledPlanProducts } from "./admin-setup-status";

describe("admin setup product counts", () => {
    it("counts only enabled saleable plan products, excluding the default entitlement identity and point products", () => {
        expect(countEnabledPlanProducts([{ productKind: "plan", enabled: true } as never, { productKind: "plan", enabled: true } as never, { productKind: "plan", enabled: false } as never, { productKind: "points", enabled: true } as never])).toBe(2);
    });

    it("does not present the default daily-points identity as a paid entitlement", () => {
        expect(
            countEnabledPaidEntitlementPlans(
                [
                    { id: "free", enabled: true },
                    { id: "creator", enabled: true },
                    { id: "pro", enabled: true },
                ] as never,
                "free",
            ),
        ).toBe(2);
    });
});
