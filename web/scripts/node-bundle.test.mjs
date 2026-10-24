import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFreshEnvironment, decryptEnvironment, encryptEnvironment, parseOptions, sourceEntryIncluded, validateDomain } from "../../scripts/node-bundle.mjs";

const execute = promisify(execFile);
const tool = path.resolve(import.meta.dirname, "../../scripts/node-bundle.mjs");
const fixtureRoots = [];

afterAll(async () => {
    await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("node bundle", () => {
    it("validates CLI, public domain, source filtering and encrypted environment", () => {
        expect(parseOptions(["backup", "--mode", "template", "--output=/tmp/backup"])).toMatchObject({ action: "backup", mode: "template" });
        expect(() => parseOptions(["backup", "--unknown", "x"])).toThrow("不支持的参数");
        expect(() => validateDomain("http://example.com")).toThrow();
        expect(() => validateDomain("https://example.com/")).toThrow();
        expect(validateDomain("https://example.com")).toBe("https://example.com");
        expect(sourceEntryIncluded("web/.env.local", false)).toBe(false);
        expect(sourceEntryIncluded("web/node_modules/dependency.js", false)).toBe(false);
        expect(sourceEntryIncluded("web/src/page.tsx", false)).toBe(true);
        const secret = "VOZEB_PRO_ENCRYPTION_KEY=secret\n";
        const encrypted = encryptEnvironment(secret, "this is a long passphrase");
        expect(encrypted.includes(Buffer.from("secret"))).toBe(false);
        expect(decryptEnvironment(encrypted, "this is a long passphrase")).toBe(secret);
        expect(() => decryptEnvironment(encrypted, "incorrect passphrase")).toThrow();
        const fresh = createFreshEnvironment(exampleEnvironment(), "https://new.example.com");
        expect(fresh).toContain("NEXT_PUBLIC_SITE_URL=https://new.example.com");
        expect(fresh).toMatch(/VOZEB_PRO_ENCRYPTION_KEY=[a-f0-9]{64}/);
        expect(fresh).not.toContain("old-secret");
    });

    it("creates a template bundle, verifies it and restores an isolated fresh node", async () => {
        const fixture = await setup();
        const bundle = path.join(fixture.root, "bundle");
        const target = path.join(fixture.root, "target");
        await invoke(["backup", "--mode", "template", "--source", fixture.source, "--output", bundle], fixture);
        const manifest = JSON.parse(await readFile(path.join(bundle, "node-bundle.json"), "utf8"));
        expect(manifest.mode).toBe("template");
        expect(await readdir(bundle)).not.toContain("deployment.env.enc");
        const archive = await execute("tar", ["-tzf", path.join(bundle, "source.tar.gz")]);
        expect(archive.stdout).toContain("web/src/page.tsx");
        expect(archive.stdout).not.toContain("web/.env.local");
        expect(archive.stdout.split("\n")).not.toContain(".env");
        await invoke(["verify", "--input", bundle], fixture);
        await invoke(["restore", "--input", bundle, "--target", target, "--domain", "https://new.example.com"], fixture);
        await expect(readFile(path.join(target, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
        await invoke(["restore", "--input", bundle, "--target", target, "--domain", "https://new.example.com", "--apply", "--confirm", manifest.id], fixture);
        const environment = await readFile(path.join(target, ".env"), "utf8");
        expect(environment).toContain("NEXT_PUBLIC_SITE_URL=https://new.example.com");
        expect(environment).toContain("VOZEB_PRO_APP_BIND=127.0.0.1");
        expect(environment).toContain("COMPOSE_PROJECT_NAME=vozeb-");
        expect(environment).not.toContain("old-secret");
        expect(await readdir(target)).toContain("Dockerfile");
        const calls = await readFile(fixture.calls, "utf8");
        expect(calls).toContain("--project-directory");
        expect(calls).toContain("compose -p vozeb-");
        expect(calls).toContain("build app");
        expect(calls).not.toContain("generation-worker");
        await writeFile(path.join(bundle, "source.tar.gz"), "corrupted");
        await expect(invoke(["verify", "--input", bundle], fixture)).rejects.toThrow();
    });

    it("rejects a full clone that omits populated media and resumes the original services", async () => {
        const fixture = await setup();
        const deployment = path.join(fixture.root, "deployment");
        await mkdir(deployment);
        await writeFile(path.join(deployment, "docker-compose.local.yml"), "services: {}\n");
        await writeFile(path.join(deployment, ".env"), `${exampleEnvironment()}\nNEXT_PUBLIC_SITE_URL=https://old.example.com\n`, { mode: 0o600 });
        const passphrase = path.join(fixture.root, "passphrase");
        await writeFile(passphrase, randomBytes(32).toString("hex"), { mode: 0o600 });
        const bundle = path.join(fixture.root, "bundle");
        await expect(invoke(["backup", "--mode", "full", "--source", fixture.source, "--deployment", deployment, "--output", bundle, "--passphrase-file", passphrase, "--local-media", "omit"], { ...fixture, mediaPresent: true })).rejects.toThrow();
        expect(await readdir(bundle)).toContain(".incomplete");
        const calls = await readFile(fixture.calls, "utf8");
        expect(calls).toContain("stop generation-worker");
        expect(calls).toContain("stop app");
        expect(calls).toContain("start app");
        expect(calls).toContain("start generation-worker");
    });

    describe("full encrypted bundle", () => {
        let fixture;
        let bundle;
        let passphrase;

        beforeAll(async () => {
            fixture = await setup();
            const deployment = path.join(fixture.root, "deployment");
            bundle = path.join(fixture.root, "bundle");
            passphrase = path.join(fixture.root, "passphrase");
            await mkdir(deployment);
            await writeFile(path.join(deployment, "docker-compose.local.yml"), "services: {}\n");
            await writeFile(path.join(deployment, ".env"), `${exampleEnvironment()}VOZEB_PRO_BUILD_CONTEXT=/old/source\n`, { mode: 0o600 });
            await writeFile(passphrase, randomBytes(32).toString("hex"), { mode: 0o600 });
            await invoke(["backup", "--mode", "full", "--source", fixture.source, "--deployment", deployment, "--output", bundle, "--passphrase-file", passphrase], fixture);
        });

        it("rejects an incorrect passphrase without writing the target environment", async () => {
            const target = path.join(fixture.root, "wrong-passphrase-target");
            const wrongPassphrase = path.join(fixture.root, "wrong-passphrase");
            await writeFile(wrongPassphrase, randomBytes(32).toString("hex"), { mode: 0o600 });
            await expect(invoke(["restore", "--input", bundle, "--target", target, "--domain", "https://new.example.com", "--passphrase-file", wrongPassphrase], fixture)).rejects.toThrow();
            await expect(readFile(path.join(target, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("rejects an incorrect confirmation", async () => {
            const target = path.join(fixture.root, "wrong-confirmation-target");
            await expect(invoke(["restore", "--input", bundle, "--target", target, "--domain", "https://new.example.com", "--passphrase-file", passphrase, "--apply", "--confirm", "wrong"], fixture)).rejects.toThrow();
        });

        it("backs up and restores a full node with encrypted secrets and a changed domain", async () => {
            const target = path.join(fixture.root, "target");
            // beforeAll creates the real encrypted fixture once; this verifies and restores that same bundle.
            const manifest = JSON.parse(await readFile(path.join(bundle, "node-bundle.json"), "utf8"));
            expect(manifest.mode).toBe("full");
            expect(manifest.domain).toBe("https://old.example.com");
            expect((await readFile(path.join(bundle, "deployment.env.enc"))).includes(Buffer.from("old-secret"))).toBe(false);
            await invoke(["verify", "--input", bundle], fixture);
            await invoke(["restore", "--input", bundle, "--target", target, "--domain", "https://new.example.com", "--passphrase-file", passphrase, "--apply", "--confirm", manifest.id], fixture);
            const environment = await readFile(path.join(target, ".env"), "utf8");
            expect(environment).toContain("NEXT_PUBLIC_SITE_URL=https://new.example.com");
            expect(environment).toContain("VOZEB_PRO_ENCRYPTION_KEY=old-secret");
            expect(environment).toContain("VOZEB_PRO_APP_BIND=127.0.0.1");
            expect(environment).toContain("VOZEB_PRO_BUILD_CONTEXT=.");
            expect(environment).not.toContain("/old/source");
            const calls = await readFile(fixture.calls, "utf8");
            expect(calls).toContain("disaster-backup.mjs");
            expect(calls).toContain("disaster-restore.mjs");
            expect(calls).toContain("build app");
            expect(calls).toContain("start app");
            expect(calls).toContain("start generation-worker");
            expect(calls).not.toContain("up -d --wait --no-build generation-worker");
        });
    });

    it("rejects omitting object files when historical records still reference them", async () => {
        const fixture = await setup();
        const deployment = path.join(fixture.root, "deployment");
        const passphrase = path.join(fixture.root, "passphrase");
        await mkdir(deployment);
        await writeFile(path.join(deployment, "docker-compose.local.yml"), "services: {}\n");
        await writeFile(path.join(deployment, ".env"), exampleEnvironment(), { mode: 0o600 });
        await writeFile(passphrase, randomBytes(32).toString("hex"), { mode: 0o600 });
        const bundle = path.join(fixture.root, "bundle");
        await expect(invoke(["backup", "--mode", "full", "--source", fixture.source, "--deployment", deployment, "--output", bundle, "--passphrase-file", passphrase, "--object-storage", "omit"], { ...fixture, objectRequired: true })).rejects.toThrow();
        expect(await readdir(bundle)).toContain(".incomplete");
        const calls = await readFile(fixture.calls, "utf8");
        expect(calls).toContain("start generation-worker");
        expect(calls).not.toContain("disaster-backup.mjs");
    });

    it("does not overwrite an unrelated server's existing image tag", async () => {
        const fixture = await setup();
        const bundle = path.join(fixture.root, "bundle");
        const target = path.join(fixture.root, "target");
        await invoke(["backup", "--mode", "template", "--source", fixture.source, "--output", bundle], fixture);
        const manifest = JSON.parse(await readFile(path.join(bundle, "node-bundle.json"), "utf8"));
        await expect(invoke(["restore", "--input", bundle, "--target", target, "--domain", "https://new.example.com", "--apply", "--confirm", manifest.id], { ...fixture, conflictingImage: true })).rejects.toThrow();
        await expect(readFile(path.join(target, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(fixture.calls, "utf8")).not.toContain("image load");
    });
});

function exampleEnvironment() {
    return (
        [
            "NEXT_PUBLIC_SITE_URL=https://old.example.com",
            "VOZEB_PRO_IMAGE=vozeb-pro:local",
            "POSTGRES_PASSWORD=old-secret",
            "VOZEB_PRO_ENCRYPTION_KEY=old-secret",
            "VOZEB_PRO_INSTALL_TOKEN=old-secret",
            "VOZEB_PRO_MAINTENANCE_TOKEN=old-secret",
            "VOZEB_PRO_WORKER_TOKEN=old-secret",
        ].join("\n") + "\n"
    );
}

async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "vozeb-node-bundle-"));
    fixtureRoots.push(root);
    const source = path.join(root, "source");
    const bin = path.join(root, "bin");
    const calls = path.join(root, "docker-calls.log");
    await mkdir(path.join(source, "web", "src"), { recursive: true });
    await mkdir(path.join(source, "web", "scripts"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(source, "Dockerfile"), "FROM scratch\n");
    await writeFile(path.join(source, "docker-compose.local.yml"), "services: {}\n");
    await writeFile(path.join(source, ".env.example"), exampleEnvironment());
    await writeFile(path.join(source, ".env"), "PRIVATE=do-not-copy\n");
    await writeFile(path.join(source, "web", "src", "page.tsx"), "export default function Page() { return null; }\n");
    await writeFile(path.join(source, "web", "package.json"), "{}\n");
    await writeFile(path.join(source, "web", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    for (const file of ["disaster-backup.mjs", "disaster-restore.mjs", "disaster-media-check.mjs"]) await writeFile(path.join(source, "web", "scripts", file), "// fixture\n");
    await writeFile(
        path.join(bin, "docker"),
        `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_CALLS, args.join(' ') + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') fs.writeSync(1, JSON.stringify([{Id:'sha256:app',Architecture:'amd64'},{Id:'sha256:pg',Architecture:'amd64'}]));
if (args[0] === 'image' && args[1] === 'ls' && process.env.FAKE_CONFLICTING_IMAGE==='1' && args.at(-1)==='vozeb-pro:local') fs.writeSync(1, 'sha256:other');
if (args[0] === 'image' && args[1] === 'save') fs.writeSync(1, 'fake-image-data');
if (args[0] === 'compose' && args.includes('ps') && args.includes('-q')) fs.writeSync(1, args.at(-1) + '-container\\n');
else if (args[0] === 'compose' && args.includes('ps')) fs.writeSync(1, 'app\\ngeneration-worker\\n');
if (args[0] === 'container' && args[1] === 'inspect') fs.writeSync(1, 'sha256:app\\n');
if (args[0] === 'compose' && args.some(x => x.endsWith('disaster-media-check.mjs'))) fs.writeSync(1, JSON.stringify({localMediaPresent:process.env.FAKE_MEDIA_PRESENT==='1',objectStorageRequired:process.env.FAKE_OBJECT_REQUIRED==='1'}));
if (args[0] === 'compose' && args.some(x => x.endsWith('disaster-backup.mjs'))) {
  const mounted = args[args.findIndex(x => x === '-v') + 1].split(':')[0];
  const dir = require('path').join(mounted, 'point');
  const file = require('path').join(dir, 'database', 'vozeb-pro.dump');
  fs.mkdirSync(require('path').dirname(file), {recursive:true});
  fs.writeFileSync(file, 'fake-database');
  const hash = require('crypto').createHash('sha256').update('fake-database').digest('hex');
  fs.writeFileSync(require('path').join(dir, 'recovery-point.json'), JSON.stringify({recoveryPointId:'test-point',database:{file:'database/vozeb-pro.dump',bytes:13,sha256:hash},localMedia:{roots:[{name:'reference-assets',files:[]},{name:'generation-assets',files:[]}]},objectStorage:{objects:[]}}));
}
`,
        { mode: 0o700 },
    );
    await chmod(path.join(bin, "docker"), 0o700);
    return { root, source, bin, calls };
}

async function invoke(args, fixture) {
    return execute(process.execPath, [tool, ...args], {
        env: {
            ...process.env,
            PATH: `${fixture.bin}:${process.env.PATH}`,
            FAKE_DOCKER_CALLS: fixture.calls,
            FAKE_MEDIA_PRESENT: fixture.mediaPresent ? "1" : "0",
            FAKE_OBJECT_REQUIRED: fixture.objectRequired ? "1" : "0",
            FAKE_CONFLICTING_IMAGE: fixture.conflictingImage ? "1" : "0",
        },
        maxBuffer: 1024 * 1024,
    });
}
