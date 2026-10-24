import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
const TRANSPARENT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWPQq/3PoFf7H0KAOABK+winx6MN+QAAAABJRU5ErkJggg==";
const FALLBACK_MP4 = Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==", "base64");

const models = [
    { id: "mock-text", capability: "text", api_format: "openai", endpoint: "/chat/completions" },
    { id: "mock-image", capability: "image", api_format: "openai", endpoint: "/images/generations" },
    { id: "mock-video", capability: "video", api_format: "openai", endpoint: "/videos" },
    { id: "mock-audio", capability: "audio", api_format: "openai", endpoint: "/audio/speech" },
];

const GLOBAL_AIOPC_IMAGE_PATHS = new Set(["/image2/images", "/banana/images"]);
const YUMENG_MODEL_CENTER_TASK_PATH = "/kyyReactApiServer/v2/model-center/tasks";
const GLOBAL_AIOPC_VIDEO_PATHS = new Set([
    "/sora/videos",
    "/veo/videos",
    "/seedance/videos",
    "/kyyvideo2/videos",
    "/seedance-discount/videos",
    "/seedance-x1/videos",
    "/sd2_manxue/videos",
    "/grok/videos",
    "/omni-flash/videos",
    "/happyhorse-t2v/videos",
    "/happyhorse-i2v/videos",
    "/happyhorse-r2v/videos",
    "/happyhorse-edit/videos",
    "/starvideos/videos",
    "/videos/videos",
    "/luxvid-video/videos",
    "/vidu/videos",
]);

export function createProtocolFixtureServer(options = {}) {
    const tasks = new Map();
    const requests = [];
    let taskSequence = 0;
    const nextTaskId = (kind) => `fixture-${kind}-${++taskSequence}`;
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
            const body = await readRequestBody(request);
            requests.push({ method: request.method || "GET", path: url.pathname, headers: request.headers, contentType: request.headers["content-type"] || "", body });
            await handleFixtureRequest({ request, response, url, body, tasks, requests, nextTaskId, options });
        } catch (error) {
            sendJson(response, 500, { error: { message: error instanceof Error ? error.message : "fixture failed" } });
        }
    });
    return { server, requests, tasks };
}

