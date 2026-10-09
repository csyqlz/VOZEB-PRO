import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { Client } from "pg";
import sharp from "sharp";

import type { Asset } from "../src/lib/library-asset-contract";
import type { ObjectStorageSettings } from "../src/lib/object-storage-contract";
import type { LocalMediaRegistration } from "../src/lib/server/local-media-registry";
import { objectStorageFixture } from "./object-storage-fixture";
import { expectNoHorizontalOverflow } from "./responsive-helpers";

test.use({ ignoreHTTPSErrors: true });

test("object storage CDN settings immediately resolve persisted relative assets on desktop and mobile", async ({ page, request }, testInfo) => {
    const before = await readSettings(request);
    expect(before.hasAccessKeyId, "This test only configures the isolated E2E store").toBe(false);
    expect(before.hasSecretAccessKey).toBe(false);
    expect(before.cdnBaseUrl).toBe("");
    const fixture = await objectStorageFixture();
    const prefix = "cdn-e2e/参考 图";
    const cdnA = `${fixture.cdnOrigin}/cdn-a`;
    const cdnB = `${fixture.cdnOrigin}/cdn-b`;
    const imageRequests: string[] = [];
    page.on("request", (entry) => {
        if (entry.resourceType() === "image" && [fixture.origin, fixture.cdnOrigin].some((origin) => entry.url().startsWith(origin))) imageRequests.push(entry.url());
    });
    let storageKey = "";
    let assetId = "";
    try {
        await page.goto("/admin?section=externalStorage", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const cdnInput = page.getByLabel("CDN 地址前缀", { exact: true });
        await expect(cdnInput).toHaveValue(before.cdnBaseUrl);
        await page.getByLabel("Endpoint", { exact: true }).fill(`${fixture.origin}/s3`);
        await page.getByLabel("Region", { exact: true }).fill("us-east-1");
        await page.getByLabel("Bucket", { exact: true }).fill("e2e-media");
        await page.getByLabel("对象路径前缀", { exact: true }).fill(prefix);
        await cdnInput.fill(`${cdnA}/`);
        await page.getByRole("switch", { name: "切换 Path-style 模式" }).check();
        await page.getByLabel("Access Key", { exact: true }).fill("e2e-oss-access");
        await page.getByLabel("Secret Key", { exact: true }).fill("e2e-oss-secret");
        await page.getByRole("switch", { name: "切换外部存储" }).check();
        await saveSettings(page, request, cdnA);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(cdnInput).toHaveValue(cdnA);
        await cdnInput.scrollIntoViewIfNeeded();
        await expectControlWithinViewport(cdnInput, page);
        await expectNoHorizontalOverflow(page, "object storage settings");
        await page.screenshot({ path: testInfo.outputPath("cdn-settings.png"), fullPage: true });
        await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect(cdnInput).toHaveValue(cdnA);
        await cdnInput.scrollIntoViewIfNeeded();
        await expectControlWithinViewport(cdnInput, page);
        await expectNoHorizontalOverflow(page, "object storage settings dark");
        await page.screenshot({ path: testInfo.outputPath("cdn-settings-dark.png"), fullPage: true });

        const bytes = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#178a77" } })
            .png()
            .toBuffer();
        const uploaded = await request.post("/api/reference-assets", { data: { type: "image", persistent: true, originalName: "E2E CDN image.png", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` } });
        expect(uploaded.ok(), await uploaded.text()).toBe(true);
        const media = (await uploaded.json()) as { url: string; key: string; bytes: number; mimeType: string; upstreamUrl: string };
        storageKey = media.key;
        expect(media.url).toMatch(/^\/api\/reference-assets\/permanent\//);
        const title = `E2E CDN ${testInfo.project.name}`;
        const created = await request.post("/api/library-assets", {
            data: { kind: "image", title, coverUrl: media.url, tags: [], data: { storageKey, serverUrl: media.url, dataUrl: media.url, width: 640, height: 360, bytes: media.bytes, mimeType: media.mimeType } },
        });
        expect(created.ok(), await created.text()).toBe(true);
        assetId = ((await created.json()) as { data: { asset: Asset } }).data.asset.id;
        const persisted = await persistedMedia(storageKey, assetId);
        expect(persisted.registration).toMatchObject({ storageKey, storageProvider: "object", externalObjectKey: `${prefix}/media/reference/${storageKey}` });
        expect(persisted.asset).toMatchObject({ coverUrl: media.url, data: { serverUrl: media.url, dataUrl: media.url, storageKey } });
        expect(JSON.stringify(persisted)).not.toMatch(/https?:\/\/|X-Amz-/);

        await page.goto("/assets", { waitUntil: "domcontentloaded" });
        const thumbnail = page.getByRole("button", { name: `查看 ${title}`, exact: true }).getByRole("img");
        await expectLoadedImage(thumbnail);
        expect(imageRequests.some((url) => url.startsWith(`${cdnA}/`) && url.includes(".vozeb-preview/webp-"))).toBe(true);
        expect(imageRequests.every((url) => !new URL(url).pathname.startsWith("/s3/"))).toBe(true);
        await page.getByRole("button", { name: `查看 ${title}`, exact: true }).click();
        const preview = page.getByRole("dialog", { name: "素材详情" });
        await expectLoadedImage(preview.getByRole("img", { name: title }));
        await preview.evaluate(async (element) => {
            await Promise.all(
                element
                    .getAnimations({ subtree: true })
                    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
                    .map((animation) => animation.finished),
            );
        });
        await expectNoHorizontalOverflow(page, "CDN asset preview");
        await page.screenshot({ path: testInfo.outputPath("cdn-asset-preview.png"), fullPage: true });
        await preview.getByRole("button", { name: "Close", exact: true }).click();

        const original = await request.get(media.url, { maxRedirects: 0 });
        expect(original.status()).toBe(307);
        expect(original.headers().location).toBe(`${cdnA}/${persisted.registration.externalObjectKey.split("/").map(encodeURIComponent).join("/")}`);
        const download = await request.get(`${media.url}?download=original`, { maxRedirects: 0 });
        expect(download.status()).toBe(307);
        expect(download.headers().location).toContain(`${fixture.origin}/s3/e2e-media/`);
        expect(new URL(download.headers().location).searchParams.has("X-Amz-Signature")).toBe(true);
        const provider = await request.get(media.upstreamUrl, { maxRedirects: 0 });
        expect(provider.status()).toBe(307);
        expect(provider.headers().location).toContain(`${fixture.origin}/s3/e2e-media/`);

        await page.goto("/admin?section=externalStorage", { waitUntil: "domcontentloaded" });
        await expect(cdnInput).toHaveValue(cdnA);
        await cdnInput.fill(cdnB);
        await saveSettings(page, request, cdnB);
        const changed = await request.get(media.url, { maxRedirects: 0 });
        expect(changed.headers().location).toBe(original.headers().location.replace(cdnA, cdnB));
        imageRequests.length = 0;
        await page.goto("/assets", { waitUntil: "domcontentloaded" });
        await expectLoadedImage(thumbnail);
        expect(imageRequests.length).toBeGreaterThan(0);
        expect(imageRequests.every((url) => url.startsWith(`${cdnB}/`))).toBe(true);
        expect(await persistedMedia(storageKey, assetId)).toEqual(persisted);

        await page.goto("/admin?section=externalStorage", { waitUntil: "domcontentloaded" });
        await expect(cdnInput).toHaveValue(cdnB);
        await cdnInput.fill("");
        await saveSettings(page, request, "");
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(cdnInput).toHaveValue("");
        expect((await readSettings(request)).cdnBaseUrl).toBe("");
    } finally {
        await page.goto("about:blank");
        try {
            if (assetId) {
                const removed = await request.delete(`/api/library-assets/${assetId}`);
                expect(removed.ok(), await removed.text()).toBe(true);
            } else if (storageKey) {
                const removed = await request.delete("/api/media-assets", { data: { storageKeys: [storageKey] } });
                expect(removed.ok(), await removed.text()).toBe(true);
            }
        } finally {
            const restored = await request.patch("/api/admin/object-storage", { data: { ...before, clearAccessKeyId: true, clearSecretAccessKey: true } });
            await fixture.close();
            expect(restored.ok(), await restored.text()).toBe(true);
        }
    }
});

async function readSettings(request: APIRequestContext) {
    const response = await request.get("/api/admin/object-storage");
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: ObjectStorageSettings }).data;
}

async function saveSettings(page: Page, request: APIRequestContext, cdnBaseUrl: string) {
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/object-storage" && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存外部存储配置" }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.getByLabel("CDN 地址前缀", { exact: true })).toHaveValue(cdnBaseUrl);
    expect((await readSettings(request)).cdnBaseUrl).toBe(cdnBaseUrl);
    await expect(page.getByLabel("当前密码")).toHaveCount(0);
}

async function expectLoadedImage(image: Locator) {
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);
}

async function expectControlWithinViewport(control: Locator, page: Page) {
    const rect = await control.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.width).toBeGreaterThan(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function persistedMedia(storageKey: string, assetId: string) {
    const databaseUrl = process.env.VOZEB_PRO_E2E_DATABASE_URL?.trim();
    if (databaseUrl) {
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        try {
            const registration = (await client.query("SELECT storage_key, storage_provider, external_object_key FROM vozeb_pro_local_media_assets WHERE storage_key = $1", [storageKey])).rows[0];
            const asset = (await client.query<{ asset_json: Asset }>("SELECT asset_json FROM vozeb_pro_library_assets WHERE id = $1", [assetId])).rows[0]?.asset_json;
            return { registration: { storageKey: registration.storage_key as string, storageProvider: registration.storage_provider as string, externalObjectKey: registration.external_object_key as string }, asset };
        } finally {
            await client.end();
        }
    }
    const readJson = async (file: string) => JSON.parse(await readFile(path.join(process.cwd(), ".e2e-data", file), "utf8"));
    const registrations = (await readJson("local-media-assets.json")) as { assets: LocalMediaRegistration[] };
    const library = (await readJson("library-assets.json")) as { assets: Array<{ asset: Asset }> };
    const registration = registrations.assets.find((item) => item.storageKey === storageKey)!;
    return { registration: { storageKey: registration.storageKey, storageProvider: registration.storageProvider, externalObjectKey: registration.externalObjectKey! }, asset: library.assets.find((item) => item.asset.id === assetId)?.asset };
}
