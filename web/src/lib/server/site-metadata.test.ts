import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_SETTINGS } from "@/lib/auth/store";
import { browserIconHref } from "./site-metadata";

describe("site metadata", () => {
    it("keeps the bundled browser icon on the same origin", () => {
        expect(browserIconHref(DEFAULT_SITE_SETTINGS)).toBe("/sub2-logo.png");
    });

    it("uses a custom logo when the browser icon is still the bundled default", () => {
        expect(browserIconHref({ iconUrl: "/icon.svg", logoUrl: "/custom-logo.svg" })).toBe("/custom-logo.svg");
    });

    it("keeps an independently configured browser icon", () => {
        expect(browserIconHref({ iconUrl: "https://cdn.example.com/favicon.png", logoUrl: "/custom-logo.svg" })).toBe("https://cdn.example.com/favicon.png");
    });

    it("does not send legacy reserved favicon paths back through a redirect", () => {
        expect(browserIconHref({ iconUrl: "/favicon.ico", logoUrl: "/logo.svg" })).toBe("/logo.svg");
        expect(browserIconHref({ iconUrl: "/api/site-icon", logoUrl: "/logo.svg" })).toBe("/logo.svg");
    });
});
