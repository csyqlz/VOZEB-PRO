import { describe, expect, it } from "vitest";

import { nextGenerationWorkerPollPolicy } from "./generation-worker-policy.mjs";

describe("generation worker polling policy", () => {
    it("backs idle lanes off from two seconds to a ten second ceiling", () => {
        let idleBatches = 0;
        const delays = [];

        for (let index = 0; index < 5; index += 1) {
            const policy = nextGenerationWorkerPollPolicy({ claimed: 0, idleBatches, baseIdleDelayMs: 2_000 });
            delays.push(policy.delayMs);
            idleBatches = policy.idleBatches;
        }

        expect(delays).toEqual([2_000, 4_000, 8_000, 10_000, 10_000]);
    });

    it("returns to the active batch interval after claiming work", () => {
        expect(nextGenerationWorkerPollPolicy({ claimed: 3, idleBatches: 4, baseIdleDelayMs: 2_000 })).toEqual({ delayMs: 250, idleBatches: 0 });
    });

    it("wakes at the persisted next poll time instead of overshooting it with idle backoff", () => {
        expect(nextGenerationWorkerPollPolicy({ claimed: 0, idleBatches: 4, baseIdleDelayMs: 2_000, nextDueAt: 5_500, now: 1_000 })).toEqual({ delayMs: 4_500, idleBatches: 0 });
        expect(nextGenerationWorkerPollPolicy({ claimed: 0, idleBatches: 4, baseIdleDelayMs: 2_000, nextDueAt: 1_000, now: 1_000 })).toEqual({ delayMs: 250, idleBatches: 0 });
        expect(nextGenerationWorkerPollPolicy({ claimed: 0, idleBatches: 4, baseIdleDelayMs: 2_000, nextDueAt: 60_000, now: 1_000 })).toEqual({ delayMs: 10_000, idleBatches: 0 });
    });

    it("does not shorten an explicitly configured longer idle interval", () => {
        expect(nextGenerationWorkerPollPolicy({ claimed: 0, idleBatches: 2, baseIdleDelayMs: 30_000 })).toEqual({ delayMs: 30_000, idleBatches: 3 });
    });
});
