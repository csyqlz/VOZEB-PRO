import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import createNextConfig from "../next.config";

describe("Next response headers", () => {
    it("prevents private pages and APIs from being indexed", async () => {
        const config = createNextConfig("phase-production-build");
        const rules = (await config.headers?.()) || [];
        const privateRule = rules.find((rule) => rule.source.includes(":section"));

        expect(privateRule?.source).toBe("/:section(api|admin|assets|billing|canvas|community|create|drama|forgot-password|help|image|install|login|my-prompts|profile|prompts|register|service-unavailable|video|works)/:path*");
        expect(privateRule?.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" });
    });

    it("loads local environment variables for standalone production testing", async () => {
        const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };

        expect(packageJson.scripts?.["start:standalone"]).toContain("--env-file-if-exists=.env.local");
    });
});
