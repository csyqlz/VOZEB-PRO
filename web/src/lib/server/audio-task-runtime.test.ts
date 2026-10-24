import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));
vi.mock("@/lib/server/generation-media-authorization", () => ({ generationMediaProxyHeaders: vi.fn(() => ({ "x-media-auth": "signed" })) }));

const mocks = vi.hoisted(() => ({
    getTask: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    schedule: vi.fn(),
    register: vi.fn(),
    writeMedia: vi.fn(),
    refund: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ getAuthSettings: vi.fn(), refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/audio-task-store", () => ({
    getAudioTask: mocks.getTask,
    updateAudioTask: mocks.updateTask,
    transitionAudioTask: mocks.transitionTask,
}));
vi.mock("@/lib/server/creative-runtime-service", () => ({ registerGenerationTaskAssetsForUser: mocks.register }));
vi.mock("@/lib/server/generation-task-scheduler", () => ({ scheduleGenerationTask: mocks.schedule }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: mocks.writeMedia }));

import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { GenerationSubmissionUncertainError } from "./generation-submission-error";
import { createAudioTaskUpstreamStep, markAudioTaskFailed } from "./audio-task-runtime";
import type { AudioTask } from "./audio-task-store";
import { emptyAdvancedConfig, protocolModelConfig, registeredChannelProtocolDefinitions } from "@/lib/channel-protocol-registry";

const AUDIO_PROTOCOLS = registeredChannelProtocolDefinitions.filter((definition) => definition.capabilities.includes("audio"));

