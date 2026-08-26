import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshUserPointsIfSystem } from "@/services/api/points";
import { requestCanvasImageDecomposition } from "./canvas-image-decomposition";

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: vi.fn(async () => undefined) }));
vi.mock("@/services/api/session-expiration", () => ({ throwIfClientSessionExpired: vi.fn() }));

describe("canvas image decomposition API client", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
        vi.mocked(refreshUserPointsIfSystem).mockClear();
    });

    it("returns all recognized ecommerce layers and refreshes billed points", async () => {
        const data = {
            width: 1000,
            height: 1000,
            backgroundDescription: "蓝色背景",
            layers: [{ id: "product", name: "商品", kind: "product" as const, bbox: { x: 100, y: 120, width: 500, height: 700 }, zIndex: 1 }],
        };
        vi.mocked(fetch).mockResolvedValue(Response.json({ code: 0, data, msg: "OK" }));

        await expect(requestCanvasImageDecomposition({ requestId: "request-one", source: "/api/reference-assets/source.png" })).resolves.toEqual(data);
        expect(fetch).toHaveBeenCalledWith("/api/canvas/image-decomposition", expect.objectContaining({ method: "POST", body: JSON.stringify({ requestId: "request-one", source: "/api/reference-assets/source.png" }) }));
        expect(refreshUserPointsIfSystem).toHaveBeenCalledWith("system");
    });

    it("surfaces the server error and still refreshes billed points", async () => {
        vi.mocked(fetch).mockResolvedValue(Response.json({ code: 503, data: null, msg: "默认文本模型不支持图片理解" }, { status: 503 }));

        await expect(requestCanvasImageDecomposition({ requestId: "request-one", source: "/api/reference-assets/source.png" })).rejects.toThrow("默认文本模型不支持图片理解");
        expect(refreshUserPointsIfSystem).toHaveBeenCalledWith("system");
    });
});
