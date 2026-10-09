import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { billingProductsFixture, expectDialogWithinViewport, expectNoHorizontalOverflow, masonryGalleryFixture, masonryLayoutIsReady, mockCreativeImageUploads, openCreativeHistory, readMasonryLayout } from "./responsive-helpers";

async function waitForCreativeComposerReady(page: Page) {
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByRole("button", { name: /当前创作类型：/ })).toBeVisible({ timeout: 45_000 });
}

async function mockExistingCreativeConversation(page: Page) {
    const id = `e2e-conversation-${randomUUID()}`;
    const timestamp = Date.now();
    const conversation = {
        id,
        userId: "e2e-user",
        surface: "chat",
        source: "agent",
        title: "已有对话",
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: timestamp,
    };
    await page.route(new RegExp(`/api/creative/conversations/${id}$`), (route) => route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/messages(?:\\?.*)?$`), (route) =>
        route.fulfill({
            json: {
                code: 0,
                data: {
                    messages: [{ id: `message-${randomUUID()}`, conversationId: id, sequence: 1, role: "user", status: "completed", content: "继续完善这张图片", metadata: {}, createdAt: timestamp, updatedAt: timestamp }],
                },
                msg: "OK",
            },
        }),
    );
    await page.route(new RegExp(`/api/creative/conversations/${id}/assets$`), (route) => route.fulfill({ json: { code: 0, data: { assets: [] }, msg: "OK" } }));
    return id;
}

async function mockAgentConversationSwitchRace(page: Page) {
    const timestamp = Date.now();
    const conversationA = {
        id: `e2e-running-a-${randomUUID()}`,
        userId: "e2e-user",
        surface: "chat",
        source: "agent",
        title: "运行中的对话 A",
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp + 1,
        lastMessageAt: timestamp + 1,
    };
    const conversationB = {
        ...conversationA,
        id: `e2e-idle-b-${randomUUID()}`,
        title: "空闲对话 B",
        createdAt: timestamp - 1,
        updatedAt: timestamp,
        lastMessageAt: timestamp,
    };
    const run = {
        id: `e2e-running-run-${randomUUID()}`,
        conversationId: conversationA.id,
        inputMessageId: "e2e-running-user",
        assistantMessageId: "e2e-running-assistant",
        status: "running",
        requestedModelIds: ["e2e-image-model", "e2e-video-model"],
        generationPreferences: { mode: "image", image: { size: "1:1", quality: "high", count: 2 }, video: { size: "16:9", quality: "720P", seconds: 10, count: 2 } },
        assetIds: [],
        tasks: [
            { id: "e2e-running-image", title: "生成图片", type: "image", model: "e2e-image-model", ratio: "1:1", quality: "high", count: 2, status: "running" },
            { id: "e2e-running-video", title: "生成视频", type: "video", model: "e2e-video-model", ratio: "16:9", quality: "720P", seconds: 10, count: 2, status: "running" },
        ],
        createdAt: timestamp,
        updatedAt: timestamp + 1,
    };
    const messages = new Map([
        [
            conversationA.id,
            [
                { id: run.inputMessageId, conversationId: conversationA.id, runId: run.id, sequence: 1, role: "user", status: "completed", content: "A 对话正在生成海报", metadata: {}, createdAt: timestamp, updatedAt: timestamp },
                { id: run.assistantMessageId, conversationId: conversationA.id, runId: run.id, sequence: 2, role: "assistant", status: "running", content: "正在生成 A 对话结果", metadata: {}, createdAt: timestamp + 1, updatedAt: timestamp + 1 },
            ],
        ],
        [
            conversationB.id,
            [
                { id: "e2e-idle-user", conversationId: conversationB.id, sequence: 1, role: "user", status: "completed", content: "B 对话自己的消息", metadata: {}, createdAt: timestamp, updatedAt: timestamp },
                { id: "e2e-idle-assistant", conversationId: conversationB.id, sequence: 2, role: "assistant", status: "completed", content: "B 对话已经完成", metadata: {}, createdAt: timestamp, updatedAt: timestamp },
            ],
        ],
    ]);
    const conversations = new Map([
        [conversationA.id, conversationA],
        [conversationB.id, conversationB],
    ]);
    let runReads = 0;
    let eventRequests = 0;
    let controlRequests = 0;
    let createRequests = 0;
    let releaseDelayedRun = () => undefined;
    let resolveDelayedRunRequested = () => undefined;
    let resolveDelayedRunReturned = () => undefined;
    const delayedRunRelease = new Promise<void>((resolve) => {
        releaseDelayedRun = resolve;
    });
    const delayedRunRequested = new Promise<void>((resolve) => {
        resolveDelayedRunRequested = resolve;
    });
    const delayedRunReturned = new Promise<void>((resolve) => {
        resolveDelayedRunReturned = resolve;
    });

    await page.route(/\/api\/creative\/conversations(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({ json: { code: 0, data: { conversations: [conversationA, conversationB], hasMore: false }, msg: "OK" } });
    });
    await page.route(/\/api\/creative\/conversations\/([^/?]+)$/, async (route) => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1) || "";
        const conversation = conversations.get(id);
        return conversation ? route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } }) : route.fallback();
    });
    await page.route(/\/api\/creative\/conversations\/([^/?]+)\/messages(?:\?.*)?$/, async (route) => {
        const id = new URL(route.request().url()).pathname.split("/").at(-2) || "";
        return route.fulfill({ json: { code: 0, data: { messages: messages.get(id) || [] }, msg: "OK" } });
    });
    await page.route(/\/api\/creative\/conversations\/([^/?]+)\/assets$/, (route) => route.fulfill({ json: { code: 0, data: { assets: [] }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${run.id}$`), async (route) => {
        runReads += 1;
        if (runReads === 2) {
            resolveDelayedRunRequested();
            await delayedRunRelease;
        }
        await route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
        if (runReads === 2) resolveDelayedRunReturned();
    });
    await page.route(new RegExp(`/api/agent/runs/${run.id}/events$`), async (route) => {
        eventRequests += 1;
        await route.abort("connectionrefused");
    });
    await page.route(new RegExp(`/api/agent/runs/${run.id}/(?:cancel|pause|resume|retry)$`), async (route) => {
        controlRequests += 1;
        await route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
    });
    await page.route(/\/api\/agent\/runs$/, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        createRequests += 1;
        await route.fulfill({ json: { code: 0, data: { run, created: false }, msg: "OK" } });
    });

    return {
        conversationA,
        conversationB,
        run,
        delayedRunRequested,
        delayedRunReturned,
        releaseDelayedRun,
        runReads: () => runReads,
        eventRequests: () => eventRequests,
        controlRequests: () => controlRequests,
        createRequests: () => createRequests,
    };
}

