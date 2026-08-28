import { randomUUID } from "node:crypto";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

type MediaType = "image" | "video";
type MediaSize = { width: number; height: number; label: string };

const IMAGE_SIZES: MediaSize[] = [
    { label: "1:1", width: 1024, height: 1024 },
    { label: "9:16", width: 720, height: 1280 },
    { label: "16:9", width: 1920, height: 1080 },
    { label: "超长图", width: 1000, height: 4000 },
];
const VIDEO_SIZES: MediaSize[] = [
    { label: "16:9", width: 1920, height: 1080 },
    { label: "9:16", width: 720, height: 1280 },
    { label: "1:1", width: 1024, height: 1024 },
];
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    browserErrors.set(page, errors);
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
        if (response.status() >= 400) errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });
});

test.afterEach(async ({ page }) => {
    expect(browserErrors.get(page) || []).toEqual([]);
});

test("image results shrink to their real 1:1, 9:16, 16:9 and long-image sizes", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "桌面尺寸矩阵由 1672×941 基准项目验证");
    await preparePage(page, testInfo);
    const expected = [
        { width: 420, height: 420 },
        { width: 300, height: 533 },
        { width: 560, height: 315 },
        { width: 320, height: 1280 },
    ];

    for (let index = 0; index < IMAGE_SIZES.length; index += 1) {
        const fixture = await mockCreativeRound(page, { type: "image", sizes: [IMAGE_SIZES[index]] });
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });
        const result = page.getByTestId("creative-media-result");
        const primary = result.getByTestId("creative-primary-result");
        await expect(primary).toBeVisible({ timeout: 45_000 });
        await expect(result.getByText("更多", { exact: true })).toHaveCount(0);
        await expect(result.getByTestId("creative-result-switcher")).toHaveCount(0);
        await expect(primary).toHaveAttribute("data-rendered-width", String(expected[index].width));
        await expect(primary).toHaveAttribute("data-rendered-height", String(expected[index].height));
        await expectTightMediaBounds(primary, expected[index]);
        await expectShrinkToFitShell(result, expected[index].width);
        await expectNoHorizontalOverflow(page);
        if (IMAGE_SIZES[index].label === "超长图") await captureVisibleResultSegments(page, primary, testInfo, "image-single-long");
        else await captureResult(result, testInfo, `image-single-${IMAGE_SIZES[index].label.replace(":", "-")}`);
    }
});

test("multiple image results share one switcher and actions follow the selected result", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "完整多结果交互在桌面基准项目验证");
    await preparePage(page, testInfo);
    const fixture = await mockCreativeRound(page, { type: "image", sizes: IMAGE_SIZES });
    await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

    const round = page.getByTestId("creative-media-round");
    const result = round.getByTestId("creative-media-result");
    const primary = result.getByTestId("creative-primary-result");
    await expect(result).toBeVisible({ timeout: 45_000 });
    await expect(result.getByTestId("creative-result-switcher")).toHaveAttribute("data-results-count", "4");
    await expect(result.getByText("更多", { exact: true })).toBeVisible();
    await expect(round.getByLabel("生成耗时：8秒")).toBeVisible();
    await expect(round.getByLabel(/完成时间：/)).toBeVisible();
    const [titleBounds, timingBounds] = await Promise.all([
        round.getByRole("heading", { name: "已为你生成图片" }).evaluate((element) => element.getBoundingClientRect().toJSON()),
        round.getByTestId("creative-run-timing").evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(Math.abs(titleBounds.bottom - timingBounds.bottom)).toBeLessThanOrEqual(8);
    await expect(primary).toHaveAttribute("data-rendered-width", "420");
    expect(fixture.repeatedRequests()).toHaveLength(0);

    await round.getByRole("button", { name: "复制输入内容" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lastCopiedText?: string }).__lastCopiedText)).toBe(fixture.prompt);

    const thirdResult = result.getByRole("button", { name: "查看生成结果 3" });
    await thirdResult.click();
    await expect(primary).toHaveAttribute("data-rendered-width", "560");
    await expect(primary).toHaveAttribute("data-rendered-height", "315");
    await expect(round.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", fixture.assets[2].id);
    await expect(thirdResult.locator(".lucide-check")).toHaveCount(0);
    const selectedOutline = thirdResult.locator("[data-selected-outline]");
    const thumbnailContent = thirdResult.locator("[data-thumbnail-content]");
    await expect(selectedOutline).toHaveCount(1);
    await expect(thumbnailContent).toHaveCount(1);
    const [thumbnailBounds, outlineBounds, contentBounds] = await Promise.all([
        thirdResult.evaluate((element) => element.getBoundingClientRect().toJSON()),
        selectedOutline.evaluate((element) => element.getBoundingClientRect().toJSON()),
        thumbnailContent.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(Math.abs(thumbnailBounds.left - outlineBounds.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(thumbnailBounds.top - outlineBounds.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(thumbnailBounds.right - outlineBounds.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(thumbnailBounds.bottom - outlineBounds.bottom)).toBeLessThanOrEqual(1);
    expect(contentBounds.left - thumbnailBounds.left).toBeGreaterThanOrEqual(1.5);
    expect(contentBounds.top - thumbnailBounds.top).toBeGreaterThanOrEqual(1.5);
    expect(thumbnailBounds.right - contentBounds.right).toBeGreaterThanOrEqual(1.5);
    expect(thumbnailBounds.bottom - contentBounds.bottom).toBeGreaterThanOrEqual(1.5);
    const [primaryBounds, switcherBounds] = await Promise.all([primary.evaluate((element) => element.getBoundingClientRect().toJSON()), result.getByTestId("creative-result-switcher").evaluate((element) => element.getBoundingClientRect().toJSON())]);
    expect(primaryBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height / 3 + 2);
    expect(switcherBounds.left).toBeGreaterThan(primaryBounds.right);
    expect(switcherBounds.left - primaryBounds.right).toBeLessThanOrEqual(16);
    expect(Math.abs(switcherBounds.top - primaryBounds.top)).toBeLessThanOrEqual(1);
    expect(switcherBounds.height).toBeLessThanOrEqual(primaryBounds.height + 1);
    expect(thumbnailBounds.width).toBeLessThan(primaryBounds.width / 4);
    const selectionColors = await selectedOutline.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--primary)";
        document.body.appendChild(probe);
        const colors = { border: getComputedStyle(element).borderTopColor, primary: getComputedStyle(probe).color };
        probe.remove();
        return colors;
    });
    expect(selectionColors.border).toBe(selectionColors.primary);
    const actionPalettes = await Promise.all(
        ["更多本轮创作操作", "下载"].map((name) =>
            round.getByRole("button", { name, exact: true }).evaluate((element) => {
                const style = getComputedStyle(element);
                return { background: style.backgroundColor, border: style.borderTopColor, color: style.color };
            }),
        ),
    );
    expect(actionPalettes[1]).toEqual(actionPalettes[0]);
    await copyCurrentPrompt(page, round);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lastCopiedText?: string }).__lastCopiedText)).toBe(fixture.optimizedPromptFor(2));
    const actionBounds = await round.getByLabel("本轮创作操作", { exact: true }).evaluate((element) => element.getBoundingClientRect().toJSON());
    expect(actionBounds.width).toBeLessThanOrEqual(primaryBounds.width + 1);
    await round.getByRole("button", { name: "下载", exact: true }).click();
    await expect(page.getByText("下载当前结果", { exact: true })).toBeVisible();
    await expect(page.getByText(`下载全部结果（${fixture.assets.length}）`, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await round.getByRole("button", { name: "更多本轮创作操作" }).click();
    await expect(page.getByText("新窗口打开", { exact: true })).toHaveCount(0);
    await page.getByText("引用结果", { exact: true }).click();
    await expect(page.getByRole("button", { name: `移除${fixture.assets[2].title}` })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `移除${fixture.assets[0].title}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `移除${fixture.assets[1].title}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `移除${fixture.assets[3].title}` })).toHaveCount(0);
    await round.getByRole("button", { name: "更多本轮创作操作" }).click();
    await page.getByText("取消引用", { exact: true }).click();
    await expect(page.getByRole("button", { name: `移除${fixture.assets[2].title}` })).toHaveCount(0);
    await captureResult(result, testInfo, "image-multiple-results");

    await result.getByRole("button", { name: "查看生成结果 4" }).click();
    await expect(primary).toHaveAttribute("data-rendered-width", "320");
    await expect(primary).toHaveAttribute("data-rendered-height", "1280");
    await expect(round.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", fixture.assets[3].id);

    await copyCurrentPrompt(page, round);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lastCopiedText?: string }).__lastCopiedText)).toBe(fixture.optimizedPromptFor(3));
    await expectNoHorizontalOverflow(page);
    await expect(round.getByRole("button", { name: "更多本轮创作操作" })).toBeVisible();
    await expect(round.getByRole("button", { name: "重新编辑" })).toHaveCount(0);
    await expect(round.getByRole("button", { name: "再次生成" })).toHaveCount(0);
    expect(fixture.repeatedRequests()).toHaveLength(0);
    const conversationScroll = page.getByTestId("creative-conversation-scroll");
    const composerDock = page.getByTestId("creative-composer-dock");
    await conversationScroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    const [scrollBounds, roundBounds, dockBounds] = await Promise.all([
        conversationScroll.evaluate((element) => element.getBoundingClientRect().toJSON()),
        round.evaluate((element) => element.getBoundingClientRect().toJSON()),
        composerDock.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(Math.abs(scrollBounds.bottom - dockBounds.top)).toBeLessThanOrEqual(1);
    expect(roundBounds.bottom).toBeLessThanOrEqual(dockBounds.top + 2);
});

