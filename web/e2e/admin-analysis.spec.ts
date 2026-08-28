import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, expectVisibleControlsWithinViewport } from "./responsive-helpers";

test("admin analysis keeps a dense data-first layout across viewports", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "light" }, version: 0 }));
    });
    await page.goto("/admin", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "实收金额" })).toBeVisible();
    await expect(page.locator("[data-admin-analysis-panel]")).toBeVisible();
    await expect(page.locator("[data-admin-analysis-bar]")).toHaveCount(7);

    const layout = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>(".admin-analysis-metric-card")].map((card) => {
            const rect = card.getBoundingClientRect();
            return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) };
        });
        const panel = document.querySelector<HTMLElement>("[data-admin-analysis-panel]")?.getBoundingClientRect();
        const pageRoot = document.querySelector<HTMLElement>(".admin-console-page");
        const firstCard = document.querySelector<HTMLElement>(".admin-analysis-metric-card");
        return {
            cards,
            panel: panel ? { left: Math.round(panel.left), right: Math.round(panel.right), top: Math.round(panel.top), width: Math.round(panel.width) } : null,
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            pageBackground: pageRoot ? getComputedStyle(pageRoot).backgroundColor : null,
            cardBackground: firstCard ? getComputedStyle(firstCard).backgroundColor : null,
        };
    });

    expect(layout.cards).toHaveLength(4);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.panel?.left).toBeGreaterThanOrEqual(0);
    expect(layout.panel?.right).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.pageBackground).not.toBe(layout.cardBackground);

    const mobile = testInfo.project.name.startsWith("mobile-");
    if (mobile) {
        expect(layout.cards[0]?.top).toBe(layout.cards[1]?.top);
        expect(layout.cards[2]?.top).toBe(layout.cards[3]?.top);
        expect(layout.cards[2]!.top).toBeGreaterThan(layout.cards[0]!.top);
        expect(layout.cards.every((card) => card.width >= 150 && card.right <= layout.clientWidth)).toBe(true);
    } else {
        expect(new Set(layout.cards.map((card) => card.top)).size).toBe(1);
        expect(layout.cards.map((card) => card.left)).toEqual([...layout.cards.map((card) => card.left)].sort((left, right) => left - right));
        expect(Math.max(...layout.cards.map((card) => card.height)) - Math.min(...layout.cards.map((card) => card.height))).toBeLessThanOrEqual(1);
    }

    await page.getByText("生成类型", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "生成类型分布" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("admin-analysis.png"), fullPage: false });
});

