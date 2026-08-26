import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateNginxContract } from "./nginx-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Nginx production proxy contract", () => {
    it("keeps HTTP/2, gzip, immutable static caching and unbuffered Agent SSE enabled", () => {
        expect(validateNginxContract({ repoRoot })).toBe(path.join(repoRoot, "deploy", "nginx", "vozeb-pro.conf.example"));
    });
});