test("copy prompt refreshes a restored run whose cached details omit the public prompt", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "旧会话提示词刷新由桌面基准项目验证");
    await preparePage(page, testInfo);
    const fixture = await mockCreativeRound(page, { type: "image", sizes: [IMAGE_SIZES[0]], withholdPrompts: true });
    await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

    const round = page.getByTestId("creative-media-round");
    const moreButton = round.getByRole("button", { name: "更多本轮创作操作" });
    await expect(moreButton).toBeVisible({ timeout: 45_000 });
    await expect(moreButton).toBeEnabled();
    const requestsBeforeCopy = fixture.runRequests();

    fixture.revealPrompts();
    await copyCurrentPrompt(page, round);

    await expect.poll(fixture.runRequests).toBeGreaterThan(requestsBeforeCopy);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lastCopiedText?: string }).__lastCopiedText)).toBe(fixture.optimizedPromptFor(0));
});

test("a 100-result batch stays complete inside the bounded result rail", async ({ page }, testInfo) => {
    await preparePage(page, testInfo);
    const desktop = testInfo.project.name === "chromium";
    const fixture = await mockCreativeRound(page, { type: "image", sizes: Array.from({ length: 100 }, () => IMAGE_SIZES[0]) });
    await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

    const result = page.getByTestId("creative-media-result");
    const primary = result.getByTestId("creative-primary-result");
    const switcher = result.getByTestId("creative-result-switcher");
    const strip = switcher.getByLabel("更多生成结果", { exact: true });
    await expect(switcher).toBeVisible({ timeout: 45_000 });
    await expect(switcher).toHaveAttribute("data-results-count", "100");
    await expect(switcher.getByRole("button", { name: /查看生成结果/ })).toHaveCount(100);
    await expect(switcher.getByTestId("creative-result-position")).toHaveText("1 / 100");
    await expect(switcher).toHaveAttribute("data-orientation", desktop ? "vertical" : "horizontal");
    await expect(switcher).toHaveAttribute("data-overflow", "true");

    const [primaryBounds, switcherBounds, stripMetrics] = await Promise.all([
        primary.evaluate((element) => element.getBoundingClientRect().toJSON()),
        switcher.evaluate((element) => element.getBoundingClientRect().toJSON()),
        strip.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
    ]);
    if (desktop) {
        expect(switcherBounds.height).toBeLessThanOrEqual(primaryBounds.height + 1);
        expect(stripMetrics.scrollHeight).toBeGreaterThan(stripMetrics.clientHeight);
    } else {
        expect(switcherBounds.width).toBeLessThanOrEqual(primaryBounds.width + 1);
        expect(stripMetrics.scrollWidth).toBeGreaterThan(stripMetrics.clientWidth);
    }

    await switcher.getByRole("button", { name: "查看更多生成结果" }).click();
    await expect.poll(() => strip.evaluate((element, vertical) => (vertical ? element.scrollTop : element.scrollLeft), desktop)).toBeGreaterThan(0);
    await switcher.getByRole("button", { name: "查看生成结果 100" }).click();
    await expect(switcher.getByTestId("creative-result-position")).toHaveText("100 / 100");
    await expectNoHorizontalOverflow(page);
});

