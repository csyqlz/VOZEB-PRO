import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";

import { createCanvasProject, deleteCanvasProject, expectCanvasSaved, expectNoHorizontalOverflow, node, readCanvasProject } from "./canvas-e2e-helpers";
import { E2E_PROTOCOL_ORIGIN } from "./support";

test.describe.configure({ mode: "serial" });

test("canvas keeps editing, selection, linking and persistence fluid", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 交互回归 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [
            node("text-source", "text", 60, 100, 240, 170, { content: "创作方向" }),
            node("config-target", "config", 380, 100, 280, 210, { size: "1280x720", composerContent: "" }),
            node("image-target", "image", 200, 360, 260, 200, { content: "/logo.svg", serverUrl: "/logo.svg" }),
        ],
        connections: [],
    });

    try {
        const projectPath = `/api/canvas/projects/${project.id}`;
        const patchRequests: number[] = [];
        page.on("request", (request) => {
            if (request.method() === "PATCH" && new URL(request.url()).pathname === projectPath) patchRequests.push(Date.now());
        });

        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await expect(surface).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(surface.locator("[data-canvas-grid]")).toBeVisible();
        await expect(surface.locator("[data-canvas-grid]")).not.toHaveCSS("background-image", "none");

        const configNode = page.locator('[data-node-id="config-target"]');
        await expect.poll(async () => (await configNode.boundingBox())!.height).toBeLessThanOrEqual(182);
        const initialConfigBox = await configNode.boundingBox();
        expect(initialConfigBox).not.toBeNull();
        const generationModeButton = configNode.getByRole("button", { name: "切换生成类型，当前生图" });
        await expect(generationModeButton).toBeVisible();
        await generationModeButton.click();
        await expect(page.getByRole("menuitem", { name: "视频" })).toBeVisible();
        await page.getByRole("menuitem", { name: "视频" }).click();
        await expect(configNode.getByRole("button", { name: "切换生成类型，当前视频" })).toBeVisible();
        await expect(configNode.locator(".canvas-composer-model-picker")).not.toHaveAttribute("title", "gpt-image-2");
        const configDetailsToggle = configNode.getByRole("button", { name: "展开输入与镜头" });
        await expect(configDetailsToggle).toBeVisible();
        await expect(configNode.locator("[data-canvas-config-details]")).toHaveCount(0);
        await configDetailsToggle.click();
        await expect(configNode.getByRole("button", { name: "收起输入与镜头" })).toBeVisible();
        await expect(configNode.locator("[data-canvas-config-details]")).toBeVisible();
        await expect.poll(async () => (await configNode.boundingBox())!.height).toBeGreaterThan(initialConfigBox!.height + 40);
        await configNode.getByRole("button", { name: "收起输入与镜头" }).click();
        await expect(configNode.locator("[data-canvas-config-details]")).toHaveCount(0);
        await expect.poll(async () => (await configNode.boundingBox())!.height).toBeLessThanOrEqual(182);
        await configNode.click({ position: { x: 36, y: 36 } });
        const composer = page.locator('[contenteditable="true"]');
        await expect(composer).toBeVisible();
        await expect.poll(() => composer.evaluate((element) => document.activeElement === element)).toBe(true);
        const composerPatchCount = patchRequests.length;
        await composer.fill("单击即可输入并保存");
        await expect.poll(() => patchRequests.length).toBeGreaterThan(composerPatchCount);
        await expectCanvasSaved(page);

        await page.reload({ waitUntil: "domcontentloaded" });
        const restoredConfigNode = page.locator('[data-node-id="config-target"]');
        await expect.poll(async () => (await restoredConfigNode.boundingBox())!.height).toBeLessThanOrEqual(182);
        await restoredConfigNode.click({ position: { x: 36, y: 36 } });
        await expect(composer).toHaveText("单击即可输入并保存");
        await expect.poll(() => composer.evaluate((element) => document.activeElement === element)).toBe(true);
        await page.getByRole("button", { name: "关闭提示词组装" }).click();

        const imageNode = page.locator('[data-node-id="image-target"]');
        await imageNode.click({ position: { x: 36, y: 36 } });
        const nodePrompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(nodePrompt).toBeVisible();
        await expect.poll(() => nodePrompt.evaluate((element) => document.activeElement === element)).toBe(true);
        await nodePrompt.fill("222@");
        const mentionMenu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(mentionMenu).toBeVisible();
        await expect(mentionMenu.getByText("图片1", { exact: true })).toBeVisible();
        await expect(mentionMenu.locator("img")).toBeVisible();
        await nodePrompt.fill("放大编辑后仍然同步");
        await page.getByRole("button", { name: "放大提示词输入" }).click();
        const promptDialog = page.getByRole("dialog", { name: "编辑提示词" });
        const expandedPrompt = promptDialog.getByRole("textbox", { name: "提示词编辑器" });
        await expect(promptDialog).toBeVisible();
        await expect(promptDialog.locator(".ant-modal-body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(promptDialog.locator('[data-canvas-prompt-editor="expanded"]')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(expandedPrompt).toHaveCSS("background-color", "rgb(238, 246, 251)");
        await expect(promptDialog.locator(".ant-modal-footer")).toHaveCount(0);
        await expect(expandedPrompt).toHaveValue("放大编辑后仍然同步");
        await expect.poll(() => expandedPrompt.evaluate((element) => document.activeElement === element)).toBe(true);
        await expandedPrompt.fill("弹窗中的长提示词会实时回写原输入框");
        await promptDialog.getByRole("button", { name: "收起提示词输入" }).click();
        await expect(promptDialog).toBeHidden();
        await expect(nodePrompt).toHaveValue("弹窗中的长提示词会实时回写原输入框");

        await page.getByRole("button", { name: "切换到框选模式" }).click();
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "select");
        await dragSelectionBox(page, page.locator("[data-node-id]"));
        await expectSelectedNodeCount(page, 3);

        const temporaryPanNodeBox = await configNode.boundingBox();
        const temporaryPanViewport = await readCanvasViewport(request, projectPath);
        expect(temporaryPanNodeBox).not.toBeNull();
        await surface.focus();
        await page.keyboard.down("Space");
        await expect(surface).toHaveAttribute("data-canvas-temporary-pan", "true");
        await page.mouse.move(temporaryPanNodeBox!.x + 80, temporaryPanNodeBox!.y + 60);
        await page.mouse.down();
        await page.mouse.move(temporaryPanNodeBox!.x + 140, temporaryPanNodeBox!.y + 95, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up("Space");
        await expect(surface).toHaveAttribute("data-canvas-temporary-pan", "false");
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "select");
        await expect.poll(async () => (await readCanvasViewport(request, projectPath)).x).toBeGreaterThan(temporaryPanViewport.x + 40);
        const temporaryPanNodeAfter = await configNode.boundingBox();
        expect(temporaryPanNodeAfter!.x - temporaryPanNodeBox!.x).toBeGreaterThan(40);
        expect(temporaryPanNodeAfter!.x - temporaryPanNodeBox!.x).toBeLessThan(80);

        const sourceNode = page.locator('[data-node-id="text-source"]');
        await expect.poll(() => page.locator("[data-canvas-world-viewport]").evaluate((element) => element.scrollTop)).toBe(0);
        await sourceNode.click();
        await page.keyboard.down("Control");
        await page.locator('[data-node-id="config-target"]').click({ position: { x: 36, y: 36 } });
        await page.keyboard.up("Control");
        await expectSelectedNodeCount(page, 2);

        await dragConnection(page, sourceNode, sourceNode);
        await expect(page.locator("[data-connection-create-menu]")).toHaveCount(0);

        await dragConnection(page, sourceNode, page.locator('[data-node-id="config-target"]'));
        await expect(page.locator("[data-connection-id]")).toHaveCount(1);

        const surfaceBounds = await surface.boundingBox();
        expect(surfaceBounds).not.toBeNull();
        await dragConnectionToPoint(page, sourceNode, surfaceBounds!.x + surfaceBounds!.width - 70, surfaceBounds!.y + surfaceBounds!.height - 70);
        const createMenu = page.locator("[data-connection-create-menu]");
        await expect(createMenu).toBeVisible();
        await expect
            .poll(async () => {
                const menu = await createMenu.boundingBox();
                const canvas = await surface.boundingBox();
                return Boolean(menu && canvas && menu.x >= canvas.x && menu.y >= canvas.y && menu.x + menu.width <= canvas.x + canvas.width && menu.y + menu.height <= canvas.y + canvas.height);
            })
            .toBe(true);
        await createMenu.getByRole("button", { name: /图片生成/ }).click();
        await expect(page.locator("[data-connection-id]")).toHaveCount(2);
        await expect(page.locator("[data-node-id]")).toHaveCount(4);
        await page.waitForTimeout(500);
        await expectCanvasSaved(page);

        patchRequests.length = 0;
        const beforeDrag = await sourceNode.boundingBox();
        expect(beforeDrag).not.toBeNull();
        const dragStart = { x: beforeDrag!.x + beforeDrag!.width / 2, y: beforeDrag!.y + beforeDrag!.height - 28 };
        await page.mouse.move(dragStart.x, dragStart.y);
        await page.mouse.down();
        await page.mouse.move(dragStart.x + 90, dragStart.y + 45, { steps: 8 });
        await page.waitForTimeout(400);
        expect(patchRequests).toHaveLength(0);
        await page.mouse.up();
        await expect.poll(() => patchRequests.length).toBe(1);
        await expectCanvasSaved(page);
        const afterDrag = await sourceNode.boundingBox();
        expect(afterDrag!.x).toBeGreaterThan(beforeDrag!.x + 70);

        const resizeHandle = sourceNode.locator('[data-canvas-resize-corner="bottom-right"]');
        const handleBounds = await resizeHandle.boundingBox();
        const beforeResize = await sourceNode.boundingBox();
        expect(handleBounds).not.toBeNull();
        await page.mouse.move(handleBounds!.x + handleBounds!.width / 2, handleBounds!.y + handleBounds!.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBounds!.x + 75, handleBounds!.y + 45, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => (await sourceNode.boundingBox())!.width).toBeGreaterThan(beforeResize!.width + 40);
        await expect.poll(() => patchRequests.length).toBeGreaterThan(1);
        await expectCanvasSaved(page);

        await page.keyboard.down("Control");
        await imageNode.click({ position: { x: 36, y: 36 } });
        await page.keyboard.up("Control");
        await expectSelectedNodeCount(page, 2);
        await page.getByRole("button", { name: "切换到小手模式" }).click();
        await expect(surface).toHaveAttribute("data-canvas-interaction-mode", "pan");
        await expectSelectedNodeCount(page, 2);
        const copyPatchCount = patchRequests.length;
        await page.keyboard.press("Control+c");
        await page.keyboard.press("Control+v");
        await expect.poll(() => patchRequests.length).toBeGreaterThan(copyPatchCount);
        await expectCanvasSaved(page);
        await expect.poll(() => readCanvasNodeCount(request, projectPath)).toBe(6);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas node prompt keeps image and video mentions after long text", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 节点长提示词引用 ${randomUUID().slice(0, 8)}`,
        nodes: [
            { ...node("prompt-image", "image", 60, 80, 220, 160, { content: `${E2E_PROTOCOL_ORIGIN}/media/fixture.png`, serverUrl: `${E2E_PROTOCOL_ORIGIN}/media/fixture.png` }), title: "节点参考图片" },
            { ...node("prompt-video", "video", 60, 300, 220, 160, { content: `${E2E_PROTOCOL_ORIGIN}/media/fixture.mp4`, serverUrl: `${E2E_PROTOCOL_ORIGIN}/media/fixture.mp4` }), title: "节点参考视频" },
            node("prompt-target", "image", 420, 180, 260, 200, {}),
        ],
        connections: [
            { id: "prompt-image-edge", fromNodeId: "prompt-image", toNodeId: "prompt-target" },
            { id: "prompt-video-edge", fromNodeId: "prompt-video", toNodeId: "prompt-target" },
        ],
    });

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await page.locator('[data-node-id="prompt-target"]').click({ position: { x: 40, y: 40 } });
        const prompt = page.getByRole("textbox", { name: "节点提示词" });
        await expect(prompt).toBeVisible({ timeout: 20_000 });

        const longText = Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 条镜头要求保持人物、场景和光线连续。`).join("\n");
        await prompt.fill(`${longText}\n先参考@图`);
        let menu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(menu).toBeVisible();
        const imageOption = menu.getByRole("button").filter({ hasText: "图片1" });
        await expect(imageOption.locator("img")).toBeVisible();
        await imageOption.click();
        await expect(prompt).toHaveValue(`${longText}\n先参考图片1 `);

        await prompt.fill(`${await prompt.inputValue()}再结合@视`);
        menu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(menu).toBeVisible();
        const videoOption = menu.getByRole("button").filter({ hasText: "视频1" });
        await expect(videoOption.locator("video")).toBeVisible();
        await videoOption.click();
        await expect(prompt).toHaveValue(`${longText}\n先参考图片1 再结合视频1 `);
        await expect(page.locator('[data-canvas-resource-reference="prompt-image"] img')).toBeVisible();
        await expect(page.locator('[data-canvas-resource-reference="prompt-video"] video')).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas video first and last frame roles persist and retry from the output snapshot", async ({ page, request }) => {
    test.setTimeout(120_000);
    const project = await createCanvasProject(request, {
        title: `Canvas 首尾帧 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 36, y: 110, k: 1 },
        nodes: [
            { ...node("first-frame", "image", 430, 60, 220, 150, { content: "https://cdn.example.com/canvas-first.webp", remoteUrl: "https://cdn.example.com/canvas-first.webp", naturalWidth: 1280, naturalHeight: 720 }), title: "首帧图片" },
            { ...node("last-frame", "image", 430, 260, 220, 150, { content: "https://cdn.example.com/canvas-last.webp", remoteUrl: "https://cdn.example.com/canvas-last.webp", naturalWidth: 1280, naturalHeight: 720 }), title: "尾帧图片" },
            node("video-config", "config", 20, 90, 300, 180, { generationMode: "video", composerContent: "让画面从清晨平滑过渡到黄昏", size: "1280x720", seconds: "5", vquality: "720" }),
        ],
        connections: [
            { id: "first-frame-edge", fromNodeId: "first-frame", toNodeId: "video-config" },
            { id: "last-frame-edge", fromNodeId: "last-frame", toNodeId: "video-config" },
        ],
    });
    const submitted: Array<{ prompt: string; references: Array<{ type: string; role: string; url: string }>; clientRequestId: string }> = [];

    await page.addInitScript(() => {
        if (!localStorage.getItem("vozeb-pro:theme_store")) localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 }));
    });
    await page.route("**/api/video-generation-tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON() as { prompt: string; references: Array<{ type: string; role: string; url: string }>; config?: { model?: string } };
        submitted.push({ prompt: body.prompt, references: body.references, clientRequestId: route.request().headers()["x-vozeb-pro-client-request-id"] || "" });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: { id: `canvas-video-task-${submitted.length}`, model: body.config?.model || "video-v1", durationSeconds: 5 } }) });
    });
    await page.route("**/api/video-tasks/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: { status: "error", error: "E2E 视频上游失败", canRetry: true } }) });
    });

    try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        const configNode = page.locator('[data-node-id="video-config"]');
        await expect(configNode).toBeVisible();

        let settingsTrigger = configNode.getByRole("button", { name: /^视频设置：/ });
        await settingsTrigger.click();
        let settings = page.locator("[data-canvas-video-reference-settings]");
        await expect(settings).toBeVisible();
        await settings.getByRole("button", { name: "视频参考模式：首尾帧" }).click();
        await settings.getByRole("button", { name: "设为视频首帧：首帧图片" }).click();
        await settings.getByRole("button", { name: "选择视频尾帧" }).click();
        await settings.getByRole("button", { name: "设为视频尾帧：尾帧图片" }).click();
        await expect(settings.getByText("首帧图片", { exact: true })).toBeVisible();
        await expect(settings.getByText("尾帧图片", { exact: true })).toBeVisible();
        settingsTrigger = configNode.getByRole("button", { name: /^视频设置：首尾帧/ });
        await settingsTrigger.click();
        await expect(settings).toBeHidden();

        await expect
            .poll(async () => {
                const stored = await readCanvasProject(request, `/api/canvas/projects/${project.id}`);
                return stored.nodes.find((item) => item.id === "video-config")?.metadata;
            })
            .toMatchObject({ videoReferenceMode: "first_last", videoFirstFrame: { nodeId: "first-frame" }, videoLastFrame: { nodeId: "last-frame" } });

        const collapseAgentPanel = page.getByRole("button", { name: "收起 Agent 面板" });
        if (await collapseAgentPanel.isVisible().catch(() => false)) {
            await collapseAgentPanel.click();
            await expect(collapseAgentPanel).toBeHidden();
        }

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await settingsTrigger.click();
            await expect(settings).toBeVisible();
            const bounds = await settings.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
            await expectNoHorizontalOverflow(page, `Canvas 首尾帧 ${width}px`);
            await settingsTrigger.click();
            await expect(settings).toBeHidden();
        }

        await page.setViewportSize({ width: 1280, height: 900 });
        await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveClass(/dark/);
        settingsTrigger = page.locator('[data-node-id="video-config"]').getByRole("button", { name: /^视频设置：首尾帧/ });
        await settingsTrigger.click();
        settings = page.locator("[data-canvas-video-reference-settings]");
        await expect(settings).toBeVisible();
        await expectNoHorizontalOverflow(page, "Canvas 首尾帧深色主题");
        await settingsTrigger.click();

        await page.locator('[data-node-id="video-config"]').getByRole("button", { name: "开始生成" }).click();
        await expect.poll(() => submitted.length).toBe(1);
        expect(submitted[0].references).toEqual([
            { type: "image", role: "first_frame", url: "https://cdn.example.com/canvas-first.webp" },
            { type: "image", role: "last_frame", url: "https://cdn.example.com/canvas-last.webp" },
        ]);
        const retryButton = page.getByRole("button", { name: "重试" });
        await expect(retryButton).toBeVisible({ timeout: 20_000 });

        settingsTrigger = page.locator('[data-node-id="video-config"]').getByRole("button", { name: /^视频设置：首尾帧/ });
        await settingsTrigger.click();
        settings = page.locator("[data-canvas-video-reference-settings]");
        await settings.getByRole("button", { name: "视频参考模式：普通参考" }).click();
        settingsTrigger = page.locator('[data-node-id="video-config"]').getByRole("button", { name: /^视频设置：普通参考/ });
        await settingsTrigger.click();
        await expect(settings).toBeHidden();

        await retryButton.click();
        await expect.poll(() => submitted.length).toBe(2);
        expect(submitted[1].prompt).toBe(submitted[0].prompt);
        expect(submitted[1].references).toEqual(submitted[0].references);
        expect(submitted[1].clientRequestId).not.toBe(submitted[0].clientRequestId);
        await expect
            .poll(async () => {
                const stored = await readCanvasProject(request, `/api/canvas/projects/${project.id}`);
                return stored.nodes.find((item) => item.type === "video")?.metadata?.videoReferences?.map((reference) => reference.role);
            })
            .toEqual(["first_frame", "last_frame"]);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas opens the Agent rail at the intended width and keeps a fresh chat after deletion", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas Agent 面板 ${randomUUID().slice(0, 8)}`,
        nodes: [
            { ...node("mention-image", "image", 80, 120, 220, 160, { content: `${E2E_PROTOCOL_ORIGIN}/media/fixture.png`, serverUrl: `${E2E_PROTOCOL_ORIGIN}/media/fixture.png` }), title: "协议引用图片" },
            { ...node("mention-video", "video", 340, 120, 220, 160, { content: `${E2E_PROTOCOL_ORIGIN}/media/fixture.mp4`, serverUrl: `${E2E_PROTOCOL_ORIGIN}/media/fixture.mp4` }), title: "协议引用视频" },
        ],
        connections: [],
        chatSessions: [
            {
                id: "agent-session",
                title: "待删除对话",
                messages: [{ id: "agent-message", role: "user", text: "删除后继续输入" }],
                createdAt: "2026-08-06T00:00:00.000Z",
                updatedAt: "2026-08-06T00:00:00.000Z",
            },
            {
                id: "agent-session-two",
                conversationId: "conversation-agent-two",
                title: "第二条对话",
                messages: [{ id: "agent-message-two", role: "user", text: "用于批量删除" }],
                createdAt: "2026-08-05T00:00:00.000Z",
                updatedAt: "2026-08-05T00:00:00.000Z",
            },
            {
                id: "agent-session-three",
                conversationId: "conversation-agent-three",
                title: "第三条对话",
                messages: [{ id: "agent-message-three", role: "user", text: "用于批量删除" }],
                createdAt: "2026-08-04T00:00:00.000Z",
                updatedAt: "2026-08-04T00:00:00.000Z",
            },
        ],
        activeChatId: "agent-session",
    });
    const deletedConversationIds: string[][] = [];
    let persistedAssistantSessions = project.chatSessions;

    try {
        const projectPath = `/api/canvas/projects/${project.id}`;
        await page.route(`**${projectPath}/assistant-conversations`, async (route) => {
            const body = route.request().postDataJSON() as { conversationIds: string[] };
            deletedConversationIds.push(body.conversationIds);
            const removed = new Set(body.conversationIds);
            persistedAssistantSessions = persistedAssistantSessions.filter((session) => !session.conversationId || !removed.has(session.conversationId));
            if (!persistedAssistantSessions.length) {
                persistedAssistantSessions = [{ id: "server-empty-session", title: "新对话", messages: [], createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" }];
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ code: 0, data: { deleted: body.conversationIds.length, chatSessions: persistedAssistantSessions, activeChatId: persistedAssistantSessions[0].id }, msg: "OK" }),
            });
        });
        await page.setViewportSize({ width: 1474, height: 900 });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });

        const panel = page.getByLabel("Canvas Agent 对话面板");
        await expect(panel).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => Math.round((await panel.boundingBox())?.width || 0)).toBe(404);
        await expect(page.getByRole("button", { name: "打开 Agent", exact: true })).toHaveCount(0);

        await page.getByRole("tab", { name: /历史/ }).click();
        await page.getByRole("button", { name: "修改标题：待删除对话" }).click();
        await page.getByRole("textbox", { name: "编辑对话标题" }).fill("已修改标题");
        await page.getByRole("textbox", { name: "编辑对话标题" }).press("Enter");
        await expect(page.getByText("已修改标题", { exact: true })).toBeVisible();
        await expect.poll(async () => (await readCanvasProject(request, projectPath)).chatSessions.find((session) => session.id === "agent-session")?.title).toBe("已修改标题");

        await page.getByRole("checkbox", { name: "选择对话：第二条对话" }).check();
        await page.getByRole("checkbox", { name: "选择对话：第三条对话" }).check();
        await page.getByRole("button", { name: "删除所选 (2)" }).click();
        let deleteDialog = page.getByRole("dialog", { name: "删除对话记录？" });
        await deleteDialog.getByRole("button", { name: /删\s*除/ }).click();
        await expect(page.getByText("第二条对话", { exact: true })).toHaveCount(0);
        await expect(page.getByText("第三条对话", { exact: true })).toHaveCount(0);
        expect(deletedConversationIds).toEqual([["conversation-agent-two", "conversation-agent-three"]]);
        await expect.poll(() => readCanvasChatState(request, projectPath)).toEqual({ sessions: 1, messages: 1 });

        await page.getByRole("button", { name: "删除对话：已修改标题" }).click();
        deleteDialog = page.getByRole("dialog", { name: "删除对话记录？" });
        await deleteDialog.getByRole("button", { name: /删\s*除/ }).click();

        await expect(page.getByRole("tab", { name: "对话", exact: true })).toHaveAttribute("aria-selected", "true");
        const agentComposer = page.getByPlaceholder("描述你想让 Agent 如何操作画布");
        await expect(agentComposer).toBeVisible();
        await expect(page.getByText("你好，我是你的画布助手", { exact: true })).toBeVisible();
        await expect.poll(() => page.locator("[data-canvas-agent-scroll]").evaluate((element) => element.scrollTop)).toBe(0);
        await expect.poll(() => readCanvasChatState(request, projectPath)).toEqual({ sessions: 1, messages: 0 });

        await agentComposer.fill("222@");
        const mentionPicker = page.getByTestId("canvas-agent-mention-picker");
        await expect(mentionPicker).toBeVisible();
        await expect(mentionPicker.getByRole("button", { name: "引用协议引用图片" })).toBeVisible();
        await expect(mentionPicker.locator("img")).toBeVisible();
        await mentionPicker.getByRole("button", { name: "引用协议引用图片" }).click();
        await expect(agentComposer).toHaveValue("222@图片1 ");
        await agentComposer.fill(`${await agentComposer.inputValue()}再参考@`);
        await expect(mentionPicker).toBeVisible();
        await mentionPicker.getByRole("tab", { name: /视频/ }).click();
        await expect(mentionPicker.getByRole("button", { name: "引用协议引用视频" })).toBeVisible();
        await expect(mentionPicker.locator("video")).toBeVisible();
        await mentionPicker.getByRole("button", { name: "引用协议引用视频" }).click();
        await expect(agentComposer).toHaveValue("222@图片1 再参考@视频1 ");
        await agentComposer.fill("");

        const generationPreferencesTrigger = panel.getByRole("button", { name: /生成参数：/ });
        await expect
            .poll(() => panel.locator("[data-canvas-agent-toolbar] button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") || "")))
            .toEqual([expect.stringMatching(/^(选择创作 Skill|当前 Skill：)/), expect.stringMatching(/^智能规划.*点击/), expect.stringMatching(/^(选择生成模型|已选择 \d+ 个模型)$/), expect.stringMatching(/^生成参数：/), "发送"]);
        await expect.poll(async () => Math.round((await generationPreferencesTrigger.boundingBox())?.width || 0)).toBeLessThanOrEqual(116);
        await generationPreferencesTrigger.click();
        const generationPreferencesPanel = page.locator("[data-creative-generation-preferences]");
        await expect(generationPreferencesPanel).toBeVisible();
        await expect.poll(async () => Math.round((await generationPreferencesPanel.boundingBox())?.width || 0)).toBe(280);
        await expect
            .poll(async () => {
                const bounds = await generationPreferencesPanel.boundingBox();
                return bounds ? bounds.x >= 0 && bounds.x + bounds.width <= 1475 : false;
            })
            .toBe(true);
        await generationPreferencesTrigger.click();

        await page.getByRole("button", { name: "收起 Agent 面板" }).click();
        await expect(page.getByRole("button", { name: "打开 Agent", exact: true })).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas Agent toolbar stays ordered and its generation settings fit narrow viewports", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas 参数布局 ${randomUUID().slice(0, 8)}`, nodes: [], connections: [] });

    try {
        await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
            await page.getByRole("button", { name: "打开 Agent", exact: true }).click();
            const panel = page.getByLabel("Canvas Agent 对话面板");
            const textarea = panel.getByRole("textbox", { name: "描述你想让 Agent 如何操作画布" });
            const trigger = panel.getByRole("button", { name: /生成参数：/ });
            await expect(panel).toBeVisible({ timeout: 20_000 });
            await expect.poll(async () => Math.round((await textarea.boundingBox())?.height || 0)).toBeGreaterThanOrEqual(80);
            await expect.poll(async () => Math.round((await trigger.boundingBox())?.width || 0)).toBeLessThanOrEqual(116);
            await expect
                .poll(() => panel.locator("[data-canvas-agent-toolbar] button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") || "")))
                .toEqual([expect.stringMatching(/^(选择创作 Skill|当前 Skill：)/), expect.stringMatching(/^智能规划.*点击/), expect.stringMatching(/^(选择生成模型|已选择 \d+ 个模型)$/), expect.stringMatching(/^生成参数：/), "发送"]);
            await expect
                .poll(async () => {
                    const controls = panel.locator("[data-creative-agent-controls='compact']");
                    const toolBoxes = await controls.locator(":scope > button, :scope > * > button").evaluateAll((buttons) =>
                        buttons.slice(0, 4).map((button) => {
                            const bounds = button.getBoundingClientRect();
                            return { left: bounds.left, right: bounds.right };
                        }),
                    );
                    const triggerBox = await trigger.boundingBox();
                    return {
                        leftToolGaps: toolBoxes.slice(1).map((box, index) => Math.round(box.left - toolBoxes[index].right)),
                        parameterAfterModel: toolBoxes[3] && toolBoxes[2] ? Math.round(toolBoxes[3].left - toolBoxes[2].right) : null,
                        parameterX: triggerBox ? Math.round(triggerBox.x) : null,
                    };
                })
                .toMatchObject({ leftToolGaps: [4, 4, 8], parameterAfterModel: 8 });
            await expect
                .poll(() =>
                    trigger
                        .locator("span")
                        .first()
                        .evaluate((element) => ({
                            text: element.textContent || "",
                            clipped: element.scrollWidth > element.clientWidth,
                            overflow: getComputedStyle(element).overflow,
                            textOverflow: getComputedStyle(element).textOverflow,
                        })),
                )
                .toMatchObject({ clipped: false, overflow: "visible", textOverflow: "clip" });

            await trigger.click();
            const visiblePreferencesPanel = page.locator("[data-creative-generation-preferences]:visible");
            await expect(visiblePreferencesPanel).toBeVisible();
            await expect.poll(async () => Math.round((await visiblePreferencesPanel.boundingBox())?.width || 0)).toBe(280);
            await expect
                .poll(async () => {
                    const bounds = await visiblePreferencesPanel.boundingBox();
                    return bounds ? bounds.x >= 0 && bounds.x + bounds.width <= width + 1 : false;
                })
                .toBe(true);
            await expectNoHorizontalOverflow(page, `Canvas Agent 参数 ${width}px`);
            await trigger.click();
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await expect(page.locator("[data-creative-generation-preferences]:visible")).toHaveCount(0);
        }

        await page.getByRole("button", { name: "收起 Agent 面板" }).click();
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await page.getByRole("button", { name: "打开 Agent", exact: true }).click();
        const darkTrigger = page.getByLabel("Canvas Agent 对话面板").getByRole("button", { name: /生成参数：/ });
        await darkTrigger.click();
        const darkPanel = page.locator("[data-creative-generation-preferences]:visible");
        await expect(darkPanel).toBeVisible();
        await expect.poll(async () => Math.round((await darkPanel.boundingBox())?.width || 0)).toBe(280);
        await expectNoHorizontalOverflow(page, "Canvas Agent 参数深色主题");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas keeps project chat state isolated during client-side project navigation", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 会话隔离 ${randomUUID().slice(0, 8)}`,
        nodes: [],
        connections: [],
        chatSessions: [
            {
                id: "source-session",
                title: "只属于原画布",
                messages: [{ id: "source-message", role: "user", text: "这条消息不能进入新画布" }],
                createdAt: "2026-08-11T00:00:00.000Z",
                updatedAt: "2026-08-11T00:00:00.000Z",
            },
        ],
        activeChatId: "source-session",
    });
    let createdProjectId = "";

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByText("这条消息不能进入新画布", { exact: true })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "打开资产面板" }).click();
        await page.getByRole("button", { name: "新建画布" }).click();
        await expect.poll(() => new URL(page.url()).pathname.split("/").pop()).not.toBe(project.id);
        createdProjectId = new URL(page.url()).pathname.split("/").pop() || "";

        await expect(page.getByText("你好，我是你的画布助手", { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText("这条消息不能进入新画布", { exact: true })).toHaveCount(0);
        await expect.poll(async () => (await readCanvasProject(request, `/api/canvas/projects/${createdProjectId}`)).chatSessions).toEqual([]);
    } finally {
        await deleteCanvasProject(request, project.id);
        if (createdProjectId) await deleteCanvasProject(request, createdProjectId);
    }
});

