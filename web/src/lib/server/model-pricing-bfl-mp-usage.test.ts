import { describe, expect, it } from "vitest";
import { inspectBflFlux2MpUsage, inspectDataeyesBflFlux2MpUpperBound } from "./model-pricing-bfl-mp-usage";

describe("BFL FLUX.2 megapixel units", () => {
    it("rounds each output independently, including a batch of different sizes", () => {
        expect(
            inspectBflFlux2MpUsage({
                outputs: [
                    { width: 1024, height: 1024 },
                    { width: 1025, height: 1024 },
                ],
                referenceImages: [],
            }),
        ).toEqual({
            ready: true,
            quantities: {
                "first-output-mp": "2",
                "additional-output-mp": "1",
                "reference-mp": "0",
            },
        });
    });
    it("caps one reference at four MP and charges every reference once per output in a batch", () => {
        expect(
            inspectBflFlux2MpUsage({
                outputs: [
                    { width: 2048, height: 2048 },
                    { width: 1, height: 1 },
                ],
                referenceImages: [{ width: 4096, height: 2048 }],
            }),
        ).toEqual({
            ready: true,
            quantities: {
                "first-output-mp": "2",
                "additional-output-mp": "3",
                "reference-mp": "8",
            },
        });
        expect(
            inspectBflFlux2MpUsage({
                outputs: [{ width: 1024, height: 1024 }],
                referenceImages: [
                    { width: 2048, height: 2048 },
                    { width: 1, height: 1 },
                ],
            }),
        ).toEqual({
            ready: true,
            quantities: {
                "first-output-mp": "1",
                "additional-output-mp": "0",
                "reference-mp": "2",
            },
        });
    });
    it("does not infer units from missing, invalid, or transformed-overlimit dimensions", () => {
        for (const input of [
            { outputs: [], referenceImages: [] },
            { outputs: [{ width: 1024, height: 1024 }], referenceImages: undefined },
            { outputs: [{ width: 1024, height: 1024 }], referenceImages: [null] },
            { outputs: [{ width: 0, height: 1024 }], referenceImages: [] },
            { outputs: [{ width: 4096, height: 2048 }], referenceImages: [] },
        ])
            expect(inspectBflFlux2MpUsage(input).ready).toBe(false);
    });
    it("bounds one documented DataEyes response without treating the bound as observed usage", () => {
        expect(inspectDataeyesBflFlux2MpUpperBound(0)).toEqual({ ready: true, quantities: { "first-output-mp": "1", "additional-output-mp": "3", "reference-mp": "0" } });
        expect(inspectDataeyesBflFlux2MpUpperBound(1)).toEqual({ ready: true, quantities: { "first-output-mp": "1", "additional-output-mp": "3", "reference-mp": "4" } });
        expect(inspectDataeyesBflFlux2MpUpperBound(8)).toEqual({ ready: true, quantities: { "first-output-mp": "1", "additional-output-mp": "3", "reference-mp": "8" } });
        for (const count of [-1, 1.5, 9]) expect(inspectDataeyesBflFlux2MpUpperBound(count).ready).toBe(false);
    });
});