async function mockCreativeMediaRound(page: Page, imageBuffer: Buffer, options: { imageDataUrl?: string; outputCount?: number; outputDimensions?: { width: number; height: number } } = {}) {
    const id = `e2e-media-round-${randomUUID()}`;
    const runId = `e2e-run-${randomUUID()}`;
    const timestamp = Date.now();
    const imageDataUrl = options.imageDataUrl || `data:image/webp;base64,${imageBuffer.toString("base64")}`;
    const outputCount = options.outputCount || 1;
    let repeatedRequest: Record<string, unknown> | undefined;
    const userMessage = {
        id: `user-${randomUUID()}`,
        conversationId: id,
        runId,
        sequence: 7,
        role: "user",
        status: "completed",
        content: "让参考图变成清透自然的电影感画面",
        metadata: { assetIds: ["reference-one"] },
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const assistantMessage = {
        id: `assistant-${randomUUID()}`,
        conversationId: id,
        runId,
        sequence: 8,
        role: "assistant",
        status: "completed",
        content: "图片已生成。",
        metadata: {
            generation: {
                highlights: [
                    { title: "主体清晰", description: "人物轮廓与服饰细节完整，适合作为商品主视觉。" },
                    { title: "质感细腻", description: "光影层次自然，材质与色彩表现稳定。" },
                    { title: "构图完整", description: "画面信息层级清楚，核心内容易于浏览。" },
                    { title: "便于延展", description: "可继续用于详情页、海报与社媒物料。" },
                ],
            },
        },
        createdAt: timestamp + 1,
        updatedAt: timestamp + 1,
    };
    const historyMessages = Array.from({ length: 6 }, (_, index) => ({
        id: `history-${index}-${randomUUID()}`,
        conversationId: id,
        sequence: index + 1,
        role: index % 2 ? "assistant" : "user",
        status: "completed",
        content: index % 2 ? `前面的创作记录 ${index + 1} 已完成。` : `前面的创作需求 ${index + 1}，用于验证长对话滚动。`,
        metadata: {},
        createdAt: timestamp - (7 - index),
        updatedAt: timestamp - (7 - index),
    }));
    const conversation = {
        id,
        userId: "e2e-user",
        surface: "chat",
        source: "agent",
        title: userMessage.content,
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: timestamp,
    };
    const reference = {
        id: "reference-one",
        userId: "e2e-user",
        conversationId: id,
        sourceRunId: "upload",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: "人物参考图",
        serverUrl: imageDataUrl,
        remoteUrl: imageDataUrl,
        mimeType: "image/webp",
        width: 512,
        height: 512,
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    const outputs = Array.from({ length: outputCount }, (_, index) => ({
        ...reference,
        ...options.outputDimensions,
        id: `output-${index + 1}`,
        sourceRunId: runId,
        messageId: assistantMessage.id,
        ordinal: index + 1,
        title: outputCount > 1 ? `生成结果 ${index + 1}` : "生成结果",
        createdAt: timestamp + index + 1,
        updatedAt: timestamp + index + 1,
    }));
    const run = {
        id: runId,
        conversationId: id,
        inputMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        status: "completed",
        prompt: userMessage.content,
        referencedAssetIds: [reference.id],
        requestedModelIds: ["e2e-image-model"],
        generationPreferences: { mode: "image", image: { size: "1:1", quality: "high" } },
        assetIds: outputs.map((output) => output.id),
        tasks: [{ id: "image-task", title: "生成图片", type: "image", model: "e2e-image-model", ratio: "1:1", quality: "high", count: outputCount, status: "completed" }],
        createdAt: timestamp,
        updatedAt: timestamp,
    };

    await page.route(new RegExp(`/api/creative/conversations/${id}$`), (route) => route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/messages(?:\\?.*)?$`), (route) => route.fulfill({ json: { code: 0, data: { messages: [...historyMessages, userMessage, assistantMessage] }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/assets$`), (route) => route.fulfill({ json: { code: 0, data: { assets: [reference, ...outputs] }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${runId}$`), (route) => route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } }));
    await page.route(/\/api\/agent\/runs$/, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        repeatedRequest = (await route.request().postDataJSON()) as Record<string, unknown>;
        const repeatedRun = { ...run, id: `repeat-${runId}`, inputMessageId: `repeat-user-${randomUUID()}`, assistantMessageId: `repeat-assistant-${randomUUID()}`, status: "running", assetIds: [], tasks: [] };
        return route.fulfill({ json: { code: 0, data: { run: repeatedRun, created: true }, msg: "OK" } });
    });
    return { id, repeatedRequest: () => repeatedRequest };
}

async function openComposerPopover(trigger: Locator, popover: Locator) {
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await expect(popover).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function selectComposerPopoverOption(trigger: Locator, popover: Locator, option: Locator, verify: () => Promise<void>) {
    await openComposerPopover(trigger, popover);
    await option.scrollIntoViewIfNeeded();
    await expect(option).toBeVisible();
    await option.click();
    await verify();
}

test("creative composer controls return to a neutral palette after selection", async ({ page }) => {
    const readPalette = (selector: Locator) =>
        selector.evaluate((element) => {
            const style = getComputedStyle(element);
            return { backgroundColor: style.backgroundColor, borderColor: style.borderColor, color: style.color };
        });

    const verifyNeutralControls = async (label: string) => {
        await waitForCreativeComposerReady(page);
        const modeTrigger = page.getByRole("button", { name: "当前创作类型：Agent 模式" });
        await expect(modeTrigger).toBeVisible();
        const neutralPalette = await readPalette(page.getByRole("button", { name: "生成模型：智能模型" }));
        await expect.poll(() => readPalette(modeTrigger)).toEqual(neutralPalette);
        await expect.poll(() => readPalette(page.getByRole("button", { name: "生成参数：生成参数" }))).toEqual(neutralPalette);
        await expect.poll(() => readPalette(page.getByRole("button", { name: "选择创作 Skill" }))).toEqual(neutralPalette);

        const modePopover = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
        await openComposerPopover(modeTrigger, modePopover);
        const [modeTriggerRect, modePopoverRect] = await Promise.all([modeTrigger.evaluate((element) => element.getBoundingClientRect().toJSON()), modePopover.evaluate((element) => element.getBoundingClientRect().toJSON())]);
        expect(modePopoverRect.top, `${label} mode popover should open below its trigger`).toBeGreaterThanOrEqual(modeTriggerRect.bottom - 1);
        await expect.poll(() => readPalette(modeTrigger)).not.toEqual(neutralPalette);
        const selectedModeTrigger = page.getByRole("button", { name: "当前创作类型：视频生成" });
        await selectComposerPopoverOption(modeTrigger, modePopover, modePopover.getByRole("button", { name: /视频生成/ }), () => expect(selectedModeTrigger).toBeVisible());
        await expect(modePopover).toBeHidden();

        await expect.poll(() => readPalette(selectedModeTrigger)).toEqual(neutralPalette);

        const preferenceTrigger = page.getByRole("button", { name: "生成参数：智能参数 · 5秒" });
        const preferencePopover = page.locator(".ant-popover").last();
        await openComposerPopover(preferenceTrigger, preferencePopover);
        await expect.poll(() => readPalette(preferenceTrigger)).not.toEqual(neutralPalette);
        await preferencePopover.getByRole("tab", { name: "输出" }).click();
        const configuredPreferenceTrigger = page.getByRole("button", { name: "生成参数：智能参数 · 10秒" });
        await selectComposerPopoverOption(preferenceTrigger, preferencePopover, preferencePopover.getByRole("button", { name: "输入视频时长 10 秒" }), () => expect(configuredPreferenceTrigger).toBeVisible());
        await page.keyboard.press("Escape");
        await expect(preferencePopover).toBeHidden();

        await expect.poll(() => readPalette(configuredPreferenceTrigger)).toEqual(neutralPalette);
        await expectNoHorizontalOverflow(page, label);
    };

    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await verifyNeutralControls("creative composer neutral controls light");

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await verifyNeutralControls("creative composer neutral controls dark");
});

test("creative composer optimizes the current prompt without sending it", async ({ page }) => {
    let optimizationRequests = 0;
    let runCreates = 0;
    await page.route(/\/api\/agent\/prompt-optimization$/, async (route) => {
        optimizationRequests += 1;
        const body = (await route.request().postDataJSON()) as Record<string, unknown>;
        expect(body).toMatchObject({ prompt: "做个国风人物海报", mode: "agent" });
        await route.fulfill({ json: { code: 0, data: { prompt: "生成一张国风人物海报，突出人物主体与传统服饰细节。" }, msg: "OK" } });
    });
    await page.route(/\/api\/agent\/runs$/, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        runCreates += 1;
        return route.abort();
    });
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await waitForCreativeComposerReady(page);

    const input = page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" });
    const optimize = page.getByRole("button", { name: "优化提示词" });
    await expect(optimize).toBeDisabled();
    await input.fill("做个国风人物海报");
    await expect(optimize).toBeEnabled();
    await optimize.click();

    await expect(input).toHaveValue("生成一张国风人物海报，突出人物主体与传统服饰细节。");
    expect(optimizationRequests).toBe(1);
    expect(runCreates).toBe(0);
    await expectNoHorizontalOverflow(page, "creative prompt optimizer");
});

test("creative composer ignores an optimization response after the user sends", async ({ page }) => {
    let releaseOptimization = () => undefined;
    const optimizationRelease = new Promise<void>((resolve) => {
        releaseOptimization = resolve;
    });
    let runCreates = 0;
    await page.route(/\/api\/agent\/prompt-optimization$/, async (route) => {
        await optimizationRelease;
        await route.fulfill({ json: { code: 0, data: { prompt: "这条迟到的优化结果不能覆盖输入框" }, msg: "OK" } });
    });
    await page.route(/\/api\/agent\/runs$/, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        runCreates += 1;
        await route.abort("connectionrefused");
    });
    try {
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await waitForCreativeComposerReady(page);

        const input = page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" });
        await input.fill("直接发送当前提示词");
        await page.getByRole("button", { name: "优化提示词" }).click();
        const send = page.getByRole("button", { name: "发送" });
        await expect(send).toBeEnabled();
        await send.click();
        await expect.poll(() => runCreates).toBe(1);

        releaseOptimization();
        await expect(input).toHaveValue("直接发送当前提示词");
        expect(runCreates).toBe(1);
    } finally {
        releaseOptimization();
    }
});

test("Agent generation inputs apply immediately and reveal video frame slots", async ({ page }, testInfo) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await waitForCreativeComposerReady(page);

    const preferenceTrigger = page.getByRole("button", { name: "生成参数：生成参数" });
    const preferencePopover = page.locator(".ant-popover").last();
    await openComposerPopover(preferenceTrigger, preferencePopover);

    await preferencePopover.getByRole("button", { name: "打开图片自定义像素尺寸" }).click();
    await expect(preferencePopover.getByText("修改后立即生效，例如 1024 × 1536")).toHaveCount(0);
    await expect(preferencePopover.getByRole("button", { name: "恢复智能" })).toHaveCount(0);
    await preferencePopover.getByRole("textbox", { name: "自定义图片宽度" }).fill("1024");
    await preferencePopover.getByRole("textbox", { name: "自定义图片高度" }).fill("1536");
    await expect(preferencePopover.getByText("1024×1536", { exact: true })).toBeVisible();
    await expect(preferencePopover.getByRole("button", { name: "应用", exact: true })).toHaveCount(0);

    await preferencePopover.getByRole("tab", { name: "输出" }).click();
    const countInput = preferencePopover.getByRole("textbox", { name: "自定义生成数量" });
    await countInput.fill("6");
    await expect(countInput).toHaveValue("6");
    if (process.env.VOZEB_PRO_VISUAL_CAPTURE === "1") {
        const screenshotPath = testInfo.outputPath(`agent-immediate-parameters-${testInfo.project.name}.png`);
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("Agent 即时尺寸与数量", { path: screenshotPath, contentType: "image/png" });
    }

    await preferencePopover.getByRole("button", { name: "视频", exact: true }).click();
    await preferencePopover.getByRole("tab", { name: "输出" }).click();
    const durationInput = preferencePopover.getByRole("spinbutton", { name: "输入视频时长" });
    await expect(durationInput).not.toHaveAttribute("max");
    await durationInput.fill("60");
    await durationInput.press("Tab");
    await expect(durationInput).toHaveValue("60");
    await preferencePopover.getByRole("tab", { name: "画面" }).click();
    const firstLastOption = preferencePopover.getByRole("button", { name: "选择视频参考方式 首尾帧" });
    await expect(firstLastOption).toBeVisible();
    await firstLastOption.click();
    await expect(page.getByRole("button", { name: "当前创作类型：Agent 模式" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preferencePopover).toBeHidden();

    const frames = page.locator('[aria-label="视频首尾帧"]');
    const firstFrame = page.getByRole("button", { name: "添加视频首帧" });
    await expect(frames).toBeVisible();
    await expect(firstFrame).toBeVisible();
    await expect(page.getByRole("button", { name: "添加视频尾帧" })).toBeVisible();

    await firstFrame.click();
    const framePopover = page.locator(".ant-popover").filter({ hasText: "选择首帧图片" }).last();
    await expect(framePopover).toBeVisible();
    const [frameRect, framePopoverRect] = await Promise.all([firstFrame.evaluate((element) => element.getBoundingClientRect().toJSON()), framePopover.evaluate((element) => element.getBoundingClientRect().toJSON())]);
    expect(framePopoverRect.top, "new Agent frame picker should open below its slot").toBeGreaterThanOrEqual(frameRect.bottom - 1);
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} Agent immediate inputs and video frames`);
    if (process.env.VOZEB_PRO_VISUAL_CAPTURE === "1") {
        const screenshotPath = testInfo.outputPath(`agent-immediate-inputs-${testInfo.project.name}.png`);
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("Agent 即时参数与首尾帧", { path: screenshotPath, contentType: "image/png" });
    }
});

test("creative composer renders uploaded images as thumbnails instead of filename chips", async ({ page }, testInfo) => {
    const imageBuffer = readFileSync("public/generation-smoke.webp");
    const projectName = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-");
    const fileName = `${projectName}-reference.webp`;
    const requests = await mockCreativeImageUploads(page, [fileName], imageBuffer);

    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await waitForCreativeComposerReady(page);

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "添加素材" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: fileName, mimeType: "image/webp", buffer: imageBuffer });

    const preview = page.getByRole("img", { name: fileName });
    await expect(preview).toBeVisible({ timeout: 45_000 });
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);
    await expect(page.getByText("上传中", { exact: true })).toHaveCount(0);
    expect(requests.conversationCreates()).toBe(0);
    expect(requests.assetUploads()).toBe(0);
    await expect(page).toHaveURL(/\/create$/);
    const inputRow = page.getByTestId("creative-composer-input-row");
    const previewSlot = page.getByLabel(`已上传图片 ${fileName}`);
    const textarea = page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" });
    await expect
        .poll(async () => {
            const [previewRect, textareaRect, rowRect] = await Promise.all([
                previewSlot.evaluate((element) => element.getBoundingClientRect().toJSON()),
                textarea.evaluate((element) => element.getBoundingClientRect().toJSON()),
                inputRow.evaluate((element) => element.getBoundingClientRect().toJSON()),
            ]);
            return previewRect.top >= rowRect.top && previewRect.bottom <= rowRect.bottom && previewRect.left < textareaRect.left && previewRect.width >= 48 && previewRect.height >= 48;
        })
        .toBe(true);
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} creative image attachment preview`);

    const removeButton = page.getByRole("button", { name: `移除${fileName}` });
    const addButton = page.getByRole("button", { name: "继续添加参考素材" });
    await expect
        .poll(() =>
            removeButton.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const indicator = element.querySelector<HTMLElement>("[data-delete-indicator]");
                if (!indicator) return false;
                const indicatorRect = indicator.getBoundingClientRect();
                const style = getComputedStyle(indicator);
                return (
                    rect.width >= 28 &&
                    rect.height >= 28 &&
                    indicatorRect.width >= 22 &&
                    indicatorRect.width <= 24 &&
                    indicatorRect.height >= 22 &&
                    indicatorRect.height <= 24 &&
                    style.backgroundColor !== "transparent" &&
                    style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
                    style.color === "rgb(255, 255, 255)"
                );
            }),
        )
        .toBe(true);
    await expect
        .poll(async () => {
            const [previewRect, removeRect, addRect] = await Promise.all([
                preview.evaluate((element) => element.getBoundingClientRect().toJSON()),
                removeButton.evaluate((element) => element.getBoundingClientRect().toJSON()),
                addButton.evaluate((element) => element.getBoundingClientRect().toJSON()),
            ]);
            return removeRect.top < previewRect.top && removeRect.right <= addRect.left;
        })
        .toBe(true);
    await removeButton.click();
    await expect(preview).toBeHidden();
});

test("creative conversation keeps successful media rounds copy-only", async ({ page }, testInfo) => {
    if (testInfo.project.name === "chromium") await page.setViewportSize({ width: 1672, height: 941 });
    const imageBuffer = readFileSync("public/generation-smoke.webp");
    const portraitDataUrl = `data:image/svg+xml;base64,${Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#111820"/><rect x="52" y="52" width="616" height="760" rx="12" fill="#243846"/><circle cx="360" cy="350" r="168" fill="#8fb5c3"/><rect x="108" y="870" width="504" height="24" rx="12" fill="#e8eef1"/><rect x="168" y="926" width="384" height="16" rx="8" fill="#82939c"/><rect x="96" y="1030" width="148" height="148" rx="8" fill="#304c5c"/><rect x="286" y="1030" width="148" height="148" rx="8" fill="#456778"/><rect x="476" y="1030" width="148" height="148" rx="8" fill="#6b8793"/></svg>',
    ).toString("base64")}`;
    const fixture = await mockCreativeMediaRound(page, imageBuffer, { imageDataUrl: portraitDataUrl, outputDimensions: { width: 720, height: 1280 } });
    await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

    const round = page.getByTestId("creative-media-round");
    await expect(round).toBeVisible({ timeout: 45_000 });
    await expect(round.getByText("让参考图变成清透自然的电影感画面", { exact: true })).toBeVisible();
    await expect(round.getByRole("img", { name: "人物参考图" })).toBeVisible();
    await expect(round.getByTestId("creative-user-avatar")).toBeVisible();
    await expect(round.getByLabel("本轮创作参数")).toContainText("e2e-image-model");
    await expect(round.getByLabel("本轮创作参数")).toContainText("1:1");
    await expect(round.getByLabel("本轮创作参数")).toContainText("高画质");

    const result = round.getByTestId("creative-media-result");
    const primaryResult = result.getByTestId("creative-primary-result");
    const media = primaryResult.getByRole("img", { name: "生成结果" });
    await expect(media).toBeVisible();
    await expect(primaryResult).toHaveAttribute("data-rendered-width", "300");
    await expect(primaryResult).toHaveAttribute("data-rendered-height", "533");
    await expect(result.getByText("更多生成结果", { exact: true })).toHaveCount(0);
    await expect(result.getByTestId("creative-result-switcher")).toHaveCount(0);
    const [primaryRect, mediaRect] = await Promise.all([primaryResult.evaluate((element) => element.getBoundingClientRect().toJSON()), media.evaluate((element) => element.getBoundingClientRect().toJSON())]);
    const portraitScale = Math.min(1, page.viewportSize()!.height / 3 / 533);
    expect(Math.abs(primaryRect.width - 300 * portraitScale)).toBeLessThanOrEqual(2);
    expect(Math.abs(primaryRect.height - 533 * portraitScale)).toBeLessThanOrEqual(2);
    expect(primaryRect.width - mediaRect.width).toBeLessThanOrEqual(3);
    expect(primaryRect.height - mediaRect.height).toBeLessThanOrEqual(3);

    const resultGroup = round.getByTestId("creative-result-group");
    const request = round.getByTestId("creative-round-request");
    await expect(resultGroup).toBeVisible();
    await expect(round.getByLabel("创作助手")).toBeVisible();
    await expect
        .poll(() =>
            resultGroup.evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                    backgroundColor: style.backgroundColor,
                    borderWidth: `${style.borderTopWidth} ${style.borderRightWidth} ${style.borderBottomWidth} ${style.borderLeftWidth}`,
                    boxShadow: style.boxShadow,
                };
            }),
        )
        .toEqual({ backgroundColor: "rgba(0, 0, 0, 0)", borderWidth: "0px 0px 0px 0px", boxShadow: "none" });
    const actions = result.getByLabel("本轮创作操作", { exact: true });
    const [groupRect, resultRect, actionsRect, requestRect] = await Promise.all([
        resultGroup.evaluate((element) => element.getBoundingClientRect().toJSON()),
        result.evaluate((element) => element.getBoundingClientRect().toJSON()),
        actions.evaluate((element) => element.getBoundingClientRect().toJSON()),
        request.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(Math.abs(groupRect.width - resultRect.width)).toBeLessThanOrEqual(2);
    expect(actionsRect.width).toBeLessThanOrEqual(primaryRect.width + 2);
    expect(groupRect.width).toBeGreaterThanOrEqual(primaryRect.width - 2);
    expect(groupRect.width).toBeLessThanOrEqual(352);
    expect(requestRect.bottom, JSON.stringify({ requestBottom: requestRect.bottom, groupTop: groupRect.top })).toBeLessThanOrEqual(groupRect.top + 1);
    if (process.env.VOZEB_PRO_VISUAL_CAPTURE === "1") {
        await page.getByTestId("creative-conversation-scroll").evaluate((element) => element.scrollTo({ top: Math.max(0, element.scrollHeight - element.clientHeight - 230) }));
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-compact", "true");
        const screenshotPath = testInfo.outputPath(`creative-media-single-${testInfo.project.name}.png`);
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("单结果创作记录", { path: screenshotPath, contentType: "image/png" });
    }

    const scrollArea = page.getByTestId("creative-conversation-scroll");
    const composer = page.locator(".creative-composer");
    await scrollArea.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(composer).toHaveAttribute("data-compact", "false");
    const expandedComposerHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
    await expect.poll(() => scrollArea.evaluate((element) => element.scrollHeight - element.clientHeight > 200)).toBe(true);
    const composerDock = page.getByTestId("creative-composer-dock");
    await composerDock.evaluate((element) => {
        element.dataset.compactTransitions = "";
        new MutationObserver(() => {
            const state = element.dataset.compact || "";
            const composer = element.querySelector<HTMLElement>(".creative-composer");
            const height = composer?.getBoundingClientRect().height || 0;
            element.dataset.compactTransitions = [element.dataset.compactTransitions, `${state}:${height}`].filter(Boolean).join(",");
        }).observe(element, { attributes: true, attributeFilter: ["data-compact"] });
    });
    await scrollArea.hover();
    await page.mouse.wheel(0, -10_000);
    await expect(composer).toHaveAttribute("data-compact", "true");
    await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();
    await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(64);
    const compactAppearance = await composer.evaluate((element) => {
        const style = getComputedStyle(element);
        const shell = element.parentElement;
        const dock = shell?.parentElement;
        const inputRow = element.querySelector<HTMLElement>("[data-testid='creative-composer-input-row']");
        const actionButtons = Array.from(element.querySelectorAll<HTMLElement>("button[aria-label='引用当前对话资产'], button[aria-label='优化提示词'], button[aria-label='发送']"));
        return {
            backgroundColor: style.backgroundColor,
            borderWidth: `${style.borderTopWidth} ${style.borderRightWidth} ${style.borderBottomWidth} ${style.borderLeftWidth}`,
            boxShadow: style.boxShadow,
            composerHeight: element.getBoundingClientRect().height,
            composerWidth: element.getBoundingClientRect().width,
            inputRowHeight: inputRow?.getBoundingClientRect().height || 0,
            actionButtonSizes: actionButtons
                .map((button) => {
                    const bounds = button.getBoundingClientRect();
                    return { width: bounds.width, height: bounds.height };
                })
                .filter((bounds) => bounds.width > 0 && bounds.height > 0),
            shellHeight: shell?.getBoundingClientRect().height || 0,
            shellWidth: shell?.getBoundingClientRect().width || 0,
            shellBackgroundColor: shell ? getComputedStyle(shell).backgroundColor : null,
            dockBackgroundColor: dock ? getComputedStyle(dock).backgroundColor : null,
            dockPosition: dock ? getComputedStyle(dock).position : null,
            dockPointerEvents: dock ? getComputedStyle(dock).pointerEvents : null,
        };
    });
    expect(compactAppearance.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(compactAppearance.borderWidth).not.toBe("0px 0px 0px 0px");
    expect(compactAppearance.boxShadow).not.toBe("none");
    expect(compactAppearance).toMatchObject({ shellBackgroundColor: "rgba(0, 0, 0, 0)", dockBackgroundColor: "rgba(0, 0, 0, 0)", dockPosition: "absolute", dockPointerEvents: "none" });
    expect(compactAppearance.composerHeight).toBeGreaterThanOrEqual(60);
    expect(compactAppearance.composerHeight).toBeLessThanOrEqual(64);
    expect(compactAppearance.inputRowHeight).toBeLessThanOrEqual(46);
    expect(compactAppearance.shellHeight - compactAppearance.composerHeight).toBeGreaterThanOrEqual(12);
    expect(compactAppearance.shellHeight - compactAppearance.composerHeight).toBeLessThanOrEqual(18);
    expect(compactAppearance.composerWidth).toBeGreaterThanOrEqual(compactAppearance.shellWidth - 50);
    expect(compactAppearance.actionButtonSizes).toEqual([
        { width: 44, height: 44 },
        { width: 44, height: 44 },
        { width: 44, height: 44 },
    ]);
    await expect(composerDock).toHaveAttribute("data-compact-transitions", /^true:(?:6[0-4](?:\.\d+)?)$/);
    const disabledSendAppearance = await composer.getByRole("button", { name: "发送" }).evaluate((element) => {
        const style = getComputedStyle(element);
        return { disabled: (element as HTMLButtonElement).disabled, backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor };
    });
    expect(disabledSendAppearance).toEqual({ disabled: true, backgroundImage: "none", backgroundColor: "rgb(226, 229, 232)" });
    expect(compactAppearance.composerHeight).toBeLessThan(expandedComposerHeight);
    expect(compactAppearance.shellHeight).toBeLessThan(expandedComposerHeight);
    await page.getByRole("button", { name: "回到底部" }).click();
    await expect(composer).toHaveAttribute("data-compact", "false");
    await expect.poll(() => scrollArea.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(4);

    await round.getByRole("button", { name: "查看本轮创作详细信息" }).click();
    const details = page.getByText("本轮创作详情", { exact: true }).locator("..", { hasText: "e2e-image-model" });
    await expect(details).toContainText("高画质");
    await page.keyboard.press("Escape");

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(round).toBeVisible();
    await expect(round.getByLabel("本轮创作参数")).toContainText("e2e-image-model");
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} creative media round dark`);
    if (process.env.VOZEB_PRO_VISUAL_CAPTURE === "1") {
        const screenshotPath = testInfo.outputPath(`creative-media-single-dark-${testInfo.project.name}.png`);
        await round.screenshot({ path: screenshotPath });
        await testInfo.attach("深色单结果创作记录", { path: screenshotPath, contentType: "image/png" });
    }

    await expect(round.getByRole("button", { name: "更多本轮创作操作" })).toBeVisible();
    await expect(round.getByRole("button", { name: "重新编辑" })).toHaveCount(0);
    await expect(round.getByRole("button", { name: "再次生成" })).toHaveCount(0);
    expect(fixture.repeatedRequest()).toBeUndefined();
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} creative media round`);
});

test("creative conversation uses the shared switcher only for multiple media results", async ({ page }, testInfo) => {
    if (testInfo.project.name === "chromium") await page.setViewportSize({ width: 1672, height: 941 });
    const imageBuffer = readFileSync("public/generation-smoke.webp");
    const fixture = await mockCreativeMediaRound(page, imageBuffer, { outputCount: 4 });
    await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

    const round = page.getByTestId("creative-media-round");
    const result = round.getByTestId("creative-media-result");
    const primaryResult = result.getByTestId("creative-primary-result");
    const switcher = result.getByTestId("creative-result-switcher");
    await expect(primaryResult.getByRole("img", { name: "生成结果 1" })).toBeVisible({ timeout: 45_000 });
    await expect(result).toHaveAttribute("data-results-count", "4");
    await expect(switcher).toHaveAttribute("data-results-count", "4");
    await expect(result.getByText("更多", { exact: true })).toBeVisible();
    await expect(switcher.getByRole("button", { name: /查看生成结果/ })).toHaveCount(4);
    const bounds = await switcher.getByRole("button", { name: /查看生成结果/ }).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
    expect(bounds.every((rect) => rect.width <= 79 && rect.height <= 65)).toBe(true);
    if (page.viewportSize()!.width >= 640) {
        expect(Math.max(...bounds.map((rect) => rect.left)) - Math.min(...bounds.map((rect) => rect.left))).toBeLessThanOrEqual(1);
        expect(bounds.every((rect, index) => index === 0 || rect.top > bounds[index - 1].top)).toBe(true);
    } else {
        expect(Math.max(...bounds.map((rect) => rect.top)) - Math.min(...bounds.map((rect) => rect.top))).toBeLessThanOrEqual(1);
        expect(bounds.every((rect, index) => index === 0 || rect.left > bounds[index - 1].left)).toBe(true);
    }
    await switcher.getByRole("button", { name: "查看生成结果 2" }).click();
    await expect(switcher.getByRole("button", { name: "查看生成结果 2" })).toHaveAttribute("aria-pressed", "true");
    const [groupWidth, primaryWidth, actionsWidth, switcherWidth] = await Promise.all([
        round.getByTestId("creative-result-group").evaluate((element) => element.getBoundingClientRect().width),
        primaryResult.evaluate((element) => element.getBoundingClientRect().width),
        result.getByLabel("本轮创作操作", { exact: true }).evaluate((element) => element.getBoundingClientRect().width),
        switcher.evaluate((element) => element.getBoundingClientRect().width),
    ]);
    expect(primaryWidth).toBeLessThanOrEqual(420);
    expect(groupWidth).toBeGreaterThanOrEqual(primaryWidth);
    expect(actionsWidth).toBeLessThanOrEqual(primaryWidth + 2);
    if (page.viewportSize()!.width >= 640) expect(switcherWidth).toBeLessThan(primaryWidth);
    else expect(Math.abs(switcherWidth - primaryWidth)).toBeLessThanOrEqual(2);
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} four media results`);

    if (process.env.VOZEB_PRO_VISUAL_CAPTURE === "1") {
        await page.getByTestId("creative-conversation-scroll").evaluate((element) => element.scrollTo({ top: Math.max(0, element.scrollHeight - element.clientHeight - 230) }));
        const screenshotPath = testInfo.outputPath(`creative-media-four-${testInfo.project.name}.png`);
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("四结果创作记录", { path: screenshotPath, contentType: "image/png" });
    }
});

