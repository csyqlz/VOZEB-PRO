import { describe, expect, it } from "vitest";

import { GENERATION_ROUTE_MAX_DURATION_SECONDS, GENERATION_TRANSPORT_TIMEOUT_MS } from "./generation-http-lifecycle";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, resolveModelPollingAttempts, resolveModelRequestTimeoutMs } from "./model-request-policy";

describe("model request policy", () => {
    it("uses commercial defaults when a binding has no timeout override", () => {
        expect(resolveModelRequestTimeoutMs(undefined, "text")).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS.text);
        expect(resolveModelRequestTimeoutMs(undefined, "image")).toBe(10 * 60_000);
    });

    it("applies a binding timeout to text models", () => {
        expect(resolveModelRequestTimeoutMs({ capabilityProfile: { timeoutMs: 15_000 } }, "text")).toBe(15_000);
        expect(resolveModelRequestTimeoutMs({ capabilityProfile: { timeoutMs: 8 * 60_000 } }, "text")).toBe(8 * 60_000);
    });

    it("applies and bounds a binding timeout", () => {
        expect(resolveModelRequestTimeoutMs({ capabilityProfile: { timeoutMs: 420_000 } }, "image")).toBe(420_000);
        expect(resolveModelRequestTimeoutMs({ capabilityProfile: { timeoutMs: 100 } }, "image")).toBe(5_000);
        expect(resolveModelRequestTimeoutMs({ capabilityProfile: { timeoutMs: 60 * 60_000 } }, "image")).toBe(30 * 60_000);
    });

    it("extends asynchronous polling to the effective model timeout", () => {
        expect(resolveModelPollingAttempts({ capabilityProfile: { timeoutMs: 12 * 60_000 } }, "image", 2_500, 120)).toBe(288);
        expect(resolveModelPollingAttempts(undefined, "audio", 2_500, 180)).toBe(180);
    });

    it("keeps the HTTP lifecycle above every supported model timeout", () => {
        expect(GENERATION_TRANSPORT_TIMEOUT_MS).toBe(GENERATION_ROUTE_MAX_DURATION_SECONDS * 1000);
        expect(GENERATION_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MODEL_REQUEST_TIMEOUT_MS.video);
    });
});
