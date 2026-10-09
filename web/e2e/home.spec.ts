import { expect, test, type Locator, type Page } from "@playwright/test";

const galleryResponse = {
    code: 0,
    msg: "OK",
    data: {
        items: [
            galleryItem(1, "image", "media", "视觉设计"),
            galleryItem(2, "video", "media", "视频"),
            galleryItem(3, "image", "drama", "短剧"),
            galleryItem(4, "image", "media", "品牌内容"),
            galleryItem(5, "image", "canvas", "视觉设计"),
            galleryItem(6, "video", "drama", "短剧"),
        ],
    },
};

test("public homepage is functional for signed-out visitors", async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL || "http://127.0.0.1:3100") });
    await context.clearCookies();
    const page = await context.newPage();
    const browserErrors = collectBrowserErrors(page);
    let galleryRequest = "";
    let billingProductRequests = 0;
    await page.route("**/api/public/gallery?**", async (route) => {
        galleryRequest = route.request().url();
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(galleryResponse) });
    });
    await page.route("**/api/billing/products", (route) => {
        billingProductRequests += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ products: [], paymentProviders: [] }) });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "一个入口 完成所有 AI 创作" })).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByText("核心能力", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("home-agent-card")).toHaveCount(1);
    await expect(page.getByTestId("home-agent-halo").locator("[data-halo-ring]")).toHaveCount(4);
    await expect(page.getByTestId("home-public-gallery")).toBeVisible();
    const galleryLayout = await page
        .getByTestId("home-public-gallery")
        .locator("article")
        .evaluateAll((cards) => {
            const visible = cards.map((card) => ({ bounds: card.getBoundingClientRect(), display: getComputedStyle(card).display })).filter((card) => card.display !== "none" && card.bounds.width > 0 && card.bounds.height > 0);
            return { visibleCount: visible.length, rowCount: new Set(visible.map((card) => Math.round(card.bounds.top))).size };
        });
    expect(galleryLayout.rowCount).toBe(2);
    expect(galleryLayout.visibleCount).toBe(testInfo.project.name.startsWith("mobile-") ? 4 : 6);
    const firstGalleryCard = page.getByTestId("home-gallery-card").first();
    await expect(firstGalleryCard.locator("[data-gallery-type], [data-gallery-like]")).toHaveCount(0);
    await expect(firstGalleryCard.locator(".author")).toHaveCount(0);
    const firstGalleryMedia = firstGalleryCard.getByRole("button", { name: /查看作品/ });
    await expect(firstGalleryMedia).toBeVisible();
    if (testInfo.project.name === "chromium") {
        const workBody = firstGalleryCard.locator("[data-gallery-work-body]");
        await expect(workBody).toHaveCSS("opacity", "0");
        await expect(workBody).toHaveCSS("background-image", "none");
        await firstGalleryCard.hover();
        await expect.poll(() => workBody.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    }
    await firstGalleryMedia.click();
    const galleryPreview = page.getByRole("dialog");
    await expect(galleryPreview.getByRole("img", { name: "首页公开作品 1" })).toBeVisible();
    await galleryPreview.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("header").getByRole("button", { name: "登录", exact: true })).toHaveCount(0);
    await expect(page.getByText("登录后使用 AI 创作", { exact: true })).toHaveCount(0);
    const headerNavigation = page.getByRole("navigation", { name: "官网主导航" });
    if (testInfo.project.name === "chromium") {
        await expect(headerNavigation).toBeVisible();
        await expect(headerNavigation.getByRole("button", { name: "创作 Agent" })).toHaveCount(1);
        await expect(headerNavigation.getByRole("button", { name: "短剧制作" })).toHaveCount(1);
        await expect(headerNavigation.getByRole("link", { name: "作品广场" })).toHaveCount(1);
        await expect(headerNavigation.getByRole("button", { name: "价格方案" })).toHaveCount(1);
        await expect(headerNavigation.getByText("图片工作台", { exact: true })).toHaveCount(0);
        await expect(headerNavigation.getByText("视频工作台", { exact: true })).toHaveCount(0);
        await page
            .locator("header")
            .getByRole("button", { name: /立即体验/ })
            .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "Close" }).click();

        const navGlass = page.getByTestId("home-nav-glass");
        const firstNavItem = headerNavigation.getByRole("button", { name: "创作 Agent" });
        const lastNavItem = headerNavigation.getByRole("button", { name: "价格方案" });
        await firstNavItem.hover();
        await expect(navGlass).toHaveCSS("opacity", "1");
        await expect.poll(() => centerOffset(navGlass, firstNavItem)).toBeLessThanOrEqual(1);
        await lastNavItem.hover();
        await expect.poll(() => centerOffset(navGlass, lastNavItem)).toBeLessThanOrEqual(1);
        await lastNavItem.click();
        const plansDialog = page.getByRole("dialog");
        await expect(plansDialog.getByText("升级创作套餐", { exact: true })).toBeVisible();
        await expect(plansDialog.getByText("暂无已上架套餐", { exact: true })).toBeVisible();
        expect(billingProductRequests).toBe(1);
        await plansDialog.getByRole("button", { name: "关闭套餐选择" }).click();
        await expect(plansDialog).toBeHidden();
    } else {
        await expect(headerNavigation).toHaveCount(0);
        const menuButton = page.getByRole("button", { name: "打开导航菜单" });
        await menuButton.click();
        const mobileNavigation = page.getByRole("navigation", { name: "移动端导航" });
        await expect(mobileNavigation).toBeVisible();
        await expect(mobileNavigation.getByRole("button", { name: "创作 Agent" })).toHaveCount(1);
        await expect(mobileNavigation.getByRole("button", { name: "短剧制作" })).toHaveCount(1);
        await expect(mobileNavigation.getByRole("link", { name: "作品广场" })).toHaveCount(1);
        await expect(mobileNavigation.getByRole("button", { name: "价格方案" })).toHaveCount(1);
        await page.getByRole("button", { name: "关闭导航菜单" }).click();
        await expect(mobileNavigation).toHaveCount(0);
    }
    expect(new URL(galleryRequest).pathname).toBe("/api/public/gallery");
    expect(new URL(galleryRequest).searchParams.get("limit")).toBe("18");
    expect(new URL(galleryRequest).searchParams.get("sort")).toBe("random");

    const prompt = page.getByLabel("描述你想创作的内容");
    await prompt.fill("测试首页创作输入");
    await page.getByRole("button", { name: "生成一张科幻城市概念图" }).click();
    await expect(prompt).toHaveValue("生成一张科幻城市概念图");
    await page.getByRole("button", { name: "AI 绘图" }).click();
    await expect(page.getByRole("button", { name: "AI 绘图" })).toHaveAttribute("aria-pressed", "true");
    await expect(prompt).toHaveAttribute("placeholder", "描述你想创作的内容，比如：");
    await page.getByRole("button", { name: "生成电影感的未来城市概念图" }).click();
    await expect(prompt).toHaveValue("生成电影感的未来城市概念图");
    await expect(page.getByLabel("创作模式").getByRole("button")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "智能模式" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "智能规划" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Agent 模式" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "AI 写作" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "AI 脚本" })).toHaveCount(0);

    await expect(page.getByRole("button", { name: "使用麦克风" })).toHaveCount(0);
    if (testInfo.project.name === "chromium") {
        await prompt.focus();
        expect(await prompt.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
        expect(await prompt.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
        expect(await prompt.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
        expect(await prompt.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

        const send = page.getByRole("button", { name: "开始创作" });
        await send.hover();
        const sendStyle = await send.evaluate((element) => ({
            backgroundImage: getComputedStyle(element).backgroundImage,
            borderRadius: getComputedStyle(element).borderRadius,
            boxShadow: getComputedStyle(element).boxShadow,
            color: getComputedStyle(element).color,
        }));
        expect(sendStyle.backgroundImage).toContain("linear-gradient");
        expect(sendStyle.borderRadius).toBe("50%");
        expect(sendStyle.boxShadow).toBe("none");
        expect(sendStyle.color).toBe("rgb(255, 255, 255)");
    }
    for (const action of ["开始创作", "进入创作页添加参考素材"]) {
        await page.getByRole("button", { name: action }).click();
        const dialog = page.getByRole("dialog");
        const closeButton = dialog.getByRole("button", { name: "Close" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "登录后回到刚才的位置" })).toBeVisible();
        await expect(dialog.getByText("登录后将继续刚才的创作操作，输入内容不会丢失。")).toHaveCount(0);
        await expect(closeButton).toBeVisible();
        await closeButton.click();
        await expect(dialog).toBeHidden();
    }

    await expect(page.getByRole("heading", { name: "简单四步，创意即刻落地" })).toBeVisible();
    for (const title of ["选择场景", "输入需求", "生成内容", "发布与分享"]) await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("heading", { name: "开启你的 AI 创作工作流" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "行业场景解决方案" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "产品" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "平台" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "解决方案" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "联系我们" })).toHaveCount(0);
    if (testInfo.project.name.startsWith("mobile-")) {
        const footerLayout = await mobileFooterDomState(page);
        expect(footerLayout.navigationCount).toBe(3);
        expect(footerLayout.navigationLeftSpread).toBeLessThanOrEqual(1);
        expect(footerLayout.navigationTops).toEqual([...footerLayout.navigationTops].sort((left, right) => left - right));
        expect(footerLayout.productFirstRowTopDelta).toBeLessThanOrEqual(1);
        expect(footerLayout.productSecondColumnOffset).toBeGreaterThan(120);
        expect(footerLayout.socialLogoTopDelta).toBeLessThanOrEqual(4);
        expect(footerLayout.firstPolicyLeft).toBeGreaterThan(footerLayout.footerCenter);
    }

    await expect(page.getByRole("tab", { name: "音频作品" })).toHaveCount(0);
    await page.getByRole("tab", { name: "视频", exact: true }).click();
    await expect(page.getByRole("tab", { name: "视频", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("home-public-gallery").locator("article")).toHaveCount(1);
    await page
        .getByTestId("home-gallery-card")
        .getByRole("button", { name: /查看作品/ })
        .click();
    const videoPreview = page.getByRole("dialog");
    await expect(videoPreview.locator("video")).toBeVisible();
    await videoPreview.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("tab", { name: "短剧", exact: true }).click();
    await expect(page.getByTestId("home-public-gallery").locator("article")).toHaveCount(2);
    const brandTab = page.getByRole("tab", { name: "品牌内容", exact: true });
    await brandTab.click();
    if (testInfo.project.name === "chromium") await brandTab.hover();
    await expect(brandTab).toHaveCSS("color", "rgb(255, 255, 255)");

    const beforeTheme = await homepageDomState(page);
    await page.getByRole("button", { name: "切换到深色主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    if (testInfo.project.name === "chromium") {
        const attach = page.getByRole("button", { name: "进入创作页添加参考素材" });
        const send = page.getByRole("button", { name: "开始创作" });
        const [attachStyle, sendStyle] = await Promise.all([
            attach.evaluate((element) => ({ backgroundImage: getComputedStyle(element).backgroundImage, borderColor: getComputedStyle(element).borderColor, color: getComputedStyle(element).color })),
            send.evaluate((element) => ({ backgroundImage: getComputedStyle(element).backgroundImage, color: getComputedStyle(element).color })),
        ]);
        expect(attachStyle.backgroundImage).toBe("none");
        expect(attachStyle.borderColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(attachStyle.color).not.toBe(sendStyle.color);
        expect(sendStyle.backgroundImage).toContain("linear-gradient");
        expect(sendStyle.color).toBe("rgb(255, 255, 255)");
    }
    expect(await homepageDomState(page)).toEqual(beforeTheme);
    await expectNoHorizontalOverflow(page);
    expect(browserErrors).toEqual([]);
    await context.close();
});

test("signed-in homepage restores the image prompt in the image-only create entry", async ({ page }, testInfo) => {
    await page.route("**/api/public/gallery?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(galleryResponse) }));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const createEntry = page.locator("header").getByRole("button", { name: "开始创作", exact: true });
    if (testInfo.project.name === "chromium") await expect(createEntry).toBeVisible();
    else await expect(createEntry).toHaveCount(0);
    await expect(page.locator("header").getByRole("button", { name: /用户|账号|头像/ })).toHaveCount(0);
    await page.getByRole("button", { name: "AI 绘图" }).click();
    await page.getByLabel("描述你想创作的内容").fill("已登录首页图片提示词");
    await page.getByTestId("home-agent-card").getByRole("button", { name: "开始创作" }).click();
    await expect(page).toHaveURL(/\/create(?:#.*)?$/);
    await expect(page.getByRole("button", { name: /当前创作类型：/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /生成模型：/ })).toBeVisible();
    await expect(page.locator("textarea").first()).toHaveValue("已登录首页图片提示词");
});

test("homepage gallery hides internal service errors from visitors", async ({ page }) => {
    await page.route("**/api/public/gallery?**", (route) =>
        route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ code: 409, data: null, msg: "作品广场需要启用 PostgreSQL 数据库" }),
        }),
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "作品暂时无法加载" })).toBeVisible();
    await expect(page.getByText("请稍后重试，或刷新页面后再试。")).toBeVisible();
    await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
    await expect(page.getByText(/PostgreSQL|数据库|部署/)).toHaveCount(0);
});

test("homepage hero stays centered and responsive", async ({ page }, testInfo) => {
    await page.route("**/api/public/gallery?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(galleryResponse) }));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const geometry = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const title = document.querySelector("h1")!.getBoundingClientRect();
        const subtitle = document.querySelector("h1 + p")!.getBoundingClientRect();
        const card = document.querySelector<HTMLElement>('[data-testid="home-agent-card"]')!.getBoundingClientRect();
        const halo = document.querySelector<HTMLElement>('[data-testid="home-agent-halo"]')!.getBoundingClientRect();
        const textarea = document.querySelector<HTMLElement>("#home-agent-prompt")!.getBoundingClientRect();
        const presetsElement = document.querySelector<HTMLElement>('[aria-label="示例提示词"]')!;
        const presets = presetsElement.getBoundingClientRect();
        const presetButtons = Array.from(presetsElement.querySelectorAll<HTMLButtonElement>("button"));
        const presetButtonRects = presetButtons.map((button) => button.getBoundingClientRect());
        const creationModesElement = document.querySelector<HTMLElement>('[aria-label="创作模式"]')!;
        const creationModes = creationModesElement.getBoundingClientRect();
        const toolbarElement = creationModesElement.parentElement!;
        const toolbar = toolbarElement.getBoundingClientRect();
        const send = document.querySelector<HTMLElement>('button[aria-label="开始创作"]')!.getBoundingClientRect();
        const mobileToolbarButtons = Array.from(toolbarElement.querySelectorAll<HTMLButtonElement>("button")).map((button) => button.getBoundingClientRect());
        const cardRadius = Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('[data-testid="home-agent-card"]')!).borderRadius);
        const rings = Array.from(document.querySelectorAll<HTMLElement>("[data-halo-ring]"));
        const decorations = Array.from(document.querySelectorAll<HTMLElement>("[data-hero-decoration]"));
        return {
            viewportWidth,
            titleCenterOffset: Math.abs(title.left + title.width / 2 - viewportWidth / 2),
            cardCenterOffset: Math.abs(card.left + card.width / 2 - viewportWidth / 2),
            cardWidth: card.width,
            cardHeight: card.height,
            cardRadius,
            haloCenterOffset: Math.abs(halo.left + halo.width / 2 - (card.left + card.width / 2)),
            haloWidthRatio: halo.width / card.width,
            haloTop: halo.top,
            cardBottom: card.bottom,
            textareaHeight: textarea.height,
            presetOffset: presets.top - textarea.bottom,
            presetButtonsInsideCard: presetButtonRects.every((button) => button.left >= card.left && button.right <= card.right && button.top >= card.top && button.bottom <= card.bottom),
            presetColumnCount: new Set(presetButtonRects.map((button) => Math.round(button.left))).size,
            presetRowCount: new Set(presetButtonRects.map((button) => Math.round(button.top))).size,
            presetsFitWithoutScroll: presetsElement.scrollWidth <= presetsElement.clientWidth + 1,
            visiblePresetCount: presetButtons.filter((button) => {
                const style = getComputedStyle(button);
                const bounds = button.getBoundingClientRect();
                return style.display !== "none" && bounds.width > 0 && bounds.height > 0 && Boolean(button.textContent?.trim());
            }).length,
            toolbarOffset: toolbar.top - presets.bottom,
            sendInset: card.right - send.right,
            sendVisible: send.width >= 42 && send.height >= 42,
            filledRingCount: rings.filter((ring) => getComputedStyle(ring).backgroundImage !== "none").length,
            borderOnlyRingCount: rings.filter((ring) => Number.parseFloat(getComputedStyle(ring).borderTopWidth) > 0 && getComputedStyle(ring).backgroundImage === "none").length,
            decorationCount: decorations.length,
            decorationSizeCount: new Set(
                decorations.map((decoration) => {
                    const bounds = decoration.getBoundingClientRect();
                    return `${Math.round(bounds.width)}x${Math.round(bounds.height)}`;
                }),
            ).size,
            polygonDecorationCount: decorations.filter((decoration) => getComputedStyle(decoration).clipPath !== "none").length,
            animatedDecorationCount: decorations.filter((decoration) => getComputedStyle(decoration).animationName !== "none").length,
            visibleDecorationCount: decorations.filter((decoration) => getComputedStyle(decoration).display !== "none").length,
            decorationSubtitleOverlapCount: decorations.filter((decoration) => getComputedStyle(decoration).display !== "none" && decoration.getBoundingClientRect().top < subtitle.bottom).length,
            mobileToolbarButtonCount: mobileToolbarButtons.length,
            mobileToolbarButtonsInsideCard: mobileToolbarButtons.every((button) => button.left >= card.left && button.right <= card.right && button.top >= card.top && button.bottom <= card.bottom),
            mobileToolbarRowSpread: Math.max(...mobileToolbarButtons.map((button) => button.top)) - Math.min(...mobileToolbarButtons.map((button) => button.top)),
            visibleModeLabelCount: Array.from(creationModesElement.querySelectorAll<HTMLElement>("span:last-child")).filter((label) => getComputedStyle(label).display !== "none").length,
            sequencedDecorationCount: decorations.filter((decoration) => getComputedStyle(decoration).animationName.includes("artifact-reveal") && getComputedStyle(decoration).animationName.includes("artifact-float")).length,
            shadowedDecorationCount: decorations.filter((decoration) => {
                const face = decoration.firstElementChild as HTMLElement | null;
                return getComputedStyle(decoration).boxShadow !== "none" || getComputedStyle(decoration, "::before").boxShadow !== "none" || (face ? getComputedStyle(face).boxShadow !== "none" : false);
            }).length,
            castShadowDecorationCount: decorations.filter((decoration) => getComputedStyle(decoration, "::after").content !== "none").length,
        };
    });
    expect(geometry.titleCenterOffset).toBeLessThanOrEqual(2);
    expect(geometry.cardCenterOffset).toBeLessThanOrEqual(2);
    expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.viewportWidth - (geometry.viewportWidth < 768 ? 24 : 48));
    if (testInfo.project.name === "chromium") {
        expect(geometry.cardWidth).toBeGreaterThanOrEqual(1080);
        expect(geometry.cardWidth).toBeLessThanOrEqual(1120);
        expect(geometry.cardHeight).toBeGreaterThanOrEqual(286);
        expect(geometry.cardHeight).toBeLessThanOrEqual(304);
        expect(geometry.cardRadius).toBeGreaterThanOrEqual(28);
        expect(geometry.cardRadius).toBeLessThanOrEqual(32);
        expect(geometry.haloCenterOffset).toBeLessThanOrEqual(1);
        expect(geometry.haloWidthRatio).toBeGreaterThan(1.16);
        expect(geometry.haloWidthRatio).toBeLessThan(1.2);
        expect(geometry.haloTop).toBeLessThan(geometry.cardBottom);
        expect(geometry.textareaHeight).toBeGreaterThanOrEqual(68);
        expect(geometry.presetOffset).toBe(0);
        expect(geometry.toolbarOffset).toBeGreaterThanOrEqual(18);
        expect(geometry.toolbarOffset).toBeLessThanOrEqual(26);
        expect(geometry.sendInset).toBeGreaterThanOrEqual(34);
        expect(geometry.filledRingCount).toBe(4);
        expect(geometry.borderOnlyRingCount).toBe(0);
        expect(geometry.decorationCount).toBe(4);
        expect(geometry.decorationSizeCount).toBe(4);
        expect(geometry.polygonDecorationCount).toBe(0);
        expect(geometry.animatedDecorationCount).toBe(4);
        expect(geometry.sequencedDecorationCount).toBe(4);
        expect(geometry.shadowedDecorationCount).toBe(0);
        expect(geometry.castShadowDecorationCount).toBe(0);
    }
    if (testInfo.project.name.startsWith("mobile-")) {
        expect(geometry.visiblePresetCount).toBe(4);
        expect(geometry.presetButtonsInsideCard).toBe(true);
        expect(geometry.presetColumnCount).toBe(2);
        expect(geometry.presetRowCount).toBe(2);
        expect(geometry.presetsFitWithoutScroll).toBe(true);
        expect(geometry.visibleDecorationCount).toBe(4);
        expect(geometry.decorationSubtitleOverlapCount).toBe(0);
        expect(geometry.mobileToolbarButtonCount).toBe(6);
        expect(geometry.mobileToolbarButtonsInsideCard).toBe(true);
        expect(geometry.mobileToolbarRowSpread).toBeLessThanOrEqual(3);
        expect(geometry.visibleModeLabelCount).toBe(0);
    }
    expect(geometry.sendVisible).toBe(true);
    await expectNoHorizontalOverflow(page);
});

