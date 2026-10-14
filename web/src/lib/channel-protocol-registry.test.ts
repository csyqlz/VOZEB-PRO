import { describe, expect, it } from "vitest";

import type { SystemModelChannel } from "@/lib/auth/store";
import {
    applyChannelProtocol,
    applyModelProtocol,
    channelCredentialsReady,
    channelProtocolDefinition,
    channelProtocolDefinitions,
    registeredChannelProtocolDefinitions,
    channelProtocolOptions,
    channelSupportsModelCatalog,
    channelProtocolValidationErrors,
    normalizeStrictProtocolModelConfig,
    protocolAuthHeaders,
    resolveChannelModelConfig,
} from "./channel-protocol-registry";

const channel = {
    id: "one",
    name: "测试渠道",
    baseUrl: "https://api.example.com/v1",
    apiKey: "secret",
    apiFormat: "openai",
    models: ["image-one"],
    enabled: false,
} satisfies SystemModelChannel;

describe("channel protocol registry", () => {
    it("exposes only active protocols and keeps SD2 separate from Stable Diffusion", () => {
        const protocols = channelProtocolOptions().map((item) => item.value);
        expect(protocols).toEqual(["openai", "yumeng", "gemini", "seedance", "stable-diffusion", "volcengine-video", "sub2api", "newapi", "custom", "compatible", "auto"]);
        expect(protocols).not.toEqual(expect.arrayContaining(["vozeb-recommended", "seedance-special", "globalaiopc"]));
        expect(channelProtocolDefinition("openai").modelCatalogPaths).toEqual(["/v1/models"]);
        expect(channelProtocolDefinition("sub2api").modelCatalogPaths).toEqual(["/v1/models"]);
        expect(channelProtocolDefinition("newapi").modelCatalogPaths).toEqual(["/v1/models"]);
        expect(channelProtocolDefinition("seedance").modelCatalogPaths).toEqual(["/models"]);
        expect(channelProtocolDefinition("volcengine-video").modelCatalogPaths).toEqual(["/api/v3/models"]);
        expect(channelProtocolDefinition("stable-diffusion").modelCatalogPaths).toEqual(["/sdapi/v1/sd-models"]);
        expect(channelProtocolDefinition("gemini").modelCatalogPaths).toEqual(["/v1beta/models"]);
        expect(channelProtocolDefinition("yumeng")).toMatchObject({
            label: "昱梦",
            defaultBaseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer",
            modelCatalogPaths: [],
            capabilities: ["image", "video"],
            builtInModels: expect.any(Array),
        });
        expect(channelProtocolDefinition("yumeng").builtInModels).toHaveLength(26);
    });

    it("keeps strict protocol paths and request contracts isolated", () => {
        expect(channelProtocolDefinition("openai").operations).toMatchObject({
            text: { createPath: "/chat/completions" },
            image: { createPath: "/images/generations", editPath: "/images/edits" },
            video: { createPath: "/videos", queryPath: "/videos/:task_id", requestTemplate: expect.stringContaining("multipart/form-data") },
            audio: { createPath: "/audio/speech" },
        });
        expect(channelProtocolDefinition("sub2api").operations.image).toMatchObject({ createPath: "/images/generations", editPath: "/images/generations", requestTemplate: expect.stringContaining("image_urls") });
        expect(channelProtocolDefinition("newapi").operations).toMatchObject({
            ...channelProtocolDefinition("openai").operations,
            video: { supportsReferenceImage: true, supportsReferenceVideo: true, supportsReferenceAudio: true, referenceRule: expect.stringContaining("JSON content") },
        });
        expect(channelProtocolDefinition("seedance").operations.video).toMatchObject({ createPath: "/contents/generations/tasks", queryPath: "/contents/generations/tasks/:task_id", resultField: "content.video_url" });
        expect(channelProtocolDefinition("volcengine-video").operations.video).toEqual(channelProtocolDefinition("seedance").operations.video);
        expect(channelProtocolDefinition("stable-diffusion").operations.image).toMatchObject({ createPath: "/sdapi/v1/txt2img", editPath: "/sdapi/v1/img2img", resultField: "images[0]" });
        expect(channelProtocolDefinition("yumeng").operations).toMatchObject({
            image: { createPath: "/kyyReactApiServer/v2/model-center/tasks", queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id", resultField: "result_url / image_url", supportsReferenceImage: true },
            video: {
                createPath: "/kyyReactApiServer/v2/model-center/tasks",
                queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id",
                resultField: "result_url / video_url",
                supportsReferenceImage: true,
                supportsReferenceVideo: true,
                supportsReferenceAudio: true,
            },
        });
        expect(channelProtocolDefinition("seedance-special").operations.video).toMatchObject({ createPath: "/v1/seedance-special/videos", queryPath: "/v1/result/:task_id" });
        expect(channelProtocolDefinition("vozeb-recommended").operations.video).toMatchObject({
            createPath: "/v1/videos/generations",
            imageToVideoPath: "/v1/videos/generations",
            queryPath: "/v1/videos/generations/:task_id",
            resultField: "metadata.url",
            statusField: "status",
        });
        expect(channelProtocolDefinition("gemini").operations.video).toMatchObject({
            createPath: "/models/:model:predictLongRunning",
            imageToVideoPath: "/models/:model:predictLongRunning",
            queryPath: "/models/:model/operations/:task_id",
            resultField: "response.generateVideoResponse.generatedSamples[0].video.uri",
            statusField: "done",
        });
    });

    it("keeps every strict capability executable and every asynchronous video query explicit", () => {
        const strict = registeredChannelProtocolDefinitions.filter((definition) => definition.strict);

        for (const definition of strict) {
            expect(Object.keys(definition.operations).sort(), definition.id).toEqual([...definition.capabilities].sort());
            for (const capability of definition.capabilities) {
                const operation = definition.operations[capability];
                expect(operation?.createPath, `${definition.id}:${capability}`).toMatch(/^\//);
                expect(operation?.resultField, `${definition.id}:${capability}`).toBeTruthy();
                if (capability === "video") expect(operation?.queryPath, `${definition.id}:${capability}`).toMatch(/^\//);
            }
        }
    });

    it("applies the VOZEB recommended preset to frontend channel drafts", () => {
        const configured = applyChannelProtocol({ ...channel, baseUrl: "", models: ["Seedance 2.0-fast-720p"] }, "vozeb-recommended");

        expect(configured).toMatchObject({ baseUrl: "https://new.aiym.ink/v1", apiFormat: "openai" });
        expect(configured.advancedConfig).toMatchObject({
            protocol: "vozeb-recommended",
            createPath: "/v1/videos/generations",
            queryPath: "/v1/videos/generations/:task_id",
            modelCatalogPaths: ["/v1/models"],
        });
        expect(configured.advancedConfig?.modelCapabilities?.["seedance 2.0-fast-720p"]).toBe("video");
        expect(channelProtocolValidationErrors(configured)).toEqual([]);
    });

    it("applies independent image edit and image-to-video paths", () => {
        expect(applyModelProtocol({ capability: "image" }, "openai")).toMatchObject({ createPath: "/images/generations", editPath: "/images/edits" });
        expect(applyModelProtocol({ capability: "video" }, "seedance")).toMatchObject({ createPath: "/contents/generations/tasks", imageToVideoPath: "/contents/generations/tasks" });
        expect(applyModelProtocol({ capability: "video" }, "volcengine-video")).toMatchObject({ createPath: "/contents/generations/tasks", queryPath: "/contents/generations/tasks/:task_id" });
        expect(applyModelProtocol({ capability: "image" }, "stable-diffusion")).toMatchObject({ createPath: "/sdapi/v1/txt2img", editPath: "/sdapi/v1/img2img", resultField: "images[0]" });
    });

    it("classifies opaque models from strict single-capability protocol catalogs", () => {
        expect(applyChannelProtocol({ ...channel, models: ["opaque"] }, "seedance").advancedConfig?.modelCapabilities?.opaque).toBe("video");
        expect(applyChannelProtocol({ ...channel, models: ["opaque"] }, "stable-diffusion").advancedConfig?.modelCapabilities?.opaque).toBe("image");
    });

    it("supports keyless Stable Diffusion channels without an authorization header", () => {
        const configured = applyChannelProtocol({ ...channel, apiKey: "", hasApiKey: false }, "stable-diffusion");
        expect(configured.advancedConfig?.authMode).toBe("none");
        expect(channelCredentialsReady(configured)).toBe(true);
        expect(protocolAuthHeaders("", configured.advancedConfig)).toEqual({});
    });

    it("uses the Gemini API key header for the explicit Gemini protocol", () => {
        const configured = applyChannelProtocol({ ...channel, baseUrl: "", models: ["veo-3.1-generate-preview"] }, "gemini");

        expect(configured.baseUrl).toBe("https://generativelanguage.googleapis.com");
        expect(configured.apiFormat).toBe("gemini");
        expect(configured.advancedConfig?.modelConfigs?.["veo-3.1-generate-preview"]).toMatchObject({ protocol: "gemini", apiFormat: "gemini", capability: "video" });
        expect(protocolAuthHeaders("secret", configured.advancedConfig, "gemini")).toEqual({ "x-goog-api-key": "secret" });
    });

    it("preserves an administrator-configured Base URL when selecting a protocol", () => {
        expect(applyChannelProtocol(channel, "gemini").baseUrl).toBe(channel.baseUrl);
        expect(applyChannelProtocol(channel, "vozeb-recommended").baseUrl).toBe(channel.baseUrl);
        expect(applyChannelProtocol(channel, "yumeng").baseUrl).toBe(channel.baseUrl);
    });

    it("applies only the documented Yumeng v2 model-center contract", () => {
        const configured = applyChannelProtocol({ ...channel, baseUrl: "", models: [] }, "yumeng");

        expect(configured.baseUrl).toBe("https://zcbservice.aizfw.cn/kyyReactApiServer");
        expect(configured.models).toHaveLength(26);
        expect(configured.models).toContain("seedream_5.0Pro");
        expect(configured.models).toContain("KlingO3");
        expect(configured.models).toContain("seedance-2.5-c1");
        expect(configured.models).toContain("videos_933_c1");
        expect(configured.models).not.toContain("seedance-2.5-c2");
        expect(configured.models).not.toContain("videos_stable");
        expect(configured.advancedConfig?.modelConfigs).toMatchObject({
            "seedream_5.0pro": { capability: "image", protocol: "yumeng", createPath: "/kyyReactApiServer/v2/model-center/tasks" },
            klingo3: { capability: "video", protocol: "yumeng", createPath: "/kyyReactApiServer/v2/model-center/tasks" },
            "sd_2.0_fast_special": { capability: "video", protocol: "yumeng", durationRange: "4-15 秒", supportsReferenceVideo: true, requestTemplate: expect.stringContaining("first_image") },
            "seedance-2.5-c1": { capability: "video", protocol: "yumeng", durationRange: "4-30 秒", supportsReferenceVideo: true },
            videos_933_c1: { capability: "video", protocol: "yumeng", durationRange: "4-15 秒", supportsReferenceVideo: true, requestTemplate: expect.stringContaining("reference_mode") },
        });
        expect(configured.advancedConfig?.operationConfigs).toMatchObject({
            image: { protocol: "yumeng", capability: "image", createPath: "/kyyReactApiServer/v2/model-center/tasks", queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id" },
            video: { protocol: "yumeng", capability: "video", createPath: "/kyyReactApiServer/v2/model-center/tasks", queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id", supportsReferenceVideo: true },
        });
        for (const model of configured.models) {
            expect(configured.advancedConfig?.modelConfigs?.[model.toLowerCase()]).toMatchObject({
                protocol: "yumeng",
                createPath: "/kyyReactApiServer/v2/model-center/tasks",
                queryPath: "/kyyReactApiServer/v2/model-center/tasks/:task_id",
            });
        }
        expect(protocolAuthHeaders("secret", configured.advancedConfig)).toEqual({ authorization: "Bearer secret" });
        expect(channelSupportsModelCatalog(configured)).toBe(false);
        expect(channelSupportsModelCatalog(applyChannelProtocol(channel, "openai"))).toBe(true);
        expect(channelSupportsModelCatalog({ advancedConfig: { ...configured.advancedConfig!, modelCatalogPaths: ["/v2/model-center/models"] } })).toBe(true);
    });

    it("repairs the retired Yumeng portal host without changing custom provider hosts", () => {
        expect(applyChannelProtocol({ ...channel, baseUrl: "http://token.myairealm.com/" }, "yumeng").baseUrl).toBe("https://zcbservice.aizfw.cn/kyyReactApiServer");
        expect(applyChannelProtocol({ ...channel, baseUrl: "https://yumeng.example.com/kyyReactApiServer" }, "yumeng").baseUrl).toBe("https://yumeng.example.com/kyyReactApiServer");
    });

    it("loads the documented Seedance special models and rejects preset tampering", () => {
        const configured = applyChannelProtocol(channel, "seedance-special");
        expect(configured.models).toHaveLength(10);
        expect(channelProtocolValidationErrors(configured)).toEqual([]);
        const model = configured.models[0];
        const key = model.toLowerCase();
        const tampered = {
            ...configured,
            advancedConfig: {
                ...configured.advancedConfig!,
                modelConfigs: { ...configured.advancedConfig!.modelConfigs, [key]: { ...configured.advancedConfig!.modelConfigs![key], imageToVideoPath: "/wrong" } },
            },
        };
        expect(channelProtocolValidationErrors(tampered)).toContain(`${model} 的图生视频路径必须为 /v1/seedance-special/videos`);
    });

    it("allows a model-level Seedance route inside an OpenAI channel", () => {
        const configured = applyChannelProtocol({ ...channel, models: ["writer", "sd2.0"] }, "openai");
        const mixed = {
            ...configured,
            advancedConfig: {
                ...configured.advancedConfig!,
                modelConfigs: {
                    ...configured.advancedConfig!.modelConfigs,
                    "sd2.0": applyModelProtocol({ capability: "video" }, "seedance"),
                },
                modelCapabilities: { ...configured.advancedConfig!.modelCapabilities, "sd2.0": "video" as const },
            },
        };
        expect(channelProtocolValidationErrors(mixed)).toEqual([]);
    });

    it("restores strict model presets after catalog or health detection", () => {
        const configured = applyChannelProtocol({ ...channel, models: ["gpt-image-2"] }, "openai");
        const key = "gpt-image-2";
        configured.advancedConfig!.modelConfigs![key] = normalizeStrictProtocolModelConfig(
            {
                capability: "image",
                source: "health",
                protocol: "openai",
                createPath: "/images/generations",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","response_format":"url"}',
            },
            "openai",
        );

        expect(configured.advancedConfig!.modelConfigs![key]).toEqual(applyModelProtocol({ capability: "image" }, "openai"));
        expect(channelProtocolValidationErrors(configured)).toEqual([]);
    });

    it("rejects unsafe custom authentication header names", () => {
        const configured = applyChannelProtocol(channel, "custom");
        configured.advancedConfig = { ...configured.advancedConfig!, authMode: "custom-header", authHeader: "Cookie" };
        expect(channelProtocolValidationErrors(configured)).toContain("测试渠道 的自定义鉴权请求头名称无效");
    });

    it("falls back to the capability operation when a model has no dedicated config", () => {
        expect(
            resolveChannelModelConfig(
                {
                    ...applyChannelProtocol(channel, "custom").advancedConfig!,
                    modelCapabilities: { opaque: "video" },
                    operationConfigs: { video: { capability: "video", protocol: "custom", createPath: "/jobs" } },
                },
                "opaque",
            ),
        ).toMatchObject({ capability: "video", protocol: "custom", createPath: "/jobs" });
    });
});
