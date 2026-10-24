import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectOpenAiImageUsage, observeImageTaskUsage } from "./model-pricing-image-usage";
import { createImageTask, getImageTask, updateImageTask, type ImageTask } from "./image-task-store";
import { emptyDb } from "@/lib/auth/store-normalizers";
import { writeAuthDb, readAuthDb } from "@/lib/auth/store-repository";
import { createPostgresRepositories, initializePostgresSchema, postgresQuery } from "./database";
import { parseImageSubmissionJson, publicTask } from "@/app/api/image-tasks/image-task-support";
import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import * as taskStore from "./generation-task-store";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
const payload = {
    model: "image-fixture",
    quality: "high",
    size: "1024x1024",
    data: [{ b64_json: png, revised_prompt: "private prompt" }],
    usage: { input_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 }, output_tokens: 25, output_tokens_details: { text_tokens: 5, image_tokens: 20 }, total_tokens: 75 },
};

describe("native Images API usage facts", () => {
    it("keeps modality subtotals separate and does not invent cache quantities", () => {
        const result = inspectOpenAiImageUsage(payload);
        expect(result).toMatchObject({
            hasResults: true,
            missing: [],
            invalid: [],
            quantities: { inputTotalTokens: "50", inputTextTokens: "10", inputImageTokens: "40", outputTotalTokens: "25", outputTextTokens: "5", outputImageTokens: "20", totalTokens: "75" },
        });
        expect(JSON.stringify(result)).not.toMatch(/private prompt|b64_json|cached/i);
    });
    it("keeps optional output detail missing instead of treating total output as image tokens", () => {
        const result = inspectOpenAiImageUsage({ ...payload, usage: { ...payload.usage, output_tokens_details: undefined } });
        expect(result.missing).toEqual(["output_tokens_details.text_tokens", "output_tokens_details.image_tokens"]);
        expect(result.quantities.outputTotalTokens).toBe("25");
        expect(result.quantities.outputImageTokens).toBeUndefined();
    });
    it("uses a consistent per-result response model and rejects conflicting result identities", () => {
        expect(inspectOpenAiImageUsage({ ...payload, model: undefined, data: [{ b64_json: png, model: "image-fixture" }] })).toMatchObject({ reportedModel: "image-fixture", invalid: [] });
        expect(inspectOpenAiImageUsage({ ...payload, data: [{ b64_json: png, model: "other" }] }).invalid).toContain("图片结果项报告的型号不一致");
        expect(
            inspectOpenAiImageUsage({
                ...payload,
                model: undefined,
                data: [
                    { b64_json: png, model: "image-fixture" },
                    { b64_json: png, model: "other" },
                ],
            }).invalid,
        ).toContain("图片结果项报告的型号不一致");
        expect(inspectOpenAiImageUsage({ ...payload, model: undefined, data: [{ b64_json: png, model: "image-fixture" }, { b64_json: png }] }).reportedModel).toBeUndefined();
    });
    it("accepts explicit zero-only metadata on direct Images calls but blocks unexplained nonzero values", () => {
        const zero = inspectOpenAiImageUsage({
            ...payload,
            usage: {
                ...payload.usage,
                input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 0 },
                output_tokens_details: { ...payload.usage.output_tokens_details, reasoning_tokens: 0 },
            },
        });
        expect(zero.invalid).toEqual([]);
        expect(zero.unmappedUsageFields).toEqual([]);
        expect(zero.zeroOnlyUsageFields).toEqual(["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"]);
        expect(zero.usageFields).toMatchObject({ "input_tokens_details.cached_tokens": "0", "output_tokens_details.reasoning_tokens": "0" });
        expect(inspectOpenAiImageUsage(payload)).toMatchObject({ zeroOnlyUsageFields: [], invalid: [] });
        for (const field of ["cached_tokens", "reasoning_tokens"] as const) {
            const usage =
                field === "cached_tokens"
                    ? { ...payload.usage, input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 1 } }
                    : { ...payload.usage, output_tokens_details: { ...payload.usage.output_tokens_details, reasoning_tokens: 1 } };
            expect(inspectOpenAiImageUsage({ ...payload, usage }).invalid).toContain(`未解释的图片用量字段：${field === "cached_tokens" ? "input_tokens_details" : "output_tokens_details"}.${field}`);
        }
    });
    it.each([-1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1, null, undefined])("does not price invalid or absent token count %j as zero", (value) => {
        const result = inspectOpenAiImageUsage({ ...payload, usage: { ...payload.usage, input_tokens: value } });
        expect(result.missing).toContain("input_tokens");
        expect(result.quantities.inputTotalTokens).toBeUndefined();
    });
    it.each([{ input_tokens: 51 }, { output_tokens: 26 }, { total_tokens: 76 }, { input_tokens: Number.MAX_SAFE_INTEGER, input_tokens_details: { text_tokens: Number.MAX_SAFE_INTEGER, image_tokens: 1 } }])(
        "rejects contradictory aggregate counters %j",
        (usage) => {
            expect(inspectOpenAiImageUsage({ ...payload, usage: { ...payload.usage, ...usage } }).invalid.length).toBeGreaterThan(0);
        },
    );
    it("keeps absent usage and asynchronous IDs distinguishable from a completed media result", () => {
        expect(inspectOpenAiImageUsage({ id: "provider-job", status: "processing" })).toMatchObject({ quantities: {}, hasResults: false });
        expect(inspectOpenAiImageUsage({ error: { message: "private error" } }).invalid).toEqual(["上游响应包含错误"]);
    });
});

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers)("image task usage persistence (%s)", (provider) => {
    let directory: string;
    let task: ImageTask;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-image-usage-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        const db = emptyDb();
        const now = new Date().toISOString();
        const user = {
            id: randomUUID(),
            username: `fixture_${randomUUID()}`,
            displayName: "用量夹具",
            bio: "",
            role: "user" as const,
            adminPermissions: [],
            status: "active" as const,
            pointsBalance: 70,
            passwordHash: "fixture-only",
            createdAt: now,
            updatedAt: now,
        };
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            await repos.users.createWithNextAccountId({ ...user, planId: settings.settings!.defaultPlanId });
        } else {
            db.users.push({ ...user, accountId: "0001", planId: db.settings.entitlements.defaultPlanId });
            await writeAuthDb(db);
        }
        task = await createImageTask({
            userId: user.id,
            username: user.username,
            displayName: user.displayName,
            kind: "generation",
            source: "image-workbench",
            prompt: "private prompt",
            references: [],
            attemptNo: 1,
            config: { baseUrl: "http://127.0.0.1", apiKey: "fixture-secret", apiFormat: "openai", channelId: "fixture-channel", model: "image-fixture", logicalModel: "logical-image" },
        });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (provider === "postgres") await createPostgresRepositories().users.delete(task.userId);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    it("persists actual local TCP generation and edit responses without changing results or the wallet", async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        const paths: string[] = [];
        const server = createServer((request, response) => {
            paths.push(request.url!);
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(payload));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Fixture did not bind");
            const origin = `http://127.0.0.1:${address.port}`;
            task.config.baseUrl = origin;
            const result = await runOpenAiImageTask(task, origin, origin, "");
            expect(result).toMatchObject({ dataUrl: `data:image/png;base64,${png}` });
            const editTask = { ...task, kind: "edit" as const, references: [{ dataUrl: `data:image/png;base64,${png}` }] };
            expect(await runOpenAiImageTask(editTask, origin, origin, "")).toMatchObject({ dataUrl: `data:image/png;base64,${png}` });
            expect(paths).toEqual(["/v1/images/generations", "/v1/images/edits"]);
            const restored = (await getImageTask(task.id))!;
            expect(restored.usageObservations).toHaveLength(2);
            expect(restored.usageObservations!.map((item) => item.operation)).toEqual(["generations", "edits"]);
            expect(restored.usageObservations![0]).toMatchObject({ attemptNo: 1, channelId: "fixture-channel", logicalModel: "logical-image", requestedModel: "image-fixture", observation: { missing: [], invalid: [] } });
            expect(JSON.stringify(restored.usageObservations)).not.toMatch(/private prompt|fixture-secret|b64_json|127\.0\.0\.1/);
            expect(publicTask(restored)).not.toHaveProperty("usageObservations");
            expect(restored.billing).toBeUndefined();
            if (provider === "postgres") {
                expect((await postgresQuery("SELECT points_balance FROM users WHERE id = $1", [task.userId])).rows[0].points_balance).toBe("70.00");
                expect((await createPostgresRepositories().points.listRecords(task.userId)).items).toHaveLength(0);
            } else expect((await readAuthDb()).users.find((user) => user.id === task.userId)!.pointsBalance).toBe(70);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });
    it("preserves concurrent observations and an older attempt without changing the current attempt", async () => {
        await updateImageTask(task.id, { attemptNo: 2 });
        await Promise.all(["generations", "edits"].map((operation) => observeImageTaskUsage(task, Response.json(payload), payload, `https://fixture.invalid/v1/images/${operation}`)));
        const restored = (await getImageTask(task.id))!;
        expect(restored.attemptNo).toBe(2);
        expect(restored.usageObservations).toHaveLength(2);
        expect(restored.usageObservations!.every((item) => item.attemptNo === 1)).toBe(true);
        expect(new Set(restored.usageObservations!.map((item) => item.id)).size).toBe(2);
    });
    it("retains provider usage numbers and field presence without storing private response text", async () => {
        const responsePayload = {
            ...payload,
            usage: {
                ...payload.usage,
                input_tokens_details: { ...payload.usage.input_tokens_details, cached_tokens: 7, vendor_secret: "fixture-secret" },
                vendor_breakdown: { cached_image_tokens: "3", prompt: "private prompt" },
            },
        };
        await observeImageTaskUsage(task, Response.json(responsePayload), responsePayload, "https://fixture.invalid/v1/images/generations");
        const restored = (await getImageTask(task.id))!;
        expect(restored.usageObservations![0].usageEvidence).toMatchObject({
            input_tokens: 50,
            input_tokens_details: { text_tokens: 10, image_tokens: 40, cached_tokens: 7, vendor_secret: null },
            vendor_breakdown: { cached_image_tokens: "3", prompt: null },
        });
        expect(JSON.stringify(restored.usageObservations)).not.toMatch(/fixture-secret|private prompt|b64_json/);
        expect(publicTask(restored)).not.toHaveProperty("usageObservations");
    });
    it("does not apply Images counters to Responses tools, Gemini or custom endpoints", async () => {
        for (const path of ["/v1/responses", "/models/image:generateContent", "/jobs"]) await observeImageTaskUsage(task, Response.json(payload), payload, `https://fixture.invalid${path}`);
        expect((await getImageTask(task.id))!.usageObservations).toBeUndefined();
    });
    it("returns an unchanged successful response even if observation persistence fails", async () => {
        vi.spyOn(taskStore, "mutateStoredGenerationTask").mockRejectedValueOnce(new Error("private database failure"));
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await parseImageSubmissionJson(task, Response.json(payload), "https://fixture.invalid/v1/images/generations")).toEqual(payload);
        expect(JSON.stringify(log.mock.calls)).not.toContain("private database failure");
        expect((await getImageTask(task.id))!.usageObservations).toBeUndefined();
    });
});
