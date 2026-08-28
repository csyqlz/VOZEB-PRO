import { describe, expect, it, vi } from "vitest";

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { ImageTask } from "@/lib/server/image-task-store";

const mocks = vi.hoisted(() => ({ imageSubmissionFetch: vi.fn(), taskFetch: vi.fn() }));

vi.mock("./image-task-support", async () => ({
    ...(await vi.importActual<typeof import("./image-task-support")>("./image-task-support")),
    imageSubmissionFetch: mocks.imageSubmissionFetch,
    taskFetch: mocks.taskFetch,
}));

import { ImageQueryContractError } from "./image-task-support";
import { pollCustomImageTask, resolveDeclarativeImageSize, runCustomImageTask } from "./image-task-custom";

describe("declarative image request size", () => {
    it("does not turn Stable Diffusion intelligent requests into a square size", () => {
        expect(resolveDeclarativeImageSize({ quality: "auto", size: "auto", advancedConfig: { ...emptyAdvancedConfig(), protocol: "stable-diffusion" } })).toBe("");
    });

    it("preserves explicit dimensions and does not invent custom protocol defaults", () => {
        expect(resolveDeclarativeImageSize({ quality: "high", size: "1536x1024", advancedConfig: { ...emptyAdvancedConfig(), protocol: "stable-diffusion" } })).toBe("1536x1024");
        expect(resolveDeclarativeImageSize({ quality: "auto", size: "auto", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" } })).toBe("");
    });

    it("keeps the system proxy as the polling base when the proxy exposes the upstream URL", async () => {
        mocks.imageSubmissionFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ id: "upstream-one", status: "queued" }), {
                headers: { "content-type": "application/json", "x-vozeb-pro-upstream-url": "https://provider.example/v1/jobs" },
            }),
        );
        const task = {
            id: "image-one",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "generation",
            source: "image-workbench",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            prompt: "create an image",
            references: [],
            config: {
                baseUrl: "/api/ai/system/channel-one",
                apiKey: "",
                apiFormat: "openai",
                model: "custom-image",
                channelId: "channel-one",
                advancedConfig: {
                    ...emptyAdvancedConfig(),
                    protocol: "custom",
                    createPath: "/jobs",
                    queryPath: "/jobs/:task_id",
                    requestTemplate: '{"prompt":"{{prompt}}"}',
                    resultField: "data.image_url",
                },
            },
        } as unknown as ImageTask;

        await expect(runCustomImageTask(task, "http://internal", "http://public", "", true)).resolves.toMatchObject({
            pending: {
                id: "upstream-one",
                mediaBaseUrl: "https://provider.example/v1/jobs",
                pollBaseUrl: "http://internal/api/ai/system/channel-one/jobs",
            },
        });
    });

    it("classifies non-JSON query responses as contract errors instead of upstream failures", async () => {
        const task = {
            id: "image-query-contract",
            userId: "user-one",
            kind: "generation",
            status: "running",
            prompt: "create an image",
            references: [],
            config: {
                baseUrl: "/api/ai/system/channel-one",
                apiKey: "",
                apiFormat: "openai",
                model: "custom-image",
                channelId: "channel-one",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", queryPath: "/jobs/:task_id" },
            },
        } as unknown as ImageTask;

        for (const response of [new Response("<!doctype html><html>blocked</html>", { headers: { "content-type": "text/html" } }), new Response("not-json", { headers: { "content-type": "text/plain" } })]) {
            mocks.taskFetch.mockResolvedValueOnce(response);
            await expect(pollCustomImageTask(task, "upstream-one", "https://provider.example", "http://internal/api/ai/system/channel-one", "", true)).rejects.toBeInstanceOf(ImageQueryContractError);
        }
        expect(mocks.taskFetch).toHaveBeenCalledTimes(2);
    });
});
