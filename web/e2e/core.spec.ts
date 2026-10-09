import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { DRAMA_PROJECT_MAX_BYTES } from "@/lib/drama-project-contract";
import { createCanvasProject, deleteCanvasProject, expectCanvasSaved, readCanvasProject } from "./canvas-e2e-helpers";
import { E2E_PAYMENT_WEBHOOK_SECRET, E2E_PROTOCOL_ORIGIN, pollTask, protocolFixtureState, resetProtocolFixture } from "./support";

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
    await expect(page.getByTestId("creative-media-result").getByTestId("creative-primary-result").getByRole("img")).toHaveAttribute("src", /\/api\/generation-log-assets\/permanent\/.+\.png/);

    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
});

test("unified creative video mode reaches the local planning and video protocols", async ({ page, request }) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });

    await page.getByRole("button", { name: "当前创作类型：Agent 模式" }).click();
    const modePicker = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
    await expect(modePicker).toBeVisible();
    await modePicker.getByRole("button", { name: /视频生成/ }).click();
    await expect(page.getByRole("button", { name: "当前创作类型：视频生成" })).toBeVisible();

    const prompt = `统一入口协议视频 ${randomUUID().slice(0, 8)}`;
    await page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" }).fill(prompt);
    const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送" }).click();
    const runResponse = await runCreated;
    expect(runResponse.ok(), await runResponse.text()).toBe(true);
    const runId = ((await runResponse.json()) as { data: { run: { id: string } } }).data.run.id;
    await waitForAgentRun(request, runId);

    const video = page.getByTestId("creative-video-result").locator("video");
    await expect(video).toHaveAttribute("src", /\/api\/reference-assets\/permanent\/.+\.mp4/);
    const videoResponse = await request.get((await video.getAttribute("src"))!);
    expect(videoResponse.ok(), await videoResponse.text()).toBe(true);
    expect(videoResponse.headers()["content-type"]).toMatch(/^video\/mp4/);

    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
    expect(state.requests.some((item) => item.method === "GET" && /\/videos\/fixture-video-/.test(item.path))).toBe(true);
});

test("unified creative Agent reaches the local image and video protocols", async ({ page, request }) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });

    const prompt = `统一 Agent 生成一张图片和一段视频 ${randomUUID().slice(0, 8)}`;
    await page.getByRole("textbox", { name: "输入你的创作想法、脚本或画面要求" }).fill(prompt);
    const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送" }).click();
    const runResponse = await runCreated;
    expect(runResponse.ok(), await runResponse.text()).toBe(true);
    const runId = ((await runResponse.json()) as { data: { run: { id: string } } }).data.run.id;
    await waitForAgentRun(request, runId);

    await expect(page.getByTestId("creative-media-result").getByTestId("creative-primary-result").getByRole("img")).toHaveAttribute("src", /\/api\/generation-log-assets\/permanent\/.+\.png/);
    const video = page.getByTestId("creative-video-result").locator("video");
    await expect(video).toHaveAttribute("src", /\/api\/reference-assets\/permanent\/.+\.mp4/);
    const videoResponse = await request.get((await video.getAttribute("src"))!);
    expect(videoResponse.ok(), await videoResponse.text()).toBe(true);
    expect(videoResponse.headers()["content-type"]).toMatch(/^video\/mp4/);
    await expect(page.getByText(/内部协议(?:图片|视频)执行提示/)).toHaveCount(0);

    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
    expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
    expect(state.requests.some((item) => item.method === "GET" && /\/videos\/fixture-video-/.test(item.path))).toBe(true);
});