function galleryItem(index: number, mediaType: "image" | "video", sourceType: "media" | "canvas" | "drama", category: string) {
    return {
        slug: `home-e2e-${index}`,
        sourceType,
        viewCount: index * 10,
        likeCount: index * 3,
        isFeatured: false,
        publishedAt: "2026-08-05T00:00:00.000Z",
        title: `首页公开作品 ${index}`,
        description: "公开作品测试数据",
        publicPrompt: `public fixture ${index}`,
        category,
        tags: [],
        authorName: "公开创作者",
        preview: {
            id: `home-preview-${index}`,
            mediaType,
            mimeType: mediaType === "video" ? "video/mp4" : "image/svg+xml",
            url: mediaType === "video" ? "data:video/mp4;base64," : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="hsl(${index * 48} 58% 62%)"/></svg>`)}`,
        },
    };
}

function collectBrowserErrors(page: Page) {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
    });
    return errors;
}

async function homepageDomState(page: Page) {
    return page.evaluate(() => ({
        mains: document.querySelectorAll("main").length,
        heroes: document.querySelectorAll("h1").length,
        agentCards: document.querySelectorAll('[data-testid="home-agent-card"]').length,
    }));
}

async function mobileFooterDomState(page: Page) {
    return page.evaluate(() => {
        const footer = document.querySelector<HTMLElement>("footer")!;
        const navigations = Array.from(footer.querySelectorAll<HTMLElement>("nav"));
        const navigationRects = navigations.map((navigation) => navigation.getBoundingClientRect());
        const productItems = Array.from(navigations[0].querySelectorAll<HTMLElement>("a, button")).map((item) => item.getBoundingClientRect());
        const social = footer.querySelector<HTMLElement>('a[aria-label="邮箱联系"]');
        const footerLogo = footer.querySelector<HTMLElement>('a[href="/"]');
        const firstPolicy = footer.querySelector<HTMLElement>('[data-testid="home-footer-bottom"] a');
        const footerRect = footer.getBoundingClientRect();
        return {
            navigationCount: navigations.length,
            navigationLeftSpread: Math.max(...navigationRects.map((rect) => rect.left)) - Math.min(...navigationRects.map((rect) => rect.left)),
            navigationTops: navigationRects.map((rect) => Math.round(rect.top)),
            productFirstRowTopDelta: Math.abs(productItems[0].top - productItems[1].top),
            productSecondColumnOffset: productItems[1].left - productItems[0].left,
            socialLogoTopDelta: social && footerLogo ? Math.abs(social.getBoundingClientRect().top - footerLogo.getBoundingClientRect().top) : Number.POSITIVE_INFINITY,
            firstPolicyLeft: firstPolicy?.getBoundingClientRect().left || 0,
            footerCenter: footerRect.left + footerRect.width / 2,
        };
    });
}

