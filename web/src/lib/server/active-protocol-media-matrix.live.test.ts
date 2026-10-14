import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCustomImageTask, pollCustomImageTask } from "@/app/api/image-tasks/image-task-custom";
import { runOpenAiImageTask } from "@/app/api/image-tasks/image-task-openai";
import { createUpstream } from "@/app/api/video-generation-tasks/video-generation-route";
import type { SystemChannelProtocol } from "@/lib/auth/store-types";
import { channelProtocolDefinitions, emptyAdvancedConfig, protocolModelConfig, registeredChannelProtocolDefinitions } from "@/lib/channel-protocol-registry";
import type { SystemGenerationChannelConfig } from "@/lib/server/generation-channel";
import type { ImageTask } from "@/lib/server/image-task-store";
import type { VideoTask } from "@/lib/server/video-task-store";
import { queryVideoTaskUpstream } from "@/lib/server/video-task-runtime";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));

const MULTIPLIERS = { imageQuality: { auto: 1, high: 1 }, videoQuality: { "720": 1, "1080": 1 }, videoSeconds: { "5": 1, "8": 1 } };
const STRICT_IMAGE_PROTOCOLS = registeredChannelProtocolDefinitions.filter((definition) => definition.strict && definition.operations.image);
const STRICT_VIDEO_PROTOCOLS = registeredChannelProtocolDefinitions.filter((definition) => definition.strict && definition.operations.video);
const ADVANCED_IMAGE_PROTOCOLS = channelProtocolDefinitions.filter((definition) => !definition.strict && definition.capabilities.includes("image"));
const ADVANCED_VIDEO_PROTOCOLS = channelProtocolDefinitions.filter((definition) => !definition.strict && definition.capabilities.includes("video"));
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
let fixture: ReturnType<typeof createProtocolFixtureServer>;
let origin = "";

