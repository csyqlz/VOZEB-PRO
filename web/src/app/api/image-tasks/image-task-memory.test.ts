import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ registrations: vi.fn() }));

vi.mock("@/lib/server/local-media-registry", () => ({ getLocalMediaRegistrations: mocks.registrations }));

import { createWeightedImageSubmissionQueue, estimateImageSubmissionSourceBytes } from "./image-task-memory";

describe("image submission memory queue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.registrations.mockResolvedValue([]);
    });

    it("waits until enough memory is released before starting another large submission", async () => {
        const queue = createWeightedImageSubmissionQueue(100);
        const order: string[] = [];
        let releaseFirst!: () => void;
        const firstCanFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstStarted!: () => void;
        const firstDidStart = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });

        const first = queue.run(70, async () => {
            order.push("first:start");
            firstStarted();
            await firstCanFinish;
            order.push("first:end");
        });
        await firstDidStart;
        const second = queue.run(70, async () => {
            order.push("second:start");
            order.push("second:end");
        });

        await Promise.resolve();
        expect(order).toEqual(["first:start"]);

        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    });

    it("uses registered media bytes when estimating an inline edit submission", async () => {
        mocks.registrations.mockResolvedValue([
            { storageKey: "permanent/large-source.png", bytes: 16_377_533 },
            { storageKey: "permanent/person.png", bytes: 2_989_436 },
        ]);

        await expect(
            estimateImageSubmissionSourceBytes({
                userId: "user-one",
                references: [{ dataUrl: "/api/reference-assets/permanent/large-source.png" }, { dataUrl: "/api/reference-assets/permanent/person.png" }],
            }),
        ).resolves.toBe(19_366_969);
        expect(mocks.registrations).toHaveBeenCalledWith(["permanent/large-source.png", "permanent/person.png"], { ownerUserId: "user-one" });
    });
});
