import path from "node:path";
import { fileURLToPath } from "node:url";

import { generationRuntimeEnvironment, superviseGenerationRuntime } from "./generation-runtime.mjs";

const mode = process.argv[2];
if (mode !== "dev") throw new Error("Usage: run-app.mjs dev");

const requestedPort = readPort(process.argv.slice(3)) || readPort([process.env.PORT]);

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextEntry = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
const runtime = generationRuntimeEnvironment({ allowEphemeralToken: true });
const environment = {
    ...runtime.environment,
    ...(requestedPort ? { PORT: String(requestedPort) } : {}),
    NEXT_DIST_DIR: runtime.environment.NEXT_DIST_DIR?.trim() || ".next-dev",
};
if (requestedPort && requestedPort !== 3000) environment.NEXT_DIST_DIR = `${environment.NEXT_DIST_DIR}-${requestedPort}`;
if (runtime.ephemeralToken) console.log("Generated ephemeral maintenance and worker tokens for this local development process.");

process.exitCode = await superviseGenerationRuntime({
    app: { command: process.execPath, args: [nextEntry, "dev", "--webpack", "-H", "0.0.0.0", "-p", String(requestedPort || 3000)], cwd: webRoot },
    workerScript: path.join(webRoot, "scripts", "generation-worker.mjs"),
    environment,
});

function readPort(values) {
    for (const value of values) {
        const text = String(value || "").trim();
        const match = text.match(/^(?:--port|-p)?=?([1-9]\d{2,4})$/);
        if (match) return Number(match[1]);
    }
    return 0;
}
