import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    optimizeCreativePrompt: vi.fn(),
    checkGenerationRateLimit: vi.fn(),
}));

vi.mock("@/app/api/vozeb-cms-capability", () => ({ requireVozebCmsCapability: vi.fn(async () => null) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ isAuthInputError: () => false }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: (origin: string) => origin }));
vi.mock("@/lib/server/prompt-optimization-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/server/prompt-optimization-service")>()),
    optimizeCreativePrompt: mocks.optimizeCreativePrompt,
}));
vi.mock("@/lib/server/security", () => ({
    checkGenerationRateLimit: mocks.checkGenerationRateLimit,
    rateLimitHeaders: () => new Headers(),
}));

import { POST } from "./route";

describe("prompt optimization route", () => {
    beforeEach(() => {
        mocks.getCurrentUser.mockReset().mockResolvedValue({ id: "user-one" });
        mocks.optimizeCreativePrompt.mockReset().mockResolvedValue("优化后的提示词");
        mocks.checkGenerationRateLimit.mockReset().mockResolvedValue({ allowed: true });
    });

    it("returns the optimized public prompt through the standard API envelope", async () => {
        const response = await POST(request({ requestId: "request-one", prompt: "原始提示词", mode: "video" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ code: 0, data: { prompt: "优化后的提示词" }, msg: "OK" });
        expect(mocks.optimizeCreativePrompt).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", requestId: "request-one", prompt: "原始提示词", mode: "video" }));
    });

    it("rejects empty prompts without calling the model", async () => {
        const response = await POST(request({ requestId: "request-one", prompt: "   ", mode: "image" }));

        expect(response.status).toBe(400);
        expect(mocks.optimizeCreativePrompt).not.toHaveBeenCalled();
    });

    it("requires a signed-in user", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const response = await POST(request({ requestId: "request-one", prompt: "原始提示词", mode: "agent" }));

        expect(response.status).toBe(401);
        expect(mocks.checkGenerationRateLimit).not.toHaveBeenCalled();
    });
});

function request(body: unknown) {
    return new Request("http://localhost:3000/api/agent/prompt-optimization", { method: "POST", headers: { "content-type": "application/json", cookie: "session=1" }, body: JSON.stringify(body) });
}
