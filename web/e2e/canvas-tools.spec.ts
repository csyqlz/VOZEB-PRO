import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test, type Locator } from "@playwright/test";
import { unzipSync } from "fflate";
import sharp from "sharp";

import { normalizeImagePreviewWidth } from "../src/lib/media-image-variant";
import { createCanvasProject, deleteCanvasProject, expectCanvasSaved, expectNoHorizontalOverflow, node, readCanvasProject } from "./canvas-e2e-helpers";

test.describe.configure({ mode: "serial" });

test("canvas smart layering refines each element with an independent task", async ({ page, request }) => {
    const imageTaskRequests: Array<{
        config?: { outputBackground?: string; outputMode?: string };
        prompt?: string;
        references?: Array<{ dataUrl?: string; serverUrl?: string }>;
    }> = [];
    let decompositionRequests = 0;
    let releaseDecomposition: (() => void) | undefined;
    const decompositionGate = new Promise<void>((resolve) => {
        releaseDecomposition = resolve;
    });
    await page.route("**/api/canvas/image-decomposition", async (route) => {
        await decompositionGate;
        await route.continue();
    });
    page.on("request", (current) => {
        const path = new URL(current.url()).pathname;
        if (current.method() === "POST" && path === "/api/image-tasks") imageTaskRequests.push((current.postDataJSON() || {}) as (typeof imageTaskRequests)[number]);
        if (current.method() === "POST" && path === "/api/canvas/image-decomposition") decompositionRequests += 1;
    });
    const sourceBytes = await fiveElementFixture();
    const upload = await request.post("/api/reference-assets", {
        data: { type: "image", persistent: false, dataUrl: `data:image/png;base64,${sourceBytes.toString("base64")}`, originalName: "ecommerce-source.png" },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const sourceAsset = (await upload.json()) as { key: string; url: string; mimeType: string };
    const project = await createCanvasProject(request, {
        title: `Canvas OCR 分层 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 80, y: 100, k: 0.8 },
        nodes: [node("source-image", "image", 100, 120, 360, 216, { content: sourceAsset.url, serverUrl: sourceAsset.url, storageKey: sourceAsset.key, mimeType: sourceAsset.mimeType, naturalWidth: 1200, naturalHeight: 720 })],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await page.locator('[data-node-id="source-image"]').click();
        await page.getByRole("button", { name: "智能分层", exact: true }).click();
        const analysisStatus = page.getByText("正在分层分析", { exact: true });
        await expect(analysisStatus).toBeVisible();
        releaseDecomposition?.();
        await expect(analysisStatus).toBeHidden({ timeout: 90_000 });
        const generated = page.locator('[data-node-id]:not([data-node-id="source-image"])');
        await expect(generated.first()).toBeVisible({ timeout: 90_000 });
        await expect.poll(() => imageTaskRequests.length, { timeout: 180_000 }).toBe(6);
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).nodes.length, { timeout: 180_000 }).toBe(7);
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).connections.length, { timeout: 180_000 }).toBe(6);
        await expect
            .poll(
                async () => {
                    const current = await readCanvasProject(request, projectPath);
                    return current.nodes.find((item) => item.metadata?.sourceLayerNodeId === "source-image" && item.metadata?.layerName === "背景")?.metadata?.status;
                },
                { timeout: 180_000 },
            )
            .toBe("success");
        await expect
            .poll(
                async () => {
                    const current = await readCanvasProject(request, projectPath);
                    return current.nodes
                        .filter((item) => item.metadata?.sourceLayerNodeId === "source-image" && item.metadata?.layerName !== "背景")
                        .map((item) => item.metadata?.status)
                        .sort();
                },
                { timeout: 180_000 },
            )
            .toEqual(Array.from({ length: 5 }, () => "success"));
        const saved = await readCanvasProject(request, projectPath);
        const layerNodes = saved.nodes.filter((item) => item.metadata?.sourceLayerNodeId === "source-image" && item.metadata?.layerName !== "背景");
        const background = saved.nodes.find((item) => item.metadata?.sourceLayerNodeId === "source-image" && item.metadata?.layerName === "背景");
        expect(layerNodes).toHaveLength(5);
        expect(background?.metadata).toMatchObject({ status: "success", content: expect.any(String), storageKey: expect.any(String) });
        expect(saved.connections.map((connection) => connection.fromNodeId)).toEqual(Array.from({ length: 6 }, () => "source-image"));
        for (const layer of layerNodes) {
            expect(layer.metadata).toMatchObject({ status: "success", content: expect.any(String), storageKey: expect.any(String), imageLayer: expect.any(Object) });
            const response = await request.get(String(layer.metadata?.serverUrl || layer.metadata?.content));
            expect(response.ok(), await response.text()).toBe(true);
            const layerBytes = await response.body();
            const image = sharp(layerBytes);
            await expect(image.metadata()).resolves.toMatchObject({ format: "png", width: expect.any(Number), height: expect.any(Number) });
            const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            expect(data.some((value, index) => index % info.channels === info.channels - 1 && value < 255)).toBe(true);
        }
        expect(decompositionRequests, "智能分层应只请求一次视觉识别").toBe(1);
        const elementRequests = imageTaskRequests.filter((item) => item.config?.outputBackground === "transparent");
        expect(elementRequests, "每个元素应单独请求透明分层").toHaveLength(5);
        expect(elementRequests.map((item) => item.references?.[0]?.dataUrl)).toEqual(Array.from({ length: 5 }, () => sourceAsset.url));
        expect(
            elementRequests.every((item) => item.prompt?.includes("从这张完整主图中精准提取") && item.prompt.includes("元素范围 x=")),
            "元素任务必须引用完整主图并携带原图坐标",
        ).toBe(true);
        expect(
            imageTaskRequests.filter((item) => item.config?.outputBackground !== "transparent"),
            "背景应使用独立补全任务",
        ).toHaveLength(1);
        expect(imageTaskRequests.every((item) => item.config?.outputMode === undefined)).toBe(true);
        expect(
            imageTaskRequests.some((item) => item.config?.outputMode === "layers"),
            "智能分层不得把独立元素任务改成上游批量层任务",
        ).toBe(false);
        await expect(generated.first()).toBeVisible();
        await generated.first().click();
        await expect(generated.first().locator(":scope > div").first()).toHaveCSS("border-color", "rgb(47, 128, 255)");
    } finally {
        releaseDecomposition?.();
        try {
            await deleteCanvasProject(request, project.id);
        } finally {
            const cleanup = await request.delete("/api/media-assets", { data: { storageKeys: [sourceAsset.key] } });
            expect(cleanup.ok(), await cleanup.text()).toBe(true);
        }
    }
});

test("canvas person background removal keeps the original local cutout path", async ({ page, request }) => {
    const imageTaskRequests: Array<{ config?: { outputBackground?: string } }> = [];
    page.on("request", (current) => {
        if (current.method() === "POST" && new URL(current.url()).pathname === "/api/image-tasks") imageTaskRequests.push((current.postDataJSON() || {}) as { config?: { outputBackground?: string } });
    });
    const sourceBytes = await plainSubjectFixture();
    const upload = await request.post("/api/reference-assets", {
        data: { type: "image", persistent: false, dataUrl: `data:image/png;base64,${sourceBytes.toString("base64")}`, originalName: "plain-person.png" },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const sourceAsset = (await upload.json()) as { key: string; url: string; mimeType: string };
    const project = await createCanvasProject(request, {
        title: `Canvas 人物分层 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 80, y: 100, k: 0.75 },
        nodes: [node("source-image", "image", 100, 120, 267, 400, { content: sourceAsset.url, serverUrl: sourceAsset.url, storageKey: sourceAsset.key, mimeType: sourceAsset.mimeType, naturalWidth: 640, naturalHeight: 960 })],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await page.locator('[data-node-id="source-image"]').click();
        await page.getByRole("button", { name: "消除背景", exact: true }).click();
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).nodes.length, { timeout: 120_000 }).toBe(2);
        const saved = await readCanvasProject(request, projectPath);
        const subject = saved.nodes.find((item) => item.metadata?.layerName === "主体（透明背景）");

        expect(subject?.metadata).toMatchObject({ status: "success", storageKey: expect.any(String) });
        expect(subject?.metadata?.imageTask).toBeUndefined();
        expect(imageTaskRequests, "人物去背不得创建图片生成任务").toHaveLength(0);
    } finally {
        try {
            await deleteCanvasProject(request, project.id);
        } finally {
            const cleanup = await request.delete("/api/media-assets", { data: { storageKeys: [sourceAsset.key] } });
            expect(cleanup.ok(), await cleanup.text()).toBe(true);
        }
    }
});

