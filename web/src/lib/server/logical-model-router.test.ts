import { describe, expect, it } from "vitest";

import { resolveLogicalBillingModel, resolveLogicalModel, resolveLogicalModelCandidates, resolveLogicalModelSnapshot } from "./logical-model-router";

const channel = (id: string, models: string[], enabled = true) => ({ id, name: id, baseUrl: `https://${id}.example.com`, apiKey: "secret", apiFormat: "openai" as const, models, enabled });

describe("resolveLogicalModel", () => {
    it("deduplicates a logical model while routing to its highest priority enabled binding", () => {
        const settings = {
            systemChannels: [channel("primary", ["vendor/gpt-4o"], false), channel("backup", ["gpt-4o-proxy"])],
            logicalModels: [
                {
                    id: "gpt-4o",
                    name: "GPT-4o",
                    capability: "text" as const,
                    enabled: true,
                    bindings: [
                        { id: "one", channelId: "primary", upstreamModel: "vendor/gpt-4o", enabled: true, priority: 1 },
                        { id: "two", channelId: "backup", upstreamModel: "gpt-4o-proxy", enabled: true, priority: 2 },
                    ],
                },
            ],
        };
        expect(resolveLogicalModel(settings, "text", "gpt-4o")).toMatchObject({ logicalModelId: "gpt-4o", channelId: "backup", upstreamModel: "gpt-4o-proxy" });
    });

    it("returns all usable bindings in priority order", () => {
        const settings = {
            systemChannels: [channel("primary", ["writer-v1"]), channel("backup", ["writer-v2"])],
            logicalModels: [
                {
                    id: "writer",
                    name: "Writer",
                    capability: "text" as const,
                    enabled: true,
                    bindings: [
                        { id: "two", channelId: "backup", upstreamModel: "writer-v2", enabled: true, priority: 2 },
                        { id: "one", channelId: "primary", upstreamModel: "writer-v1", enabled: true, priority: 1 },
                    ],
                },
            ],
        };
        expect(resolveLogicalModelCandidates(settings, "text", "writer").map((item) => item.channelId)).toEqual(["primary", "backup"]);
        expect(resolveLogicalModelCandidates(settings, "text", "writer", "backup").map((item) => item.channelId)).toEqual(["backup", "primary"]);
    });

    it("uses binding weight inside the same priority and exposes capability limits", () => {
        const settings = {
            systemChannels: [channel("low", ["video-low"]), channel("high", ["video-high"])],
            logicalModels: [
                {
                    id: "video",
                    name: "Video",
                    capability: "video" as const,
                    enabled: true,
                    bindings: [
                        { id: "low", channelId: "low", upstreamModel: "video-low", enabled: true, priority: 1, weight: 10 },
                        { id: "high", channelId: "high", upstreamModel: "video-high", enabled: true, priority: 1, weight: 100, capabilityProfile: { supportsReferenceImage: true, maxReferenceImages: 2, maxDurationSeconds: 10, timeoutMs: 12 * 60_000 } },
                    ],
                },
            ],
        };

        const candidates = resolveLogicalModelCandidates(settings, "video", "video");
        expect(candidates.map((item) => item.channelId)).toEqual(["high", "low"]);
        expect(candidates[0].capabilityProfile).toMatchObject({ supportsReferenceImage: true, maxReferenceImages: 2, maxDurationSeconds: 10, timeoutMs: 12 * 60_000 });
    });

    it("does not route a logical model through a binding missing from the channel model list", () => {
        const settings = {
            systemChannels: [channel("one", ["other-model"])],
            logicalModels: [{ id: "voice", name: "Voice", capability: "audio" as const, enabled: true, bindings: [{ id: "one", channelId: "one", upstreamModel: "voice-upstream", enabled: true, priority: 1 }] }],
        };
        expect(resolveLogicalModel(settings, "audio", "voice")).toBeNull();
    });

    it("rejects raw upstream model names when a logical catalog exists", () => {
        const settings = {
            systemChannels: [channel("primary", ["vendor/writer-v2"])],
            logicalModels: [{ id: "writer", name: "Writer", capability: "text" as const, enabled: true, bindings: [{ id: "one", channelId: "primary", upstreamModel: "vendor/writer-v2", enabled: true, priority: 1 }] }],
        };
        expect(resolveLogicalModel(settings, "text", "vendor/writer-v2")).toBeNull();
        expect(resolveLogicalModel(settings, "text", "writer")).toMatchObject({ logicalModelId: "writer", upstreamModel: "vendor/writer-v2" });
    });

    it("routes SD2.0 as video while keeping full Stable Diffusion names on image", () => {
        const settings = {
            systemChannels: [channel("primary", ["sd2.0", "stable-diffusion-2.0"])],
            logicalModels: [
                { id: "sd2.0", name: "Seedance 2.0", capability: "video" as const, enabled: true, bindings: [{ id: "one", channelId: "primary", upstreamModel: "sd2.0", enabled: true, priority: 1 }] },
                { id: "stable-diffusion-2.0", name: "Stable Diffusion 2.0", capability: "image" as const, enabled: true, bindings: [{ id: "two", channelId: "primary", upstreamModel: "stable-diffusion-2.0", enabled: true, priority: 1 }] },
            ],
        };

        expect(resolveLogicalModel(settings, "video", "sd2.0")?.upstreamModel).toBe("sd2.0");
        expect(resolveLogicalModel(settings, "image", "stable-diffusion-2.0")?.upstreamModel).toBe("stable-diffusion-2.0");
        expect(resolveLogicalModel(settings, "image", "sd2.0")).toBeNull();
    });

    it("uses the logical model id as the billing key for its bound upstream model", () => {
        const logicalModels = [{ id: "writer", name: "Writer", capability: "text" as const, enabled: true, bindings: [{ id: "one", channelId: "primary", upstreamModel: "vendor/writer-v2", enabled: true, priority: 1 }] }];

        expect(resolveLogicalBillingModel(logicalModels, "text", "primary", "vendor/writer-v2")).toBe("writer");
        expect(resolveLogicalBillingModel(logicalModels, "text", "other", "vendor/writer-v2")).toBe("vendor/writer-v2");
    });

    it("uses normalized model equivalence when resolving the billing key", () => {
        const logicalModels = [{ id: "gemini", name: "Gemini", capability: "text" as const, enabled: true, bindings: [{ id: "one", channelId: "primary", upstreamModel: "models/GEMINI-2.5", enabled: true, priority: 1 }] }];

        expect(resolveLogicalBillingModel(logicalModels, "text", "primary", "gemini-2.5")).toBe("gemini");
    });

    it("honors a validated preferred logical model when bindings share an upstream alias", () => {
        const logicalModels = [
            { id: "writer-basic", name: "Basic", capability: "text" as const, enabled: true, bindings: [{ id: "one", channelId: "primary", upstreamModel: "vendor/shared", enabled: true, priority: 1 }] },
            { id: "writer-pro", name: "Pro", capability: "text" as const, enabled: true, bindings: [{ id: "two", channelId: "primary", upstreamModel: "vendor/shared", enabled: true, priority: 1 }] },
        ];

        expect(resolveLogicalBillingModel(logicalModels, "text", "primary", "vendor/shared", "writer-pro")).toBe("writer-pro");
        expect(resolveLogicalBillingModel(logicalModels, "text", "primary", "vendor/shared", "forged-model")).toBe("writer-basic");
    });

    it("resolves only the exact channel and upstream model saved in a task snapshot", () => {
        const settings = {
            systemChannels: [channel("primary", ["writer-v2"]), channel("backup", ["writer-v1"])],
            logicalModels: [
                {
                    id: "writer",
                    name: "Writer",
                    capability: "text" as const,
                    enabled: true,
                    bindings: [
                        { id: "new", channelId: "primary", upstreamModel: "writer-v2", enabled: true, priority: 1 },
                        { id: "old", channelId: "backup", upstreamModel: "writer-v1", enabled: true, priority: 2 },
                    ],
                },
            ],
        };

        expect(resolveLogicalModelSnapshot(settings, "text", { logicalModelId: "writer", channelId: "backup", upstreamModel: "writer-v1" })).toMatchObject({ channelId: "backup", upstreamModel: "writer-v1" });
        expect(resolveLogicalModelSnapshot(settings, "text", { logicalModelId: "writer", channelId: "backup", upstreamModel: "missing" })).toBeNull();
    });
});
