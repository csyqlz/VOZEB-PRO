import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";

import { ADMIN_SECTION_KEYS } from "../src/components/admin/admin-sections";
import { expectNoHorizontalOverflow, expectVisibleControlsWithinViewport } from "./responsive-helpers";
import { E2E_ADMIN } from "./support";

const PROFILE_SECTIONS = ["overview", "profile", "billing", "coupons", "orders", "points", "consume", "referrals", "security"] as const;
const BASE_URL = `http://127.0.0.1:${Number(process.env.VOZEB_PRO_E2E_PORT || 3100)}`;
const USES_POSTGRES = Boolean(process.env.VOZEB_PRO_E2E_DATABASE_URL?.trim());
const FILE_PROVIDER_LIMITATIONS = new Map([
    ["/api/public/gallery", 409],
    ["/api/notifications/interactions", 409],
    ["/api/admin/referrals", 501],
]);

type RouteCase = { path: string; expectedPath?: RegExp; expectedStatus?: number; readyHeading?: string; readyText?: string };
type ApiFailure = { path: string; status: number; body: string };

test("all authenticated pages reach their real routes and stay usable", async ({ page, request }, testInfo) => {
    test.setTimeout(360_000);
    const fixtures = await createPageFixtures(request, testInfo.project.use.viewport?.width || 1280);
    const routes: RouteCase[] = [
        { path: "/", readyHeading: "一个入口 完成所有 AI 创作" },
        { path: "/gallery", readyHeading: "灵感发现" },
        { path: "/community", readyHeading: "灵感发现" },
        { path: "/announcements", readyHeading: "网站公告" },
        { path: "/create" },
        { path: "/image", expectedPath: /\/create$/ },
        { path: "/video", expectedPath: /\/create$/ },
        { path: "/canvas", readyHeading: "我的画布" },
        { path: `/canvas/${fixtures.canvasId}` },
        { path: "/drama", readyHeading: "短剧项目" },
        { path: `/drama/${fixtures.dramaId}` },
        { path: "/works", readyHeading: "作品管理" },
        { path: "/assets", readyHeading: "我的素材" },
        { path: "/my-prompts", readyHeading: "我的提示词" },
        { path: "/prompts", readyHeading: "提示词库" },
        { path: "/help", readyHeading: "从操作到交付，按真实流程完成创作" },
        { path: "/me", readyHeading: "E2E 管理员" },
        USES_POSTGRES ? { path: `/u/${E2E_ADMIN.username}`, expectedStatus: 404, readyText: "404" } : { path: `/u/${E2E_ADMIN.username}`, readyHeading: "创作者主页暂不可用" },
        { path: "/billing", expectedPath: /\/profile\?section=billing$/ },
        { path: "/billing/checkout", readyText: "套餐不存在或已下架" },
        { path: "/billing/success", readyText: "支付结果缺少订单编号" },
        { path: "/billing/cancel", readyText: "支付结果缺少订单编号" },
        { path: "/admin/setup", readyHeading: "把站点配置到可以上线运营" },
        { path: "/admin/billing", readyHeading: "财务钱包" },
        { path: "/admin/generation-operations", expectedPath: /\/admin\?section=generationOperations$/ },
        ...PROFILE_SECTIONS.map((section) => ({ path: `/profile?section=${section}` })),
    ];
    const themes = testInfo.project.name === "chromium" ? (["light", "dark"] as const) : ([testInfo.project.name === "mobile-430" ? "dark" : "light"] as const);

    for (const theme of themes) {
        await setTheme(page, theme);
        for (const route of routes) await verifyRoute(page, route, `${testInfo.project.name} ${theme}`);
    }
});

test("every administrator section renders its server-backed surface", async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    const theme = testInfo.project.name === "mobile-430" ? "dark" : "light";
    await setTheme(page, theme);
    for (const section of ADMIN_SECTION_KEYS) {
        await verifyRoute(page, { path: section === "overview" ? "/admin" : `/admin?section=${section}` }, `${testInfo.project.name} admin ${section}`);
        await expect(page.locator("[data-hydrated='true']")).toBeVisible();
        await expect(page.locator("h1")).toHaveCount(1);
        await expect(page.locator("h1").first()).toHaveClass(/sr-only/);
        await expect(page.getByText("正在加载分区...", { exact: true })).toHaveCount(0);
        await expectAdminShellHierarchy(page, `${testInfo.project.name} admin ${section}`);
        if (!USES_POSTGRES && ["orders", "products", "promotions", "coupons"].includes(section)) {
            await expect(page.getByText("商业运营需要启用 PostgreSQL", { exact: true })).toHaveCount(1);
        }
    }
});

