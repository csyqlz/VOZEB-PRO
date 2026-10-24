import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: session.user }));
import { GET as getPublicTask } from "@/app/api/video-tasks/[id]/route";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { readAuthDb, writeAuthDb } from "@/lib/auth/store-repository";
import { emptyAdvancedConfig, protocolModelConfig } from "@/lib/channel-protocol-registry";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { inspectMinimaxVideoUsage, observeVideoTaskUsage } from "./model-pricing-video-usage";
import { createVideoTask, getVideoTask, updateVideoTask, type VideoTask } from "./video-task-store";
import { queryVideoTaskUpstream } from "./video-task-runtime";
import * as taskStore from "./generation-task-store";

const payload = {
    task: {
        id: "original-video",
        model: "MiniMax-H3",
        status: "succeeded",
        resolution: "2K",
        task_type: "generation",
        modality: "video",
        duration: 15,
        content: { url: "https://media.example.com/private-result.mp4" },
        prompt: "private prompt",
        usage: { total_seconds: 6.25, input_seconds: 1.25, output_seconds: 5, input_image_count: 2, input_audio_seconds: 3.5, total_tokens: 99999 },
    },
};
const inspect = (value: unknown) => inspectMinimaxVideoUsage(value, "original-video", "MiniMax-H3");
describe("MiniMax V2 video usage facts", () => {
    it("preserves separate decimal meters without using requested duration, token usage or pricing assumptions", () => {
        expect(inspect(payload)).toMatchObject({ hasResult: true, missing: [], invalid: [], quantities: { totalSeconds: "6.25", inputSeconds: "1.25", outputSeconds: "5", inputImageCount: "2", inputAudioSeconds: "3.5" } });
        expect(inspect(payload).usageFields?.total_tokens).toBe("99999");
        expect(JSON.stringify(inspect(payload).quantities)).not.toMatch(/99999|tokens|duration/);
        expect(JSON.stringify(inspect(payload))).not.toMatch(/private|duration/);
    });
    it("keeps missing usage distinct from explicit zero", () => {
        expect(inspect({ task: { ...payload.task, usage: undefined } })).toMatchObject({ quantities: {}, missing: expect.arrayContaining(["task.usage.output_seconds", "task.usage.input_image_count"]) });
        expect(inspect({ task: { ...payload.task, usage: { input_seconds: 0, input_image_count: 0 } } }).quantities).toEqual({ inputSeconds: "0", inputImageCount: "0" });
    });
    it.each([-1, "5", true, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}, []])("marks unusable seconds %j instead of inserting zero", (value) => {
        const observation = inspect({ task: { ...payload.task, usage: { ...payload.task.usage, output_seconds: value } } });
        expect(observation.quantities.outputSeconds).toBeUndefined();
        expect(observation.invalid).toContain("task.usage.output_seconds 不是有效的非负数值");
    });
    it("rejects fractional image counts while preserving fractional media seconds", () => {
        const observation = inspect({ task: { ...payload.task, usage: { ...payload.task.usage, input_image_count: 1.5 } } });
        expect(observation.quantities.inputImageCount).toBeUndefined();
        expect(observation.quantities.inputSeconds).toBe("1.25");
        expect(observation.invalid).toContain("task.usage.input_image_count 不是有效的非负整数");
    });
    it.each([{ id: "other-video" }, { model: "MiniMax-H3-Max" }, { error: { message: "private provider message" } }])("retains an identity/error conflict %j without retaining provider prose", (patch) => {
        const observation = inspect({ task: { ...payload.task, ...patch } });
        expect(observation.invalid).toHaveLength(1);
        expect(JSON.stringify(observation)).not.toContain("private provider message");
    });
    it.each([undefined, "data:video/mp4;base64,private", "https://secret:password@example.com/video.mp4"])("does not treat absent or invalid result %j as completed media", (url) => {
        expect(inspect({ task: { ...payload.task, content: { url } } }).hasResult).toBe(false);
    });
});

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers)("video usage persistence (%s)", (provider) => {
    let directory: string;
    let task: VideoTask;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-video-usage-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        const db = emptyDb();
        const now = new Date().toISOString();
        const user = {
            id: randomUUID(),
            username: `fixture_${randomUUID()}`,
            displayName: "视频用量夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 70,
            passwordHash: "fixture-only",
            createdAt: now,
            updatedAt: now,
        };
        session.user.mockResolvedValue(user);
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            await repos.users.createWithNextAccountId({ ...user, planId: settings.settings!.defaultPlanId });
        } else {
            db.users.push({ ...user, accountId: "0001", planId: db.settings.entitlements.defaultPlanId });
            await writeAuthDb(db);
        }
        task = await createVideoTask({
            userId: user.id,
            requestedDurationSeconds: 15,
            prompt: "private prompt",
            source: "video-workbench",
            attempts: [{ attemptNo: 1, status: "running", model: "logical-video", channelId: "fixture-channel", startedAt: Date.now() }],
            upstream: { id: "original-video", provider: "generation", model: "MiniMax-H3", pointsRecordId: "original-fixed-charge" },
            config: {
                apiSource: "system",
                baseUrl: "http://127.0.0.1",
                apiKey: "system",
                apiFormat: "openai",
                channelId: "fixture-channel",
                model: "MiniMax-H3",
                logicalModel: "logical-video",
                advancedConfig: { ...emptyAdvancedConfig(), ...protocolModelConfig("minimax", "video", "MiniMax-H3") },
            },
        });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") await createPostgresRepositories().users.delete(task.userId);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    const path = "/v2/query/video_generation/original-video";
    async function localQuery(responsePayload: unknown = payload) {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const paths: string[] = [];
        const server = createServer((request, response) => {
            paths.push(request.url!);
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(responsePayload));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("fixture did not bind");
            const config = { ...task.config, baseUrl: `http://127.0.0.1:${address.port}` };
            const result = await queryVideoTaskUpstream({ ...task, config }, "", "");
            expect(paths).toEqual(task.config.model.startsWith("MiniMax-Hailuo") ? ["/v1/query/video_generation?task_id=original-video"] : [path]);
            return result;
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    }
    it("persists local TCP terminal facts privately and leaves the real wallet unchanged", async () => {
        expect(await localQuery()).toMatchObject({ state: "result_ready", resultUrl: payload.task.content.url });
        const restored = (await getVideoTask(task.id))!;
        expect(restored.usageObservations).toHaveLength(1);
        expect(restored.usageObservations![0]).toMatchObject({ attemptNo: 1, upstreamTaskId: "original-video", pointsRecordId: "original-fixed-charge", requestedModel: "MiniMax-H3", observation: { quantities: { outputSeconds: "5" } } });
        expect(restored.usageObservations![0].observation.usageFields?.total_tokens).toBe("99999");
        expect(JSON.stringify(restored.usageObservations)).not.toMatch(/private|fixture-secret/);
        const publicResponse = await getPublicTask(new Request(`http://internal/api/video-tasks/${task.id}`), { params: Promise.resolve({ id: task.id }) });
        expect(publicResponse.status).toBe(200);
        const publicJson = await publicResponse.json();
        expect(publicJson.task.durationSeconds).toBe(15);
        expect(JSON.stringify(publicJson)).not.toMatch(/usageObservations|outputSeconds|original-fixed-charge|fixture-secret/);
        if (provider === "postgres") {
            expect((await postgresQuery("SELECT points_balance FROM users WHERE id = $1", [task.userId])).rows[0].points_balance).toBe("70.00");
            expect((await createPostgresRepositories().points.listRecords(task.userId)).items).toHaveLength(0);
        } else expect((await readAuthDb()).users.find((user) => user.id === task.userId)!.pointsBalance).toBe(70);
    });
    it.each(["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"])("persists %s V1 facts through a real query and keeps them private", async (model) => {
        task = (await updateVideoTask(task.id, { config: { ...task.config, model, advancedConfig: { ...emptyAdvancedConfig(), ...protocolModelConfig("minimax", "video", model) } }, upstream: { ...task.upstream, model } }))!;
        const body = { task_id: "original-video", status: "Success", file_id: "original-file", video_width: 1920, video_height: 1080, base_resp: { status_code: 0 }, prompt: "PRIVATE_PROMPT", download_url: "https://media.example.com/private-result.mp4" };
        expect(await localQuery(body)).toMatchObject({ state: "result_ready", resultUrl: "https://media.example.com/private-result.mp4" });
        const queryPath = "/v1/query/video_generation?task_id=original-video";
        await Promise.all([observeVideoTaskUsage(task, body, queryPath), observeVideoTaskUsage(task, body, queryPath)]);
        const saved = (await getVideoTask(task.id))!;
        expect(saved.usageObservations).toHaveLength(1);
        expect(saved.usageObservations![0]).toMatchObject({ requestedModel: model, observation: { protocol: "minimax-hailuo-v1", fileId: "original-file", width: 1920, missing: [], invalid: [] } });
        expect(JSON.stringify(saved.usageObservations)).not.toMatch(/PRIVATE_|private-result|quantities|duration|reportedModel/);
        await observeVideoTaskUsage(task, { ...body, file_id: "changed-file" }, queryPath);
        expect((await getVideoTask(task.id))!.usageObservations).toHaveLength(2);
        for (const wrongPath of [path, "/v1/query/video_generation?task_id=other"]) await observeVideoTaskUsage(task, { ...body, file_id: "wrong-path-file" }, wrongPath);
        expect((await getVideoTask(task.id))!.usageObservations).toHaveLength(2);
        const publicResponse = await getPublicTask(new Request(`http://internal/api/video-tasks/${task.id}`), { params: Promise.resolve({ id: task.id }) });
        expect(publicResponse.status).toBe(200);
        expect(JSON.stringify(await publicResponse.json())).not.toMatch(/usageObservations|fileId|original-file|pointsRecordId/);
    });
    it("deduplicates repeated concurrent polling and retains changed provider facts without overwriting originals", async () => {
        await Promise.all([observeVideoTaskUsage(task, payload, path), observeVideoTaskUsage(task, payload, path)]);
        const changed = { task: { ...payload.task, usage: { ...payload.task.usage, output_seconds: 6 } } };
        await Promise.all([observeVideoTaskUsage(task, changed, path), observeVideoTaskUsage(task, changed, path)]);
        const observations = (await getVideoTask(task.id))!.usageObservations!;
        expect(observations).toHaveLength(2);
        expect(observations.map((item) => (item.observation.protocol === "minimax-video-v2" ? item.observation.quantities.outputSeconds : undefined))).toEqual(["5", "6"]);
    });
    it("retains an older attempt's facts without changing the current upstream identity", async () => {
        await updateVideoTask(task.id, { upstream: { ...task.upstream, id: "new-upstream" }, attempts: [...task.attempts!, { ...task.attempts![0], attemptNo: 2 }] });
        await observeVideoTaskUsage(task, payload, path);
        expect(await getVideoTask(task.id)).toMatchObject({ upstream: { id: "new-upstream" }, usageObservations: [{ attemptNo: 1, upstreamTaskId: "original-video" }] });
    });
    it("keeps failed terminal meters and missing fields without inventing a refund or zero usage", async () => {
        await observeVideoTaskUsage(task, { task: { ...payload.task, status: "failed", content: undefined, usage: { output_seconds: 1.5 } } }, path);
        expect((await getVideoTask(task.id))!.usageObservations![0].observation).toMatchObject({ status: "failed", hasResult: false, quantities: { outputSeconds: "1.5" }, missing: expect.arrayContaining(["task.usage.input_seconds"]) });
        expect((await getVideoTask(task.id))!.status).toBe("running");
    });
    it("does not treat intermediate polls, Hailuo V1, unknown protocols or another path as H3 terminal usage", async () => {
        await observeVideoTaskUsage(task, { task: { ...payload.task, status: "running" } }, path);
        await observeVideoTaskUsage(task, payload, "/v1/query/video_generation?task_id=original-video");
        await observeVideoTaskUsage({ ...task, config: { ...task.config, model: "MiniMax-Hailuo-2.3" } }, payload, path);
        await observeVideoTaskUsage({ ...task, config: { ...task.config, advancedConfig: emptyAdvancedConfig() } }, payload, path);
        expect((await getVideoTask(task.id))!.usageObservations).toBeUndefined();
    });
    it("keeps an actual successful TCP result when diagnostic persistence fails and redacts the error", async () => {
        vi.spyOn(taskStore, "mutateStoredGenerationTask").mockRejectedValueOnce(new Error("private database error"));
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await localQuery()).toMatchObject({ state: "result_ready", resultUrl: payload.task.content.url });
        expect(JSON.stringify(log.mock.calls)).not.toContain("private database error");
        expect((await getVideoTask(task.id))!.usageObservations).toBeUndefined();
    });
    it("does not attach another user's observation", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await observeVideoTaskUsage({ ...task, userId: randomUUID() }, payload, path);
        expect((await getVideoTask(task.id))!.usageObservations).toBeUndefined();
    });
});
