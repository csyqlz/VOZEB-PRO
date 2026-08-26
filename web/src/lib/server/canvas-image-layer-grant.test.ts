import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasImageDecomposition } from "@/lib/canvas-image-decomposition";

import { createCanvasImageLayerGrant, verifyCanvasImageLayerGrant } from "./canvas-image-layer-grant";

const source = "/api/reference-assets/source.png";
const decomposition: CanvasImageDecomposition = {
    strategy: "ecommerce",
    width: 1200,
    height: 800,
    backgroundDescription: "白色背景",
    backgroundPreservedVisuals: [],
    layers: [
        {
            id: "product",
            name: "商品",
            kind: "product",
            bbox: { x: 120, y: 80, width: 700, height: 620 },
            zIndex: 1,
        },
    ],
};

describe("canvas image layer grant", () => {
    beforeEach(() => vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "11".repeat(32)));

    it("accepts a transparent element slot bound to the user and full source", () => {
        const grant = createCanvasImageLayerGrant({ userId: "user-one", requestId: "request-one", source, decomposition });

        expect(
            verifyCanvasImageLayerGrant({
                userId: "user-one",
                source,
                batch: { grant, slotId: "layer:product" },
                outputBackground: "transparent",
            }),
        ).toMatchObject({ requestId: expect.stringMatching(/^canvas-layer:/), slotId: "layer:product" });
    });

    it("accepts the opaque background slot", () => {
        const grant = createCanvasImageLayerGrant({ userId: "user-one", requestId: "request-one", source, decomposition });

        expect(verifyCanvasImageLayerGrant({ userId: "user-one", source, batch: { grant, slotId: "background" } })).toMatchObject({ slotId: "background" });
    });

    it.each([
        ["another user", { userId: "user-two", source, slotId: "layer:product", outputBackground: "transparent" }],
        ["another source", { userId: "user-one", source: "/api/reference-assets/other.png", slotId: "layer:product", outputBackground: "transparent" }],
        ["an unknown slot", { userId: "user-one", source, slotId: "layer:unknown", outputBackground: "transparent" }],
        ["an opaque element", { userId: "user-one", source, slotId: "layer:product", outputBackground: undefined }],
        ["a transparent background", { userId: "user-one", source, slotId: "background", outputBackground: "transparent" }],
    ])("rejects %s", (_label, input) => {
        const grant = createCanvasImageLayerGrant({ userId: "user-one", requestId: "request-one", source, decomposition });

        expect(
            verifyCanvasImageLayerGrant({
                userId: input.userId,
                source: input.source,
                batch: { grant, slotId: input.slotId },
                outputBackground: input.outputBackground,
            }),
        ).toBeNull();
    });

    it("rejects a modified signature", () => {
        const grant = createCanvasImageLayerGrant({ userId: "user-one", requestId: "request-one", source, decomposition });
        const tampered = `${grant.slice(0, -1)}${grant.endsWith("a") ? "b" : "a"}`;

        expect(verifyCanvasImageLayerGrant({ userId: "user-one", source, batch: { grant: tampered, slotId: "layer:product" }, outputBackground: "transparent" })).toBeNull();
    });
});
