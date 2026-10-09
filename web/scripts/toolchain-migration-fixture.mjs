import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(path.join(webRoot, "package.json"));
const requireNextConfig = createRequire(requireWeb.resolve("eslint-config-next"));
const pluginRoot = path.dirname(requireNextConfig.resolve("@next/eslint-plugin-next/package.json"));
assert.equal(JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version, "16.3.0");
const requirePlugin = createRequire(path.join(pluginRoot, "package.json"));
const scannerSource = readFileSync(path.join(pluginRoot, "dist/utils/get-root-dirs.js"));
assert.equal(createHash("sha256").update(scannerSource).digest("hex"), "e4e0e0a8e8cff9f7a2619ed1768cec2acf3f11fb49ec45488e46a3d6965757a1");
const getRootDirs = requirePlugin("./dist/utils/get-root-dirs.js").getRootDirs;
const plugin = requirePlugin("./dist/index.js");
const { ESLint } = requireWeb("eslint");
const fixture = mkdtempSync(path.join(os.tmpdir(), "vozeb-next-scanner-"));
const tree = path.join(fixture, "tree");
function fixtureFile(relative) {
    const target = path.join(tree, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export default function Page() { return null; }\n");
}
for (const relative of [
    "pages/index.js",
    "apps/web/pages/index.js",
    "apps/web/pages/about.js",
    "apps/web/pages/blog/[slug].js",
    "apps/web/pages/products/[...id].js",
    "apps/admin/src/pages/admin.jsx",
    "apps/app/app/page.tsx",
    "apps/app/app/shop/page.tsx",
    "apps/app/app/posts/[slug]/page.tsx",
    "apps/app/app/(group)/group/page.tsx",
    "apps/app/app/@modal/(..)photo/page.tsx",
    "apps/.hidden/pages/hidden.tsx",
    "custom-pages/custom.tsx",
])
    fixtureFile(relative);
symlinkSync(path.join(tree, "apps/web"), path.join(tree, "apps/linked"), process.platform === "win32" ? "junction" : "dir");
const previousCwd = process.cwd();
process.chdir(tree);
process.on("exit", () => process.chdir(previousCwd));

// Golden results were recorded from the official locked Next plugin before migration.
const scans = [
    ["no next settings", undefined, [tree]],
    ["no rootDir", {}, [tree]],
    ["relative static directory", { rootDir: "apps/web" }, ["apps/web"]],
    ["absolute static directory", { rootDir: path.join(tree, "apps/web").replaceAll("\\", "/") }, [path.join(tree, "apps/web").replaceAll("\\", "/")]],
    ["ordered array with invalid entries and duplicates", { rootDir: ["apps/web", null, "apps/admin", "apps/web"] }, ["apps/web", "apps/admin", "apps/web"]],
    ["monorepo wildcard", { rootDir: "apps/*" }, ["apps/admin", "apps/app", "apps/linked", "apps/web"]],
    ["no matching directory", { rootDir: "missing/*" }, []],
    ["brace pattern", { rootDir: "apps/{web,admin}" }, ["apps/web", "apps/admin"]],
    ["extglob pattern", { rootDir: "apps/@(web|admin)" }, ["apps/admin", "apps/web"]],
    ["explicit dot directory", { rootDir: "apps/.hidden" }, ["apps/.hidden"]],
    ["dot wildcard", { rootDir: "apps/.*" }, ["apps/.hidden"]],
    ["symlink static directory", { rootDir: "apps/linked" }, ["apps/linked"]],
    ["symlink wildcard", { rootDir: "apps/l*" }, ["apps/linked"]],
    ["Windows separators static", { rootDir: "apps\\web" }, ["apps/web"]],
    ["Windows separators wildcard", { rootDir: "apps\\*" }, ["apps/admin", "apps/app", "apps/linked", "apps/web"]],
    ["static trailing separator", { rootDir: "apps/web/" }, ["apps/web/"]],
    ["empty array", { rootDir: [] }, []],
    ["symlink trailing separator", { rootDir: "apps/linked/" }, ["apps/linked/"]],
    ["explicit relative static", { rootDir: "./apps/web" }, ["./apps/web"]],
    ["explicit relative wildcard", { rootDir: "./apps/*" }, ["./apps/admin", "./apps/app", "./apps/linked", "./apps/web"]],
];
for (const [name, next, expected] of scans) {
    test(`installed Next directory scan: ${name}`, () => {
        assert.deepEqual(getRootDirs({ cwd: tree, settings: next === undefined ? {} : { next } }), expected);
    });
}

function diagnostic(route, endColumn) {
    return [
        {
            ruleId: "@next/next/no-html-link-for-pages",
            severity: 2,
            message: "Do not use an `<a>` element to navigate to `" + route + "`. Use `<Link />` from `next/link` instead. See: https://nextjs.org/docs/messages/no-html-link-for-pages",
            line: 1,
            column: 47,
            nodeType: "JSXOpeningElement",
            endLine: 1,
            endColumn,
        },
    ];
}
const lintCases = [
    ["Pages internal anchor rejected", '<a href="/about">About</a>', "apps/*", [], diagnostic("/about/", 64)],
    ["root index rejected", '<a href="/">Home</a>', undefined, [], diagnostic("/", 59)],
    ["Link allowed", '<Link href="/about">About</Link>', "apps/*", [], []],
    ["external HTTPS allowed", '<a href="https://example.com/about">About</a>', "apps/*", [], []],
    ["external protocol-relative allowed", '<a href="//example.com/about">About</a>', "apps/*", [], []],
    ["fragment allowed", '<a href="#about">About</a>', "apps/*", [], []],
    ["download allowed", '<a href="/about" download>About</a>', "apps/*", [], []],
    ["blank target allowed", '<a href="/about" target="_blank">About</a>', "apps/*", [], []],
    ["dynamic href allowed", "<a href={target}>About</a>", "apps/*", [], []],
    ["no href allowed", "<a>About</a>", "apps/*", [], []],
    ["src/pages internal anchor rejected", '<a href="/admin">Admin</a>', "apps/*", [], diagnostic("/admin/", 64)],
    ["App Router index anchor rejected", '<a href="/">Home</a>', "apps/app", [], diagnostic("/", 59)],
    ["nested App route retains baseline diagnostics", '<a href="/shop">Shop</a>', "apps/*", [], []],
    ["dynamic Pages anchor rejected", '<a href="/blog/article">Article</a>', "apps/*", [], diagnostic("/blog/article/", 71)],
    ["catch-all Pages anchor rejected", '<a href="/products/a/b">Product</a>', "apps/*", [], diagnostic("/products/a/b/", 71)],
    ["dynamic App anchor rejected", '<a href="/posts/article">Article</a>', "apps/*", [], diagnostic("/posts/article/", 72)],
    ["custom Pages directory rejected", '<a href="/custom">Custom</a>', "apps/*", [path.join(tree, "custom-pages")], diagnostic("/custom/", 65)],
    ["group and intercepted routes retain baseline diagnostics", '<><a href="/group">Group</a><a href="/photo">Photo</a></>', "apps/*", [], []],
    ["query and fragment normalize internal route", '<a href="/about?q=1#top">About</a>', "apps/*", [], diagnostic("/about/", 72)],
    ["duplicate root arrays retain cached diagnostics", '<a href="/about">About</a>', ["apps/web", "apps/web"], [], diagnostic("/about/", 64)],
];
for (const [name, code, rootDir, options, expected] of lintCases) {
    test(`installed Next lint rule: ${name}`, async () => {
        const eslint = new ESLint({
            cwd: tree,
            overrideConfigFile: true,
            overrideConfig: [
                {
                    files: ["**/*.jsx"],
                    languageOptions: { parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } } },
                    plugins: { "@next/next": plugin },
                    settings: { next: rootDir === undefined ? {} : { rootDir } },
                    rules: { "@next/next/no-html-link-for-pages": ["error", ...options] },
                },
            ],
        });
        const [result] = await eslint.lintText(`export default function Component() { return (${code}); }`, { filePath: path.join(tree, "case.jsx") });
        assert.deepEqual(result.messages, expected);
        assert.equal(result.errorCount, expected.length);
        assert.equal(result.warningCount, 0);
    });
}
