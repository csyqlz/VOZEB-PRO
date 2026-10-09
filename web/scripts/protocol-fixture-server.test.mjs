import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { validateImageLayerOutputs } from "../src/lib/server/image-layer-output";
import { assertTransparentImageOutput } from "../src/lib/server/image-transparent-output";
import { ecommerceVisualAnalysisTool, ecommerceVisualAnalysisV4Tool, normalizeEcommerceVisualAnalysis } from "../src/lib/server/ecommerce-visual-analysis";
import { ecommerceEditPlanningTool, ecommerceEditPlanningV6Tool } from "../src/lib/server/ecommerce-edit-planner";
import { resolveEcommerceReferenceDecision } from "../src/lib/server/ecommerce-reference-purpose";
import { normalizeEcommerceEditPlan } from "../src/lib/server/ecommerce-edit-plan";
import { ecommerceQualityCheckTool, ECOMMERCE_QUALITY_CHECK_KEYS } from "../src/lib/server/ecommerce-quality-check";
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
    async function ecommerceTool(tool, input) {
        const response = await fetch(`${origin}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: [{ role: "user", content: JSON.stringify(input) }], tools: [{ type: "function", ...tool }], tool_choice: { type: "function", name: tool.name } }),
        }).then((value) => value.json());
        return JSON.parse(response.output[0].arguments);
    }

    it("returns actual v4 reference evidence and v6 authorized source facts through the TCP fixture", async () => {
        const assets = [
            { id: "product", title: "product.png", width: 6, height: 4 },
            { id: "lighting", title: "lighting.png", width: 6, height: 4 },
        ];
        const raw = await ecommerceTool(ecommerceVisualAnalysisV4Tool, { userRequest: "图片1和图片2", assets });
        expect(raw).toMatchObject({
            analysisVersion: "ecommerce-visual-analysis.v4",
            purposeSuggestions: [],
            references: [
                { assetId: "product", contentType: "isolated_product" },
                { assetId: "lighting", contentType: "interior_scene", cues: expect.arrayContaining([expect.objectContaining({ facet: "style", confidence: "high" })]) },
            ],
        });
        expect(raw.references.every((reference) => !("role" in reference))).toBe(true);
        const analysis = normalizeEcommerceVisualAnalysis(raw, assets);
        expect(analysis).not.toBeNull();
        const planningInput = {
            userRequest: "图片1和图片2",
            assetCandidates: assets.map((asset) => ({ ...asset, type: "image" })),
            referenceAliases: [
                { assetId: "product", alias: "图片1" },
                { assetId: "lighting", alias: "图片2" },
            ],
        };
        const referenceDecision = resolveEcommerceReferenceDecision({
            planningInput,
            analysis,
            confirmedBindings: [
                { assetId: "product", alias: "图片1", purposes: ["edit_target", "product_identity"] },
                { assetId: "lighting", alias: "图片2", purposes: ["lighting"] },
            ],
        });
        expect(referenceDecision.state).toBe("resolved");
        const plan = await ecommerceTool(ecommerceEditPlanningV6Tool, {
            userRequest: planningInput.userRequest,
            sources: { productAnchorId: "product", currentSceneBaselineId: null, sceneReferenceIds: ["lighting"] },
            visualAnalysis: analysis,
            referenceDecision,
            requiredModelRoles: { visionAnalysis: "vision", editPlanning: "planning", generation: "image", qualityCheck: "quality" },
        });
        expect(normalizeEcommerceEditPlan(plan)).toMatchObject({
            planVersion: "ecommerce-edit.v6",
            baseline: { productFacts: analysis.references[0].productFacts, sceneFacts: null },
            referenceUses: [
                { assetId: "product", purposes: ["edit_target", "product_identity"], usedCueIds: [] },
                { assetId: "lighting", purposes: ["lighting"], usedCueIds: ["lighting-lighting"] },
            ],
        });
    });

    it("returns analysis v3 and plan v5 photography contracts for the actual structured schemas", async () => {
        const assets = [{ id: "cabinet", title: "white-product.png", width: 100, height: 80 }];
        const analysis = await ecommerceTool(ecommerceVisualAnalysisTool, { userRequest: "把三层抽屉柜放进客厅", assets });
        expect(analysis.analysisVersion).toBe("ecommerce-visual-analysis.v3");
        expect(normalizeEcommerceVisualAnalysis(analysis, assets)).toMatchObject({ references: [{ visibleStructure: [{ count: 3 }], photographyFacts: { materials: [{ objectId: "cabinet" }] } }] });
        const plan = await ecommerceTool(ecommerceEditPlanningTool, {
            userRequest: "把三层抽屉柜放进客厅",
            sources: { productAnchorId: "cabinet", currentSceneBaselineId: null, sceneReferenceIds: [] },
            visualAnalysis: analysis,
            requiredModelRoles: { visionAnalysis: "vision", editPlanning: "planning", generation: "image", qualityCheck: "quality" },
            continuity: { branchId: "fixture-branch", parentResultId: null },
        });
        expect(plan.planVersion).toBe("ecommerce-edit.v5");
        expect(normalizeEcommerceEditPlan(plan)).toMatchObject({ photography: analysis.references[0].photographyFacts, visibleStructure: [{ count: 3 }] });
    });

    it("returns independent baseline and result observations without treating plan counts as answers", async () => {
        const response = await ecommerceTool(ecommerceQualityCheckTool, {
            baselineRole: "scene",
            resultIds: ["result"],
            plan: { delta: { requestedChanges: ["三层抽屉柜结果故意变成四层"] }, visibleStructure: [{ objectId: "cabinet", feature: "drawers", count: 4 }] },
        });
        expect(response.baselineObservation.visibleStructure[0].count).toBe(3);
        expect(response.results[0].observation.visibleStructure[0].count).toBe(4);
        expect(response.results[0].checks.map((check) => check.key)).toEqual(ECOMMERCE_QUALITY_CHECK_KEYS);
    });

    it.each(["gemini", "json fallback"])("uses the actual %s schema for new ecommerce contracts", async (protocol) => {
        const call = async (tool, input) => {
            const instruction = `JSON 必须符合以下 Schema：${JSON.stringify(tool.parameters)}`;
            const body =
                protocol === "gemini"
                    ? { contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }], tools: [{ functionDeclarations: [tool] }] }
                    : {
                          input: [
                              { role: "system", content: `作为 ${tool.name} 的最终参数。${instruction}` },
                              { role: "user", content: JSON.stringify(input) },
                          ],
                          text: { format: { type: "json_object" } },
                      };
            const response = await fetch(`${origin}/v1/${protocol === "gemini" ? "models/fixture-text:generateContent" : "responses"}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }).then((value) => value.json());
            return JSON.parse(protocol === "gemini" ? response.candidates[0].content.parts[0].text : response.output[0].arguments);
        };
        const assets = [{ id: "cabinet", title: "scene.png", width: 6, height: 4 }];
        const analysis = await call(ecommerceVisualAnalysisTool, { assets, userRequest: "三层抽屉柜只加柜面花瓶" });
        expect(analysis).toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v3", references: [{ assetId: "cabinet", role: "scene", visibleStructure: [{ count: 3 }], photographyFacts: { materials: [{ objectId: "cabinet" }] } }] });
        const plan = await call(ecommerceEditPlanningTool, {
            userRequest: "三层抽屉柜只加柜面花瓶",
            sources: { productAnchorId: null, currentSceneBaselineId: "cabinet", sceneReferenceIds: [] },
            visualAnalysis: analysis,
            requiredModelRoles: { visionAnalysis: "vision", editPlanning: "planning", generation: "image", qualityCheck: "quality" },
        });
        expect(normalizeEcommerceEditPlan(plan)).toMatchObject({ planVersion: "ecommerce-edit.v5", operation: "scene_edit", photography: { materials: [{ objectId: "cabinet" }] }, protection: { scope: "local" } });
        const quality = await call(ecommerceQualityCheckTool, { resultIds: ["result"], plan });
        expect(quality.baselineObservation.visibleStructure[0].count).toBe(3);
        expect(quality.results[0].checks.map((check) => check.key)).toEqual(ECOMMERCE_QUALITY_CHECK_KEYS);
    });

    it("retains the named legacy v1 no-schema protocol control", async () => {
        const analysis = await ecommerceTool({ name: "analyze_ecommerce_references" }, { assets: [{ id: "legacy", title: "legacy.png" }] });
        expect(analysis.analysisVersion).toBe("ecommerce-visual-analysis.v1");
        expect(analysis.references[0]).not.toHaveProperty("photographyFacts");
        const qa = await ecommerceTool({ name: "check_ecommerce_results" }, { resultIds: ["legacy-result"] });
        expect(qa).not.toHaveProperty("baselineObservation");
        expect(qa.results[0].checks).toHaveLength(8);
    });

    it("persists an asynchronous ecommerce upstream identity across fixture query calls", async () => {
        await new Promise((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        fixture = createProtocolFixtureServer({ ecommerceAsyncImage: true });
        await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${fixture.server.address().port}`;
        const created = await fetch(`${origin}/v1/images/edits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: "6x4" }) }).then((value) => value.json());
        expect(created).toMatchObject({ task_id: "fixture-ecommerce-image-1", status: "queued", poll_url: `${origin}/v1/images/tasks/fixture-ecommerce-image-1` });
        const queried = await fetch(created.poll_url).then((value) => value.json());
        expect(queried).toMatchObject({ task_id: created.task_id, status: "completed", data: [{ b64_json: expect.any(String) }] });
        expect(fixture.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        await expect(sharp(Buffer.from(queried.data[0].b64_json, "base64")).metadata()).resolves.toMatchObject({ width: 6, height: 4 });
    });

    it.each(["ecommerce-edit.v3", "ecommerce-edit.v4"])("keeps a named %s plan control without adding photography", async (version) => {
        const tool = structuredClone(ecommerceEditPlanningTool);
        tool.parameters.properties.planVersion.enum = [version];
        const plan = await ecommerceTool(tool, {
            userRequest: "三层抽屉柜只加柜面花瓶",
            sources: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
            requiredModelRoles: { visionAnalysis: "vision", editPlanning: "planning", generation: "image", qualityCheck: "quality" },
            visualAnalysis: {
                references: [
                    {
                        role: "scene",
                        sceneFacts: { space: "room", composition: "front", lighting: "soft" },
                        visibleStructure: [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 6, height: 4 } }],
                    },
                ],
            },
        });
        expect(normalizeEcommerceEditPlan(plan)).toMatchObject({ planVersion: version, operation: "scene_edit", protection: { scope: "local", allowLightingChange: false } });
        expect(plan).not.toHaveProperty("photography");
        expect(Boolean(plan.visibleStructure)).toBe(version === "ecommerce-edit.v4");
    });

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

    it("reports white and transparent ecommerce product backgrounds from image pixels", async () => {
        const analyze = async (id, image) => {
            const response = await fetch(`${origin}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        userRequest: "把商品放进现代客厅",
                                        assets: [{ id, title: "fixture-product.png", width: 16, height: 16 }],
                                    }),
                                },
                                { type: "text", text: `assetId=${id}` },
                                { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
                            ],
                        },
                    ],
                    tools: [{ type: "function", function: { name: "analyze_ecommerce_references" } }],
                    tool_choice: { type: "function", function: { name: "analyze_ecommerce_references" } },
                }),
            }).then((value) => value.json());
            return JSON.parse(response.choices[0].message.tool_calls[0].function.arguments).references[0].visualEvidence;
        };
        const subject = { input: { create: { width: 6, height: 8, channels: 4, background: "#252525" } }, left: 5, top: 4 };
        const white = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#ffffff" } })
            .composite([subject])
            .png()
            .toBuffer();
        const transparent = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#00000000" } })
            .composite([subject])
            .png()
            .toBuffer();

        await expect(analyze("white-product", white)).resolves.toMatchObject({
            whiteBackground: true,
            transparentBackground: false,
            isolatedSubject: true,
        });
        await expect(analyze("transparent-product", transparent)).resolves.toMatchObject({
            whiteBackground: false,
            transparentBackground: true,
            isolatedSubject: true,
        });
    });

    it("serves OpenAI and Stable Diffusion image results", async () => {
        const openAi = await fetch(`${origin}/v1/images/generations`, { method: "POST" }).then((response) => response.json());
        const stableDiffusion = await fetch(`${origin}/sdapi/v1/txt2img`, { method: "POST" }).then((response) => response.json());
        expect(openAi.data[0].b64_json).toMatch(/^iVBOR/);
        expect(stableDiffusion.images[0]).toBe(openAi.data[0].b64_json);
        await expect(sharp(Buffer.from(openAi.data[0].b64_json, "base64")).metadata()).resolves.toMatchObject({ format: "png", width: 2, height: 2 });
    });

    it.each([
        ["JSON generation", "/v1/images/generations", "json", false],
        ["JSON edit", "/v1/images/edits", "json", true],
        ["multipart generation", "/v1/images/generations", "multipart", true],
        ["multipart edit", "/v1/images/edits", "multipart", false],
        ["multipart transparent edit", "/v1/images/edits", "multipart", true],
    ])("creates native PNG pixels at the requested size for %s", async (_name, endpoint, encoding, transparent) => {
        const size = { width: 384, height: 216 };
        const parameters = { model: "mock-image", size: `${size.width}x${size.height}`, ...(transparent ? { background: "transparent" } : {}) };
        const form = new FormData();
        for (const [key, value] of Object.entries(parameters)) form.set(key, value);
        const response = await fetch(`${origin}${endpoint}`, {
            method: "POST",
            ...(encoding === "json" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(parameters) } : { body: form }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        if (transparent) await expect(assertTransparentImageOutput(`data:image/png;base64,${payload.data[0].b64_json}`)).resolves.toBeUndefined();
        const image = sharp(Buffer.from(payload.data[0].b64_json, "base64"));
        await expect(image.metadata()).resolves.toMatchObject({ format: "png", ...size });
        const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(data[info.channels - 1]).toBe(transparent ? 0 : 255);
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
