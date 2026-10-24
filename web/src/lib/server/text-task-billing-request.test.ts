import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./model-pricing-service", () => ({ capturePublishedPricingIdentity: async () => null }));

import { createPostgresRepositories, initializePostgresSchema } from "./database";
import { bindTextTaskBillingRequest, createTextTask, getTextTask, transitionTextTask, updateTextTask, type TextTask } from "./text-task-store";

const providers = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? ["file", "postgres"] : ["file"];
describe.each(providers)("text task accounting association (%s)", (provider) => {
    let task: TextTask;
    let directory: string;
    let userId: string;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-task-billing-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", provider);
        userId = randomUUID();
        if (provider === "postgres") {
            await initializePostgresSchema();
            const repos = createPostgresRepositories();
            const settings = await repos.settings.getSettings();
            const now = new Date().toISOString();
            await repos.users.createWithNextAccountId({
                id: userId,
                username: `task_${userId}`,
                displayName: "任务计费关联夹具",
                bio: "",
                role: "user",
                adminPermissions: [],
                status: "active",
                planId: settings.settings!.defaultPlanId,
                pointsBalance: 20,
                passwordHash: "fixture-only",
                createdAt: now,
                updatedAt: now,
            });
        }
        task = await createTextTask({
            userId,
            config: { baseUrl: "/api/ai/system/channel", apiKey: "", model: "upstream", logicalModel: "writer", channelId: "channel", apiFormat: "openai" },
            messages: [],
            attemptNo: 1,
            attempts: [{ attemptNo: 1, channelId: "channel", model: "writer", capability: "text", status: "running", startedAt: Date.now() }],
        });
        await transitionTextTask(task, ["pending"], { status: "running" });
    });
    afterEach(async () => {
        if (provider === "postgres" && userId) await createPostgresRepositories().users.delete(userId);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    function input() {
        return {
            taskId: task.id,
            userId: task.userId,
            attemptNo: 1,
            requestId: `system-ai:${"a".repeat(64)}`,
            requestFingerprint: "b".repeat(64),
            businessRequestId: `task:${task.id}:1`,
            channelId: "channel",
            logicalModel: "writer",
            upstreamModel: "upstream",
        };
    }
    it("persists one immutable request across concurrent binding and unrelated updates", async () => {
        await Promise.all([bindTextTaskBillingRequest(input()), bindTextTaskBillingRequest(input()), updateTextTask(task.id, { billing: { pointsCost: 0.25, pointsRecordId: "record", refunded: false } })]);
        const { taskId: _taskId, userId: _userId, ...reference } = input();
        const saved = await getTextTask(task.id);
        expect(saved?.billingRequests).toEqual([reference]);
        expect(saved?.billing).toMatchObject({ pointsCost: 0.25 });
        await expect(bindTextTaskBillingRequest({ ...input(), requestFingerprint: "c".repeat(64) })).rejects.toThrow("不同计费请求");
        expect((await getTextTask(task.id))?.billingRequests).toEqual([reference]);
    });
    it("rejects another user, an old attempt, changed channel, and terminal task", async () => {
        await expect(bindTextTaskBillingRequest({ ...input(), userId: "another-user" })).rejects.toThrow("无权访问");
        await expect(bindTextTaskBillingRequest({ ...input(), attemptNo: 2 })).rejects.toThrow("已变化");
        await expect(bindTextTaskBillingRequest({ ...input(), channelId: "another-channel" })).rejects.toThrow("已变化");
        await expect(bindTextTaskBillingRequest({ ...input(), upstreamModel: "another-model" })).rejects.toThrow("已变化");
        await transitionTextTask(task, ["running"], { status: "cancelled" });
        await expect(bindTextTaskBillingRequest(input())).rejects.toThrow("已变化");
        expect((await getTextTask(task.id))?.billingRequests).toBeUndefined();
    });
    it("keeps prior attempts while recording a new server-owned request", async () => {
        await bindTextTaskBillingRequest(input());
        await updateTextTask(task.id, {
            attemptNo: 2,
            attempts: [
                { ...task.attempts![0], status: "failed" },
                { ...task.attempts![0], attemptNo: 2 },
            ],
        });
        await bindTextTaskBillingRequest({ ...input(), attemptNo: 2, requestId: `system-ai:${"c".repeat(64)}`, businessRequestId: `task:${task.id}:2` });
        const saved = await getTextTask(task.id);
        expect(saved?.billingRequests?.map((item) => item.attemptNo)).toEqual([1, 2]);
        await expect(bindTextTaskBillingRequest(input())).rejects.toThrow("已变化");
    });
});