test("admin operations pages keep one clear SaaS hierarchy across viewports", async ({ page }, testInfo) => {
    const theme = testInfo.project.name === "mobile-430" ? "dark" : "light";
    await page.addInitScript((nextTheme) => {
        localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 }));
    }, theme);

    const surfaces = [
        { section: "externalStorage", heading: "外部存储" },
        { section: "works", heading: "作品管理" },
        { section: "logs", heading: "调用记录" },
        { section: "generationOperations", heading: "生成运维" },
        { section: "users", heading: "用户管理" },
        { section: "wallet", heading: "财务流水" },
    ] as const;

    for (const surface of surfaces) {
        await page.goto(`/admin?section=${surface.section}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-hydrated='true']")).toBeVisible();
        const pagePanel = page.locator(".admin-page-panel");
        await expect(pagePanel).toHaveCount(1);
        if (surface.section === "generationOperations" && testInfo.project.name === "chromium") {
            await expect(page.getByRole("heading", { name: "运行概览", exact: true })).toBeVisible();
        } else if (surface.section === "logs" && testInfo.project.name === "chromium") {
            await expect(page.getByTestId("admin-log-list-surface")).toBeVisible();
        } else {
            await expect(pagePanel.getByRole("heading", { name: surface.heading, exact: true })).toBeVisible();
        }
        await expectNoHorizontalOverflow(page, `${testInfo.project.name} ${surface.section}`);
        await expectVisibleControlsWithinViewport(page, `${testInfo.project.name} ${surface.section}`);

        const bounds = await page.locator(".admin-page-panel").evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, viewportWidth: document.documentElement.clientWidth };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(-1);
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);

        if (surface.section === "works") {
            await page.getByText("举报申诉", { exact: true }).last().click();
            await expect(page.getByPlaceholder("搜索作品标题、作者、提交人、用户 ID 或作品链接")).toBeVisible();
            await expect(pagePanel.getByRole("heading", { name: "作品管理", exact: true })).toHaveCount(1);
            await expectNoHorizontalOverflow(page, `${testInfo.project.name} works governance`);
        }

        if (surface.section === "generationOperations") {
            await expect(page.getByRole("columnheader", { name: "操作", exact: true })).toHaveCount(0);
            const filterLayout = await page.getByTestId("generation-task-filters").evaluate((element) => {
                const controls = [...element.children].map((child) => child.getBoundingClientRect());
                return { searchWidth: controls[0]?.width || 0, heights: controls.map((control) => control.height), viewportWidth: document.documentElement.clientWidth };
            });
            if (testInfo.project.name === "chromium") expect(filterLayout.searchWidth).toBeLessThanOrEqual(421);
            expect(Math.max(...filterLayout.heights) - Math.min(...filterLayout.heights)).toBeLessThanOrEqual(1);
            const sectionTops = await page.locator("#generation-runtime-summary-title, #generation-task-queue-title, #generation-channel-status-title").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
            expect(sectionTops).toHaveLength(3);
            expect(sectionTops[0]).toBeLessThan(sectionTops[1]);
            expect(sectionTops[1]).toBeLessThan(sectionTops[2]);
        }

        if (surface.section === "logs") {
            const logLayout = await page.getByTestId("admin-log-list-surface").evaluate((element) => {
                const surfaceRect = element.getBoundingClientRect();
                const searchRect = element.querySelector<HTMLElement>("input[placeholder='搜索日志']")?.closest<HTMLElement>(".ant-input-affix-wrapper")?.getBoundingClientRect();
                const tableContent = element.querySelector<HTMLElement>(".ant-table-content");
                return {
                    surface: { left: surfaceRect.left, right: surfaceRect.right, radius: getComputedStyle(element).borderRadius, borderWidth: getComputedStyle(element).borderTopWidth },
                    searchWidth: searchRect?.width || 0,
                    tableClientWidth: tableContent?.clientWidth || 0,
                    tableScrollWidth: tableContent?.scrollWidth || 0,
                    viewportWidth: document.documentElement.clientWidth,
                };
            });
            expect(logLayout.surface.left).toBeGreaterThanOrEqual(-1);
            expect(logLayout.surface.right).toBeLessThanOrEqual(logLayout.viewportWidth + 1);
            expect(logLayout.surface.borderWidth).not.toBe("0px");
            expect(logLayout.surface.radius).not.toBe("0px");
            if (testInfo.project.name === "chromium") {
                expect(logLayout.searchWidth).toBeLessThanOrEqual(321);
                expect(logLayout.tableScrollWidth).toBeLessThanOrEqual(logLayout.tableClientWidth + 1);
            }
        }
    }
});

test("admin navigation keeps storage and maintenance as independent groups", async ({ page }, testInfo) => {
    const theme = testInfo.project.name === "mobile-430" ? "dark" : "light";
    await page.addInitScript((nextTheme) => {
        localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 }));
    }, theme);
    await page.goto("/admin?section=externalStorage", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-hydrated='true']")).toBeVisible();

    if (testInfo.project.name.startsWith("mobile-")) await page.getByRole("button", { name: "展开后台侧边栏" }).click();

    const navigation = page.locator(".admin-section-nav");
    await expect(navigation).toBeVisible();
    await expect(navigation.locator(".admin-section-nav-group-title")).toHaveText(["经营分析", "商品运营", "财务管理", "上游配置", "系统管理", "存储与数据", "系统维护", "内容运营"]);

    const storageGroup = navigation.getByRole("button", { name: "存储与数据", exact: true });
    const maintenanceGroup = navigation.getByRole("button", { name: "系统维护", exact: true });
    await expect(storageGroup).toHaveAttribute("aria-expanded", "true");
    await expect(maintenanceGroup).toHaveAttribute("aria-expanded", "false");
    await expect(navigation.getByRole("button", { name: "本地媒体", exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "外部存储", exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "数据备份", exact: true })).toBeVisible();

    await maintenanceGroup.click();
    await expect(storageGroup).toHaveAttribute("aria-expanded", "false");
    await expect(maintenanceGroup).toHaveAttribute("aria-expanded", "true");
    await expect(navigation.getByRole("button", { name: "版本更新", exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "注销申请", exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "使用文档", exact: true })).toBeVisible();

    const bounds = await navigation.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewportWidth: document.documentElement.clientWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} admin navigation`);
});

