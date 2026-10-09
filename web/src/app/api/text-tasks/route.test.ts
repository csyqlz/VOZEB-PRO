import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createTextTask: vi.fn(),
    scheduleGenerationTask: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user-one", role: "user" })) }));
vi.mock("@/lib/auth/store", () => {
    class AuthInputError extends Error {
        status = 400;
    }
    return {
        AuthInputError,
        getAuthSettings: vi.fn(async () => ({
            defaultModels: { textModel: "text-model" },
            generationConcurrency: { text: 1 },
        })),
        isAuthInputError: (error: unknown) => error instanceof AuthInputError,
    };
});
vi.mock("@/lib/server/generation-channel", () => ({
    generationModelId: vi.fn(() => "text-model"),
    toSystemGenerationChannel: vi.fn((config) => config),
}));
vi.mock("@/lib/server/generation-task-recovery-service", () => ({ runGenerationTaskRecoveryBatch: vi.fn() }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.scheduleGenerationTask }));
vi.mock("@/lib/server/generation-task-store", () => ({
    withGenerationConcurrencyLimit: vi.fn(async (_userId, _type, _staleMs, _limit, handler) => handler()),
}));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn(() => "http://localhost") }));
vi.mock("@/lib/server/logical-model-router", () => ({
    resolveLogicalModelCandidates: vi.fn(() => [{ channelId: "channel-one", model: "text-model", apiFormat: "gemini", advancedConfig: { protocol: "gemini" } }]),
}));
vi.mock("@/lib/server/security", () => ({
    checkGenerationRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 })),
    rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/text-task-store", () => ({
    createTextTask: mocks.createTextTask,
}));

import { POST } from "./route";

describe("POST /api/text-tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createTextTask.mockImplementation(async (input) => ({ ...input, id: "text-task", status: "pending" }));
    });

    it("accepts a 10 MiB reference after browser base64 encoding", async () => {
        const encodedReference = "A".repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3));
        const response = await POST(
            new Request("http://localhost/api/text-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    config: { model: "text-model" },
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Describe this reference" },
                                { type: "image_url", image_url: { url: `data:image/png;base64,${encodedReference}` } },
                            ],
                        },
                    ],
                }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.createTextTask).toHaveBeenCalledOnce();
        expect(mocks.scheduleGenerationTask).toHaveBeenCalledOnce();
    });
});
