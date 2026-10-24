import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createAudioTask: vi.fn(),
    publicModelPricingMode: vi.fn(async () => undefined),
    getAuthSettings: vi.fn(async () => ({
        systemChannels: [],
        logicalModels: [],
        defaultModels: { audioModel: "" },
        generationConcurrency: { audio: 1 },
        generationDefaults: { audioVoice: "alloy", audioFormat: "mp3" },
    })),
}));

vi.mock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/auth/store", () => {
    class AuthInputError extends Error {
        status = 400;
    }
    return {
        AuthInputError,
        getAuthSettings: mocks.getAuthSettings,
        isAuthInputError: (error: unknown) => error instanceof AuthInputError,
        refundUserPoints: vi.fn(),
    };
});
vi.mock("@/lib/server/generation-task-store", async (importOriginal) => ({
    normalizeGenerationTaskContext: (await importOriginal<typeof import("@/lib/server/generation-task-store")>()).normalizeGenerationTaskContext,
    withGenerationConcurrencyLimit: vi.fn(async (_userId, _type, _staleMs, _limit, handler) => handler()),
    linkStoredGenerationTask: vi.fn(),
}));
vi.mock("@/lib/server/security", () => ({
    checkGenerationRateLimit: vi.fn(async () => ({ allowed: true, remaining: 19, resetAt: Date.now() + 60_000 })),
    rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/server/audio-task-store", () => ({
    createAudioTask: mocks.createAudioTask,
    getAudioTask: vi.fn(),
    transitionAudioTask: vi.fn(),
    updateAudioTask: vi.fn(),
}));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: vi.fn() }));
vi.mock("@/lib/server/model-pricing-activation-service", () => ({ publicModelPricingMode: mocks.publicModelPricingMode }));

import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import { POST } from "./route";

describe("audio task model routing", () => {
    beforeEach(() => vi.clearAllMocks());

    it("rejects a forged client model when the backend has no audio default", async () => {
        const response = await POST(
            new Request("http://localhost/api/audio-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ config: { model: "forged-audio" }, prompt: "Generate narration" }),
            }),
        );

        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("音频任务参数不完整或渠道不支持");
        expect(mocks.createAudioTask).not.toHaveBeenCalled();
    });

    it.each(["gemini", "dataeyes-gemini"] as const)("accepts a configured %s speech channel", async (protocol) => {
        const model = "gemini-3.1-flash-tts-preview";
        const channel = applyChannelProtocol({ id: "gemini-audio", name: "Gemini", baseUrl: "https://provider.example", apiKey: "fixture-key", apiFormat: "gemini", models: [model], enabled: true }, protocol);
        mocks.getAuthSettings.mockResolvedValueOnce({
            systemChannels: [channel],
            logicalModels: [],
            defaultModels: { audioModel: model },
            generationConcurrency: { audio: 1 },
            generationDefaults: { audioVoice: "Kore", audioFormat: "wav" },
        } as never);
        mocks.createAudioTask.mockImplementationOnce(async (input) => ({ ...input, id: "audio-gemini", status: "pending", createdAt: 1, updatedAt: 1 }));
        const response = await POST(
            new Request("http://localhost/api/audio-tasks", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    config: { model, voice: "Kore", format: "wav" },
                    prompt: "Generate narration",
                    context: {
                        conversationId: "conversation",
                        usageObservations: [{ pointsRecordId: "forged-charge" }],
                        billingMode: "official-usage",
                        billingPending: true,
                        billingRequests: [{ requestId: "forged" }],
                        pricedResponses: [{ data: "forged" }],
                        billing: { pointsCost: 0 },
                        upstream: { id: "forged-task" },
                    },
                }),
            }),
        );
        expect(response.status).toBe(200);
        expect(mocks.createAudioTask).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ apiFormat: "gemini", advancedConfig: expect.objectContaining({ protocol }) }) }));
        const input = mocks.createAudioTask.mock.calls.at(-1)![0];
        expect(input.conversationId).toBe("conversation");
        expect(input).not.toHaveProperty("usageObservations");
        for (const field of ["billingMode", "billingPending", "billingRequests", "pricedResponses"]) expect(input).not.toHaveProperty(field);
        expect(input).not.toHaveProperty("billing");
        expect(input).not.toHaveProperty("upstream");
    });

    it.each([
        ["fixed", "openai"],
        ["metered", "openai"],
        ["secondary-metered", "openai"],
        ["secondary-blocked", "openai"],
        ["fixed", "gemini"],
        ["metered", "gemini"],
        ["secondary-metered", "gemini"],
        ["secondary-blocked", "gemini"],
    ] as const)("keeps mixed audio protocol candidates in the selected %s %s operation", async (mode, primary) => {
        const model = "shared-audio-model";
        const available = [
            applyChannelProtocol({ id: "openai-audio", name: "OpenAI", baseUrl: "https://openai.example", apiKey: "fixture-key", apiFormat: "openai", models: [model], enabled: true }, "openai"),
            applyChannelProtocol({ id: "gemini-audio", name: "Gemini", baseUrl: "https://gemini.example", apiKey: "fixture-key", apiFormat: "gemini", models: [model], enabled: true }, "gemini"),
        ];
        const channels = primary === "openai" ? available : available.reverse();
        mocks.getAuthSettings.mockResolvedValueOnce({
            systemChannels: channels,
            logicalModels: [{ id: "audio", name: "Audio", capability: "audio", enabled: true, bindings: channels.map((channel, index) => ({ id: channel.id, channelId: channel.id, upstreamModel: model, enabled: true, priority: index + 1 })) }],
            defaultModels: { audioModel: "audio" },
            generationConcurrency: { audio: 1 },
            generationDefaults: { audioVoice: "alloy", audioFormat: "mp3" },
        } as never);
        if (mode === "metered") mocks.publicModelPricingMode.mockResolvedValueOnce({ billingMode: "official-usage", bindingKeys: [`${channels[0].id}/${model}`] } as never);
        if (mode === "secondary-metered") mocks.publicModelPricingMode.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ billingMode: "official-usage", bindingKeys: [`${channels[1].id}/${model}`] } as never);
        if (mode === "secondary-blocked") mocks.publicModelPricingMode.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ billingMode: "blocked", reason: "stale activation" } as never);
        mocks.createAudioTask.mockImplementationOnce(async (input) => ({ ...input, id: "audio-scoped", status: "pending", createdAt: 1, updatedAt: 1 }));

        const response = await POST(new Request("http://localhost/api/audio-tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { model: "audio" }, prompt: "Generate narration" }) }));

        expect(response.status).toBe(200);
        expect(mocks.publicModelPricingMode).toHaveBeenNthCalledWith(1, "audio", "audio", [expect.objectContaining({ channelId: channels[0].id })], undefined, primary === "openai" ? "chat/completions" : "generateContent");
        if (mode !== "metered") expect(mocks.publicModelPricingMode).toHaveBeenNthCalledWith(2, "audio", "audio", [expect.objectContaining({ channelId: channels[1].id })], undefined, primary === "openai" ? "generateContent" : "chat/completions");
        const input = mocks.createAudioTask.mock.calls.at(-1)![0];
        expect(input).toMatchObject({ config: { channelId: channels[0].id }, candidateConfigs: mode === "fixed" ? [expect.objectContaining({ channelId: channels[1].id })] : [] });
        expect(input.billingMode).toBe(mode === "metered" ? "official-usage" : undefined);
    });
});
