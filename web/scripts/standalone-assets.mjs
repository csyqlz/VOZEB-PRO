import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function prepareStandaloneAssets({ webRoot, distDir = ".next" }) {
    const buildRoot = resolveChildPath(webRoot, distDir, "build directory");
    const standaloneRoot = path.join(buildRoot, "standalone");
    const serverEntry = path.join(standaloneRoot, "server.js");
    const sourceStatic = path.join(buildRoot, "static");
    const targetStatic = path.join(standaloneRoot, distDir, "static");
    const sourcePublic = path.join(webRoot, "public");
    const targetPublic = path.join(standaloneRoot, "public");

    await assertFile(serverEntry, `Standalone server was not found: ${serverEntry}`);
    const sharpRuntimePackages = await copySharpRuntimePackages(webRoot, standaloneRoot);
    const sourceStaticFiles = await listRelativeFiles(sourceStatic);
    if (!sourceStaticFiles.length) throw new Error(`Build static directory is empty: ${sourceStatic}`);

    const sourcePublicFiles = await listRelativeFiles(sourcePublic);
    for (const requiredAsset of ["logo.svg", "icon.svg"]) {
        if (!sourcePublicFiles.includes(requiredAsset)) throw new Error(`Required brand asset is missing: public/${requiredAsset}`);
    }

    await copyDirectoryContents(sourceStatic, targetStatic);
    await copyDirectoryContents(sourcePublic, targetPublic);

    const targetStaticFiles = await listRelativeFiles(targetStatic);
    const targetPublicFiles = await listRelativeFiles(targetPublic);
    if (!targetStaticFiles.length) throw new Error(`Standalone static directory is empty: ${targetStatic}`);
    const missingPublicFiles = sourcePublicFiles.filter((file) => !targetPublicFiles.includes(file));
    if (missingPublicFiles.length) throw new Error(`Standalone public directory is incomplete: ${missingPublicFiles.join(", ")}`);

    return { serverEntry, standaloneRoot, staticFiles: targetStaticFiles.length, publicFiles: targetPublicFiles.length, sharpRuntimePackages };
}

async function copySharpRuntimePackages(webRoot, standaloneRoot) {
    const sourcePnpmRoot = path.join(webRoot, "node_modules", ".pnpm");
    const targetPnpmRoot = path.join(standaloneRoot, "node_modules", ".pnpm");
    const packages = (await readdir(sourcePnpmRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("@img+sharp-"));
    if (!packages.length) throw new Error(`Sharp runtime packages were not found: ${sourcePnpmRoot}`);
    if (process.platform === "linux" && !packages.some((entry) => entry.name.startsWith("@img+sharp-linux"))) {
        throw new Error(`Sharp native Linux runtime package was not found: ${sourcePnpmRoot}`);
    }
    if (process.platform === "linux" && !packages.some((entry) => entry.name.startsWith("@img+sharp-libvips-linux"))) {
        throw new Error(`Sharp libvips runtime package was not found: ${sourcePnpmRoot}`);
    }

    await mkdir(targetPnpmRoot, { recursive: true });
    const copies = packages.map((entry) => ({ source: path.join(sourcePnpmRoot, entry.name), target: path.join(targetPnpmRoot, entry.name) }));
    await Promise.all(copies.map(({ target }) => rm(target, { recursive: true, force: true })));
    await Promise.all(copies.map(({ source, target }) => cp(source, target, { recursive: true, force: true, verbatimSymlinks: true })));
    return packages.map((entry) => entry.name).sort();
}

async function assertFile(target, message) {
    try {
        if (!(await stat(target)).isFile()) throw new Error(message);
    } catch {
        throw new Error(message);
    }
}

async function copyDirectoryContents(source, target) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    await Promise.all(entries.map((entry) => cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: true })));
}

async function listRelativeFiles(root, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = await Promise.all(
        entries.map(async (entry) => {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) return listRelativeFiles(root, target);
            return entry.isFile() ? [path.relative(root, target).replaceAll(path.sep, "/")] : [];
        }),
    );
    return files.flat().sort();
}

function resolveChildPath(root, child, label) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, child);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Invalid ${label}: ${child}`);
    return resolved;
}
