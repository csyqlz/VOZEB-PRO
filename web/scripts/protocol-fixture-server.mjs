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
            requests.push({ method: request.method || "GET", path: url.pathname, search: url.search, headers: request.headers, contentType: request.headers["content-type"] || "", body });
            await handleFixtureRequest({ request, response, url, body, tasks, requests, nextTaskId, options });
        } catch (error) {
            sendJson(response, 500, { error: { message: error instanceof Error ? error.message : "fixture failed" } });
        }
    });
    return { server, requests, tasks };
}

async function handleFixtureRequest({ request, response, url, body, tasks, requests, nextTaskId, options }) {
    const path = fixturePath(url.pathname);
    const responseDelayMs = Math.max(0, Number(options.responseDelayMs) || 0);
    if (request.method === "POST" && responseDelayMs) await delay(responseDelayMs);
    if (request.method === "GET" && path === "/health") return sendJson(response, 200, { ok: true });
    if (request.method === "GET" && path === "/__state") {
        return sendJson(response, 200, {
            requests: requests
                .filter((item) => !item.path.endsWith("/__state"))
                .map((item) => ({
                    method: item.method,
                    path: item.path,
                    authorization: item.headers.authorization || "",
                    contentType: item.contentType,
                    bodyBytes: item.body.byteLength,
                    model: requestedModel(item.body, item.contentType),
                })),
            tasks: Array.from(tasks.entries()).map(([id, task]) => ({ id, ...task })),
        });
    }
    if (request.method === "POST" && path === "/__reset") {
        requests.splice(0, requests.length);
        tasks.clear();
        return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && path === "/__ecommerce-analysis-failure") {
        options.failEcommerceAnalysis = jsonBody(body).enabled === true;
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
        const catalog = url.searchParams.has("protocol") ? [...models, { id: "opaque-catalog-model" }] : models;
        return sendJson(response, 200, { object: "list", data: catalog });
    }
    if (request.method === "GET" && path === "/sdapi/v1/sd-models") {
        return sendJson(response, 200, [{ title: "mock-image", model_name: "mock-image", id: "mock-image" }, ...(url.searchParams.has("protocol") ? [{ id: "opaque-catalog-model" }] : [])]);
    }

    if (request.method === "POST" && ["/responses", "/chat/completions", "/messages"].includes(path)) {
        const payload = jsonBody(body);
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (shouldFailRequest(request, model)) return sendJson(response, model.includes("-fail") ? 400 : 503, { error: { message: "fixture text failure" } });
        const toolName = selectedToolName(payload);
        if (toolName === "analyze_ecommerce_references" && options.failEcommerceAnalysis) return sendJson(response, 503, { error: { message: "fixture analysis service unavailable" } });
        const argumentsText = toolName ? JSON.stringify(await toolArguments(toolName, payload)) : "协议测试文本返回成功";
        if (payload.stream === true) return sendStructuredTextStream(response, path, toolName, argumentsText);
        if (path === "/responses") {
            return sendJson(response, 200, toolName ? { output: [{ type: "function_call", name: toolName, arguments: argumentsText }] } : { output_text: argumentsText });
        }
        if (path === "/messages") {
            return sendJson(response, 200, toolName ? { content: [{ type: "tool_use", id: "tool-fixture", name: toolName, input: JSON.parse(argumentsText) }] } : { content: [{ type: "text", text: argumentsText }] });
        }
        return sendJson(response, 200, {
            choices: [
                {
                    message: toolName ? { role: "assistant", content: "", tool_calls: [{ id: "tool-fixture", type: "function", function: { name: toolName, arguments: argumentsText } }] } : { role: "assistant", content: argumentsText },
                },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        });
    }

    if (request.method === "POST" && /\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) {
        const payload = jsonBody(body);
        if (payload.generationConfig?.responseModalities?.includes("IMAGE")) {
            return sendJson(response, 200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: (await fixtureImage(options)).toString("base64") } }] } }] });
        }
        const toolName = selectedToolName(payload);
        const text = toolName ? JSON.stringify(await toolArguments(toolName, payload)) : "协议测试文本返回成功";
        if (path.endsWith(":streamGenerateContent")) return sendStructuredTextStream(response, path, toolName, text, url.searchParams.get("alt") === "sse" ? "gemini-sse" : "ndjson");
        return sendJson(response, 200, { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 8, totalTokenCount: 16 } });
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
        if (options.sub2apiImageEdits) {
            const payload = jsonBody(body);
            // sub2api 86f93c28 only reads images[].image_url and mask.image_url on edits.
            const inputs = path === "/images/edits" && Array.isArray(payload.images) ? payload.images.map((image) => image?.image_url).filter((url) => typeof url === "string" && url.trim()) : [];
            if (!inputs.length) return sendJson(response, 400, { error: { message: "image input is required" } });
            if (payload.mask && typeof payload.mask.image_url !== "string") return sendJson(response, 400, { error: { message: "mask.image_url is required" } });
        }
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (options.failImage || shouldFailRequest(request, model)) return sendJson(response, options.failImage || model.includes("-fail") ? 400 : 503, { error: { message: "fixture image failure" } });
        const image = await openAiFixtureImage(body, request.headers["content-type"] || "", options);
        if (options.ecommerceAsyncImage) {
            const id = nextTaskId("ecommerce-image");
            tasks.set(id, { kind: "ecommerce-image", status: "completed", image });
            return sendJson(response, 200, { task_id: id, status: "queued", poll_url: `${url.origin}/v1/images/tasks/${id}` });
        }
        const images = requestsLayeredOutput(body) ? await layeredFixtureImages(body, request.headers["content-type"] || "", options) : [image];
        return sendJson(response, 200, { created: Math.floor(Date.now() / 1000), data: images.map((item) => ({ b64_json: item.toString("base64"), revised_prompt: "protocol fixture" })) });
    }
    const ecommerceImageTaskId = path.match(/^\/images\/tasks\/(.+)$/)?.[1];
    if (request.method === "GET" && ecommerceImageTaskId) {
        const task = tasks.get(ecommerceImageTaskId);
        if (!task || task.kind !== "ecommerce-image") return sendJson(response, 404, { error: { message: "ecommerce fixture task missing" } });
        return sendJson(response, 200, { task_id: ecommerceImageTaskId, status: task.status, data: [{ b64_json: task.image.toString("base64") }] });
    }
    if (request.method === "POST" && ["/sdapi/v1/txt2img", "/sdapi/v1/img2img"].includes(path)) {
        return sendJson(response, 200, { images: [(await fixtureImage(options)).toString("base64")], info: "{}" });
    }
    if (request.method === "POST" && path === "/custom/images") {
        if (requestsLayeredOutput(body)) return sendJson(response, 200, { data: { layers: [`${url.origin}/media/fixture.png?layer=1`, `${url.origin}/media/fixture.png?layer=2`] } });
        return sendJson(response, 200, { data: { image_url: `${url.origin}/media/fixture.png` } });
    }

    if (request.method === "POST" && (GLOBAL_AIOPC_VIDEO_PATHS.has(path) || ["/videos", "/contents/generations/tasks", "/seedance-special/videos"].includes(path))) {
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (shouldFailRequest(request, model)) return sendJson(response, model.includes("-fail") ? 400 : 503, { error: { message: "fixture video failure" } });
        const id = nextTaskId("video");
        tasks.set(id, { kind: "video", status: model.includes("-slow") ? "pending" : "completed" });
        return sendJson(response, 200, { id, task_id: id, status: "queued" });
    }
    if (request.method === "POST" && path === "/videos/generations") {
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
    if (request.method === "GET" && videoId) {
        const mediaUrl = `${url.origin}/media/fixture.mp4`;
        const task = tasks.get(videoId);
        if (task?.kind === "image") return sendJson(response, 200, { task_id: videoId, status: "completed", image_url: `${url.origin}/media/fixture.png` });
        if (task?.status === "pending") return sendJson(response, 200, { id: videoId, task_id: videoId, status: "processing" });
        if (task?.status === "cancelled") return sendJson(response, 200, { id: videoId, task_id: videoId, status: "cancelled" });
        return sendJson(response, 200, { id: videoId, task_id: videoId, status: "completed", video_url: mediaUrl, content: { video_url: mediaUrl }, result: { video_url: mediaUrl } });
    }
    if (request.method === "GET" && path === "/media/fixture.mp4") {
        const bytes = options.videoPath ? await readFile(options.videoPath) : FALLBACK_MP4;
        return sendBytes(response, 200, "video/mp4", bytes);
    }
    if (request.method === "GET" && path === "/media/fixture.png") return sendBytes(response, 200, "image/png", await fixtureImage(options));

    if (request.method === "POST" && path === "/audio/speech") {
        const model = requestedModel(body, request.headers["content-type"] || "");
        if (shouldFailRequest(request, model)) return sendJson(response, model.includes("-fail") ? 400 : 503, { error: { message: "fixture audio failure" } });
        return sendBytes(response, 200, "audio/wav", createWave());
    }
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
    return (
        [
            "create_agent_plan",
            "plan_workbench_action",
            "review_creative_outputs",
            "analyze_ecommerce_references",
            "plan_ecommerce_edit",
            "check_ecommerce_results",
            "analyze_drama_content",
            "design_drama_visuals",
            "decompose_ecommerce_image",
            "make_plan",
        ].find((name) => source.includes(name)) || ""
    );
}