test("creative composer opens menus upward after entering a conversation", async ({ page }) => {
    const conversationId = await mockExistingCreativeConversation(page);
    await page.goto(`/create?conversationId=${conversationId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("继续完善这张图片", { exact: true })).toBeVisible();

    const modeTrigger = page.getByRole("button", { name: "当前创作类型：Agent 模式" });
    const modePopover = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
    await openComposerPopover(modeTrigger, modePopover);
    const [triggerRect, popoverRect] = await Promise.all([modeTrigger.evaluate((element) => element.getBoundingClientRect().toJSON()), modePopover.evaluate((element) => element.getBoundingClientRect().toJSON())]);
    expect(popoverRect.bottom, "conversation mode popover should open above its trigger").toBeLessThanOrEqual(triggerRect.top + 1);
});

test("switching conversations keeps the previous Agent run isolated and resumable", async ({ page }) => {
    const fixture = await mockAgentConversationSwitchRace(page);
    await page.goto(`/create?conversationId=${fixture.conversationA.id}`, { waitUntil: "domcontentloaded" });
    await waitForCreativeComposerReady(page);
    await expect(page.getByText("A 对话正在生成海报", { exact: true })).toBeVisible();
    await expect(page.getByTestId("creative-media-loading")).toHaveCount(4);
    await expect(page.locator('[data-testid="creative-media-loading"][data-loading-type="image"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="creative-media-loading"][data-loading-type="video"]')).toHaveCount(2);
    await expect(page.getByLabel("本轮创作参数")).toContainText("e2e-image-model + e2e-video-model");
    await expect(page.getByLabel("本轮创作参数")).toContainText("4个结果");
    for (const loader of await page.getByTestId("creative-media-loading").all()) {
        const bounds = await loader.evaluate((element) => element.getBoundingClientRect().toJSON());
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
    }
    await expectNoHorizontalOverflow(page, "concurrent image and video loading");
    await fixture.delayedRunRequested;

    let history = await openCreativeHistory(page);
    await history.getByText("空闲对话 B", { exact: true }).click();
    await expect(page.getByText("B 对话自己的消息", { exact: true })).toBeVisible();
    await expect(page.getByText("A 对话正在生成海报", { exact: true })).toBeHidden();
    if ((page.viewportSize()?.width || 0) >= 1024) await expect(history).toBeVisible();
    else await expect(history).toBeHidden();

    fixture.releaseDelayedRun();
    await fixture.delayedRunReturned;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    expect(fixture.eventRequests(), "the delayed A run must not reconnect inside B").toBe(0);
    expect(fixture.controlRequests(), "switching conversations must not control or cancel A").toBe(0);

    history = await openCreativeHistory(page);
    await history.getByText("运行中的对话 A", { exact: true }).click();
    await expect(page.getByText("A 对话正在生成海报", { exact: true })).toBeVisible();
    await expect(page.getByText("B 对话自己的消息", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
    await expect.poll(fixture.eventRequests).toBeGreaterThan(0);

    expect(fixture.runReads()).toBeGreaterThanOrEqual(4);
    expect(fixture.createRequests(), "returning to A must reuse the persisted run").toBe(0);
    expect(fixture.controlRequests(), "returning to A must not cancel, pause, resume, or retry it").toBe(0);
});

test("creative video first and last frame controls support upload, removal and reselection", async ({ page }, testInfo) => {
    const frameBuffer = readFileSync("public/generation-smoke.webp");
    const projectName = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-");
    const firstFileName = `${projectName}-first-frame.webp`;
    const lastFileName = `${projectName}-last-frame.webp`;
    await mockCreativeImageUploads(page, [firstFileName, lastFileName], frameBuffer);

    const selectFirstLastMode = async () => {
        await waitForCreativeComposerReady(page);
        const modeTrigger = page.getByRole("button", { name: /当前创作类型：/ });
        await expect(modeTrigger).toBeVisible();
        if ((await modeTrigger.getAttribute("aria-label")) !== "当前创作类型：视频生成") {
            const modePopover = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
            await selectComposerPopoverOption(modeTrigger, modePopover, modePopover.getByRole("button", { name: /^视频生成/ }), () => expect(modeTrigger).toHaveAttribute("aria-label", "当前创作类型：视频生成"));
            await expect(modePopover).toBeHidden();
        }

        const preferenceTrigger = page.getByRole("button", { name: /生成参数：/ });
        const preferencePopover = page.locator(".ant-popover").filter({ hasText: "参考方式" }).last();
        const frames = page.locator('[aria-label="视频首尾帧"]');
        await selectComposerPopoverOption(preferenceTrigger, preferencePopover, preferencePopover.getByRole("button", { name: "选择视频参考方式 首尾帧" }), () => expect(frames).toBeVisible());
        await page.keyboard.press("Escape");
        await expect(preferencePopover).toBeHidden();
    };

    const uploadFrame = async (label: "首帧" | "尾帧", fileName: string) => {
        await page.getByRole("button", { name: `添加视频${label}` }).click();
        const popover = page
            .locator(".ant-popover")
            .filter({ hasText: `选择${label}图片` })
            .last();
        await expect(popover).toBeVisible();
        const chooserPromise = page.waitForEvent("filechooser");
        await popover.getByRole("button", { name: "上传新图片" }).click();
        const chooser = await chooserPromise;
        await chooser.setFiles({ name: fileName, mimeType: "image/webp", buffer: frameBuffer });
        await expect(page.getByRole("button", { name: `更换视频${label}` })).toBeVisible({ timeout: 45_000 });
    };

    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await selectFirstLastMode();

    const composer = page.locator(".creative-composer");
    const frames = page.locator('[aria-label="视频首尾帧"]');
    await composer.locator("textarea").fill("让首尾画面自然衔接");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("请先同时选择视频首帧和尾帧图片").last()).toBeVisible();

    await uploadFrame("首帧", firstFileName);
    await uploadFrame("尾帧", lastFileName);
    await expect(frames.getByRole("img", { name: firstFileName })).toBeVisible();
    await expect(frames.getByRole("img", { name: lastFileName })).toBeVisible();
    await expect(composer.getByText(firstFileName, { exact: true })).toHaveCount(0);
    await expect(composer.getByText(lastFileName, { exact: true })).toHaveCount(0);

    await frames.getByRole("button", { name: "移除视频尾帧" }).click();
    await expect(page.getByRole("button", { name: "添加视频尾帧" })).toBeVisible();
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByText("请先同时选择视频首帧和尾帧图片").last()).toBeVisible();

    await page.getByRole("button", { name: "添加视频尾帧" }).click();
    const tailPopover = page.locator(".ant-popover").filter({ hasText: "选择尾帧图片" }).last();
    await expect(tailPopover).toBeVisible();
    await tailPopover.getByRole("button", { name: `设为尾帧：${lastFileName}` }).click();
    await expect(frames.getByRole("img", { name: lastFileName })).toBeVisible();
    await expect(composer.getByText(lastFileName, { exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} creative video frames light`);

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await selectFirstLastMode();
    await expect(page.getByRole("button", { name: "添加视频首帧" })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加视频尾帧" })).toBeVisible();
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} creative video frames dark`);
});

test("Agent text assets with emoji remain visible after hydration and refresh", async ({ page }) => {
    const conversationId = "agent-emoji-conversation";
    const messageId = "agent-emoji-message";
    const conversation = {
        id: conversationId,
        userId: "e2e-user",
        surface: "chat" as const,
        source: "agent" as const,
        title: "Emoji 文章回归",
        status: "active" as const,
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: 1,
        updatedAt: 2,
        lastMessageAt: 2,
    };
    const message = {
        id: messageId,
        conversationId,
        sequence: 2,
        role: "assistant" as const,
        status: "completed" as const,
        content: "已完成 1 个创作任务。",
        metadata: {},
        createdAt: 2,
        updatedAt: 2,
    };
    const asset = {
        id: "agent-emoji-asset",
        userId: "e2e-user",
        conversationId,
        messageId,
        ordinal: 0,
        type: "text" as const,
        status: "ready" as const,
        title: "夏日新品推文",
        textContent: "# 夏日新品\n\n今天也要保持好心情 😊❤️🚀",
        metadata: {},
        createdAt: 2,
        updatedAt: 2,
    };

    await page.route(/\/api\/creative\/conversations(?:\/.*)?(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET") return route.fallback();
        if (url.pathname.endsWith(`/conversations/${conversationId}`)) return route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } });
        if (url.pathname.endsWith(`/conversations/${conversationId}/messages`)) return route.fulfill({ json: { code: 0, data: { messages: [message] }, msg: "OK" } });
        if (url.pathname.endsWith(`/conversations/${conversationId}/assets`)) return route.fulfill({ json: { code: 0, data: { assets: [asset] }, msg: "OK" } });
        if (url.pathname === "/api/creative/conversations") return route.fulfill({ json: { code: 0, data: { conversations: [conversation], hasMore: false }, msg: "OK" } });
        return route.fallback();
    });

    await page.goto(`/create?conversationId=${conversationId}`, { waitUntil: "domcontentloaded" });
    const textResult = page.getByRole("region", { name: "文本产物：夏日新品推文" });
    await expect(textResult).toBeVisible();
    await expect(textResult).toContainText("今天也要保持好心情 😊❤️🚀");
    await expect(page.getByText("已完成 1 个创作任务。", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "复制消息" })).toBeVisible();
    const markdown = textResult.locator('div[style*="Segoe UI Emoji"]');
    expect(await markdown.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Segoe UI Emoji");
    await expectNoHorizontalOverflow(page, "Agent emoji article");

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("region", { name: "文本产物：夏日新品推文" })).toContainText("今天也要保持好心情 😊❤️🚀");
    await expectNoHorizontalOverflow(page, "Agent emoji article dark");
});
