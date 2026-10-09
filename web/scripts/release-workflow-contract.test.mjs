import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("release workflow contract", () => {
    it.each(["docker-image.yml", "docs-docker-image.yml"])("gates %s behind quality and signs immutable digests", (file) => {
        const source = workflow(file);
        const parsed = parseDocument(source);

        expect(parsed.errors).toEqual([]);
        const jobs = parsed.toJS().jobs;
        expect(source).not.toContain('branches: ["main"]');
        expect(source).toContain("quality:");
        expect(jobs.build.needs).toEqual(["quality", "security", "meta"]);
        expect(source).toContain("type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v')");
        expect(source).toContain("anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610");
        expect(source).toContain("cosign sign --yes");
        expect(source).toContain("cosign attest --yes");
        expect(source).toContain("awk '/^Digest:/ && digest == \"\" { digest = $2 } END { print digest }'");
        expect(source).not.toContain("awk '/^Digest:/ { print $2; exit }'");
        expect(source).toContain("version: 11.9.0");
        expect(source).not.toMatch(/uses:\s+[^\s]+@(v\d|main|master)\b/);
    });

    it("runs static, unit, and sharded Chromium quality jobs in parallel", () => {
        const source = workflow("quality.yml");
        const jobs = parseDocument(source).toJS().jobs;

        expect(parseDocument(source).errors).toEqual([]);
        for (const command of ["pnpm run lint", "pnpm run typecheck", "pnpm test", "pnpm run build", "pnpm run e2e"]) expect(source).toContain(command);
        expect(source).toContain("pnpm exec playwright install --with-deps chromium");
        expect(jobs["web-chromium"].strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2] } });
        expect(jobs.web.needs).toEqual(["web-checks", "web-unit", "web-chromium"]);
        expect(jobs["web-checks"].services).toBeUndefined();
        expect(jobs["web-unit"].services).toBeUndefined();
        expect(jobs["web-chromium"].steps.find((item) => item.name === "Browser E2E").run).toBe('pnpm run e2e --project=chromium --shard="${{ matrix.shard }}/2"');
        expect(jobs["web-chromium"].steps.find((item) => item.name === "Upload browser artifacts").with.name).toBe("web-playwright-report-chromium-${{ matrix.shard }}");
        expect(source).not.toContain("mobile-390");
        expect(source).not.toContain("mobile-430");
        expect(source).toContain("version: 11.9.0");
        expect(source).toContain("gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7");
        expect(source).toContain("github/codeql-action/analyze@47be0dbd5113ab1b79fe2dd3f68bdf7e426cdc87");
        expect(source).not.toMatch(/uses:\s+[^\s]+@(v\d|main|master)\b/);
    });

    it("does not repeat standalone Quality for release tags", () => {
        const document = parseDocument(workflow("quality.yml"));
        expect(document.errors).toEqual([]);

        const trigger = document.toJS().on;
        expect(trigger.push).toEqual({ branches: ["main"] });
        expect(trigger.pull_request).toBeNull();
        expect(trigger.workflow_dispatch).toBeNull();
    });

    it("parallelizes Docker release quality before preserving the build gate", () => {
        const document = parseDocument(workflow("docker-image.yml"));
        expect(document.errors).toEqual([]);

        const jobs = document.toJS().jobs;
        expect(jobs["quality-chromium"].strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2] } });
        expect(jobs.quality.needs).toEqual(["quality-checks", "quality-unit", "quality-chromium"]);
        expect(jobs["quality-checks"].services).toBeUndefined();
        expect(jobs["quality-unit"].services).toBeUndefined();
        expect(jobs.build.needs).toContain("quality");
        expect(jobs["quality-chromium"].steps.find((item) => item.name === "Browser E2E").run).toBe('pnpm run e2e --project=chromium --shard="${{ matrix.shard }}/2"');
        expect(jobs["quality-chromium"].steps.find((item) => item.name === "Upload browser artifacts").with.name).toBe("web-playwright-report-chromium-${{ matrix.shard }}");
        expect(document.toString()).not.toContain("mobile-390");
        expect(document.toString()).not.toContain("mobile-430");
    });

    it.each([
        ["quality.yml", "web-chromium"],
        ["docker-image.yml", "quality-chromium"],
    ])("serializes shared PostgreSQL integration tests in %s", (file, job) => {
        const document = parseDocument(workflow(file));
        expect(document.errors).toEqual([]);

        const step = document.toJS().jobs[job].steps.find((item) => item.name === "PostgreSQL integration tests");
        expect(step?.if).toBe("${{ matrix.shard == 1 }}");
        expect(step?.run).toContain("pnpm exec vitest run --no-file-parallelism");
    });

    it("includes ecommerce isolated PostgreSQL process regressions without dropping existing gates", () => {
        const step = parseDocument(workflow("quality.yml"))
            .toJS()
            .jobs["web-chromium"].steps.find((item) => item.name === "PostgreSQL integration tests");
        for (const file of [
            "database/auth-entity-concurrency.postgres.test.ts",
            "admin-backup-store.postgres.test.ts",
            "points-wallet-idempotency.postgres.test.ts",
            "database/work-community-postgres.test.ts",
            "database/create-overview-quality.postgres.test.ts",
            "ecommerce-selection-recovery.postgres.test.ts",
        ])
            expect(step.run).toContain(`src/lib/server/${file}`);
        expect(step.env.VOZEB_PRO_RUN_ECOMMERCE_POSTGRES_INTEGRATION).toBe("1");
        expect(step.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE).toBe("1");
        expect(step.run).toContain("--no-file-parallelism");
    });

    it("declares one pnpm version for the repository and both Docker builds", () => {
        const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
        const appDockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
        const docsDockerfile = readFileSync(path.join(repoRoot, "docs/Dockerfile"), "utf8");

        expect(rootPackage.packageManager).toBe("pnpm@11.9.0");
        expect(appDockerfile).toContain("ARG PNPM_VERSION=11.9.0");
        expect(docsDockerfile).toContain("pnpm@11.9.0");
    });

    it("keeps automated dependency PRs within supported major versions", () => {
        const document = parseDocument(readFileSync(path.join(repoRoot, ".github/dependabot.yml"), "utf8"));
        expect(document.errors).toEqual([]);

        const updates = document.toJS().updates;
        const web = updates.find((item) => item["package-ecosystem"] === "npm" && item.directory === "/web");
        const docs = updates.find((item) => item["package-ecosystem"] === "npm" && item.directory === "/docs");
        const actions = updates.find((item) => item["package-ecosystem"] === "github-actions");
        const docker = updates.filter((item) => item["package-ecosystem"] === "docker");

        expect(web.groups["web-runtime"]["update-types"]).toEqual(["minor", "patch"]);
        expect(web.groups["web-development"]["update-types"]).toEqual(["minor", "patch"]);
        expect(web.ignore.map((item) => item["dependency-name"])).toEqual(["*"]);
        expect(docs.groups["docs-dependencies"]["update-types"]).toEqual(["minor", "patch"]);
        expect(docs.ignore.map((item) => item["dependency-name"])).toEqual(["*"]);
        expect(actions.ignore.map((item) => item["dependency-name"])).toEqual(["*"]);
        expect([...web.ignore, ...docs.ignore, ...actions.ignore, ...docker.flatMap((item) => item.ignore)].every((item) => item["update-types"][0] === "version-update:semver-major")).toBe(true);
        expect(docker).toHaveLength(2);
        expect(docker.every((item) => item.ignore[0]["dependency-name"] === "node")).toBe(true);
    });
});

function workflow(file) {
    return readFileSync(path.join(repoRoot, ".github/workflows", file), "utf8");
}