test("signed-out, legal, installation and invalid public detail routes fail safely", async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: testInfo.project.use.viewport || undefined, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
        const theme = testInfo.project.name === "mobile-430" ? "dark" : "light";
        await page.addInitScript((nextTheme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
        const routes: RouteCase[] = [
            { path: "/", readyHeading: "一个入口 完成所有 AI 创作" },
            { path: "/login", readyHeading: "登录 VOZEB PRO" },
            { path: "/register", readyHeading: "注册 VOZEB PRO" },
            { path: "/forgot-password", readyHeading: "重置密码" },
            { path: "/privacy", readyHeading: "隐私政策" },
            { path: "/terms", readyHeading: "服务条款" },
            { path: "/gallery", readyHeading: "灵感发现" },
            { path: "/announcements", readyHeading: "网站公告" },
            USES_POSTGRES ? { path: `/u/${E2E_ADMIN.username}`, expectedStatus: 404, readyText: "404" } : { path: `/u/${E2E_ADMIN.username}`, readyHeading: "创作者主页暂不可用" },
            { path: "/share/not-a-real-public-work", expectedStatus: USES_POSTGRES ? 404 : 200, readyText: USES_POSTGRES ? "404" : "作品分享暂不可用" },
            { path: "/install", expectedPath: /\/$/ },
        ];
        for (const route of routes) await verifyRoute(page, route, `${testInfo.project.name} signed-out`);
    } finally {
        await context.close();
    }
});

async function createPageFixtures(request: APIRequestContext, viewportWidth: number) {
    const suffix = randomUUID().slice(0, 8);
    const nodeX = 120;
    const nodeWidth = 280;
    const viewportX = Math.round((viewportWidth - nodeWidth) / 2 - nodeX);
    const canvas = await request.post("/api/canvas/projects", {
        data: {
            title: `全页面回归画布 ${suffix}`,
            project: {
                viewport: { x: viewportX, y: 120, k: 1 },
                nodes: [{ id: `text-${suffix}`, type: "text", title: "页面回归节点", position: { x: nodeX, y: 120 }, width: nodeWidth, height: 180, metadata: { content: "服务端画布记录" } }],
                connections: [],
            },
        },
    });
    expect(canvas.ok(), await canvas.text()).toBe(true);
    const canvasPayload = (await canvas.json()) as { data: { project: { id: string } } };

    const drama = await request.post("/api/drama/projects", { data: { title: `全页面回归短剧 ${suffix}`, summary: "验证服务端项目读取与移动布局", ratio: "9:16" } });
    expect(drama.ok(), await drama.text()).toBe(true);
    const dramaPayload = (await drama.json()) as { data: { project: { id: string } } };
    return { canvasId: canvasPayload.data.project.id, dramaId: dramaPayload.data.project.id };
}

async function expectAdminShellHierarchy(page: Page, label: string) {
    const metrics = await page.evaluate(() => {
        const style = (selector: string) => {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) return null;
            const computed = getComputedStyle(element);
            return { fontSize: Number.parseFloat(computed.fontSize), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
        };
        return {
            desktop: matchMedia("(min-width: 1024px)").matches,
            brand: style(".admin-section-brand-copy > span:first-child"),
            logo: style(".admin-section-brand > :first-child"),
            group: style(".admin-section-nav-group-title"),
            item: style(".admin-section-nav-item"),
        };
    });
    if (!metrics.desktop) return;
    expect(metrics.brand?.fontSize, `${label} brand title`).toBeGreaterThanOrEqual(16);
    expect(metrics.logo?.width, `${label} brand logo`).toBeGreaterThanOrEqual(32);
    expect(metrics.logo?.height, `${label} brand logo`).toBeGreaterThanOrEqual(32);
    expect(metrics.group?.fontSize, `${label} navigation group`).toBeGreaterThanOrEqual(13);
    expect(metrics.item?.fontSize, `${label} navigation item`).toBeGreaterThanOrEqual(15);
    expect(metrics.item?.height, `${label} navigation item height`).toBeGreaterThanOrEqual(40);
}

