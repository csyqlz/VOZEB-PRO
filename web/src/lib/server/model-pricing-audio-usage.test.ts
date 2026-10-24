import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), media: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: mocks.media }));
vi.mock("@/lib/server/creative-runtime-service", () => ({ registerGenerationTaskAssetsForUser: vi.fn().mockResolvedValue(undefined) }));
import { GET as getPublicTask } from "@/app/api/audio-tasks/[id]/route";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import { emptyAdvancedConfig, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { createAudioTask, getAudioTask, updateAudioTask, type AudioTask } from "./audio-task-store";
import { createAudioTaskUpstreamStep } from "./audio-task-runtime";
import { inspectAudioUsage, observeAudioTaskUsage } from "./model-pricing-audio-usage";
import * as taskStore from "./generation-task-store";

const chat = {
    model: "audio-fixture",
    service_tier: "default",
    choices: [{ message: { audio: { data: "private-audio", transcript: "private text" } } }],
    usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        prompt_tokens_details: { text_tokens: 10, audio_tokens: 0, image_tokens: 0, cached_tokens: 2, cache_write_tokens: 0 },
        completion_tokens_details: { text_tokens: 3, audio_tokens: 17, reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    },
};
const gemini = {
    modelVersion: "tts-fixture",
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: "private-audio" } }] } }],
    usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 31,
        thoughtsTokenCount: 1,
        cachedContentTokenCount: 2,
        toolUsePromptTokenCount: 0,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 10 }],
        candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 20 }],
        cacheTokensDetails: [{ modality: "TEXT", tokenCount: 2 }],
        toolUsePromptTokensDetails: [{ modality: "TEXT", tokenCount: 0 }],
    },
};