async function toolArguments(name, payload) {
    if (name === "analyze_ecommerce_references") return ecommerceVisualAnalysisArguments(payload);
    if (name === "plan_ecommerce_edit") return ecommerceEditPlanArguments(payload);
    if (name === "check_ecommerce_results") return ecommerceQualityArguments(payload);
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
        const imageAndVideo = plannerGenerationMode(payload) !== "image" && /图片.*视频|视频.*图片/.test(plannerRequestText(payload));
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

async function ecommerceVisualAnalysisArguments(payload) {
    const input = structuredUserPayloads(payload).find((value) => Array.isArray(value?.assets)) || {};
    const assets = Array.isArray(input.assets) ? input.assets : [];
    const imageEvidence = await Promise.all(ecommerceImageDataUrls(payload).map(fixtureImageBackgroundEvidence));
    const userRequest = String(input.userRequest || "");
    const ambiguous = /无法判断角色/.test(userRequest) || assets.some((asset) => /ambiguous/i.test(String(asset?.title || "")));
    const localEdit = /再亮一点|较早结果|背景改成|局部|去掉|移除/.test(userRequest);
    const version = ecommerceToolProperties(payload).analysisVersion?.enum?.[0] || "ecommerce-visual-analysis.v1";
    const sceneOnly = /只加柜面花瓶|无商品锚点|场景只加花瓶/.test(userRequest);
    return {
        analysisVersion: version,
        ...(version === "ecommerce-visual-analysis.v4" ? { purposeSuggestions: [] } : {}),
        references: assets.map((asset, index) => {
            const assetId = String(asset?.id || "");
            if (ambiguous) {
                const unknown = { ...unknownEcommerceReference(assetId), ...(version !== "ecommerce-visual-analysis.v1" ? { visibleStructure: [] } : {}) };
                if (version === "ecommerce-visual-analysis.v4") {
                    delete unknown.role;
                    return { ...unknown, contentType: "unknown", cues: [] };
                }
                return unknown;
            }
            const role = !sceneOnly && (assets.length === 1 || (!localEdit && index === 0) || (localEdit && index === 1)) ? "product" : "scene";
            const reference = role === "product" ? productEcommerceReference(assetId, imageEvidence[index]) : sceneEcommerceReference(assetId, localEdit);
            if (version !== "ecommerce-visual-analysis.v1") reference.visibleStructure = fixtureVisibleStructure(userRequest, asset.width, asset.height);
            if (version === "ecommerce-visual-analysis.v3") reference.photographyFacts = fixturePhotography();
            if (version === "ecommerce-visual-analysis.v4") {
                delete reference.role;
                return {
                    ...reference,
                    contentType: role === "product" ? "isolated_product" : "interior_scene",
                    cues: [
                        { id: `${assetId}-style`, facet: "style", description: "simple contemporary appearance", confidence: "high" },
                        { id: `${assetId}-lighting`, facet: "lighting", description: "soft natural window light", confidence: "high" },
                        { id: `${assetId}-composition`, facet: "composition", description: "eye-level composition", confidence: "high" },
                    ],
                };
            }
            return reference;
        }),
    };
}

function ecommerceToolProperties(payload) {
    const tool = (payload.tools || []).flatMap((item) => item.functionDeclarations || [item]).find((item) => item.name === selectedToolName(payload) || item.function?.name === selectedToolName(payload));
    const schema = tool?.parameters || tool?.input_schema || tool?.function?.parameters;
    if (schema) return schema.properties || {};
    const messages = [...(Array.isArray(payload.input) ? payload.input : []), ...(Array.isArray(payload.messages) ? payload.messages : []), ...(payload.systemInstruction ? [{ role: "system", content: payload.systemInstruction.parts }] : [])];
    const system = messages.find((item) => item.role === "system")?.content;
    const text = typeof system === "string" ? system : Array.isArray(system) ? system.map((part) => part.text || "").join("\n") : "";
    const schemaText = text.split("JSON 必须符合以下 Schema：")[1]?.split("\n\n")[0];
    try {
        return schemaText ? JSON.parse(schemaText).properties || {} : {};
    } catch {
        return {};
    }
}

function fixtureVisibleStructure(request, width = 1, height = 1, count = 3) {
    // These deterministic observations simulate the QA contract, not model vision.
    const cabinet = /三层抽屉柜/.test(request);
    return [{ objectId: cabinet ? "cabinet" : "fixture-subject", feature: cabinet ? "drawers" : "legs", count: cabinet ? count : 2, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width, height } }];
}