describe("active media protocols over TCP fixtures", () => {
    beforeEach(async () => {
        vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        origin = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
    });

    it.each(STRICT_IMAGE_PROTOCOLS)("completes $id image creation with its registered request shape", async (definition) => {
        const model = definition.builtInModels?.find((item) => item.capability === "image")?.id || "mock-image";
        const operation = definition.operations.image!;
        const baseUrl = operation.createPath === "/images/generations" ? `${origin}/v1` : origin;
        const task = imageTask(baseUrl, model, definition.id, imageConfig(definition.id));
        const result = await runImageTask(task, definition.id);
        await expectImageResult(result);
        expectCreateRequest(new URL(`${baseUrl}${operation.createPath}`).pathname, false);
    });

    it.each(STRICT_IMAGE_PROTOCOLS.filter((definition) => definition.operations.image?.supportsReferenceImage))("completes $id image editing with a transmitted reference", async (definition) => {
        const model = definition.builtInModels?.find((item) => item.capability === "image")?.id || "mock-image";
        const operation = definition.operations.image!;
        const baseUrl = operation.createPath === "/images/generations" ? `${origin}/v1` : origin;
        const task = imageTask(baseUrl, model, definition.id, imageConfig(definition.id), true);
        const result = await runImageTask(task, definition.id);
        await expectImageResult(result);
        expectCreateRequest(new URL(`${baseUrl}${operation.editPath || operation.createPath}`).pathname, true);
    });

    it.each(STRICT_VIDEO_PROTOCOLS)("completes $id video creation and polling without path fallback", async (definition) => {
        const model = definition.builtInModels?.find((item) => item.capability === "video")?.id || "mock-video";
        const createPath = definition.operations.video!.createPath!;
        const config = videoConfig(definition.id, origin, model);
        const upstream = await createUpstream("user-live", "", "", config, "animate a blue logo", { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false }, [], MULTIPLIERS, `video-${definition.id}`);
        await expectVideoResult(config, upstream);
        expectVideoRequests(createPath.replace(":model", model), definition.operations.video!.queryPath!, model, upstream.id, false);
    });

    it.each(STRICT_VIDEO_PROTOCOLS.filter((definition) => definition.operations.video?.supportsReferenceImage))("completes $id image-to-video with a transmitted reference", async (definition) => {
        const model = definition.builtInModels?.find((item) => item.capability === "video")?.id || "mock-video";
        const operation = definition.operations.video!;
        const createPath = operation.imageToVideoPath || operation.createPath;
        const queryPath = operation.queryPath;
        if (!createPath) throw new Error(`${definition.id} video operation is missing imageToVideoPath/createPath`);
        if (!queryPath) throw new Error(`${definition.id} video operation is missing queryPath`);
        const config = videoConfig(definition.id, origin, model);
        const references = [{ type: "image" as const, url: `${origin}/media/fixture.png` }];
        const upstream = await createUpstream("user-live", "", "", config, "animate the reference image", { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false }, references, MULTIPLIERS, `image-video-${definition.id}`);
        await expectVideoResult(config, upstream);
        expectVideoRequests(createPath.replace(":model", model), queryPath, model, upstream.id, true);
    });

    it.each(ADVANCED_IMAGE_PROTOCOLS)("completes configured $id image creation", async (definition) => {
        const baseUrl = definition.id === "custom" ? origin : `${origin}/v1`;
        const task = imageTask(baseUrl, "mock-image", definition.id, imageConfig(definition.id));
        const image = definition.id === "custom" ? await runCustomImageTask(task, origin, origin, "", true) : await runOpenAiImageTask(task, origin, origin, "", true);
        await expectImageResult(image);
        expectCreateRequest(definition.id === "custom" ? "/custom/images" : "/v1/images/generations", false);
    });

    it.each(ADVANCED_IMAGE_PROTOCOLS)("completes configured $id image editing with a transmitted reference", async (definition) => {
        const baseUrl = definition.id === "custom" ? origin : `${origin}/v1`;
        const task = imageTask(baseUrl, "mock-image", definition.id, imageConfig(definition.id), true);
        const image = definition.id === "custom" ? await runCustomImageTask(task, origin, origin, "", true) : await runOpenAiImageTask(task, origin, origin, "", true);
        await expectImageResult(image);
        expectCreateRequest(definition.id === "custom" ? "/custom/images" : "/v1/images/edits", true);
    });

    it.each(ADVANCED_VIDEO_PROTOCOLS)("completes configured $id video creation and polling", async (definition) => {
        const config = videoConfig(definition.id, origin, "mock-video");
        const upstream = await createUpstream("user-live", "", "", config, "animate a blue logo", { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false }, [], MULTIPLIERS, `video-${definition.id}`);
        await expectVideoResult(config, upstream);
        expectVideoRequests(definition.id === "custom" ? "/custom/videos" : "/videos", definition.id === "custom" ? "/custom/results/:task_id" : "/videos/:task_id", "mock-video", upstream.id, false);
    });

    it.each(ADVANCED_VIDEO_PROTOCOLS)("completes configured $id image-to-video with a transmitted reference", async (definition) => {
        const config = videoConfig(definition.id, origin, "mock-video");
        const upstream = await createUpstream(
            "user-live",
            "",
            "",
            config,
            "animate the reference image",
            { videoSeconds: 5, size: "16:9", vquality: "720", videoGenerateAudio: false },
            [{ type: "image", url: `${origin}/media/fixture.png` }],
            MULTIPLIERS,
            `image-video-${definition.id}`,
        );
        await expectVideoResult(config, upstream);
        expectVideoRequests(definition.id === "custom" ? "/custom/videos" : "/videos", definition.id === "custom" ? "/custom/results/:task_id" : "/videos/:task_id", "mock-video", upstream.id, true);
    });
});

function imageTask(baseUrl: string, model: string, protocol: string, advancedConfig?: ImageTask["config"]["advancedConfig"], edit = false): ImageTask {
    return {
        id: `image-${protocol}`,
        userId: "user-live",
        username: "user",
        displayName: "User",
        kind: edit ? "edit" : "generation",
        source: "image-workbench",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: { baseUrl, apiKey: "fixture-key", apiFormat: "openai", model, channelId: `fixture-${protocol}`, ...(advancedConfig ? { advancedConfig } : {}) },
        candidateConfigs: [],
        prompt: "create a blue protocol test image",
        references: edit
            ? [
                  {
                      id: "reference",
                      name: "reference.png",
                      type: "image/png",
                      dataUrl: protocol === "yumeng" ? `${origin}/media/fixture.png` : protocol === "sub2api" || protocol === "custom" ? "https://cdn.example.com/reference.png" : PNG_DATA_URL,
                  },
              ]
            : [],
    };
}

function imageConfig(protocol: string) {
    if (protocol === "stable-diffusion") {
        return { ...emptyAdvancedConfig(), ...protocolModelConfig("stable-diffusion", "image") };
    }
    if (protocol === "yumeng") return { ...emptyAdvancedConfig(), ...protocolModelConfig("yumeng", "image") };
    if (protocol === "custom") {
        return {
            ...emptyAdvancedConfig(),
            protocol: "custom" as const,
            createPath: "/custom/images",
            editPath: "/custom/images",
            requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{images}}"}',
            resultField: "data.image_url",
            supportsReferenceImage: true,
        };
    }
    const strict = protocolModelConfig(protocol as SystemChannelProtocol, "image");
    return strict ? { ...emptyAdvancedConfig(), ...strict } : { ...emptyAdvancedConfig(), protocol: protocol as SystemChannelProtocol };
}

