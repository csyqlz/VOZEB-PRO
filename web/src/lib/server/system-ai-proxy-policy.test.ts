import { describe, expect, it } from "vitest";

import { authorizeSystemAiProxyRequest } from "./system-ai-proxy-policy";

const logicalModels = [
    {
        id: "writer",
        name: "写作",
        capability: "text" as const,
        enabled: true,
        bindings: [{ id: "writer-main", channelId: "main", upstreamModel: "vendor-text", enabled: true, priority: 1 }],
    },
    {
        id: "video-pro",
        name: "视频",
        capability: "video" as const,
        enabled: true,
        bindings: [{ id: "video-main", channelId: "main", upstreamModel: "vendor-video", enabled: true, priority: 1 }],
    },
];

describe("system AI proxy policy", () => {
    it("allows a billed create path for the bound logical model", () => {
        expect(
            authorizeSystemAiProxyRequest({
                method: "POST",
                path: ["chat", "completions"],
                search: "",
                channelId: "main",
                upstreamModel: "vendor-text",
                preferredLogicalModelId: "writer",
                logicalModels,
                apiFormat: "openai",
                pointsUsageKind: "text",
            }),
        ).toMatchObject({ allowed: true, logicalModelId: "writer", operation: "create" });
    });

    it("authorizes Gemini Veo creation and operation polling paths", () => {
        const base = {
            channelId: "main",
            upstreamModel: "veo-3.1-generate-preview",
            preferredLogicalModelId: "video-pro",
            logicalModels: [
                ...logicalModels,
                {
                    id: "video-pro",
                    name: "Gemini 视频",
                    capability: "video" as const,
                    enabled: true,
                    bindings: [{ id: "gemini-video", channelId: "main", upstreamModel: "veo-3.1-generate-preview", enabled: true, priority: 1 }],
                },
            ],
            apiFormat: "gemini" as const,
        };

        expect(
            authorizeSystemAiProxyRequest({
                ...base,
                method: "POST",
                path: ["models", "veo-3.1-generate-preview:predictLongRunning"],
                search: "",
                pointsUsageKind: "video",
            }),
        ).toMatchObject({ allowed: true, operation: "create", logicalModelId: "video-pro" });
        expect(
            authorizeSystemAiProxyRequest({
                ...base,
                method: "GET",
                path: ["models", "veo-3.1-generate-preview", "operations", "operation-one"],
                search: "",
                upstreamTaskIdHint: "operation-one",
            }),
        ).toMatchObject({ allowed: true, operation: "query", upstreamTaskId: "operation-one" });
    });

    it("authorizes native Gemini image resolution aliases against the base model binding", () => {
        expect(
            authorizeSystemAiProxyRequest({
                method: "POST",
                path: ["v1", "models", "gemini-3.1-flash-image-4k-16x9:generateContent"],
                search: "",
                channelId: "main",
                upstreamModel: "gemini-3.1-flash-image",
                preferredLogicalModelId: "gemini-image",
                logicalModels: [
                    {
                        id: "gemini-image",
                        name: "Gemini 图片",
                        capability: "image" as const,
                        enabled: true,
                        bindings: [{ id: "gemini-image-main", channelId: "main", upstreamModel: "gemini-3.1-flash-image", enabled: true, priority: 1 }],
                    },
                ],
                apiFormat: "gemini",
                pointsUsageKind: "image",
                paths: { create: ["/v1/models/gemini-3.1-flash-image:generateContent"] },
            }),
        ).toMatchObject({ allowed: true, logicalModelId: "gemini-image", operation: "create" });
    });

    it("rejects unbound models, unknown paths, and unbilled create requests", () => {
        const base = { method: "POST", search: "", channelId: "main", preferredLogicalModelId: "", logicalModels, apiFormat: "openai" as const };
        expect(authorizeSystemAiProxyRequest({ ...base, path: ["chat", "completions"], upstreamModel: "unknown", pointsUsageKind: "text" })).toMatchObject({ allowed: false, status: 403 });
        expect(authorizeSystemAiProxyRequest({ ...base, path: ["account", "balance"], upstreamModel: "vendor-text", pointsUsageKind: "text" })).toMatchObject({ allowed: false, status: 404 });
        expect(authorizeSystemAiProxyRequest({ ...base, path: ["chat", "completions"], upstreamModel: "vendor-text" })).toMatchObject({ allowed: false, status: 400 });
    });

    it("allows only configured query and cancel task paths", () => {
        const base = {
            channelId: "main",
            upstreamModel: "vendor-video",
            preferredLogicalModelId: "video-pro",
            logicalModels,
            apiFormat: "openai" as const,
            paths: { create: ["/jobs/video"], query: ["/jobs/video/:task_id"], cancel: [{ path: "/jobs/video/:task_id/cancel", method: "POST" }] },
        };
        expect(authorizeSystemAiProxyRequest({ ...base, method: "GET", path: ["jobs", "video", "task-one"], search: "" })).toMatchObject({ allowed: true, operation: "query", upstreamTaskId: "task-one" });
        expect(authorizeSystemAiProxyRequest({ ...base, method: "POST", path: ["jobs", "video", "task-one", "cancel"], search: "" })).toMatchObject({ allowed: true, operation: "cancel", upstreamTaskId: "task-one" });
        expect(authorizeSystemAiProxyRequest({ ...base, method: "GET", path: ["jobs", "other", "task-one"], search: "" })).toMatchObject({ allowed: false, status: 404 });
    });

    it("extracts task ids from query strings and rejects conflicting hints", () => {
        const base = {
            channelId: "main",
            upstreamModel: "vendor-video",
            preferredLogicalModelId: "video-pro",
            logicalModels,
            apiFormat: "openai" as const,
            paths: { query: ["/result?id=:task_id"], cancel: [{ path: "/jobs/cancel", method: "POST" }] },
        };
        expect(authorizeSystemAiProxyRequest({ ...base, method: "GET", path: ["result"], search: "?id=task%20one" })).toMatchObject({ allowed: true, operation: "query", upstreamTaskId: "task one" });
        expect(authorizeSystemAiProxyRequest({ ...base, method: "POST", path: ["jobs", "cancel"], search: "", upstreamTaskIdHint: "task-two" })).toMatchObject({ allowed: true, operation: "cancel", upstreamTaskId: "task-two" });
        expect(authorizeSystemAiProxyRequest({ ...base, method: "GET", path: ["result"], search: "?id=task-one", upstreamTaskIdHint: "task-two" })).toMatchObject({ allowed: false, status: 400 });
    });

    it("rejects unsupported methods and mismatched logical capabilities", () => {
        expect(
            authorizeSystemAiProxyRequest({
                method: "PUT",
                path: ["chat", "completions"],
                search: "",
                channelId: "main",
                upstreamModel: "vendor-text",
                logicalModels,
                apiFormat: "openai",
                pointsUsageKind: "text",
            }),
        ).toMatchObject({ allowed: false, status: 405 });
        expect(
            authorizeSystemAiProxyRequest({
                method: "POST",
                path: ["responses"],
                search: "",
                channelId: "main",
                upstreamModel: "vendor-text",
                logicalModels,
                apiFormat: "openai",
                pointsUsageKind: "image",
            }),
        ).toMatchObject({ allowed: false, status: 403 });
    });
});