async function setTheme(page: Page, theme: "light" | "dark") {
    if (page.url() === "about:blank") await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate((nextTheme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: nextTheme }, version: 0 })), theme);
}

async function verifyRoute(page: Page, route: RouteCase, label: string) {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const apiFailures: ApiFailure[] = [];
    const apiFailureReads: Promise<void>[] = [];
    const onPageError = (error: Error) => pageErrors.push(error.message);
    const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === "error") consoleErrors.push(message.text());
    };
    const onResponse = (response: Response) => {
        const url = new URL(response.url());
        if (url.origin !== BASE_URL || !url.pathname.startsWith("/api/") || response.status() < 400) return;
        apiFailureReads.push(
            response
                .text()
                .then((body) => apiFailures.push({ status: response.status(), path: url.pathname, body }))
                .catch(() => apiFailures.push({ status: response.status(), path: url.pathname, body: "<unreadable>" })),
        );
    };
    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    page.on("response", onResponse);
    try {
        const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
        if (route.expectedStatus !== undefined) expect(response?.status()).toBe(route.expectedStatus);
        else if (route.path.startsWith("/share/")) expect(response?.status()).toBe(404);
        else expect(response?.status() || 200, `${label} ${route.path} document status`).toBeLessThan(500);
        await expect(page.locator("main").first()).toBeVisible();
        const browserIconHref = await page.locator('link[rel="icon"]').getAttribute("href");
        expect(browserIconHref, `${label} ${route.path} browser icon href`).toBeTruthy();
        expect(browserIconHref, `${label} ${route.path} browser icon must not depend on a redirect`).not.toContain("/api/site-icon");
        if (route.expectedPath) await expect(page).toHaveURL(route.expectedPath);
        if (route.readyHeading) await expect(page.getByRole("heading", { name: route.readyHeading, exact: true })).toBeVisible();
        if (route.readyText) await expect(page.getByText(route.readyText, { exact: true }).first()).toBeVisible();
        await expect(page.locator("body")).not.toContainText("Application error");
        await expect(page.locator("body")).not.toContainText("Internal Server Error");
        await expectNoHorizontalOverflow(page, `${label} ${route.path}`);
        await expectVisibleControlsWithinViewport(page, `${label} ${route.path}`);
        await Promise.all(apiFailureReads);
        const expectedLimitations = apiFailures.filter(isExpectedFileProviderLimitation);
        const unexpectedApiFailures = apiFailures.filter((failure) => !isExpectedFileProviderLimitation(failure));
        expect(pageErrors, `${label} ${route.path} page errors`).toEqual([]);
        expect(unexpectedApiFailures, `${label} ${route.path} API failures`).toEqual([]);
        expect(withoutExpectedResourceErrors(consoleErrors, expectedLimitations, route.expectedStatus), `${label} ${route.path} console errors; API responses: ${JSON.stringify(apiFailures)}`).toEqual([]);
    } finally {
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
        page.off("response", onResponse);
    }
}

function isExpectedFileProviderLimitation(failure: ApiFailure) {
    if (failure.status === 404 && failure.path === `/api/public/users/${E2E_ADMIN.username}`) return failure.body.includes("创作者主页不存在");
    if (!USES_POSTGRES && failure.path.startsWith("/api/admin/billing/")) return false;
    if (USES_POSTGRES || (failure.status !== 409 && failure.status !== 501)) return false;
    return failure.body.includes("需要启用 PostgreSQL") || FILE_PROVIDER_LIMITATIONS.get(failure.path) === failure.status;
}

function withoutExpectedResourceErrors(consoleErrors: string[], expectedLimitations: ApiFailure[], expectedDocumentStatus?: number) {
    const remainingByStatus = new Map<number, number>();
    for (const failure of expectedLimitations) remainingByStatus.set(failure.status, (remainingByStatus.get(failure.status) || 0) + 1);
    if (expectedDocumentStatus && expectedDocumentStatus >= 400) remainingByStatus.set(expectedDocumentStatus, (remainingByStatus.get(expectedDocumentStatus) || 0) + 1);
    return consoleErrors.filter((message) => {
        const match = message.match(/^Failed to load resource: the server responded with a status of (\d+)/);
        const status = Number(match?.[1]);
        const remaining = remainingByStatus.get(status) || 0;
        if (!remaining) return true;
        remainingByStatus.set(status, remaining - 1);
        return false;
    });
}
