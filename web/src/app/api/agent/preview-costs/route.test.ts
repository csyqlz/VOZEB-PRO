import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), preview: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/creative-cost-preview-service", () => ({ previewCreativeDirectCosts: mocks.preview }));

import { POST } from "./route";

describe("agent cost preview API", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "user-one" });
        mocks.preview.mockResolvedValue({ totalCount: 2, fixedEstimatedPoints: 3, lines: [] });
    });

    it("rejects anonymous requests before reading pricing", async () => {
        mocks.user.mockResolvedValue(null);
        const response = await POST(request({ modelIds: ["image-a"] }));
        expect(response.status).toBe(401);
        expect(mocks.preview).not.toHaveBeenCalled();
    });

    it("normalizes current preferences and returns a private, non-cached preview", async () => {
        const response = await POST(request({ modelIds: ["image-b", "image-a"], preferences: { image: { count: 2, quality: "high" } }, hasImageReferences: true }));
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(mocks.preview).toHaveBeenCalledWith(["image-b", "image-a"], { image: { quality: "high", count: 2 } }, true);
        expect((await response.json()).data.preview.fixedEstimatedPoints).toBe(3);
    });

    it("rejects duplicate models without accessing the cost service", async () => {
        const response = await POST(request({ modelIds: ["image-a", "image-a"] }));
        expect(response.status).toBe(400);
        expect(mocks.preview).not.toHaveBeenCalled();
    });

    it("rejects invalid JSON through the bounded request reader", async () => {
        const response = await POST(new Request("http://localhost/api/agent/preview-costs", { method: "POST", body: "{" }));
        expect(response.status).toBe(400);
        expect(mocks.preview).not.toHaveBeenCalled();
    });
});

function request(body: unknown) {
    return new Request("http://localhost/api/agent/preview-costs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
