import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { validateImageLayerOutputs } from "../src/lib/server/image-layer-output";
import { createProtocolFixtureServer } from "./protocol-fixture-server.mjs";

let fixture;
let origin;
let temporaryDirectory;

beforeEach(async () => {
    fixture = createProtocolFixtureServer();
    await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    const address = fixture.server.address();
    origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
    await new Promise((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
});

describe("protocol fixture server", () => {
    it("serves a categorized model catalog and structured text tools", async () => {
        const catalog = await fetch(`${origin}/v1/models`).then((response) => response.json());
        expect(catalog.data.map((model) => model.capability)).toEqual(["text", "image", "video", "audio"]);

        const response = await fetch(`${origin}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tools: [{ type: "function", name: "create_agent_plan" }], tool_choice: { type: "function", name: "create_agent_plan" } }),
        }).then((value) => value.json());
        expect(JSON.parse(response.output[0].arguments)).toMatchObject({ intent: "generation", deliverables: [{ type: "image", model: "mock-image", ratio: "16:9" }] });

        const combined = await fetch(`${origin}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                input: "生成一张图片和一段视频",
                tools: [{ type: "function", name: "create_agent_plan" }],
                tool_choice: { type: "function", name: "create_agent_plan" },
            }),
        }).then((value) => value.json());
        expect(JSON.parse(combined.output[0].arguments)).toMatchObject({
            intent: "generation",
            deliverables: [
                { type: "image", model: "e2e-image", ratio: "16:9" },
                { type: "video", model: "e2e-video", ratio: "16:9", seconds: 5 },
            ],
        });

        const decomposition = await fetch(`${origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                messages: [{ role: "user", content: "请分析这张 1000x800 图片" }],
                tools: [{ type: "function", function: { name: "decompose_ecommerce_image" } }],
                tool_choice: { type: "function", function: { name: "decompose_ecommerce_image" } },
            }),
        }).then((value) => value.json());
        expect(JSON.parse(decomposition.choices[0].message.tool_calls[0].function.arguments)).toMatchObject({
            strategy: "ecommerce",
            backgroundDescription: "协议夹具蓝色渐变背景",
            backgroundPreservedVisuals: ["蓝色渐变", "柔和环境光"],
            layers: [{ kind: "product" }, { kind: "headline" }, { kind: "logo" }, { kind: "badge" }, { kind: "decoration" }],
        });

        const script = "主角推门进入明亮的测试房间，说：测试开始。";
        const drama = await fetch(`${origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                messages: [{ role: "user", content: JSON.stringify({ script }) }],
                tools: [{ type: "function", function: { name: "analyze_drama_content" } }],
                tool_choice: { type: "function", function: { name: "analyze_drama_content" } },
            }),
        }).then((value) => value.json());
        expect(JSON.parse(drama.choices[0].message.tool_calls[0].function.arguments).shots[0].sourceText).toBe(script);
    });

    it("serves OpenAI and Stable Diffusion image results", async () => {
        const openAi = await fetch(`${origin}/v1/images/generations`, { method: "POST" }).then((response) => response.json());
        const stableDiffusion = await fetch(`${origin}/sdapi/v1/txt2img`, { method: "POST" }).then((response) => response.json());
        expect(openAi.data[0].b64_json).toMatch(/^iVBOR/);
        expect(stableDiffusion.images[0]).toBe(openAi.data[0].b64_json);
        await expect(sharp(Buffer.from(openAi.data[0].b64_json, "base64")).metadata()).resolves.toMatchObject({ format: "png", width: 2, height: 2 });
    });

    it("returns source-pixel layers and a clean background from one multipart edit", async () => {
        const background = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#dbeafe" } })
            .png()
            .toBuffer();
        const source = await sharp(background)
            .composite([
                {
                    input: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ef4444" } })
                        .png()
                        .toBuffer(),
                    left: 1,
                    top: 1,
                },
            ])
            .png()
            .toBuffer();
        const form = new FormData();
        form.set("model", "mock-image");
        form.set("prompt", "分层任务要求：返回完整多图结果");
        form.set("image", new Blob([source], { type: "image/png" }), "source.png");

        const payload = await fetch(`${origin}/v1/images/edits`, { method: "POST", body: form }).then((response) => response.json());
        const outputs = payload.data.map((item) => `data:image/png;base64,${item.b64_json}`);

        await expect(validateImageLayerOutputs(`data:image/png;base64,${source.toString("base64")}`, outputs)).resolves.toMatchObject([{ kind: "element" }, { kind: "background" }]);
    });

    it("serves a configured fixture image without changing the default contract", async () => {
        await new Promise((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        temporaryDirectory = await mkdtemp(path.join(tmpdir(), "vozeb-pro-protocol-image-"));
        const imagePath = path.join(temporaryDirectory, "fixture.png");
        const expected = await sharp({ create: { width: 7, height: 5, channels: 4, background: "#7c8cff" } })
            .png()
            .toBuffer();
        await writeFile(imagePath, expected);
        fixture = createProtocolFixtureServer({ imagePath });
        await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        origin = `http://127.0.0.1:${address.port}`;

        const openAi = await fetch(`${origin}/v1/images/generations`, { method: "POST" }).then((response) => response.json());
        const media = Buffer.from(await fetch(`${origin}/media/fixture.png`).then((response) => response.arrayBuffer()));

        expect(Buffer.from(openAi.data[0].b64_json, "base64")).toEqual(expected);
        expect(media).toEqual(expected);
        await expect(sharp(media).metadata()).resolves.toMatchObject({ format: "png", width: 7, height: 5 });
    });

    it.each([
        ["OpenAI", "/v1/videos", "/v1/videos/fixture-video-1"],
        ["Seedance", "/contents/generations/tasks", "/contents/generations/tasks/fixture-video-1"],
        ["Seedance special", "/v1/seedance-special/videos", "/v1/result/fixture-video-1"],
    ])("serves %s asynchronous video creation and polling", async (_name, createPath, queryPath) => {
        const created = await fetch(`${origin}${createPath}`, { method: "POST" }).then((response) => response.json());
        const completed = await fetch(`${origin}${queryPath}`).then((response) => response.json());
        const media = await fetch(completed.video_url);
        expect(created.task_id).toBe("fixture-video-1");
        expect(completed).toMatchObject({ status: "completed", video_url: `${origin}/media/fixture.mp4` });
        expect(media.headers.get("content-type")).toBe("video/mp4");
    });

    it("serves the VOZEB recommended JSON video contract", async () => {
        const body = { model: "Seedance 2.0-fast-720p", prompt: "test", duration: 5, resolution: "720p", generate_audio: false, aspect_ratio: "16:9" };
        const created = await fetch(`${origin}/v1/videos/generations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
        const completed = await fetch(`${origin}/v1/videos/generations/${created.task_id}`).then((response) => response.json());

        expect(created).toMatchObject({ id: "fixture-vozeb-video-1", task_id: "fixture-vozeb-video-1", status: "queued" });
        expect(completed).toMatchObject({ status: "completed", metadata: { url: `${origin}/media/fixture.mp4` } });
        expect(fixture.requests[0]).toMatchObject({ contentType: "application/json" });
    });

    it("serves the complete Yumeng model-center task path", async () => {
        const body = { model: "seedream_5.0Pro", prompt: "test", reference_images: [`${origin}/media/fixture.png`] };
        const created = await fetch(`${origin}/kyyReactApiServer/v2/model-center/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }).then((response) => response.json());
        const completed = await fetch(`${origin}/kyyReactApiServer/v2/model-center/tasks/${created.task_id}`).then((response) => response.json());

        expect(created).toMatchObject({ task_id: "fixture-yumeng-image-1", status: "queued" });
        expect(completed).toMatchObject({ status: "completed", result_url: `${origin}/media/fixture.png` });
        expect(fixture.requests.map((request) => request.path)).toEqual(["/kyyReactApiServer/v2/model-center/tasks", "/kyyReactApiServer/v2/model-center/tasks/fixture-yumeng-image-1"]);
    });

    it("serves synchronous audio bytes", async () => {
        const response = await fetch(`${origin}/v1/audio/speech`, { method: "POST" });
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(response.headers.get("content-type")).toBe("audio/wav");
        expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    });

    it("does not reuse upstream task ids after resetting assertion state", async () => {
        const first = await fetch(`${origin}/v1/videos`, { method: "POST" }).then((response) => response.json());
        await fetch(`${origin}/v1/__reset`, { method: "POST" });
        const second = await fetch(`${origin}/v1/videos`, { method: "POST" }).then((response) => response.json());

        expect(first.task_id).toBe("fixture-video-1");
        expect(second.task_id).toBe("fixture-video-2");
    });

    it("can delay POST responses for task-control regression", async () => {
        await new Promise((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        fixture = createProtocolFixtureServer({ responseDelayMs: 40 });
        await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        origin = `http://127.0.0.1:${address.port}`;
        const startedAt = Date.now();

        await fetch(`${origin}/v1/chat/completions`, { method: "POST" });

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    });

    it("can return an explicit image failure for task-retry regression", async () => {
        await new Promise((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        fixture = createProtocolFixtureServer({ failImage: true });
        await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        origin = `http://127.0.0.1:${address.port}`;

        const response = await fetch(`${origin}/v1/images/generations`, { method: "POST" });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { message: "fixture image failure" } });
    });
});
