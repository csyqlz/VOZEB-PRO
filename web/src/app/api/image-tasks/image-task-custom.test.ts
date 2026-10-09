import { describe, expect, it, vi } from "vitest";

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { ImageTask } from "@/lib/server/image-task-store";

const mocks = vi.hoisted(() => ({ imageSubmissionFetch: vi.fn() }));

vi.mock("./image-task-support", async () => ({
    ...(await vi.importActual<typeof import("./image-task-support")>("./image-task-support")),
    imageSubmissionFetch: mocks.imageSubmissionFetch,
}));

import { resolveDeclarativeImageSize, runCustomImageTask } from "./image-task-custom";

describe("declarative image request size", () => {
    it("does not turn Stable Diffusion intelligent requests into a square size", () => {
        expect(resolveDeclarativeImageSize({ quality: "auto", size: "auto", advancedConfig: { ...emptyAdvancedConfig(), protocol: "stable-diffusion" } })).toBe("");
    });

    it("preserves explicit dimensions and does not invent custom protocol defaults", () => {
        expect(resolveDeclarativeImageSize({ quality: "high", size: "1536x1024", advancedConfig: { ...emptyAdvancedConfig(), protocol: "stable-diffusion" } })).toBe("1536x1024");
        expect(resolveDeclarativeImageSize({ quality: "auto", size: "auto", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" } })).toBe("");
    });

    it("uses a SiliconFlow-safe default image size when the UI asks for auto", () => {
        expect(resolveDeclarativeImageSize({ model: "Kwai-Kolors/Kolors", quality: "auto", size: "auto", advancedConfig: { ...emptyAdvancedConfig(), protocol: "siliconflow" } })).toBe("1024x1024");
        expect(resolveDeclarativeImageSize({ model: "Qwen/Qwen-Image", quality: "auto", size: "auto", advancedConfig: { ...emptyAdvancedConfig(), protocol: "siliconflow" } })).toBe("1328x1328");
    });

    it("clamps explicit SiliconFlow dimensions to provider-safe presets", () => {
        expect(resolveDeclarativeImageSize({ model: "Kwai-Kolors/Kolors", quality: "medium", size: "2048x2048", advancedConfig: { ...emptyAdvancedConfig(), protocol: "siliconflow" } })).toBe("1024x1024");
        expect(resolveDeclarativeImageSize({ model: "Kwai-Kolors/Kolors", quality: "medium", size: "16:9", advancedConfig: { ...emptyAdvancedConfig(), protocol: "siliconflow" } })).toBe("1024x576");
        expect(resolveDeclarativeImageSize({ model: "Kwai-Kolors/Kolors", quality: "medium", size: "3:4", advancedConfig: { ...emptyAdvancedConfig(), protocol: "siliconflow" } })).toBe("768x1024");
    });

    it("submits SiliconFlow image requests with its documented JSON contract", async () => {
        mocks.imageSubmissionFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ images: [{ url: "https://cdn.example.com/result.png" }] }), {
                headers: { "content-type": "application/json" },
            }),
        );
        const task = {
            id: "image-siliconflow",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "generation",
            source: "image-workbench",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            prompt: "create a cheap product image",
            references: [],
            config: {
                baseUrl: "https://api.siliconflow.cn/v1",
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "Kwai-Kolors/Kolors",
                channelId: "siliconflow-channel",
                quality: "auto",
                size: "auto",
                advancedConfig: {
                    ...emptyAdvancedConfig(),
                    protocol: "siliconflow",
                    createPath: "/images/generations",
                    editPath: "/images/generations",
                    requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image_size":"{{size}}","batch_size":"{{batch_size}}","num_inference_steps":20,"guidance_scale":7.5}',
                    resultField: "images[0].url",
                    supportsReferenceImage: true,
                },
            },
        } as ImageTask;

        await expect(runCustomImageTask(task, "http://internal", "http://public", "", true)).resolves.toMatchObject({ remoteUrl: "https://cdn.example.com/result.png" });
        const request = mocks.imageSubmissionFetch.mock.calls[0];
        expect(request?.[1]).toBe("https://api.siliconflow.cn/v1/images/generations");
        expect(JSON.parse(String(request?.[2]?.body))).toMatchObject({
            model: "Kwai-Kolors/Kolors",
            image_size: "1024x1024",
            batch_size: 1,
            num_inference_steps: 20,
            guidance_scale: 7.5,
        });
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
        } as ImageTask;

        await expect(runCustomImageTask(task, "http://internal", "http://public", "", true)).resolves.toMatchObject({
            pending: {
                id: "upstream-one",
                mediaBaseUrl: "https://provider.example/v1/jobs",
                pollBaseUrl: "http://internal/api/ai/system/channel-one/jobs",
            },
        });
    });
});