describe("audio usage facts", () => {
    it.each([0, [], {}, null, "", " "])("records malformed identity and tier %j instead of dropping it", (value) => {
        expect(inspectAudioUsage("openai-chat-audio", { ...chat, model: value, service_tier: value }).invalid).toEqual(["上游响应型号格式无效", "上游服务档位格式无效"]);
        expect(inspectAudioUsage("gemini-tts", { ...gemini, modelVersion: value, usageMetadata: { ...gemini.usageMetadata, serviceTier: value } }).invalid).toEqual(["上游响应型号格式无效", "上游服务档位格式无效"]);
    });
    it("keeps explicit modalities without deriving missing or uncached quantities", () => {
        const result = inspectAudioUsage("openai-chat-audio", chat);
        expect(result).toMatchObject({ hasAudio: true, missing: [], invalid: [], quantities: { inputAudioTokens: "0", inputCachedTokens: "2", outputAudioTokens: "17", outputTextTokens: "3" } });
        expect(result.quantities).not.toHaveProperty("uncachedInputTokens");
        expect(JSON.stringify(result)).not.toContain("private");
    });
    it("preserves Gemini modality lists, thought counts and original totals independently", () => {
        expect(inspectAudioUsage("gemini-tts", gemini)).toMatchObject({ hasAudio: true, missing: [], invalid: [], quantities: { inputTextTokens: "10", outputAudioTokens: "20", thoughtTokens: "1", totalTokens: "31", cachedInputTextTokens: "2" } });
        expect(inspectAudioUsage("gemini-tts", gemini).quantities).not.toHaveProperty("outputTextTokens");
    });
    it.each(["openai-chat-audio", "gemini-tts"] as const)("keeps missing %s usage and audio separate from zero", (protocol) => {
        expect(inspectAudioUsage(protocol, {})).toMatchObject({ hasAudio: false, quantities: {} });
        expect(inspectAudioUsage(protocol, {}).missing.length).toBeGreaterThan(0);
        expect(inspectAudioUsage(protocol, { error: { message: "private failure" } }).invalid).toEqual(["上游响应包含错误"]);
    });
    it.each([-1, 0.25, "3", true, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, {}, []])("marks invalid count %j without a zero substitute", (value) => {
        const a = inspectAudioUsage("openai-chat-audio", { ...chat, usage: { ...chat.usage, completion_tokens: value } });
        const b = inspectAudioUsage("gemini-tts", { ...gemini, usageMetadata: { ...gemini.usageMetadata, candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: value }] } });
        expect(a.quantities.outputTotalTokens).toBeUndefined();
        expect(b.quantities.outputAudioTokens).toBeUndefined();
        expect(a.invalid).toHaveLength(1);
        expect(b.invalid).toHaveLength(1);
    });
    it("does not infer text tokens from aggregate minus audio or treat omitted cache as zero", () => {
        const result = inspectAudioUsage("openai-chat-audio", { ...chat, usage: { ...chat.usage, prompt_tokens_details: {}, completion_tokens_details: { audio_tokens: 17 } } });
        expect(result.quantities.outputTextTokens).toBeUndefined();
        expect(result.quantities.inputCachedTokens).toBeUndefined();
        expect(result.missing).toContain("completion_tokens_details.text_tokens");
    });
    it("rejects contradictory totals and individual counters exceeding their totals", () => {
        expect(inspectAudioUsage("openai-chat-audio", { ...chat, usage: { ...chat.usage, total_tokens: 29 } }).invalid).toContain("totalTokens 与分项合计不一致");
        expect(inspectAudioUsage("openai-chat-audio", { ...chat, usage: { ...chat.usage, completion_tokens_details: { audio_tokens: 21 } } }).invalid).toContain("outputAudioTokens 超过 outputTotalTokens");
        expect(inspectAudioUsage("gemini-tts", { ...gemini, usageMetadata: { ...gemini.usageMetadata, totalTokenCount: 30 } }).invalid).toContain("totalTokens 与分项合计不一致");
        expect(inspectAudioUsage("gemini-tts", { ...gemini, usageMetadata: { ...gemini.usageMetadata, candidatesTokenCount: 21 } }).invalid).toContain("outputTotalTokens 与分项合计不一致");
    });
    it("rejects duplicate or unknown Gemini modalities without overwriting first facts or retaining unknown prose", () => {
        const result = inspectAudioUsage("gemini-tts", {
            ...gemini,
            usageMetadata: {
                ...gemini.usageMetadata,
                candidatesTokensDetails: [
                    { modality: "AUDIO", tokenCount: 10 },
                    { modality: "AUDIO", tokenCount: 20 },
                    { modality: "private-modality", tokenCount: 1 },
                ],
            },
        });
        expect(result.quantities.outputAudioTokens).toBe("10");
        expect(result.invalid).toHaveLength(2);
        expect(JSON.stringify(result)).not.toContain("private");
    });
    it("detects excessive known modality subtotals without counting cache or prediction overlaps twice", () => {
        const result = inspectAudioUsage("openai-chat-audio", { ...chat, usage: { ...chat.usage, prompt_tokens_details: { text_tokens: 8, audio_tokens: 8 }, completion_tokens_details: { text_tokens: 12, audio_tokens: 12 } } });
        expect(result.invalid).toContain("inputTotalTokens 小于已知模态合计");
        expect(result.invalid).toContain("outputTotalTokens 小于已知模态合计");
        expect(inspectAudioUsage("openai-chat-audio", chat).invalid).toEqual([]);
    });
    it.each([undefined, null, [], {}])("does not fill an absent Gemini modality list %j with zero", (details) => {
        const result = inspectAudioUsage("gemini-tts", { ...gemini, usageMetadata: { ...gemini.usageMetadata, candidatesTokensDetails: details } });
        expect(result.missing).toContain("candidatesTokensDetails");
        expect(result.quantities.outputAudioTokens).toBeUndefined();
    });
});

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers)("audio usage persistence (%s)", (provider) => {
    let directory: string;
    let task: AudioTask;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-audio-usage-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        const now = new Date().toISOString();
        const user = {
            id: randomUUID(),
            username: `fixture_${randomUUID()}`,
            displayName: "音频用量夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 70,
            passwordHash: "fixture-only",
            createdAt: now,
            updatedAt: now,
        };
        mocks.user.mockResolvedValue(user);
        mocks.media.mockReset().mockResolvedValue({ token: "fixture.wav", url: "/api/reference-assets/fixture.wav" });
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            await repos.users.createWithNextAccountId({ ...user, planId: settings.settings!.defaultPlanId });
        } else {
            const db = emptyDb();
            db.users.push({ ...user, accountId: "0001", planId: db.settings.entitlements.defaultPlanId });
            await writeAuthDb(db);
        }
        task = await createAudioTask({
            userId: user.id,
            prompt: "private prompt",
            source: "agent",
            attemptNo: 1,
            config: {
                baseUrl: "http://127.0.0.1",
                apiKey: "fixture-secret",
                apiFormat: "openai",
                channelId: "fixture-channel",
                model: "gpt-4o-audio-preview",
                logicalModel: "logical-audio",
                voice: "alloy",
                format: "wav",
                advancedConfig: { ...emptyAdvancedConfig(), ...protocolModelConfig("openai", "audio") },
            },
        });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") await createPostgresRepositories().users.delete(task.userId);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    async function localCreate(protocol: "openai" | "gemini" | "dataeyes-gemini") {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("Fixture did not bind");
            const isGemini = protocol !== "openai";
            await updateAudioTask(task.id, {
                config: {
                    ...task.config,
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiFormat: isGemini ? "gemini" : "openai",
                    model: isGemini ? "gemini-tts-fixture" : task.config.model,
                    advancedConfig: { ...emptyAdvancedConfig(), ...protocolModelConfig(protocol, "audio") },
                },
            });
            const result = await createAudioTaskUpstreamStep(task, "http://internal");
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0].path).toBe(isGemini ? "/models/gemini-tts-fixture:generateContent" : "/chat/completions");
            expect(mocks.media).toHaveBeenCalledWith(expect.stringMatching(/^data:audio\/wav;base64,UklGR/), "audio", expect.objectContaining({ taskId: task.id, ownerUserId: task.userId }));
            return result;
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    }
    it.each(["openai", "gemini", "dataeyes-gemini"] as const)("stores actual TCP %s response facts while retaining media and wallet behavior", async (protocol) => {
        expect(await localCreate(protocol)).toEqual({ state: "completed" });
        const restored = (await getAudioTask(task.id))!;
        expect(restored.status).toBe("success");
        expect(restored.usageObservations).toHaveLength(1);
        expect(restored.usageObservations![0]).toMatchObject({ attemptNo: 1, logicalModel: "logical-audio", observation: { hasAudio: true, invalid: [], quantities: { outputAudioTokens: protocol === "openai" ? "10" : "12" } } });
        expect(JSON.stringify(restored.usageObservations)).not.toMatch(/private|fixture-secret|transcript|inlineData/);
        const publicResponse = await getPublicTask(new Request(`http://internal/api/audio-tasks/${task.id}`), { params: Promise.resolve({ id: task.id }) });
        expect(publicResponse.status).toBe(200);
        expect(await publicResponse.text()).not.toMatch(/usageObservations|outputAudioTokens|fixture-secret/);
        if (provider === "postgres") {
            expect((await postgresQuery("SELECT points_balance FROM users WHERE id = $1", [task.userId])).rows[0].points_balance).toBe("70.00");
            expect((await createPostgresRepositories().points.listRecords(task.userId)).items).toHaveLength(0);
        } else expect((await readAuthDb()).users.find((user) => user.id === task.userId)!.pointsBalance).toBe(70);
    });
    const observe = (value: unknown, audioTask = task) => observeAudioTaskUsage(audioTask, Response.json(value, { headers: { "x-vozeb-pro-points-record-id": "original-charge" } }), value, "/chat/completions", "openai-chat-audio");
    it("deduplicates concurrency but preserves changed facts and the original fixed charge identity", async () => {
        await Promise.all([observe(chat), observe(chat)]);
        const changed = { ...chat, usage: { ...chat.usage, completion_tokens: 21 } };
        await Promise.all([observe(changed), observe(changed)]);
        const receipts = (await getAudioTask(task.id))!.usageObservations!;
        expect(receipts).toHaveLength(2);
        expect(receipts.map((item) => item.observation.quantities.outputTotalTokens)).toEqual(["20", "21"]);
        expect(receipts.every((item) => item.pointsRecordId === "original-charge")).toBe(true);
    });
    it("retains late old attempt observations without changing current attempt or result", async () => {
        await updateAudioTask(task.id, { attemptNo: 2, status: "success", result: { url: "/new.wav", mimeType: "audio/wav" } });
        await observe(chat);
        expect(await getAudioTask(task.id)).toMatchObject({ attemptNo: 2, status: "success", result: { url: "/new.wav" }, usageObservations: [{ attemptNo: 1 }] });
    });
    it("isolates unrelated paths, HTTP errors and another user's task", async () => {
        for (const path of ["/audio/speech", "/tts", "/jobs"]) await observeAudioTaskUsage(task, Response.json(chat), chat, path, "openai-chat-audio");
        await observeAudioTaskUsage(task, Response.json(chat, { status: 503 }), chat, "/chat/completions", "openai-chat-audio");
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await observe(chat, { ...task, userId: randomUUID() });
        expect((await getAudioTask(task.id))!.usageObservations).toBeUndefined();
    });
    it("delivers the original successful TCP response even when diagnostic storage fails", async () => {
        const original = taskStore.mutateStoredGenerationTask;
        vi.spyOn(taskStore, "mutateStoredGenerationTask").mockImplementation((type, id, ttl, mutate, executor) =>
            original(
                type,
                id,
                ttl,
                (current) => {
                    const next = mutate(current);
                    if (next && "usageObservations" in next) throw new Error("private database failure");
                    return next;
                },
                executor,
            ),
        );
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await localCreate("openai")).toEqual({ state: "completed" });
        expect((await getAudioTask(task.id))!.usageObservations).toBeUndefined();
        expect(log).toHaveBeenCalled();
        expect(JSON.stringify(log.mock.calls)).not.toContain("private database failure");
    });
});