test("a long-running media task uses warm elapsed-time feedback", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "运行中人格化文案由桌面基准项目验证");
    await preparePage(page, testInfo);
    const fixture = await mockPendingCreativeRound(page, "video");

    try {
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });
        const waiting = page.getByTestId("creative-generation-waiting");
        await expect(waiting).toBeVisible({ timeout: 45_000 });
        await expect(waiting).toContainText("主人，久等了");
        await expect(waiting.getByTestId("creative-generation-elapsed")).toContainText("已等待 2分");
        await expect(waiting).not.toContainText("正在处理");
        await expect(page.getByRole("heading", { name: "已为你生成视频" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await captureResult(waiting, testInfo, "creative-generation-waiting");
    } finally {
        fixture.releaseEvents();
    }
});

test("a paused media task shows its concrete review reason without a loading state", async ({ page }, testInfo) => {
    await preparePage(page, testInfo);
    const reason = "OpenAI 视频协议最多支持 1 张参考图";
    const fixture = await mockPendingCreativeRound(page, "video", reason);

    try {
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });
        const round = page.getByTestId("creative-media-round");
        await expect(round.getByRole("heading", { name: "任务已暂停" })).toBeVisible({ timeout: 45_000 });
        await expect(round.getByTestId("creative-generation-review")).toHaveText(reason);
        await expect(round.getByTestId("creative-generation-waiting")).toHaveCount(0);
        await expect(round.getByTestId("creative-media-loading")).toHaveCount(0);
        await expect(round.getByText(/正在生成|已等待/)).toHaveCount(0);
        await expect(round.getByRole("button", { name: "直接重试本次创作" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await captureResult(round, testInfo, "creative-generation-paused-review");
    } finally {
        fixture.releaseEvents();
    }
});

test("single video results keep real ratios and retain complete player controls", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "桌面视频尺寸矩阵由 1672×941 基准项目验证");
    await preparePage(page, testInfo);
    const expected = [
        { width: 520, height: 293 },
        { width: 300, height: 533 },
        { width: 420, height: 420 },
    ];

    for (let index = 0; index < VIDEO_SIZES.length; index += 1) {
        const fixture = await mockCreativeRound(page, { type: "video", sizes: [VIDEO_SIZES[index]] });
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });
        const result = page.getByTestId("creative-video-result");
        const primary = result.getByTestId("creative-primary-result");
        const player = result.getByTestId("creative-video-player");
        const video = player.locator("video").first();
        await expect(result).toBeVisible({ timeout: 45_000 });
        await video.evaluate((element) => element.dispatchEvent(new Event("loadedmetadata")));
        await expect(result.getByText("更多", { exact: true })).toHaveCount(0);
        await expect(result.getByTestId("creative-result-switcher")).toHaveCount(0);
        await expect(result.getByText(/视频亮点|镜头分镜|配乐氛围|文案摘要/)).toHaveCount(0);
        await expect(primary).toHaveAttribute("data-rendered-width", String(expected[index].width));
        await expect(primary).toHaveAttribute("data-rendered-height", String(expected[index].height));
        await expectTightMediaBounds(primary, expected[index]);
        await expectShrinkToFitShell(result, expected[index].width);
        await expect(video).toHaveAttribute("preload", "metadata");
        await expect(player.getByLabel("视频播放进度")).toBeVisible();
        await expect(player.getByLabel("静音")).toBeVisible();
        await expect(player.getByLabel("全屏播放")).toBeVisible();

        if (index === 0) {
            await player.getByRole("button", { name: "开始播放视频" }).click();
            await expect(player.getByRole("button", { name: "暂停视频" })).toBeVisible();
            await player.getByRole("button", { name: "暂停视频" }).click();
            await player.getByLabel("视频播放进度").fill("6");
            await expect(player.getByText("00:06 / 00:15", { exact: true })).toBeVisible();
            await player.getByLabel("静音").click();
            await expect(player.getByLabel("打开声音")).toBeVisible();
            await player.getByLabel("全屏播放").click();
            await expect.poll(() => page.evaluate(() => Number((window as unknown as { __fullscreenRequests?: number }).__fullscreenRequests || 0))).toBe(1);
        }
        await expectNoHorizontalOverflow(page);
        await captureResult(result, testInfo, `video-single-${VIDEO_SIZES[index].label.replace(":", "-")}`);
    }
});

test("natural media dimensions replace stale ratio metadata when persisted dimensions are missing", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "自然尺寸回退在桌面基准项目验证");
    await preparePage(page, testInfo);

    const imageFixture = await mockCreativeRound(page, { type: "image", sizes: [IMAGE_SIZES[1]], omitDimensions: true, reportedRatio: "1:1" });
    await page.goto(`/create?conversationId=${imageFixture.id}`, { waitUntil: "domcontentloaded" });
    const imageResult = page.getByTestId("creative-media-result");
    const imagePrimary = imageResult.getByTestId("creative-primary-result");
    await expect(imagePrimary).toHaveAttribute("data-rendered-width", "300", { timeout: 45_000 });
    await expect(imagePrimary).toHaveAttribute("data-rendered-height", "533");
    await expectTightMediaBounds(imagePrimary, { width: 300, height: 533 });
    await expectShrinkToFitShell(imageResult, 300);

    const videoFixture = await mockCreativeRound(page, { type: "video", sizes: [VIDEO_SIZES[0]], omitDimensions: true, reportedRatio: "1:1" });
    await page.goto(`/create?conversationId=${videoFixture.id}`, { waitUntil: "domcontentloaded" });
    const videoResult = page.getByTestId("creative-video-result");
    const videoPrimary = videoResult.getByTestId("creative-primary-result");
    const video = videoResult.getByTestId("creative-video-player").locator("video").first();
    await expect.poll(() => video.evaluate((element) => element.videoWidth / element.videoHeight), { timeout: 45_000 }).toBeCloseTo(16 / 9, 2);
    await expect(videoPrimary).toHaveAttribute("data-rendered-width", "520");
    await expect(videoPrimary).toHaveAttribute("data-rendered-height", "293");
    await expectTightMediaBounds(videoPrimary, { width: 520, height: 293 });
    await expectShrinkToFitShell(videoResult, 520);
    await expectNoHorizontalOverflow(page);
});