test("module center keeps a dense operational layout and disables every access layer", async ({ page, request }, testInfo) => {
    const theme = testInfo.project.name === "mobile-430" ? "dark" : "light";
    await page.addInitScript((nextTheme) => {
        localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 }));
    }, theme);
    await page.goto("/admin?section=modules", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "系统功能", exact: true })).toBeVisible();
    await expect(page.getByText("注册能力", { exact: true })).toBeVisible();
    await expect(page.getByText("安全层级", { exact: true })).toHaveCount(0);
    const list = page.getByTestId("admin-module-list");
    await expect(list).toBeVisible();
    await expect(list.locator("[data-module-id]")).toHaveCount(5);

    const layout = await list.evaluate((element) => {
        const bounds = (target: Element) => {
            const rect = target.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        return {
            list: bounds(element),
            rows: [...element.querySelectorAll("[data-module-id]")].map(bounds),
            headerDisplay: getComputedStyle(element.firstElementChild as Element).display,
            viewportWidth: document.documentElement.clientWidth,
        };
    });
    expect(layout.list.left).toBeGreaterThanOrEqual(-1);
    expect(layout.list.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.rows.every((row) => row.left >= -1 && row.right <= layout.viewportWidth + 1 && row.width > 0 && row.height > 0)).toBe(true);
    expect(layout.headerDisplay === "grid").toBe(testInfo.project.name === "chromium");
    await expectNoHorizontalOverflow(page, `${testInfo.project.name} modules`);
    await expectVisibleControlsWithinViewport(page, `${testInfo.project.name} modules`);

    await page.getByRole("button", { name: "诊断", exact: true }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("能力标识", { exact: true })).toBeVisible();
    await expect(drawer.getByText("停用影响", { exact: true })).toBeVisible();
    await expect
        .poll(async () =>
            drawer.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1;
            }),
        )
        .toBe(true);
    await drawer.locator(".ant-drawer-close").click();

    const modulesResponse = await request.get("/api/admin/modules");
    expect(modulesResponse.ok(), await modulesResponse.text()).toBe(true);
    const modules = ((await modulesResponse.json()) as { data: { modules: Array<{ id: string; enabled: boolean; revision: number }> } }).data.modules;
    const drama = modules.find((module) => module.id === "drama");
    expect(drama).toBeDefined();

    try {
        const disabledResponse = await request.patch("/api/admin/modules", {
            data: { moduleId: "drama", enabled: false, baseRevision: drama!.revision, mutationId: randomUUID() },
        });
        expect(disabledResponse.ok(), await disabledResponse.text()).toBe(true);

        await page.goto("/assets", { waitUntil: "domcontentloaded" });
        if (testInfo.project.name.startsWith("mobile-")) await page.getByRole("button", { name: "打开导航菜单" }).click();
        await expect(page.getByRole("link", { name: "短剧", exact: true })).toHaveCount(0);

        const routeResponse = await request.get("/drama");
        expect(routeResponse.status()).toBe(404);

        const serviceResponse = await request.get("/api/drama/projects");
        expect(serviceResponse.status()).toBe(403);
        expect(await serviceResponse.json()).toMatchObject({ msg: "短剧系统模块已停用" });

        const capabilityResponse = await request.post("/api/drama/analyze", { data: {} });
        expect(capabilityResponse.status()).toBe(403);
        expect(await capabilityResponse.json()).toMatchObject({ msg: "短剧系统模块已停用" });
    } finally {
        const latestResponse = await request.get("/api/admin/modules");
        const latest = ((await latestResponse.json()) as { data: { modules: Array<{ id: string; enabled: boolean; revision: number }> } }).data.modules.find((module) => module.id === "drama");
        if (latest && latest.enabled !== drama!.enabled) {
            const restoredResponse = await request.patch("/api/admin/modules", {
                data: { moduleId: "drama", enabled: drama!.enabled, baseRevision: latest.revision, mutationId: randomUUID() },
            });
            expect(restoredResponse.ok(), await restoredResponse.text()).toBe(true);
        }
    }
});
