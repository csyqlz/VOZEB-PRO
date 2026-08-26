import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";

vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));

import { createProtocolFixtureServer } from "../../../../scripts/protocol-fixture-server.mjs";
import { runGeminiImageTask } from "./image-task-gemini";
import { buildJsonImageEditBodies, buildResponsesImageBodies, runOpenAiImageTask, runOpenAiJsonImageEditTask, runOpenAiResponsesImageTask } from "./image-task-openai";
import { runCustomImageTask } from "./image-task-custom";
import type { ImageTask } from "@/lib/server/image-task-store";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

beforeEach(() => {
    vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
    vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
});

describe("OpenAI image provider over a live compatible fixture", () => {
    it("parses a valid PNG returned over TCP", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task: ImageTask = {
            id: "image-live",
            userId: "user-live",
            username: "user",
            displayName: "User",
            kind: "generation",
            source: "image-workbench",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            config: { baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", model: "mock-image", channelId: "fixture-image" },
            candidateConfigs: [],
            prompt: "create a blue protocol test image",
            references: [],
        };

        try {
            await expect(runOpenAiImageTask(task, "http://internal", "http://public", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,iVBOR/) });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/images/generations" });
            expect(fixture.requests[0]?.headers.authorization).toBe("Bearer fixture-key");
            expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ model: "mock-image", response_format: "url" });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("uses the selected GlobalAiOpc image preset once and polls its declared result path", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = "http://127.0.0.1:" + address.port;
        const task: ImageTask = {
            id: "image-global-live",
            userId: "user-live",
            username: "user",
            displayName: "User",
            kind: "generation",
            source: "image-workbench",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-2",
                channelId: "fixture-global-image",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "globalaiopc", globalAiOpcPreset: "image-gpt-image-2", createPath: "/image2/images", queryPath: "/result/:task_id" },
            },
            candidateConfigs: [],
            prompt: "create a blue protocol test image",
            references: [],
        };

        try {
            const submitted = await runOpenAiImageTask(task, "http://internal", "http://public", "", true);
            expect(submitted.pending).toMatchObject({ id: expect.stringMatching(/^fixture-image-/) });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/image2/images" });
            expect(fixture.requests[0]?.headers.authorization).toBe("Bearer fixture-key");
            expect(fixture.requests[0]?.headers["idempotency-key"]).toBe("image-task:image-global-live:attempt:1");
            const body = JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}");
            expect(body).toMatchObject({ model: "gpt-image-2", prompt: "create a blue protocol test image" });
            expect(body).not.toHaveProperty("ratio");
            expect(body).not.toHaveProperty("resolution");

            const { pollOpenAiImageTask } = await import("./image-task-support");
            const result = await pollOpenAiImageTask(task.config, submitted.pending!.id, origin, origin, "", "", true);
            expect(result.dataUrl).toMatch(/(?:^data:image\/png;base64,|\/media\/fixture\.png$)/);
            expect(fixture.requests.map((request) => request.path)).toEqual(["/v1/image2/images", "/v1/result/" + submitted.pending!.id]);
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("sends sub2api edits as one JSON request with an image_urls string array", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = "http://127.0.0.1:" + address.port;
        const task = liveImageTask(origin, {
            id: "image-sub2api-live",
            kind: "edit",
            references: [{ type: "image/png", dataUrl: "https://cdn.example.com/reference.png" }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-sub2api",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api", createPath: "/images/generations", editPath: "/images/generations", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runOpenAiImageTask(task, "", "", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]?.path).toBe("/v1/images/generations");
            const body = JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}");
            expect(body.image_urls).toEqual(["https://cdn.example.com/reference.png"]);
            expect(body.images).toBeUndefined();
            expect(fixture.requests[0]?.headers["idempotency-key"]).toBe("image-task:image-sub2api-live:attempt:1");
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("sends standard OpenAI edits as multipart with the reference image file", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-openai-edit-live",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-openai",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai", createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runOpenAiImageTask(task, origin, "", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]?.path).toBe("/v1/images/edits");
            expect(fixture.requests[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
            const body = fixture.requests[0]?.body.toString("latin1") || "";
            expect(body).toContain('name="image"; filename="reference.png"');
            expect(body).toContain("Content-Type: image/png");
            expect(body).not.toContain('name="background"');
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("uses a new billing identity when multipart editing falls back to JSON", async () => {
        const requests: Array<{ contentType: string; idempotencyKey: string }> = [];
        const server = createServer(async (request, response) => {
            for await (const chunk of request) void chunk;
            const contentType = String(request.headers["content-type"] || "");
            requests.push({ contentType, idempotencyKey: String(request.headers["idempotency-key"] || "") });
            response.setHeader("content-type", "application/json");
            if (contentType.startsWith("multipart/form-data")) {
                response.statusCode = 415;
                response.end(JSON.stringify({ error: { message: "multipart form-data is not supported" } }));
                return;
            }
            response.statusCode = 200;
            response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fallback fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-edit-fallback-billing",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-openai-fallback",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "compatible", createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runOpenAiImageTask(task, "", "", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(requests.map((request) => request.idempotencyKey)).toEqual(["image-task:image-edit-fallback-billing:attempt:1", "image-task:image-edit-fallback-billing:attempt:1:json-edit"]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("keeps every URL to base64 to JSON fallback on a distinct billing identity", async () => {
        const requests: Array<{ contentType: string; idempotencyKey: string }> = [];
        const server = createServer(async (request, response) => {
            for await (const chunk of request) void chunk;
            const contentType = String(request.headers["content-type"] || "");
            requests.push({ contentType, idempotencyKey: String(request.headers["idempotency-key"] || "") });
            response.setHeader("content-type", "application/json");
            if (requests.length === 1) {
                response.setHeader("x-vozeb-pro-upstream-url", "http://upstream.internal/v1/images/edits");
                response.statusCode = 200;
                response.end(JSON.stringify({ data: [{ url: "http://renderer.internal/result.png" }] }));
                return;
            }
            if (requests.length === 2) {
                response.statusCode = 415;
                response.end(JSON.stringify({ error: { message: "multipart form-data is not supported" } }));
                return;
            }
            response.statusCode = 200;
            response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Fallback fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-url-base64-json-billing",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-openai-fallback-chain",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "compatible", createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runOpenAiImageTask(task, "", "", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(requests.map((request) => request.idempotencyKey)).toEqual([
                "image-task:image-url-base64-json-billing:attempt:1",
                "image-task:image-url-base64-json-billing:attempt:1:base64",
                "image-task:image-url-base64-json-billing:attempt:1:base64-json-edit",
            ]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("uses a distinct billing identity for each compatible JSON edit body", async () => {
        const idempotencyKeys: string[] = [];
        const server = createServer(async (request, response) => {
            for await (const chunk of request) void chunk;
            idempotencyKeys.push(String(request.headers["idempotency-key"] || ""));
            response.setHeader("content-type", "application/json");
            if (idempotencyKeys.length === 1) {
                response.statusCode = 422;
                response.end(JSON.stringify({ error: { message: "Input should be a valid dictionary or object to extract fields from" } }));
                return;
            }
            response.statusCode = 200;
            response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("JSON edit fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-json-body-billing",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-json-body-billing",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "compatible", editPath: "/images/edits", referenceRule: "JSON image references", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runOpenAiJsonImageEditTask(task, `${origin}/v1/images/edits`, origin, "", "high", "1024x1024", "", "b64_json", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(idempotencyKeys).toEqual(["image-task:image-json-body-billing:attempt:1", "image-task:image-json-body-billing:attempt:1:primary-2"]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("uses a distinct billing identity for each compatible Responses body", async () => {
        const idempotencyKeys: string[] = [];
        const server = createServer(async (request, response) => {
            for await (const chunk of request) void chunk;
            idempotencyKeys.push(String(request.headers["idempotency-key"] || ""));
            response.setHeader("content-type", "application/json");
            if (idempotencyKeys.length === 1) {
                response.statusCode = 422;
                response.end(JSON.stringify({ error: { message: "unsupported input shape" } }));
                return;
            }
            response.statusCode = 200;
            response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Responses fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-responses-body-billing",
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-responses-body-billing",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "compatible" },
            },
        });

        try {
            await expect(runOpenAiResponsesImageTask(task, origin, "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(idempotencyKeys).toEqual(["image-task:image-responses-body-billing:attempt:1:responses", "image-task:image-responses-body-billing:attempt:1:responses-2"]);
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("sends transparent OpenAI edits as multipart without changing ordinary edits", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-openai-transparent-edit-live",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "gpt-image-1",
                channelId: "fixture-openai",
                outputBackground: "transparent",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai", createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runOpenAiImageTask(task, origin, "", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            const body = fixture.requests[0]?.body.toString("latin1") || "";
            expect(body).toContain('name="background"');
            expect(body).toContain("transparent");
            expect(fixture.requests[0]?.body.toString("utf8")).toContain("真实透明 Alpha");
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("keeps transparent output in JSON edits and Responses tools only when requested", async () => {
        const transparentTask = liveImageTask("https://provider.example/v1", {
            kind: "edit",
            config: { baseUrl: "https://provider.example/v1", apiKey: "key", apiFormat: "openai", model: "gpt-image-1", outputBackground: "transparent" },
            references: [{ dataUrl: PNG_DATA_URL }],
        });
        const ordinaryTask = { ...transparentTask, config: { ...transparentTask.config, outputBackground: undefined } };
        const layerTask = { ...ordinaryTask, config: { ...ordinaryTask.config, outputMode: "layers" as const } };

        const [transparentBody] = await buildJsonImageEditBodies(transparentTask, "high", "1024x1024", "b64_json", "", "");
        const [ordinaryBody] = await buildJsonImageEditBodies(ordinaryTask, "high", "1024x1024", "b64_json", "", "");
        const [layerBody] = await buildJsonImageEditBodies(layerTask, "high", "1024x1024", "b64_json", "", "");
        expect(transparentBody).toMatchObject({ background: "transparent", output_format: "png" });
        expect(ordinaryBody).not.toHaveProperty("background");
        expect(buildResponsesImageBodies(transparentTask, "")[0]?.tools?.[0]).toMatchObject({ type: "image_generation", background: "transparent", output_format: "png" });
        expect(buildResponsesImageBodies(ordinaryTask, "")[0]?.tools?.[0]).toEqual({ type: "image_generation" });
        expect(layerBody).not.toHaveProperty("n");
    });

    it("sends Stable Diffusion img2img references as inline base64", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-stable-diffusion-edit-live",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "",
                apiFormat: "openai",
                model: "mock-image",
                channelId: "fixture-stable-diffusion",
                size: "1024x1024",
                advancedConfig: {
                    ...emptyAdvancedConfig(),
                    protocol: "stable-diffusion",
                    createPath: "/sdapi/v1/txt2img",
                    editPath: "/sdapi/v1/img2img",
                    requestTemplate: '{"prompt":"{{prompt}}","width":"{{width}}","height":"{{height}}","batch_size":1,"init_images":"{{images}}","override_settings":{"sd_model_checkpoint":"{{model}}"},"override_settings_restore_afterwards":true}',
                    resultField: "images[0]",
                    supportsReferenceImage: true,
                },
            },
        });

        try {
            await expect(runCustomImageTask(task, origin, "", "", true)).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]?.path).toBe("/sdapi/v1/img2img");
            expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ init_images: [PNG_DATA_URL] });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("sends Gemini image references and an edit mask as inlineData", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-gemini-edit-live",
            kind: "edit",
            references: [{ name: "reference.png", type: "image/png", dataUrl: "/media/fixture.png" }],
            mask: { name: "mask.png", type: "image/png", dataUrl: PNG_DATA_URL },
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "gemini",
                model: "gemini-image",
                channelId: "fixture-gemini",
                advancedConfig: { ...emptyAdvancedConfig(), protocol: "compatible", createPath: "/models/:model:generateContent", supportsReferenceImage: true },
            },
        });

        try {
            await expect(runGeminiImageTask(task, origin, "session=fixture")).resolves.toMatchObject({ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
            expect(fixture.requests.map((request) => request.path)).toEqual(["/media/fixture.png", "/v1beta/models/gemini-image:generateContent"]);
            expect(fixture.requests[0]?.headers.cookie).toBe("session=fixture");
            const body = JSON.parse(fixture.requests[1]?.body.toString("utf8") || "{}");
            expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_BASE64 } });
            expect(body.contents[0].parts[1].fileData).toBeUndefined();
            expect(body.contents[0].parts[0].text).toContain("最后一张图片是编辑蒙版");
            expect(body.contents[0].parts[2]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_BASE64 } });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it.each([
        ["Stable Diffusion", "stable-diffusion", "/sdapi/v1/txt2img", '{"prompt":"{{prompt}}","width":"{{width}}","height":"{{height}}","override_settings":{"sd_model_checkpoint":"{{model}}"}}', "images[0]"],
        ["custom", "custom", "/custom/images", '{"deployment":"{{model}}","input":"{{prompt}}","dimensions":"{{size}}"}', "data.image_url"],
    ] as const)("uses the exact %s image template and result field", async (_name, protocol, createPath, requestTemplate, resultField) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = "http://127.0.0.1:" + address.port;
        const task = liveImageTask(origin, {
            id: "image-" + protocol + "-live",
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "fixture-image-model",
                channelId: "fixture-" + protocol,
                size: "1024x1024",
                advancedConfig: { ...emptyAdvancedConfig(), protocol, createPath, requestTemplate, resultField },
            },
        });

        try {
            await expect(runCustomImageTask(task, "", "", "", true)).resolves.toMatchObject({ dataUrl: expect.any(String) });
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.requests[0]?.path).toBe(createPath);
            expect(fixture.requests[0]?.headers["idempotency-key"]).toBe("image-task:" + task.id + ":attempt:1");
            const body = JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}");
            if (protocol === "stable-diffusion") expect(body).toMatchObject({ prompt: task.prompt, width: 1024, height: 1024, override_settings: { sd_model_checkpoint: task.config.model } });
            else expect(body).toEqual({ deployment: task.config.model, input: task.prompt, dimensions: "1024x1024" });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it.each([
        ["custom", "high"],
        ["yumeng", "4K"],
    ] as const)("keeps image quality mapping isolated for the %s protocol", async (protocol, expectedResolution) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: `image-${protocol}-quality`,
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: protocol === "yumeng" ? "seedream-5.0" : "fixture-image-model",
                channelId: `fixture-${protocol}`,
                quality: "high",
                advancedConfig: { ...emptyAdvancedConfig(), protocol, createPath: "/custom/images", requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","resolution":"{{resolution}}"}', resultField: "data.image_url" },
            },
        });

        try {
            await expect(runCustomImageTask(task, "", "", "", true)).resolves.toMatchObject({ dataUrl: expect.any(String) });
            expect(JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}")).toMatchObject({ resolution: expectedResolution });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("maps custom relay image ratio, resolution, dimensions and per-task count aliases", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-custom-relay-parameters",
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "midjourney-proxy",
                channelId: "fixture-custom-relay",
                size: "9:16",
                quality: "2K",
                advancedConfig: {
                    ...emptyAdvancedConfig(),
                    protocol: "custom",
                    createPath: "/custom/images",
                    requestTemplate:
                        '{"model":"{{model}}","prompt":"{{prompt}}","ratio":"{{ratio}}","aspect_ratio":"{{aspect_ratio}}","size":"{{size}}","resolution":"{{resolution}}","quality":"{{quality}}","width":"{{width}}","height":"{{height}}","n":"{{n}}","count":"{{count}}","num_images":"{{num_images}}","batch_size":"{{batch_size}}"}',
                    resultField: "data.image_url",
                },
            },
        });

        try {
            await expect(runCustomImageTask(task, "", "", "", true)).resolves.toMatchObject({ dataUrl: expect.any(String) });
            const body = JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}");
            expect(body).toMatchObject({
                ratio: "9:16",
                aspect_ratio: "9:16",
                size: "1024x1824",
                resolution: "2K",
                quality: "2K",
                width: 1024,
                height: 1824,
                n: 1,
                count: 1,
                num_images: 1,
                batch_size: 1,
            });
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });

    it("keeps every image from one custom layer response without adding count aliases", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        const task = liveImageTask(origin, {
            id: "image-custom-layers",
            kind: "edit",
            references: [{ id: "source", name: "source.png", type: "image/png", dataUrl: PNG_DATA_URL }],
            config: {
                baseUrl: origin,
                apiKey: "fixture-key",
                apiFormat: "openai",
                model: "layer-model",
                channelId: "fixture-custom-layers",
                outputMode: "layers",
                advancedConfig: {
                    ...emptyAdvancedConfig(),
                    protocol: "custom",
                    createPath: "/custom/images",
                    editPath: "/custom/images",
                    referenceRule: "base64 inline",
                    requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{image}}","n":"{{n}}","count":"{{count}}","num_images":"{{num_images}}","batch_size":"{{batch_size}}"}',
                    resultField: "data.layers",
                },
            },
        });

        try {
            const result = await runCustomImageTask(task, "", origin, "", true);
            expect(result.results).toHaveLength(2);
            const body = JSON.parse(fixture.requests[0]?.body.toString("utf8") || "{}");
            expect(body).not.toHaveProperty("n");
            expect(body).not.toHaveProperty("count");
            expect(body).not.toHaveProperty("num_images");
            expect(body).not.toHaveProperty("batch_size");
        } finally {
            await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        }
    });
});

function liveImageTask(origin: string, patch: Partial<ImageTask>): ImageTask {
    return {
        id: "image-live",
        userId: "user-live",
        username: "user",
        displayName: "User",
        kind: "generation",
        source: "image-workbench",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: { baseUrl: origin, apiKey: "fixture-key", apiFormat: "openai", model: "mock-image", channelId: "fixture-image" },
        candidateConfigs: [],
        prompt: "create a blue protocol test image",
        references: [],
        ...patch,
    };
}