test("multiple videos switch src, poster and size while releasing the previous player", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "完整视频切换在桌面基准项目验证");
    await preparePage(page, testInfo);
    const fixture = await mockCreativeRound(page, { type: "video", sizes: [VIDEO_SIZES[0], VIDEO_SIZES[1]] });
    await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

    const round = page.getByTestId("creative-media-round");
    const result = round.getByTestId("creative-video-result");
    const primary = result.getByTestId("creative-primary-result");
    const firstPlayer = result.getByTestId("creative-video-player");
    await expect(result).toBeVisible({ timeout: 45_000 });
    await firstPlayer.locator("video").evaluate((element) => element.dispatchEvent(new Event("loadedmetadata")));
    await firstPlayer.getByRole("button", { name: "开始播放视频" }).click();
    const pausesBeforeSwitch = await page.evaluate(() => Number((window as unknown as { __mediaPauseCalls?: number }).__mediaPauseCalls || 0));

    await result.getByRole("button", { name: "查看生成结果 2" }).click();
    const secondPlayer = result.getByTestId("creative-video-player");
    const secondVideo = secondPlayer.locator("video").first();
    await expect(secondVideo).toHaveAttribute("aria-label", fixture.assets[1].title);
    await expect(secondVideo).toHaveAttribute("src", fixture.assets[1].serverUrl!);
    await expect(secondVideo).toHaveAttribute("poster", fixture.assets[1].metadata.coverUrl as string);
    await expect(primary).toHaveAttribute("data-rendered-width", "300");
    await expect(primary).toHaveAttribute("data-rendered-height", "533");
    await expect(secondPlayer.getByText("00:00 / 00:15", { exact: true })).toBeVisible();
    await expect(round.getByLabel("本轮创作操作", { exact: true })).toHaveAttribute("data-active-asset-id", fixture.assets[1].id);
    await expect.poll(() => page.evaluate(() => Number((window as unknown as { __mediaPauseCalls?: number }).__mediaPauseCalls || 0))).toBeGreaterThan(pausesBeforeSwitch);
    expect(await page.evaluate(() => Number((window as unknown as { __mediaLoadCalls?: number }).__mediaLoadCalls || 0))).toBe(0);
    await expect(result.getByText("更多", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await captureResult(result, testInfo, "video-multiple-results");
});

test("failed image and video generations expose only in-place retry", async ({ page }, testInfo) => {
    await preparePage(page, testInfo);
    for (const type of ["image", "video"] as const) {
        const fixture = await mockCreativeRound(page, { type, sizes: [], failed: true });
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

        const round = page.getByTestId("creative-media-round");
        await expect(round).toBeVisible({ timeout: 45_000 });
        await expect(round.getByTestId("creative-generation-failure")).toBeVisible();
        await expect(round.getByText("当前模型暂不可用，请切换模型或稍后重试。", { exact: true })).toBeVisible();
        await expect(round.getByRole("button", { name: "直接重试本次创作" })).toHaveText("直接重试");
        await expect(round.getByTestId("creative-primary-result")).toHaveCount(0);
        await expect(round.getByRole("button", { name: /编辑.*重试/ })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await captureResult(round, testInfo, `${type}-generation-failed`);
    }
});

test("partial image and video runs keep every successful result visible with a failed-task retry", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "部分成功结果由桌面基准项目验证");
    await preparePage(page, testInfo);

    for (const type of ["image", "video"] as const) {
        const fixture = await mockCreativeRound(page, { type, sizes: type === "image" ? IMAGE_SIZES.slice(0, 2) : VIDEO_SIZES.slice(0, 2), partialFailure: true });
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });
        const round = page.getByTestId("creative-media-round");
        const result = round.getByTestId(type === "image" ? "creative-media-result" : "creative-video-result");

        await expect(result).toBeVisible({ timeout: 45_000 });
        await expect(result).toHaveAttribute("data-results-count", "2");
        await expect(result.getByTestId("creative-result-switcher")).toHaveAttribute("data-results-count", "2");
        await expect(round.getByRole("button", { name: "直接重试本次创作" })).toBeVisible();
        await expect(round.getByRole("button", { name: `重试 ${type === "image" ? "图片" : "视频"}生成` })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await captureResult(round, testInfo, `${type}-partial-results`);
    }
});

