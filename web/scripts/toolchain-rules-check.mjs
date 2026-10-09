import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(path.join(webRoot, "package.json"));
const { ESLint } = requireWeb("eslint");

export async function checkInstalledProjectRules() {
    const config = await new ESLint({ cwd: webRoot }).calculateConfigForFile(path.join(webRoot, "src/app/layout.tsx"));
    const severities = Object.entries(config.rules)
        .map(([name, value]) => [name, value[0]])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    assert.equal(createHash("sha256").update(JSON.stringify(severities)).digest("hex"), "686f5c5a42d48b04581d42080468efb5785c5f73d571370254b64248cf5aadd2");
    assert.equal(severities.length, 113);
    assert.equal(severities.filter(([name]) => name.startsWith("@next/next/")).length, 22);
    assert.equal(config.rules["@next/next/no-html-link-for-pages"][0], 2);
}
