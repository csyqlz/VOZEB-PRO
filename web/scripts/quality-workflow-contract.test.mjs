import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(path.join(root, ".github/workflows/quality.yml"), "utf8");
const document = parseDocument(source);
const workflow = document.toJS();

describe("independent web CI checks", () => {
    it("reports all four package scripts independently even when one fails", () => {
        expect(document.errors).toEqual([]);
        const job = workflow.jobs.checks;
        expect(job).toBeDefined();
        expect(job.name).toBe("Web / ${{ matrix.check }}");
        expect(job.strategy["fail-fast"]).toBe(false);
        expect(job.strategy.matrix.check).toEqual(["typecheck", "lint", "test", "build"]);
        expect(job.needs).toBeUndefined();
        expect(job.if).toBeUndefined();
        expect(job["continue-on-error"]).toBeUndefined();
        expect(job.defaults.run["working-directory"]).toBe("web");
        const run = job.steps.find((step) => step.run === "pnpm run ${{ matrix.check }}");
        expect(run).toBeDefined();
        expect(run.if).toBeUndefined();
        expect(run["continue-on-error"]).toBeUndefined();
        const scripts = JSON.parse(readFileSync(path.join(root, "web/package.json"), "utf8")).scripts;
        for (const check of job.strategy.matrix.check) expect(scripts[check]).toBeTruthy();
    });

    it("runs PR code without deployment secrets or persisted checkout credentials", () => {
        expect(workflow.on).toHaveProperty("pull_request");
        expect(workflow.on).not.toHaveProperty("pull_request_target");
        expect(workflow.permissions).toEqual({ contents: "read" });
        const job = workflow.jobs.checks;
        expect(job).toBeDefined();
        expect(job.permissions).toBeUndefined();
        expect(job.environment).toBeUndefined();
        expect(job["runs-on"]).toBe("ubuntu-latest");
        expect(JSON.stringify(job)).not.toMatch(/secrets\.|github\.token|NEXT_SKIP_BUILD_TYPECHECK/);
        expect(job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["persist-credentials"]).toBe(false);
        for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    });

    it("uses the existing pnpm version and frozen web lockfile for every check", () => {
        const job = workflow.jobs.checks;
        expect(job).toBeDefined();
        const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).packageManager.split("@")[1];
        expect(job.steps.find((step) => step.uses?.startsWith("pnpm/action-setup@")).with.version).toBe(version);
        const node = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
        expect(node.with["node-version"]).toBe(22);
        expect(node.with["cache-dependency-path"]).toBe("web/pnpm-lock.yaml");
        expect(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile")).toBe(true);
        expect(readFileSync(path.join(root, "web/pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion:");
    });

    it("prepares the locked browser before both jobs run browser-backed unit tests", () => {
        for (const [job, command] of [
            [workflow.jobs.checks, "pnpm run ${{ matrix.check }}"],
            [workflow.jobs.web, "pnpm test"],
        ]) {
            const prepare = job.steps.findIndex((step) => step.run?.includes("pnpm exec playwright install --with-deps chromium"));
            expect(prepare).toBeGreaterThanOrEqual(0);
            expect(prepare).toBeLessThan(job.steps.findIndex((step) => step.run === command));
            expect(job.steps[prepare].run).toContain("chromium.executablePath()");
            expect(job.steps[prepare].run).toContain("/usr/bin/chromium");
        }
        expect(workflow.jobs.checks.steps.find((step) => step.run?.includes("playwright install")).if).toBe("matrix.check == 'test'");
    });

    it("retains the original required gate including security and wallet integration tests", () => {
        const web = workflow.jobs.web;
        expect(web.if).toBeUndefined();
        expect(web["continue-on-error"]).toBeUndefined();
        const commands = web.steps.map((step) => step.run).filter(Boolean);
        for (const command of ["pnpm run typecheck", "pnpm run lint", "pnpm test", "pnpm run build", "pnpm run audit:release", "pnpm run format:check", "pnpm run e2e"]) expect(commands).toContain(command);
        const postgres = web.steps.find((step) => step.name === "PostgreSQL integration tests");
        expect(postgres.run).toContain("--no-file-parallelism");
        expect(postgres.run).toContain("points-wallet-idempotency.postgres.test.ts");
        expect(postgres["continue-on-error"]).toBeUndefined();
        expect(workflow.jobs.security.steps.some((step) => step.uses?.startsWith("gitleaks/gitleaks-action@"))).toBe(true);
        expect(workflow.jobs.security.steps.some((step) => step.uses?.startsWith("github/codeql-action/analyze@"))).toBe(true);
    });
});
