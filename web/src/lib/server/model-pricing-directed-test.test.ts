import { describe, expect, it } from "vitest";
import { selectDirectedPricingBinding } from "./model-pricing-directed-test";

const configs = [
    { channelId: "first", model: "sku" },
    { channelId: "second", model: "sku" },
];
const request = (key?: string) => new Request("https://example.test/api/image-tasks", { headers: key ? { "x-vozeb-pro-pricing-test-binding": key } : {} });
const manager = { role: "admin", status: "active", adminPermissions: ["billing.manage"] } as Parameters<typeof selectDirectedPricingBinding>[1];
const ordinary = { role: "user" } as Parameters<typeof selectDirectedPricingBinding>[1];

describe("directed pricing acceptance", () => {
    it("does not alter ordinary task routing without an explicit binding", () => {
        expect(selectDirectedPricingBinding(request(), ordinary, configs)).toMatchObject({ directed: false, configs });
    });

    it("requires financial permission and an exact current binding", () => {
        expect(selectDirectedPricingBinding(request("first/sku"), ordinary, configs)).toMatchObject({ directed: true, status: 403, configs: [] });
        expect(selectDirectedPricingBinding(request("other/sku"), manager, configs)).toMatchObject({ directed: true, status: 400, configs: [] });
        expect(selectDirectedPricingBinding(request("first/sku"), manager, configs)).toMatchObject({ directed: true, key: "first/sku", configs: [configs[0]] });
    });
});