function fixturePhotography() {
    return {
        materials: [{ objectId: "cabinet", textureDirection: "vertical visible grain", textureScale: "fine grain", roughness: "matte", gloss: "low gloss" }],
        lighting: { keyLight: "existing broad window light", fillLight: "existing ambient fill", whiteBalance: "neutral", contactShadow: "soft contact shadow" },
        composition: { focalSubject: "furniture", depth: "existing room depth", negativeSpace: "existing clear area" },
    };
}

function productEcommerceReference(assetId, evidence) {
    const background = evidence || { whiteBackground: false, transparentBackground: true };
    const isolatedSubject = background.whiteBackground || background.transparentBackground;
    return {
        assetId,
        role: "product",
        confidence: isolatedSubject ? "high" : "low",
        visualEvidence: { ...background, isolatedSubject, completeScene: false },
        productFacts: { identity: "ecommerce fixture product", outline: "complete product silhouette", color: "original neutral color", material: "original visible material", brandText: [], view: "front three-quarter view" },
        sceneFacts: null,
        productCore: { x: 0.2, y: 0.15, width: 0.6, height: 0.7 },
        fusionHalo: { x: 0.15, y: 0.1, width: 0.7, height: 0.8 },
        editableTargets: [],
    };
}

function ecommerceImageDataUrls(payload) {
    const urls = [];
    const visit = (value) => {
        if (typeof value === "string") {
            if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) urls.push(value);
            return;
        }
        if (!value || typeof value !== "object") return;
        if (value.source?.type === "base64" && typeof value.source.media_type === "string" && typeof value.source.data === "string") {
            urls.push(`data:${value.source.media_type};base64,${value.source.data}`);
            return;
        }
        if (value.inlineData && typeof value.inlineData.mimeType === "string" && typeof value.inlineData.data === "string") {
            urls.push(`data:${value.inlineData.mimeType};base64,${value.inlineData.data}`);
            return;
        }
        for (const item of Array.isArray(value) ? value : Object.values(value)) visit(item);
    };
    visit(payload.input);
    visit(payload.messages);
    visit(payload.contents);
    return urls;
}

