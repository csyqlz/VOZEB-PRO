import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { Linter } from "eslint";
import { afterAll, describe, expect, it } from "vitest";

const configRequire = createRequire(import.meta.resolve("eslint-config-next"));
const pluginRequire = createRequire(configRequire.resolve("@next/eslint-plugin-next/package.json"));
const { getRootDirs } = pluginRequire("./dist/utils/get-root-dirs.js");
const plugin = configRequire("@next/eslint-plugin-next");
const root = mkdtempSync(path.join(tmpdir(), "vozeb-next-eslint-"));
const apps = path.join(root, "apps").replace(/\\/g, "/");
const webA = `${apps}/web-a`;
const webB = `${apps}/web-b`;
const relativeApps = path.relative(process.cwd(), apps).replace(/\\/g, "/");

for (const file of [`${webA}/src/pages/about.tsx`, `${webA}/nested/app/ignored/page.tsx`, `${webB}/pages/contact.tsx`, `${apps}/file.txt`]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export default function Page() { return null; }\n");
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Next ESLint root directory scanning", () => {
    it.each([
        ["default cwd", undefined, [webA]],
        ["literal directory without descendants", webA, [webA]],
        ["Windows separators", webA.replace(/\//g, "\\"), [webA]],
        ["relative directory", `${relativeApps}/web-a`, [`${relativeApps}/web-a`]],
        ["relative wildcard", `${relativeApps}/*`, [`${relativeApps}/web-a`, `${relativeApps}/web-b`]],
        ["directory wildcard excludes files", `${apps}/*`, [webA, webB]],
        ["brace alternatives without descendants", `${apps}/{web-a,web-b}`, [webA, webB]],
        ["globstar", `${apps}/**/nested`, [`${webA}/nested`]],
        ["array of directories", [webA, webB], [webA, webB]],
        ["missing directory", `${apps}/missing`, []],
        ["file is not a root directory", `${apps}/file.txt`, []],
    ])("resolves %s", (_name, rootDir, expected) => {
        const directories = getRootDirs({ cwd: webA, settings: { next: { rootDir } } });
        // Both scanners' paths feed path.join in Next; a trailing slash is immaterial.
        expect(directories.map((directory) => directory.replace(/\\/g, "/").replace(/\/$/, "")).sort()).toEqual(expected);
    });

    it.each([`${apps}/*`, `${apps}/{web-a,web-b}`, [webA, webB]].map((rootDir) => [rootDir]))("keeps internal-link linting active with rootDir %j", (rootDir) => {
        const linter = new Linter({ cwd: root });
        const config = {
            files: ["**/*.jsx"],
            languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
            plugins: { "@next/next": plugin },
            settings: { next: { rootDir } },
            rules: { "@next/next/no-html-link-for-pages": "error" },
        };
        const messages = linter.verify('const links = <><a href="/about">About</a><a href="/contact">Contact</a><a href="https://example.com">External</a></>;', [config], { filename: path.join(root, "links.jsx") });

        expect(messages).toEqual([
            expect.objectContaining({ ruleId: "@next/next/no-html-link-for-pages", message: expect.stringContaining("`/about/`") }),
            expect.objectContaining({ ruleId: "@next/next/no-html-link-for-pages", message: expect.stringContaining("`/contact/`") }),
        ]);
    });
});
