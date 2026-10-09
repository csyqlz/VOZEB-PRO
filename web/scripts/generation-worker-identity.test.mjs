import { describe, expect, it } from "vitest";

import { buildGenerationWorkerId, sanitizeGenerationWorkerId } from "./generation-worker-identity.mjs";

describe("generation worker identity", () => {
    it("normalizes non-ASCII worker IDs before they are sent as HTTP headers", () => {
        const workerId = sanitizeGenerationWorkerId("generation-worker:何万会:23968:87810682-d2bf-4c23-8337-4d8dd0ae864b");

        expect(workerId).toMatch(/^[A-Za-z0-9._:-]+$/);
        expect(workerId).not.toContain("何");
        expect(() => new Headers({ "x-vozeb-pro-worker-id": workerId })).not.toThrow();
    });

    it("builds a header-safe default worker ID from localized host names", () => {
        const workerId = buildGenerationWorkerId({
            configuredId: "",
            host: "何万会-PC",
            pid: 23968,
            uuid: "87810682-d2bf-4c23-8337-4d8dd0ae864b",
        });

        expect(workerId).toMatch(/^generation-worker:/);
        expect(workerId).toContain(":PC:");
        expect(workerId).toContain(":23968:");
        expect(workerId).toContain("87810682-d2bf-4c23-8337-4d8dd0ae864b");
        expect(() => new Headers({ "x-vozeb-pro-worker-id": workerId })).not.toThrow();
    });

    it("removes empty separator segments left by fully localized host names", () => {
        const workerId = buildGenerationWorkerId({
            configuredId: "",
            host: "何万会",
            pid: 23968,
            uuid: "87810682-d2bf-4c23-8337-4d8dd0ae864b",
        });

        expect(workerId).toBe("generation-worker:23968:87810682-d2bf-4c23-8337-4d8dd0ae864b");
        expect(() => new Headers({ "x-vozeb-pro-worker-id": workerId })).not.toThrow();
    });

    it("keeps worker IDs within the persisted and header size budget", () => {
        const workerId = sanitizeGenerationWorkerId(`worker:${"a".repeat(300)}`);

        expect(workerId.length).toBeLessThanOrEqual(150);
        expect(() => new Headers({ "x-vozeb-pro-worker-id": workerId })).not.toThrow();
    });
});