async function fixtureImageBackgroundEvidence(source) {
    const match = source.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\r\n]+)$/i);
    if (!match) return null;
    try {
        const decoded = await sharp(Buffer.from(match[1], "base64")).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const { width, height, channels } = decoded.info;
        if (!width || !height || channels !== 4) return null;
        const border = new Set();
        for (let x = 0; x < width; x += 1) {
            border.add(x);
            border.add((height - 1) * width + x);
        }
        for (let y = 0; y < height; y += 1) {
            border.add(y * width);
            border.add(y * width + width - 1);
        }
        let transparent = 0;
        let white = 0;
        for (const index of border) {
            const offset = index * channels;
            const alpha = decoded.data[offset + 3];
            if (alpha <= 24) transparent += 1;
            const red = decoded.data[offset];
            const green = decoded.data[offset + 1];
            const blue = decoded.data[offset + 2];
            const minimum = Math.min(red, green, blue);
            const maximum = Math.max(red, green, blue);
            if (minimum >= 240 && maximum - minimum <= 10) white += 1;
        }
        if (transparent / border.size >= 0.9) return { whiteBackground: false, transparentBackground: true };
        if (white / border.size >= 0.9) return { whiteBackground: true, transparentBackground: false };
        return { whiteBackground: false, transparentBackground: false };
    } catch {
        return null;
    }
}

