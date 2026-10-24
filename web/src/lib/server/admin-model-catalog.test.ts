import { describe, expect, it } from "vitest";

import {
    buildModelCatalogUrls,
    buildModelsUrl,
    configuredModelCatalog,
    isModelCatalogUnsupported,
    mergeModelCatalogEntries,
    mergeModelConfigs,
    modelCapabilitiesRecord,
    nextModelsPageUrl,
    officialModelCatalog,
    parseModelCatalog,
    parseModelConfigs,
    parseModels,
} from "./admin-model-catalog";

describe("admin model catalog", () => {
    it("keeps only Gemini and Veo models from the shared DataEyes directory", () => {
        const payload = { data: [{ id: "gpt-4.1" }, { id: "gemini-2.5-flash" }, { id: "gemini-3-pro-image" }, { id: "gemini-3.1-flash-tts-preview" }, { id: "veo-3.1-generate-preview" }] };
        expect(parseModelCatalog(payload, "provider", "dataeyes-gemini").map((item) => [item.id, item.capability])).toEqual([
            ["gemini-2.5-flash", "text"],
            ["gemini-3-pro-image", "image"],
            ["gemini-3.1-flash-tts-preview", "audio"],
            ["veo-3.1-generate-preview", "video"],
        ]);
        expect(Object.keys(parseModelConfigs(payload, "dataeyes-gemini"))).not.toContain("gpt-4.1");
    });
    it("keeps only FLUX images from the shared DataEyes directory", () => {
        const payload = { data: [{ id: "flux-2-pro" }, { id: "flux-kontext-max" }, { id: "gpt-image-1" }, { id: "kling-v3" }] };
        expect(parseModelCatalog(payload, "provider", "dataeyes-flux").map((item) => [item.id, item.capability])).toEqual([
            ["flux-2-pro", "image"],
            ["flux-kontext-max", "image"],
        ]);
        expect(Object.keys(parseModelConfigs(payload, "dataeyes-flux"))).toEqual(["flux-2-pro", "flux-kontext-max"]);
    });

    it("keeps Seedream images even when DataEyes labels their endpoint openai", () => {
        const payload = { data: [{ id: "ByteDance-Seedream-5.0-pro", supported_endpoint_types: ["openai"] }, { id: "doubao-seedream-4-5-251128" }, { id: "gpt-4.1" }] };
        expect(parseModelCatalog(payload, "provider", "dataeyes-seedream").map((item) => [item.id, item.capability])).toEqual([
            ["ByteDance-Seedream-5.0-pro", "image"],
            ["doubao-seedream-4-5-251128", "image"],
        ]);
        expect(Object.keys(parseModelConfigs(payload, "dataeyes-seedream"))).toEqual(["bytedance-seedream-5.0-pro", "doubao-seedream-4-5-251128"]);
    });

    it("builds OpenAI and Gemini model URLs", () => {
        expect(buildModelsUrl("https://api.example.com/v1", "openai")).toBe("https://api.example.com/v1/models");
        expect(buildModelsUrl("https://generativelanguage.googleapis.com/v1beta", "gemini")).toBe("https://generativelanguage.googleapis.com/v1beta/models");
        expect(buildModelsUrl("https://api.example.com/v1/models", "openai")).toBe("https://api.example.com/v1/models");
        expect(buildModelsUrl("https://api.example.com/v1/chat/completions", "openai")).toBe("https://api.example.com/v1/models");
        expect(buildModelCatalogUrls("https://api.example.com/v1", "openai", ["/v1/text-models", "/v1/video-models"])).toEqual(["https://api.example.com/v1/text-models", "https://api.example.com/v1/video-models"]);
    });

    it("parses common and nested provider response shapes", () => {
        expect(parseModels({ data: [{ id: "gpt-test" }], models: [{ name: "models/gemini-test" }], result: { items: [{ model: "video-test" }] } })).toEqual(["gemini-test", "gpt-test", "video-test"]);
        expect(parseModels({ data: { id: "response-wrapper", models: [{ id: "nested-model" }] } })).toEqual(["nested-model"]);
        expect(parseModels({ data: [] })).toEqual([]);
        expect(parseModelCatalog({ data: { text: ["writer-v2"], image_models: ["image-v2"], video: [{ id: "sd2.0" }] } })).toEqual([
            { id: "image-v2", capability: "image", source: "provider" },
            { id: "sd2.0", capability: "video", source: "provider" },
            { id: "writer-v2", capability: "text", source: "provider" },
        ]);
    });

    it("preserves provider capability metadata and prioritizes video names over Stable Diffusion image hints", () => {
        expect(
            parseModelCatalog({
                data: [{ id: "writer-v1", modalities: ["text"] }, { id: "photo-v1", endpoint: "/images/generations" }, { id: "stable-video-diffusion" }],
            }),
        ).toEqual([
            { id: "photo-v1", capability: "image", source: "provider" },
            { id: "stable-video-diffusion", capability: "video", source: "provider" },
            { id: "writer-v1", capability: "text", source: "provider" },
        ]);
    });

    it("uses the Sub2API catalog shape and falls back to known media model names only when metadata is absent", () => {
        expect(
            parseModelCatalog(
                {
                    object: "list",
                    data: [
                        { id: "gemini-3.1-flash-image-preview", object: "model" },
                        { id: "nano-banana-2", object: "model" },
                    ],
                },
                "provider",
                "sub2api",
            ),
        ).toEqual([
            { id: "gemini-3.1-flash-image-preview", capability: "image", source: "provider" },
            { id: "nano-banana-2", capability: "image", source: "provider" },
        ]);
    });

    it("uses New API catalog endpoint metadata before model-name fallback", () => {
        expect(
            parseModelCatalog(
                {
                    data: [
                        { id: "opaque-newapi-image", supported_endpoint_types: ["openai", "image-generation"] },
                        { id: "opaque-newapi-video", supported_endpoint_types: ["openai-video"] },
                        { id: "image-named-text-model", capability: "text" },
                    ],
                },
                "provider",
                "newapi",
            ),
        ).toEqual([
            { id: "image-named-text-model", capability: "text", source: "provider" },
            { id: "opaque-newapi-image", capability: "image", source: "provider" },
            { id: "opaque-newapi-video", capability: "video", source: "provider" },
        ]);
    });

    it("uses a single-capability protocol catalog before model-name inference", () => {
        const payload = { data: [{ id: "opaque-model", object: "model" }] };

        expect(parseModelCatalog(payload, "provider", "seedance")).toEqual([{ id: "opaque-model", capability: "video", source: "provider" }]);
        expect(parseModelCatalog(payload, "provider", "vozeb-recommended")).toEqual([{ id: "opaque-model", capability: "video", source: "provider" }]);
        expect(parseModelCatalog(payload, "provider", "stable-diffusion")).toEqual([{ id: "opaque-model", capability: "image", source: "provider" }]);
        expect(parseModelCatalog(payload, "provider", "openai")).toEqual([{ id: "opaque-model", capability: "text", source: "provider" }]);
        expect(parseModelConfigs(payload, "seedance")["opaque-model"]).toMatchObject({ capability: "video", source: "provider" });
    });

    it("keeps per-model endpoints when a company catalog mixes OpenAI and SD2.0", () => {
        expect(
            parseModelConfigs({
                data: [
                    { id: "openai-text", capability: "text", api_format: "openai", endpoint: "/chat/completions" },
                    { id: "sd2.0", capability: "video", protocol: "seedance", endpoint: "/videos", query_path: "/videos/:task_id" },
                ],
            }),
        ).toEqual({
            "openai-text": { capability: "text", source: "provider", apiFormat: "openai", createPath: "/chat/completions" },
            "sd2.0": { capability: "video", source: "provider", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
        });
    });

    it("combines root capability groups with nested model maps without dropping any company models", () => {
        const payload = {
            text_models: [{ id: "openai-text", api_format: "openai-compatible", route: "/chat/completions" }],
            models: {
                "opaque-image": { output_modalities: ["image"], endpoint: "/images/generations" },
                "sd2.0": { capabilities: ["video"], protocol: "seedance", path: "/videos", task_endpoint: "/videos/:task_id" },
            },
        };

        expect(parseModelCatalog(payload)).toEqual([
            { id: "opaque-image", capability: "image", source: "provider" },
            { id: "openai-text", capability: "text", source: "provider" },
            { id: "sd2.0", capability: "video", source: "provider" },
        ]);
        expect(parseModelConfigs(payload)).toMatchObject({
            "opaque-image": { capability: "image", createPath: "/images/generations" },
            "openai-text": { capability: "text", apiFormat: "openai", createPath: "/chat/completions" },
            "sd2.0": { capability: "video", protocol: "seedance", createPath: "/videos", queryPath: "/videos/:task_id" },
        });
    });

    it("reads capability maps and common provider method metadata", () => {
        expect(parseModelCatalog({ data: { "writer-v3": "text", "video-v3": "video" } })).toEqual([
            { id: "video-v3", capability: "video", source: "provider" },
            { id: "writer-v3", capability: "text", source: "provider" },
        ]);
        expect(parseModelCatalog({ data: [{ id: "opaque-writer", supported_generation_methods: ["generateContent"] }] })).toEqual([{ id: "opaque-writer", capability: "text", source: "provider" }]);
    });

    it("excludes non-creative discovery models while keeping text-to-speech models", () => {
        const payload = {
            data: [
                { id: "gpt-4.1" },
                { id: "text-embedding-3-small" },
                { id: "bge-reranker-v2-m3" },
                { id: "dots.ocr" },
                { id: "gcp-speech-to-text", capability: "audio" },
                { id: "whisper-1", capability: "audio" },
                { id: "omni-moderation-latest" },
                { id: "llama-3.1-nemoguard-8b-topic-control" },
                { id: "tts-1", capability: "audio" },
                { id: "gcp-text-to-speech", capability: "audio" },
            ],
        };

        expect(parseModelCatalog(payload)).toEqual([
            { id: "gcp-text-to-speech", capability: "audio", source: "provider" },
            { id: "gpt-4.1", capability: "text", source: "provider" },
            { id: "tts-1", capability: "audio", source: "provider" },
        ]);
        expect(Object.keys(parseModelConfigs(payload)).sort()).toEqual(["gcp-text-to-speech", "gpt-4.1", "tts-1"]);
    });

    it("preserves an explicitly manual model when merging a saved catalog", () => {
        expect(configuredModelCatalog(["whisper-1", "text-embedding-3-small"], { "whisper-1": "audio" }, { "whisper-1": { capability: "audio", source: "manual" } })).toEqual([{ id: "whisper-1", capability: "audio", source: "configured" }]);
    });

    it("does not overwrite an administrator's manual model route during discovery", () => {
        const catalog = [{ id: "vendor-model", capability: "video" as const, source: "provider" as const }];
        const configs = mergeModelConfigs(
            catalog,
            { "vendor-model": { capability: "image", source: "manual", protocol: "compatible", createPath: "/custom/images" } },
            { "vendor-model": { capability: "video", source: "provider", protocol: "seedance", createPath: "/videos" } },
        );

        expect(configs["vendor-model"]).toEqual({ capability: "image", source: "manual", protocol: "compatible", createPath: "/custom/images" });
        expect(modelCapabilitiesRecord(catalog, configs)).toEqual({ "vendor-model": "image" });
    });

    it("builds Gemini token and OpenAI cursor pagination URLs", () => {
        expect(nextModelsPageUrl("https://api.example.com/v1beta/models", { nextPageToken: "page two" }, "gemini", "gemini-one")).toBe("https://api.example.com/v1beta/models?pageToken=page+two");
        expect(nextModelsPageUrl("https://api.example.com/v1/models?limit=100", { has_more: true, last_id: "model-one" }, "openai", "model-one")).toBe("https://api.example.com/v1/models?limit=100&after=model-one");
        expect(nextModelsPageUrl("https://api.example.com/v1/models", { has_more: false }, "openai", "model-one")).toBe("");
        expect(nextModelsPageUrl("https://api.example.com/v1/models", { links: { next: "/v1/models?page=2" } }, "openai", "model-one")).toBe("https://api.example.com/v1/models?page=2");
    });

    it("merges configured, provider, and Agnes official catalogs without dropping models", () => {
        const merged = mergeModelCatalogEntries([{ id: "manual-text", capability: "text", source: "configured" }], [{ id: "agnes-video-v2.0", capability: "image", source: "provider" }], officialModelCatalog("https://apihub.agnes-ai.com/v1"));

        expect(merged).toEqual(
            expect.arrayContaining([
                { id: "manual-text", capability: "text", source: "configured" },
                { id: "agnes-2.0-flash", capability: "text", source: "official" },
                { id: "agnes-image-2.1-flash", capability: "image", source: "official" },
                { id: "agnes-video-v2.0", capability: "video", source: "official" },
            ]),
        );
    });

    it("recognizes provider routes that do not expose a model catalog", () => {
        expect(isModelCatalogUnsupported(404, { message: "No handler found for GET /kyyReactApiServer/v1/models" })).toBe(true);
        expect(isModelCatalogUnsupported(404, { message: "No handler found for GET /kyyReactApiServer/v1/videos/videos" })).toBe(false);
        expect(isModelCatalogUnsupported(401, { message: "No handler found for GET /v1/models" })).toBe(false);
    });
});
