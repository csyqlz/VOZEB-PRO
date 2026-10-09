import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import sharp from "sharp";

import { createProtocolFixtureServer } from "../scripts/protocol-fixture-server.mjs";
import { emptyAdvancedConfig } from "../src/lib/channel-protocol-registry";
import { e2eSettingsPatch, pollTask } from "./support";

const MODEL = "gemini-3.1-flash-image";
const NATIVE_SIZE = { width: 4096, height: 2304 };
let fixture: ReturnType<typeof createProtocolFixtureServer>;
let dataDirectory = "";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "vozeb-custom-image-e2e-"));
    const imagePath = path.join(dataDirectory, "native-4k.png");
    await sharp({ create: { ...NATIVE_SIZE, channels: 3, background: { r: 24, g: 132, b: 192 } } })
        .png()
        .toFile(imagePath);
    fixture = createProtocolFixtureServer({ imagePath });
    await new Promise<void>((resolve, reject) => {
        fixture.server.once("error", reject);
        fixture.server.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Custom image fixture did not bind a TCP port");

    const settings = e2eSettingsPatch();
    const operation = {
        capability: "image" as const,
        source: "manual" as const,
        protocol: "custom" as const,
        apiFormat: "openai" as const,
        createPath: "/custom/images",
        editPath: "/custom/images",
        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","references":"{{images}}"}',
        resultField: "data.image_url",
        referenceRule: "base64 inline image references",
        supportsReferenceImage: true,
    };
    const systemChannels = settings.systemChannels.map((channel) => ({
        ...channel,
        models: channel.models.filter((model) => !model.includes("image")),
        advancedConfig: {
            ...channel.advancedConfig,
            modelCapabilities: Object.fromEntries(Object.entries(channel.advancedConfig.modelCapabilities).filter(([, capability]) => capability !== "image")),
            modelConfigs: Object.fromEntries(Object.entries(channel.advancedConfig.modelConfigs).filter(([model]) => !model.includes("image"))),
        },
    }));
    const saved = await request.patch("/api/admin/settings", {
        data: {
            ...settings,
            systemChannels: [
                ...systemChannels,
                {
                    id: "e2e-gemini-custom",
                    name: "E2E Gemini custom",
                    baseUrl: `http://127.0.0.1:${address.port}`,
                    apiKey: "e2e-custom-image-secret",
                    apiFormat: "openai",
                    models: [MODEL],
                    enabled: true,
                    advancedConfig: { ...emptyAdvancedConfig(), ...operation, modelCapabilities: { [MODEL]: "image" }, modelConfigs: { [MODEL]: operation }, operationConfigs: { image: operation } },
                },
            ],
            defaultModels: { ...settings.defaultModels, imageModel: MODEL },
            ecommerceModelRoles: { ...settings.ecommerceModelRoles, image_generation: [] },
            modelPointCosts: { ...settings.modelPointCosts, [MODEL]: 0 },
        },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
});

test.afterEach(async ({ request }) => {
    try {
        const restored = await request.patch("/api/admin/settings", { data: e2eSettingsPatch() });
        expect(restored.ok(), await restored.text()).toBe(true);
    } finally {
        await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
        await rm(dataDirectory, { recursive: true, force: true });
    }
});

function customImageRequestsForPrompt(prompt: string) {
    return fixture.requests.filter((entry) => {
        if (entry.method !== "POST" || entry.path !== "/custom/images") return false;
        try {
            return JSON.parse(entry.body.toString("utf8")).prompt === prompt;
        } catch {
            return false;
        }
    });
}

test("custom Gemini 4K requests preserve native pixels across image task sources and automatic ratio", async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "The shared server task matrix runs once; responsive creation runs on every viewport.");
    const prompt = "Native image resolution fixture " + randomUUID();
    const cases = [
        { source: "image-workbench", size: "16:9" },
        { source: "agent", size: "16:9" },
        { source: "canvas", size: "16:9" },
        { source: "drama", size: "16:9" },
        { source: "image-workbench", size: "auto" },
        { source: "image-workbench", size: "16:9", reference: true },
    ];
    for (const item of cases) {
        const created = await request.post("/api/image-tasks", {
            data: {
                kind: item.reference ? "edit" : "generation",
                config: { model: MODEL, quality: "4k", size: item.size },
                prompt,
                source: item.source,
                context: { clientRequestId: randomUUID() },
                references: item.reference
                    ? [
                          {
                              name: "reference.png",
                              dataUrl: `data:image/png;base64,${(
                                  await sharp({ create: { width: 16, height: 9, channels: 3, background: "#2478bf" } })
                                      .png()
                                      .toBuffer()
                              ).toString("base64")}`,
                          },
                      ]
                    : [],
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const { task } = (await created.json()) as { task: { id: string } };
        const completed = await pollTask(request, `/api/image-tasks/${task.id}`);
        expect(completed).toMatchObject({ status: "success", result: NATIVE_SIZE });
        const result = completed.result as { serverUrl: string };
        const media = await request.get(result.serverUrl);
        expect(media.ok()).toBe(true);
        expect(await sharp(await media.body()).metadata()).toMatchObject(NATIVE_SIZE);
        const upstream = customImageRequestsForPrompt(prompt).at(-1)!;
        const payload = JSON.parse(upstream.body.toString("utf8"));
        expect(payload.model).toBe(`${MODEL}-4k${item.size === "auto" ? "" : "-16x9"}`);
        if (item.reference) expect(payload.references).toHaveLength(1);
    }
    expect(customImageRequestsForPrompt(prompt)).toHaveLength(cases.length);
});

test("custom Gemini image creation sends the 4K suffix and restores the full-size result after reload", async ({ page, request }, testInfo) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByRole("button", { name: /当前创作类型：/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    const preferences = page.locator("[data-creative-generation-preferences]");
    await preferences.getByRole("button", { name: "选择图片尺寸 4K 16:9", exact: true }).click();
    await page.getByRole("button", { name: /^生成参数：/ }).click();
    await page.getByRole("textbox", { name: "描述你想生成或修改的图片" }).fill("生成一张蓝色横版图片");
    const runCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await runCreated;
    expect(response.ok(), await response.text()).toBe(true);
    const { run } = ((await response.json()) as { data: { run: { id: string; conversationId: string } } }).data;
    await expect
        .poll(
            async () => {
                const current = await request.get(`/api/agent/runs/${run.id}`);
                expect(current.ok(), await current.text()).toBe(true);
                return ((await current.json()) as { data: { run: { status: string } } }).data.run.status;
            },
            { timeout: 60_000 },
        )
        .toBe("completed");

    const image = page.getByTestId("creative-media-result").getByTestId("creative-primary-result").getByRole("img");
    await expect(image).toBeVisible();
    const mediaUrl = new URL((await image.getAttribute("src"))!, page.url());
    mediaUrl.search = "";
    const media = await request.get(mediaUrl.href);
    expect(media.ok()).toBe(true);
    expect(await sharp(await media.body()).metadata()).toMatchObject({ width: 3840, height: 2160 });
    const upstream = fixture.requests.filter((entry) => entry.method === "POST" && entry.path === "/custom/images");
    expect(upstream).toHaveLength(1);
    expect(JSON.parse(upstream[0].body.toString("utf8")).model).toBe(`${MODEL}-4k-16x9`);

    await page.goto(`/create?conversationId=${run.conversationId}`, { waitUntil: "domcontentloaded" });
    await expect(image).toBeVisible();
    expect(new URL((await image.getAttribute("src"))!, page.url()).pathname).toBe(mediaUrl.pathname);
    const bounds = await image.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width / bounds!.height).toBeCloseTo(16 / 9, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("custom-gemini-4k.png"), fullPage: true });
});