function sceneEcommerceReference(assetId, containsProtectedProduct) {
    return {
        assetId,
        role: "scene",
        confidence: "high",
        visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
        productFacts: null,
        sceneFacts: { space: "modern European or American home interior", composition: "eye-level product-centered composition", lighting: "soft natural daylight" },
        productCore: containsProtectedProduct ? { x: 0.35, y: 0.25, width: 0.3, height: 0.5 } : null,
        fusionHalo: containsProtectedProduct ? { x: 0.3, y: 0.2, width: 0.4, height: 0.6 } : null,
        editableTargets: [
            { id: "background-main", kind: "background", label: "main room background", region: { x: 0, y: 0, width: 1, height: 1 } },
            { id: "lighting-main", kind: "lighting", label: "room daylight", region: { x: 0, y: 0, width: 1, height: 1 } },
            { id: "plant-right", kind: "prop", label: "right plant", region: { x: 0.75, y: 0.2, width: 0.18, height: 0.55 } },
        ],
    };
}

function unknownEcommerceReference(assetId) {
    return {
        assetId,
        role: "unknown",
        confidence: "low",
        visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false },
        productFacts: null,
        sceneFacts: null,
        productCore: null,
        fusionHalo: null,
        editableTargets: [],
    };
}

function ecommerceEditPlanArguments(payload) {
    const input = structuredUserPayloads(payload).find((value) => value?.sources && value?.requiredModelRoles) || {};
    const sources = input.sources || {};
    const analysis = input.visualAnalysis || {};
    const references = Array.isArray(analysis.references) ? analysis.references : [];
    const referenceDecision = input.referenceDecision;
    const product = references.find((reference) => (referenceDecision ? reference.assetId === referenceDecision.productAnchorId : reference?.role === "product")) || {};
    const scene = references.find((reference) => (referenceDecision ? reference.assetId === referenceDecision.currentSceneBaselineId : reference?.role === "scene")) || {};
    const roles = input.requiredModelRoles || {};
    const userRequest = String(input.userRequest || "");
    const localEdit = Boolean(sources.currentSceneBaselineId);
    const version = ecommerceToolProperties(payload).planVersion?.enum?.[0] || "ecommerce-edit.v1";
    const sceneOnly = !sources.productAnchorId;
    const localScope = /只加柜面花瓶|场景只加花瓶/.test(userRequest);
    const targetId = /亮|光/.test(userRequest) ? "lighting-main" : /植物|绿植/.test(userRequest) ? "plant-right" : "background-main";
    return {
        planVersion: version,
        ...(version === "ecommerce-edit.v6"
            ? {
                  referenceUses: references.map((reference) => {
                      const binding = referenceDecision?.bindings.find((item) => item.assetId === reference.assetId);
                      return {
                          assetId: reference.assetId,
                          alias: binding?.alias || null,
                          purposes: [...new Set([...(binding?.purposes || []), ...(reference.assetId === referenceDecision?.editTargetId ? ["edit_target"] : []), ...(reference.assetId === referenceDecision?.productAnchorId ? ["product_identity"] : [])])],
                          usedCueIds: [...new Set((referenceDecision?.appliedCues || []).filter((cue) => cue.assetId === reference.assetId).flatMap((cue) => cue.cueIds))],
                      };
                  }),
              }
            : {}),
        operation: sceneOnly ? "scene_edit" : localEdit ? "local_edit" : "product_to_scene",
        ...(version === "ecommerce-edit.v5" ? { photography: fixturePhotography() } : {}),
        ...(["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(version) ? { visibleStructure: (sceneOnly ? scene : product).visibleStructure || [] } : {}),
        ...(["ecommerce-edit.v3", "ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"].includes(version) && localEdit
            ? {
                  protection: {
                      scope: localScope ? "local" : "global",
                      protectedObjectIds: (sceneOnly ? scene : product).visibleStructure?.map((fact) => fact.objectId) || [],
                      preserveOutsideMask: localScope,
                      allowLightingChange: !localScope && /亮|光/.test(userRequest),
                  },
              }
            : {}),
        source: {
            productAnchorId: sources.productAnchorId || null,
            currentSceneBaselineId: sources.currentSceneBaselineId || null,
            sceneReferenceIds: Array.isArray(sources.sceneReferenceIds) ? sources.sceneReferenceIds : [],
        },
        baseline: {
            productFacts: sceneOnly
                ? null
                : version === "ecommerce-edit.v6"
                  ? product.productFacts || null
                  : product.productFacts || { identity: "ecommerce fixture product", outline: "complete product silhouette", color: "original neutral color", material: "original visible material", brandText: [], view: "front three-quarter view" },
            sceneFacts: version === "ecommerce-edit.v6" ? scene.sceneFacts || null : scene.sceneFacts || { space: "modern European or American home interior", composition: "eye-level product-centered composition", lighting: "soft natural daylight" },
        },
        delta: {
            requestedChanges: [userRequest || "place product in a modern home scene"],
            targetObjects: localEdit ? [targetId] : ["scene"],
            targetRegions: localEdit ? [] : ["background", "environment"],
        },
        preserve: { productCore: sceneOnly ? [] : ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: sceneOnly ? ["cabinet", "room", "camera"] : [] },
        strategy: sceneOnly ? "integrated_scene" : "strict_product",
        modelRoles: {
            visionAnalysis: String(roles.visionAnalysis || ""),
            editPlanning: String(roles.editPlanning || ""),
            generation: String(roles.generation || ""),
            qualityCheck: roles.qualityCheck === null ? null : String(roles.qualityCheck || ""),
        },
        continuity: { parentResultId: sources.parentResultId || null, branchId: String(input.continuity?.branchId || "ecommerce-fixture-branch") },
        validation: { requiredChecks: ["product_identity", "product_silhouette", "product_color_material", "product_proportions_view", "scene_intent", "composition_lighting"] },
    };
}

function ecommerceQualityArguments(payload) {
    const input = structuredUserPayloads(payload).find((value) => Array.isArray(value?.resultIds)) || {};
    const request = JSON.stringify(input.plan?.delta || {});
    const strictFailure = request.includes("[qa-silhouette-failure]");
    if (/验收解析失败/.test(request)) return { results: [] };
    const independent = Boolean(ecommerceToolProperties(payload).baselineObservation);
    const keys = ["product_identity", "product_silhouette", "product_color_material", "product_proportions_view", "brand_logo", "packaging_text", "scene_intent", "composition_lighting"];
    if (independent) keys.push("protected_structure", "protected_material", "unmodified_region");
    const observation = (result = false) => ({ readable: true, logo: "absent", packagingText: "absent", visibleStructure: fixtureVisibleStructure(request, 1, 1, result && /故意变成四层/.test(request) ? 4 : 3) });
    return {
        ...(independent ? { baselineObservation: observation(), productAnchorObservation: observation() } : {}),
        results: (Array.isArray(input.resultIds) ? input.resultIds : []).map((resultId) => ({
            resultId,
            ...(independent ? { observation: observation(true) } : {}),
            checks: keys.map((key) => ({
                key,
                status: (strictFailure && key === "product_silhouette") || (/光线不达标/.test(request) && key === "composition_lighting") ? "failed" : ["brand_logo", "packaging_text"].includes(key) ? "not_applicable" : "passed",
                reason: strictFailure && key === "product_silhouette" ? "fixture detected a changed product silhouette" : ["brand_logo", "packaging_text"].includes(key) ? "reference has no visible brand or packaging text" : "fixture comparison passed",
            })),
        })),
    };
}

function structuredUserPayloads(payload) {
    const messages = [
        ...(Array.isArray(payload.input) ? payload.input : []),
        ...(Array.isArray(payload.messages) ? payload.messages : []),
        ...(Array.isArray(payload.contents) ? payload.contents.map((item) => ({ role: item.role, content: item.parts })) : []),
    ];
    const userMessage = messages.findLast((message) => message?.role === "user");
    const content = userMessage?.content ?? (typeof payload.input === "string" ? payload.input : "");
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")) : [];
    return texts.flatMap((value) => {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed] : [];
        } catch {
            return [];
        }
    });
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
    const patterns = [/^\/videos\/([^/]+)$/, /^\/contents\/generations\/tasks\/([^/]+)$/, /^\/result\/([^/]+)$/];
    for (const pattern of patterns) {
        const match = path.match(pattern);
        if (match) return decodeURIComponent(match[1]);
    }
    return "";
}

