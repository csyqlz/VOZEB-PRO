import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_SETTINGS } from "@/lib/auth/store";

describe("default infinite-evolution brand assets", () => {
    it("uses the built-in infinite-evolution logo for every default brand entry", () => {
        expect(DEFAULT_SITE_SETTINGS.logoUrl).toBe("/logo.svg");
        expect(DEFAULT_SITE_SETTINGS.iconUrl).toBe("/sub2-logo.png");
    });

    it("keeps web logo, browser icon and docs logo identical without triangle primitives", async () => {
        const [logo, icon, docsLogo] = await Promise.all([readFile(resolve(process.cwd(), "public/logo.svg"), "utf8"), readFile(resolve(process.cwd(), "public/icon.svg"), "utf8"), readFile(resolve(process.cwd(), "../docs/public/logo.svg"), "utf8")]);

        expect(markupShape(icon)).toBe(markupShape(logo));
        expect(markupShape(docsLogo)).toBe(markupShape(logo));
        expect(logo).not.toMatch(/<(?:polygon|polyline)\b|triangle/i);
    });
});

function markupShape(svg: string) {
    return svg.match(/<path\b[^>]*\bd="([^"]+)"/)?.[1];
}