test("asset mentions stay as inline thumbnail references while the editor is focused", async ({ page }, testInfo) => {
    await preparePage(page, testInfo);
    for (const type of ["image", "video"] as const) {
        const fixture = await mockCreativeRound(page, { type, sizes: (type === "image" ? IMAGE_SIZES : VIDEO_SIZES).slice(0, 2) });
        const label = type === "image" ? "图片" : "视频";
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });

        const composer = page.locator(".creative-composer");
        const input = composer.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" });
        await expect(page.getByTestId("creative-media-round")).toBeVisible({ timeout: 45_000 });
        await expect(composer).toHaveAttribute("data-ready", "true");
        await expect(input).toBeVisible();
        await input.fill("222@");
        await expect(page.getByTestId("creative-asset-mention-picker")).toBeVisible();
        await input.fill("书店收购价格");
        await input.evaluate((element) => {
            const textarea = element as HTMLTextAreaElement;
            textarea.setSelectionRange(0, 0);
        });
        await composer.getByRole("button", { name: "引用当前对话资产" }).click();
        await expect(input).toHaveValue("@书店收购价格");
        const mentionPicker = page.getByTestId("creative-asset-mention-picker");
        await expect(mentionPicker.getByRole("tablist", { name: "引用素材类型" })).toHaveCount(0);
        const mentionGrid = mentionPicker.getByTestId(`creative-asset-mention-${type}-grid`);
        const pickerItems = mentionGrid.getByRole("button");
        await expect(pickerItems).toHaveCount(2);
        await expect(pickerItems.nth(0)).toHaveAttribute("data-asset-id", String(fixture.assets[0].id));
        await expect(pickerItems.nth(1)).toHaveAttribute("data-asset-id", String(fixture.assets[1].id));
        await expect
            .poll(async () => {
                const [firstPickerBounds, secondPickerBounds] = await Promise.all([pickerItems.nth(0).boundingBox(), pickerItems.nth(1).boundingBox()]);
                return {
                    sameRow: Boolean(firstPickerBounds && secondPickerBounds && Math.abs(firstPickerBounds.y - secondPickerBounds.y) < 1),
                    ordered: Boolean(firstPickerBounds && secondPickerBounds && secondPickerBounds.x > firstPickerBounds.x),
                };
            })
            .toEqual({ sameRow: true, ordered: true });
        await expect(mentionPicker.getByText(`${label}结果 1`, { exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: `选择${label}结果 1`, exact: true }).click();
        await expect(input).toHaveValue(`@${label}1 书店收购价格`);
        await expect
            .poll(() =>
                input.evaluate((element) => {
                    const textarea = element as HTMLTextAreaElement;
                    return { start: textarea.selectionStart, end: textarea.selectionEnd, next: textarea.value[textarea.selectionStart] };
                }),
            )
            .toEqual({ start: `@${label}1 `.length, end: `@${label}1 `.length, next: "书" });
        await expect(composer.getByLabel(`已上传${label} ${label}结果 1`)).toBeVisible();
        const mentionPreview = composer.getByTestId("creative-composer-mention-preview");
        const chips = mentionPreview.getByTestId("creative-composer-reference-chip");
        await expect(chips).toHaveCount(1);
        await expect(chips.locator("[data-mention-label]")).toHaveText(`${label}1`);
        await expect(chips.locator("img")).toHaveCount(1);
        await expect(chips.locator("[data-mention-token-width]")).toHaveText(`@${label}1`);

        await input.fill(`@${label}1 生成男孩子，@`);
        await page.getByRole("button", { name: `选择${label}结果 2`, exact: true }).click();
        await expect(input).toHaveValue(`@${label}1 生成男孩子，@${label}2 `);
        await expect(composer.getByLabel(`已上传${label} ${label}结果 1`)).toBeVisible();
        await expect(composer.getByLabel(`已上传${label} ${label}结果 2`)).toBeVisible();
        await expect(chips).toHaveCount(2);
        await expect(chips.nth(0)).toHaveAttribute("data-asset-id", String(fixture.assets[0].id));
        await expect(chips.nth(1)).toHaveAttribute("data-asset-id", String(fixture.assets[1].id));

        await composer.getByRole("button", { name: `移除${label}结果 1`, exact: true }).click();
        await expect(composer.getByLabel(`已上传${label} ${label}结果 1`)).toHaveCount(0);
        await expect(composer.getByLabel(`已上传${label} ${label}结果 2`)).toBeVisible();
        await expect(input).toHaveValue(`生成男孩子，@${label}1`);
        await expect(chips).toHaveCount(1);
        await expect(chips).toHaveAttribute("data-asset-id", String(fixture.assets[1].id));
        await expectNoHorizontalOverflow(page);
    }

    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectNoHorizontalOverflow(page);
});

test("prompt library searches, filters and scrolls through bounded server pages", async ({ page }, testInfo) => {
    await preparePage(page, testInfo);
    const promptRequests: URL[] = [];
    await page.route(/\/api\/prompts(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        promptRequests.push(url);
        const currentPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const keyword = url.searchParams.get("keyword") || "";
        const category = url.searchParams.get("category") || "";
        const start = (currentPage - 1) * 20;
        const items = Array.from({ length: 20 }, (_, index) => ({
            id: `prompt-${keyword || "all"}-${category || "all"}-${start + index + 1}`,
            title: `提示词 ${start + index + 1}`,
            coverUrl: imageDataUrl(IMAGE_SIZES[0], start + index),
            prompt: `${keyword || "通用"}${category || "创作"}提示词 ${start + index + 1}`,
            tags: [],
            category: category || "海报",
            preview: "",
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
        }));
        await route.fulfill({ json: { items, tags: [], categories: currentPage === 1 ? ["海报", "摄影"] : [], total: 40 } });
    });

    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "打开资产面板" }).click();
    await page.getByRole("tab", { name: /提示词库/ }).click();
    const scroll = page.getByTestId("creative-prompt-scroll");
    await expect(scroll).toBeVisible({ timeout: 45_000 });
    await expect(scroll.getByTestId("creative-prompt-thumbnails").locator("article")).toHaveCount(20);
    await scroll.getByRole("button", { name: "加载更多" }).click();
    await expect(scroll.getByTestId("creative-prompt-thumbnails").locator("article")).toHaveCount(40);
    await expect
        .poll(() =>
            scroll.evaluate((element) => ({
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
            })),
        )
        .toMatchObject({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) });
    const beforeScroll = await scroll.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
    await scroll.hover();
    await page.mouse.wheel(0, beforeScroll.scrollHeight);
    await expect(scroll.getByRole("button", { name: "插入：提示词 40" })).toBeVisible();
    expect(promptRequests.some((url) => url.searchParams.get("page") === "2" && url.searchParams.get("includeFacets") === "0")).toBe(true);

    const search = scroll.getByRole("textbox", { name: "搜索提示词" });
    await search.fill("产品");
    await search.press("Enter");
    await expect.poll(() => promptRequests.some((url) => url.searchParams.get("keyword") === "产品" && url.searchParams.get("page") === "1")).toBe(true);
    await scroll.getByRole("button", { name: "提示词分类" }).click();
    await page.getByText("海报", { exact: true }).last().click();
    await expect.poll(() => promptRequests.some((url) => url.searchParams.get("keyword") === "产品" && url.searchParams.get("category") === "海报")).toBe(true);
    await expectNoHorizontalOverflow(page);
});

test("result layouts remain contained at 390px and 430px", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "chromium", "移动端项目覆盖窄屏回归");
    await preparePage(page, testInfo);

    for (const type of ["image", "video"] as const) {
        const fixture = await mockCreativeRound(page, { type, sizes: type === "image" ? IMAGE_SIZES : [VIDEO_SIZES[1], VIDEO_SIZES[0]] });
        await page.goto(`/create?conversationId=${fixture.id}`, { waitUntil: "domcontentloaded" });
        const result = page.getByTestId(type === "image" ? "creative-media-result" : "creative-video-result");
        const primary = result.getByTestId("creative-primary-result");
        await expect(primary).toBeVisible({ timeout: 45_000 });
        const bounds = await primary.evaluate((element) => element.getBoundingClientRect().toJSON());
        const switcherBounds = await result.getByTestId("creative-result-switcher").evaluate((element) => element.getBoundingClientRect().toJSON());
        expect(bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height / 3 + 2);
        expect(bounds.width / bounds.height).toBeCloseTo(type === "image" ? 1 : 9 / 16, 1);
        expect(switcherBounds.top).toBeGreaterThanOrEqual(bounds.bottom);
        await expectNoHorizontalOverflow(page);
    }
});

