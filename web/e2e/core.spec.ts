import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_PAYMENT_WEBHOOK_SECRET, pollTask, protocolFixtureState, resetProtocolFixture } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    await resetProtocolFixture(request);
});

test("site footer deletions remain deleted after settings and public-session reloads", async ({ request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { site: Record<string, unknown> } }).settings.site;
    const socials = before.socials as Record<string, { enabled: boolean; label: string; url: string }>;
    try {
        const site = {
            ...before,
            friendLinks: [],
            socials: { ...socials, email: { enabled: false, label: "", url: "" } },
        };
        const savedResponse = await request.patch("/api/admin/settings", { data: { site } });
        expect(savedResponse.ok(), await savedResponse.text()).toBe(true);

        const persistedResponse = await request.get("/api/admin/settings");
        const persisted = ((await persistedResponse.json()) as { settings: { site: { friendLinks: unknown[]; socials: typeof socials } } }).settings.site;
        expect(persisted.friendLinks).toEqual([]);
        expect(persisted.socials.email).toEqual({ enabled: false, label: "", url: "" });

        const publicResponse = await request.get("/api/auth/session");
        const publicSite = ((await publicResponse.json()) as { settings: { site: { friendLinks: unknown[]; socials: typeof socials } } }).settings.site;
        expect(publicSite.friendLinks).toEqual([]);
        expect(publicSite.socials.email).toEqual({ enabled: false, label: "", url: "" });
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { site: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("admin site form persists social addresses, publishes them to the home footer, and deletes friend links", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { site: Record<string, unknown> } }).settings.site;
    const socials = before.socials as Record<string, { enabled: boolean; label: string; url: string }>;
    const testLink = { id: "e2e-footer-link", label: "E2E Footer Link", url: "https://example.com/footer", enabled: true };
    try {
        const seededResponse = await request.patch("/api/admin/settings", {
            data: {
                site: {
                    ...before,
                    friendLinks: [testLink],
                    socials: {
                        ...socials,
                        email: { enabled: true, label: "邮箱联系", url: "mailto:before@example.com" },
                        telegram: { enabled: true, label: "Telegram", url: "" },
                        x: { enabled: true, label: "X", url: "" },
                        instagram: { enabled: true, label: "Instagram", url: "" },
                    },
                },
            },
        });
        expect(seededResponse.ok(), await seededResponse.text()).toBe(true);

        await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const emailInput = page.getByPlaceholder("name@example.com");
        const telegramInput = page.getByPlaceholder("https://t.me/username 或 @username");
        const xInput = page.getByPlaceholder("https://x.com/username 或 @username");
        const instagramInput = page.getByPlaceholder("https://instagram.com/username 或 @username");
        await expect(emailInput).toBeVisible();
        await expect(emailInput).toHaveValue("mailto:before@example.com");
        await emailInput.fill("owner@example.com");
        await telegramInput.fill("t.me/vozeb_group");
        await xInput.fill("@vozeb_pro");
        await instagramInput.fill("instagram.com/vozeb.pro");
        await expect(emailInput).toHaveValue("owner@example.com");
        await page.getByRole("button", { name: "保存网站设置" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("网站信息已保存")).toBeVisible();
        await expect(emailInput).toHaveValue("mailto:owner@example.com");
        await expect(telegramInput).toHaveValue("https://t.me/vozeb_group");
        await expect(xInput).toHaveValue("https://x.com/vozeb_pro");
        await expect(instagramInput).toHaveValue("https://instagram.com/vozeb.pro");

        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.locator('footer a[aria-label="Telegram"]')).toHaveAttribute("href", "https://t.me/vozeb_group");
        await expect(page.locator('footer a[aria-label="X"]')).toHaveAttribute("href", "https://x.com/vozeb_pro");
        await expect(page.locator('footer a[aria-label="Instagram"]')).toHaveAttribute("href", "https://instagram.com/vozeb.pro");

        await page.goto("/admin?section=site", { waitUntil: "domcontentloaded" });
        await expect(emailInput).toHaveValue("mailto:owner@example.com");
        await expect(telegramInput).toHaveValue("https://t.me/vozeb_group");
        await expect(xInput).toHaveValue("https://x.com/vozeb_pro");
        await expect(instagramInput).toHaveValue("https://instagram.com/vozeb.pro");
        await page.getByRole("button", { name: "删除友情链接" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("友情链接已删除")).toBeVisible();
        await expect(page.getByText(testLink.label, { exact: true })).toHaveCount(0);

        const persistedResponse = await request.get("/api/admin/settings");
        const persisted = ((await persistedResponse.json()) as { settings: { site: { friendLinks: unknown[]; socials: typeof socials } } }).settings.site;
        expect(persisted.friendLinks).toEqual([]);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText(testLink.label, { exact: true })).toHaveCount(0);

        expect(persisted.socials.email.url).toBe("mailto:owner@example.com");
        expect(persisted.socials.telegram).toEqual({ enabled: true, label: "Telegram", url: "https://t.me/vozeb_group" });
        expect(persisted.socials.x).toEqual({ enabled: true, label: "X", url: "https://x.com/vozeb_pro" });
        expect(persisted.socials.instagram).toEqual({ enabled: true, label: "Instagram", url: "https://instagram.com/vozeb.pro" });

        const publicResponse = await request.get("/api/auth/session");
        const publicSite = ((await publicResponse.json()) as { settings: { site: { socials: typeof socials } } }).settings.site;
        expect(publicSite.socials).toEqual(persisted.socials);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { site: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("admin data lifecycle settings persist without password re-verification", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { dataLifecycle: { maintenanceBatchSize: number } } }).settings.dataLifecycle;
    const nextBatchSize = before.maintenanceBatchSize < 500 ? before.maintenanceBatchSize + 1 : before.maintenanceBatchSize - 1;

    try {
        await page.goto("/admin?section=settings", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const batchInput = page.getByRole("spinbutton", { name: /单类每批处理数量/ });
        await expect(batchInput).toHaveValue(String(before.maintenanceBatchSize));
        await batchInput.fill(String(nextBatchSize));
        await page.getByRole("button", { name: "保存系统设置" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("系统设置已保存", { exact: true })).toBeVisible();

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(batchInput).toHaveValue(String(nextBatchSize));
        const persistedResponse = await request.get("/api/admin/settings");
        expect(persistedResponse.ok(), await persistedResponse.text()).toBe(true);
        expect(((await persistedResponse.json()) as { settings: { dataLifecycle: { maintenanceBatchSize: number } } }).settings.dataLifecycle.maintenanceBatchSize).toBe(nextBatchSize);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { dataLifecycle: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("text tasks return content, fail over automatically, and surface terminal failures", async ({ request }) => {
    const fallback = await request.post("/api/text-tasks", { data: { config: { model: "e2e-text-fallback" }, messages: [{ role: "user", content: "protocol fallback" }] } });
    expect(fallback.ok(), await fallback.text()).toBe(true);
    const fallbackTask = ((await fallback.json()) as { task: { id: string } }).task;
    const completed = await pollTask(request, `/api/text-tasks/${fallbackTask.id}`);
    expect(completed).toMatchObject({ status: "success", result: { content: "协议测试文本返回成功" } });
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toMatchObject([
        { authorization: "Bearer e2e-primary-secret", model: "e2e-text-fallback" },
        { authorization: "Bearer e2e-backup-secret", model: "e2e-text-fallback" },
    ]);

    const failed = await request.post("/api/text-tasks", { data: { config: { model: "e2e-text-fail" }, messages: [{ role: "user", content: "protocol failure" }] } });
    expect(failed.ok(), await failed.text()).toBe(true);
    const failedTask = ((await failed.json()) as { task: { id: string } }).task;
    expect(await pollTask(request, `/api/text-tasks/${failedTask.id}`)).toMatchObject({ status: "error" });
});

test("image task persists a real media result and reuses the same request identity", async ({ request }) => {
    const clientRequestId = `e2e-image:${randomUUID()}`;
    const body = { kind: "generation", config: { model: "e2e-image", quality: "standard", size: "64x64" }, prompt: "blue image", source: "image-workbench", context: { clientRequestId } };
    const headers = { "X-VOZEB-PRO-Client-Request-Id": clientRequestId };
    const created = await request.post("/api/image-tasks", { data: body, headers });
    expect(created.ok(), await created.text()).toBe(true);
    const firstTask = ((await created.json()) as { task: { id: string } }).task;
    const replay = await request.post("/api/image-tasks", { data: body, headers });
    expect(replay.ok()).toBe(true);
    expect((await replay.json()).task.id).toBe(firstTask.id);
    const completed = await pollTask(request, `/api/image-tasks/${firstTask.id}`);
    expect(completed).toMatchObject({ status: "success", result: { width: 64, height: 64, mimeType: "image/png" } });
    const mediaUrl = String((completed.result as { dataUrl?: string }).dataUrl || "");
    expect(mediaUrl).toMatch(/^\/api\/generation-log-assets\/permanent\/.+\.png$/);
    const media = await request.get(mediaUrl);
    expect(media.ok()).toBe(true);
    expect(media.headers()["content-type"]).toMatch(/^image\/png/);
    expect(Array.from((await media.body()).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
});

test("unified creative page reaches the local planning and image protocols", async ({ page, request }) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });

    await page.getByRole("button", { name: "当前创作类型：Agent 模式" }).click();
    const modePicker = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
    await expect(modePicker).toBeVisible();
    await modePicker.getByRole("button", { name: /图片生成/ }).click();
    await expect(page.getByRole("button", { name: "当前创作类型：图片生成" })).toBeVisible();

    const prompt = `统一入口协议图片 ${randomUUID().slice(0, 8)}`;
    await page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" }).fill(prompt);
    const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送" }).click();
    const runResponse = await runCreated;
    expect(runResponse.ok(), await runResponse.text()).toBe(true);
    const runId = ((await runResponse.json()) as { data: { run: { id: string } } }).data.run.id;

    await expect
        .poll(
            async () => {
                const response = await request.get(`/api/agent/runs/${runId}`);
                if (!response.ok()) return `http-${response.status()}`;
                return ((await response.json()) as { data: { run: { status: string } } }).data.run.status;
            },
            { timeout: 60_000 },
        )
        .toBe("completed");
    await expect(page.getByTestId("creative-media-result")).toBeVisible();
    await expect(page.getByTestId("creative-media-result").getByRole("img")).toHaveAttribute("src", /\/api\/generation-log-assets\/permanent\/.+\.png/);

    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
});

test("video request replay and cancellation keep one upstream task", async ({ request }) => {
    const clientRequestId = `e2e-video:${randomUUID()}`;
    const body = { config: { model: "e2e-video-slow", size: "16:9", vquality: "720", videoSeconds: 5 }, prompt: "slow video", source: "video-workbench", context: { clientRequestId } };
    const headers = { "X-VOZEB-PRO-Client-Request-Id": clientRequestId };
    const created = await request.post("/api/video-generation-tasks", { data: body, headers });
    expect(created.ok(), await created.text()).toBe(true);
    const firstTask = ((await created.json()) as { task: { id: string } }).task;
    const replay = await request.post("/api/video-generation-tasks", { data: body, headers });
    expect(replay.ok()).toBe(true);
    expect((await replay.json()).task.id).toBe(firstTask.id);
    await expect.poll(async () => (await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos")).length).toBe(1);

    const cancelled = await request.patch(`/api/video-tasks/${firstTask.id}`, { data: { action: "cancel" } });
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
    expect(await pollTask(request, `/api/video-tasks/${firstTask.id}`)).toMatchObject({ status: "cancelled" });
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
});

test("legacy image and video routes hand off to the unified creative Agent", async ({ page }) => {
    for (const route of ["/image", "/video"]) {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/create$/);
        await expect(page.getByRole("heading", { name: "星启智域 创作 Agent" })).toBeVisible();
        await expect(page.getByRole("button", { name: /生成模型：/ })).toBeVisible();
    }
});

test("audio task stores a valid audio result", async ({ request }) => {
    const created = await request.post("/api/audio-tasks", { data: { config: { model: "e2e-audio", voice: "alloy", format: "wav" }, prompt: "audio fixture", source: "agent", context: { clientRequestId: `e2e-audio:${randomUUID()}` } } });
    expect(created.ok(), await created.text()).toBe(true);
    const task = ((await created.json()) as { task: { id: string } }).task;
    expect(await pollTask(request, `/api/audio-tasks/${task.id}`)).toMatchObject({ status: "success", result: { mimeType: "audio/wav" } });
});

test("canvas projects round-trip two nodes and one connection", async ({ request }) => {
    const created = await request.post("/api/canvas/projects", {
        data: {
            title: "E2E Canvas",
            project: {
                nodes: [
                    { id: "node-a", type: "text", title: "需求", position: { x: 10, y: 20 }, width: 240, height: 120, metadata: { content: "生成测试" } },
                    { id: "node-b", type: "config", title: "配置", position: { x: 360, y: 20 }, width: 240, height: 160, metadata: { size: "1280x720" } },
                ],
                connections: [{ id: "edge-a-b", fromNodeId: "node-a", toNodeId: "node-b" }],
            },
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    const loaded = await request.get(`/api/canvas/projects/${project.id}`);
    expect(loaded.ok()).toBe(true);
    expect(await loaded.json()).toMatchObject({ data: { project: { nodes: [{ id: "node-a" }, { id: "node-b" }], connections: [{ id: "edge-a-b", fromNodeId: "node-a", toNodeId: "node-b" }] } } });
});

test("new Agent Skill is saved before leaving the administrator page", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { agentSkills: unknown[] } }).settings.agentSkills;
    const skillName = `E2E 持久 Skill ${randomUUID().slice(0, 8)}`;

    try {
        await page.goto("/admin?section=skills");
        await page.getByRole("button", { name: "新增 Skill" }).click();
        await page.getByText("手动创建", { exact: true }).click();
        await page.getByLabel("Skill 名称").fill(skillName);
        await page.getByLabel("执行规则").fill("保持用户需求不变，按当前工作台能力规划并执行。");
        await page.getByRole("button", { name: "添加并保存" }).click();
        await expect(page.getByLabel("当前密码")).toHaveCount(0);
        await expect(page.getByText("Agent Skill 已添加并保存", { exact: true })).toBeVisible();

        await page.goto("/create");
        await page.goto("/admin?section=skills");
        await expect(page.getByRole("main").getByText(skillName, { exact: true })).toBeVisible();

        const persistedResponse = await request.get("/api/admin/settings");
        expect(persistedResponse.ok(), await persistedResponse.text()).toBe(true);
        const persisted = ((await persistedResponse.json()) as { settings: { agentSkills: Array<{ name?: string }> } }).settings.agentSkills;
        expect(persisted.some((skill) => skill.name === skillName)).toBe(true);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { agentSkills: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("PostgreSQL payment flow verifies missing fields, rejects trade reuse, and refunds", async ({ request }) => {
    test.skip(!process.env.VOZEB_PRO_E2E_DATABASE_URL, "需要专用 PostgreSQL E2E 数据库");
    const productResponse = await request.post("/api/admin/billing/products", {
        data: { productKind: "points", name: `E2E 积分包 ${randomUUID().slice(0, 8)}`, description: "E2E", amountCents: 100, currency: "CNY", pointsAmount: 100, enabled: true },
    });
    expect(productResponse.ok(), await productResponse.text()).toBe(true);
    const product = ((await productResponse.json()) as { product: { id: string } }).product;

    const firstOrder = await createOrder(request, product.id);
    const checkout = await request.post(`/api/billing/orders/${firstOrder.id}/checkout`, { data: { provider: "payply" } });
    expect(checkout.ok(), await checkout.text()).toBe(true);
    expect(await checkout.json()).toMatchObject({ code: 0, data: { checkout: { kind: "redirect", provider: "payply" } } });

    const firstWebhookBody = JSON.stringify({ eventId: `event-${randomUUID()}`, status: "succeeded", orderId: firstOrder.id, orderNo: firstOrder.orderNo, providerTradeId: "payply_trade_e2e", providerPaymentId: "payply_payment_e2e" });
    const firstWebhook = await postSignedWebhook(request, firstWebhookBody);
    expect(firstWebhook.ok(), await firstWebhook.text()).toBe(true);
    expect(await firstWebhook.json()).toMatchObject({ orderId: firstOrder.id, orderStatus: "paid" });
    const duplicate = await postSignedWebhook(request, firstWebhookBody);
    expect(duplicate.ok()).toBe(true);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, orderId: firstOrder.id });

    const secondOrder = await createOrder(request, product.id);
    const conflictBody = JSON.stringify({ eventId: `event-${randomUUID()}`, status: "succeeded", orderId: secondOrder.id, orderNo: secondOrder.orderNo, providerTradeId: "payply_trade_e2e", providerPaymentId: "payply_payment_conflict" });
    const conflict = await postSignedWebhook(request, conflictBody);
    expect(conflict.status()).toBe(409);

    const refund = await request.post(`/api/admin/billing/orders/${firstOrder.id}/refund`, { data: { reason: "E2E 退款" } });
    expect(refund.ok(), await refund.text()).toBe(true);
    expect(await refund.json()).toMatchObject({ order: { id: firstOrder.id, status: "refunded" }, providerRefund: { provider: "payply", status: "succeeded" } });
});

async function createOrder(request: APIRequestContext, productId: string) {
    const response = await request.post("/api/billing/orders", { data: { productId, quantity: 1, provider: "payply" } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { order: { id: string; orderNo: string } }).order;
}

async function postSignedWebhook(request: APIRequestContext, rawBody: string) {
    const signature = createHmac("sha256", E2E_PAYMENT_WEBHOOK_SECRET).update(rawBody).digest("hex");
    return request.post("/api/billing/webhooks/payply", { data: rawBody, headers: { "content-type": "application/json", "x-vozeb-pro-signature": signature } });
}