async function handleFixtureRequest({ request, response, url, body, tasks, requests, nextTaskId, options }) {
    const path = fixturePath(url.pathname, options.mountPrefixes || []);
    const responseDelayMs = Math.max(0, Number(options.responseDelayMs) || 0);
    if (request.method === "POST" && responseDelayMs) await delay(responseDelayMs);
    if (request.method === "GET" && path === "/health") return sendJson(response, 200, { ok: true });
    if (request.method === "GET" && path === "/__state") {
        return sendJson(response, 200, {
            requests: requests
                .filter((item) => !item.path.endsWith("/__state"))
                .map((item) => {
                    const payload = jsonBody(item.body);
                    const messages = Array.isArray(payload.messages) ? payload.messages : [];
                    return {
                        method: item.method,
                        path: item.path,
                        authorization: item.headers.authorization || "",
                        contentType: item.contentType,
                        bodyBytes: item.body.byteLength,
                        model: requestedModel(item.body, item.contentType),
                        imageCount: messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "image_url" && /^data:image\//.test(part.image_url?.url || "")).length,
                        messageCount: messages.length,
                    };
                }),
            tasks: Array.from(tasks.entries()).map(([id, task]) => ({ id, ...task })),
        });
    }
    if (request.method === "POST" && path === "/__reset") {
        requests.splice(0, requests.length);
        tasks.clear();
        return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && path === "/vendor-space/knowledge/article-947") {
        return sendBytes(
            response,
            200,
            "text/html; charset=utf-8",
            Buffer.from(`<!doctype html><html><body><article>
                <h1>Provider integration manual</h1>
                <p>Model catalog: GET ${url.origin}/api/v3/models</p>
                <pre>curl --url ${url.origin}/custom/images --header 'X-API-Key: token' --header 'Content-Type: application/json' --data '{"model":"custom-image-v9","prompt":"test","width":1024,"height":1024,"references":[]}'</pre>
                <pre>{"data":{"image_url":"${url.origin}/media/fixture.png"}}</pre>
                <pre>curl --url ${url.origin}/custom/videos --header 'X-API-Key: token' --header 'Content-Type: application/json' --data '{"model":"custom-video-v9","prompt":"test","duration":5,"references":[]}'</pre>
                <pre>{"data":{"task_id":"custom-video-task","status":"queued"}}</pre>
                <pre>curl --url ${url.origin}/custom/results/:task_id --header 'X-API-Key: token'</pre>
                <pre>{"data":{"status":"completed","video_url":"${url.origin}/media/fixture.mp4"}}</pre>
            </article></body></html>`),
        );
    }
    if (request.method === "GET" && ["/models", "/api/v3/models"].includes(path)) {
        const catalog =
            url.searchParams.get("protocol") === "dataeyes-seedance"
                ? [{ id: "seedance-1.5-pro" }, { id: "seedance-2.0-fast" }, { id: "provider-scoped-video" }]
                : url.searchParams.get("protocol") === "dataeyes-flux"
                  ? [{ id: "flux-2-pro" }, { id: "gpt-image-1" }]
                  : url.searchParams.get("protocol") === "dataeyes-seedream"
                    ? [{ id: "ByteDance-Seedream-5.0-pro", supported_endpoint_types: ["openai"] }, { id: "gpt-image-1" }]
                    : url.searchParams.has("protocol")
                      ? [...models, { id: "opaque-catalog-model" }]
                      : models;
        return sendJson(response, 200, { object: "list", data: catalog });
    }
    if (request.method === "GET" && path === "/sdapi/v1/sd-models") {
        return sendJson(response, 200, [{ title: "mock-image", model_name: "mock-image", id: "mock-image" }, ...(url.searchParams.has("protocol") ? [{ id: "opaque-catalog-model" }] : [])]);
    }

    if (request.method === "POST" && ["/responses", "/chat/completions", "/messages", "/api/paas/v4/chat/completions"].includes(path)) {
        const payload = jsonBody(body);
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (shouldFailRequest(request, model)) return sendJson(response, model.includes("-fail") ? 400 : 503, { error: { message: "fixture text failure" } });
        if (path === "/chat/completions" && ["gpt-4o-audio-preview", "gpt-audio-1.5"].includes(model)) {
            if (!payload.modalities?.includes("audio") || !payload.audio?.voice || !payload.audio?.format) return sendJson(response, 400, { error: { message: "audio output parameters missing" } });
            if (options.failOpenAiAudio) return sendJson(response, 503, { error: { message: "fixture audio response uncertain" } });
            if (options.openAiAudioResponse) return sendJson(response, 200, options.openAiAudioResponse);
            return sendJson(response, 200, {
                model,
                service_tier: "default",
                choices: [{ index: 0, message: { role: "assistant", content: null, audio: { data: createWave().toString("base64"), transcript: "fixture audio" } } }],
                usage: {
                    prompt_tokens: 8,
                    completion_tokens: 12,
                    total_tokens: 20,
                    prompt_tokens_details: { text_tokens: 8, audio_tokens: 0, image_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
                    completion_tokens_details: { text_tokens: 2, audio_tokens: 10, reasoning_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
                },
            });
        }
        const toolName = path === "/messages" && !Array.isArray(payload.tools) ? "" : selectedToolName(payload);
        const argumentsText = toolName ? JSON.stringify(toolArguments(toolName, payload)) : "协议测试文本返回成功";
        const inputTokenDetails =
            path === "/chat/completions" && model === "qwen3.8-max"
                ? { cached_tokens: 2, cache_creation_input_tokens: 1 }
                : path === "/chat/completions" && ["deepseek-flash", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"].includes(model)
                  ? { cached_tokens: 2 }
                  : { cached_tokens: 2, cache_write_tokens: 1 };
        if (path === "/chat/completions" && model === "kimi-k3") {
            response.setHeader("Msh-Usage-Cache-Write-Tokens-5m", "1");
            response.setHeader("Msh-Usage-Cache-Write-Tokens-1h", "0");
        }
        const nativeCache = path === "/chat/completions" && model === "deepseek-flash" ? { prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 6 } : {};
        if (payload.stream === true && path === "/messages") return sendAnthropicTextStream(response, model, toolName ? argumentsText : jsonRequested(payload) ? "{}" : argumentsText);
        if (payload.stream === true) return sendStructuredTextStream(response, path, toolName, argumentsText, "sse", inputTokenDetails, model, nativeCache);
        if (path === "/responses") {
            return sendJson(response, 200, {
                ...(toolName ? { output: [{ type: "function_call", name: toolName, arguments: argumentsText }] } : { output_text: argumentsText }),
                model,
                usage: { input_tokens: 8, output_tokens: 8, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } },
            });
        }
        if (path === "/messages") {
            const usage = { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 }, service_tier: "standard", inference_geo: "global" };
            return sendJson(response, 200, {
                model,
                type: "message",
                stop_reason: toolName ? "tool_use" : "end_turn",
                usage,
                content: toolName ? [{ type: "tool_use", id: "tool-fixture", name: toolName, input: JSON.parse(argumentsText) }] : [{ type: "text", text: jsonRequested(payload) ? "{}" : argumentsText }],
            });
        }
        return sendJson(response, 200, {
            model,
            service_tier: "default",
            choices: [
                {
                    finish_reason: toolName ? "tool_calls" : "stop",
                    message: toolName ? { role: "assistant", content: "", tool_calls: [{ id: "tool-fixture", type: "function", function: { name: toolName, arguments: argumentsText } }] } : { role: "assistant", content: argumentsText },
                },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16, prompt_tokens_details: inputTokenDetails, ...nativeCache },
        });
    }

    if (request.method === "POST" && /\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) {
        const payload = jsonBody(body);
        if (payload.generationConfig?.responseModalities?.includes("AUDIO")) {
            if (options.failGeminiAudio) return sendJson(response, 503, { error: "fixture audio outcome unknown" });
            if (options.geminiAudioResponse) return sendJson(response, 200, options.geminiAudioResponse);
            return sendJson(response, 200, {
                candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: createWave().toString("base64") } }] } }],
                usageMetadata: {
                    promptTokenCount: 8,
                    candidatesTokenCount: 12,
                    totalTokenCount: 20,
                    cachedContentTokenCount: 0,
                    thoughtsTokenCount: 0,
                    toolUsePromptTokenCount: 0,
                    promptTokensDetails: [{ modality: "TEXT", tokenCount: 8 }],
                    candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 12 }],
                },
            });
        }
        if (payload.generationConfig?.responseModalities?.includes("IMAGE")) {
            return sendJson(response, 200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: (await fixtureImage(options)).toString("base64") } }] } }] });
        }
        const toolName = selectedToolName(payload);
        const text = toolName ? JSON.stringify(toolArguments(toolName, payload)) : "协议测试文本返回成功";
        if (path.endsWith(":streamGenerateContent")) return sendStructuredTextStream(response, path, toolName, text, "ndjson");
        return sendJson(response, 200, { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 8, cachedContentTokenCount: 2, candidatesTokenCount: 8, thoughtsTokenCount: 1, totalTokenCount: 17 } });
    }
    if (request.method === "POST" && ["/planner/run", "/planner/stream"].includes(path)) {
        if (path === "/planner/stream") return sendStructuredTextStream(response, path, "make_plan", "{}");
        return sendJson(response, 200, { data: { plan: JSON.stringify({}) } });
    }

    const geminiCreate = path.match(/^\/models\/([^/]+):predictLongRunning$/);
    if (request.method === "POST" && geminiCreate) {
        const id = nextTaskId("gemini-operation");
        tasks.set(id, { kind: "gemini-video", status: "completed", model: decodeURIComponent(geminiCreate[1]) });
        return sendJson(response, 200, { name: `models/${decodeURIComponent(geminiCreate[1])}/operations/${id}`, done: false });
    }
    const geminiOperation = path.match(/^\/models\/([^/]+)\/operations\/([^/]+)$/);
    if (request.method === "GET" && geminiOperation) {
        const id = decodeURIComponent(geminiOperation[2]);
        const model = decodeURIComponent(geminiOperation[1]);
        const task = tasks.get(id);
        if (!task || task.kind !== "gemini-video") return sendJson(response, 404, { error: { message: "Gemini operation not found" } });
        return sendJson(response, 200, {
            name: `models/${model}/operations/${id}`,
            done: task.status === "completed",
            ...(task.status === "completed" ? { response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${url.origin}/media/fixture.mp4` } }] } } } : {}),
        });
    }

    if (request.method === "POST" && GLOBAL_AIOPC_IMAGE_PATHS.has(path)) {
        const id = nextTaskId("image");
        tasks.set(id, { kind: "image", status: "completed" });
        return sendJson(response, 200, { task_id: id, status: "queued" });
    }
    if (request.method === "POST" && ["/images/generations", "/images/edits"].includes(path)) {
        if (String(request.headers["idempotency-key"] || "").includes("xai")) return sendJson(response, 200, { data: [{ url: `${url.origin}/media/fixture.png` }] });
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (model.toLowerCase() === "bytedance-seedream-5.0-pro") {
            const payload = jsonBody(body);
            if (url.pathname !== "/v1/images/generations" || payload.response_format !== "url" || !/^(?:2K|[1-9]\d*x[1-9]\d*)$/.test(String(payload.size || "")) || "n" in payload || "quality" in payload)
                return sendJson(response, 400, { error: { message: "DataEyes Seedream request shape is invalid" } });
            return sendJson(response, 200, { data: [{ url: `${url.origin}/media/fixture.png?result=1` }, { url: `${url.origin}/media/fixture.png?result=2` }] });
        }
        if (options.failImage || shouldFailRequest(request, model)) return sendJson(response, options.failImage || model.includes("-fail") ? 400 : 503, { error: { message: "fixture image failure" } });
        if (["flux-kontext-pro", "flux-kontext-max", "flux-pro-1.1"].includes(model))
            return sendJson(response, 200, options.imageResponse || { data: [{ url: `${url.origin}/media/fixture.png${body.includes("fixture-invalid-image-after-usage") ? "?invalid=1" : ""}` }] });
        if (options.imageResponse) return sendJson(response, 200, options.imageResponse);
        const image =
            model === "e2e-image" && body.includes("fixture-invalid-image-after-usage")
                ? Buffer.from(TRANSPARENT_PNG_BASE64, "base64").fill(0, 33)
                : requestsTransparentBackground(body, request.headers["content-type"] || "")
                  ? Buffer.from(TRANSPARENT_PNG_BASE64, "base64")
                  : await fixtureImage(options);
        const images = requestsLayeredOutput(body) ? await layeredFixtureImages(body, request.headers["content-type"] || "", options) : [image];
        return sendJson(response, 200, {
            created: Math.floor(Date.now() / 1000),
            data: images.map((item) => ({ b64_json: item.toString("base64"), revised_prompt: "protocol fixture" })),
            ...(["mock-image-priced", "e2e-image"].includes(model)
                ? { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { text_tokens: 1, image_tokens: 2 }, output_tokens_details: { text_tokens: 0, image_tokens: 4 } } }
                : {}),
        });
    }
    if (request.method === "POST" && ["/sdapi/v1/txt2img", "/sdapi/v1/img2img"].includes(path)) {
        return sendJson(response, 200, { images: [(await fixtureImage(options)).toString("base64")], info: "{}" });
    }
    if (request.method === "POST" && path === "/custom/images") {
        if (requestsLayeredOutput(body)) return sendJson(response, 200, { data: { layers: [`${url.origin}/media/fixture.png?layer=1`, `${url.origin}/media/fixture.png?layer=2`] } });
        return sendJson(response, 200, { data: { image_url: `${url.origin}/media/fixture.png` } });
    }

    if (request.method === "POST" && path === "/compatible-mode/v1/images/generations") return sendJson(response, 200, { data: [{ url: `${url.origin}/media/fixture.png` }] });
    if (request.method === "POST" && path === "/image_generation") return sendJson(response, 200, { data: { image_urls: [`${url.origin}/media/fixture.png`] }, base_resp: { status_code: 0 } });
    if (request.method === "POST" && /^\/flux-[a-z0-9.-]+$/.test(path)) {
        const id = nextTaskId("bfl-image");
        tasks.set(id, { kind: "bfl-image", status: "Ready" });
        return sendJson(response, 200, { id, polling_url: `${url.origin}/v1/get_result?id=${encodeURIComponent(id)}` });
    }
    if (request.method === "GET" && path === "/get_result") {
        const id = url.searchParams.get("id");
        return tasks.get(id)?.kind === "bfl-image" ? sendJson(response, 200, { id, status: "Ready", result: { sample: `${url.origin}/media/fixture.png` } }) : sendJson(response, 404, { error: "task not found" });
    }

    if (request.method === "POST" && path === "/video_generation") {
        const payload = jsonBody(body);
        const model = payload.model;
        if (!["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"].includes(model) || (model.endsWith("-Fast") && !payload.first_frame_image) || payload.content || payload.ratio || payload.last_frame_image)
            return sendJson(response, 400, { error: "invalid Hailuo request" });
        if (![6, 10].includes(payload.duration ?? 6) || !["768P", "1080P"].includes(payload.resolution ?? "768P") || (payload.resolution === "1080P" && (payload.duration ?? 6) !== 6))
            return sendJson(response, 400, { error: "invalid Hailuo duration/resolution" });
        const id = nextTaskId("hailuo");
        tasks.set(id, { kind: "hailuo", status: "Success", fileId: `${id}-file`, videoWidth: 1920, videoHeight: 1080 });
        return sendJson(response, 200, { task_id: id, base_resp: { status_code: 0, status_msg: "success" }, ...options.hailuoCreateResponse });
    }
    if (request.method === "GET" && path === "/query/video_generation") {
        const id = url.searchParams.get("task_id");
        const task = tasks.get(id);
        if (task?.kind !== "hailuo") return sendJson(response, 404, { error: "task not found" });
        return sendJson(response, 200, {
            task_id: id,
            status: task.status,
            ...(task.status === "Success" ? { file_id: task.fileId, video_width: task.videoWidth, video_height: task.videoHeight, ...(task.error ? { error: task.error } : {}) } : {}),
            base_resp: { status_code: 0, status_msg: "success" },
        });
    }
    if (request.method === "GET" && path === "/files/retrieve") {
        const fileId = url.searchParams.get("file_id");
        const task = [...tasks.values()].find((task) => task.kind === "hailuo" && task.fileId === fileId);
        if (!task || task.fileUnavailable) return sendJson(response, 503, { error: "file unavailable" });
        return sendJson(response, 200, { file: { file_id: fileId, download_url: `${url.origin}/media/hailuo.mp4` }, base_resp: { status_code: 0 } });
    }

    const officialVideoKind =
        request.method === "POST" &&
        (path === "/api/v1/services/aigc/video-generation/video-synthesis"
            ? "bailian"
            : path === "/videos/text2video" || path === "/videos/image2video"
              ? "kling"
              : path === "/ent/v2/text2video" || path === "/ent/v2/img2video"
                ? "vidu"
                : path === "/v2/video_generation"
                  ? "minimax"
                  : "");
    if (officialVideoKind) {
        if (officialVideoKind === "minimax" && !["MiniMax-H3", "MiniMax-H3-Max"].includes(jsonBody(body).model)) return sendJson(response, 400, { error: "V2 only supports H3 models" });
        const id = nextTaskId(`${officialVideoKind}-video`);
        tasks.set(id, {
            kind: officialVideoKind,
            status: "completed",
            ...(officialVideoKind === "minimax"
                ? {
                      model: jsonBody(body).model,
                      resolution: "768P",
                      taskType: "generation",
                      modality: "video",
                      usage: { total_seconds: 6.25, input_seconds: 1.25, output_seconds: 5, input_image_count: 2, input_audio_seconds: 3.5 },
                      resultFile: body.toString("utf8").includes("fixture-h3-usage") ? "hailuo.mp4" : "fixture.mp4",
                  }
                : {}),
        });
        if (officialVideoKind === "minimax" && body.toString("utf8").includes("fixture-h3-shadow"))
            Object.assign(tasks.get(id), { usage: { total_seconds: 5.25, input_seconds: 0, output_seconds: 5.25, input_image_count: 0, input_audio_seconds: 0 }, resultFile: "hailuo.mp4" });
        return sendJson(response, 200, officialVideoKind === "bailian" ? { output: { task_id: id, task_status: "PENDING" } } : officialVideoKind === "kling" ? { data: { task_id: id, task_status: "submitted" } } : { task_id: id, state: "created" });
    }
    const officialVideoId = path.match(/^\/(?:api\/v1\/tasks|videos\/(?:text2video|image2video)|ent\/v2\/tasks|v2\/query\/video_generation)\/([^/]+)/)?.[1];
    if (request.method === "GET" && officialVideoId) {
        const id = decodeURIComponent(officialVideoId);
        const kind = tasks.get(id)?.kind;
        const videoUrl = `${url.origin}/media/fixture.mp4`;
        if (kind === "bailian") return sendJson(response, 200, { output: { task_id: id, task_status: "SUCCEEDED", video_url: videoUrl } });
        if (kind === "kling") return sendJson(response, 200, { data: { task_id: id, task_status: "succeed", task_result: { videos: [{ url: videoUrl }] } } });
        if (kind === "vidu") return sendJson(response, 200, { task_id: id, state: "success", creations: [{ url: videoUrl }] });
        if (kind === "minimax") {
            const task = tasks.get(id);
            return sendJson(response, 200, {
                task: {
                    id,
                    model: task.model,
                    status: task.status === "completed" ? "succeeded" : task.status,
                    resolution: task.resolution,
                    task_type: task.taskType,
                    modality: task.modality,
                    usage: task.usage,
                    content: { url: `${url.origin}/media/${task.resultFile || "fixture.mp4"}` },
                },
            });
        }
    }

    if (request.method === "POST" && (GLOBAL_AIOPC_VIDEO_PATHS.has(path) || ["/videos", "/contents/generations/tasks", "/seedance/api/v3/contents/generations/tasks", "/seedance-special/videos"].includes(path))) {
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (shouldFailRequest(request, model)) return sendJson(response, model.includes("-fail") ? 400 : 503, { error: { message: "fixture video failure" } });
        const id = nextTaskId("video");
        tasks.set(id, { kind: "video", status: model.includes("-slow") ? "pending" : "completed" });
        return sendJson(response, 200, { id, task_id: id, status: "queued" });
    }
    if (request.method === "POST" && path === "/videos/generations") {
        if (String(request.headers["idempotency-key"] || "").includes("xai")) {
            const id = nextTaskId("xai-video");
            tasks.set(id, { kind: "grok-video", status: "done" });
            return sendJson(response, 200, { request_id: id });
        }
        if (String(request.headers["idempotency-key"] || "").includes("sub2api-grok")) {
            const payload = jsonBody(body);
            const id = nextTaskId("grok-video");
            tasks.set(id, { kind: "grok-video", status: "done", model: payload.model });
            return sendJson(response, 200, { request_id: id });
        }
        if (
            !String(request.headers["content-type"] || "")
                .toLowerCase()
                .includes("application/json")
        )
            return sendJson(response, 415, { code: "invalid_content_type", message: "VOZEB recommended video requests must use application/json", data: null });
        const payload = jsonBody(body);
        if (payload.model === "Seedance 2.0-fast-720p" && payload.generate_audio !== false) return sendJson(response, 400, { code: "invalid_request", message: "generate_audio must be false", data: null });
        const id = nextTaskId("vozeb-video");
        tasks.set(id, { kind: "vozeb-video", status: "completed" });
        return sendJson(response, 200, { id, task_id: id, object: "video", model: payload.model, status: "queued", progress: 0, created_at: 0 });
    }
    if (request.method === "POST" && path === YUMENG_MODEL_CENTER_TASK_PATH) {
        const payload = jsonBody(body);
        const model = String(payload.model || "");
        const kind = /image|seedream/i.test(model) ? "yumeng-image" : "yumeng-video";
        const id = nextTaskId(kind);
        tasks.set(id, { kind, status: "completed", model });
        return sendJson(response, 200, { task_id: id, status: "queued" });
    }
    const yumengTaskPrefix = `${YUMENG_MODEL_CENTER_TASK_PATH}/`;
    const yumengTaskId = path.startsWith(yumengTaskPrefix) ? path.slice(yumengTaskPrefix.length) : "";
    if (request.method === "GET" && yumengTaskId) {
        const id = decodeURIComponent(yumengTaskId);
        const task = tasks.get(id);
        if (!task || !String(task.kind).startsWith("yumeng-")) return sendJson(response, 404, { code: 404, message: "昱梦任务不存在" });
        const resultUrl = task.kind === "yumeng-image" ? `${url.origin}/media/fixture.png` : `${url.origin}/media/fixture.mp4`;
        return sendJson(response, 200, { task_id: id, status: "completed", result_url: resultUrl });
    }
    if (request.method === "POST" && path === "/custom/videos") {
        const id = nextTaskId("custom-video");
        tasks.set(id, { kind: "custom-video", status: "completed" });
        return sendJson(response, 200, { data: { task_id: id, status: "queued" } });
    }
    const customVideoId = path.match(/^\/custom\/results\/([^/]+)$/)?.[1];
    if (request.method === "GET" && customVideoId) {
        return sendJson(response, 200, { data: { task_id: decodeURIComponent(customVideoId), status: "completed", video_url: `${url.origin}/media/fixture.mp4` } });
    }
    const vozebVideoId = path.match(/^\/videos\/generations\/([^/]+)$/)?.[1];
    if (request.method === "GET" && vozebVideoId) {
        const id = decodeURIComponent(vozebVideoId);
        return sendJson(response, 200, { id, task_id: id, object: "video", status: "completed", progress: 100, metadata: { url: `${url.origin}/media/fixture.mp4` } });
    }
    const videoId = videoTaskId(path);
    const grokContentId = path.match(/^\/videos\/([^/]+)\/content$/)?.[1];
    if (request.method === "GET" && grokContentId && tasks.get(decodeURIComponent(grokContentId))?.kind === "grok-video") {
        const bytes = options.videoPath ? await readFile(options.videoPath) : FALLBACK_MP4;
        return sendBytes(response, 200, "video/mp4", bytes);
    }
    if (request.method === "DELETE" && path.startsWith("/seedance/api/v3/contents/generations/tasks/") && videoId) {
        const task = tasks.get(videoId);
        if (!task) return sendJson(response, 404, { error: { message: "Seedance task not found" } });
        tasks.set(videoId, { ...task, status: "cancelled" });
        return sendJson(response, 200, { id: videoId, status: "cancelled" });
    }
    if (request.method === "GET" && videoId) {
        const mediaUrl = `${url.origin}/media/fixture.mp4`;
        const task = tasks.get(videoId);
        if (task?.kind === "grok-video") return sendJson(response, 200, { status: "done", video: { url: mediaUrl } });
        if (task?.kind === "image") return sendJson(response, 200, { task_id: videoId, status: "completed", image_url: `${url.origin}/media/fixture.png` });
        if (task?.status === "pending") return sendJson(response, 200, { id: videoId, task_id: videoId, status: "processing" });
        if (task?.status === "cancelled") return sendJson(response, 200, { id: videoId, task_id: videoId, status: "cancelled" });
        return sendJson(response, 200, { id: videoId, task_id: videoId, status: "completed", video_url: mediaUrl, content: { video_url: mediaUrl }, result: { video_url: mediaUrl } });
    }
    if (request.method === "GET" && path === "/media/hailuo.mp4") {
        const bytes = await readFile(new URL("./fixtures/hailuo.mp4", import.meta.url));
        return sendBytes(response, 200, "video/mp4", bytes);
    }
    if (request.method === "GET" && path === "/media/fixture.mp4") {
        const bytes = options.videoPath ? await readFile(options.videoPath) : FALLBACK_MP4;
        return sendBytes(response, 200, "video/mp4", bytes);
    }
    if (request.method === "GET" && path === "/media/fixture.png") return sendBytes(response, 200, "image/png", url.searchParams.has("invalid") ? Buffer.from("invalid fixture image") : await fixtureImage(options));

    if (request.method === "POST" && path === "/audio/speech") {
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (["gpt-4o-audio-preview", "gpt-audio-1.5"].includes(model)) return sendJson(response, 404, { error: { message: "audio preview uses chat completions" } });
        if (shouldFailRequest(request, model)) return sendJson(response, model.includes("-fail") ? 400 : 503, { error: { message: "fixture audio failure" } });
        return sendBytes(response, 200, "audio/wav", createWave());
    }
    if (request.method === "POST" && path === "/tts") return sendBytes(response, 200, "audio/wav", createWave());
    if (request.method === "POST" && path === "/t2a_v2") return sendJson(response, 200, { data: { audio: createWave().toString("hex") }, base_resp: { status_code: 0 } });
    if (request.method === "POST" && path === "/custom/audio") return sendJson(response, 200, { data: { audio_url: `${url.origin}/media/fixture.wav` } });
    if (request.method === "GET" && path === "/media/fixture.wav") return sendBytes(response, 200, "audio/wav", createWave());
    if ((request.method === "POST" || request.method === "DELETE") && /\/(?:cancel|videos\/[^/]+)$/.test(path)) {
        const id = videoTaskId(path.replace(/\/cancel$/, ""));
        if (id && tasks.has(id)) tasks.set(id, { ...tasks.get(id), status: "cancelled" });
        return sendJson(response, 200, { status: "cancelled" });
    }

    sendJson(response, 404, { error: { message: `fixture route not found: ${request.method} ${url.pathname}` } });
}

function selectedToolName(payload) {
    const choice = payload.tool_choice;
    if (choice?.name) return choice.name;
    if (choice?.function?.name) return choice.function.name;
    const tool = Array.isArray(payload.tools) ? payload.tools[0] : undefined;
    const explicit = tool?.name || tool?.function?.name || "";
    if (explicit) return explicit;
    const source = JSON.stringify(payload);
    return ["create_agent_plan", "plan_workbench_action", "review_creative_outputs", "analyze_drama_content", "design_drama_visuals", "decompose_ecommerce_image", "make_plan"].find((name) => source.includes(name)) || "";
}

function toolArguments(name, payload) {
    if (name === "decompose_ecommerce_image") {
        const { width, height } = imageRequestDimensions(payload);
        if (width === 640 && height === 960) {
            return {
                strategy: "subject",
                backgroundDescription: "人物后的摄影背景",
                backgroundPreservedVisuals: [],
                layers: [],
            };
        }
        if (width === 1000 && height === 801) {
            return {
                strategy: "ecommerce",
                backgroundDescription: "浅灰电商测试背景",
                backgroundPreservedVisuals: [],
                layers: Array.from({ length: 20 }, (_, index) => fixtureLayer("product", `元素 ${String(index + 1).padStart(2, "0")}`, 40 + (index % 5) * 190, 40 + Math.floor(index / 5) * 180, 120, 120, index + 1)),
            };
        }
        if (width === 1200 && height === 720) {
            return {
                strategy: "ecommerce",
                backgroundDescription: "浅灰蓝电商背景",
                backgroundPreservedVisuals: [],
                layers: [
                    fixtureLayer("product", "商品组合", 240, 180, 624, 468, 3, [
                        [395, 355],
                        [595, 330],
                        [525, 495],
                        [720, 450],
                    ]),
                    fixtureLayer(
                        "headline",
                        "主标题",
                        52,
                        40,
                        620,
                        76,
                        5,
                        Array.from({ length: 8 }, (_, index) => [87 + index * 78, 77]),
                    ),
                    fixtureLayer("logo", "品牌 Logo", 968, 36, 164, 72, 7, [[1050, 72]]),
                    fixtureLayer("badge", "促销角标", 914, 175, 140, 140, 6, [[984, 245]]),
                    fixtureLayer("decoration", "前景装饰", 35, 465, 220, 170, 1, [
                        [92, 550],
                        [158, 525],
                        [205, 580],
                    ]),
                ],
            };
        }
        return {
            strategy: "ecommerce",
            backgroundDescription: "协议夹具蓝色渐变背景",
            backgroundPreservedVisuals: ["蓝色渐变", "柔和环境光"],
            layers: [
                fixtureLayer("product", "商品组合", width * 0.2, height * 0.25, width * 0.52, height * 0.65, 3),
                fixtureLayer("headline", "主标题", width * 0.05, height * 0.05, width * 0.55, height * 0.12, 5),
                fixtureLayer("logo", "品牌 Logo", width * 0.8, height * 0.05, width * 0.15, height * 0.1, 7),
                fixtureLayer("badge", "促销角标", width * 0.72, height * 0.25, width * 0.2, height * 0.18, 6),
                fixtureLayer("decoration", "前景装饰", width * 0.03, height * 0.65, width * 0.18, height * 0.28, 1),
            ],
        };
    }
    if (name === "create_agent_plan") {
        if (plannerGenerationMode(payload) === "video") {
            return {
                intent: "generation",
                objective: "验证视频工作台完整生成链路",
                audience: "协议测试用户",
                reply: "已收到，我会生成一段协议测试视频。",
                decisions: [{ label: "视频模型", value: "e2e-video", reason: "使用本地协议测试模型" }],
                foundation: {
                    complexity: "simple",
                    brief: { objective: "验证视频工作台完整生成链路" },
                    direction: { summary: "清晰的蓝色横版测试视频" },
                },
                deliverables: [
                    {
                        id: "fixture-video",
                        title: "协议测试视频",
                        type: "video",
                        model: "e2e-video",
                        prompt: "内部协议视频执行提示：镜头缓慢推进",
                        count: 1,
                        ratio: "16:9",
                        quality: "720",
                        seconds: 5,
                        dependencies: [],
                    },
                ],
            };
        }
        const imageAndVideo = /图片.*视频|视频.*图片/.test(plannerRequestText(payload));
        if (imageAndVideo) {
            return {
                intent: "generation",
                objective: "验证 Agent 图片与视频完整生成链路",
                audience: "协议测试用户",
                reply: "已收到，我会生成一张图片和一段视频。",
                decisions: [
                    { label: "图片模型", value: "e2e-image", reason: "使用本地协议测试模型" },
                    { label: "视频模型", value: "e2e-video", reason: "使用本地协议测试模型" },
                ],
                foundation: {
                    complexity: "simple",
                    brief: { objective: "验证 Agent 图片与视频完整生成链路" },
                    direction: { summary: "清晰的蓝色横版测试画面" },
                },
                deliverables: [
                    {
                        id: "fixture-image",
                        title: "协议测试图片",
                        type: "image",
                        model: "e2e-image",
                        prompt: "内部协议图片执行提示：生成蓝色横版测试画面",
                        count: 1,
                        ratio: "16:9",
                        quality: "high",
                        dependencies: [],
                    },
                    {
                        id: "fixture-video",
                        title: "协议测试视频",
                        type: "video",
                        model: "e2e-video",
                        prompt: "内部协议视频执行提示：镜头缓慢推进",
                        count: 1,
                        ratio: "16:9",
                        quality: "720",
                        seconds: 5,
                        dependencies: [],
                    },
                ],
            };
        }
        return {
            intent: "generation",
            objective: "验证 Canvas Agent 稳定生成链路",
            audience: "协议测试用户",
            reply: "已收到，我会生成一张横版协议测试图片。",
            decisions: [{ label: "模型", value: "mock-image", reason: "使用本地协议测试模型" }],
            foundation: {
                complexity: "simple",
                brief: { objective: "验证 Canvas Agent 稳定生成链路" },
                direction: { summary: "清晰的蓝色横版测试画面" },
            },
            deliverables: [{ id: "fixture-image", title: "协议测试图片", type: "image", model: "mock-image", prompt: "生成一张蓝色横版协议测试图片", count: 1, ratio: "16:9", quality: "high", dependencies: [] }],
        };
    }
    if (name === "plan_workbench_action") {
        return {
            intent: "generation",
            foundation: { complexity: "simple", brief: { objective: "验证工作台协议生成" }, direction: { summary: "清晰的蓝色测试画面" } },
            deliverables: [{ title: "协议测试图片", type: "image", role: "主画面" }],
            parameterPatch: { model: "mock-image", size: "1024x1024", quality: "high", count: 1 },
            resolvedPrompt: "生成一张蓝色协议测试图片",
            shouldGenerate: true,
            reply: "已收到，我会生成协议测试图片。",
            decisions: [{ label: "模型", value: "mock-image", reason: "本地协议测试" }],
            choices: [],
        };
    }
    if (name === "review_creative_outputs") return { mode: "visual", status: "passed", score: 100, summary: "协议测试产物通过", issues: [], retryTaskIds: [] };
    if (name === "analyze_drama_content") {
        const sourceText = dramaSourceText(payload) || "主角推门说：测试开始。";
        return {
            episode: { outline: "主角进入测试场景并完成一句对白。", hook: "门突然打开。", nextPreview: "下一幕继续。", sourceRange: "全文" },
            characters: [{ name: "主角", description: "协议测试角色" }],
            scenes: [{ name: "测试房间", description: "明亮整洁的房间" }],
            props: [],
            clues: [],
            shots: [
                {
                    title: "进入房间",
                    description: sourceText,
                    sourceText,
                    shotBoundary: "角色进入形成新镜头",
                    dialogue: "测试开始。",
                    narration: "",
                    utterances: [{ type: "dialogue", speaker: "主角", text: "测试开始。" }],
                    duration: 5,
                    characterNames: ["主角"],
                    sceneName: "测试房间",
                    propNames: [],
                    clueNames: [],
                },
            ],
        };
    }
    if (name === "design_drama_visuals") {
        return {
            shots: [
                {
                    shotId: firstShotId(payload) || "shot-1",
                    imagePrompt: "主角推门进入明亮房间",
                    videoPrompt: "镜头缓慢推进，主角推门进入",
                    cameraMotion: "缓慢推进",
                    startFramePrompt: "关闭的房门",
                    endFramePrompt: "主角站在房间中央",
                    negativePrompt: "模糊，畸形",
                    continuity: {
                        shotSize: "中景",
                        cameraAngle: "平视",
                        composition: "主体居中",
                        characterBlocking: "主角从左向右进入",
                        gazeDirection: "看向前方",
                        actionStart: "推门",
                        actionEnd: "站定",
                        screenDirection: "左到右",
                        axisRule: "保持180度轴线",
                        continuityNotes: "保持角色服装和场景一致",
                    },
                },
            ],
        };
    }
    return {};
}

function plannerRequestText(payload) {
    const messages = [...(Array.isArray(payload.input) ? payload.input : []), ...(Array.isArray(payload.messages) ? payload.messages : [])];
    const userMessage = messages.findLast((message) => message?.role === "user");
    const content = userMessage?.content ?? (typeof payload.input === "string" ? payload.input : "");
    return typeof content === "string" ? content : JSON.stringify(content);
}

function dramaSourceText(payload) {
    try {
        const value = JSON.parse(plannerRequestText(payload));
        return typeof value?.script === "string" ? value.script.trim() : "";
    } catch {
        return "";
    }
}

function plannerGenerationMode(payload) {
    try {
        const value = JSON.parse(plannerRequestText(payload));
        return ["image", "video", "audio"].includes(value?.generationPreferences?.mode) ? value.generationPreferences.mode : "";
    } catch {
        return "";
    }
}

function imageRequestDimensions(payload) {
    const match = plannerRequestText(payload).match(/(\d+)x(\d+)/i);
    return { width: Math.max(1, Number(match?.[1]) || 1024), height: Math.max(1, Number(match?.[2]) || 1024) };
}

function fixtureLayer(kind, name, x, y, width, height, zIndex, focusPoints = []) {
    const bbox = { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    return {
        id: `${kind}-${zIndex}`,
        groupId: `${kind}-${zIndex}`,
        kind,
        name,
        bbox,
        focusPoints: focusPoints.length ? focusPoints.map(([pointX, pointY]) => ({ x: pointX, y: pointY })) : [{ x: bbox.x + Math.round(bbox.width / 2), y: bbox.y + Math.round(bbox.height / 2) }],
        zIndex,
        confidence: 0.95,
    };
}

function firstShotId(payload) {
    const source = JSON.stringify(payload.input || payload.messages || "");
    return source.match(/shot-[A-Za-z0-9_-]+/)?.[0] || "";
}

function videoTaskId(path) {
    const patterns = [/^\/videos\/([^/]+)$/, /^\/contents\/generations\/tasks\/([^/]+)$/, /^\/seedance\/api\/v3\/contents\/generations\/tasks\/([^/]+)$/, /^\/result\/([^/]+)$/];
    for (const pattern of patterns) {
        const match = path.match(pattern);
        if (match) return decodeURIComponent(match[1]);
    }
    return "";
}

function fixturePath(pathname, mountPrefixes = []) {
    const internal = pathname.replace(/^\/api\/ai\/system\/[^/]+(?=\/)/, "");
    const mounted = mountPrefixes.reduce((path, prefix) => (path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : path), internal);
    return mounted.replace(/^\/(?:api\/v3|v1beta|v1)(?=\/)/, "");
}

function createWave() {
    const sampleRate = 8_000;
    const samples = 800;
    const dataSize = samples * 2;
    const wave = Buffer.alloc(44 + dataSize);
    wave.write("RIFF", 0);
    wave.writeUInt32LE(36 + dataSize, 4);
    wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(sampleRate, 24);
    wave.writeUInt32LE(sampleRate * 2, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write("data", 36);
    wave.writeUInt32LE(dataSize, 40);
    for (let index = 0; index < samples; index += 1) wave.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 4_000), 44 + index * 2);
    return wave;
}

function fixtureImage(options) {
    return options.imagePath ? readFile(options.imagePath) : Promise.resolve(Buffer.from(PNG_BASE64, "base64"));
}

async function layeredFixtureImages(body, contentType, options) {
    const sourceBytes = (await multipartImage(body, contentType)) || (await fixtureImage(options));
    const { data, info } = await sharp(sourceBytes, { failOn: "error" }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const element = Buffer.alloc(data.length);
    const background = Buffer.from(data);
    const backgroundPixel = data.subarray(0, 4);
    let hasElement = false;
    let hasBackground = false;
    for (let offset = 0; offset < data.length; offset += 4) {
        const isBackground = data[offset] === backgroundPixel[0] && data[offset + 1] === backgroundPixel[1] && data[offset + 2] === backgroundPixel[2] && data[offset + 3] === backgroundPixel[3];
        if (isBackground) {
            hasBackground = true;
            continue;
        }
        hasElement = true;
        data.copy(element, offset, offset, offset + 4);
        backgroundPixel.copy(background, offset);
    }
    if (!hasElement || !hasBackground) throw new Error("layer fixture source must contain a visible element and background");
    const raw = { width: info.width, height: info.height, channels: 4 };
    return Promise.all([sharp(element, { raw }).png().toBuffer(), sharp(background, { raw }).png().toBuffer()]);
}

async function multipartImage(body, contentType) {
    if (!String(contentType).toLowerCase().startsWith("multipart/form-data")) return null;
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    const file = form.getAll("image").find((value) => value instanceof Blob);
    return file ? Buffer.from(await file.arrayBuffer()) : null;
}

async function readRequestBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function jsonBody(body) {
    try {
        return JSON.parse(body.toString("utf8") || "{}");
    } catch {
        return {};
    }
}

function requestedModel(body, contentType = "") {
    if (String(contentType).includes("application/json")) {
        const payload = jsonBody(body);
        return String(payload.model || payload.deployment || "");
    }
    const text = body.toString("utf8");
    return text.match(/name="model"\r?\n\r?\n([^\r\n]+)/i)?.[1]?.trim() || "";
}

function requestsTransparentBackground(body, contentType = "") {
    if (String(contentType).includes("application/json")) return jsonBody(body).background === "transparent";
    return /name="background"\r?\n\r?\ntransparent(?:\r?\n|$)/i.test(body.toString("utf8"));
}

function requestsLayeredOutput(body) {
    return body.toString("utf8").includes("分层任务要求");
}

function shouldFailRequest(request, model) {
    if (!model) return false;
    if (model.includes("-fail")) return true;
    return model.includes("-fallback") && String(request.headers.authorization || "").includes("e2e-primary-secret");
}

function sendJson(response, status, value) {
    sendBytes(response, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(value)));
}

function sendBytes(response, status, contentType, bytes) {
    response.writeHead(status, { "content-type": contentType, "content-length": bytes.length, "cache-control": "no-store" });
    response.end(bytes);
}

async function sendStructuredTextStream(response, path, toolName, argumentsText, format = "sse", inputTokenDetails = { cached_tokens: 2, cache_write_tokens: 1 }, model = "mock-text", nativeCache = {}) {
    const isResponses = path === "/responses";
    const isChat = path === "/chat/completions" || path === "/messages";
    response.writeHead(200, { "content-type": format === "ndjson" ? "application/x-ndjson" : "text/event-stream", "cache-control": "no-store" });
    if (format === "ndjson") {
        const payload = JSON.stringify({ modelVersion: "mock-text", candidates: [{ index: 0, content: { parts: [{ text: argumentsText }] }, finishReason: "STOP" }] });
        const splitAt = Math.max(1, Math.floor(payload.length / 2));
        response.write(payload.slice(0, splitAt));
        await new Promise((resolve) => setImmediate(resolve));
        response.write(`${payload.slice(splitAt)}\n`);
        response.write(`${JSON.stringify({ usageMetadata: { serviceTier: "default", promptTokenCount: 8, cachedContentTokenCount: 2, candidatesTokenCount: 8, thoughtsTokenCount: 1, totalTokenCount: 17 } })}\n`);
        response.end();
        return;
    }
    const payload = isResponses ? { type: "response.output_text.delta", delta: argumentsText } : isChat ? { model, service_tier: "default", choices: [{ index: 0, delta: { content: argumentsText } }] } : { data: { plan: argumentsText } };
    const event = `data: ${JSON.stringify(payload)}\n\n`;
    if (isResponses) response.write(`data: ${JSON.stringify({ type: "response.created", response: { model, service_tier: "default" } })}\n\n`);
    response.write(event.slice(0, Math.max(1, Math.floor(event.length / 2))));
    await new Promise((resolve) => setImmediate(resolve));
    response.write(event.slice(Math.max(1, Math.floor(event.length / 2))));
    if (isResponses) response.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 8, input_tokens_details: inputTokenDetails } } })}\n\n`);
    else if (isChat)
        response.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 8, prompt_tokens_details: inputTokenDetails, ...nativeCache } })}\n\n`,
        );
    response.write("data: [DONE]\n\n");
    response.end();
}

function jsonRequested(payload) {
    return typeof payload.system === "string" && payload.system.includes("JSON");
}

function sendAnthropicTextStream(response, model, content) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("message_start", {
        message: {
            model,
            content: [],
            usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 }, service_tier: "standard", inference_geo: "global" },
        },
    });
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: content } });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } });
    emit("message_stop", {});
    response.end();
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
    const port = Number(process.env.VOZEB_PRO_PROTOCOL_FIXTURE_PORT) || 4010;
    const host = process.env.VOZEB_PRO_PROTOCOL_FIXTURE_HOST || "127.0.0.1";
    const fixture = createProtocolFixtureServer({
        imagePath: process.env.VOZEB_PRO_PROTOCOL_FIXTURE_IMAGE,
        videoPath: process.env.VOZEB_PRO_PROTOCOL_FIXTURE_VIDEO,
        responseDelayMs: process.env.VOZEB_PRO_PROTOCOL_FIXTURE_DELAY_MS,
        failImage: process.env.VOZEB_PRO_PROTOCOL_FIXTURE_FAIL_IMAGE === "1",
    });
    fixture.server.listen(port, host, () => console.log(`Protocol fixture ready at http://${host}:${port}`));
}
