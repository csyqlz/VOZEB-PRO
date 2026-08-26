import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    decomposeCanvasImage: vi.fn(),
    checkGenerationRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ isAuthInputError: () => false }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: (origin: string) => origin }));
vi.mock("@/lib/server/canvas-image-decomposition-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/server/canvas-image-decomposition-service")>()),
    decomposeCanvasImage: mocks.decomposeCanvasImage,
}));
vi.mock("@/lib/server/security", () => ({
    checkGenerationRateLimit: mocks.checkGenerationRateLimit,
    rateLimitHeaders: () => new Headers(),
}));

import { POST } from "./route";

describe("canvas image decomposition route", () => {
    const decomposition = {
        strategy: "ecommerce" as const,
        width: 1000,
        height: 1000,
        backgroundDescription: "蓝色背景",
        layers: [{ id: "product", name: "商品", kind: "product", bbox: { x: 100, y: 120, width: 500, height: 700 }, zIndex: 1 }],
    };

    beforeEach(() => {
        mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "user-one" });
        mocks.decomposeCanvasImage.mockReset().mockResolvedValue(decomposition);
        mocks.checkGenerationRateLimit.mockReset().mockResolvedValue({ allowed: true });
    });

    it("returns the recognized layers through the standard API envelope", async () => {
        const response = await POST(request({ requestId: "request-one", source: "/api/reference-assets/source.png" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { ...decomposition, batchGrant: expect.any(String) }, msg: "OK" });
        expect(mocks.decomposeCanvasImage).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", requestId: "request-one", source: "/api/reference-assets/source.png" }));
    });

    it("rejects an empty source before calling the model", async () => {
        const response = await POST(request({ requestId: "request-one", source: " " }));

        expect(response.status).toBe(400);
        expect(mocks.decomposeCanvasImage).not.toHaveBeenCalled();
    });

    it("requires a signed-in user", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const response = await POST(request({ requestId: "request-one", source: "/api/reference-assets/source.png" }));

        expect(response.status).toBe(401);
        expect(mocks.checkGenerationRateLimit).not.toHaveBeenCalled();
    });
});

function request(body: unknown) {
    return new Request("http://localhost:3000/api/canvas/image-decomposition", { method: "POST", headers: { "content-type": "application/json", cookie: "session=1" }, body: JSON.stringify(body) });
}
