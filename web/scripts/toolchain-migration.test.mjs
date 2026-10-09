import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { checkInstalledProjectRules } from "./toolchain-rules-check.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const source = (relative) => readFileSync(path.join(webRoot, relative), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const copiedStyles = "src/app/styles/shadcn-tailwind.css";
const exactPlugin = "@next/eslint-plugin-next@16.3.0";

describe("reproducible toolchain migration", () => {
    it("retains the complete locked shadcn stylesheet after canonical formatting", async () => {
        expect(existsSync(path.join(webRoot, copiedStyles))).toBe(true);
        const original = source(copiedStyles);
        const css = await format(original, { ...JSON.parse(source(".prettierrc.json")), parser: "css" });
        expect(sha256(css)).toBe("2f0ff0271530ef9b7cf7807ab073d8e923035e85340f6e3fda63c27132736d6a");
        const ast = semanticAst(postcss.parse(css));
        expect(sha256(JSON.stringify(ast))).toBe("52e3ed07b58c5a0028f562bfe7024042453b0427a86ad3c17771c3124fa31e5a");
    });

    it("retains the complete MIT copyright and permission notice", () => {
        const license = "src/app/styles/shadcn-tailwind.LICENSE.md";
        expect(existsSync(path.join(webRoot, license))).toBe(true);
        expect(sha256(source(license))).toBe("1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f");
    });

    it("imports copied styles before the original foundation and removes only the CSS CLI dependency", () => {
        const imports = postcss
            .parse(source("src/app/globals.css"))
            .nodes.filter((node) => node.type === "atrule" && node.name === "import")
            .map((node) => node.params);
        expect(imports.slice(0, 4)).toEqual(['"tailwindcss"', '"tw-animate-css"', '"./styles/shadcn-tailwind.css"', '"./styles/global-foundation.css"']);
        expect(JSON.parse(source("package.json")).devDependencies.shadcn).toBeUndefined();
    });

    it("binds the scanner patch and dependency change to the exact installed Next plugin", () => {
        const workspace = parse(source("pnpm-workspace.yaml"));
        expect(workspace.patchedDependencies?.[exactPlugin]).toBe("patches/@next__eslint-plugin-next@16.3.0.patch");
        expect(workspace.overrides[`${exactPlugin}>fast-glob`]).toBe("-");
        expect(workspace.packageExtensions?.[exactPlugin]?.dependencies).toEqual({ glob: "13.0.6", minimatch: "10.2.6" });
        expect(workspace.allowUnusedPatches).not.toBe(true);
    });

    it("makes the package patch available before the Docker frozen install", () => {
        const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
        const buildStage = dockerfile.slice(dockerfile.indexOf("FROM node:22-bookworm-slim AS web-build"), dockerfile.indexOf("FROM node:22-bookworm-slim\n"));
        const patchCopy = buildStage.indexOf("COPY web/patches ./patches");
        const install = buildStage.indexOf("pnpm install --frozen-lockfile");
        expect(patchCopy).toBeGreaterThanOrEqual(0);
        expect(install).toBeGreaterThan(patchCopy);
    });

    it("runs actual installed directory scanning and lint diagnostics", () => {
        expectFixture("toolchain-migration-fixture.mjs", 40);
    });

    it("retains the complete installed project rule names and severities", async () => {
        await checkInstalledProjectRules();
    });
});

function expectFixture(file, count) {
    const child = spawnSync(process.execPath, ["--test", "--test-concurrency=1", path.join(webRoot, "scripts", file)], { cwd: webRoot, encoding: "utf8" });
    const output = (child.stdout || "") + (child.stderr || "");
    process.stdout.write(output);
    expect(child.error, output).toBeUndefined();
    expect(child.signal, output).toBeNull();
    expect(child.status, output).toBe(0);
    expect(output).toMatch(new RegExp(`^# tests ${count}$`, "m"));
    expect(output).toMatch(new RegExp(`^# pass ${count}$`, "m"));
    expect(output).toMatch(/^# fail 0$/m);
    expect(output).toMatch(/^# cancelled 0$/m);
    expect(output).toMatch(/^# skipped 0$/m);
    expect(output).toMatch(/^# todo 0$/m);
}

function semanticAst(node) {
    return Object.fromEntries(
        Object.entries(node.toJSON())
            .filter(([key]) => !["raws", "source", "inputs"].includes(key))
            .map(([key, value]) => [key, key === "nodes" ? node.nodes.map(semanticAst) : value]),
    );
}