test("canvas Agent can reference images beyond the first fifty without stalling", async ({ page, request }) => {
    const sourceBytes = await plainSubjectFixture();
    const upload = await request.post("/api/reference-assets", {
        data: { type: "image", persistent: false, dataUrl: `data:image/png;base64,${sourceBytes.toString("base64")}`, originalName: "large-canvas-reference.png" },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const sourceAsset = (await upload.json()) as { key: string; url: string; mimeType: string };
    const imageNodes = Array.from({ length: 64 }, (_, index) =>
        node(`image-${index + 1}`, "image", (index % 8) * 150, Math.floor(index / 8) * 110, 128, 88, {
            content: sourceAsset.url,
            serverUrl: sourceAsset.url,
            storageKey: sourceAsset.key,
            mimeType: sourceAsset.mimeType,
            naturalWidth: 640,
            naturalHeight: 960,
        }),
    );
    const project = await createCanvasProject(request, {
        title: `Canvas 大图引用 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 80, y: 80, k: 0.5 },
        nodes: imageNodes,
        connections: [],
    });

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const panel = page.getByLabel("Canvas Agent 对话面板");
        const composer = panel.getByRole("textbox", { name: "描述你想让 Agent 如何操作画布" });
        await expect(composer).toBeVisible({ timeout: 20_000 });

        for (const nodeId of ["image-52", "image-59", "image-64"]) {
            await composer.fill(`${await composer.inputValue()}@${nodeId}`);
            const option = page.getByRole("button", { name: `引用${nodeId}`, exact: true });
            await expect(option).toBeVisible();
            await option.click();
        }

        await expect(composer).toHaveValue("@图片1 @图片2 @图片3 ");
        await expect(panel.locator('[data-canvas-agent-input-row] img[alt="image-64"]')).toBeVisible();
        await composer.fill(`${await composer.inputValue()}${Array.from({ length: 18 }, (_, index) => `\n保持参考主体一致，补充第 ${index + 1} 条镜头运动说明。`).join("")}`);
        await expect.poll(() => composer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const mentionBounds = await panel.locator('[data-testid="canvas-agent-mention-preview"]').evaluate((preview) => {
            const previewRect = preview.getBoundingClientRect();
            const textareaRect = preview.parentElement?.querySelector("textarea")?.getBoundingClientRect();
            const scrollLayerRect = preview.querySelector("[data-canvas-agent-mention-scroll-layer]")?.getBoundingClientRect();
            return {
                previewTop: previewRect.top,
                previewBottom: previewRect.bottom,
                textareaTop: textareaRect?.top ?? Number.NaN,
                textareaBottom: textareaRect?.bottom ?? Number.NaN,
                scrollLayerTop: scrollLayerRect?.top,
            };
        });
        expect(mentionBounds.previewTop).toBeGreaterThanOrEqual(mentionBounds.textareaTop - 1);
        expect(mentionBounds.previewBottom).toBeLessThanOrEqual(mentionBounds.textareaBottom + 1);
        expect(mentionBounds.scrollLayerTop ?? Number.POSITIVE_INFINITY).toBeLessThan(mentionBounds.previewTop);
        await expect(page.locator('.node-element[data-node-id="image-64"]')).toHaveCSS("z-index", "50");
        const previewWidths = await page.locator('.node-element[data-node-id^="image-"] img').evaluateAll((images) => images.map((image) => new URL((image as HTMLImageElement).src).searchParams.get("width")).filter(Boolean));
        const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
        expect(new Set(previewWidths)).toEqual(new Set([String(normalizeImagePreviewWidth(128 * 0.5 * devicePixelRatio))]));
    } finally {
        try {
            await deleteCanvasProject(request, project.id);
        } finally {
            const cleanup = await request.delete("/api/media-assets", { data: { storageKeys: [sourceAsset.key] } });
            expect(cleanup.ok(), await cleanup.text()).toBe(true);
        }
    }
});

test("canvas layer tools, transparent preview, Agent node simplification and auto layout stay usable", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 图层工具 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 20, y: 40, k: 0.72 },
        nodes: [
            node("prompt", "text", 900, 700, 240, 140, { content: "生成电影感人物海报" }),
            node("manual-config", "config", -320, 30, 300, 180, { generationMode: "image", composerContent: "电影感人物海报" }),
            node("source-image", "image", 80, -500, 260, 180, { content: "/logo.svg", naturalWidth: 512, naturalHeight: 512, layerName: "主体（透明背景）" }),
            node("agent-brief", "brief", -700, -520, 340, 220, { agentRunId: "run-layer-tools", agentBrief: { objective: "内部目标" } }),
            node("agent-brand", "brand-kit", -700, -240, 340, 220, { agentRunId: "run-layer-tools", brandKit: { summary: "内部视觉方向" } }),
            node("agent-config", "config", -280, -400, 300, 180, { agentRunId: "run-layer-tools", generationMode: "image" }),
            node("agent-task", "task", 260, 260, 300, 180, { agentRunId: "run-layer-tools", prompt: "生成蓝色电影感人物海报", agentTaskStatus: "completed" }),
            node("agent-output", "image", 720, 240, 260, 180, { agentRunId: "run-layer-tools", content: "/logo.svg", naturalWidth: 512, naturalHeight: 512, layerName: "背景" }),
        ],
        connections: [
            { id: "manual-input", fromNodeId: "prompt", toNodeId: "manual-config" },
            { id: "manual-output", fromNodeId: "manual-config", toNodeId: "source-image" },
            { id: "brief-task", fromNodeId: "agent-brief", toNodeId: "agent-task" },
            { id: "brand-task", fromNodeId: "agent-brand", toNodeId: "agent-task" },
            { id: "config-task", fromNodeId: "agent-config", toNodeId: "agent-task" },
            { id: "task-output", fromNodeId: "agent-task", toNodeId: "agent-output" },
        ],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;

    try {
        await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        await expect(page.locator("[data-node-id]")).toHaveCount(4);
        await expect(page.locator('[data-node-id="agent-brief"], [data-node-id="agent-brand"], [data-node-id="agent-config"], [data-node-id="agent-task"]')).toHaveCount(0);
        await expect(page.locator('[data-node-id="manual-config"]')).toBeVisible();
        await expect(page.locator('[data-node-id="agent-output"]')).toBeVisible();

        await page.getByRole("button", { name: "一键整理画布" }).click();
        await expectCanvasSaved(page);
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).nodes.find((item) => item.id === "prompt")?.position.x).toBe(96);
        const arrangedBoxes = await page.locator("[data-node-id]").evaluateAll((elements) =>
            elements.map((element) => {
                const { left, top, right, bottom } = element.getBoundingClientRect();
                return { left, top, right, bottom };
            }),
        );
        for (let first = 0; first < arrangedBoxes.length; first += 1) {
            for (let second = first + 1; second < arrangedBoxes.length; second += 1) {
                const a = arrangedBoxes[first];
                const b = arrangedBoxes[second];
                expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
            }
        }
        const arrangedProject = await readCanvasProject(request, projectPath);
        expect(arrangedProject.nodes.find((item) => item.id === "agent-brief")?.position).toEqual({ x: -700, y: -520 });
        await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "撤销", exact: true }).click();
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).nodes.find((item) => item.id === "prompt")?.position.x).toBe(900);
        await page.getByRole("button", { name: "一键整理画布" }).click();
        await expectCanvasSaved(page);

        const sourceImage = page.locator('[data-node-id="source-image"]');
        await expect(sourceImage.locator('[data-canvas-transparent-preview="true"]')).toHaveCount(0);
        await expect(page.locator('[data-node-id="agent-output"] [data-canvas-transparent-preview]')).toHaveCount(0);
        await sourceImage.hover();
        await expect(page.locator("[data-canvas-hover-toolbar]")).toHaveCount(0);
        await sourceImage.click();
        for (const name of ["智能分层", "消除背景", "识别人脸并调节表情参考"]) {
            await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
        }

        await page.getByRole("button", { name: "打开画布菜单" }).click();
        await expect(page.getByRole("menuitem", { name: /PSD/i })).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas auto layout separates branching flows and keeps lines away from unrelated nodes", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 分支整理 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 20, y: 40, k: 0.72 },
        nodes: [
            node("pig-source", "image", 80, 40, 260, 220, { content: "/logo.svg", naturalWidth: 512, naturalHeight: 512 }),
            node("pig-cutout", "image", 760, 560, 240, 220, { content: "/logo.svg", naturalWidth: 512, naturalHeight: 512 }),
            node("pig-background", "image", 760, 920, 280, 180, { content: "/logo.svg", naturalWidth: 512, naturalHeight: 512 }),
            node("person-source", "image", 140, 760, 320, 180, { content: "/generation-smoke.webp", naturalWidth: 1200, naturalHeight: 720 }),
            node("person-cutout", "image", 760, 120, 280, 180, { content: "/generation-smoke.webp", naturalWidth: 1200, naturalHeight: 720 }),
            node("person-background", "image", 760, 340, 280, 180, { content: "/generation-smoke.webp", naturalWidth: 1200, naturalHeight: 720 }),
        ],
        connections: [
            { id: "pig-cutout-edge", fromNodeId: "pig-source", toNodeId: "pig-cutout" },
            { id: "pig-background-edge", fromNodeId: "pig-source", toNodeId: "pig-background" },
            { id: "person-cutout-edge", fromNodeId: "person-source", toNodeId: "person-cutout" },
            { id: "person-background-edge", fromNodeId: "person-source", toNodeId: "person-background" },
        ],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "一键整理画布" }).click();
        await expectCanvasSaved(page);
        const arranged = await readCanvasProject(request, projectPath);
        const byId = new Map(arranged.nodes.map((item) => [item.id, item]));
        const bounds = [
            ["pig-source", "pig-cutout", "pig-background"],
            ["person-source", "person-cutout", "person-background"],
        ].map((ids) => ({
            left: Math.min(...ids.map((id) => byId.get(id)!.position.x)),
            top: Math.min(...ids.map((id) => byId.get(id)!.position.y)),
            right: Math.max(...ids.map((id) => byId.get(id)!.position.x + byId.get(id)!.width)),
            bottom: Math.max(...ids.map((id) => byId.get(id)!.position.y + byId.get(id)!.height)),
        }));
        expect(bounds[0].right <= bounds[1].left || bounds[1].right <= bounds[0].left || bounds[0].bottom <= bounds[1].top || bounds[1].bottom <= bounds[0].top).toBe(true);
        await expectConnectionsAvoidNodes(page, [
            { id: "pig-cutout-edge", endpoints: ["pig-source", "pig-cutout"] },
            { id: "pig-background-edge", endpoints: ["pig-source", "pig-background"] },
            { id: "person-cutout-edge", endpoints: ["person-source", "person-cutout"] },
            { id: "person-background-edge", endpoints: ["person-source", "person-background"] },
        ]);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas box selection downloads selected images and videos as a browser ZIP", async ({ page, request }) => {
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XcX9WQAAAABJRU5ErkJggg==";
    const videoDataUrl = "data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=";
    const uploadAsset = async (type: "image" | "video", dataUrl: string, originalName: string) => {
        const response = await request.post("/api/reference-assets", { data: { type, persistent: false, dataUrl, originalName } });
        expect(response.ok(), await response.text()).toBe(true);
        return (await response.json()) as { key: string; url: string; mimeType: string };
    };
    const imageAsset = await uploadAsset("image", imageDataUrl, "selected.png");
    const videoAsset = await uploadAsset("video", videoDataUrl, "selected.mp4");
    let project: Awaited<ReturnType<typeof createCanvasProject>> | undefined;

    try {
        project = await createCanvasProject(request, {
            title: `Canvas 批量下载 ${randomUUID().slice(0, 8)}`,
            viewport: { x: 80, y: 100, k: 0.8 },
            nodes: [
                node("selected-image", "image", 100, 140, 220, 180, { content: imageAsset.url, serverUrl: imageAsset.url, storageKey: imageAsset.key, mimeType: imageAsset.mimeType }),
                node("selected-video", "video", 420, 140, 260, 180, { content: videoAsset.url, serverUrl: videoAsset.url, storageKey: videoAsset.key, mimeType: videoAsset.mimeType }),
            ],
            connections: [],
        });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "切换到框选模式" }).click();
        const boxes = await Promise.all([page.locator('[data-node-id="selected-image"]').boundingBox(), page.locator('[data-node-id="selected-video"]').boundingBox()]);
        expect(boxes.every(Boolean)).toBe(true);
        const left = Math.min(...boxes.map((box) => box!.x)) - 12;
        const top = Math.min(...boxes.map((box) => box!.y)) - 12;
        const right = Math.max(...boxes.map((box) => box!.x + box!.width)) + 12;
        const bottom = Math.max(...boxes.map((box) => box!.y + box!.height)) + 12;
        await page.mouse.move(left, top);
        await page.mouse.down();
        await page.mouse.move(right, bottom, { steps: 8 });
        await page.mouse.up();

        const batchDownload = page.getByRole("button", { name: "批量下载 2 个图片或视频" });
        await expect(batchDownload).toBeVisible();
        const downloadPromise = page.waitForEvent("download");
        await batchDownload.click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/[.]zip$/i);
        const filePath = await download.path();
        expect(filePath).not.toBeNull();
        const entries = Object.keys(unzipSync(await readFile(filePath!)));
        expect(entries.some((name) => /[.]png$/i.test(name))).toBe(true);
        expect(entries.some((name) => /[.]mp4$/i.test(name))).toBe(true);

        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(surface).toBeVisible({ timeout: 20_000 });
        const selectMode = page.getByRole("button", { name: "切换到框选模式" });
        if (await selectMode.isVisible()) await selectMode.click();
        const mobileBoxes = await Promise.all([page.locator('[data-node-id="selected-image"]').boundingBox(), page.locator('[data-node-id="selected-video"]').boundingBox()]);
        expect(mobileBoxes.every(Boolean)).toBe(true);
        const mobileLeft = Math.min(...mobileBoxes.map((box) => box!.x)) - 12;
        const mobileTop = Math.min(...mobileBoxes.map((box) => box!.y)) - 12;
        const mobileRight = Math.max(...mobileBoxes.map((box) => box!.x + box!.width)) + 12;
        const mobileBottom = Math.max(...mobileBoxes.map((box) => box!.y + box!.height)) + 12;
        await page.mouse.move(mobileLeft, mobileTop);
        await page.mouse.down();
        await page.mouse.move(mobileRight, mobileBottom, { steps: 8 });
        await page.mouse.up();

        const mobileBatchDownload = page.getByRole("button", { name: "批量下载 2 个图片或视频" });
        await expect(mobileBatchDownload).toBeVisible();
        await mobileBatchDownload.scrollIntoViewIfNeeded();
        const mobileLayout = await page.evaluate(() => {
            const toolbar = document.querySelector<HTMLElement>("[data-canvas-toolbar] .canvas-toolbar-dock");
            const button = document.querySelector<HTMLElement>("[data-canvas-batch-download]");
            if (!toolbar || !button) throw new Error("Canvas 批量下载控件未渲染");
            const toolbarBox = toolbar.getBoundingClientRect();
            const buttonBox = button.getBoundingClientRect();
            return {
                buttonWidth: buttonBox.width,
                buttonRight: buttonBox.right,
                toolbarRight: toolbarBox.right,
                documentScrollWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
            };
        });
        expect(mobileLayout.buttonWidth).toBeGreaterThanOrEqual(52);
        expect(mobileLayout.buttonRight).toBeLessThanOrEqual(mobileLayout.toolbarRight + 1);
        expect(mobileLayout.documentScrollWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
    } finally {
        try {
            if (project) await deleteCanvasProject(request, project.id);
        } finally {
            const cleanup = await request.delete("/api/media-assets", { data: { storageKeys: [imageAsset.key, videoAsset.key] } });
            expect(cleanup.ok(), await cleanup.text()).toBe(true);
        }
    }
});

test("canvas face dialog keeps detection, close control and intensity slider usable", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 人脸表情 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 120, y: 100, k: 1 },
        nodes: [node("source-image", "image", 120, 100, 400, 260, { content: "/generation-smoke.webp", naturalWidth: 1200, naturalHeight: 720 })],
        connections: [],
    });

    try {
        await page.addInitScript(() => {
            let detectionCount = 0;
            Object.defineProperty(window, "FaceDetector", {
                configurable: true,
                value: class {
                    async detect() {
                        detectionCount += 1;
                        if (detectionCount === 1) return [{ boundingBox: { x: 240, y: 120, width: 240, height: 240 }, confidence: 0.94 }];
                        return [
                            { boundingBox: { x: 240, y: 120, width: 240, height: 240 }, confidence: 0.94 },
                            { boundingBox: { x: 720, y: 144, width: 220, height: 230 }, confidence: 0.91 },
                        ];
                    }
                },
            });
        });
        await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        const sourceImage = page.locator('[data-node-id="source-image"]');
        await sourceImage.click();
        await page.getByRole("button", { name: "识别人脸并调节表情参考", exact: true }).click();
        const emotionDialog = page.getByRole("dialog");
        await expect(emotionDialog.getByText("人脸与表情参考")).toBeVisible();
        await expect(emotionDialog.getByText("目标人物", { exact: true })).toHaveCount(0);
        await expect(emotionDialog.getByText(/^自\s*然$/)).toHaveCount(1);
        await expect(emotionDialog.locator("[data-face-control-panel]")).toHaveCSS("border-top-width", "0px");
        await expectFaceDialogDesktopLayout(emotionDialog);
        await expectCloseControlSeparated(emotionDialog);

        const autoDetectButton = emotionDialog.getByRole("button", { name: "自动识别", exact: true });
        await expect(emotionDialog.getByText("已自动识别 1 个人物", { exact: true })).toBeVisible();
        await expect(emotionDialog.getByRole("button", { name: "人物 1", exact: true })).toHaveCount(0);
        await autoDetectButton.click();
        await expect(emotionDialog.getByRole("button", { name: "人物 1", exact: true })).toBeVisible();
        await emotionDialog.getByRole("button", { name: "人物 2", exact: true }).click();
        const secondFaceBox = emotionDialog.getByRole("button", { name: "选择人物 2", exact: true });
        await expect(secondFaceBox).toBeVisible();
        await expect(secondFaceBox).toHaveText("");

        for (const name of ["愤怒", "悲伤", "哭泣", "惊讶", "害怕", "厌恶"]) {
            await expect(emotionDialog.getByRole("button", { name, exact: true })).toBeVisible();
        }
        const angryPreset = emotionDialog.getByRole("button", { name: "愤怒", exact: true });
        await angryPreset.click();
        await expect(angryPreset).toHaveAttribute("aria-pressed", "true");
        const intensitySlider = emotionDialog.getByRole("slider", { name: "表情强度" });
        await expect(intensitySlider).toHaveAttribute("aria-valuenow", "1");
        await intensitySlider.press("ArrowRight");
        await expect(intensitySlider).toHaveAttribute("aria-valuenow", "2");
        await expect(intensitySlider).toHaveAttribute("aria-valuetext", "强烈");
        for (const mark of ["轻微", "明显", "强烈"]) await expect(emotionDialog.getByText(mark, { exact: true })).toBeVisible();
        await expectIntensityMarksContained(emotionDialog);

        await emotionDialog.getByRole("button", { name: "手动框选" }).click();
        const emotionImage = emotionDialog.getByRole("img", { name: "待调整表情的图片" });
        const imageBounds = await emotionImage.boundingBox();
        expect(imageBounds).not.toBeNull();
        await page.mouse.move(imageBounds!.x + imageBounds!.width * 0.3, imageBounds!.y + imageBounds!.height * 0.25);
        await page.mouse.down();
        await page.mouse.move(imageBounds!.x + imageBounds!.width * 0.7, imageBounds!.y + imageBounds!.height * 0.72, { steps: 6 });
        await page.mouse.up();
        await expect(emotionDialog.getByRole("button", { name: "选择手动框选", exact: true })).toHaveText("");
        await expect(emotionDialog.getByRole("button", { name: "生成表情参考" })).toBeEnabled();

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            const bounds = await emotionDialog.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(-1);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
            await expectCloseControlSeparated(emotionDialog);
            await expectNoHorizontalOverflow(page, `Canvas 表情参考 ${width}px`);
        }
        await emotionDialog.getByRole("button", { name: "取消" }).click();

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await sourceImage.click();
        await page.getByRole("button", { name: "识别人脸并调节表情参考", exact: true }).click();
        await expect(emotionDialog).toBeVisible();
        await expectCloseControlSeparated(emotionDialog);
        await expectNoHorizontalOverflow(page, "Canvas 表情参考深色主题");
        await emotionDialog.getByRole("button", { name: "取消" }).click();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

async function fiveElementFixture() {
    const svg = `<svg width="1200" height="720" xmlns="http://www.w3.org/2000/svg">
        <rect width="1200" height="720" fill="#eef4f7"/>
        <g fill="#172033">${Array.from({ length: 8 }, (_, index) => `<rect x="${60 + index * 78}" y="48" width="54" height="58" rx="8"/>`).join("")}</g>
        <g stroke="#ffffff" stroke-width="6">
            <rect x="270" y="250" width="250" height="210" rx="28" fill="#61a889"/>
            <rect x="470" y="210" width="250" height="240" rx="28" fill="#84bd91"/>
            <rect x="390" y="390" width="270" height="210" rx="28" fill="#a3cc9b"/>
            <rect x="610" y="330" width="220" height="240" rx="28" fill="#76a48d"/>
        </g>
        <rect x="980" y="48" width="140" height="48" rx="16" fill="#e53935"/>
        <circle cx="984" cy="245" r="62" fill="#f8bd3e" stroke="#ffffff" stroke-width="6"/>
        <g fill="#d7e5ed" stroke="#ffffff" stroke-width="5"><circle cx="92" cy="550" r="45"/><circle cx="158" cy="525" r="54"/><circle cx="205" cy="580" r="42"/></g>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

async function plainSubjectFixture() {
    const head = await sharp({ create: { width: 180, height: 180, channels: 4, background: "#f0b790" } })
        .png()
        .toBuffer();
    const body = await sharp({ create: { width: 290, height: 520, channels: 4, background: "#274c77" } })
        .png()
        .toBuffer();
    return sharp({ create: { width: 640, height: 960, channels: 4, background: "#dce7ef" } })
        .composite([
            { input: body, left: 175, top: 350 },
            { input: head, left: 230, top: 240 },
        ])
        .png()
        .toBuffer();
}

async function expectCloseControlSeparated(dialog: Locator) {
    const closeButton = dialog.locator(".ant-modal-close");
    const modeControls = dialog.locator("[data-face-mode-controls]");
    await expect(closeButton).toBeVisible();
    await expect(modeControls).toBeVisible();
    const [closeBounds, controlsBounds] = await Promise.all([closeButton.boundingBox(), modeControls.boundingBox()]);
    expect(closeBounds).not.toBeNull();
    expect(controlsBounds).not.toBeNull();
    const separated =
        closeBounds!.x + closeBounds!.width <= controlsBounds!.x || controlsBounds!.x + controlsBounds!.width <= closeBounds!.x || closeBounds!.y + closeBounds!.height <= controlsBounds!.y || controlsBounds!.y + controlsBounds!.height <= closeBounds!.y;
    expect(separated, "人脸面板关闭按钮不应与模式控件重叠").toBe(true);
}

async function expectFaceDialogDesktopLayout(dialog: Locator) {
    await expect(dialog).toHaveCSS("transform", "none");
    const title = dialog.locator("[data-face-dialog-title]");
    const status = dialog.locator("[data-face-dialog-status]");
    const modeControls = dialog.locator("[data-face-mode-controls]");
    const autoDetectButton = dialog.getByRole("button", { name: "自动识别", exact: true });
    const manualSelectButton = dialog.getByRole("button", { name: "手动框选", exact: true });
    const previewPanel = dialog.locator("[data-face-preview-panel]");
    const previewImage = dialog.getByRole("img", { name: "待调整表情的图片" });
    const controlPanel = dialog.locator("[data-face-control-panel]");
    const [titleBounds, statusBounds, modeBounds, autoDetectBounds, manualSelectBounds, buttonHeights, panelWidths, previewBounds, imageBounds, controlBounds] = await Promise.all([
        title.boundingBox(),
        status.boundingBox(),
        modeControls.boundingBox(),
        autoDetectButton.boundingBox(),
        manualSelectButton.boundingBox(),
        Promise.all([autoDetectButton, manualSelectButton].map((button) => button.evaluate((element) => Number.parseFloat(getComputedStyle(element).height)))),
        Promise.all([modeControls, controlPanel].map((element) => element.evaluate((node) => Number.parseFloat(getComputedStyle(node).width)))),
        previewPanel.boundingBox(),
        previewImage.boundingBox(),
        controlPanel.boundingBox(),
    ]);
    for (const bounds of [titleBounds, statusBounds, modeBounds, autoDetectBounds, manualSelectBounds, previewBounds, imageBounds, controlBounds]) expect(bounds).not.toBeNull();
    expect(statusBounds!.x, "识别状态应紧跟标题显示").toBeGreaterThanOrEqual(titleBounds!.x + titleBounds!.width);
    const titleCenterY = titleBounds!.y + titleBounds!.height / 2;
    const statusCenterY = statusBounds!.y + statusBounds!.height / 2;
    expect(Math.abs(titleCenterY - statusCenterY), "标题与识别状态应处于同一水平线").toBeLessThanOrEqual(1);
    expect(Math.abs(titleBounds!.height - statusBounds!.height), "标题与识别状态应使用相同的行高").toBeLessThanOrEqual(1);
    expect(Math.abs(modeBounds!.y - controlBounds!.y), "识别方式应位于右侧参数区顶部").toBeLessThanOrEqual(1);
    expect(Math.abs(panelWidths[0] - panelWidths[1]), "识别方式应均衡铺满右侧参数栏").toBeLessThanOrEqual(1);
    expect(Math.min(...buttonHeights), "识别方式按钮不应过小").toBeGreaterThanOrEqual(27);
    expect(Math.max(...buttonHeights), "识别方式按钮不应过大").toBeLessThanOrEqual(29);
    expect(Math.abs(previewBounds!.y - controlBounds!.y), "图片与表情参数区应从同一顶边开始").toBeLessThanOrEqual(1);
    expect(previewBounds!.height - imageBounds!.height, "图片预览框不应被右侧参数栏拉出大块留白").toBeLessThanOrEqual(28);
    expect(imageBounds!.width / imageBounds!.height, "图片应保持原始宽高比").toBeCloseTo(1200 / 720, 2);
}

async function expectIntensityMarksContained(dialog: Locator) {
    const intensity = dialog.locator("[data-emotion-intensity-slider]");
    const firstMark = intensity.getByText("轻微", { exact: true });
    const lastMark = intensity.getByText("强烈", { exact: true });
    const [intensityBounds, firstBounds, lastBounds] = await Promise.all([intensity.boundingBox(), firstMark.boundingBox(), lastMark.boundingBox()]);
    for (const bounds of [intensityBounds, firstBounds, lastBounds]) expect(bounds).not.toBeNull();
    expect(firstBounds!.x, "左侧强度标签不应溢出").toBeGreaterThanOrEqual(intensityBounds!.x);
    expect(lastBounds!.x + lastBounds!.width, "右侧强度标签不应溢出").toBeLessThanOrEqual(intensityBounds!.x + intensityBounds!.width);
}

async function expectConnectionsAvoidNodes(page: import("@playwright/test").Page, connections: Array<{ id: string; endpoints: string[] }>) {
    const violations = await page.evaluate((items) => {
        const nodeElements = [...document.querySelectorAll<HTMLElement>("[data-node-id]")];
        const paths = items.map(({ id, endpoints }) => {
            const path = document.querySelector<SVGPathElement>(`[data-connection-id="${CSS.escape(id)}"] path:last-child`);
            if (!path) return { id, endpoints, points: [], error: `${id}: missing path` };
            const matrix = path.getScreenCTM();
            if (!matrix) return { id, endpoints, points: [], error: `${id}: missing matrix` };
            const length = path.getTotalLength();
            const points = Array.from({ length: Math.ceil(length / 6) + 1 }, (_, index) => {
                const local = path.getPointAtLength(Math.min(length, index * 6));
                const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
                return { x: screen.x, y: screen.y };
            });
            return { id, endpoints, points, error: "" };
        });
        const violations = paths.flatMap(({ id, endpoints, points, error }) => {
            if (error) return [error];
            const unrelated = nodeElements.filter((element) => !endpoints.includes(element.dataset.nodeId || ""));
            for (const screen of points.slice(1, -1)) {
                const blocking = unrelated.find((element) => {
                    const rect = element.getBoundingClientRect();
                    return screen.x > rect.left + 3 && screen.x < rect.right - 3 && screen.y > rect.top + 3 && screen.y < rect.bottom - 3;
                });
                if (blocking) return [`${id}: crosses ${blocking.dataset.nodeId}`];
            }
            return [];
        });
        const cross = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        for (let first = 0; first < paths.length; first += 1) {
            for (let second = first + 1; second < paths.length; second += 1) {
                const a = paths[first];
                const b = paths[second];
                if (a.error || b.error || a.endpoints.some((endpoint) => b.endpoints.includes(endpoint))) continue;
                let intersects = false;
                for (let aIndex = 1; aIndex < a.points.length && !intersects; aIndex += 1) {
                    const aStart = a.points[aIndex - 1];
                    const aEnd = a.points[aIndex];
                    for (let bIndex = 1; bIndex < b.points.length; bIndex += 1) {
                        const bStart = b.points[bIndex - 1];
                        const bEnd = b.points[bIndex];
                        if (cross(aStart, aEnd, bStart) * cross(aStart, aEnd, bEnd) < 0 && cross(bStart, bEnd, aStart) * cross(bStart, bEnd, aEnd) < 0) {
                            intersects = true;
                            break;
                        }
                    }
                }
                if (intersects) violations.push(`${a.id}: crosses ${b.id}`);
            }
        }
        return violations;
    }, connections);
    expect(violations).toEqual([]);
}