describe("audio task runtime submission safety", () => {
    let state: AudioTask;

    beforeEach(() => {
        vi.clearAllMocks();
        state = audioTask();
        mocks.getTask.mockImplementation(async () => state);
        mocks.updateTask.mockImplementation(async (_id: string, patch: Partial<AudioTask>) => {
            state = { ...state, ...patch };
            return state;
        });
        mocks.transitionTask.mockImplementation(async (_task: AudioTask, allowed: string[], patch: Partial<AudioTask>) => {
            if (!allowed.includes(state.status)) return null;
            state = { ...state, ...patch };
            return state;
        });
        mocks.writeMedia.mockResolvedValue({ token: "fixture-audio", url: "/api/reference-assets/fixture-audio.wav" });
        mocks.register.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("switches to the next channel after a deterministic 422 rejection", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: { message: "参数不受支持" } }, { status: 422 }))
            .mockResolvedValueOnce(Response.json({ audio_url: "https://cdn.example/result.mp3" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(createAudioTaskUpstreamStep(state, "http://internal")).resolves.toMatchObject({
            state: "result_ready",
            resultUrl: "https://cdn.example/result.mp3",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(state.config.channelId).toBe("channel-two");
        expect(state.candidateConfigs).toEqual([]);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "running"]);
        expect(mocks.schedule).toHaveBeenLastCalledWith(
            "audio",
            "audio-one",
            expect.objectContaining({ executionPhase: "result_ready", channelId: "channel-two", resultPayload: { url: "https://cdn.example/result.mp3" }, lastUpstreamStatus: "completed" }),
        );
    });

    it("persists an asynchronous upstream task identity before returning", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ id: "audio-upstream-one" })));

        await expect(createAudioTaskUpstreamStep(state, "http://internal")).resolves.toMatchObject({ state: "pending", upstreamTaskId: "audio-upstream-one" });

        expect(state.upstream).toEqual({ id: "audio-upstream-one", createPath: "/audio/speech" });
        expect(mocks.schedule).toHaveBeenLastCalledWith("audio", "audio-one", expect.objectContaining({ executionPhase: "submitted", upstreamTaskId: "audio-upstream-one", channelId: "channel-one", lastUpstreamStatus: "submitted" }));
    });

    it("does not persist an HTML fallback page as generated audio", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response("<!doctype html><html><body>fallback</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }))
            .mockResolvedValueOnce(Response.json({ audio_url: "https://cdn.example/result.mp3" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(createAudioTaskUpstreamStep(state, "http://internal")).resolves.toMatchObject({ state: "result_ready", resultUrl: "https://cdn.example/result.mp3" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mocks.writeMedia).not.toHaveBeenCalled();
        expect(state.attempts?.map(({ status }) => status)).toEqual(["failed", "running"]);
    });

    it.each(AUDIO_PROTOCOLS)("receives an audio response from the $id protocol over a local TCP interface", async (definition) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const custom = definition.id === "custom";
        const advancedConfig = custom
            ? {
                  ...emptyAdvancedConfig(),
                  protocol: "custom" as const,
                  createPath: "/custom/audio",
                  requestTemplate: '{"deployment":"{{model}}","content":"{{input}}","speaker":"{{voice}}","rate":"{{speed}}"}',
                  resultField: "data.audio_url",
              }
            : { ...emptyAdvancedConfig(), ...(protocolModelConfig(definition.id, "audio") || { protocol: definition.id }) };
        state = {
            ...audioTask(),
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: definition.apiFormat,
                model: `${definition.id}-audio`,
                channelId: `fixture-${definition.id}-audio`,
                voice: custom ? "nova" : definition.apiFormat === "gemini" ? "Kore" : "alloy",
                format: "wav",
                speed: custom ? "1.25" : "1",
                advancedConfig,
            },
            candidateConfigs: [],
        };

        try {
            const result = await createAudioTaskUpstreamStep(state, "http://internal");
            if (custom) {
                expect(result).toMatchObject({ state: "result_ready", resultUrl: expect.stringContaining("/media/fixture.wav") });
                expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toEqual({ deployment: "custom-audio", content: "test", speaker: "nova", rate: 1.25 });
            } else {
                expect(result).toEqual({ state: "completed" });
                expect(state).toMatchObject({ status: "success", result: { url: "/api/reference-assets/fixture-audio.wav", mimeType: "audio/wav" } });
                expect(mocks.writeMedia).toHaveBeenCalledWith(expect.stringMatching(/^data:audio\/wav;base64,UklGR/), "audio", expect.objectContaining({ ownerUserId: "user-one", taskId: "audio-one" }));
                expect(mocks.register).toHaveBeenCalledOnce();
            }
            expect(fixture.requests[0]).toMatchObject({
                method: "POST",
                path: custom
                    ? "/custom/audio"
                    : definition.apiFormat === "gemini"
                      ? `/models/${definition.id}-audio:generateContent`
                      : definition.id === "sub2api-grok"
                        ? "/tts"
                        : definition.id === "xai"
                          ? "/v1/tts"
                          : definition.id === "minimax"
                            ? "/v1/t2a_v2"
                            : "/audio/speech",
            });
            if (definition.id === "sub2api-grok" || definition.id === "xai") expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ text: "test", voice_id: "eve", language: "auto", codec: "wav" });
            if (definition.id === "minimax") expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ output_format: "hex", voice_setting: { voice_id: "male-qn-qingse" } });
            expect(fixture.requests[0]?.headers[definition.id === "gemini" ? "x-goog-api-key" : "authorization"]).toBe(definition.id === "gemini" ? "fixture-key" : "Bearer fixture-key");
            expect(fixture.requests[0]?.headers["idempotency-key"]).toBe("audio-task:audio-one:attempt:1");
            expect(fixture.requests[0]?.headers["x-client-request-id"]).toBe("audio-task:audio-one:attempt:1");
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it.each(["gpt-4o-audio-preview", "gpt-audio-1.5"])("saves %s speech from Chat Completions even when the saved OpenAI preset still names the TTS path", async (model) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        state = {
            ...audioTask(),
            config: { ...audioTask().config, baseUrl: `http://127.0.0.1:${address.port}`, model, format: "wav", advancedConfig: { ...emptyAdvancedConfig(), ...protocolModelConfig("openai", "audio") } },
            candidateConfigs: [],
        };
        try {
            await expect(createAudioTaskUpstreamStep(state, "http://internal")).resolves.toEqual({ state: "completed" });
            expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/chat/completions" });
            expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ model, modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" }, messages: [{ role: "user", content: "test" }] });
            expect(mocks.writeMedia).toHaveBeenCalledWith(expect.stringMatching(/^data:audio\/wav;base64,UklGR/), "audio", expect.objectContaining({ taskId: "audio-one" }));
            expect(state).toMatchObject({ status: "success", result: { mimeType: "audio/wav" } });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("fails safely when Chat Completions returns text without audio", async () => {
        state = { ...audioTask(), config: { ...audioTask().config, model: "gpt-4o-audio-preview", advancedConfig: { ...emptyAdvancedConfig(), ...protocolModelConfig("openai", "audio") } }, candidateConfigs: [] };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ id: "chat-one", choices: [{ message: { content: "text only" } }] })));

        await expect(createAudioTaskUpstreamStep(state, "http://internal")).resolves.toMatchObject({ state: "failed", error: expect.stringContaining("未返回有效的语音数据") });
        expect(state.upstream).toBeUndefined();
        expect(mocks.writeMedia).not.toHaveBeenCalled();
    });

    it("keeps the original candidate when the request connection is interrupted", async () => {
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error("socket closed"));
        vi.stubGlobal("fetch", fetchMock);

        await expect(createAudioTaskUpstreamStep(state, "http://internal")).rejects.toBeInstanceOf(GenerationSubmissionUncertainError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(state.config.channelId).toBe("channel-one");
        expect(state.candidateConfigs).toHaveLength(1);
        expect(state.attempts?.map(({ status }) => status)).toEqual(["running"]);
    });

    it("treats a successful response with invalid JSON as an uncertain submission", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce(
                new Response("not-json", {
                    status: 200,
                    headers: { "content-type": "application/json", "x-vozeb-pro-points-cost": "1.25", "x-vozeb-pro-points-record-id": "audio-points-unknown" },
                }),
            ),
        );

        await expect(createAudioTaskUpstreamStep(state, "http://internal")).rejects.toBeInstanceOf(GenerationSubmissionUncertainError);
        expect(state.config.channelId).toBe("channel-one");
        expect(state.billing).toEqual({ pointsCost: 1.25, pointsRecordId: "audio-points-unknown", refunded: false });
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("does not refund when audio success wins the failure transition race", async () => {
        state = { ...audioTask(), status: "running", billing: { pointsCost: 2, pointsRecordId: "audio-race", refunded: false } };
        mocks.transitionTask.mockImplementationOnce(async () => {
            state = { ...state, status: "success" };
            return null;
        });

        await expect(markAudioTaskFailed(state, "late failure")).resolves.toMatchObject({ status: "success" });
        expect(mocks.refund).not.toHaveBeenCalled();
    });

    it("commits the audio error state before refunding", async () => {
        state = { ...audioTask(), status: "running", attemptNo: 1, billing: { pointsCost: 2, pointsRecordId: "audio-failed", refunded: false } };
        mocks.refund.mockImplementationOnce(async () => {
            expect(state.status).toBe("error");
            return undefined;
        });

        await expect(markAudioTaskFailed(state, "provider failed")).resolves.toMatchObject({ status: "error", billing: { refunded: true } });
        expect(mocks.refund).toHaveBeenCalledOnce();
    });
});

function audioTask(): AudioTask {
    const second = { baseUrl: "https://two.example", apiKey: "two", apiFormat: "openai" as const, model: "audio-two", channelId: "channel-two", voice: "alloy", format: "mp3", speed: "1" };
    return {
        id: "audio-one",
        userId: "user-one",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        config: { baseUrl: "https://one.example", apiKey: "one", apiFormat: "openai", model: "audio-one", channelId: "channel-one", voice: "alloy", format: "mp3", speed: "1" },
        candidateConfigs: [second],
        prompt: "test",
    };
}
