import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));

import { GenerationSubmissionSafeFailure } from "@/lib/server/generation-submission-error";
import { maintenanceWorkerContext } from "@/lib/server/maintenance-auth";
import {
    allowsImageProtocolFallback,
    ImageQueryContractError,
    findImageResult,
    imageRequestAspectRatio,
    imageTaskPollAttempts,
    imageTaskPollUrls,
    imageTaskRequestTimeoutMs,
    openAiImageTaskPath,
    parseImagePayloadOrPoll,
    parseImagePayloadCompat,
    parseImageQueryJson,
    resolveRequestSize,
    resolveResultSize,
    sanitizeConfigs,
    shouldFallbackToJsonImageEdit,
    shouldRetryJsonImageEditPayload,
    taskHeaders,
} from "./image-task-support";

const config = {
    baseUrl: "/api/ai/system/global-image",
    apiFormat: "openai",
    advancedConfig: { protocol: "globalaiopc", globalAiOpcPreset: "image-gpt-image-2", createPath: "/image2/images", queryPath: "/result/:task_id" },
} as never;

describe("GlobalAiOpc image task paths", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("preserves maintenance authorization for the internal system proxy", () => {
        const token = "m".repeat(32);
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", `${token}-maintenance`);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", token);
        const headers = taskHeaders(
            {
                baseUrl: "/api/ai/system/channel-one",
                apiKey: "system",
                apiFormat: "openai",
                model: "image-model",
                logicalModel: "image-logical",
            } as never,
            maintenanceWorkerContext("user-one"),
            "image-task:test:attempt:1",
        );

        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
        expect(headers.get("x-vozeb-pro-worker-user-id")).toBe("user-one");
        expect(headers.get("x-vozeb-pro-logical-model")).toBe("image-logical");
    });

    it("upscales small exact dimensions for the provider instead of rejecting the task", () => {
        expect(resolveRequestSize(undefined, "400x600")).toBe("672x1008");
        expect(resolveRequestSize(undefined, "512x512")).toBe("816x816");
    });

    it("passes exact dimensions through without a platform resolution ceiling", () => {
        expect(resolveRequestSize(undefined, "5000x5000")).toBe("5000x5000");
        expect(resolveRequestSize(undefined, "1200x7200")).toBe("1200x7200");
    });

    it("normalizes ratio results to the exact upstream request while restoring custom output dimensions", () => {
        expect(resolveResultSize("low", "1:1")).toBe("1024x1024");
        expect(resolveResultSize("high", "16:9")).toBe(resolveRequestSize("high", "16:9"));
        expect(resolveResultSize(undefined, "400x600")).toBe("400x600");
        expect(resolveResultSize(undefined, "auto")).toBeUndefined();
    });

    it("uses the model binding timeout for synchronous requests and asynchronous polling", () => {
        const configured = {
            baseUrl: "/api/ai/system/global-image",
            apiFormat: "openai",
            model: "gemini-3-pro-image-preview",
            advancedConfig: { protocol: "globalaiopc", globalAiOpcPreset: "image-gpt-image-2", createPath: "/image2/images", queryPath: "/result/:task_id" },
            capabilityProfile: { timeoutMs: 12 * 60_000 },
        } as never;
        expect(imageTaskRequestTimeoutMs(configured)).toBe(12 * 60_000);
        expect(imageTaskPollAttempts(configured)).toBe(288);
        expect(imageTaskRequestTimeoutMs(config)).toBe(10 * 60_000);
    });

    it.each([
        ["1080*1213", "1080x1213"],
        ["1080×1213", "1080x1213"],
        ["1080 X 1213", "1080x1213"],
    ])("normalizes custom image dimensions written as %s", (input, expected) => {
        expect(resolveRequestSize(undefined, input)).toBe(expected);
    });

    it("keeps a compatible ratio alongside exact custom dimensions", () => {
        expect(imageRequestAspectRatio("1824x1024")).toBe("16:9");
        expect(imageRequestAspectRatio("1024x1536")).toBe("2:3");
        expect(imageRequestAspectRatio("9:16")).toBe("9:16");
    });

    it("treats raw JPEG base64 as inline image data before relative URL parsing", () => {
        const jpegBase64 = `/9j/${"A".repeat(96)}`;
        expect(findImageResult(jpegBase64, "https://provider.example/v1/images/generations", config)).toMatchObject({
            dataUrl: `data:image/jpeg;base64,${jpegBase64}`,
        });
    });

    it("uses the configured create and result endpoints instead of OpenAI defaults", async () => {
        await expect(openAiImageTaskPath(config, "generation")).resolves.toBe("/image2/images");
        expect(imageTaskPollUrls(config, "http://localhost:3000/api/ai/system/global-image/image2/images", "task 1")[0]).toBe("http://localhost:3000/api/ai/system/global-image/result/task%201");
    });

    it("routes standard OpenAI generations and edits to their matching endpoints", async () => {
        const openAiConfig = {
            baseUrl: "https://provider.example/v1",
            model: "gpt-image-1",
            apiFormat: "openai",
            advancedConfig: { protocol: "openai", createPath: "/images/generations" },
        } as never;

        await expect(openAiImageTaskPath(openAiConfig, "generation")).resolves.toBe("/images/generations");
        await expect(openAiImageTaskPath(openAiConfig, "edit")).resolves.toBe("/images/edits");
        expect(imageTaskPollUrls(openAiConfig, "https://provider.example/v1/images/generations", "task-one")).toEqual([]);
    });

    it("keeps an OpenAI response with only an id for manual review instead of guessing a task endpoint", async () => {
        const openAiConfig = {
            baseUrl: "/api/ai/system/openai-image",
            model: "gpt-image-2",
            apiFormat: "openai",
            advancedConfig: { protocol: "openai", createPath: "/images/generations", queryPath: "" },
        } as never;

        await expect(parseImagePayloadOrPoll(openAiConfig, { id: "upstream-one" }, "http://localhost/api/ai/system/openai-image", "", "http://localhost/api/ai/system/openai-image", true)).resolves.toMatchObject({
            needsReview: { upstream: { id: "upstream-one" } },
        });
    });

    it("keeps every image returned by one upstream response", () => {
        const result = parseImagePayloadCompat({ data: [{ url: "https://cdn.example.com/first.png" }, { url: "https://cdn.example.com/second.png" }] }, "https://provider.example/v1/images/generations", {
            baseUrl: "https://provider.example/v1",
            model: "gpt-image-1",
            apiFormat: "openai",
        } as never);

        expect(result?.dataUrl).toBe("https://cdn.example.com/first.png");
        expect(result?.results?.map((item) => item.dataUrl)).toEqual(["https://cdn.example.com/first.png", "https://cdn.example.com/second.png"]);
    });

    it("classifies an HTML polling response as an invalid query contract", async () => {
        const response = new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });

        await expect(parseImageQueryJson(response)).rejects.toBeInstanceOf(ImageQueryContractError);
    });

    it("prefers the edit endpoint declared by the channel reference rule", async () => {
        const openAiConfig = {
            baseUrl: "https://provider.example/v1",
            model: "gpt-image-1",
            apiFormat: "openai",
            advancedConfig: { createPath: "/images/generations", referenceRule: "图生图使用 /images/edits；按 multipart/form-data 上传" },
        } as never;

        await expect(openAiImageTaskPath(openAiConfig, "edit")).resolves.toBe("/images/edits");
    });

    it("keeps Sub2API image edits on the configured shared endpoint", async () => {
        const sub2ApiConfig = {
            baseUrl: "https://provider.example/v1",
            model: "gpt-image-1",
            apiFormat: "openai",
            advancedConfig: { protocol: "sub2api", createPath: "/images/generations" },
        } as never;

        await expect(openAiImageTaskPath(sub2ApiConfig, "edit")).resolves.toBe("/images/generations");
    });

    it("treats a model-level protocol as strict even when the parent channel is legacy auto", () => {
        const modelConfig = {
            baseUrl: "https://provider.example/v1",
            model: "gpt-image-1",
            apiFormat: "openai",
            advancedConfig: {
                protocol: "auto",
                modelConfigs: {
                    "gpt-image-1": {
                        capability: "image",
                        protocol: "sub2api",
                        createPath: "/images/generations",
                        editPath: "/images/generations",
                        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image_urls":"{{images}}"}',
                        resultField: "data[0].url",
                    },
                },
            },
        } as never;

        expect(allowsImageProtocolFallback(modelConfig)).toBe(false);
    });

    it("uses the model-level reference capability when the channel default is disabled", () => {
        const [resolved] = sanitizeConfigs(
            { model: "image-logical" } as never,
            {
                generationDefaults: {},
                systemChannels: [
                    {
                        id: "channel-one",
                        name: "Channel one",
                        baseUrl: "https://provider.example/v1",
                        apiKey: "server-key",
                        apiFormat: "openai",
                        enabled: true,
                        models: ["vendor/image"],
                        advancedConfig: {
                            protocol: "openai",
                            supportsReferenceImage: false,
                            modelConfigs: {
                                "vendor/image": {
                                    capability: "image",
                                    protocol: "openai",
                                    apiFormat: "openai",
                                    createPath: "/images/generations",
                                    editPath: "/images/edits",
                                    supportsReferenceImage: true,
                                },
                            },
                        },
                    },
                ],
                logicalModels: [
                    {
                        id: "image-logical",
                        name: "Image logical",
                        capability: "image",
                        enabled: true,
                        bindings: [{ id: "binding-one", channelId: "channel-one", upstreamModel: "vendor/image", enabled: true, priority: 1 }],
                    },
                ],
            } as never,
        );

        expect(resolved?.advancedConfig).toMatchObject({ protocol: "openai", editPath: "/images/edits", supportsReferenceImage: true });
    });

    it("recognizes Pydantic dictionary errors as an incompatible edit payload", () => {
        const message = "Input should be a valid dictionary or object to extract fields from";

        expect(shouldFallbackToJsonImageEdit(422, message)).toBe(true);
        expect(shouldRetryJsonImageEditPayload(422, message)).toBe(true);
    });
});