function videoConfig(protocol: SystemChannelProtocol, baseUrl: string, model: string): SystemGenerationChannelConfig {
    const strict = protocolModelConfig(protocol, "video");
    const advancedConfig =
        (strict ? { ...emptyAdvancedConfig(), ...strict } : undefined) ||
        (protocol === "custom"
            ? {
                  ...emptyAdvancedConfig(),
                  protocol: "custom" as const,
                  createPath: "/custom/videos",
                  imageToVideoPath: "/custom/videos",
                  queryPath: "/custom/results/:task_id",
                  requestTemplate: '{"deployment":"{{model}}","input":"{{prompt}}","seconds":"{{duration}}","aspect":"{{ratio}}","images":"{{images}}"}',
                  resultField: "data.video_url",
                  statusField: "data.status",
                  supportsReferenceImage: true,
              }
            : {
                  ...emptyAdvancedConfig(),
                  protocol,
                  createPath: "/videos",
                  imageToVideoPath: "/videos",
                  queryPath: "/videos/:task_id",
                  requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{images}}"}',
                  resultField: "video_url",
                  statusField: "status",
                  supportsReferenceImage: true,
              });
    return { apiSource: "system", baseUrl, apiKey: "system", apiFormat: protocol === "gemini" ? "gemini" : "openai", model, logicalModel: model, channelId: `fixture-${protocol}`, advancedConfig };
}

async function runImageTask(task: ImageTask, protocol: SystemChannelProtocol) {
    const declarative = protocol === "stable-diffusion" || protocol === "yumeng";
    const submitted = declarative ? await runCustomImageTask(task, origin, origin, "", protocol === "yumeng") : await runOpenAiImageTask(task, origin, origin, "", true);
    return submitted.pending ? pollCustomImageTask(task, submitted.pending.id, submitted.pending.mediaBaseUrl, submitted.pending.pollBaseUrl, "") : submitted;
}

async function expectImageResult(result: { dataUrl?: string; remoteUrl?: string }) {
    const source = result.remoteUrl || result.dataUrl || "";
    expect(source).toBeTruthy();
    if (source.startsWith("data:")) {
        expect(Buffer.from(source.slice(source.indexOf(",") + 1), "base64").byteLength).toBeGreaterThan(0);
        return;
    }
    const response = await fetch(source);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("image/");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
}

function expectCreateRequest(expectedPath: string, referenceRequired: boolean) {
    const requests = fixture.requests.filter((request) => request.method === "POST");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(expectedPath);
    const body = requestBodyText(requests[0]);
    expect(requestContainsReference(requests[0]), referenceRequired ? `reference media was not transmitted: ${body}` : `text-only request unexpectedly included reference media: ${body}`).toBe(referenceRequired);
}

async function expectVideoResult(config: SystemGenerationChannelConfig, upstream: VideoTask["upstream"]) {
    expect(upstream?.id).toBeTruthy();
    const result = await queryVideoTaskUpstream({ config, upstream, userId: "user-live" } as unknown as VideoTask, "", "");
    expect(result).toMatchObject({ state: "result_ready", resultUrl: expect.stringContaining("/media/fixture.mp4") });
    if (result.state !== "result_ready") throw new Error(`video fixture did not return a result: ${result.state}`);
    const response = await fetch(result.resultUrl);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
}

function expectVideoRequests(createPath: string, queryPath: string, model: string, taskId: string, referenceRequired: boolean) {
    const createRequests = fixture.requests.filter((request) => request.method === "POST");
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]?.path).toBe(createPath);
    expect(requestContainsReference(createRequests[0]), referenceRequired ? "reference image was not transmitted to the video provider" : "text-only video request unexpectedly included a reference").toBe(referenceRequired);
    const expectedQuery = queryPath.replace(":model", model).replace(":task_id", taskId);
    expect(fixture.requests.some((request) => request.method === "GET" && request.path === expectedQuery)).toBe(true);
    expect(fixture.requests.some((request) => request.method === "GET" && request.path === "/media/fixture.mp4")).toBe(true);
}

function requestContainsReference(request: (typeof fixture.requests)[number] | undefined) {
    if (!request) return false;
    const body = requestBodyText(request);
    return /reference\.png|fixture\.png|iVBOR|input_reference|reference_images|image_urls|inlineData|image_url|"images"\s*:\s*\[\s*"http|"image"\s*:\s*\{/.test(body);
}

function requestBodyText(request: (typeof fixture.requests)[number] | undefined) {
    return request?.body.toString(request.contentType.includes("multipart/form-data") ? "latin1" : "utf8") || "";
}