test("canvas separates project management from the command menu and keeps assets in a four-column rail", async ({ page, request }) => {
    const targetTitle = `Canvas 切换目标 ${randomUUID().slice(0, 8)}`;
    const target = await createCanvasProject(request, { title: targetTitle, nodes: [], connections: [] });
    const project = await createCanvasProject(request, {
        title: `Canvas 资产侧栏 ${randomUUID().slice(0, 8)}`,
        nodes: Array.from({ length: 5 }, (_, index) => node(`asset-${index + 1}`, "image", index * 180, 120, 160, 120, { content: "/logo.svg", naturalWidth: 160, naturalHeight: 120 })),
        connections: [],
    });

    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await expectCanvasSaved(page);
        await expect(page.getByLabel("画布已保存")).toHaveCount(0);

        await page.getByRole("button", { name: "打开画布菜单" }).click();
        await expect(page.getByRole("menuitem", { name: "导入素材" })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "资产面板" })).toHaveCount(0);
        await expect(page.getByRole("menuitem", { name: "删除画布" })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "新建画布" })).toHaveCount(0);
        await expect(page.getByRole("menuitem", { name: "我的画布" })).toHaveCount(0);
        await page.getByRole("button", { name: "打开画布菜单" }).click();

        const closedWidth = (await surface.boundingBox())?.width || 0;
        await page.getByRole("button", { name: "打开资产面板" }).click();
        const panel = page.getByLabel("Canvas 资产面板");
        await expect(panel).toBeVisible();
        await expect.poll(async () => closedWidth - ((await surface.boundingBox())?.width || 0)).toBeGreaterThan(300);

        const cards = panel.locator('[data-testid="canvas-current-assets-grid"] > article');
        await expect(cards).toHaveCount(5);
        const cardBoxes = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map(({ left, top, width }) => ({ left, top, width })));
        expect(new Set(cardBoxes.slice(0, 4).map((box) => Math.round(box.top))).size).toBe(1);
        expect(cardBoxes.slice(0, 4).map((box) => Math.round(box.left))).toEqual([...cardBoxes.slice(0, 4).map((box) => Math.round(box.left))].sort((a, b) => a - b));
        expect(cardBoxes[4].top).toBeGreaterThan(cardBoxes[0].top + cardBoxes[0].width);
        await expect(panel.getByText("asset-1", { exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "定位asset-1" })).toBeVisible();

        await panel.getByRole("button", { name: "切换画布" }).click();
        await page.getByRole("menuitem").filter({ hasText: targetTitle }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/canvas/${target.id}`);

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
            await expect(surface).toBeVisible({ timeout: 20_000 });
            const topbarGeometry = await page.locator(".canvas-topbar").evaluate((topbar) => {
                const title = topbar.querySelector<HTMLElement>(".canvas-topbar-title");
                const assets = topbar.querySelector<HTMLElement>('[aria-label="打开资产面板"], [aria-label="关闭资产面板"]');
                const actions = topbar.querySelector<HTMLElement>(".canvas-topbar-actions");
                const controls = actions ? Array.from(actions.querySelectorAll<HTMLElement>("button, a")).filter((control) => getComputedStyle(control).display !== "none") : [];
                const bounds = (element: Element | null) => {
                    if (!element) return null;
                    const rect = element.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
                };
                return {
                    viewportWidth: window.innerWidth,
                    documentWidth: document.documentElement.scrollWidth,
                    title: bounds(title),
                    assets: bounds(assets),
                    actions: bounds(actions),
                    controls: controls.map((control) => bounds(control)),
                };
            });
            expect(topbarGeometry.documentWidth).toBeLessThanOrEqual(width + 1);
            expect(topbarGeometry.title).not.toBeNull();
            expect(topbarGeometry.assets).not.toBeNull();
            expect(topbarGeometry.actions).not.toBeNull();
            expect(topbarGeometry.title!.width).toBeGreaterThanOrEqual(80);
            expect(topbarGeometry.assets!.width).toBeGreaterThanOrEqual(30);
            expect(topbarGeometry.title!.right).toBeLessThanOrEqual(topbarGeometry.assets!.left + 1);
            expect(topbarGeometry.title!.right).toBeLessThanOrEqual(topbarGeometry.actions!.left + 1);
            expect(topbarGeometry.controls.every((control) => control && control.left >= -1 && control.right <= topbarGeometry.viewportWidth + 1)).toBe(true);

            if (width === 390) {
                await page.getByRole("button", { name: "打开资产面板" }).click();
                const mobilePanel = page.getByLabel("Canvas 资产面板");
                await expect(mobilePanel).toBeVisible();
                await expect.poll(async () => (await mobilePanel.boundingBox())?.x ?? Number.NEGATIVE_INFINITY, { timeout: 3_000 }).toBeGreaterThanOrEqual(-1);
                const mobileBounds = await mobilePanel.boundingBox();
                expect(mobileBounds).not.toBeNull();
                expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
                expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(width + 1);
                await expectNoHorizontalOverflow(page, "Canvas 资产侧栏 390px");
            }
        }
    } finally {
        await deleteCanvasProject(request, project.id);
        await deleteCanvasProject(request, target.id);
    }
});

test("canvas Agent keeps simultaneous runs bound to separate chats", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas Agent 运行隔离 ${randomUUID().slice(0, 8)}`, nodes: [], connections: [] });
    const createBodies: Array<Record<string, unknown>> = [];
    const runs = new Map<string, Record<string, unknown>>();

    await page.route("**/api/agent/runs?**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { runs: [] }, msg: "OK" }) });
    });
    await page.route("**/api/agent/runs", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON() as Record<string, unknown>;
        createBodies.push(body);
        const index = createBodies.length;
        const run = {
            id: `run-${index}`,
            conversationId: `conversation-${index}`,
            inputMessageId: `input-${index}`,
            assistantMessageId: `assistant-${index}`,
            status: "running",
            surface: "canvas",
            projectId: project.id,
            assetIds: [],
            tasks: [],
        };
        runs.set(run.id, run);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { run, created: true }, msg: "OK" }) });
    });
    await page.route(/\/api\/agent\/runs\/run-\d+$/, async (route) => {
        const runId = new URL(route.request().url()).pathname.split("/").pop() || "";
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { run: runs.get(runId) }, msg: "OK" }) });
    });
    await page.route(/\/api\/agent\/runs\/run-\d+\/events$/, async (route) => {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: run.planning\ndata: {"data":{}}\n\n' });
    });

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const composer = page.getByPlaceholder("描述你想让 Agent 如何操作画布");
        await expect(composer).toBeVisible({ timeout: 20_000 });
        await composer.fill("第一条后台任务");
        await page.getByRole("button", { name: "发送" }).click();
        await expect.poll(() => createBodies.length).toBe(1);

        await page.getByRole("button", { name: "新建对话" }).click();
        await expect(composer).toBeEnabled();
        await composer.fill("第二条后台任务");
        await page.getByRole("button", { name: "发送" }).click();
        await expect.poll(() => createBodies.length).toBe(2);

        expect(createBodies.map((body) => body.conversationId)).toEqual([undefined, undefined]);
        await expect
            .poll(async () => {
                const sessions = (await readCanvasProject(request, `/api/canvas/projects/${project.id}`)).chatSessions;
                return sessions
                    .map((session) => session.conversationId)
                    .filter(Boolean)
                    .sort();
            })
            .toEqual(["conversation-1", "conversation-2"]);

        await page.getByRole("tab", { name: /历史/ }).click();
        await page.getByRole("button", { name: "进入对话：第一条后台任务" }).click();
        await expect(page.getByText(/正在理解需求并分析当前画布|任务仍在后台运行/)).toBeVisible();
        await expect(page.getByText("第一条后台任务", { exact: true })).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas remains operable with 10001 nodes and 10000 connections", async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const nodes = Array.from({ length: 10_001 }, (_, index) => node(`perf-node-${index}`, index % 9 === 0 ? "config" : "text", (index % 100) * 320, Math.floor(index / 100) * 240, 240, 160, { content: `节点 ${index}` }));
    const connections = Array.from({ length: 10_000 }, (_, index) => {
        const sourceIndex = (index * 17) % 10_001;
        let targetIndex = (index * 37 + 1) % 10_001;
        if (targetIndex === sourceIndex) targetIndex = (targetIndex + 1) % 10_001;
        return { id: `perf-edge-${index}`, fromNodeId: `perf-node-${sourceIndex}`, toNodeId: `perf-node-${targetIndex}` };
    });
    const project = await createCanvasProject(request, { title: `Canvas 性能回归 ${randomUUID().slice(0, 8)}`, viewport: { x: 80, y: 100, k: 1 }, nodes, connections });

    try {
        await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
        const startedAt = Date.now();
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('[data-node-id="perf-node-0"]')).toBeVisible();
        const interactiveMs = Date.now() - startedAt;
        const renderedNodeCount = await page.locator("[data-node-id]").count();
        expect(renderedNodeCount).toBeGreaterThan(0);
        expect(renderedNodeCount).toBeLessThan(nodes.length);

        await page.getByRole("button", { name: "打开小地图" }).click();
        await expect(page.locator("[data-canvas-minimap] canvas")).toBeVisible();
        expect(await page.locator("[data-canvas-minimap] [data-node-id]").count()).toBe(0);

        const surface = page.locator("[data-canvas-surface]");
        const bounds = await surface.boundingBox();
        expect(bounds).not.toBeNull();
        const navigationStartedAt = Date.now();
        await page.mouse.move(bounds!.x + bounds!.width - 35, bounds!.y + bounds!.height - 35);
        await page.mouse.down();
        await page.mouse.move(bounds!.x + bounds!.width - 155, bounds!.y + bounds!.height - 95, { steps: 8 });
        await page.mouse.up();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const navigationMs = Date.now() - navigationStartedAt;
        await page.waitForTimeout(500);
        await expectCanvasSaved(page);

        const surfaceImage = await surface.screenshot();
        const { data: surfacePixels, info: surfaceInfo } = await sharp(surfaceImage).raw().toBuffer({ resolveWithObject: true });
        const cornerPixels = [
            [4, 4],
            [surfaceInfo.width - 5, 4],
            [4, surfaceInfo.height - 5],
            [surfaceInfo.width - 5, surfaceInfo.height - 5],
        ].map(([x, y]) => {
            const offset = (y * surfaceInfo.width + x) * surfaceInfo.channels;
            return [surfacePixels[offset], surfacePixels[offset + 1], surfacePixels[offset + 2]];
        });
        expect(
            cornerPixels.some(([red, green, blue]) => red > 240 && green > 240 && blue > 240),
            "Canvas background must not become a white composite layer in dark mode",
        ).toBe(false);

        const firstNode = page.locator('[data-node-id="perf-node-0"]');
        const firstBounds = await firstNode.boundingBox();
        expect(firstBounds).not.toBeNull();
        const saveStartedAt = Date.now();
        const patchRequest = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/canvas/projects/${project.id}`);
        await page.mouse.move(firstBounds!.x + 80, firstBounds!.y + 16);
        await page.mouse.down();
        await page.mouse.move(firstBounds!.x + 125, firstBounds!.y + 41, { steps: 6 });
        await page.mouse.up();
        await patchRequest;
        await expectCanvasSaved(page, 10_000);
        const saveMs = Date.now() - saveStartedAt;

        const metrics = { nodes: nodes.length, connections: connections.length, interactiveMs, navigationMs, saveMs, renderedNodeCount };
        await testInfo.attach("canvas-performance.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
        expect(interactiveMs).toBeLessThan(20_000);
        expect(navigationMs).toBeLessThan(1_500);
        expect(saveMs).toBeLessThan(10_000);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas restores all nine node types and opens text editing on a single click", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Canvas 节点矩阵 ${randomUUID().slice(0, 8)}`,
        viewport: { x: 90, y: 80, k: 0.75 },
        nodes: [
            node("matrix-image", "image", 40, 80, 240, 180, { content: "/logo.svg", naturalWidth: 240, naturalHeight: 180 }),
            node("matrix-panorama", "panorama", 340, 80, 300, 150, { content: "/logo.svg", naturalWidth: 300, naturalHeight: 150 }),
            node("matrix-text", "text", 700, 80, 260, 180, { content: "单击编辑文本" }),
            node("matrix-config", "config", 1020, 80, 300, 180, { generationMode: "image", model: "" }),
            node("matrix-video", "video", 40, 360, 260, 170, { content: "/logo.svg", mimeType: "video/mp4" }),
            node("matrix-audio", "audio", 340, 360, 260, 150, { content: "/logo.svg", mimeType: "audio/mpeg" }),
            node("matrix-brief", "brief", 700, 340, 320, 210, { agentBrief: { objective: "节点矩阵目标", deliverables: [{ type: "image", title: "主视觉", count: 1 }] } }),
            node("matrix-task", "task", 40, 640, 300, 180, { prompt: "任务恢复内容", agentTaskStatus: "completed", agentTaskAttempts: 1 }),
            node("matrix-brand", "brand-kit", 420, 620, 320, 200, { brandKit: { summary: "品牌方向恢复", keywords: ["电影感"] } }),
        ],
        connections: [],
    });
    const nodeTypes = new Map([
        ["matrix-image", "image"],
        ["matrix-panorama", "panorama"],
        ["matrix-text", "text"],
        ["matrix-config", "config"],
        ["matrix-video", "video"],
        ["matrix-audio", "audio"],
        ["matrix-brief", "brief"],
        ["matrix-task", "task"],
        ["matrix-brand", "brand-kit"],
    ]);
    const expectNodeTheme = async (theme: "light" | "dark") => {
        const colors =
            theme === "light"
                ? { fill: "rgb(238, 246, 251)", panel: "rgb(255, 255, 255)", stroke: "rgb(217, 231, 238)", text: "rgb(30, 41, 59)", subtle: "rgb(248, 250, 252)", subtleText: "rgb(71, 85, 105)" }
                : { fill: "rgb(17, 19, 24)", panel: "rgb(15, 17, 21)", stroke: "rgb(48, 54, 66)", text: "rgb(248, 250, 252)", subtle: "rgb(26, 31, 39)", subtleText: "rgb(203, 213, 225)" };

        for (const [id, type] of nodeTypes) {
            const frame = page.locator(`[data-node-id="${id}"] > div`).first();
            const expectedBackground = type === "image" || type === "panorama" || type === "video" ? "rgba(0, 0, 0, 0)" : type === "config" ? colors.panel : colors.fill;
            await expect(frame, `${type} ${theme} border`).toHaveCSS("border-color", colors.stroke);
            await expect(frame, `${type} ${theme} background`).toHaveCSS("background-color", expectedBackground);
            await expect(frame, `${type} ${theme} text`).toHaveCSS("color", colors.text);
        }

        for (const chip of [page.locator('[data-node-id="matrix-brief"]').getByText("主视觉", { exact: true }), page.locator('[data-node-id="matrix-brand"]').getByText("电影感", { exact: true })]) {
            await expect(chip).toHaveCSS("background-color", colors.subtle);
            await expect(chip).toHaveCSS("border-color", colors.stroke);
            await expect(chip).toHaveCSS("color", colors.subtleText);
        }
    };

    try {
        await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible({ timeout: 20_000 });
        await expect.poll(async () => readCanvasViewport(request, `/api/canvas/projects/${project.id}`)).toEqual({ x: 90, y: 80, k: 0.75 });
        await expect(page.locator("[data-node-id]")).toHaveCount(9);
        await expect(page.locator('[data-node-id="matrix-brief"]').getByText("创作目标")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-brief"]').getByText("节点矩阵目标")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-task"]').getByText("任务恢复内容")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-brand"]').getByText("灵感与视觉方向")).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-video"] video')).toBeVisible();
        await expect(page.locator('[data-node-id="matrix-audio"] audio')).toBeVisible();
        await expectNodeTheme("light");

        const surface = page.locator("[data-canvas-surface]");
        const imageNode = page.locator('[data-node-id="matrix-image"]');
        const nodeToolbar = page.locator("[data-canvas-hover-toolbar]");
        await imageNode.hover();
        await expect(nodeToolbar).toHaveCount(0);
        await imageNode.click({ position: { x: 48, y: 48 } });
        await expect(nodeToolbar).toBeVisible();
        await surface.click({ position: { x: 20, y: 20 } });
        await expect(nodeToolbar).toHaveCount(0);

        for (const item of [
            { id: "matrix-panorama", x: 340 },
            { id: "matrix-video", x: 40 },
        ]) {
            const movableNode = page.locator(`[data-node-id="${item.id}"]`);
            const bounds = await movableNode.boundingBox();
            expect(bounds).not.toBeNull();
            const start = { x: bounds!.x + bounds!.width * 0.35, y: bounds!.y + bounds!.height * 0.35 };
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(start.x + 64, start.y + 36, { steps: 6 });
            await page.mouse.up();
            await expect.poll(async () => (await readCanvasProject(request, `/api/canvas/projects/${project.id}`)).nodes.find((current) => current.id === item.id)?.position.x).toBeGreaterThan(item.x + 50);
        }
        await expectCanvasSaved(page);

        const textNode = page.locator('[data-node-id="matrix-text"]');
        await textNode.click({ position: { x: 50, y: 80 } });
        const textEditor = textNode.locator("textarea");
        await expect(textEditor).toBeVisible();
        await expect.poll(() => textEditor.evaluate((element) => document.activeElement === element)).toBe(true);
        await textEditor.fill("单击后立即可编辑");

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator('[data-node-id="matrix-text"]').getByText("单击后立即可编辑")).toBeVisible();
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expectNodeTheme("dark");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("canvas Agent attachment remove badge stays compact and theme readable", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas 删除角标 ${randomUUID().slice(0, 8)}`, nodes: [], connections: [] });

    try {
        await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 })));
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const panel = page.getByRole("complementary", { name: "Canvas Agent 对话面板" });
        await expect(panel).toBeVisible({ timeout: 20_000 });
        await panel.locator('input[type="file"][multiple]').setInputFiles({
            name: "reference.png",
            mimeType: "image/png",
            buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3kgAAAABJRU5ErkJggg==", "base64"),
        });

        const removeButton = panel.getByRole("button", { name: "移除参考素材：reference.png" });
        const badge = removeButton.locator(":scope > span");
        await expect(removeButton).toBeVisible();
        await expect.poll(async () => (await removeButton.boundingBox())?.width).toBe(28);
        await expect.poll(async () => (await removeButton.boundingBox())?.height).toBe(28);
        await expect.poll(async () => (await badge.boundingBox())?.width).toBe(16);
        await expect.poll(async () => (await badge.boundingBox())?.height).toBe(16);
        const badgeGeometry = await removeButton.evaluate((button) => {
            const badgeElement = button.firstElementChild;
            const preview = button.parentElement;
            if (!badgeElement || !preview) return null;
            const badgeBounds = badgeElement.getBoundingClientRect();
            const previewBounds = preview.getBoundingClientRect();
            return {
                left: badgeBounds.left,
                top: badgeBounds.top,
                right: badgeBounds.right,
                bottom: badgeBounds.bottom,
                previewLeft: previewBounds.left,
                previewTop: previewBounds.top,
                previewRight: previewBounds.right,
                previewBottom: previewBounds.bottom,
            };
        });
        expect(badgeGeometry).not.toBeNull();
        expect(badgeGeometry!.left).toBeGreaterThanOrEqual(badgeGeometry!.previewLeft);
        expect(badgeGeometry!.top).toBeGreaterThanOrEqual(badgeGeometry!.previewTop);
        expect(badgeGeometry!.right).toBeLessThanOrEqual(badgeGeometry!.previewRight);
        expect(badgeGeometry!.bottom).toBeLessThanOrEqual(badgeGeometry!.previewBottom);
        await expect(badge).toHaveCSS("background-color", "rgba(255, 255, 255, 0.94)");
        await expect(badge).toHaveCSS("border-color", "rgba(15, 23, 42, 0.16)");
        await expect(badge).toHaveCSS("color", "rgb(71, 85, 105)");
        await expect.poll(() => badge.evaluate((element) => Number.parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThanOrEqual(10);

        await removeButton.hover();
        await expect(badge).toHaveCSS("background-color", "rgb(255, 241, 242)");
        await expect(badge).toHaveCSS("color", "rgb(220, 38, 38)");
        await panel.getByRole("textbox", { name: "描述你想让 Agent 如何操作画布" }).click();
        await page.getByRole("button", { name: "切换到深色主题" }).click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(badge).toHaveCSS("background-color", "rgba(15, 23, 42, 0.88)");
        await expect(badge).toHaveCSS("border-color", "rgba(255, 255, 255, 0.2)");
        await removeButton.press("ArrowDown");
        await expect.poll(() => removeButton.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        await expect(badge).toHaveCSS("background-color", "rgb(42, 18, 21)");
        await expect(badge).toHaveCSS("border-color", "rgb(127, 29, 29)");
        await expect(badge).toHaveCSS("color", "rgb(248, 113, 113)");

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 932 });
            await removeButton.scrollIntoViewIfNeeded();
            const bounds = await removeButton.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
            await expectNoHorizontalOverflow(page, `Canvas 删除角标 ${width}px`);
        }

        await removeButton.click();
        await expect(removeButton).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

async function readCanvasNodeCount(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { nodes: unknown[] } } }).data.project.nodes.length;
}

async function readCanvasViewport(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { viewport: { x: number; y: number; k: number } } } }).data.project.viewport;
}

async function readCanvasChatState(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    const sessions = ((await response.json()) as { data: { project: { chatSessions: { messages: unknown[] }[] } } }).data.project.chatSessions;
    return { sessions: sessions.length, messages: sessions.reduce((count, session) => count + session.messages.length, 0) };
}

async function dragConnection(page: Page, sourceNode: Locator, targetNode: Locator) {
    const targetBounds = await targetNode.boundingBox();
    expect(targetBounds).not.toBeNull();
    await dragConnectionToPoint(page, sourceNode, targetBounds!.x + targetBounds!.width / 2, targetBounds!.y + targetBounds!.height / 2);
}

async function dragConnectionToPoint(page: Page, sourceNode: Locator, targetX: number, targetY: number) {
    await sourceNode.hover();
    const handle = sourceNode.locator('[data-canvas-handle="source"]');
    const bounds = await handle.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
}

async function dragSelectionBox(page: Page, nodes: Locator) {
    const boxes = await nodes.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map(({ left, top, right, bottom }) => ({ left, top, right, bottom })));
    expect(boxes.length).toBeGreaterThan(0);
    const bounds = boxes.reduce((current, box) => ({ left: Math.min(current.left, box.left), top: Math.min(current.top, box.top), right: Math.max(current.right, box.right), bottom: Math.max(current.bottom, box.bottom) }), {
        left: Infinity,
        top: Infinity,
        right: -Infinity,
        bottom: -Infinity,
    });
    await page.mouse.move(bounds.left - 16, bounds.top - 16);
    await page.mouse.down();
    await page.mouse.move(bounds.right + 16, bounds.bottom + 16, { steps: 10 });
    await page.mouse.up();
}

async function expectSelectedNodeCount(page: Page, count: number) {
    await expect.poll(() => page.locator("[data-node-id] > div").evaluateAll((elements) => elements.filter((element) => getComputedStyle(element).borderColor === "rgb(47, 128, 255)").length)).toBe(count);
}
