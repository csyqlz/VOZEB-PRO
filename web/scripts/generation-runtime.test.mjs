import { describe, expect, it, vi } from "vitest";

import { generationRuntimeEnvironment, resolveGenerationWorkerOrigin, waitForHttpReady } from "./generation-runtime.mjs";

describe("generation runtime environment", () => {
    it("uses distinct configured maintenance and worker tokens", () => {
        const maintenanceToken = "a".repeat(32);
        const workerToken = "b".repeat(32);
        const result = generationRuntimeEnvironment({ environment: { VOZEB_PRO_MAINTENANCE_TOKEN: maintenanceToken, VOZEB_PRO_WORKER_TOKEN: workerToken, PORT: "3100" } });

        expect(result).toMatchObject({ ephemeralToken: false, environment: { VOZEB_PRO_MAINTENANCE_TOKEN: maintenanceToken, VOZEB_PRO_WORKER_TOKEN: workerToken, VOZEB_PRO_WORKER_API_ORIGIN: "http://127.0.0.1:3100" } });
    });

    it("generates a process-local token only for development", () => {
        const result = generationRuntimeEnvironment({ environment: {}, allowEphemeralToken: true });

        expect(result.ephemeralToken).toBe(true);
        expect(result.environment.VOZEB_PRO_MAINTENANCE_TOKEN).toHaveLength(64);
        expect(result.environment.VOZEB_PRO_WORKER_TOKEN).toHaveLength(64);
        expect(result.environment.VOZEB_PRO_WORKER_TOKEN).not.toBe(result.environment.VOZEB_PRO_MAINTENANCE_TOKEN);
    });

    it("fails production startup before the app can run without a valid token", () => {
        expect(() => generationRuntimeEnvironment({ environment: { VOZEB_PRO_MAINTENANCE_TOKEN: "short", VOZEB_PRO_WORKER_TOKEN: "b".repeat(32) } })).toThrow("distinct and contain at least 32 characters");
        expect(() => generationRuntimeEnvironment({ environment: { VOZEB_PRO_MAINTENANCE_TOKEN: "a".repeat(32), VOZEB_PRO_WORKER_TOKEN: "a".repeat(32) } })).toThrow("distinct and contain at least 32 characters");
    });

    it("normalizes a Render private hostport to an HTTP origin", () => {
        expect(resolveGenerationWorkerOrigin({ environment: { VOZEB_PRO_WORKER_API_ORIGIN: "vozeb-pro:3000" } })).toBe("http://vozeb-pro:3000");
    });

    it("waits for the web health contract before releasing the worker", async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const sleep = vi.fn(async () => undefined);

        await waitForHttpReady({ origin: "http://127.0.0.1:3100", fetcher, sleep });

        expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:3100/api/health/live", expect.objectContaining({ cache: "no-store" }));
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(50, undefined);
    });
});