async function preparePage(page: Page, testInfo: TestInfo) {
    if (testInfo.project.name === "chromium") await page.setViewportSize({ width: 1672, height: 941 });
    await page.route(/\/api\/public\/gallery(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { items: [] }, msg: "OK" } }));
    await page.route(/\/api\/notifications\/interactions(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { items: [], unreadCount: 0 }, msg: "OK" } }));
    await installBrowserSpies(page);
}

async function mockCreativeRound(page: Page, options: { type: MediaType; sizes: MediaSize[]; failed?: boolean; partialFailure?: boolean; omitDimensions?: boolean; reportedRatio?: string; withholdPrompts?: boolean }) {
    const id = `e2e-result-${randomUUID()}`;
    const runId = `e2e-run-${randomUUID()}`;
    const timestamp = Date.now();
    const prompt = options.type === "image" ? `生成 ${Math.max(1, options.sizes.length)} 张商业主视觉` : `生成 ${Math.max(1, options.sizes.length)} 条产品短视频`;
    const optimizedPromptFor = (index: number) => (options.type === "image" ? "夏日海边商业主视觉，人物自然微笑，通透明亮，保留真实肤质" : `产品短视频镜头 ${index + 1}，运镜平稳，动作自然，光线连贯`);
    const assets = [] as Array<Record<string, unknown>>;

    for (let index = 0; index < options.sizes.length; index += 1) {
        const size = options.sizes[index];
        const serverUrl = options.type === "image" ? imageDataUrl(size, index) : await createVideoDataUrl(page, size, index);
        const coverUrl = imageDataUrl(size, index + 10);
        const agentTaskId = options.partialFailure ? `${options.type}-task` : options.type === "image" ? "image-task" : `video-task-${index + 1}`;
        assets.push({
            id: `${options.type}-asset-${randomUUID()}`,
            userId: "e2e-user",
            conversationId: id,
            messageId: `assistant-${runId}`,
            sourceRunId: runId,
            sourceTaskId: `${options.type}-task-${index + 1}`,
            ordinal: index,
            type: options.type,
            status: "ready",
            title: `${options.type === "image" ? "图片" : "视频"}结果 ${index + 1}`,
            serverUrl,
            remoteUrl: serverUrl,
            mimeType: options.type === "image" ? "image/svg+xml" : "video/webm",
            ...(options.omitDimensions ? {} : { width: size.width, height: size.height }),
            durationMs: options.type === "video" ? 15_000 : undefined,
            metadata: { coverUrl, ratio: options.reportedRatio || `${size.width}:${size.height}`, agentTaskId },
            createdAt: timestamp + index + 1,
            updatedAt: timestamp + index + 1,
        });
    }

    const userMessage = { id: `user-${runId}`, conversationId: id, runId, sequence: 1, role: "user", status: "completed", content: prompt, metadata: {}, createdAt: timestamp, updatedAt: timestamp };
    const assistantMessage = {
        id: `assistant-${runId}`,
        conversationId: id,
        runId,
        sequence: 2,
        role: "assistant",
        status: options.failed ? "failed" : "completed",
        content: options.failed ? "当前模型暂不可用，请切换模型或稍后重试。" : `${options.type === "image" ? "图片" : "视频"}已生成。`,
        metadata: {},
        createdAt: timestamp + 1,
        updatedAt: timestamp + 1,
    };
    const conversation = { id, userId: "e2e-user", surface: "chat", source: "agent", title: prompt, status: "active", contextSummary: "", contextSummaryThroughSequence: 0, createdAt: timestamp, updatedAt: timestamp, lastMessageAt: timestamp };
    const primarySize = options.sizes[0] || (options.type === "image" ? IMAGE_SIZES[0] : VIDEO_SIZES[0]);
    const tasks = options.failed
        ? [
              {
                  id: `${options.type}-task`,
                  title: options.type === "image" ? "图片生成" : "视频生成",
                  type: options.type,
                  model: `${options.type}-gen`,
                  optimizedPrompt: optimizedPromptFor(0),
                  count: 1,
                  status: "failed",
                  error: "当前模型暂不可用，请切换模型或稍后重试。",
              },
          ]
        : options.partialFailure
          ? [
                {
                    id: `${options.type}-task`,
                    title: options.type === "image" ? "图片生成" : "视频生成",
                    type: options.type,
                    model: `${options.type}-gen`,
                    optimizedPrompt: optimizedPromptFor(0),
                    count: options.sizes.length + 1,
                    status: "failed",
                    error: "部分结果生成失败",
                    childTasks: [
                        ...assets.map((asset, index) => ({ id: `${options.type}-child-${index + 1}`, status: "completed", attempt: 1, result: { serverUrl: asset.serverUrl } })),
                        { id: `${options.type}-child-failed`, status: "failed", attempt: 1, error: "上游拒绝了一个结果" },
                    ],
                },
            ]
          : options.type === "image"
            ? [
                  {
                      id: "image-task",
                      title: "生成图片",
                      type: "image",
                      model: "image-gen",
                      optimizedPrompt: optimizedPromptFor(0),
                      ratio: options.reportedRatio || primarySize.label,
                      quality: "high",
                      count: Math.max(1, options.sizes.length),
                      status: "completed",
                  },
              ]
            : options.sizes.map((size, index) => ({
                  id: `video-task-${index + 1}`,
                  title: "生成视频",
                  type: "video",
                  model: "video-gen",
                  optimizedPrompt: optimizedPromptFor(index),
                  ratio: options.reportedRatio || size.label,
                  quality: "high",
                  seconds: 15,
                  count: 1,
                  status: "completed",
              }));
    const run = {
        id: runId,
        conversationId: id,
        inputMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        status: options.failed ? "failed" : "completed",
        prompt,
        referencedAssetIds: [],
        requestedModelIds: [`${options.type}-gen`],
        generationPreferences:
            options.type === "image" ? { mode: "image", image: { size: options.reportedRatio || primarySize.label, quality: "high" } } : { mode: "video", video: { size: options.reportedRatio || primarySize.label, quality: "high", seconds: 15 } },
        assetIds: assets.map((asset) => asset.id),
        tasks,
        createdAt: timestamp,
        updatedAt: timestamp + 8_000,
    };
    const repeatedRun = {
        ...run,
        id: `repeat-${runId}`,
        inputMessageId: `repeat-user-${runId}`,
        assistantMessageId: `repeat-assistant-${runId}`,
        status: "running",
        assetIds: [],
        tasks: [],
    };
    const repeatedRequests: Array<Record<string, unknown>> = [];
    let promptsVisible = !options.withholdPrompts;
    let runRequestCount = 0;

    await page.route(new RegExp(`/api/creative/conversations/${id}$`), (route) => route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/messages(?:\\?.*)?$`), (route) => route.fulfill({ json: { code: 0, data: { messages: [userMessage, assistantMessage] }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/assets$`), (route) => route.fulfill({ json: { code: 0, data: { assets }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${runId}$`), (route) => {
        runRequestCount += 1;
        const responseRun = promptsVisible ? run : { ...run, tasks: run.tasks.map((task) => Object.fromEntries(Object.entries(task).filter(([key]) => key !== "optimizedPrompt"))) };
        return route.fulfill({ json: { code: 0, data: { run: responseRun }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/agent/runs/${repeatedRun.id}/events(?:\\?.*)?$`), (route) =>
        route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: `event: run.completed\ndata: ${JSON.stringify({ data: { reply: "再次生成已完成" } })}\n\n`,
        }),
    );
    await page.route(/\/api\/agent\/runs$/, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        repeatedRequests.push((await route.request().postDataJSON()) as Record<string, unknown>);
        return route.fulfill({ json: { code: 0, data: { run: repeatedRun, created: true }, msg: "OK" } });
    });
    return {
        id,
        prompt,
        assets,
        optimizedPromptFor,
        repeatedRequests: () => repeatedRequests,
        revealPrompts: () => {
            promptsVisible = true;
        },
        runRequests: () => runRequestCount,
    };
}