function fixturePath(pathname) {
    const internal = pathname.replace(/^\/api\/ai\/system\/[^/]+(?=\/)/, "");
    return internal.replace(/^\/(?:api\/v3|v1beta|v1)(?=\/)/, "");
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

async function openAiFixtureImage(body, contentType, options) {
    const size = String(contentType).toLowerCase().startsWith("multipart/form-data") ? (await new Response(body, { headers: { "content-type": contentType } }).formData()).get("size") : jsonBody(body).size;
    const match = typeof size === "string" ? size.match(/^(\d+)x(\d+)$/i) : null;
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    const transparent = requestsTransparentBackground(body, contentType);
    if (!options.imagePath && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) {
        if (transparent) return sharp(Buffer.from(TRANSPARENT_PNG_BASE64, "base64")).resize(width, height, { fit: "fill" }).png().toBuffer();
        return sharp({ create: { width, height, channels: 4, background: "#2e7dff" } })
            .png()
            .toBuffer();
    }
    return transparent ? Buffer.from(TRANSPARENT_PNG_BASE64, "base64") : fixtureImage(options);
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

async function sendStructuredTextStream(response, path, toolName, argumentsText, format = "sse") {
    const isResponses = path === "/responses";
    const isChat = path === "/chat/completions" || path === "/messages";
    response.writeHead(200, { "content-type": format === "ndjson" ? "application/x-ndjson" : "text/event-stream", "cache-control": "no-store" });
    if (format === "ndjson") {
        const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: argumentsText }] } }] });
        const splitAt = Math.max(1, Math.floor(payload.length / 2));
        response.write(payload.slice(0, splitAt));
        await new Promise((resolve) => setImmediate(resolve));
        response.write(`${payload.slice(splitAt)}\n`);
        response.end();
        return;
    }
    const payload =
        format === "gemini-sse"
            ? { candidates: [{ content: { parts: [{ text: argumentsText }] } }] }
            : isResponses
              ? { type: "response.output_text.delta", delta: argumentsText }
              : isChat
                ? { choices: [{ delta: { content: argumentsText } }] }
                : { data: { plan: argumentsText } };
    const event = `data: ${JSON.stringify(payload)}\n\n`;
    response.write(event.slice(0, Math.max(1, Math.floor(event.length / 2))));
    await new Promise((resolve) => setImmediate(resolve));
    response.write(event.slice(Math.max(1, Math.floor(event.length / 2))));
    response.write("data: [DONE]\n\n");
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