test("Canvas Agent persists local image and video results while the canvas remains movable", async ({ page, request }) => {
    const project = await createCanvasProject(request, { title: `Canvas Agent 协议 ${randomUUID().slice(0, 8)}`, viewport: { x: 80, y: 100, k: 1 }, nodes: [], connections: [] });
    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const composer = page.getByPlaceholder("描述你想让 Agent 如何操作画布");
        await expect(composer).toBeVisible({ timeout: 20_000 });
        await composer.fill("生成一张图片和一段视频，验证画布协议与持久化");
        const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
        await page.getByRole("button", { name: "发送" }).click();
        const runResponse = await runCreated;
        expect(runResponse.ok(), await runResponse.text()).toBe(true);
        const runId = ((await runResponse.json()) as { data: { run: { id: string } } }).data.run.id;
        await waitForAgentRun(request, runId);

        const projectPath = `/api/canvas/projects/${project.id}`;
        await expect
            .poll(async () => {
                const stored = await readCanvasProject(request, projectPath);
                return stored.nodes
                    .filter((item) => item.metadata?.agentRunId === runId && item.metadata?.status === "success")
                    .map((item) => item.type)
                    .sort();
            })
            .toEqual(["image", "video"]);
        const stored = await readCanvasProject(request, projectPath);
        const outputNodes = stored.nodes.filter((item) => item.metadata?.agentRunId === runId && ["image", "video"].includes(item.type));
        expect(outputNodes).toHaveLength(2);
        for (const item of outputNodes) await expect(page.locator(`[data-node-id="${item.id}"]`)).toBeVisible();
        await expect(page.locator(`[data-node-id="brief-${runId}"], [data-node-id="brand-${runId}"], [data-node-id^="task-${runId}-"]`)).toHaveCount(0);
        await expect(page.getByText(/内部协议(?:图片|视频)执行提示/)).toHaveCount(0);

        const surface = page.locator("[data-canvas-surface]");
        if ((await surface.getAttribute("data-canvas-interaction-mode")) !== "pan") await page.getByRole("button", { name: "切换到小手模式" }).click();
        const beforeViewport = await canvasViewport(request, project.id);
        const bounds = await surface.boundingBox();
        expect(bounds).not.toBeNull();
        const panStart = { x: bounds!.x + bounds!.width * 0.45, y: bounds!.y + bounds!.height * 0.52 };
        await page.mouse.move(panStart.x, panStart.y);
        await page.mouse.down();
        await page.mouse.move(panStart.x + 80, panStart.y - 40, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await canvasViewport(request, project.id)).x).toBeGreaterThan(beforeViewport.x + 50);
        await expectCanvasSaved(page, 10_000);

        await page.goto("/canvas", { waitUntil: "domcontentloaded" });
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-canvas-surface]")).toBeVisible();
        expect(
            (await readCanvasProject(request, projectPath)).nodes
                .filter((item) => item.metadata?.agentRunId === runId && item.metadata?.status === "success")
                .map((item) => item.type)
                .sort(),
        ).toEqual(["image", "video"]);

        const state = await protocolFixtureState(request);
        expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
        expect(state.requests.some((item) => item.method === "GET" && /\/videos\/fixture-video-/.test(item.path))).toBe(true);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("Drama Agent persists and restores local image and video results", async ({ page, request }) => {
    const created = await request.post("/api/drama/projects", {
        data: {
            title: `短剧 Agent 协议 ${randomUUID().slice(0, 8)}`,
            summary: "验证项目 Agent 图片与视频完整链路",
            ratio: "16:9",
            sourceAssets: [
                { id: "protocol-source-image", type: "image", title: "协议来源图片", serverUrl: `${E2E_PROTOCOL_ORIGIN}/media/fixture.png`, mimeType: "image/png", width: 640, height: 360 },
                { id: "protocol-source-video", type: "video", title: "协议来源视频", serverUrl: `${E2E_PROTOCOL_ORIGIN}/media/fixture.mp4`, mimeType: "video/mp4", width: 640, height: 360 },
            ],
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    try {
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-drama-workspace]")).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "打开项目 Agent" }).click();
        const panel = page.getByRole("complementary", { name: "项目 Agent 面板" });
        await expect(panel).toBeVisible();
        const composer = panel.getByPlaceholder("告诉 Agent 下一步要做什么");
        await composer.fill("222@");
        const mentionPicker = page.locator("[data-drama-agent-mention-picker]");
        await expect(mentionPicker).toBeVisible();
        await expect(mentionPicker.getByRole("button", { name: "引用来源：协议来源图片" })).toBeVisible();
        await expect(mentionPicker.locator('img[data-drama-agent-mention-media="image"]')).toBeVisible();
        await expect(mentionPicker.getByRole("button", { name: "引用来源：协议来源视频" })).toBeVisible();
        await expect(mentionPicker.locator('[data-drama-agent-mention-media="video"] video')).toBeVisible();
        await mentionPicker.getByRole("button", { name: "引用来源：协议来源图片" }).click();
        await expect(composer).toHaveValue("222@来源1 ");
        await composer.fill(`${await composer.inputValue()}再参考@`);
        await expect(mentionPicker).toBeVisible();
        await mentionPicker.getByRole("button", { name: "引用来源：协议来源视频" }).click();
        await expect(composer).toHaveValue("222@来源1 再参考@来源2 ");
        const prompt = `${await composer.inputValue()}生成一张图片和一段视频，验证短剧项目 Agent 持久化`;
        await composer.fill(prompt);
        const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
        await panel.getByRole("button", { name: "发送给项目 Agent" }).click();
        const runResponse = await runCreated;
        expect(runResponse.ok(), await runResponse.text()).toBe(true);
        const runRequest = runResponse.request().postDataJSON() as { snapshot?: { currentTurnReferences?: Array<{ id: string; kind: string; alias: string }> } };
        expect(runRequest.snapshot?.currentTurnReferences).toEqual([
            { id: "protocol-source-image", kind: "source", title: "协议来源图片", alias: "@来源1" },
            { id: "protocol-source-video", kind: "source", title: "协议来源视频", alias: "@来源2" },
        ]);
        const run = ((await runResponse.json()) as { data: { run: { id: string; conversationId: string } } }).data.run;
        await waitForAgentRun(request, run.id);
        await expect(panel.getByRole("img", { name: "协议测试图片" })).toBeVisible({ timeout: 20_000 });
        await expect(panel.getByRole("button", { name: "打开视频：协议测试视频" })).toBeVisible();
        await expect(panel.getByText(/内部协议(?:图片|视频)执行提示/)).toHaveCount(0);
        await expect.poll(async () => (await dramaProject(request, project.id)).creativeConversationId).toBe(run.conversationId);

        await page.goto("/drama", { waitUntil: "domcontentloaded" });
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "打开项目 Agent" }).click();
        const restored = page.getByRole("complementary", { name: "项目 Agent 面板" });
        await expect(restored.getByText(prompt, { exact: true })).toBeVisible();
        await expect(restored.getByRole("img", { name: "协议测试图片" })).toBeVisible();
        await expect(restored.getByRole("button", { name: "打开视频：协议测试视频" })).toBeVisible();
        await expect(restored.getByText(/内部协议(?:图片|视频)执行提示/)).toHaveCount(0);

        const state = await protocolFixtureState(request);
        expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
    } finally {
        const deleted = await request.delete(`/api/drama/projects/${project.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }
});

test("Drama production persists storyboard and shot video results through reload", async ({ page, request }) => {
    const analysisRequestIds: string[] = [];
    const contentRequestOrder: string[] = [];
    page.on("request", (current) => {
        const pathname = new URL(current.url()).pathname;
        if (current.method() !== "POST") return;
        if (pathname === "/api/drama/analyze" || pathname.endsWith("/versions")) contentRequestOrder.push(pathname);
        if (pathname !== "/api/drama/analyze") return;
        const requestId = String((current.postDataJSON() as { requestId?: string } | null)?.requestId || "");
        analysisRequestIds.push(requestId);
    });
    const created = await request.post("/api/drama/projects", {
        data: {
            title: `短剧生产协议 ${randomUUID().slice(0, 8)}`,
            summary: "验证短剧从剧本分析到镜头视频的完整链路",
            style: "清晰的横版测试画面",
            ratio: "16:9",
            initialScript: "主角推门进入明亮的测试房间，说：测试开始。",
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    try {
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-drama-workspace]")).toBeVisible({ timeout: 20_000 });
        const analyzeButton = page.locator("[data-drama-script-statusbar]").getByRole("button", { name: "AI 整理" });
        await expect(analyzeButton).toBeEnabled();
        await analyzeButton.click();
        await expect(page.getByRole("heading", { name: "内容审核", exact: true })).toBeVisible({ timeout: 30_000 });
        expect(contentRequestOrder.slice(0, 2)).toEqual([`/api/drama/projects/${project.id}/versions`, "/api/drama/analyze"]);

        await page.getByRole("button", { name: "确认内容并生成视觉方案" }).click();
        await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "展开" }).first().click();
        for (const label of ["分镜驱动", "直接生成", "参考图", "单帧", "首尾帧"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "进入镜头生成" }).click();
        await expect(page.getByRole("heading", { name: "镜头生成", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "生成 1 个就绪镜头" }).click();

        await expect
            .poll(
                async () => {
                    const stored = await dramaProject(request, project.id);
                    const shot = stored.episodes[0]?.shots[0];
                    return {
                        reviewStatus: stored.episodes[0]?.reviewStatus,
                        storyboardStatus: shot?.storyboardStatus,
                        storyboardTaskId: Boolean(shot?.storyboardTaskId),
                        storyboardImageUrl: Boolean(shot?.storyboardImageUrl),
                        generationStatus: shot?.generationStatus,
                        generationTaskId: Boolean(shot?.generationTaskId),
                        videoUrl: Boolean(shot?.videoUrl),
                    };
                },
                { timeout: 90_000 },
            )
            .toEqual({ reviewStatus: "visual_ready", storyboardStatus: "success", storyboardTaskId: true, storyboardImageUrl: true, generationStatus: "success", generationTaskId: true, videoUrl: true });

        await expect(page.getByRole("button", { name: /查看图片：.*起始帧/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /查看视频：.*生成视频/ })).toBeVisible();
        const state = await protocolFixtureState(request);
        expect(state.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
        expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(1);
        expect(analysisRequestIds).toHaveLength(2);
        expect(analysisRequestIds.every(Boolean)).toBe(true);
        expect(new Set(analysisRequestIds).size).toBe(2);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByRole("button", { name: "切换到镜头生成" })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "切换到镜头生成" }).click();
        await expect(page.getByRole("heading", { name: "镜头生成", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /查看图片：.*起始帧/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /查看视频：.*生成视频/ })).toBeVisible();
        expect((await dramaProject(request, project.id)).episodes[0]?.shots[0]).toMatchObject({ storyboardStatus: "success", generationStatus: "success" });
    } finally {
        const deleted = await request.delete(`/api/drama/projects/${project.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }
});

test("Drama visual result recovers a dropped browser response idempotently", async ({ page, request }) => {
    const created = await request.post("/api/drama/projects", {
        data: {
            title: `短剧视觉断线恢复 ${randomUUID().slice(0, 8)}`,
            summary: "验证视觉结果已落库但浏览器响应丢失时恢复同一任务",
            style: "清晰测试画面",
            ratio: "16:9",
            initialScript: "主角推门进入明亮的测试房间，说：测试开始。",
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    try {
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-drama-workspace]")).toBeVisible({ timeout: 20_000 });
        await page.locator("[data-drama-script-statusbar]").getByRole("button", { name: "AI 整理" }).click();
        await expect(page.getByRole("heading", { name: "内容审核", exact: true })).toBeVisible({ timeout: 30_000 });

        let dropped = false;
        await page.route(`**/api/drama/projects/${project.id}/episodes/*/visual-analysis`, async (route) => {
            if (dropped) return route.continue();
            const response = await route.fetch();
            expect(response.ok(), await response.text()).toBe(true);
            dropped = true;
            await route.abort("failed");
        });
        await page.getByRole("button", { name: "确认内容并生成视觉方案" }).click();
        await expect(page.getByRole("button", { name: "检查任务状态" })).toBeVisible({ timeout: 30_000 });
        const committed = await dramaProject(request, project.id);
        expect(committed.episodes[0]).toMatchObject({ reviewStatus: "visual_ready", visualCompletedTaskId: expect.any(String) });
        expect(committed.episodes[0]).not.toHaveProperty("visualTaskId");
        const versionsBefore = (await (await request.get(`/api/drama/projects/${project.id}/versions`)).json()) as { data: { versions: Array<{ reason: string }> } };
        expect(versionsBefore.data.versions.filter((version) => version.reason === "视觉方案生成前")).toHaveLength(1);

        await page.getByRole("button", { name: "检查任务状态" }).click();
        await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 30_000 });
        const versionsAfter = (await (await request.get(`/api/drama/projects/${project.id}/versions`)).json()) as { data: { versions: Array<{ reason: string }> } };
        expect(versionsAfter.data.versions.filter((version) => version.reason === "视觉方案生成前")).toHaveLength(1);
    } finally {
        const deleted = await request.delete(`/api/drama/projects/${project.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }
});

test("Drama import persists supported sources and blocks files above the shared project limit", async ({ page, request }) => {
    const created = await request.post("/api/drama/projects", { data: { title: `短剧导入限额 ${randomUUID().slice(0, 8)}` } });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    try {
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-drama-workspace]")).toBeVisible({ timeout: 20_000 });
        await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({ name: "supported.txt", mimeType: "text/plain", buffer: Buffer.from("剧".repeat(1_050_000), "utf8") });
        await page.getByRole("button", { name: "确认导入 263 集" }).click();
        await expect(page.getByText("已导入 263 集，请逐集检查并提取内容结构", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect.poll(async () => (await dramaProject(request, project.id)).episodes.length).toBe(263);

        await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({ name: "oversized.txt", mimeType: "text/plain", buffer: Buffer.alloc(DRAMA_PROJECT_MAX_BYTES + 1, 0x61) });

        await expect(page.getByText("剧本文件超过 8 MB，请拆分后重新上传", { exact: true })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "导入整本剧本" })).toHaveCount(0);
        expect((await dramaProject(request, project.id)).episodes).toHaveLength(263);
    } finally {
        const deleted = await request.delete(`/api/drama/projects/${project.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }
});

test("Drama wide script workspace keeps episode settings collapsed and editor wide", async ({ page, request }) => {
    await page.setViewportSize({ width: 1672, height: 1000 });
    const created = await request.post("/api/drama/projects", {
        data: {
            title: `短剧宽屏模式 ${randomUUID().slice(0, 8)}`,
            summary: "验证宽屏剧本工作区不会隐藏视频生产模式",
            ratio: "9:16",
            initialScript: "主角走进房间。",
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;
    try {
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        const workspace = page.locator("[data-drama-script-workspace]");
        await expect(workspace).toBeVisible({ timeout: 20_000 });
        await expect(workspace.locator("[data-drama-episode-settings]")).toHaveCount(0);
        const settingsButton = page.getByRole("button", { name: "打开本集设置" });
        await expect(settingsButton).toBeVisible();
        await settingsButton.click();
        const settings = page.locator("[data-drama-episode-settings]");
        await expect(settings).toBeVisible();
        await expect(settings.getByText("视频生产模式", { exact: true })).toBeVisible();
        await expect(settings.getByText("分镜驱动", { exact: true })).toBeVisible();

        const columns = await workspace.evaluate((element) =>
            ["[data-drama-scene-structure]", "[data-drama-script-editor]"].map((selector) => {
                const rect = element.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
                return rect ? { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) } : null;
            }),
        );
        expect(columns.every(Boolean)).toBe(true);
        expect(columns[0]?.right).toBeLessThanOrEqual(columns[1]?.left || 0);
        expect(columns[1]?.width).toBeGreaterThan(900);
        const editorWidth = await page.locator("[data-drama-script-editor] .ProseMirror").evaluate((element) => Math.round(element.getBoundingClientRect().width));
        expect(editorWidth).toBeGreaterThan(900);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
        const deleted = await request.delete(`/api/drama/projects/${project.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }
});

test("Drama imports Word chapters and persists an edited episode number", async ({ page, request }) => {
    await page.setViewportSize({ width: 1672, height: 1000 });
    const created = await request.post("/api/drama/projects", {
        data: {
            title: `短剧 Word 导入 ${randomUUID().slice(0, 8)}`,
            summary: "验证 Word 章节导入和集数持久化",
            ratio: "9:16",
            initialScript: "待替换的初始剧本。",
        },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const project = ((await created.json()) as { data: { project: { id: string } } }).data.project;

    try {
        await page.goto(`/drama/${project.id}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-drama-script-workspace]")).toBeVisible({ timeout: 20_000 });

        const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>第一章 归来</w:t></w:r></w:p>
<w:p><w:r><w:t>顾言推开城门。</w:t></w:r></w:p>
<w:p><w:r><w:t>第二章 真相</w:t></w:r></w:p>
<w:p><w:r><w:t>门后站着林夏。</w:t></w:r></w:p>
</w:body></w:document>`;
        const docx = Buffer.from(zipSync({ "word/document.xml": strToU8(documentXml) }));
        await page.locator('input[type="file"][accept*=".docx"]').setInputFiles({ name: "章节小说.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });

        const importDialog = page.getByRole("dialog", { name: "导入整本剧本" });
        await expect(importDialog).toBeVisible();
        await expect(importDialog.getByText("第一章 归来", { exact: true })).toBeVisible();
        await expect(importDialog.getByText("第二章 真相", { exact: true })).toBeVisible();
        await importDialog.getByRole("button", { name: "确认导入 2 集" }).click();

        await expect
            .poll(async () => {
                const stored = await dramaProject(request, project.id);
                return stored.episodes.map((episode) => ({ episodeNumber: episode.episodeNumber, title: episode.title, sourceRange: episode.sourceRange, script: episode.script }));
            })
            .toEqual([
                { episodeNumber: 1, title: "第 1 集 · 第一章 归来", sourceRange: "第一章 归来", script: "第一章 归来\n顾言推开城门。" },
                { episodeNumber: 2, title: "第 2 集 · 第二章 真相", sourceRange: "第二章 真相", script: "第二章 真相\n门后站着林夏。" },
            ]);

        await page.getByRole("button", { name: "打开本集设置" }).click();
        const episodeNumber = page.locator("[data-drama-episode-settings]").getByRole("spinbutton", { name: "集数" });
        await expect(episodeNumber).toHaveValue("1");
        await episodeNumber.fill("7");
        await episodeNumber.press("Enter");
        await expect.poll(async () => (await dramaProject(request, project.id)).episodes[0]?.episodeNumber).toBe(7);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("[data-drama-script-workspace]")).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "打开本集设置" }).click();
        await expect(page.locator("[data-drama-episode-settings]").getByRole("spinbutton", { name: "集数" })).toHaveValue("7");
        await expect(page.getByText("第 07 集", { exact: true })).toBeVisible();
    } finally {
        const deleted = await request.delete(`/api/drama/projects/${project.id}`);
        expect(deleted.ok(), await deleted.text()).toBe(true);
    }
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

async function waitForAgentRun(request: APIRequestContext, runId: string) {
    let terminalStatus = "";
    await expect
        .poll(
            async () => {
                const response = await request.get(`/api/agent/runs/${runId}`);
                if (!response.ok()) return `http-${response.status()}`;
                const status = ((await response.json()) as { data: { run: { status: string } } }).data.run.status;
                if (["completed", "failed", "cancelled"].includes(status)) terminalStatus = status;
                return terminalStatus;
            },
            { timeout: 90_000 },
        )
        .not.toBe("");
    expect(terminalStatus).toBe("completed");
}

async function canvasViewport(request: APIRequestContext, projectId: string) {
    const response = await request.get(`/api/canvas/projects/${projectId}`);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { viewport: { x: number; y: number; k: number } } } }).data.project.viewport;
}

async function dramaProject(request: APIRequestContext, projectId: string) {
    const response = await request.get(`/api/drama/projects/${projectId}`);
    expect(response.ok(), await response.text()).toBe(true);
    return (
        (await response.json()) as {
            data: {
                project: {
                    creativeConversationId?: string;
                    episodes: Array<{
                        episodeNumber?: number;
                        title: string;
                        script: string;
                        sourceRange: string;
                        reviewStatus: string;
                        shots: Array<{
                            storyboardStatus?: string;
                            storyboardTaskId?: string;
                            storyboardImageUrl?: string;
                            generationStatus?: string;
                            generationTaskId?: string;
                            videoUrl?: string;
                        }>;
                    }>;
                };
            };
        }
    ).data.project;
}

test("legacy image and video routes hand off to the unified creative Agent", async ({ page }) => {
    for (const route of ["/image", "/video"]) {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/create$/);
        await expect(page.getByRole("heading", { name: "VOZEB PRO 创作 Agent" })).toBeVisible();
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