async function expectNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("main.app-scroll-page");
        const rootBounds = root?.getBoundingClientRect();
        const offenders = rootBounds
            ? Array.from(root.querySelectorAll<HTMLElement>("*")).flatMap((element) => {
                  const bounds = element.getBoundingClientRect();
                  if (bounds.width <= 0 || (bounds.left >= rootBounds.left - 1 && bounds.right <= rootBounds.right + 1)) return [];
                  let parent = element.parentElement;
                  while (parent && parent !== root) {
                      const overflowX = getComputedStyle(parent).overflowX;
                      if (overflowX === "hidden" || overflowX === "clip" || overflowX === "auto" || overflowX === "scroll") return [];
                      parent = parent.parentElement;
                  }
                  return [{ tag: element.tagName, className: element.className, left: Math.round(bounds.left), right: Math.round(bounds.right), width: Math.round(bounds.width) }];
              })
            : [];
        return {
            document: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
            body: [document.body.clientWidth, document.body.scrollWidth],
            root: root ? [root.clientWidth, root.scrollWidth] : [0, 1],
            offenders,
        };
    });
    for (const [label, widths] of Object.entries(overflow)) {
        if (label === "offenders") continue;
        const [clientWidth, scrollWidth] = widths as number[];
        expect(scrollWidth, `${label} horizontal overflow: ${JSON.stringify(overflow.offenders)}`).toBeLessThanOrEqual(clientWidth + 1);
    }
}

async function centerOffset(left: Locator, right: Locator) {
    const [leftBox, rightBox] = await Promise.all([left.boundingBox(), right.boundingBox()]);
    if (!leftBox || !rightBox) return Number.POSITIVE_INFINITY;
    return Math.abs(leftBox.x + leftBox.width / 2 - (rightBox.x + rightBox.width / 2));
}
