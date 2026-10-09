import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { prepareStandaloneAssets } from "./standalone-assets.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

describe("release type-check and build contract", () => {
    it("runs strict type-check once before the standalone build", () => {
        const releaseCheck = readFileSync(path.join(webRoot, "scripts/release-check.mjs"), "utf8");
        const productionBuild = readFileSync(path.join(webRoot, "scripts/production-build.mjs"), "utf8");
        const packageJson = JSON.parse(readFileSync(path.join(webRoot, "package.json"), "utf8"));
        const nextConfig = readFileSync(path.join(webRoot, "next.config.ts"), "utf8");
        const rootGitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
        const docsNextConfig = readFileSync(path.join(repoRoot, "docs/next.config.mjs"), "utf8");
        const standaloneStart = readFileSync(path.join(webRoot, "scripts/start-standalone.mjs"), "utf8");
        const developmentStart = readFileSync(path.join(webRoot, "scripts/run-app.mjs"), "utf8");
        const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

        expect(releaseCheck.indexOf('["run", "typecheck"]')).toBeLessThan(releaseCheck.indexOf('["run", "build"]'));
        expect(releaseCheck.indexOf('["test"]')).toBeLessThan(releaseCheck.indexOf('["run", "build"]'));
        expect(releaseCheck).toContain('["run", "lint"]');
        expect(releaseCheck).toContain('NEXT_SKIP_BUILD_TYPECHECK: "1"');
        expect(releaseCheck).not.toContain('NEXT_BUILD_CPUS: "1"');
        expect(releaseCheck).not.toContain('"--max-old-space-size=1024"');
        expect(releaseCheck).toContain(".next-release-");
        expect(releaseCheck).toContain('"web/.next-release-*"');
        expect(releaseCheck).not.toContain(":(glob)");
        expect(releaseCheck).not.toContain('const buildDistDir = ".next-production"');
        expect(releaseCheck).toContain("await rm(path.join(webRoot, buildDistDir)");
        expect(packageJson.scripts.build).toBe("node scripts/production-build.mjs");
        expect(productionBuild.indexOf("node_modules/typescript/bin/tsc")).toBeLessThan(productionBuild.indexOf("node_modules/next/dist/bin/next"));
        expect(productionBuild).toContain('NEXT_SKIP_BUILD_TYPECHECK: "1"');
        expect(productionBuild).toContain("restoreBuildFiles");
        expect(productionBuild).toContain('"tsconfig.json", "next-env.d.ts"');
        expect(releaseCheck).toContain("prepareStandaloneAssets");
        expect(nextConfig).toContain("typescript: { ignoreBuildErrors: skipBuildTypeCheck }");
        expect(nextConfig).toContain("outputFileTracingRoot: webDir");
        expect(nextConfig).toContain("turbopack: { root: webDir }");
        expect(rootGitignore.split(/\r?\n/)).toContain("/pnpm-lock.yaml");
        expect(docsNextConfig).toContain("outputFileTracingRoot: docsRoot");
        expect(docsNextConfig).toContain("turbopack: { root: docsRoot }");
        expect(standaloneStart).toContain('process.env.NEXT_DIST_DIR?.trim() || ".next"');
        expect(developmentStart).toContain('NEXT_DIST_DIR: runtime.environment.NEXT_DIST_DIR?.trim() || ".next-dev"');
        expect(standaloneStart).toContain("prepareStandaloneAssets");
        expect(dockerfile).toContain("pnpm run typecheck && NEXT_SKIP_BUILD_TYPECHECK=1 pnpm run build");
        expect(dockerfile).not.toContain("ARG NEXT_BUILD_CPUS=1");
        expect(dockerfile).not.toContain("ARG BUILD_NODE_OPTIONS=--max-old-space-size=1536");
    });

    it("copies static and complete public assets into a custom standalone dist directory", async () => {
        const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "vozeb-standalone-"));
        try {
            const distDir = ".next-production";
            await Promise.all([
                mkdir(path.join(fixtureRoot, distDir, "standalone"), { recursive: true }),
                mkdir(path.join(fixtureRoot, distDir, "static", "chunks"), { recursive: true }),
                mkdir(path.join(fixtureRoot, "public", "icons"), { recursive: true }),
                mkdir(path.join(fixtureRoot, "node_modules", ".pnpm", "@img+sharp-linux-x64@0.35.3", "node_modules", "@img", "sharp-linux-x64"), { recursive: true }),
                mkdir(path.join(fixtureRoot, "node_modules", ".pnpm", "@img+sharp-libvips-linux-x64@1.3.2", "node_modules", "@img", "sharp-libvips-linux-x64", "lib"), { recursive: true }),
            ]);
            await Promise.all([
                writeFile(path.join(fixtureRoot, distDir, "standalone", "server.js"), "server"),
                writeFile(path.join(fixtureRoot, distDir, "static", "chunks", "app.js"), "chunk"),
                writeFile(path.join(fixtureRoot, "public", "logo.svg"), "logo"),
                writeFile(path.join(fixtureRoot, "public", "icon.svg"), "icon"),
                writeFile(path.join(fixtureRoot, "public", "icons", "icon-192.png"), "png"),
                writeFile(path.join(fixtureRoot, "node_modules", ".pnpm", "@img+sharp-linux-x64@0.35.3", "node_modules", "@img", "sharp-linux-x64", "sharp.node"), "native"),
                writeFile(path.join(fixtureRoot, "node_modules", ".pnpm", "@img+sharp-libvips-linux-x64@1.3.2", "node_modules", "@img", "sharp-libvips-linux-x64", "lib", "libvips.so"), "libvips"),
            ]);

            if (process.platform !== "win32") {
                await symlink(
                    "../../../@img+sharp-libvips-linux-x64@1.3.2/node_modules/@img/sharp-libvips-linux-x64",
                    path.join(fixtureRoot, "node_modules", ".pnpm", "@img+sharp-linux-x64@0.35.3", "node_modules", "@img", "sharp-libvips-linux-x64"),
                    "dir",
                );
            }

            const result = await prepareStandaloneAssets({ webRoot: fixtureRoot, distDir });
            await prepareStandaloneAssets({ webRoot: fixtureRoot, distDir });

            expect(result.staticFiles).toBe(1);
            expect(result.publicFiles).toBe(3);
            expect(result.sharpRuntimePackages).toEqual(["@img+sharp-libvips-linux-x64@1.3.2", "@img+sharp-linux-x64@0.35.3"]);
            expect(existsSync(path.join(fixtureRoot, distDir, "standalone", distDir, "static", "chunks", "app.js"))).toBe(true);
            expect(existsSync(path.join(fixtureRoot, distDir, "standalone", "public", "logo.svg"))).toBe(true);
            expect(existsSync(path.join(fixtureRoot, distDir, "standalone", "public", "icons", "icon-192.png"))).toBe(true);
            expect(existsSync(path.join(fixtureRoot, distDir, "standalone", "node_modules", ".pnpm", "@img+sharp-linux-x64@0.35.3", "node_modules", "@img", "sharp-linux-x64", "sharp.node"))).toBe(true);
            expect(existsSync(path.join(fixtureRoot, distDir, "standalone", "node_modules", ".pnpm", "@img+sharp-libvips-linux-x64@1.3.2", "node_modules", "@img", "sharp-libvips-linux-x64", "lib", "libvips.so"))).toBe(true);

            const isolatedStandalone = path.join(fixtureRoot, "isolated-standalone");
            await rename(path.join(fixtureRoot, distDir, "standalone"), isolatedStandalone);
            await rm(path.join(fixtureRoot, "node_modules"), { recursive: true, force: true });
            if (process.platform !== "win32") {
                expect(await readFile(path.join(isolatedStandalone, "node_modules", ".pnpm", "@img+sharp-linux-x64@0.35.3", "node_modules", "@img", "sharp-libvips-linux-x64", "lib", "libvips.so"), "utf8")).toBe("libvips");
            }
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });
});
