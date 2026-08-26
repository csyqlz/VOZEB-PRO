import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MIN_TOKEN_LENGTH = 32;

export function generationRuntimeEnvironment({ environment = process.env, allowEphemeralToken = false } = {}) {
    const source = { ...environment };
    const maintenanceToken = source.VOZEB_PRO_MAINTENANCE_TOKEN?.trim() || "";
    const workerToken = source.VOZEB_PRO_WORKER_TOKEN?.trim() || "";
    if (!allowEphemeralToken && (maintenanceToken.length < MIN_TOKEN_LENGTH || workerToken.length < MIN_TOKEN_LENGTH || maintenanceToken === workerToken)) {
        throw new Error("VOZEB_PRO_MAINTENANCE_TOKEN and VOZEB_PRO_WORKER_TOKEN must be distinct and contain at least 32 characters");
    }

    const port = validPort(source.PORT) || 3000;
    const resolvedMaintenanceToken = maintenanceToken.length >= MIN_TOKEN_LENGTH ? maintenanceToken : randomBytes(32).toString("hex");
    let resolvedWorkerToken = workerToken.length >= MIN_TOKEN_LENGTH ? workerToken : randomBytes(32).toString("hex");
    if (resolvedWorkerToken === resolvedMaintenanceToken) resolvedWorkerToken = randomBytes(32).toString("hex");
    return {
        environment: {
            ...source,
            VOZEB_PRO_MAINTENANCE_TOKEN: resolvedMaintenanceToken,
            VOZEB_PRO_WORKER_TOKEN: resolvedWorkerToken,
            VOZEB_PRO_WORKER_API_ORIGIN: resolveGenerationWorkerOrigin({ environment: source, fallbackOrigin: `http://127.0.0.1:${port}` }),
        },
        ephemeralToken: maintenanceToken.length < MIN_TOKEN_LENGTH || workerToken.length < MIN_TOKEN_LENGTH || maintenanceToken === workerToken,
    };
}

export function resolveGenerationWorkerOrigin({ environment = process.env, fallbackOrigin = "http://127.0.0.1:3000" } = {}) {
    const raw = environment.VOZEB_PRO_WORKER_API_ORIGIN?.trim() || environment.VOZEB_PRO_INTERNAL_ORIGIN?.trim() || environment.NEXT_PUBLIC_SITE_URL?.trim() || fallbackOrigin;
    const value = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Generation worker origin must use HTTP or HTTPS");
    return url.origin;
}

export async function waitForHttpReady({ origin, fetcher = fetch, sleep = retrySleep, signal } = {}) {
    const healthUrl = new URL("/api/health/live", origin).toString();
    let retryMs = 50;
    while (!signal?.aborted) {
        try {
            const response = await fetcher(healthUrl, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
            if (response.ok) return;
        } catch {
            // The app may still be binding its port; keep waiting for its health contract.
        }
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, 1_000);
    }
    throw new DOMException("Aborted", "AbortError");
}

export function superviseGenerationRuntime({ app, workerScript, environment }) {
    const children = [];
    const readinessAbort = new AbortController();
    let workerStarted = false;

    return new Promise((resolve) => {
        let closed = 0;
        let stopping = false;
        let requestedExitCode = 0;
        let forceTimer;

        const cleanup = () => {
            process.off("SIGINT", stopForSignal);
            process.off("SIGTERM", stopForSignal);
            if (forceTimer) clearTimeout(forceTimer);
            readinessAbort.abort();
        };
        const stop = (exitCode) => {
            if (stopping) return;
            stopping = true;
            requestedExitCode = exitCode;
            for (const child of children) {
                if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGTERM");
            }
            forceTimer = setTimeout(() => {
                for (const child of children) {
                    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
                }
            }, 5_000);
            forceTimer.unref();
        };
        const stopForSignal = () => stop(0);

        const registerChild = (definition) => {
            const child = {
                ...definition,
                process: spawn(definition.command, definition.args, { cwd: definition.cwd, env: environment, stdio: "inherit" }),
            };
            children.push(child);
            child.process.once("error", (error) => {
                console.error(`${child.name} process failed to start`, error);
                stop(1);
            });
            child.process.once("close", (code) => {
                closed += 1;
                if (!stopping) {
                    console.error(`${child.name} process stopped unexpectedly with code ${code ?? "unknown"}`);
                    stop(code && code > 0 ? code : 1);
                }
                if (closed === children.length) {
                    cleanup();
                    resolve(requestedExitCode);
                }
            });
            return child;
        };

        process.once("SIGINT", stopForSignal);
        process.once("SIGTERM", stopForSignal);
        const web = registerChild({ name: "web", command: app.command, args: app.args, cwd: app.cwd });
        void waitForHttpReady({ origin: environment.VOZEB_PRO_WORKER_API_ORIGIN, signal: readinessAbort.signal })
            .then(() => {
                if (stopping || workerStarted || web.process.exitCode !== null || web.process.signalCode !== null) return;
                workerStarted = true;
                registerChild({ name: "generation-worker", command: process.execPath, args: [workerScript], cwd: app.cwd });
            })
            .catch((error) => {
                if (!stopping && !(error instanceof DOMException && error.name === "AbortError")) {
                    console.error("Web health check failed before starting generation worker", error instanceof Error ? error.message : error);
                    stop(1);
                }
            });
    });
}

function retrySleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function validPort(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}
