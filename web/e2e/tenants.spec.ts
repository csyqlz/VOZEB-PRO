import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("platform creates a tenant and its owner manages an isolated team console", async ({ browser, page, request }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/[^a-z0-9-]/gi, "").toLowerCase();
    const ownerUsername = `owner_${suffix}`.slice(0, 32);
    const memberUsername = `member_${suffix}`.slice(0, 32);
    const ownerPassword = "TenantOwner!2026";
    const memberPassword = "TenantMember!2026";
    const tenantName = `端到端租户 ${testInfo.project.name}`;
    const slug = `e2e-${suffix}`.slice(0, 64).replace(/-$/, "0");

    const createdResponse = await request.post("/api/admin/tenants", {
        data: {
            name: tenantName,
            slug,
            owner: { username: ownerUsername, displayName: `租户所有者 ${testInfo.project.name}`, password: ownerPassword },
        },
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);

    if ((testInfo.project.use.viewport?.width || 1440) >= 768) {
        await page.goto("/admin");
        await page.getByText("租户管理", { exact: true }).first().click();
        await expect(page.getByText(tenantName, { exact: true }).first()).toBeVisible();
    }

    const ownerContext = await browser.newContext({
        baseURL: String(testInfo.project.use.baseURL),
        viewport: testInfo.project.use.viewport || { width: 1440, height: 900 },
    });
    const browserErrors: string[] = [];
    const ownerPage = await ownerContext.newPage();
    ownerPage.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });
    ownerPage.on("requestfailed", (request) => {
        const failure = request.failure()?.errorText || "failed";
        if (failure.includes("ERR_ABORTED") && request.url().includes("_rsc=")) return;
        browserErrors.push(`request: ${request.url()} ${failure}`);
    });

    const ownerLogin = await ownerContext.request.post("/api/auth/login", { data: { username: ownerUsername, password: ownerPassword } });
    expect(ownerLogin.ok(), await ownerLogin.text()).toBe(true);
    await ownerPage.goto("/team", { waitUntil: "networkidle" });

    await expect(ownerPage.getByText("团队控制台", { exact: true })).toBeVisible();
    await expect(ownerPage.getByRole("heading", { name: tenantName })).toBeVisible();
    await expect(ownerPage.getByText("当前角色：所有者", { exact: true })).toBeVisible();
    await expect(ownerPage.getByText("活跃成员", { exact: true })).toBeVisible();

    await ownerPage.getByRole("tab", { name: "成员" }).click();
    await ownerPage.getByRole("button", { name: /创建成员/ }).click();
    await ownerPage.getByLabel("用户名").fill(memberUsername);
    await ownerPage.getByLabel("昵称").fill(`普通成员 ${testInfo.project.name}`);
    await ownerPage.getByLabel("初始密码").fill(memberPassword);
    await ownerPage.locator(".ant-modal-footer button.ant-btn-primary").click();
    await expect(ownerPage.getByText("成员创建成功", { exact: true })).toBeVisible();
    await expect(ownerPage.getByText(`@${memberUsername}`, { exact: false })).toBeVisible();

    const memberContext = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL) });
    const memberLogin = await memberContext.request.post("/api/auth/login", { data: { username: memberUsername, password: memberPassword } });
    expect(memberLogin.ok(), await memberLogin.text()).toBe(true);
    const forbiddenTeam = await memberContext.request.get("/api/team/overview?tenantId=another-tenant");
    expect(forbiddenTeam.status()).toBe(403);

    const memberRow = ownerPage.locator(".ant-table-tbody tr").filter({ hasText: memberUsername }).last();
    await memberRow.locator("button").click();
    await expect(ownerPage.getByText("成员已更新", { exact: true })).toBeVisible();
    await expect(memberRow.getByText("已禁用", { exact: true })).toBeVisible();
    expect((await memberContext.request.get("/api/team/overview")).status()).toBe(401);
    const disabledContext = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL) });
    const disabledLogin = await disabledContext.request.post("/api/auth/login", { data: { username: memberUsername, password: memberPassword } });
    expect(disabledLogin.status()).toBe(400);
    await expect(disabledLogin.json()).resolves.toMatchObject({ error: "账号已被租户禁用" });

    await ownerPage.getByRole("tab", { name: "审计" }).click();
    await expect(ownerPage.getByText("tenant.member.create", { exact: true })).toBeVisible();
    await expect(ownerPage.getByText("tenant.member.status", { exact: true })).toBeVisible();
    await expect(ownerPage.getByText("platform.tenant.create", { exact: true })).toHaveCount(0);
    const overflow = await ownerPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);

    await memberContext.close();
    await disabledContext.close();
    await ownerContext.close();
});