async function mockPendingCreativeRound(page: Page, type: MediaType, reviewReason = "") {
    const id = `e2e-pending-${randomUUID()}`;
    const runId = `e2e-pending-run-${randomUUID()}`;
    const timestamp = Date.now();
    const startedAt = timestamp - 2 * 60 * 1000;
    const prompt = type === "image" ? "生成一张有温度的生活照片" : "生成一段有温度的生活视频";
    const userMessage = { id: `user-${runId}`, conversationId: id, runId, sequence: 1, role: "user", status: "completed", content: prompt, metadata: {}, createdAt: startedAt, updatedAt: startedAt };
    const assistantMessage = {
        id: `assistant-${runId}`,
        conversationId: id,
        runId,
        sequence: 2,
        role: "assistant",
        status: "running",
        content: `正在处理「${type === "image" ? "图片" : "视频"}生成」`,
        metadata: {},
        createdAt: startedAt,
        updatedAt: timestamp,
    };
    const conversation = { id, userId: "e2e-user", surface: "chat", source: "agent", title: prompt, status: "active", contextSummary: "", contextSummaryThroughSequence: 0, createdAt: startedAt, updatedAt: timestamp, lastMessageAt: timestamp };
    const run = {
        id: runId,
        conversationId: id,
        inputMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        status: reviewReason ? "paused" : "running",
        prompt,
        referencedAssetIds: [],
        requestedModelIds: [`${type}-gen`],
        generationPreferences: type === "image" ? { mode: "image", image: { size: "1:1", quality: "high" } } : { mode: "video", video: { size: "16:9", quality: "high", seconds: 15 } },
        assetIds: [],
        tasks: [{ id: `${type}-task`, title: `${type === "image" ? "图片" : "视频"}生成`, type, model: `${type}-gen`, status: reviewReason ? "needs_review" : "running", ...(reviewReason ? { error: reviewReason } : {}) }],
        createdAt: startedAt,
        updatedAt: timestamp,
    };
    let releaseEvents = () => undefined;
    const eventsReleased = new Promise<void>((resolve) => {
        releaseEvents = resolve;
    });

    await page.route(new RegExp(`/api/creative/conversations/${id}$`), (route) => route.fulfill({ json: { code: 0, data: { conversation }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/messages(?:\\?.*)?$`), (route) => route.fulfill({ json: { code: 0, data: { messages: [userMessage, assistantMessage] }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${id}/assets$`), (route) => route.fulfill({ json: { code: 0, data: { assets: [] }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${runId}$`), (route) => route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${runId}/events(?:\\?.*)?$`), async (route) => {
        await eventsReleased;
        await route.abort();
    });
    return { id, releaseEvents };
}

function imageDataUrl(size: MediaSize, index: number) {
    const hue = (210 + index * 37) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 55% 40%)"/><stop offset="1" stop-color="hsl(${(hue + 55) % 360} 70% 78%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${size.width * 0.5}" cy="${Math.min(size.height * 0.35, size.width)}" r="${Math.max(32, size.width * 0.18)}" fill="rgba(255,255,255,.72)"/><text x="50%" y="${Math.min(size.height * 0.72, size.height - 40)}" text-anchor="middle" fill="white" font-family="sans-serif" font-size="${Math.max(24, size.width * 0.07)}">VOZEB ${size.label}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function createVideoDataUrl(page: Page, size: MediaSize, index: number) {
    await page.goto("about:blank");
    return page.evaluate(
        async ({ width, height, index: frameIndex }) => {
            const scale = Math.min(1, 640 / Math.max(width, height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(180, Math.round(width * scale));
            canvas.height = Math.max(180, Math.round(height * scale));
            const context = canvas.getContext("2d")!;
            const stream = canvas.captureStream(12);
            const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
            const chunks: Blob[] = [];
            recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
            const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
            recorder.start();
            for (let frame = 0; frame < 6; frame += 1) {
                const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
                gradient.addColorStop(0, `hsl(${215 + frameIndex * 30 + frame * 2} 42% 32%)`);
                gradient.addColorStop(1, `hsl(${38 + frameIndex * 25 + frame * 2} 58% 70%)`);
                context.fillStyle = gradient;
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = "rgba(255,255,255,.82)";
                context.beginPath();
                context.arc(canvas.width * (0.28 + frame * 0.08), canvas.height * 0.45, Math.max(24, Math.min(canvas.width, canvas.height) * 0.16), 0, Math.PI * 2);
                context.fill();
                await new Promise((resolve) => setTimeout(resolve, 45));
            }
            recorder.stop();
            await stopped;
            stream.getTracks().forEach((track) => track.stop());
            const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
            let binary = "";
            bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
            return `data:video/webm;base64,${btoa(binary)}`;
        },
        { width: size.width, height: size.height, index },
    );
}

async function installBrowserSpies(page: Page) {
    await page.addInitScript(() => {
        const states = new WeakMap<HTMLMediaElement, { paused: boolean; currentTime: number }>();
        const state = (media: HTMLMediaElement) => {
            const current = states.get(media) || { paused: true, currentTime: 0 };
            states.set(media, current);
            return current;
        };
        Object.defineProperty(HTMLMediaElement.prototype, "paused", {
            configurable: true,
            get() {
                return state(this).paused;
            },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
            configurable: true,
            get() {
                return state(this).currentTime;
            },
            set(value: number) {
                state(this).currentTime = Number(value) || 0;
            },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "duration", {
            configurable: true,
            get() {
                return 15;
            },
        });
        HTMLMediaElement.prototype.play = function () {
            state(this).paused = false;
            this.dispatchEvent(new Event("play"));
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () {
            (window as unknown as { __mediaPauseCalls?: number }).__mediaPauseCalls = Number((window as unknown as { __mediaPauseCalls?: number }).__mediaPauseCalls || 0) + 1;
            state(this).paused = true;
            this.dispatchEvent(new Event("pause"));
        };
        HTMLMediaElement.prototype.load = function () {
            (window as unknown as { __mediaLoadCalls?: number }).__mediaLoadCalls = Number((window as unknown as { __mediaLoadCalls?: number }).__mediaLoadCalls || 0) + 1;
        };
        Element.prototype.requestFullscreen = async function () {
            (window as unknown as { __fullscreenRequests?: number }).__fullscreenRequests = Number((window as unknown as { __fullscreenRequests?: number }).__fullscreenRequests || 0) + 1;
        };
        document.exitFullscreen = async () => undefined;
        document.execCommand = ((command: string) => {
            if (command.toLowerCase() !== "copy") return true;
            const selection = document.getSelection()?.toString() || "";
            const activeValue = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.value : "";
            (window as unknown as { __lastCopiedText?: string }).__lastCopiedText = selection || activeValue;
            return true;
        }) as typeof document.execCommand;
    });
}

async function expectTightMediaBounds(primary: ReturnType<Page["getByTestId"]>, expected: { width: number; height: number }) {
    const [card, media] = await Promise.all([
        primary.evaluate((element) => element.getBoundingClientRect().toJSON()),
        primary
            .locator("img, video")
            .first()
            .evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    const viewportHeight = await primary.evaluate(() => window.innerHeight);
    const scale = Math.min(1, viewportHeight / 3 / expected.height);
    expect(Math.abs(card.width - expected.width * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(card.height - expected.height * scale)).toBeLessThanOrEqual(2);
    expect(card.width - media.width).toBeLessThanOrEqual(3);
    expect(card.height - media.height).toBeLessThanOrEqual(3);
}

async function expectShrinkToFitShell(result: ReturnType<Page["getByTestId"]>, mediaWidth: number) {
    const [shell, primary, actions] = await Promise.all([
        result.evaluate((element) => element.getBoundingClientRect().toJSON()),
        result.getByTestId("creative-primary-result").evaluate((element) => element.getBoundingClientRect().toJSON()),
        result.getByLabel("本轮创作操作", { exact: true }).evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(Math.abs(shell.width - Math.max(primary.width, actions.width))).toBeLessThanOrEqual(2);
    expect(actions.width).toBeLessThanOrEqual(shell.width + 2);
    expect(primary.width).toBeLessThanOrEqual(mediaWidth + 2);
}

async function copyCurrentPrompt(page: Page, round: ReturnType<Page["getByTestId"]>) {
    await round.getByRole("button", { name: "更多本轮创作操作" }).click();
    await page.getByRole("menuitem", { name: "复制提示词" }).click();
}

async function captureResult(locator: ReturnType<Page["getByTestId"]>, testInfo: TestInfo, name: string) {
    if (process.env.VOZEB_PRO_VISUAL_CAPTURE !== "1") return;
    const path = testInfo.outputPath(`${name}-${testInfo.project.name}.png`);
    await locator.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
}

async function captureVisibleResultSegments(page: Page, locator: ReturnType<Page["getByTestId"]>, testInfo: TestInfo, name: string) {
    if (process.env.VOZEB_PRO_VISUAL_CAPTURE !== "1") return;
    for (const block of ["start", "end"] as const) {
        await locator.evaluate((element, position) => element.scrollIntoView({ block: position, inline: "nearest" }), block);
        await page.waitForTimeout(120);
        const [bounds, composerBounds] = await Promise.all([locator.boundingBox(), page.locator(".creative-composer").first().boundingBox()]);
        const viewport = page.viewportSize();
        if (!bounds || !viewport) continue;
        const x = Math.max(0, bounds.x);
        const y = Math.max(0, bounds.y);
        const right = Math.min(viewport.width, bounds.x + bounds.width);
        const bottom = Math.min(viewport.height, bounds.y + bounds.height, composerBounds?.y ? composerBounds.y - 8 : viewport.height);
        if (right <= x || bottom <= y) continue;
        const path = testInfo.outputPath(`${name}-${block}-${testInfo.project.name}.png`);
        await page.screenshot({ path, clip: { x, y, width: right - x, height: bottom - y } });
        await testInfo.attach(`${name}-${block}`, { path, contentType: "image/png" });
    }
}

async function expectNoHorizontalOverflow(page: Page) {
    const widths = await page.evaluate(() => ({ document: [document.documentElement.clientWidth, document.documentElement.scrollWidth], body: [document.body.clientWidth, document.body.scrollWidth] }));
    expect(widths.document[1], JSON.stringify(widths)).toBeLessThanOrEqual(widths.document[0] + 1);
    expect(widths.body[1], JSON.stringify(widths)).toBeLessThanOrEqual(widths.body[0] + 1);
}
