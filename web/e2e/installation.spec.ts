import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { E2E_ADMIN, e2eSettingsPatch } from "./support";

test.describe.configure({ mode: "serial" });

test("fresh deployments enter the installation flow", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/install(?:\?|$)/);
    await expect(page.getByRole("link", { name: /安装向导/ })).toBeVisible();
    await expect(page.getByText("三步完成服务器初始化", { exact: true })).toBeVisible();
    await expect(page.locator('img[src="/sub2-logo.png"]').first()).toBeVisible();
});

test("public session omits internal configuration fields", async ({ request }) => {
    const response = await request.get("/api/auth/session");
    expect(response.ok()).toBe(true);

    const payload = (await response.json()) as { settings?: unknown };
    const serialized = JSON.stringify(payload.settings);
    expect(serialized).not.toContain("advancedConfig");
    expect(serialized).not.toContain("agentSkills");
    expect(serialized).not.toContain('"mail"');
    expect(serialized).not.toContain("VOZEB_PRO_");
});

test("initialization rejects a wrong token and creates the first administrator once", async ({ page, request }) => {
    const statusResponse = await request.get("/api/install/status");
    expect(statusResponse.ok()).toBe(true);
    let install = ((await statusResponse.json()) as { install: { database?: { schemaReady?: boolean } } }).install;

    if (install.database?.schemaReady === false) {
        const rejectedInitialization = await request.post("/api/install/initialize", { data: { installToken: "wrong-install-token" } });
        expect(rejectedInitialization.status()).toBeGreaterThanOrEqual(400);
        const initialized = await request.post("/api/install/initialize", { data: { installToken: E2E_ADMIN.installToken } });
        expect(initialized.ok()).toBe(true);
        install = ((await initialized.json()) as { data: { install: typeof install } }).data.install;
        expect(install.database?.schemaReady).toBe(true);
    }

    const rejectedRegistration = await request.post("/api/auth/register", {
        data: { username: E2E_ADMIN.username, displayName: E2E_ADMIN.displayName, password: E2E_ADMIN.password, installToken: "wrong-install-token" },
    });
    expect(rejectedRegistration.status()).toBeGreaterThanOrEqual(400);

    const registration = await request.post("/api/auth/register", {
        data: { username: E2E_ADMIN.username, displayName: E2E_ADMIN.displayName, password: E2E_ADMIN.password, installToken: E2E_ADMIN.installToken },
    });
    expect(registration.ok()).toBe(true);
    expect(await registration.json()).toMatchObject({ user: { username: E2E_ADMIN.username, role: "admin" } });

    const settings = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
    expect(settings.ok(), await settings.text()).toBe(true);
    expect(await settings.json()).toMatchObject({ settings: { defaultModels: { textModel: "e2e-text", imageModel: "e2e-image", videoModel: "e2e-video", audioModel: "e2e-audio" } } });

    await page.goto("/install");
    await expect(page).toHaveURL(/\/(?:$|\?)/);

    const statePath = path.join(process.cwd(), ".e2e-data", "admin-state.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await request.storageState({ path: statePath });
});
