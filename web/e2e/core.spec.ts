import { createHash, createHmac, randomUUID } from "node:crypto";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { createCanvasProject, deleteCanvasProject, expectCanvasSaved, readCanvasProject } from "./canvas-e2e-helpers";
import { dataeyesSeedreamProtocol } from "../src/lib/dataeyes-seedream-protocol";
import { applyChannelProtocol } from "../src/lib/channel-protocol-registry";
import { E2E_ADMIN, E2E_PAYMENT_WEBHOOK_SECRET, E2E_PROTOCOL_ORIGIN, e2eSettingsPatch, pollTask, protocolFixtureState, resetProtocolFixture } from "./support";

const e2eDataDir = process.env.VOZEB_PRO_DATA_DIR || path.join(process.cwd(), ".e2e-data");

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    await resetProtocolFixture(request);
});

test("pricing workbench keeps two logical models that share one channel SKU", async ({ page, request }) => {
    const response = await request.get("/api/admin/settings");
    expect(response.ok()).toBe(true);
    const original = ((await response.json()) as { settings: { logicalModels: Array<{ id: string; name: string; bindings: Array<{ id: string }> }> } }).settings.logicalModels;
    const source = original.find((model) => model.id === "e2e-image");
    expect(source).toBeDefined();
    const duplicate = { ...source!, id: "e2e-image-premium", name: "E2E Image Premium", bindings: source!.bindings.map((binding) => ({ ...binding, id: `${binding.id}-premium` })) };
    try {
        expect((await request.patch("/api/admin/settings", { data: { logicalModels: [...original, duplicate] } })).ok()).toBe(true);
        const saved = ((await (await request.get("/api/admin/settings")).json()) as { settings: { logicalModels: Array<{ id: string }> } }).settings.logicalModels;
        expect(saved.map((model) => model.id)).toEqual(expect.arrayContaining(["e2e-image", "e2e-image-premium"]));
        await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const search = page.getByLabel("工作台模型搜索");
        await search.fill("e2e-image-premium");
        for (const width of [1440, 390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            const row = page.getByTestId("pricing-model-e2e-image-premium");
            await expect(row).toBeVisible();
            expect(
                await row.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.left >= 0 && rect.right <= window.innerWidth + 1;
                }),
            ).toBe(true);
        }
    } finally {
        expect((await request.patch("/api/admin/settings", { data: { logicalModels: original } })).ok()).toBe(true);
    }
});

test("model pricing workbench keeps filters while opening model, evidence and rule views", async ({ page }) => {
    const pricingLoaded = page.waitForResponse((response) => response.url().includes("/api/admin/model-pricing?") && response.ok());
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await pricingLoaded;
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByRole("heading", { name: "模型工作台" })).toBeVisible();
    const search = page.getByLabel("工作台模型搜索");
    await search.fill("e2e-text");
    await search.press("Enter");
    const workbench = page.locator("section").filter({ has: page.getByRole("heading", { name: "模型工作台" }) });
    await expect(workbench.getByText("e2e-text", { exact: true }).first()).toBeVisible();
    await workbench.getByRole("button", { name: "查看与处理" }).first().click();
    const modelDrawer = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await expect(modelDrawer.getByTestId("pricing-primary-action")).toHaveCount(1);
    await expect(modelDrawer.getByRole("button", { name: "该模型计价条件" })).toBeVisible();
    await modelDrawer.getByRole("button", { name: "渠道绑定", exact: true }).click();
    await expect(modelDrawer).toContainText("当前收费");
    await modelDrawer.locator(".ant-drawer-close").click();
    await expect(search).toHaveValue("e2e-text");
    await workbench.getByRole("button", { name: /文本计费异常/ }).click();
    const exceptions = page.getByRole("dialog", { name: "全部模型的文本计费异常" });
    await expect(exceptions.getByLabel("异常模型筛选")).toBeVisible();
    await expect(exceptions.getByLabel("异常渠道 ID 筛选")).toBeVisible();
    await expect(exceptions.getByLabel("异常状态筛选")).toBeVisible();
    await exceptions.locator(".ant-drawer-close").click();
    const pendingBindings = workbench.getByRole("button", { name: /待验收渠道/ });
    await expect(pendingBindings).toHaveText(/待验收渠道 · \d+ 个启用绑定/);
    const pendingFilterLoaded = page.waitForResponse((response) => new URL(response.url()).searchParams.get("workbenchStatus") === "channel-pending" && response.ok());
    await pendingBindings.click();
    await pendingFilterLoaded;
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await expect(page.getByRole("heading", { name: "待审价目候选" })).toBeVisible();
    await page.getByRole("button", { name: "已审核版本" }).click();
    await expect(page.getByRole("heading", { name: "已审核价目记录" })).toBeVisible();
    await page.getByRole("button", { name: "官网来源链接" }).click();
    await expect(page.getByText(/官网价格链接 ·/)).toBeVisible();
    await page.getByRole("button", { name: "售价规则与折算" }).click();
    await expect(page.getByRole("heading", { name: "用户售价系数" })).toBeVisible();
    await page.getByRole("button", { name: "汇率与币种折算" }).click();
    await expect(page.getByRole("heading", { name: "官网价格折算为美元" })).toBeVisible();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
});

test("independent image sale draft and saved evidence stay scoped to the selected operation", async ({ page }) => {
    const modelId = "e2e-image";
    const versionId = "e2e-independent-image-price";
    let pendingEvidence = false;
    let publishedSaleId = "sale";
    let publishedCoefficient = "2";
    await page.route("**/api/admin/model-pricing", async (route) => {
        const body = route.request().postDataJSON();
        if (route.request().method() === "POST" && body?.action === "preview")
            return route.fulfill({
                json: {
                    code: 0,
                    msg: "ok",
                    data: {
                        policy: body.policy,
                        selectedBinding: body.policy.selectedPriceBindings.find((item: { scope: string }) => item.scope === body.scope),
                        quote: { points: "84.00", lines: [] },
                        currentSalesVersionId: publishedSaleId,
                        previewToken: "fixture-preview",
                    },
                },
            });
        if (route.request().method() === "PATCH" && body?.action === "publish") {
            publishedSaleId = "sale-next";
            publishedCoefficient = "3";
            return route.fulfill({ json: { code: 0, msg: "ok", data: { ...body.policy, id: publishedSaleId, publishedBy: "fixture", publishedAt: "2026-10-20T00:00:00Z" } } });
        }
        if (route.request().method() === "PATCH" && body?.action === "revalue-image-evidence") return route.fulfill({ json: { code: 0, msg: "ok", data: { revalued: 0, status: { ready: false } } } });
        return route.continue();
    });
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("action") === "activation" && url.searchParams.get("modelId") === modelId)
            return route.fulfill({
                json: {
                    code: 0,
                    msg: "ok",
                    data: {
                        admission: {
                            modelId,
                            capability: "image",
                            officialVersionId: versionId,
                            structuralComplete: true,
                            fingerprint: "fixture",
                            salesVersionId: "sale",
                            blockers: [],
                            bindings: pendingEvidence ? [{ key: "e2e-primary/e2e-image", channelName: "E2E 主渠道", fingerprint: "binding", contractIds: ["contract"], operationContracts: [], blockers: [] }] : [],
                            contractIds: ["contract"],
                        },
                        activation: null,
                        shadow: { ready: !pendingEvidence, missingCount: pendingEvidence ? 1 : 0 },
                        bindings: pendingEvidence
                            ? [{ key: "e2e-primary/e2e-image", channelName: "E2E 主渠道", fingerprint: "binding", contractIds: ["contract"], operationContracts: [], blockers: [], shadow: { ready: false, missingCount: 1 }, active: false }]
                            : [],
                        active: false,
                    },
                },
            });
        if (url.searchParams.has("action")) return route.continue();
        const response = await route.fetch();
        const payload = await response.json();
        const data = payload.data;
        data.boundVersions = [
            ...data.boundVersions,
            { id: versionId, logicalModelId: "", capability: "image", manufacturer: "Fixture", series: "Image", officialVersion: "fixture", sku: modelId, tier: "paid", items: [{ key: "image", unit: "image", per: "1", price: "0.04", currency: "USD" }] },
        ];
        data.salesVersions = [
            {
                id: publishedSaleId,
                publishedAt: "2026-10-01T00:00:00Z",
                publishedBy: "fixture",
                priceVersionIds: {},
                selectedPriceBindings: ["generations", "edits"].map((operation) => ({ logicalModelId: modelId, scope: `image:${operation}:standard`, bindingId: `binding-${operation}`, bindingRevision: "revision", officialVersionId: versionId })),
                userPriceRules: [{ scope: "model", modelId, coefficient: publishedCoefficient }],
                conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: "2026-10-01T00:00:00Z", evidence: "fixture" },
                usdPerCurrency: { USD: "1" },
                pointsPerCurrency: { USD: "700", CNY: "100" },
                rateEvidence: { USD: "fixture" },
            },
        ];
        data.currentSalesVersionId = publishedSaleId;
        return route.fulfill({ response, json: payload });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    const search = page.getByLabel("工作台模型搜索");
    await search.fill(modelId);
    await search.press("Enter");
    await page.getByTestId(`pricing-model-${modelId}`).getByRole("button", { name: "查看与处理" }).click();
    const drawer = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await drawer.getByRole("button", { name: "渠道绑定", exact: true }).click();
    const status = drawer.getByTestId("model-billing-status");
    await expect(status.getByText("可启用")).toBeVisible();
    await expect(status.getByRole("button", { name: "启用按量扣分" })).toBeEnabled();
    await drawer.getByRole("button", { name: "该模型计价条件" }).click();
    await drawer.getByLabel("独立选价用户售价系数").fill("3");
    await drawer.getByRole("button", { name: "渠道绑定", exact: true }).click();
    await expect(status.getByText("待核对")).toBeVisible();
    await expect(status.getByRole("button", { name: "启用按量扣分" })).toBeDisabled();
    await drawer.getByRole("button", { name: "该模型计价条件" }).click();
    await drawer.getByLabel("独立选价用户售价系数").fill("2");
    await drawer.getByRole("button", { name: "渠道绑定", exact: true }).click();
    await expect(status.getByText("可启用")).toBeVisible();
    pendingEvidence = true;
    await status.getByRole("button", { name: "刷新状态" }).click();
    const revalueButton = status.getByRole("button", { name: "复核已有调用" });
    await expect(revalueButton).toBeVisible();
    const generationRequest = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith("/api/admin/model-pricing"));
    await revalueButton.click();
    expect((await generationRequest).postDataJSON()).toMatchObject({ action: "revalue-image-evidence", modelId, imageOperation: "generations" });
    await drawer.getByRole("combobox", { name: "图片按量计价操作" }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("图片编辑", { exact: true }).click();
    await expect(status).toContainText("图片编辑当前收费");
    await expect(revalueButton).toBeVisible();
    const editRequest = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith("/api/admin/model-pricing"));
    await revalueButton.click();
    expect((await editRequest).postDataJSON()).toMatchObject({ action: "revalue-image-evidence", modelId, imageOperation: "edits" });
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect
            .poll(async () => {
                const rect = await drawer.boundingBox();
                return Boolean(rect && rect.x >= 0 && rect.x + rect.width <= width && (await page.evaluate(() => document.documentElement.scrollWidth)) <= width);
            })
            .toBe(true);
        const button = await revalueButton.boundingBox();
        expect(button && button.x >= 0 && button.x + button.width <= width).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await drawer.getByRole("button", { name: "该模型计价条件" }).click();
    await drawer.getByLabel("独立选价用户售价系数").fill("3");
    await drawer.getByLabel("样例用量 image").fill("1");
    await drawer.getByRole("button", { name: "按样例用量预览" }).click();
    await expect(drawer.getByText("样例应收 84.00 积分", { exact: false })).toBeVisible();
    const publishRequest = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith("/api/admin/model-pricing") && request.postDataJSON()?.action === "publish");
    await drawer.getByRole("button", { name: "发布销售版本" }).click();
    await page
        .getByRole("dialog", { name: "发布新的用户销售版本？" })
        .getByRole("button", { name: /确\s*定/ })
        .click();
    const submitted = (await publishRequest).postDataJSON();
    expect(submitted.currentSalesVersionId).toBe("sale");
    expect(submitted.policy.selectedPriceBindings).toEqual([expect.objectContaining({ logicalModelId: modelId, scope: "image:generations:standard" }), expect.objectContaining({ logicalModelId: modelId, scope: "image:edits:standard" })]);
    expect(submitted.policy.userPriceRules).toContainEqual({ scope: "model", modelId, coefficient: "3" });
});

test("independent image Token contract records a reviewed channel alias across widths", async ({ page }) => {
    const versionId = "e2e-image-alias-price";
    const version = {
        id: versionId,
        logicalModelId: "",
        capability: "image",
        manufacturer: "Fixture",
        series: "Image",
        officialVersion: "alias-fixture",
        sku: "official-image",
        tier: "paid",
        conditions: "本地夹具：直接 Images Token",
        sourceUrl: "https://example.com/pricing",
        publishedAt: "2026-10-20T00:00:00Z",
        reviewedBy: "fixture",
        items: [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
    };
    let saved: Record<string, unknown> | undefined;
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("action") === "selection-binding" && url.searchParams.get("modelId") === "e2e-image" && url.searchParams.get("scope") === "image:generations:standard")
            return route.fulfill({
                json: {
                    code: 0,
                    msg: "ok",
                    data: {
                        id: "price-binding",
                        revision: "revision",
                        logicalModelId: "e2e-image",
                        capability: "image",
                        operation: "generations",
                        processingMode: "standard",
                        scope: "image:generations:standard",
                        officialVersionId: versionId,
                        status: "active",
                        current: true,
                        version,
                    },
                },
            });
        if (url.searchParams.has("action")) return route.continue();
        const response = await route.fetch();
        const payload = await response.json();
        payload.data.boundVersions = [...payload.data.boundVersions, version];
        return route.fulfill({ response, json: payload });
    });
    await page.route("**/api/admin/model-pricing/image-contracts**", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON();
            expect(body).toMatchObject({
                officialVersionId: versionId,
                logicalModelId: "e2e-image",
                contract: {
                    requestedModel: "e2e-image",
                    identity: { channelBindingId: "image-channel-binding", officialSku: version.sku, operation: "generations", sourceUrl: "https://example.com/image-identity", evidence: "渠道请求型号与官网 SKU 已核对" },
                    holdEstimates: [
                        { quality: "low", size: "1024x1024", meterQuantities: { inputTextTokens: "1000" } },
                        { quality: "medium", size: "2048x2048", meterQuantities: { outputImageTokens: "2000" } },
                        { quality: "low", size: "auto", observedSize: "1536x1024", meterQuantities: { outputImageTokens: "343" } },
                    ],
                },
            });
            saved = { ...body.contract, id: "saved-alias-contract", current: true, officialVersionId: versionId, reviewedBy: "fixture", reviewedAt: "2026-10-20T00:00:00Z" };
            return route.fulfill({ json: { code: 0, msg: "ok", data: saved } });
        }
        if (url.searchParams.has("channelId")) return route.fulfill({ json: { code: 0, msg: "ok", data: { version, contracts: saved ? [saved] : [] } } });
        return route.fulfill({
            json: {
                code: 0,
                msg: "ok",
                data: {
                    version,
                    bindings: [{ channelBindingId: "image-channel-binding", channelId: "e2e-primary", channelName: "E2E 主渠道", requestedModel: "e2e-image", selectedOperations: ["generations", "edits"], imageCountOperations: [] }],
                    meters: ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"],
                },
            },
        });
    });
    const open = async () => {
        const pricingLoaded = page.waitForResponse((response) => response.url().includes("/api/admin/model-pricing?") && response.ok());
        await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
        await pricingLoaded;
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await selectSalesModel(page, "e2e-image", "Fixture", "image");
        await page.getByRole("button", { name: "核对图片用量契约" }).click();
        return page.getByRole("dialog", { name: "核对图片用量契约" });
    };
    let drawer = await open();
    await expect(drawer.getByText("渠道型号身份：e2e-image → official-image · generations")).toBeVisible();
    await drawer.getByLabel("图片契约响应型号").fill("official-image");
    await drawer.getByRole("checkbox", { name: "图片 tokens 映射 inputTextTokens", exact: true }).check();
    await drawer.getByRole("checkbox", { name: "图片 tokens 映射 inputImageTokens", exact: true }).check();
    await drawer.getByRole("checkbox", { name: "图片 tokens 映射 outputTextTokens", exact: true }).check();
    await drawer.getByRole("checkbox", { name: "图片 tokens 映射 outputImageTokens", exact: true }).check();
    await drawer.getByLabel("图片预留档位 1 尺寸").fill("1024x1024");
    for (const meter of ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"]) await drawer.getByLabel(`图片预留档位 1 ${meter}`).fill(meter === "inputTextTokens" ? "1000" : "0");
    await drawer.getByLabel("图片预留档位 1 来源").fill("https://example.com/image-estimate");
    await drawer.getByLabel("图片预留档位 1 依据").fill("已核对 low / 1024x1024 单请求估算");
    await drawer.getByRole("button", { name: "添加档位" }).click();
    await drawer.getByLabel("图片预留档位 2 画质").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "medium" }).click();
    await drawer.getByLabel("图片预留档位 2 尺寸").fill("2048x2048");
    for (const meter of ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"]) await drawer.getByLabel(`图片预留档位 2 ${meter}`).fill(meter === "outputImageTokens" ? "2000" : "0");
    await drawer.getByLabel("图片预留档位 2 来源").fill("https://example.com/image-estimate-medium");
    await drawer.getByLabel("图片预留档位 2 依据").fill("已核对 medium / 2048x2048 单请求估算");
    await drawer.getByRole("button", { name: "添加档位" }).click();
    await drawer.getByLabel("图片预留档位 3 尺寸").fill("auto");
    for (const meter of ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"]) await drawer.getByLabel(`图片预留档位 3 ${meter}`).fill(meter === "outputImageTokens" ? "343" : "0");
    await drawer.getByLabel("图片预留档位 3 来源").fill("https://example.com/image-auto-estimate");
    await drawer.getByLabel("图片预留档位 3 依据").fill("已核对 low / auto 单请求估算");
    await drawer.getByLabel("图片契约核对依据").fill("直接 Images 用量已核对");
    await expect(drawer.getByRole("button", { name: "审核并保存图片契约" })).toBeDisabled();
    await drawer.getByLabel("图片渠道别名身份来源").fill("https://example.com/image-identity");
    await drawer.getByLabel("图片渠道别名核对依据").fill("渠道请求型号与官网 SKU 已核对");
    await expect(drawer.getByRole("button", { name: "审核并保存图片契约" })).toBeDisabled();
    await drawer.getByLabel("图片预留档位 3 样本输出尺寸").fill("1536x1024");
    await expect(drawer.getByRole("button", { name: "审核并保存图片契约" })).toBeEnabled();
    await drawer.getByRole("button", { name: "审核并保存图片契约" }).click();
    await expect(drawer.getByText(/已核对别名：e2e-image → official-image/)).toBeVisible();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        drawer = await open();
        await expect(drawer.getByLabel("图片渠道别名身份来源")).toHaveValue("https://example.com/image-identity");
        await expect
            .poll(async () => {
                const bounds = await drawer.boundingBox();
                return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
            })
            .toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
});

test("official price entry can reuse reviewed item structure without copying prices or evidence", async ({ page }) => {
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("action") !== "structure-references") return route.continue();
        return route.fulfill({
            json: {
                code: 0,
                msg: "ok",
                data: [
                    {
                        id: "reviewed-reference",
                        logicalModelId: "e2e-text-fallback",
                        manufacturer: "Fixture",
                        series: "Text",
                        officialVersion: "source-v1",
                        sku: "source-sku",
                        tier: "paid",
                        conditions: "source-only condition",
                        sourceKind: "manual",
                        sourceUrl: "https://example.com/source",
                        evidence: "source-only evidence",
                        observedAt: "2026-01-01T00:00:00Z",
                        publishedAt: "2026-01-01T00:00:00Z",
                        reviewedBy: "admin",
                        candidateId: "old",
                        items: [
                            { key: "inputTokens", unit: "token", per: "1000000", price: "2", currency: "USD", condition: "source-only item condition" },
                            { key: "outputTokens", unit: "token", per: "1000000", price: "8", currency: "USD" },
                        ],
                    },
                ],
            },
        });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "录入官方价目" }).click();
    const form = page.getByRole("dialog", { name: "录入官方价目候选" });
    await form.getByLabel("官方价模型能力").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "文本" }).first().click();
    await form.getByLabel("官方厂商").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "OpenAI" }).first().click();
    await form.getByLabel("官方模型 ID／产品标识").fill("target-sku");
    await form.getByLabel("官方价证据").fill("target evidence");
    await form.getByRole("button", { name: "添加计费项目" }).click();
    await form.getByLabel("项目 1 单价").fill("9");
    await form.getByRole("button", { name: "引用已审核分项结构" }).click();
    await expect(form.getByText("source-sku", { exact: false })).toBeVisible();
    await form.getByRole("button", { name: "用此结构创建草稿" }).click();
    await page.getByRole("dialog", { name: "替换当前分项草稿？" }).getByRole("button", { name: "替换分项" }).click();
    await expect(form.getByLabel("项目 1 标识")).toHaveValue("inputTokens");
    await expect(form.getByLabel("项目 2 标识")).toHaveValue("outputTokens");
    await expect(form.getByLabel("项目 1 单价")).toHaveValue("");
    await expect(form.getByLabel("项目 1 币种")).toHaveValue("");
    await expect(form.getByLabel("项目 1 适用条件")).toHaveValue("");
    await expect(form.getByLabel("项目 1 报价数量")).toHaveValue("1000000");
    await expect(form.getByLabel("官方模型 ID／产品标识")).toHaveValue("target-sku");
    await expect(form.getByLabel("官方价证据")).toHaveValue("target evidence");
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
});

test("BytePlus manual price entry offers verified video conditions while retaining editable evidence", async ({ page }) => {
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        if (new URL(route.request().url()).searchParams.has("action")) return route.continue();
        const response = await route.fetch();
        const payload = (await response.json()) as { data: { models: Array<{ id: string; name: string; capability: string; manufacturer: string; series: string }> } };
        payload.data.models.push({ id: "ByteDance-Seedance-2.5", name: "ByteDance-Seedance-2.5", capability: "video", manufacturer: "ByteDance / Volcengine", series: "Seedance" });
        await route.fulfill({ response, json: payload });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "录入官方价目" }).click();
    const form = page.getByRole("dialog", { name: "录入官方价目候选" });
    await form.getByLabel("官方价模型能力").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "视频" }).first().click();
    await form.getByLabel("官方厂商").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "ByteDance / Volcengine" }).first().click();
    await form.getByLabel("官方模型 ID／产品标识").fill("dreamina-seedance-2-5-260628");
    await form.getByLabel("价目适用条件").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "在线推理 · 视频生成" }).click();
    await form.getByRole("button", { name: "添加计费项目" }).click();
    await form.getByLabel("项目 1 适用条件").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "输出 1080p · 含输入视频" }).click();
    await expect(form.getByLabel("项目 1 适用条件")).toHaveValue("输出 1080p · 含输入视频");
    await form.getByLabel("项目 1 适用条件").fill("官网另有条件");
    await expect(form.getByLabel("项目 1 适用条件")).toHaveValue("官网另有条件");
    await page.keyboard.press("Escape");
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
});

test("official price entry optionally imports editable reference prices and requires per-item review", async ({ page }) => {
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("action") !== "structure-references") return route.continue();
        return route.fulfill({
            json: {
                code: 0,
                msg: "ok",
                data: [
                    {
                        id: "reviewed-price-reference",
                        logicalModelId: "e2e-text-fallback",
                        manufacturer: "Fixture",
                        series: "Text",
                        officialVersion: "source-v1",
                        sku: "source-sku",
                        tier: "paid",
                        conditions: "old condition",
                        sourceKind: "manual",
                        sourceUrl: "https://example.com/source",
                        evidence: "old evidence",
                        observedAt: "2026-01-01T00:00:00Z",
                        publishedAt: "2026-01-01T00:00:00Z",
                        reviewedBy: "admin",
                        candidateId: "old",
                        items: [{ key: "inputTokens", unit: "token", per: "1000000", price: "2.5", currency: "USD", condition: "old item condition" }],
                    },
                ],
            },
        });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "录入官方价目" }).click();
    const form = page.getByRole("dialog", { name: "录入官方价目候选" });
    await form.getByLabel("官方价模型能力").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "文本" }).first().click();
    await form.getByLabel("官方厂商").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "OpenAI" }).first().click();
    await form.getByRole("button", { name: "引用已审核分项结构" }).click();
    await form.getByRole("button", { name: "带入结构和参考价" }).click();
    await expect(form.getByLabel("项目 1 单价")).toHaveValue("2.5");
    await expect(form.getByLabel("项目 1 币种")).toHaveValue("USD");
    await expect(form.getByLabel("项目 1 适用条件")).toHaveValue("");
    const submit = form.getByRole("button", { name: "提交待审核" });
    await expect(submit).toBeDisabled();
    await form.getByRole("checkbox", { name: "已核对目标型号的本项价格与币种" }).check();
    await expect(submit).toBeEnabled();
    await form.getByLabel("项目 1 单价").fill("3");
    await expect(submit).toBeDisabled();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
});

test("official series catalog can be maintained independently of price candidates", async ({ page }) => {
    const entries: Array<Record<string, unknown>> = [];
    await page.route("**/api/admin/model-pricing/catalog?*", async (route) => {
        const id = new URL(route.request().url()).searchParams.get("impactId");
        const data = id ? { pending: 0, approved: 0, called: false, childVersions: entries.filter((entry) => entry.parentId === id).length } : entries;
        return route.fulfill({ json: { code: 0, msg: "ok", data } });
    });
    await page.route("**/api/admin/model-pricing/catalog", async (route) => {
        const method = route.request().method();
        const input = route.request().postDataJSON();
        if (method === "PATCH") {
            const index = entries.findIndex((entry) => entry.id === input.id);
            if (index < 0) return route.fulfill({ status: 409, json: { code: 409, msg: "目录项已变化", data: null } });
            const changes = { ...input };
            delete changes.expected;
            entries[index] = { ...entries[index], ...changes, updatedAt: new Date().toISOString(), updatedBy: "admin" };
            return route.fulfill({ json: { code: 0, msg: "ok", data: entries[index] } });
        }
        if (method === "DELETE") {
            const index = entries.findIndex((entry) => entry.id === input.id);
            if (index < 0) return route.fulfill({ status: 409, json: { code: 409, msg: "目录项已变化", data: null } });
            entries.splice(index, 1);
            return route.fulfill({ json: { code: 0, msg: "ok", data: { id: input.id } } });
        }
        if (method !== "POST") return route.continue();
        const entry = { ...input, id: `catalog-${entries.length + 1}`, createdAt: new Date().toISOString(), createdBy: "admin", parentId: input.parentId || null };
        entries.push(entry);
        return route.fulfill({ json: { code: 0, msg: "ok", data: entry } });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "官方型号目录" }).click();
    await page.getByRole("button", { name: "新增系列" }).click();
    const drawer = page.getByRole("dialog", { name: "新增官方系列" });
    await drawer.getByLabel("目录名称").fill("GPT 新系列");
    await drawer.getByLabel("目录官网命名依据").fill("官网系列名称证据");
    await drawer.getByRole("button", { name: "保存到目录" }).click();
    await expect(page.getByText("GPT 新系列", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新增官方型号" }).click();
    const versionDrawer = page.getByRole("dialog", { name: "新增官网型号/版本" });
    await versionDrawer.getByLabel("目录名称").fill("gpt-new");
    await versionDrawer.getByLabel("目录官方模型 ID").fill("gpt-new");
    await versionDrawer.getByLabel("目录官网命名依据").fill("官网型号证据");
    await versionDrawer.getByRole("button", { name: "保存到目录" }).click();
    await expect(page.getByText("gpt-new", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "gpt-new 操作菜单" }).click();
    await page.getByRole("menuitem", { name: "修改目录名称与证据" }).click();
    const editDrawer = page.getByRole("dialog", { name: "修改官网型号/版本" });
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(async () => (await editDrawer.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(width);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await editDrawer.getByLabel("目录名称").fill("gpt-newer");
    await editDrawer.getByRole("button", { name: "保存到目录" }).click();
    await expect(page.getByText("gpt-newer", { exact: true })).toBeVisible();
    await page.getByText("gpt-newer", { exact: true }).click();
    await expect(page.getByRole("dialog", { name: "官网型号详情" })).toContainText("目录引用：待审 0 条");
    await page.getByRole("dialog", { name: "官网型号详情" }).locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "gpt-newer 操作菜单" }).click();
    await page.getByRole("menuitem", { name: "删除未引用项" }).click();
    await page.getByRole("button", { name: "删除目录项" }).click();
    await expect(page.getByText("gpt-newer", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "GPT 新系列 操作菜单" }).click();
    await page.getByRole("menuitem", { name: "删除未引用项" }).click();
    await page.getByRole("button", { name: "删除目录项" }).click();
    await expect(page.getByText("GPT 新系列", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "新增官方型号" }).click();
    const ungroupedDrawer = page.getByRole("dialog", { name: "新增官网型号/版本" });
    await ungroupedDrawer.getByLabel("目录名称").fill("gpt-ungrouped");
    await ungroupedDrawer.getByLabel("目录官方模型 ID").fill("gpt-ungrouped");
    await ungroupedDrawer.getByLabel("目录官网命名依据").fill("官网独立型号证据");
    await ungroupedDrawer.getByRole("button", { name: "保存到目录" }).click();
    await expect(page.getByText("gpt-ungrouped", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "gpt-ungrouped 操作菜单" }).click();
    await page.getByRole("menuitem", { name: "删除未引用项" }).click();
    await page.getByRole("button", { name: "删除目录项" }).click();
    expect(entries).toHaveLength(0);
});

test("official series suggestions start with matching catalog capability and reveal historical names on demand", async ({ page }) => {
    await page.route("**/api/admin/model-pricing/catalog?*", async (route) =>
        route.fulfill({
            json: {
                code: 0,
                msg: "ok",
                data: [
                    { id: "text-series", manufacturer: "OpenAI", kind: "series", name: "Text verified", capability: "text", parentId: null },
                    { id: "image-series", manufacturer: "OpenAI", kind: "series", name: "Image irrelevant", capability: "image", parentId: null },
                ],
            },
        }),
    );
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("action") !== "references") return route.continue();
        return route.fulfill({ json: { code: 0, msg: "ok", data: { series: ["Historical text"], versions: [], approved: [], pending: [] } } });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "录入官方价目" }).click();
    const form = page.getByRole("dialog", { name: "录入官方价目候选" });
    await form.getByLabel("官方价模型能力").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "文本" }).first().click();
    await form.getByRole("combobox", { name: "官方厂商" }).fill("OpenAI");
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "OpenAI" }).first().click();
    await form.getByRole("combobox", { name: "官方系列" }).fill("");
    const suggestions = page.locator(".ant-select-dropdown:visible").last();
    await expect(suggestions).toContainText("Text verified");
    await expect(suggestions).not.toContainText("Image irrelevant");
    await form.getByRole("button", { name: "查看历史建议" }).click();
    await form.getByRole("combobox", { name: "官方系列" }).fill("");
    await expect(suggestions).toContainText("Historical text");
});

test("official models can be found and selected before choosing a series", async ({ page }) => {
    await page.route("**/api/admin/model-pricing/catalog?*", async (route) =>
        route.fulfill({
            json: {
                code: 0,
                msg: "ok",
                data: [
                    { id: "group", manufacturer: "OpenAI", kind: "series", name: "Grouped", capability: "text", parentId: null },
                    { id: "grouped-model", manufacturer: "OpenAI", kind: "version", name: "grouped-model", sku: "grouped-sku", parentId: "group", sourceUrl: "https://openai.com/grouped" },
                    { id: "ungrouped-model", manufacturer: "OpenAI", kind: "version", name: "ungrouped-model", sku: "ungrouped-sku", capability: "text", parentId: null, sourceUrl: "https://openai.com/ungrouped" },
                ],
            },
        }),
    );
    const pricingLoaded = page.waitForResponse((response) => response.url().includes("/api/admin/model-pricing?") && response.ok());
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await pricingLoaded;
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "官方型号目录" }).click();
    await page.getByRole("combobox", { name: "目录官方厂商" }).fill("OpenAI");
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "OpenAI" }).first().click();
    const catalog = page.locator("section").filter({ has: page.getByRole("heading", { name: "官方型号目录" }) });
    await expect(catalog.getByText("grouped-model", { exact: true })).toBeVisible();
    await expect(catalog.getByText("ungrouped-model", { exact: true })).toBeVisible();
    await catalog.getByLabel("目录搜索型号").fill("ungrouped-sku");
    await expect(catalog.getByText("grouped-model", { exact: true })).toHaveCount(0);
    await expect(catalog.getByText("ungrouped-model", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "待审价目" }).click();
    await page.getByRole("button", { name: "录入官方价目" }).click();
    const form = page.getByRole("dialog", { name: "录入官方价目候选" });
    await form.getByLabel("官方价模型能力").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "文本" }).first().click();
    await form.getByRole("combobox", { name: "官方厂商" }).fill("OpenAI");
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "OpenAI" }).first().click();
    await form.getByRole("combobox", { name: "选择目录官网型号" }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "grouped-sku" }).first().click();
    await expect(form.getByRole("combobox", { name: "官方系列" })).toHaveValue("Grouped");
    await expect(form.getByRole("combobox", { name: "官方模型版本" })).toHaveValue("grouped-model");
    await expect(form.getByLabel("官方模型 ID／产品标识")).toHaveValue("grouped-sku");
    await expect(form.getByLabel("官方 HTTPS 来源")).toHaveValue("https://openai.com/grouped");
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect((await form.boundingBox())?.width).toBeLessThanOrEqual(width);
    }
});

test("approved price list supports numbered pages and direct page selection", async ({ page }) => {
    const requestedPages: number[] = [];
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("action")) return route.continue();
        requestedPages.push(Number(url.searchParams.get("officialPage") || 1));
        const response = await route.fetch();
        const body = await response.json();
        body.data.approvedTotal = 45;
        await route.fulfill({ response, json: body });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "已审核版本" }).click();
    const approved = page.locator("section").filter({ has: page.getByRole("heading", { name: "已审核价目记录" }) });
    await approved.locator(".ant-pagination-item", { hasText: "2" }).click();
    await expect.poll(() => requestedPages.at(-1)).toBe(2);
    await expect(approved.locator(".ant-pagination-item-active")).toContainText("2");
    await page.setViewportSize({ width: 390, height: 844 });
    await approved.locator(".ant-pagination-simple:visible .ant-pagination-next").click();
    await expect.poll(() => requestedPages.at(-1)).toBe(3);
    expect(await approved.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

for (const priceMode of ["legacy", "independent"] as const)
    test(`DeepSeek UTC sales switch appears for a ${priceMode} six-item model`, async ({ page }) => {
        const modelId = "deepseek-future-e2e";
        const keys = ["cacheHitInputTokensPeak", "cacheMissInputTokensPeak", "outputTokensPeak", "cacheHitInputTokensOffPeak", "cacheMissInputTokensOffPeak", "outputTokensOffPeak"];
        const version = {
            id: "deepseek-future-price",
            logicalModelId: priceMode === "legacy" ? modelId : "",
            capability: "text",
            manufacturer: "DeepSeek",
            series: "DeepSeek",
            officialVersion: "future",
            sku: priceMode === "legacy" ? modelId : "deepseek-v3",
            tier: "paid",
            conditions: "global standard",
            publishedAt: "2026-10-01T00:00:00Z",
            reviewedBy: "admin",
            items: keys.map((key) => ({ key, price: "1", currency: "USD", per: "1000000", unit: "token" })),
        };
        const policy = {
            id: "deepseek-future-sale",
            priceVersionIds: priceMode === "legacy" ? { [modelId]: version.id } : {},
            ...(priceMode === "independent" ? { selectedPriceBindings: [{ logicalModelId: modelId, scope: "text:generation:standard", bindingId: "deepseek-binding", bindingRevision: "reviewed-revision", officialVersionId: version.id }] } : {}),
            userPriceRules: [],
            conversion: { cnyPerUsd: "7", pointsPerCny: "100" },
            usdPerCurrency: { USD: "1" },
            pointsPerCurrency: {},
            rateEvidence: {},
            publishedBy: "admin",
            publishedAt: "2026-10-01T00:00:00Z",
        };
        await page.route("**/api/admin/model-pricing?*", async (route) => {
            const action = new URL(route.request().url()).searchParams.get("action");
            if (action === "activation")
                return route.fulfill({
                    json: { code: 0, data: { admission: { modelId, capability: "text", blockers: ["No reviewed contract"], contractIds: [], structuralComplete: false }, activation: null, shadow: null, bindings: [], active: false }, msg: "" },
                });
            if (action === "sample") return route.fulfill({ json: { code: 0, data: null, msg: "" } });
            if (action) return route.continue();
            const url = new URL(route.request().url());
            url.searchParams.delete("modelId");
            const response = await route.fetch({ url: url.toString() });
            const body = await response.json();
            body.data.selectedModelId = modelId;
            body.data.models.push({ id: modelId, name: "Future", capability: "text", manufacturer: "DeepSeek", series: "DeepSeek" });
            body.data.workbenchModels = [
                {
                    id: modelId,
                    name: "Future",
                    capability: "text",
                    manufacturer: "DeepSeek",
                    series: "DeepSeek",
                    enabled: true,
                    status: "published",
                    approvedPrice: true,
                    publishedPrice: true,
                    publishedScopes: priceMode === "independent" ? ["text:generation:standard"] : [],
                    billingMode: "fixed",
                    bindingCount: 0,
                    billingBindingSlots: 0,
                    activeBindings: 0,
                    qualifiedBindings: 0,
                },
            ];
            body.data.workbenchTotal = 1;
            body.data.officialVersions = [version];
            body.data.boundVersions = [version];
            body.data.salesVersions = [policy];
            return route.fulfill({ response, json: body });
        });
        await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "查看与处理" }).click();
        const sales = page.getByRole("dialog", { name: /模型售价与渠道/ });
        await sales.getByRole("button", { name: "该模型计价条件" }).click();
        const toggle = sales.getByRole("checkbox", { name: "按 UTC 工作日时窗切换高峰／离峰售价" });
        await expect(toggle).toBeVisible();
        await expect(toggle).not.toBeChecked();
        await toggle.check();
        await expect(toggle).toBeChecked();
        await expect(sales.getByLabel(/样例用量/)).toHaveCount(3);
        await expect(sales).toContainText("周一至周五 UTC 01:00–04:00、06:00–10:00");
        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: 844 });
            await expect(toggle).toBeVisible();
            const bounds = await sales.evaluate((element) => ({ right: element.getBoundingClientRect().right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
            expect(bounds.right).toBeLessThanOrEqual(width + 1);
            expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
        }
    });

async function selectSalesModel(page: Page, modelId: string, _vendor: string, capability: "image" | "audio" | "video") {
    await page.getByLabel("工作台模型搜索").fill(modelId);
    await page.getByLabel("工作台模型搜索").press("Enter");
    const row = page.getByTestId(`pricing-model-${modelId}`);
    await expect(row).toContainText({ image: "图片", audio: "音频", video: "视频" }[capability]);
    await Promise.all([page.waitForResponse((response) => response.ok() && response.url().includes("/api/admin/model-pricing?") && new URL(response.url()).searchParams.get("modelId") === modelId), row.getByRole("button", { name: "查看与处理" }).click()]);
    const drawer = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await drawer.getByRole("button", { name: "该模型计价条件" }).click();
    await expect(drawer.getByLabel("已审核官方价版本")).toBeVisible();
}

test("directed image acceptance names the channel, marks each operation and reuses a created image for edit", async ({ page }) => {
    const version = {
        id: "fixture-official",
        logicalModelId: "e2e-image",
        manufacturer: "OpenAI",
        series: "Fixture",
        officialVersion: "e2e-image",
        sku: "e2e-image",
        tier: "paid",
        conditions: "Standard",
        publishedAt: new Date().toISOString(),
        reviewedBy: "admin",
        items: [{ key: "inputTextTokens", price: "5", currency: "USD", per: "1000000", unit: "token" }],
    };
    const policy = {
        id: "fixture-sale",
        priceVersionIds: { "e2e-image": version.id },
        userPriceRules: [],
        conversion: { cnyPerUsd: "7", pointsPerCny: "100" },
        usdPerCurrency: { USD: "1" },
        pointsPerCurrency: {},
        rateEvidence: {},
        publishedBy: "admin",
        publishedAt: new Date().toISOString(),
    };
    const shadow = { ready: false, missingCount: 1, receiptIds: { "contract-create": "receipt-create" }, sample: null };
    const activation = {
        admission: { modelId: "e2e-image", capability: "image", officialVersionId: version.id, salesVersionId: policy.id, structuralComplete: true, fingerprint: "fixture", blockers: [], contractIds: ["contract-create", "contract-edit"] },
        activation: null,
        shadow,
        active: false,
        bindings: [
            {
                key: "e2e-primary/e2e-image",
                channelName: "E2E 主渠道",
                fingerprint: "binding",
                contractIds: ["contract-create", "contract-edit"],
                operationContracts: [
                    { operation: "generations", id: "contract-create" },
                    { operation: "edits", id: "contract-edit" },
                ],
                blockers: [],
                shadow,
                active: false,
            },
            { key: "e2e-unreviewed/e2e-image", channelName: "E2E 待核对渠道", fingerprint: null, contractIds: [], operationContracts: [{ operation: "generations" }], blockers: ["缺少当前渠道的计费契约"], shadow: null, active: false },
        ],
    };
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        const action = new URL(route.request().url()).searchParams.get("action");
        if (action === "activation") return route.fulfill({ json: { code: 0, data: activation, msg: "" } });
        if (action === "sample" || action === "directed-evidence") return route.fulfill({ json: { code: 0, data: null, msg: "" } });
        if (action) return route.continue();
        const url = new URL(route.request().url());
        url.searchParams.delete("modelId");
        const response = await route.fetch({ url: url.toString() });
        const body = await response.json();
        body.data.selectedModelId = "e2e-image";
        body.data.workbenchModels = [
            {
                ...body.data.workbenchModels[0],
                id: "e2e-image",
                name: "e2e-image",
                capability: "image",
                manufacturer: "OpenAI",
                series: "Fixture",
                enabled: true,
                status: "published",
                approvedPrice: true,
                publishedPrice: true,
                publishedScopes: ["image:generations:standard"],
                bindingCount: 2,
            },
        ];
        body.data.workbenchTotal = 1;
        body.data.officialVersions = [version];
        body.data.boundVersions = [version];
        body.data.salesVersions = [policy];
        return route.fulfill({ response, json: body });
    });
    let editBody: { kind?: string; prompt?: string; references?: Array<{ dataUrl: string }> } | undefined;
    await page.route("**/api/image-tasks", (route) => {
        const body = route.request().postDataJSON();
        if (body.kind === "edit") editBody = body;
        return route.fulfill({ json: { task: { id: body.kind === "edit" ? "edited" : "created", status: "pending" } } });
    });
    await page.route("**/api/image-tasks/created", (route) => route.fulfill({ json: { task: { id: "created", status: "success", result: { dataUrl: "/api/generation-log-assets/created.png" } } } }));
    await page.route("**/api/generation-log-assets/created.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9PtlcAAAAASUVORK5CYII=", "base64") }));
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "查看与处理" }).click();
    const sales = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await sales.getByRole("button", { name: "渠道绑定", exact: true }).click();
    await expect(sales.getByText("E2E 主渠道", { exact: true })).toBeVisible();
    const unreviewed = sales.locator("div.rounded-lg").filter({ hasText: "E2E 待核对渠道" }).last();
    await expect(unreviewed.getByRole("button", { name: "执行定向验收" })).toBeVisible();
    await unreviewed.getByRole("button", { name: "执行定向验收" }).click();
    await expect(page.getByRole("dialog", { name: "新渠道定向验收" }).getByText("E2E 待核对渠道", { exact: false })).toBeVisible();
    await page.getByRole("dialog", { name: "新渠道定向验收" }).locator(".ant-modal-close").click();
    await expect(sales.getByText("创建：已验收")).toBeVisible();
    await expect(sales.getByText("编辑：待影子报价")).toBeVisible();
    await page.route("**/api/admin/model-pricing", (route) =>
        route.request().method() === "PATCH" && route.request().postDataJSON().action === "revalue-image-evidence" ? route.fulfill({ json: { code: 0, data: { revalued: 0, status: shadow }, msg: "ok" } }) : route.continue(),
    );
    const revalueRequest = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/admin/model-pricing" && request.postDataJSON().action === "revalue-image-evidence");
    await sales.getByRole("button", { name: "复核已有调用" }).click();
    expect((await revalueRequest).postDataJSON()).toMatchObject({ modelId: "e2e-image", bindingKey: "e2e-primary/e2e-image" });
    await sales.getByRole("button", { name: "执行定向验收" }).first().click();
    const modal = page.getByRole("dialog", { name: "新渠道定向验收" });
    await modal.getByLabel("验收提示词").fill("a small duck");
    await modal.getByRole("button", { name: "执行定向验收" }).click();
    await modal.getByRole("button", { name: "读取任务结果" }).click();
    await modal.locator(".ant-modal-close").click();
    await sales.getByRole("button", { name: "执行定向验收" }).first().click();
    await modal.getByLabel("验收图片操作").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "编辑（edits）" }).click();
    await modal.getByLabel("验收提示词").fill("add another duck@");
    await modal.getByRole("button", { name: /@图片1/ }).click();
    await expect(modal.getByText("编辑参考图 · 已选择 @图片1")).toBeVisible();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await modal.evaluate((element) => element.getBoundingClientRect().right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await modal.getByRole("button", { name: "执行定向验收" }).click();
    expect(editBody).toMatchObject({ kind: "edit", prompt: "add another duck", references: [{ dataUrl: "/api/generation-log-assets/created.png" }] });
});

test("new models visibly inherit fixed points until an individual cost is saved", async ({ page, request }) => {
    const model = "e2e-video-slow";
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { modelPointCosts: Record<string, number> } }).settings.modelPointCosts;
    const inherited = { ...before };
    delete inherited[model];
    try {
        expect((await request.patch("/api/admin/settings", { data: { modelPointCosts: inherited } })).ok()).toBe(true);
        await page.goto("/admin?section=points", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
        await page.locator(".ant-segmented-item").filter({ hasText: /视频/ }).click();
        const row = page.locator(`[data-point-cost-model="${model}"]`);
        for (const width of [1440, 390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            await expect(row.getByText("沿用默认")).toBeVisible();
            await expect(row.locator(".ant-input-number-input")).toHaveValue("1.00");
            await expect(row.getByRole("button", { name: "删除消耗配置" })).toBeDisabled();
            expect(
                await row.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.left >= 0 && rect.right <= window.innerWidth + 1;
                }),
            ).toBe(true);
        }
        await row.locator(".ant-input-number-input").fill("0.75");
        const firstSave = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/settings" && response.request().method() === "PATCH");
        await page.getByRole("button", { name: "保存积分规则" }).click();
        expect((await firstSave).ok()).toBe(true);
        expect(((await (await request.get("/api/admin/settings")).json()) as { settings: { modelPointCosts: Record<string, number> } }).settings.modelPointCosts[model]).toBe(0.75);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
        await page.locator(".ant-segmented-item").filter({ hasText: /视频/ }).click();
        const savedRow = page.locator(`[data-point-cost-model="${model}"]`);
        await expect(savedRow.getByText("沿用默认")).toHaveCount(0);
        await expect(savedRow.getByRole("button", { name: "删除消耗配置" })).toBeEnabled();
        await savedRow.getByRole("button", { name: "删除消耗配置" }).click();
        await expect(savedRow.getByText("沿用默认")).toBeVisible();
        const secondSave = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/settings" && response.request().method() === "PATCH");
        await page.getByRole("button", { name: "保存积分规则" }).click();
        expect((await secondSave).ok()).toBe(true);
        expect(((await (await request.get("/api/admin/settings")).json()) as { settings: { modelPointCosts: Record<string, number> } }).settings.modelPointCosts).not.toHaveProperty(model);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
        await page.locator(".ant-segmented-item").filter({ hasText: /视频/ }).click();
        await expect(page.locator(`[data-point-cost-model="${model}"]`).getByText("沿用默认")).toBeVisible();
    } finally {
        expect((await request.patch("/api/admin/settings", { data: { modelPointCosts: before } })).ok()).toBe(true);
    }
});

test("protocol catalog groups templates and filters the two Seedream routes", async ({ page }) => {
    await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
    await page.getByRole("tab", { name: "协议中心" }).click();
    await expect(page.locator("[data-protocol-id]")).toHaveCount(22);
    await expect(page.locator('[data-protocol-group="interface"]')).toContainText("不绑定平台的接口");
    await expect(page.locator('[data-protocol-group="interface"]')).toContainText("Seedance 2.0 / SD2");
    await expect(page.locator('[data-protocol-group="interface"]')).toContainText("Stable Diffusion（SD）");
    await expect(page.locator('[data-protocol-id="custom"]')).toHaveCount(0);

    const search = page.getByRole("textbox", { name: "搜索协议、平台或模型" });
    await search.fill("Seedream");
    await expect(page.locator("[data-protocol-id]")).toHaveCount(2);
    await expect(page.locator('[data-protocol-id="dataeyes-seedream"]')).toContainText("/v1/images/generations");
    await expect(page.locator('[data-protocol-id="volcengine-image"]')).toContainText("/api/v3/images/generations");
    await search.clear();
    await page.getByRole("group", { name: "协议能力筛选" }).getByRole("button", { name: "视频" }).click();
    await expect(page.locator('[data-protocol-id="dataeyes-seedream"]')).toHaveCount(0);
    await expect(page.locator('[data-protocol-id="seedance"]')).toHaveCount(1);
    await page.getByRole("group", { name: "协议能力筛选" }).getByRole("button", { name: "全部" }).click();

    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        const insideViewport = await page.locator('[data-protocol-id="dataeyes-seedream"]').evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth + 1;
        });
        expect(insideViewport).toBe(true);
    }

    await page
        .locator('[data-protocol-id="dataeyes-seedream"]')
        .getByRole("button", { name: /接\s*入/ })
        .click();
    const drawer = page.getByRole("dialog", { name: "接入新渠道" });
    await expect(drawer.locator('[data-protocol-id="dataeyes-seedream"]')).toHaveAttribute("aria-pressed", "true");
    const drawerSearch = drawer.getByRole("textbox", { name: "搜索协议、平台或模型" });
    await drawerSearch.fill("Seedream");
    await expect(drawer.locator("[data-protocol-id]")).toHaveCount(2);
    await drawer.locator('[data-protocol-id="volcengine-image"]').click();
    await drawer.getByRole("button", { name: "开始配置" }).click();
    await expect(drawer.getByPlaceholder("https://api.example.com")).toHaveValue("https://ark.cn-beijing.volces.com");
    await drawer.getByRole("button", { name: "上一步" }).click();
    await drawer.getByRole("button", { name: /取\s*消/ }).click();
});

test("channel onboarding shows built-in protocols on desktop and mobile", async ({ page }) => {
    await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [protocol, baseUrl, capabilities] of [
            ["Google Gemini / Veo", "https://generativelanguage.googleapis.com", 4],
            ["DataEyes Gemini / Veo", "https://platform.dataeyes.ai", 4],
            ["DataEyes FLUX", "https://platform.dataeyes.ai", 1],
            ["DataEyes Seedance", "https://platform.dataeyes.ai", 1],
            ["DataEyes Seedream", "https://platform.dataeyes.ai", 1],
            ["Grok（经 sub2api）", "", 4],
            ["GLM（智谱 / Z.AI）", "https://api.z.ai", 1],
            ["阿里云百炼", "https://dashscope-intl.aliyuncs.com", 2],
            ["Black Forest Labs", "https://api.bfl.ai", 1],
            ["Kling（可灵）", "https://api-singapore.klingai.com", 1],
            ["Vidu", "https://api.vidu.com", 1],
            ["MiniMax", "https://api.minimax.io", 4],
            ["Anthropic（Claude）", "https://api.anthropic.com", 1],
            ["xAI（Grok 官方）", "https://api.x.ai", 4],
            ["火山方舟图片", "https://ark.cn-beijing.volces.com", 1],
        ] as const) {
            await page.getByRole("button", { name: width < 640 ? "接入渠道" : "接入新渠道", exact: true }).click();
            const drawer = page.getByRole("dialog", { name: "接入新渠道" });
            const option = drawer.getByRole("button", { name: new RegExp(protocol) });
            await expect(option).toBeVisible();
            await expect(option.locator("span").filter({ hasText: /^(文本|图片|视频|音频)$/ })).toHaveCount(capabilities);
            await option.click();
            await drawer.getByRole("button", { name: "开始配置" }).click();
            await expect(drawer.getByPlaceholder("https://api.example.com")).toHaveValue(baseUrl);
            await expect(drawer.getByPlaceholder("例如 /kling；官方直连留空")).toBeVisible();
            await expect(drawer.getByText("严格协议")).toBeVisible();
            if (["DataEyes Seedream", "GLM（智谱 / Z.AI）", "Black Forest Labs", "Kling（可灵）", "Vidu"].some((name) => name === protocol)) {
                await drawer.getByPlaceholder("仅保存在服务端").fill("fixture-key");
                await drawer.getByRole("button", { name: "下一步" }).click();
                await expect(drawer.getByRole("button", { name: "同步模型" })).toBeVisible();
                await drawer.getByRole("button", { name: "上一步" }).click();
            }
            if (protocol === "火山方舟图片") {
                await drawer.getByPlaceholder("仅保存在服务端").fill("fixture-key");
                await drawer.getByRole("button", { name: "下一步" }).click();
                await expect(drawer.getByRole("button", { name: "同步模型" })).toHaveCount(0);
                await expect(drawer.getByText("模型 ID", { exact: true })).toBeVisible();
                await drawer.getByRole("button", { name: "上一步" }).click();
            }
            await drawer.getByRole("button", { name: "上一步" }).click();
            await drawer.getByRole("button", { name: /取\s*消/ }).click();
            await expect(drawer).toHaveCount(0);
        }
    }
});

test("DataEyes channel shows the current key catalog separately from retained historical models", async ({ page, request }) => {
    const baseline = e2eSettingsPatch();
    const channel = {
        ...structuredClone(baseline.systemChannels[0]),
        id: "e2e-dataeyes-catalog",
        name: "E2E DataEyes 目录",
        baseUrl: "https://studio.dataeyes.ai",
        apiKey: "fixture-key",
        models: ["ByteDance-Seed-1.6", "doubao-seed-2-1-pro-260915"],
        advancedConfig: { ...baseline.systemChannels[0].advancedConfig, protocol: "openai" as const, providerModels: ["doubao-seed-2-1-pro-260915"] },
    };
    try {
        const prepared = await request.patch("/api/admin/settings", { data: { systemChannels: [...baseline.systemChannels, channel] } });
        expect(prepared.ok(), await prepared.text()).toBe(true);
        await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        const row = page.getByRole("row").filter({ hasText: channel.name });
        await expect(row).toContainText("1");
        await row.getByRole("button", { name: /查\s*看/ }).click();
        const drawer = page.getByRole("dialog", { name: channel.name });
        await expect(drawer.getByText("当前密钥可用模型")).toBeVisible();
        await expect(drawer.getByText("本地保留的历史模型")).toBeVisible();
        await drawer.getByRole("tab", { name: "上游模型 1" }).click();
        await expect(drawer.getByText("当前密钥返回 1 个模型；另有 1 个本地历史模型")).toBeVisible();
        await expect(drawer.getByText("ByteDance-Seed-1.6").last()).toBeVisible();
        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await drawer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
        await expect(page.getByRole("row").filter({ hasText: channel.name })).toContainText("1");
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { systemChannels: baseline.systemChannels, logicalModels: baseline.logicalModels, defaultModels: baseline.defaultModels } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("Seedream 5.0 Pro exposes ratios and supported 2K sizes on desktop and mobile", async ({ page, request }) => {
    const baseline = e2eSettingsPatch();
    const upstreamModel = "ByteDance-Seedream-5.0-pro";
    const modelConfig = { ...dataeyesSeedreamProtocol.operations.image, source: "manual", protocol: "dataeyes-seedream", apiFormat: "openai" };
    const channel = {
        ...baseline.systemChannels[0],
        id: "e2e-seedream",
        name: "E2E Seedream",
        baseUrl: E2E_PROTOCOL_ORIGIN,
        models: [upstreamModel],
        advancedConfig: {
            ...baseline.systemChannels[0].advancedConfig,
            protocol: "dataeyes-seedream",
            createPath: "/v1/images/generations",
            editPath: "/v1/images/generations",
            modelCapabilities: { [upstreamModel]: "image" },
            modelConfigs: { [upstreamModel.toLowerCase()]: modelConfig },
            operationConfigs: {},
        },
    };
    const prepared = await request.patch("/api/admin/settings", {
        data: {
            systemChannels: [...baseline.systemChannels, channel],
            logicalModels: [
                { id: "e2e-text", name: "E2E Text", capability: "text", enabled: true, bindings: [{ id: "e2e-text-primary", channelId: "e2e-primary", upstreamModel: "e2e-text", enabled: true, priority: 1 }] },
                { id: "seedream-image", name: "Seedream 5.0 Pro", capability: "image", enabled: true, bindings: [{ id: "e2e-seedream-binding", channelId: channel.id, upstreamModel, enabled: true, priority: 1 }] },
            ],
            defaultModels: { ...baseline.defaultModels, imageModel: "seedream-image" },
        },
    });
    expect(prepared.ok(), await prepared.text()).toBe(true);

    try {
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        await page.getByRole("button", { name: "当前创作类型：Agent 模式" }).click();
        await page
            .locator(".ant-popover")
            .filter({ hasText: "创作类型" })
            .last()
            .getByRole("button", { name: /图片生成/ })
            .click();
        const modelTrigger = page.getByRole("button", { name: /生成模型：/ });
        await modelTrigger.click();
        await page
            .locator(".ant-popover")
            .filter({ hasText: "选择模型" })
            .last()
            .getByRole("button", { name: /Seedream 5.0 Pro/ })
            .click();
        await modelTrigger.click();

        for (const width of [1440, 390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            const preferences = page.getByRole("button", { name: /生成参数：/ });
            await preferences.click();
            const panel = page.locator("[data-creative-generation-preferences]:visible");
            const ratio = panel.getByRole("button", { name: "选择图片比例 16:9", exact: true });
            await expect(ratio).toBeVisible();
            await ratio.click();
            await expect(ratio).toHaveAttribute("aria-pressed", "true");
            await expect(panel.getByRole("button", { name: "选择图片尺寸 2K 16:9", exact: true })).toBeVisible();
            await expect(panel.getByRole("button", { name: "选择图片尺寸 4K 16:9", exact: true })).toHaveCount(0);
            const sizesFit = await panel.evaluate((element) => {
                const panelBounds = element.getBoundingClientRect();
                return (
                    panelBounds.left >= 0 &&
                    panelBounds.right <= window.innerWidth + 1 &&
                    [...element.querySelectorAll<HTMLButtonElement>('button[aria-label^="选择图片"]')].every((button) => {
                        const bounds = button.getBoundingClientRect();
                        return bounds.left >= panelBounds.left && bounds.right <= panelBounds.right + 1;
                    })
                );
            });
            expect(sizesFit).toBe(true);
            const size = panel.getByRole("button", { name: "选择图片尺寸 2K", exact: true });
            await expect(size).toBeVisible();
            await size.click();
            await expect(size).toHaveAttribute("aria-pressed", "true");
            await preferences.click();
        }
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { systemChannels: baseline.systemChannels, logicalModels: baseline.logicalModels, defaultModels: baseline.defaultModels } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("batch channel priorities preview exclusions and persist without changing other bindings", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    expect(beforeResponse.ok(), await beforeResponse.text()).toBe(true);
    const before = ((await beforeResponse.json()) as { settings: { logicalModels: Array<{ id: string; manufacturer?: string; series?: string; bindings: Array<{ channelId: string; priority: number }> }> } }).settings.logicalModels;
    const grouped = before.map((model) => (["e2e-text", "e2e-text-fallback"].includes(model.id) ? { ...model, manufacturer: "E2E", series: "Fixture" } : model));
    try {
        const prepared = await request.patch("/api/admin/settings", { data: { logicalModels: grouped } });
        expect(prepared.ok(), await prepared.text()).toBe(true);
        await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await page.getByRole("tab", { name: "逻辑模型" }).click();
        await page.getByRole("button", { name: "批量设置", exact: true }).click();
        const drawer = page.getByRole("dialog", { name: "批量设置模型" });
        await drawer.getByText("渠道优先级", { exact: true }).click();
        await drawer.getByLabel("批量优先级渠道").click();
        await page.locator('.ant-select-item-option[title="E2E 备用渠道 (e2e-backup)"]').click();
        await page.keyboard.press("Escape");
        await drawer.getByLabel("批量优先级模型厂商").click();
        await page.locator('.ant-select-item-option[title="E2E"]').click();
        await drawer.getByLabel("批量优先级模型系列").click();
        await page.locator('.ant-select-item-option[title="Fixture"]').click();
        await drawer.getByRole("button", { name: "预览受影响绑定" }).click();
        const selected = drawer.getByTestId("priority-row-e2e-text-e2e-backup");
        const excluded = drawer.getByTestId("priority-row-e2e-text-fallback-e2e-backup");
        await expect(selected).toContainText("优先级 2 → 1");
        await drawer.getByLabel("批量搜索模型").fill("e2e-text-fallback");
        await drawer.getByRole("button", { name: "取消搜索结果选择" }).click();
        await expect(excluded).toContainText("优先级 2 → 2");
        await drawer.getByRole("button", { name: /全选搜索结果/ }).click();
        await expect(excluded).toContainText("优先级 2 → 1");
        await drawer.getByLabel("批量搜索模型").clear();
        await excluded.getByRole("checkbox").click();
        await expect(excluded).toContainText("优先级 2 → 2");
        await drawer.getByRole("button", { name: "提交选中项" }).click();
        await expect(drawer).toHaveCount(0);
        const savedResponse = await request.get("/api/admin/settings");
        const saved = ((await savedResponse.json()) as { settings: { logicalModels: typeof before } }).settings.logicalModels;
        expect(saved.find((model) => model.id === "e2e-text")?.bindings.find((binding) => binding.channelId === "e2e-backup")?.priority).toBe(1);
        expect(saved.find((model) => model.id === "e2e-text-fallback")?.bindings.find((binding) => binding.channelId === "e2e-backup")?.priority).toBe(2);

        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            await page.getByRole("button", { name: "批量设置", exact: true }).click();
            const mobileDrawer = page.getByRole("dialog", { name: "批量设置模型" });
            await expect
                .poll(async () => {
                    const bounds = await mobileDrawer.boundingBox();
                    return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
                })
                .toBe(true);
            await mobileDrawer.locator(".ant-drawer-close").click();
        }
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { logicalModels: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("new Anthropic text binding stays in directed acceptance until its routing setting is changed", async ({ page, request }) => {
    const baseline = e2eSettingsPatch();
    const anthropic = applyChannelProtocol({ ...structuredClone(baseline.systemChannels[0]), id: "e2e-anthropic", name: "E2E Claude 验收渠道", baseUrl: E2E_PROTOCOL_ORIGIN, models: ["e2e-text"] }, "anthropic");
    anthropic.advancedConfig = { ...anthropic.advancedConfig, channelAuthMode: "bearer" };
    try {
        const prepared = await request.patch("/api/admin/settings", { data: { systemChannels: [...baseline.systemChannels, anthropic], logicalModels: baseline.logicalModels } });
        expect(prepared.ok(), await prepared.text()).toBe(true);
        const read = await request.get("/api/admin/settings");
        expect(read.ok(), await read.text()).toBe(true);
        const settings = (await read.json()) as { settings: { logicalModels: Array<{ id: string; bindings: Array<{ channelId: string; acceptanceOnly?: boolean }> }> } };
        expect(settings.settings.logicalModels.find((model) => model.id === "e2e-text")?.bindings.find((binding) => binding.channelId === anthropic.id)?.acceptanceOnly).toBe(true);

        await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await page.getByRole("tab", { name: "逻辑模型" }).click();
        await page.getByPlaceholder("搜索模型昵称、ID 或上游模型").fill("e2e-text");
        await page.locator("section").filter({ hasText: "逻辑模型路由" }).getByRole("button", { name: "路由设置" }).first().click();
        const drawer = page.getByRole("dialog", { name: "模型路由设置" });
        const pending = drawer.getByRole("checkbox", { name: /仅管理员定向验收/ }).last();
        await expect(pending).toBeChecked();
        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            await expect
                .poll(async () => {
                    const bounds = await drawer.boundingBox();
                    return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
                })
                .toBe(true);
            await expect(pending).toBeVisible();
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await pending.uncheck();
        await expect(pending).not.toBeChecked();
        await drawer.getByRole("button", { name: "应用修改" }).click();
        await page.getByRole("button", { name: "保存模型渠道配置" }).click();
        const saved = await request.get("/api/admin/settings");
        expect(saved.ok(), await saved.text()).toBe(true);
        const persisted = (await saved.json()) as typeof settings;
        expect(persisted.settings.logicalModels.find((model) => model.id === "e2e-text")?.bindings.find((binding) => binding.channelId === anthropic.id)?.acceptanceOnly).not.toBe(true);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { systemChannels: baseline.systemChannels, logicalModels: baseline.logicalModels, defaultModels: baseline.defaultModels } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("bulk logical model grouping saves only selected fields and survives reload", async ({ page, request }) => {
    const readModels = async () => {
        const response = await request.get("/api/admin/settings");
        expect(response.ok(), await response.text()).toBe(true);
        return ((await response.json()) as { settings: { logicalModels: Array<{ id: string; manufacturer?: string; series?: string; bindings: unknown[] }> } }).settings.logicalModels;
    };
    const before = await readModels();
    try {
        await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await page.getByRole("tab", { name: "逻辑模型" }).click();
        await page.getByRole("button", { name: "批量设置", exact: true }).click();
        const drawer = page.getByRole("dialog", { name: "批量设置模型" });
        await drawer.getByLabel("批量搜索模型").fill("e2e-text");
        await drawer.getByRole("button", { name: /全选搜索结果/ }).click();
        await expect(drawer.getByText("已选 3 个模型")).toBeVisible();
        await drawer.getByLabel("批量搜索模型").fill("e2e-image-fallback");
        await drawer.getByRole("button", { name: /全选搜索结果/ }).click();
        await expect(drawer.getByText("已选 4 个模型")).toBeVisible();
        await drawer.getByLabel("批量搜索模型").fill("e2e-text");
        await drawer.getByRole("button", { name: "取消搜索结果选择" }).click();
        await expect(drawer.getByText("已选 1 个模型")).toBeVisible();
        await drawer.getByLabel("批量搜索模型").fill("e2e-image-fallback");
        await drawer.getByRole("button", { name: "取消搜索结果选择" }).click();
        await expect(drawer.getByText("已选 0 个模型")).toBeVisible();
        await drawer.getByLabel("批量搜索模型").fill("e2e-text");
        await drawer.getByTestId("bulk-model-e2e-text").getByRole("checkbox").check();
        await drawer.getByTestId("bulk-model-e2e-text-fallback").getByRole("checkbox").check();
        await drawer.getByRole("checkbox", { name: "修改模型厂商" }).check();
        await drawer.getByLabel("批量模型厂商").click();
        await page.locator('.ant-select-item-option[title="DeepSeek"]').click();
        await expect(drawer.getByLabel("批量模型系列")).toBeDisabled();
        await expect(drawer.getByText("→ DeepSeek")).toHaveCount(2);
        await drawer.getByRole("button", { name: "应用到配置草稿" }).click();
        await page.getByRole("button", { name: "保存模型渠道配置" }).click();
        await expect.poll(async () => (await readModels()).filter((model) => ["e2e-text", "e2e-text-fallback"].includes(model.id)).every((model) => model.manufacturer === "DeepSeek")).toBe(true);
        let saved = await readModels();
        expect(saved.find((model) => model.id === "e2e-text-fail")?.manufacturer).toBe(before.find((model) => model.id === "e2e-text-fail")?.manufacturer);
        expect(saved.find((model) => model.id === "e2e-text")?.series).toBe(before.find((model) => model.id === "e2e-text")?.series);
        expect(saved.find((model) => model.id === "e2e-text")?.bindings).toEqual(before.find((model) => model.id === "e2e-text")?.bindings);

        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
        await page.getByRole("tab", { name: "逻辑模型" }).click();
        await page.getByRole("button", { name: "批量设置", exact: true }).click();
        await drawer.getByLabel("批量搜索模型").fill("e2e-text");
        await expect(drawer.getByTestId("bulk-model-e2e-text")).toHaveCount(0);
        await drawer.getByRole("checkbox", { name: "显示已设置的模型（用于修正）" }).check();
        await expect(drawer.getByTestId("bulk-model-e2e-text")).toBeVisible();
        await drawer.getByRole("checkbox", { name: "显示已设置的模型（用于修正）" }).uncheck();
        await drawer.getByRole("checkbox", { name: "修改模型系列" }).check();
        await drawer.getByTestId("bulk-model-e2e-text").getByRole("checkbox").check();
        await drawer.getByLabel("批量模型系列").fill("DeepSeek V4");
        for (const width of [390, 430]) {
            await page.setViewportSize({ width, height: 900 });
            await expect
                .poll(async () => {
                    const bounds = await drawer.boundingBox();
                    return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
                })
                .toBe(true);
            expect(await drawer.locator(".ant-drawer-body").evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(1);
        }
        await drawer.getByRole("button", { name: "应用到配置草稿" }).click();
        await page.getByRole("button", { name: "保存模型渠道配置" }).click();
        await expect.poll(async () => (await readModels()).find((model) => model.id === "e2e-text")?.series).toBe("DeepSeek V4");
        saved = await readModels();
        expect(saved.find((model) => model.id === "e2e-text")?.manufacturer).toBe("DeepSeek");
        expect(saved.find((model) => model.id === "e2e-text-fallback")?.series).toBe(before.find((model) => model.id === "e2e-text-fallback")?.series);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: { logicalModels: before } });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("rejected official price edits in place and sales models cascade by vendor and capability", async ({ page, request }) => {
    const sku = `e2e-edit-${randomUUID()}`;
    const createdResponse = await request.post("/api/admin/model-pricing", {
        data: {
            action: "candidate",
            price: {
                logicalModelId: "e2e-image",
                manufacturer: "Google",
                series: "Fixture",
                officialVersion: sku,
                sku,
                tier: "paid",
                conditions: "E2E edit",
                sourceKind: "manual",
                sourceUrl: "https://example.com/pricing",
                evidence: "fixture evidence",
                observedAt: new Date().toISOString(),
                items: [{ key: "imageCount", unit: "image", per: "1", price: "1", currency: "USD" }],
            },
        },
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = (await createdResponse.json()).data as { id: string };
    expect((await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: created.id, approved: false, note: "fix price" } })).ok()).toBe(true);
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "官方价与证据" }).click();
    const official = page.locator("section").filter({ has: page.getByRole("heading", { name: "待审价目候选" }) });
    await official.getByLabel("价目厂商筛选").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "Google" }).click();
    await official.getByLabel("价目模型筛选").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-image" }).click();
    await official.getByLabel("价目状态筛选").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "已驳回" }).click();
    const row = official.locator(".rounded-lg.border").filter({ hasText: sku });
    await row.getByRole("button", { name: "查看全部分项、适用条件与证据" }).click();
    await page.getByRole("dialog", { name: "核对官方价目候选" }).getByRole("button", { name: "修改候选" }).click();
    const form = page.getByRole("dialog", { name: `修改官方价目候选 · e2e-image` });
    await form.getByLabel("项目 1 单价").fill("2");
    await form.locator(".ant-modal-close").click();
    await expect(page.getByRole("dialog", { name: "放弃未保存的价目草稿？" })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑" }).click();
    await expect(form.getByLabel("项目 1 单价")).toHaveValue("2");
    await form.getByRole("button", { name: "保存并重新提交审核" }).click();
    await expect(form).toHaveCount(0);
    const revisedResponse = await request.get("/api/admin/model-pricing?candidateModelId=e2e-image&candidateStatus=pending");
    const revised = (await revisedResponse.json()).data.candidates.find((item: { id: string }) => item.id === created.id);
    expect(revised).toMatchObject({ id: created.id, status: "pending", items: [{ price: "2" }] });
    expect((await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: created.id, approved: true, note: "fixture approved" } })).ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await official.getByLabel("价目状态筛选").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "全部候选" }).click();
    const approvedRow = official.locator(".rounded-lg.border").filter({ hasText: sku });
    await approvedRow.getByRole("button", { name: "查看全部分项、适用条件与证据" }).click();
    await page.getByRole("dialog", { name: "核对官方价目候选" }).getByRole("button", { name: "修改候选" }).click();
    const approvedForm = page.getByRole("dialog", { name: "修改官方价目候选 · e2e-image" });
    await approvedForm.getByLabel("项目 1 单价").fill("3");
    await approvedForm.getByRole("button", { name: "保存并重新提交审核" }).click();
    await expect(approvedForm).toHaveCount(0);
    const reopened = (await (await request.get("/api/admin/model-pricing?candidateModelId=e2e-image&candidateStatus=pending")).json()).data.candidates.find((item: { id: string }) => item.id === created.id);
    expect(reopened).toMatchObject({ id: created.id, status: "pending", items: [{ price: "3" }] });
    expect((await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: created.id, approved: true, note: "fixture reapproved" } })).ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await official.getByLabel("价目状态筛选").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "全部候选" }).click();
    const deletableRow = official.locator(".rounded-lg.border").filter({ hasText: sku });
    await deletableRow.getByRole("button", { name: "查看全部分项、适用条件与证据" }).click();
    await page.getByRole("dialog", { name: "核对官方价目候选" }).getByRole("button", { name: "删除候选" }).click();
    await page
        .getByRole("dialog", { name: `删除 ${sku} 的官方价目？` })
        .getByRole("button", { name: "删除价目" })
        .click();
    await expect(deletableRow).toHaveCount(0);
    expect((await (await request.get("/api/admin/model-pricing?candidateModelId=e2e-image")).json()).data.candidates.some((item: { id: string }) => item.id === created.id)).toBe(false);

    await page.getByRole("button", { name: "模型工作台" }).click();
    const search = page.getByLabel("工作台模型搜索");
    await search.fill("e2e-image");
    await search.press("Enter");
    await page.getByRole("button", { name: "查看与处理" }).first().click();
    const sales = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await sales.getByRole("button", { name: "该模型计价条件" }).click();
    await expect(sales.getByLabel("售价逻辑模型").locator("..").locator("..")).toContainText("e2e-image");
    await sales.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "售价规则与折算" }).click();
    const rules = page.locator("section").filter({ has: page.getByRole("heading", { name: "用户售价系数" }) });
    await rules.getByRole("button", { name: "添加售价规则" }).click();
    const ruleIndex = await rules.getByLabel(/规则 \d+ 层级/).count();
    await rules.getByLabel(`规则 ${ruleIndex} 层级`).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "具体模型" }).click();
    await rules.getByLabel(`规则 ${ruleIndex} 模型`).click();
    await page.getByRole("menuitemcheckbox", { name: /未标厂商/ }).click();
    await page.getByRole("menuitemcheckbox", { name: /图片/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "e2e-image (e2e-image)" }).click();
    await expect(rules.getByLabel(`规则 ${ruleIndex} 模型`).locator("..").locator("..")).toContainText("e2e-image");
    const ruleRow = rules.getByLabel(`规则 ${ruleIndex} 层级`).locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await ruleRow.locator(":scope > span").count()).toBe(0);
    const modelBounds = await ruleRow.locator(".ant-cascader").boundingBox();
    const coefficientBounds = await rules.getByLabel(`规则 ${ruleIndex} 系数`).boundingBox();
    expect(modelBounds?.width || 0).toBeGreaterThan(coefficientBounds?.width || 0);
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await rules.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await ruleRow.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
    }
});

test("official price review and model sales preview publish without changing fixed points", async ({ page, request }) => {
    const beforeResponse = await request.get("/api/admin/settings");
    const fixedPoints = ((await beforeResponse.json()) as { settings: { modelPointCosts: Record<string, number> } }).settings.modelPointCosts;
    const officialVersion = `e2e-text-${randomUUID()}`;
    const officialSku = `E2E-SKU-${randomUUID()}`;
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "官网来源链接" }).click();
    await expect(page.getByRole("link", { name: "https://docs.byteplus.com/en/docs/modelark/model-pricing" })).toHaveAttribute("href", "https://docs.byteplus.com/en/docs/modelark/model-pricing");
    await page.getByRole("button", { name: "新增厂商官网链接" }).click();
    const sourceForm = page.getByRole("dialog", { name: "新增厂商官网价格链接" });
    const sourceName = `E2E-${Date.now()}`;
    await sourceForm.getByLabel("官网价格厂商名称").fill(sourceName);
    await sourceForm.getByLabel("官网价格链接地址").fill("https://example.com/e2e-pricing");
    await sourceForm.getByRole("button", { name: "保存链接" }).click();
    await expect(sourceForm).toHaveCount(0);
    await expect(page.getByText(sourceName, { exact: true })).toBeVisible();
    const originalModels = ((await (await request.get("/api/admin/settings")).json()) as { settings: { logicalModels: Array<Record<string, unknown>> } }).settings.logicalModels;
    const preparedModels = originalModels.map((model) => (model.id === "e2e-text" ? { ...model, manufacturer: sourceName } : model));
    expect((await request.patch("/api/admin/settings", { data: { logicalModels: preparedModels } })).ok()).toBe(true);
    await page.getByRole("button", { name: "模型工作台" }).click();
    const workbenchSearch = page.getByLabel("工作台模型搜索");
    await workbenchSearch.fill("e2e-text");
    await workbenchSearch.press("Enter");
    await page.getByText("e2e-text", { exact: true }).first().locator("..").locator("..").getByRole("button", { name: "查看与处理" }).click();
    await page
        .getByRole("dialog", { name: /模型售价与渠道/ })
        .locator(".ant-drawer-close")
        .click();
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "待审价目" }).click();
    await page.getByRole("button", { name: "录入官方价目" }).click();
    const form = page.getByRole("dialog", { name: "录入官方价目候选" });
    await form.getByLabel("官方价模型能力").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "文本" }).first().click();
    await expect(form.getByLabel("官方价逻辑模型")).toHaveCount(0);
    await expect(form.getByText("尚未填写分项")).toBeVisible();
    await form.getByLabel("官方厂商").fill(sourceName);
    await page.locator(".ant-select-item-option").filter({ hasText: sourceName }).click();
    await form.getByLabel("官方系列").fill("Fixture");
    await form.getByLabel("官方模型版本").fill(officialVersion);
    await form.getByLabel("官方模型 ID／产品标识").fill(officialSku);
    await form.getByLabel("官方 HTTPS 来源").fill("https://example.com/pricing");
    await form.getByLabel("价目适用条件").fill("标准付费档");
    await form.getByLabel("官方价证据").fill("E2E 官方页面证据");
    await form.getByRole("button", { name: "添加计费项目" }).click();
    await form.getByLabel("项目 1 标识").fill("inputTokens");
    await form.getByLabel("项目 1 单位").fill("token");
    await form.getByLabel("项目 1 报价数量").fill("1000000");
    await form.getByLabel("项目 1 单价").fill("1");
    await form.getByLabel("项目 1 币种").fill("USD");
    await form.getByRole("button", { name: "添加计费项目" }).click();
    await form.getByLabel("项目 2 标识").fill("outputTokens");
    await form.getByLabel("项目 2 单位").fill("token");
    await form.getByLabel("项目 2 报价数量").fill("1000000");
    await form.getByLabel("项目 2 单价").fill("4");
    await form.getByLabel("项目 2 币种").fill("USD");
    await form.getByRole("button", { name: "提交待审核" }).click();
    await expect(form).toHaveCount(0);
    const otherCandidate = await request.post("/api/admin/model-pricing", {
        data: {
            action: "candidate",
            price: {
                logicalModelId: "e2e-image",
                manufacturer: "Google",
                series: "Fixture",
                officialVersion: `e2e-image-${randomUUID()}`,
                sku: `E2E-IMAGE-SKU-${randomUUID()}`,
                tier: "paid",
                conditions: "测试图片价目",
                sourceKind: "manual",
                sourceUrl: "https://example.com/image-pricing",
                evidence: "本地浏览器夹具",
                observedAt: new Date().toISOString(),
                items: [{ key: "imageCount", unit: "image", per: "1", price: "1", currency: "USD" }],
            },
        },
    });
    expect(otherCandidate.ok(), await otherCandidate.text()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByLabel("价目厂商筛选").click();
    await page.locator(".ant-select-item-option").filter({ hasText: "Google" }).click();
    await page.getByLabel("价目模型筛选").click();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-image" })).toBeVisible();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-text" })).toHaveCount(0);
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-image" }).click();
    await page.getByLabel("价目厂商筛选").click();
    await page.locator(".ant-select-item-option").filter({ hasText: sourceName }).click();
    const modelFilter = page.locator(".ant-select").filter({ has: page.getByLabel("价目模型筛选") });
    await expect(modelFilter.locator(".ant-select-selection-item")).toHaveCount(0);
    await expect(page.getByText(`${sourceName} 全部模型`, { exact: true })).toBeVisible();
    await page.getByLabel("价目模型筛选").click();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-text" })).toHaveCount(0);
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-image" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const pendingRow = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "待审价目候选" }) })
        .locator(".rounded-lg.border")
        .filter({ hasText: officialSku });
    await pendingRow.getByRole("button", { name: "查看全部分项、适用条件与证据" }).click();
    const candidateDetail = page.getByRole("dialog", { name: "核对官方价目候选" });
    await expect(candidateDetail).toContainText(officialSku);
    await candidateDetail.getByRole("button", { name: "审核通过" }).click();
    await page
        .getByRole("dialog", { name: "审核通过并生成不可变官方价版本？" })
        .getByRole("button", { name: /确\s*定/ })
        .click();
    await expect(pendingRow).toHaveCount(0);
    await page.getByRole("button", { name: "已审核版本" }).click();
    const approvedRow = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: "已审核价目记录" }) })
        .locator(".rounded-lg.border")
        .filter({ hasText: officialSku });
    await expect(approvedRow).toContainText("可供独立选价");
    await approvedRow.getByRole("button", { name: "查看不可变版本" }).click();
    const approvedDrawer = page.getByRole("dialog", { name: "已审核官方价版本" });
    await approvedDrawer.getByLabel("选择独立选价逻辑模型").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "e2e-text" }).first().click();
    await approvedDrawer.getByRole("button", { name: "前往独立选价" }).click();
    await expect(approvedDrawer).toHaveCount(0);
    let modelDrawer = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await expect(modelDrawer).toContainText("e2e-text · 模型售价与渠道");
    await expect(
        modelDrawer
            .locator(".ant-select")
            .filter({ has: modelDrawer.getByLabel("已审核官方价版本") })
            .locator(".ant-select-selection-item"),
    ).toHaveCount(0);
    await modelDrawer.getByLabel("独立官网 SKU 搜索").fill(officialSku);
    await modelDrawer.getByLabel("独立官网 SKU 搜索").press("Enter");
    await modelDrawer.getByLabel("独立官网价版本").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: officialSku }).click();
    await modelDrawer.getByLabel("独立选价审核依据").fill("本地夹具已核对官网 SKU、国际服务及来源");
    await modelDrawer.getByRole("button", { name: "保存独立选价" }).click();
    await expect(modelDrawer).toContainText("售价草稿：");
    await page.getByRole("button", { name: "核对文本用量契约" }).click();
    const contractDrawer = page.getByRole("dialog", { name: "核对纯文本用量契约" });
    await contractDrawer.getByLabel("契约渠道绑定").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "E2E 主渠道 / e2e-text" }).click();
    await contractDrawer.getByLabel("契约响应型号").fill("e2e-text");
    await contractDrawer.getByLabel("契约服务档位").fill("default");
    await contractDrawer.getByLabel("渠道别名身份来源").fill("https://example.com/e2e-pricing");
    await contractDrawer.getByLabel("渠道别名核对依据").fill("本地夹具已核对渠道 e2e-text 与所选官网 SKU 的精确对应关系");
    for (const meter of ["inputTokens", "cachedInputTokens", "cacheWriteTokens"]) {
        await contractDrawer.getByRole("checkbox", { name: `inputTokens 映射 ${meter}` }).check();
    }
    await contractDrawer.getByRole("checkbox", { name: "outputTokens 映射 outputTokens" }).check();
    await contractDrawer.getByLabel("契约核对依据").fill("本地夹具官网分项和渠道响应样本已逐项核对");
    await contractDrawer.getByLabel("文本预留估算来源").fill("https://example.com/e2e-estimate");
    await contractDrawer.getByLabel("文本预留估算依据").fill("本地请求大小与输出样本已核对，未知提交保留预留，实际用量结算差额");
    await expect(contractDrawer.getByRole("button", { name: "审核并保存契约" })).toBeEnabled();
    await contractDrawer.getByRole("button", { name: "审核并保存契约" }).click();
    await expect(contractDrawer.getByText("当前", { exact: true })).toBeVisible();
    await contractDrawer.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "核对文本用量契约" }).click();
    const reopenedContract = page.getByRole("dialog", { name: "核对纯文本用量契约" });
    await reopenedContract.getByLabel("契约渠道绑定").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "E2E 主渠道 / e2e-text" }).click();
    await expect(reopenedContract.getByLabel("契约核对依据")).toHaveValue("本地夹具官网分项和渠道响应样本已逐项核对");
    await expect(reopenedContract.getByLabel("文本预留估算来源")).toHaveValue("https://example.com/e2e-estimate");
    await expect(reopenedContract.getByLabel("文本预留估算依据")).toHaveValue("本地请求大小与输出样本已核对，未知提交保留预留，实际用量结算差额");
    await expect(reopenedContract.getByText("当前", { exact: true })).toBeVisible();
    await reopenedContract.getByLabel("契约缓存写入计费方式").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "官方已确认缓存写入按普通输入价" }).click();
    await expect(reopenedContract.getByRole("button", { name: "审核并保存契约" })).toBeDisabled();
    await expect(reopenedContract.getByRole("checkbox", { name: "inputTokens 映射 cacheWriteTokens" })).toHaveCount(0);
    for (const meter of ["uncachedInputTokens", "cachedInputTokens"]) await reopenedContract.getByRole("checkbox", { name: `inputTokens 映射 ${meter}` }).check();
    await reopenedContract.getByRole("checkbox", { name: "outputTokens 映射 outputTokens" }).check();
    await reopenedContract.getByLabel("契约核对依据").fill("本地夹具官方写入与普通输入同价，按总输入减缓存读取核对");
    await reopenedContract.getByRole("checkbox", { name: "核对请求硬上限（含推理 Token）" }).check();
    await expect(reopenedContract.getByRole("button", { name: "审核并保存契约" })).toBeDisabled();
    await reopenedContract.getByLabel("输入总量上限", { exact: true }).fill("1000");
    await reopenedContract.getByLabel("单候选输出上限").fill("100");
    await reopenedContract.getByLabel("候选数量上限").fill("2");
    await reopenedContract.getByLabel("上限官方来源").fill("https://example.com/fixture-limits");
    await reopenedContract.getByLabel("上限核对依据").fill("本地测试夹具：输入含缓存，输出含推理，最多两个候选");
    await reopenedContract.getByRole("button", { name: "审核并保存契约" }).click();
    await expect(reopenedContract.getByText("历史", { exact: true })).toBeVisible();
    await reopenedContract.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "核对文本用量契约" }).click();
    await reopenedContract.getByLabel("契约渠道绑定").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "E2E 主渠道 / e2e-text" }).click();
    await expect(reopenedContract.getByRole("checkbox", { name: "inputTokens 映射 uncachedInputTokens" })).toBeChecked();
    await expect(reopenedContract.getByLabel("契约核对依据")).toHaveValue("本地夹具官方写入与普通输入同价，按总输入减缓存读取核对");
    await expect(reopenedContract.getByLabel("输入总量上限", { exact: true })).toHaveValue("1000");
    await expect(reopenedContract.getByLabel("单候选输出上限")).toHaveValue("100");
    await expect(reopenedContract.getByLabel("候选数量上限")).toHaveValue("2");
    await expect(reopenedContract.getByLabel("上限官方来源")).toHaveValue("https://example.com/fixture-limits");
    await expect(reopenedContract.getByLabel("上限核对依据")).toHaveValue("本地测试夹具：输入含缓存，输出含推理，最多两个候选");
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
            .poll(() =>
                reopenedContract.evaluate((element, viewportWidth) => {
                    const bounds = element.getBoundingClientRect();
                    if (bounds.x !== 0 || bounds.width !== viewportWidth || element.scrollWidth > viewportWidth) return false;
                    return ["输入总量上限", "单候选输出上限", "候选数量上限", "上限官方来源", "上限核对依据", "文本预留估算来源", "文本预留估算依据", "契约缓存写入计费方式"].every((name) => {
                        const input = element.querySelector(`[aria-label="${name}"]`);
                        const control = name === "契约缓存写入计费方式" ? input?.closest(".ant-select") : input;
                        const field = control?.getBoundingClientRect();
                        return field && field.width > 0 && field.left >= bounds.left && field.right <= bounds.right;
                    });
                }, width),
            )
            .toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await reopenedContract.locator(".ant-drawer-close").click();
    await modelDrawer.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "售价规则与折算" }).click();
    await page.getByRole("button", { name: "汇率与币种折算" }).click();
    await page.getByRole("button", { name: "调整美元/人民币汇率" }).click();
    const conversionForm = page.getByRole("dialog", { name: "调整美元/人民币汇率" });
    await conversionForm.getByLabel("美元兑人民币汇率").fill("10");
    await conversionForm.getByLabel("汇率换算依据").fill("E2E 财务定价单");
    await conversionForm.getByRole("button", { name: "保存汇率" }).click();
    await expect(conversionForm).toHaveCount(0);
    await page.getByRole("button", { name: "模型工作台" }).click();
    await workbenchSearch.fill("e2e-text");
    await workbenchSearch.press("Enter");
    await page.getByText("e2e-text", { exact: true }).first().locator("..").locator("..").getByRole("button", { name: "查看与处理" }).click();
    modelDrawer = page.getByRole("dialog", { name: /模型售价与渠道/ });
    await modelDrawer.getByRole("button", { name: "该模型计价条件" }).click();
    await page.getByLabel("样例用量 inputTokens").fill("0");
    await page.getByLabel("样例用量 outputTokens").fill("0");
    const emptyPreviewResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/admin/model-pricing") && response.request().postDataJSON()?.action === "preview");
    await page.getByRole("button", { name: "按样例用量预览" }).click();
    const emptyPreview = await emptyPreviewResponse;
    expect(emptyPreview.ok(), await emptyPreview.text()).toBe(true);
    await expect(page.getByText("样例应收 0.00 积分", { exact: false })).toBeVisible();
    await page.getByLabel("样例用量 inputTokens").fill("100000");
    await modelDrawer.getByLabel("独立选价用户售价系数").fill("0.8");
    const pricedPreviewResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/admin/model-pricing") && response.request().postDataJSON()?.action === "preview");
    await page.getByRole("button", { name: "按样例用量预览" }).click();
    const pricedPreview = await pricedPreviewResponse;
    expect(pricedPreview.ok(), await pricedPreview.text()).toBe(true);
    await expect(page.getByText("样例应收 80.00 积分", { exact: false })).toBeVisible();
    await expect(modelDrawer.getByLabel("独立选价用户售价系数")).toHaveValue("0.8");
    await page.getByRole("button", { name: "发布销售版本" }).click();
    await page
        .getByRole("dialog", { name: "发布新的用户销售版本？" })
        .getByRole("button", { name: /确\s*定/ })
        .click();
    await expect(modelDrawer).toContainText("当前发布版本");
    const pricingResponse = await request.get("/api/admin/model-pricing?modelId=e2e-text");
    expect(pricingResponse.ok(), await pricingResponse.text()).toBe(true);
    const publishedPricing = (await pricingResponse.json()).data.salesVersions.at(-1);
    expect(publishedPricing.selectedPriceBindings).toEqual([expect.objectContaining({ logicalModelId: "e2e-text", scope: "text:generation:standard" })]);
    expect(publishedPricing.priceVersionIds["e2e-text"]).toBeUndefined();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByRole("button", { name: "核对文本用量契约" })).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "核对文本用量契约" }).click();
    const publishedContract = page.getByRole("dialog", { name: "核对纯文本用量契约" });
    await publishedContract.getByLabel("契约渠道绑定").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "E2E 主渠道 / e2e-text" }).click();
    await expect(publishedContract.getByLabel("单候选输出上限")).toHaveValue("100");
    await publishedContract.getByLabel("单候选输出上限").fill("128");
    await publishedContract.getByLabel("上限核对依据").fill("本地测试夹具：已发布后复核渠道真实输出上限为 128，含推理 Token");
    await publishedContract.getByRole("button", { name: "审核并保存契约" }).click();
    await expect(publishedContract.getByLabel("单候选输出上限")).toHaveValue("128");
    await publishedContract.locator(".ant-drawer-close").click();
    await expect(modelDrawer.getByText("纯文本缓存缺失规则")).toBeVisible();
    await modelDrawer.getByRole("checkbox", { name: "缓存读取未报告按 0" }).check();
    await modelDrawer.getByLabel("文本缓存缺失规则核对依据").fill("本地测试夹具：该型号缓存读取缺失时依据审核规则按零，实际报告值优先");
    await modelDrawer.getByRole("button", { name: "审核并保存规则" }).click();
    await expect(modelDrawer.getByText(/已审核版本：(?!默认均关闭)/)).toBeVisible();
    const ruleResponse = await request.get("/api/admin/model-pricing/text-usage-rules?modelId=e2e-text");
    expect(ruleResponse.ok(), await ruleResponse.text()).toBe(true);
    expect((await ruleResponse.json()).data.rules[0]).toMatchObject({ cacheReadMissingAsZero: true, cacheWriteMissingAsZero: false });
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await expect(modelDrawer.getByRole("checkbox", { name: "缓存读取未报告按 0" })).toBeVisible();
    }
    const afterResponse = await request.get("/api/admin/settings");
    expect(((await afterResponse.json()) as { settings: { modelPointCosts: Record<string, number> } }).settings.modelPointCosts).toEqual(fixedPoints);
    expect((await request.patch("/api/admin/settings", { data: { logicalModels: originalModels } })).ok()).toBe(true);
});

test("unmatched official price evidence survives readback and requires administrator confirmation", async ({ request }) => {
    const officialModelId = `seedream-fixture-${randomUUID()}`;
    const evidence = `${officialModelId} output 0.05 USD per image`;
    const sourceUrl = "https://docs.byteplus.com/en/docs/modelark/model-pricing";
    const saved = await request.post("/api/admin/model-pricing/observations", {
        data: {
            manufacturer: "ByteDance / Volcengine",
            officialModelId,
            sourceUrl,
            sourceDigest: createHmac("sha256", "fixture").update(evidence).digest("hex"),
            sourceMode: "website",
            observedAt: new Date().toISOString(),
            evidence,
            sourceRowIds: ["fixture-row"],
            conditions: "standard image",
            items: [{ key: "output", unit: "image", per: "1", price: "0.05", currency: "USD" }],
        },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const observation = ((await saved.json()) as { data: { id: string; reviewStatus: string } }).data;
    expect(observation.reviewStatus).toBe("pending");
    const disposableId = `seedream-delete-${randomUUID()}`;
    const disposableEvidence = `${disposableId} output 0.05 USD per image`;
    const disposable = await request.post("/api/admin/model-pricing/observations", {
        data: {
            manufacturer: "ByteDance / Volcengine",
            officialModelId: disposableId,
            sourceUrl,
            sourceDigest: createHmac("sha256", "fixture").update(disposableEvidence).digest("hex"),
            sourceMode: "website",
            observedAt: new Date().toISOString(),
            evidence: disposableEvidence,
            sourceRowIds: [],
            conditions: "standard image",
            items: [{ key: "output", unit: "image", per: "1", price: "0.05", currency: "USD" }],
        },
    });
    expect(disposable.ok(), await disposable.text()).toBe(true);
    const disposableRecord = ((await disposable.json()) as { data: { id: string } }).data;
    const removed = await request.delete("/api/admin/model-pricing/observations", { data: { id: disposableRecord.id } });
    expect(removed.ok(), await removed.text()).toBe(true);
    const pendingAfterDelete = await request.get("/api/admin/model-pricing/observations?status=pending&manufacturer=ByteDance%20%2F%20Volcengine");
    expect(((await pendingAfterDelete.json()) as { data: { observations: Array<{ id: string }> } }).data.observations.some((item) => item.id === disposableRecord.id)).toBe(false);
    const premature = await request.patch("/api/admin/model-pricing/observations", { data: { action: "bind", id: observation.id } });
    expect(premature.status()).toBe(409);
    const reviewed = await request.patch("/api/admin/model-pricing/observations", { data: { action: "review", id: observation.id, status: "confirmed", note: "E2E evidence checked" } });
    expect(reviewed.ok(), await reviewed.text()).toBe(true);
    const readback = await request.get("/api/admin/model-pricing/observations?manufacturer=ByteDance%20%2F%20Volcengine");
    expect(readback.ok(), await readback.text()).toBe(true);
    const persisted = ((await readback.json()) as { data: { observations: Array<{ id: string; officialModelId: string; reviewStatus: string; items: Array<{ price: string }> }>; links: Array<{ observationId: string }> } }).data;
    expect(persisted.observations).toContainEqual(expect.objectContaining({ id: observation.id, officialModelId, reviewStatus: "confirmed", items: [expect.objectContaining({ price: "0.05" })] }));
    expect(persisted.links.some((link) => link.observationId === observation.id)).toBe(false);
});

test("generic price AI review selects a vendor and saved source, then waits for admin confirmation", async ({ page }) => {
    const officialModelId = "seedream-4-5-251128";
    const unmatchedId = "seedream-5-0-260628";
    const unmatchedEvidence = `${unmatchedId} Pricing varies by resolution. ${"InputWithoutVideoOutputResolution480p720p1080p".repeat(4)} Output 0.05 USD / image`;
    const logicalModelId = "ByteDance-Seedream-4.5";
    const discoveredLogicalModelId = "ByteDance-Seedream-5.0";
    const evidence = `${officialModelId} Output 0.04 USD / image`;
    const selectedUrl = "https://docs.byteplus.com/en/docs/ModelArk/seedream-pricing";
    const candidate = {
        logicalModelId,
        manufacturer: "ByteDance / Volcengine",
        series: "Seedream",
        officialVersion: officialModelId,
        sku: officialModelId,
        tier: "paid",
        conditions: "标准图片生成",
        sourceKind: "manual",
        sourceUrl: selectedUrl,
        evidence,
        observedAt: "2026-09-30T00:00:00Z",
        items: [{ key: "outputImages", unit: "image", per: "1", price: "0.04", currency: "USD" }],
    };
    let candidatePosted = false;
    let marked = false;
    let selectedSourceSubmitted = false;
    let archived: Record<string, unknown> | null = null;
    let archiveLink: Record<string, unknown> | null = null;
    await page.route("**/api/admin/model-pricing/observations?*", async (route) => {
        const status = new URL(route.request().url()).searchParams.get("status");
        const visible = archived && (status === "all" || !status || archived.reviewStatus === status || (status === "open" && archived.reviewStatus !== "rejected")) ? [archived] : [];
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: { observations: visible, links: archiveLink && visible.length ? [archiveLink] : [], total: visible.length, page: 1, pageSize: 20 }, msg: "ok" }) });
    });
    await page.route("**/api/admin/model-pricing/observations", async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if (route.request().method() === "POST") archived = { ...body, id: "a".repeat(64), createdAt: new Date().toISOString(), createdBy: "admin", reviewStatus: "pending" };
        if (body.action === "amend" && archived)
            archived = {
                ...archived,
                amendments: [
                    ...((archived.amendments as unknown[]) || []),
                    {
                        revision: ((archived.amendments as unknown[]) || []).length + 1,
                        variantIndex: body.variantIndex,
                        items: body.items,
                        itemEvidence: body.itemEvidence,
                        conditions: body.conditions,
                        reason: body.reason,
                        editedAt: new Date().toISOString(),
                        editedBy: "admin",
                    },
                ],
            };
        if (body.action === "review" && archived) archived = { ...archived, reviewStatus: body.status };
        if (body.action === "bind") archiveLink = body.logicalModelId ? { observationId: body.id, logicalModelId: body.logicalModelId, linkedAt: new Date().toISOString(), linkedBy: "admin" } : null;
        if (body.action === "invalidate" && archived) {
            archived = { ...archived, reviewStatus: "rejected", reviewNote: `撤销确认：${body.reason}` };
            archiveLink = null;
        }
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: body.action === "bind" ? archiveLink : archived, msg: "ok" }) });
    });
    await page.route("**/api/admin/model-pricing?*", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        if (new URL(route.request().url()).pathname !== "/api/admin/model-pricing") return route.continue();
        const action = new URL(route.request().url()).searchParams.get("action");
        if (action === "review-links") {
            await route.fulfill({
                contentType: "application/json",
                body: JSON.stringify({
                    code: 0,
                    data: [
                        { label: "当前厂商官网链接", url: "https://docs.byteplus.com/en/docs/modelark/model-pricing" },
                        { label: "Seedream", url: selectedUrl },
                    ],
                    msg: "ok",
                }),
            });
            return;
        }
        if (action) return route.continue();
        const response = await route.fetch();
        const payload = (await response.json()) as { data: { models: Array<{ id: string; name: string; capability: string; manufacturer?: string; series?: string }> } };
        payload.data.models.push({ id: logicalModelId, name: logicalModelId, capability: "image", manufacturer: "ByteDance / Volcengine", series: "Seedream" });
        payload.data.models.push({ id: discoveredLogicalModelId, name: discoveredLogicalModelId, capability: "image", manufacturer: "ByteDance / Volcengine", series: "Seedream" });
        await route.fulfill({ response, json: payload });
    });
    await page.route("**/api/admin/model-pricing/ai-review", async (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as { manufacturer: string; sourceUrl: string };
            selectedSourceSubmitted = body.manufacturer === "ByteDance / Volcengine" && body.sourceUrl === selectedUrl;
            const reviewResult = {
                manufacturer: "ByteDance / Volcengine",
                sourceUrl: candidate.sourceUrl,
                retirementUrl: "https://docs.byteplus.com/en/docs/modelark/model-deprecation-notice",
                observedAt: candidate.observedAt,
                sourceDigest: "a".repeat(64),
                sourceMode: "admin-excerpt",
                retirementMode: "admin-excerpt",
                sourceOfficialModelIds: [officialModelId, unmatchedId],
                missingOfficialModelIds: [],
                aiReturnedCount: 3,
                warnings: [],
                findings: [
                    {
                        logicalModelId,
                        officialModelId,
                        status: "new",
                        reason: "官网有价",
                        evidence,
                        sourceRowIds: ["t0r1"],
                        currentPriceId: null,
                        currentItems: [],
                        currentConditions: null,
                        observedItems: candidate.items,
                        observedConditions: candidate.conditions,
                        pendingCandidateId: null,
                        deactivationDate: null,
                        candidate,
                    },
                    {
                        logicalModelId: null,
                        officialModelId: unmatchedId,
                        status: "unmatched",
                        reason: "平台暂无该型号",
                        evidence: unmatchedEvidence,
                        sourceRowIds: ["t0r2"],
                        currentPriceId: null,
                        currentItems: [],
                        currentConditions: null,
                        observedItems: [{ key: "outputImages", unit: "image", per: "1", price: "0.05", currency: "USD" }],
                        observedConditions: "标准图片生成",
                        pendingCandidateId: null,
                        deactivationDate: null,
                        candidate: null,
                    },
                    {
                        logicalModelId,
                        officialModelId: "seedream-4-0-older",
                        status: "confirmed-retired",
                        reason: "公告确认停用",
                        evidence: "seedream-4-0-older was deactivated on January 1, 2026",
                        sourceRowIds: [],
                        currentPriceId: null,
                        currentItems: [],
                        currentConditions: null,
                        observedItems: [],
                        observedConditions: "",
                        extractionIssue: "",
                        pendingCandidateId: null,
                        deactivationDate: "2026-01-01",
                        candidate: null,
                    },
                ],
            };
            const stages = ["source", "retirement", "platform", "model", "validation"];
            const progress = stages.map((stage) => `event: progress\ndata: ${JSON.stringify({ stage, status: "done", detail: `${stage} complete` })}\n\n`).join("");
            await route.fulfill({
                contentType: "text/event-stream",
                body: `${progress}event: partial\ndata: ${JSON.stringify({ ...reviewResult, findings: reviewResult.findings.slice(0, 1) })}\n\nevent: result\ndata: ${JSON.stringify(reviewResult)}\n\n`,
            });
            return;
        }
        marked = true;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: null, msg: "ok" }) });
    });
    await page.route("**/api/admin/model-pricing", async (route) => {
        if (route.request().method() !== "POST" || route.request().postDataJSON()?.action !== "candidate") return route.continue();
        candidatePosted = true;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: 0, data: { id: "fixture-candidate" }, msg: "ok" }) });
    });
    await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "官方价与证据" }).click();
    await page.getByRole("button", { name: "AI 核对官网价目" }).click();
    const drawer = page.getByRole("dialog", { name: "AI 核对官网价目" });
    await drawer.getByLabel("核价模型厂商").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "ByteDance / Volcengine" }).click();
    await drawer.getByLabel("核价官网价格链接").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: selectedUrl }).click();
    await drawer.getByLabel("官网价目摘录").fill(evidence);
    await drawer.getByRole("button", { name: "读取官网并开始核对" }).click();
    expect(selectedSourceSubmitted).toBe(true);
    await expect(drawer.getByRole("status").getByText("核对进度")).toBeVisible();
    await expect(drawer.getByRole("status").getByText("默认文本模型核对")).toBeVisible();
    await expect(drawer.getByRole("status").getByText("已完成")).toHaveCount(5);
    await expect(drawer.getByText("新价目")).toBeVisible();
    await expect(drawer.getByText("停用日期已过")).toBeVisible();
    await drawer.getByRole("button", { name: "核对并录入价目" }).first().click();
    const candidateDialog = page.getByRole("dialog", { name: "录入官方价目候选" });
    await expect(candidateDialog.getByLabel("官方模型 ID／产品标识")).toHaveValue(officialModelId);
    await expect(candidateDialog.getByText(/当前待补齐：/)).toContainText("免费/付费档");
    await candidateDialog.getByLabel("官方系列").fill("Seedream");
    await candidateDialog.getByLabel("官方模型版本").fill(officialModelId);
    await candidateDialog.getByLabel("免费付费档").click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "付费档" }).click();
    await candidateDialog.getByRole("button", { name: "提交待审核" }).click();
    expect(candidatePosted).toBe(true);
    await drawer.getByRole("button", { name: "确认标记停用" }).click();
    expect(marked).toBe(true);
    await drawer.getByText(unmatchedId, { exact: true }).locator("..").locator("..").getByRole("button", { name: "保存官网发现" }).click();
    expect(archived).toMatchObject({ officialModelId: unmatchedId, items: [{ price: "0.05" }] });
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
            .poll(
                () =>
                    drawer.evaluate((element) => {
                        const bounds = element.getBoundingClientRect();
                        return bounds.left >= 0 && bounds.right <= window.innerWidth + 1;
                    }),
                `Drawer stays inside ${width}px viewport`,
            )
            .toBe(true);
        await expect.poll(() => drawer.locator(".ant-drawer-body").evaluate((body) => body.scrollWidth - body.clientWidth), `Drawer body has no horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
    await drawer.getByRole("button", { name: "关闭" }).click();
    await page.getByRole("button", { name: "官网发现档案" }).click();
    const archiveSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "官网模型发现档案" }) });
    await expect(archiveSection.getByText(unmatchedId, { exact: true })).toBeVisible();
    const archiveCard = archiveSection.getByTestId("official-observation-card");
    await archiveCard.getByText("查看官网价格与原文证据").click();
    const archiveEvidence = archiveCard.getByTestId("official-observation-evidence");
    await expect(archiveEvidence).toHaveText(unmatchedEvidence);
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await archiveCard.evaluate((card) => {
            const evidence = card.querySelector('[data-testid="official-observation-evidence"]') as HTMLElement;
            const bounds = card.getBoundingClientRect();
            return { cardOverflow: card.scrollWidth - card.clientWidth, evidenceOverflow: evidence.scrollWidth - evidence.clientWidth, left: bounds.left, right: bounds.right, viewport: window.innerWidth };
        });
        expect(layout.cardOverflow, `${width}px card overflow`).toBeLessThanOrEqual(1);
        expect(layout.evidenceOverflow, `${width}px evidence overflow`).toBeLessThanOrEqual(1);
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1);
    }
    await archiveSection.getByRole("button", { name: "修订价格组 1" }).click();
    const correctionDialog = page.getByRole("dialog", { name: `修订官网发现 · ${unmatchedId}` });
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await correctionDialog.evaluate((dialog) => ({ left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, overflow: dialog.scrollWidth - dialog.clientWidth, viewport: window.innerWidth }));
        expect(bounds.left, `${width}px correction dialog left`).toBeGreaterThanOrEqual(0);
        expect(bounds.right, `${width}px correction dialog right`).toBeLessThanOrEqual(bounds.viewport + 1);
        expect(bounds.overflow, `${width}px correction dialog overflow`).toBeLessThanOrEqual(1);
    }
    await correctionDialog.getByLabel("项目 1 标识").fill("verifiedOutputImages");
    await correctionDialog.getByLabel("官网发现修订原因").fill("核对官网后补齐分项标识");
    await correctionDialog.getByRole("button", { name: "保存修订，仍待确认" }).click();
    await expect(correctionDialog).toHaveCount(0);
    await expect(archiveCard.getByText("人工修订第 1 版")).toBeVisible();
    await archiveSection.getByRole("button", { name: "确认证据" }).click();
    await page
        .getByRole("button", { name: /确\s*定/ })
        .last()
        .click();
    await expect(archiveSection.getByText(unmatchedId, { exact: true })).toHaveCount(0);
    const pendingSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "待审价目候选" }) });
    await expect(pendingSection.getByText(unmatchedId, { exact: true })).toBeVisible();
    await pendingSection.getByRole("button", { name: "编辑分项并填写候选" }).click();
    const draftDialog = page.getByRole("dialog", { name: "录入官方价目候选" });
    await expect(draftDialog.getByText("此表单与“录入官方价目”共用同一提交流程。", { exact: false })).toBeVisible();
    await expect(draftDialog.getByLabel("官方模型 ID／产品标识")).toHaveValue(unmatchedId);
    await expect(draftDialog.getByLabel("项目 1 单价")).toHaveValue("0.05");
    await expect(draftDialog.getByLabel("项目 1 标识")).toHaveValue("verifiedOutputImages");
    for (const width of [390, 430, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await draftDialog.evaluate((dialog) => ({ left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, overflow: dialog.scrollWidth - dialog.clientWidth, viewport: window.innerWidth }));
        expect(bounds.left, `${width}px dialog left`).toBeGreaterThanOrEqual(0);
        expect(bounds.right, `${width}px dialog right`).toBeLessThanOrEqual(bounds.viewport + 1);
        expect(bounds.overflow, `${width}px dialog overflow`).toBeLessThanOrEqual(1);
    }
    await draftDialog.getByLabel("项目 1 单价").fill("0.06");
    await expect(draftDialog.getByLabel("项目 1 单价")).toHaveValue("0.06");
    await draftDialog.getByRole("button", { name: /取\s*消/ }).click();
    await page.getByRole("button", { name: "放弃并关闭" }).click();
    await expect(pendingSection.getByLabel(`${unmatchedId} 关联逻辑模型`)).toHaveCount(0);
    const preparationCard = pendingSection.locator(".rounded-lg.border").filter({ hasText: unmatchedId }).first();
    for (const width of [1440, 390, 430]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await preparationCard.evaluate((card) => ({ left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right, overflow: card.scrollWidth - card.clientWidth, viewport: window.innerWidth }));
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
        expect(bounds.overflow).toBeLessThanOrEqual(1);
    }
    await pendingSection.getByRole("button", { name: "编辑分项并填写候选" }).click();
    await expect(page.getByRole("dialog", { name: "录入官方价目候选" }).getByLabel("官方模型 ID／产品标识")).toHaveValue(unmatchedId);
    await expect(page.getByRole("dialog", { name: "录入官方价目候选" }).getByText(/当前待补齐：/)).toContainText("免费/付费档");
    await page
        .getByRole("dialog", { name: "录入官方价目候选" })
        .getByRole("button", { name: /取\s*消/ })
        .click();
    await pendingSection.getByRole("button", { name: "撤销确认" }).click();
    const invalidationDialog = page.getByRole("dialog", { name: `撤销 ${unmatchedId} 的证据确认` });
    await invalidationDialog.getByLabel("撤销确认原因").fill("测试确认，价格尚未整理完成");
    await invalidationDialog.getByRole("button", { name: "撤销确认并解除关联" }).click();
    await expect(pendingSection.getByText(unmatchedId, { exact: true })).toHaveCount(0);
    expect(archiveLink).toBeNull();
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

test("text conversation sends screenshot pixels and keeps follow-up context", async ({ page, request }) => {
    const screenshot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=", "base64");
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await page.getByRole("button", { name: "当前创作类型：Agent 模式" }).click();
    const modePicker = page.locator(".ant-popover").filter({ hasText: "创作类型" }).last();
    await modePicker.getByRole("button", { name: /文本对话/ }).click();
    await expect(page.getByRole("button", { name: "当前创作类型：文本对话" })).toBeVisible();
    await expect(page.getByRole("button", { name: "选择创作 Skill" })).toHaveCount(0);
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const composer = await page.locator(".creative-composer").boundingBox();
        expect(composer).not.toBeNull();
        expect(composer!.x + composer!.width).toBeLessThanOrEqual(width);
        await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: "chart.png", mimeType: "image/png", buffer: screenshot });
    await expect(page.locator(".creative-composer img")).toHaveCount(1);

    await page.getByRole("textbox", { name: "提问，或上传截图进行解读" }).fill("请解读这张图表");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送" }).click();
    const first = await created;
    expect(first.ok(), await first.text()).toBe(true);
    const firstRunId = ((await first.json()) as { data: { run: { id: string } } }).data.run.id;
    await waitForAgentRun(request, firstRunId);
    await expect(page.getByText("协议测试文本返回成功", { exact: true })).toBeVisible();
    const firstRequests = (await protocolFixtureState(request)).requests.filter((item) => item.path.endsWith("/chat/completions"));
    expect(firstRequests).toHaveLength(1);
    expect(firstRequests[0]).toMatchObject({ model: "e2e-text", imageCount: 1, messageCount: 2 });

    await page.getByRole("textbox", { name: "提问，或上传截图进行解读" }).fill("接着解释变化趋势");
    const followUp = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送" }).click();
    const second = await followUp;
    expect(second.ok(), await second.text()).toBe(true);
    await waitForAgentRun(request, ((await second.json()) as { data: { run: { id: string } } }).data.run.id);
    const requests = (await protocolFixtureState(request)).requests.filter((item) => item.path.endsWith("/chat/completions"));
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ imageCount: 0, messageCount: 4 });
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
    const taskReference = page.getByTestId("creative-task-id").filter({ hasText: runId });
    await expect(taskReference).toBeVisible();
    await expect(taskReference.getByRole("button", { name: `复制任务 ID ${runId}` })).toBeVisible();
    const videoResponse = await request.get((await video.getAttribute("src"))!);
    expect(videoResponse.ok(), await videoResponse.text()).toBe(true);
    expect(videoResponse.headers()["content-type"]).toMatch(/^video\/mp4/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("creative-task-id").filter({ hasText: runId })).toBeVisible();
    for (const width of [390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const copyButton = page.getByRole("button", { name: `复制任务 ID ${runId}` });
        await expect(copyButton).toBeVisible();
        const bounds = await copyButton.boundingBox();
        expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }

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
    page.on("request", (current) => {
        if (current.method() !== "POST" || new URL(current.url()).pathname !== "/api/drama/analyze") return;
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

for (const mode of ["legacy", "usage", "shadow", "hailuo-shadow", "hailuo-fast-shadow"])
    test(
        mode.startsWith("hailuo-")
            ? `Hailuo ${mode} freezes its original tariff without changing fixed billing`
            : mode === "shadow"
              ? "H3 video shadow freezes its original price without changing fixed billing"
              : mode === "usage"
                ? "H3 video usage persists private original meters while media stays playable"
                : "Hailuo legacy video resolves its original file and persists playable media",
        async ({ page, request }) => {
            const h3 = mode === "usage" || mode === "shadow";
            const shadow = mode.endsWith("shadow");
            const before = (await (await request.get("/api/admin/settings")).json()).settings;
            const model = h3 ? "MiniMax-H3" : mode === "hailuo-fast-shadow" ? "MiniMax-Hailuo-2.3-Fast" : "MiniMax-Hailuo-2.3";
            const logicalModelId = mode === "hailuo-fast-shadow" ? "e2e-hailuo-fast" : "e2e-hailuo";
            const channel = applyChannelProtocol({ id: "e2e-hailuo", name: "Hailuo fixture", baseUrl: E2E_PROTOCOL_ORIGIN, apiKey: "fixture-key", apiFormat: "openai", models: [model], enabled: true }, "minimax");
            const saved = await request.patch("/api/admin/settings", {
                data: {
                    systemChannels: [...before.systemChannels, channel],
                    logicalModels: [
                        ...before.logicalModels,
                        { id: logicalModelId, name: "Hailuo fixture", manufacturer: "MiniMax", capability: "video", enabled: true, bindings: [{ channelId: channel.id, upstreamModel: model, enabled: true, priority: 0 }] },
                    ],
                    modelPointCosts: { ...before.modelPointCosts, [logicalModelId]: shadow ? 0.25 : 0 },
                },
            });
            expect(saved.ok(), await saved.text()).toBe(true);
            let userId: string | undefined;
            try {
                const username = `e2e_hailuo_${randomUUID().slice(0, 8)}`;
                const userResponse = await request.post("/api/admin/users", { data: { username, password: E2E_ADMIN.password, role: "user", pointsBalance: shadow ? 10 : 0 } });
                expect(userResponse.ok(), await userResponse.text()).toBe(true);
                userId = (await userResponse.json()).user.id;
                const login = await page.request.post("/api/auth/login", {
                    data: { username, password: E2E_ADMIN.password },
                    headers: { "user-agent": `vozeb-e2e-${username}` },
                });
                expect(login.ok(), await login.text()).toBe(true);
                const clientRequestId = `e2e-hailuo:${randomUUID()}`;
                const body = {
                    config: { model: logicalModelId, vquality: h3 ? "768" : "1080", videoSeconds: h3 ? 5 : 6, size: "16:9" },
                    references: mode === "hailuo-fast-shadow" ? [{ type: "image", role: "first_frame", url: `${E2E_PROTOCOL_ORIGIN}/media/fixture.png` }] : [],
                    prompt: shadow ? (h3 ? "fixture-h3-shadow" : "fixture-hailuo-shadow") : h3 ? "fixture-h3-usage" : "Hailuo protocol fixture",
                    source: "video-workbench",
                    context: { clientRequestId },
                };
                let salesId: string | undefined;
                if (shadow) {
                    const candidate = await request.post("/api/admin/model-pricing", {
                        data: {
                            action: "candidate",
                            price: {
                                logicalModelId,
                                manufacturer: "MiniMax",
                                series: h3 ? "H3" : "Hailuo",
                                officialVersion: `e2e-shadow-${randomUUID()}`,
                                sku: model,
                                tier: "paid",
                                conditions: "仅本地夹具：全球标准视频单价",
                                sourceKind: "manual",
                                sourceUrl: "https://example.com/fixture-video-shadow",
                                evidence: "本地合成价格",
                                observedAt: new Date().toISOString(),
                                items: h3
                                    ? [
                                          ...["768P", "2K"].flatMap((r) => ["input", "output"].map((k) => ({ key: `${r}-${k}`, unit: "second", per: "1", price: "0.08", currency: "USD" }))),
                                          { key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" },
                                          { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
                                      ]
                                    : ["768P-6", "768P-10", "1080P-6"].map((key, i) => ({ key, unit: "video", per: "1", price: ["0.0015", "0.123", "0.789"][i], currency: "USD" })),
                            },
                        },
                    });
                    expect(candidate.ok(), await candidate.text()).toBe(true);
                    const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: (await candidate.json()).data.id, approved: true, note: "本地视频影子验收" } });
                    expect(reviewed.ok(), await reviewed.text()).toBe(true);
                    const versionId = (await reviewed.json()).data.versionId;
                    const contract = await request.post("/api/admin/model-pricing/video-contracts", {
                        data: {
                            officialVersionId: versionId,
                            expectedCurrentId: null,
                            contract: h3
                                ? {
                                      channelId: channel.id,
                                      requestedModel: model,
                                      protocol: "minimax-video-v2",
                                      scope: "global-standard-minimax-h3-generation",
                                      resolutionItems: Object.fromEntries(["768P", "2K"].map((r) => [r, { inputSeconds: `${r}-input`, outputSeconds: `${r}-output` }])),
                                      inputImageItem: "images",
                                      inputImagePricing: "all-at-standard-rate",
                                      inputAudioItem: "inputAudioSeconds",
                                      evidence: "本地 H3 原任务用量夹具",
                                  }
                                : {
                                      channelId: channel.id,
                                      requestedModel: model,
                                      protocol: "minimax-hailuo-v1",
                                      scope: "global-standard-minimax-hailuo-generation",
                                      tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
                                      evidence: "本地 Hailuo 原任务文件夹具",
                                  },
                        },
                    });
                    expect(contract.ok(), await contract.text()).toBe(true);
                    const overview = (await (await request.get("/api/admin/model-pricing")).json()).data;
                    const exchange = await request.patch("/api/admin/model-pricing", {
                        data: { action: "exchange-rate", exchangeRate: { cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "本地视频汇率" }, expectedObservedAt: overview.exchangeRate?.observedAt || null },
                    });
                    expect(exchange.ok(), await exchange.text()).toBe(true);
                    const previewResponse = await request.post("/api/admin/model-pricing", {
                        data: {
                            action: "preview",
                            modelId: logicalModelId,
                            usage: h3 ? { "768P-input": "0", "768P-output": "5.25", "2K-input": "0", "2K-output": "0", images: "0" } : { "768P-6": "0", "768P-10": "0", "1080P-6": "1" },
                            policy: {
                                priceVersionIds: { [logicalModelId]: versionId },
                                selectedPriceBindings: [],
                                userPriceRules: [],
                                conversion: { ...(await exchange.json()).data, pointsPerCny: "100" },
                                usdPerCurrency: {},
                                pointsPerCurrency: {},
                                rateEvidence: {},
                            },
                        },
                    });
                    expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
                    const preview = (await previewResponse.json()).data;
                    expect(preview.policy.selectedPriceBindings).toEqual([]);
                    const published = await request.patch("/api/admin/model-pricing", {
                        data: { action: "publish", policy: preview.policy, currentSalesVersionId: preview.currentSalesVersionId, previewToken: preview.previewToken },
                    });
                    expect(published.ok(), await published.text()).toBe(true);
                    salesId = (await published.json()).data.id;
                }
                const created = await page.request.post("/api/video-generation-tasks", { data: body });
                expect(created.ok(), await created.text()).toBe(true);
                const { task } = await created.json();
                const finished = await pollTask(page.request, `/api/video-tasks/${task.id}`);
                expect(finished.status).toBe("success");
                const state = await protocolFixtureState(request);
                expect(state.requests.filter((item) => item.method === "POST" && item.path === (h3 ? "/v2/video_generation" : "/v1/video_generation"))).toHaveLength(1);
                const records = JSON.parse(await readFile(path.join(e2eDataDir, "generation-tasks.json"), "utf8")) as Array<{
                    id: string;
                    payload: { usageObservations?: Array<{ upstreamTaskId: string; observation: { protocol: string; quantities?: Record<string, string>; fileId?: string } }> };
                }>;
                const receipts = records.find((item) => item.id === task.id)!.payload.usageObservations!;
                expect(receipts).toHaveLength(1);
                expect(receipts[0].upstreamTaskId).toBe(finished.upstreamId);
                if (h3) {
                    expect(state.requests.some((item) => item.path.startsWith("/v2/query/video_generation/"))).toBe(true);
                    expect(receipts[0].observation).toMatchObject({
                        protocol: "minimax-video-v2",
                        quantities: shadow
                            ? { totalSeconds: "5.25", inputSeconds: "0", outputSeconds: "5.25", inputImageCount: "0", inputAudioSeconds: "0" }
                            : { totalSeconds: "6.25", inputSeconds: "1.25", outputSeconds: "5", inputImageCount: "2", inputAudioSeconds: "3.5" },
                    });
                } else {
                    expect(state.requests.some((item) => item.path === "/v1/query/video_generation")).toBe(true);
                    expect(state.requests.some((item) => item.path === "/v1/files/retrieve")).toBe(true);
                    expect(state.requests.some((item) => item.path === "/v2/video_generation")).toBe(false);
                    expect(receipts[0].observation).toMatchObject({ protocol: "minimax-hailuo-v1", fileId: `${finished.upstreamId}-file`, status: "Success", width: 1920, height: 1080, missing: [], invalid: [] });
                    expect(receipts[0].observation).not.toHaveProperty("quantities");
                }
                expect(JSON.stringify(receipts)).not.toMatch(/fixture-h3-usage|fixture-key|hailuo.mp4|fixture.png/);
                expect(JSON.stringify(finished)).not.toMatch(/usageObservations|outputSeconds|inputImageCount|fileId/);
                const replay = await page.request.post("/api/video-generation-tasks", { data: body });
                expect((await replay.json()).task.id).toBe(task.id);
                expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path === (h3 ? "/v2/video_generation" : "/v1/video_generation"))).toHaveLength(1);
                const balance = (await (await page.request.get("/api/auth/session")).json()).user.pointsBalance;
                if (shadow) {
                    expect(balance).toBe(9.75);
                    const account = JSON.parse(await readFile(path.join(e2eDataDir, "model-pricing-shadow", `${createHash("sha256").update(userId!).digest("hex")}.json`), "utf8"));
                    expect(account.exactPoints).toBe(h3 ? "294" : "5523/10");
                    expect(account.receipts).toHaveLength(1);
                    expect(account.calls).toMatchObject([{ kind: "video", upstreamTaskId: finished.upstreamId, frozen: { policy: { id: salesId } }, result: { status: "priced" } }]);
                    if (!h3) expect(account.calls[0].frozen.bound).toMatchObject({ protocol: "minimax-hailuo-v1", tier: "1080P-6", maximumVideos: "1", mode: mode === "hailuo-fast-shadow" ? "image" : "text" });
                    expect(JSON.stringify(account)).not.toMatch(/fixture-h3-shadow|fixture-hailuo-shadow|fixture-key|hailuo.mp4|fixture.png/);
                    expect(JSON.stringify(finished)).not.toMatch(/frozen|receiptId|exactPoints/);
                } else expect(balance).toBe(0);
                await page.goto("/create", { waitUntil: "domcontentloaded" });
                const resultUrl = (finished.result as { serverUrl?: string; url?: string }).serverUrl || (finished.result as { url?: string }).url;
                expect(resultUrl).toBeTruthy();
                const metadata = await page.evaluate(async (url) => {
                    const video = document.createElement("video");
                    video.src = url!;
                    await new Promise<void>((resolve, reject) => {
                        video.onloadedmetadata = () => resolve();
                        video.onerror = () => reject(new Error("video unavailable"));
                    });
                    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
                }, resultUrl);
                expect(metadata.width).toBeGreaterThan(0);
                expect(metadata.height).toBeGreaterThan(0);
                expect(metadata.duration).toBeGreaterThan(0);
            } finally {
                if (userId) {
                    const deleted = await request.delete(`/api/admin/users/${userId}`);
                    expect(deleted.ok(), await deleted.text()).toBe(true);
                }
                const restored = await request.patch("/api/admin/settings", { data: { systemChannels: before.systemChannels, logicalModels: before.logicalModels, modelPointCosts: before.modelPointCosts } });
                expect(restored.ok(), await restored.text()).toBe(true);
            }
        },
    );

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

for (const { model, shadow } of [
    { model: "gpt-4o-audio-preview", shadow: false },
    { model: "gpt-audio-1.5", shadow: false },
    { model: "gpt-audio-1.5", shadow: true },
])
    test(shadow ? "OpenAI audio shadow freezes four prices while generation keeps fixed billing" : `OpenAI audio preview generates speech through Chat Completions ${model}`, async ({ page, request }) => {
        const before = (await (await request.get("/api/admin/settings")).json()).settings;
        const saved = await request.patch("/api/admin/settings", { data: { modelPointCosts: { ...before.modelPointCosts, [model]: 0.25 } } });
        expect(saved.ok(), await saved.text()).toBe(true);
        let userId: string | undefined;
        try {
            const username = `e2e_chat_audio_${randomUUID().slice(0, 8)}`;
            const createdUser = await request.post("/api/admin/users", { data: { username, password: E2E_ADMIN.password, role: "user", pointsBalance: 10 } });
            expect(createdUser.ok(), await createdUser.text()).toBe(true);
            userId = (await createdUser.json()).user.id;
            const login = await page.request.post("/api/auth/login", {
                data: { username, password: E2E_ADMIN.password },
                headers: { "user-agent": `vozeb-e2e-${username}` },
            });
            expect(login.ok(), await login.text()).toBe(true);
            const body = { config: { model, voice: "alloy", format: "wav" }, prompt: "Read this sentence aloud", source: "agent", context: { clientRequestId: `e2e-chat-audio:${randomUUID()}` } };
            let salesId: string | undefined;
            if (shadow) {
                const binding = before.logicalModels.find((item: { id: string }) => item.id === model).bindings.find((item: { enabled: boolean }) => item.enabled);
                const rateKeys = ["inputText", "inputAudio", "outputText", "outputAudio"];
                const candidate = await request.post("/api/admin/model-pricing", {
                    data: {
                        action: "candidate",
                        price: {
                            logicalModelId: model,
                            manufacturer: "OpenAI",
                            series: "Fixture",
                            officialVersion: `e2e-shadow-${randomUUID()}`,
                            sku: model,
                            tier: "paid",
                            conditions: "仅本地合成：全球标准四个普通音频价项",
                            sourceKind: "manual",
                            sourceUrl: "https://example.com/fixture-openai-audio",
                            evidence: "本地合成价格",
                            observedAt: new Date().toISOString(),
                            items: rateKeys.map((key, index) => ({ key, unit: "token", per: "1000000", price: String(index + 1), currency: "USD" })),
                        },
                    },
                });
                expect(candidate.ok(), await candidate.text()).toBe(true);
                const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: (await candidate.json()).data.id, approved: true, note: "本地音频影子验收" } });
                expect(reviewed.ok(), await reviewed.text()).toBe(true);
                const versionId = (await reviewed.json()).data.versionId;
                const contract = await request.post("/api/admin/model-pricing/audio-contracts", {
                    data: {
                        officialVersionId: versionId,
                        expectedCurrentId: null,
                        contract: {
                            channelId: binding.channelId,
                            requestedModel: model,
                            reportedModel: model,
                            declaredProtocol: "openai",
                            protocol: "openai-chat-audio",
                            scope: "global-standard-openai-chat-audio-uncached",
                            itemKeys: { inputTextTokens: "inputText", inputAudioTokens: "inputAudio", outputTextTokens: "outputText", outputAudioTokens: "outputAudio" },
                            evidence: "本地 Chat Audio 完整原响应",
                        },
                    },
                });
                expect(contract.ok(), await contract.text()).toBe(true);
                const overview = (await (await request.get("/api/admin/model-pricing")).json()).data;
                const exchange = await request.patch("/api/admin/model-pricing", {
                    data: { action: "exchange-rate", exchangeRate: { cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "本地音频汇率" }, expectedObservedAt: overview.exchangeRate?.observedAt || null },
                });
                expect(exchange.ok(), await exchange.text()).toBe(true);
                const previewResponse = await request.post("/api/admin/model-pricing", {
                    data: {
                        action: "preview",
                        modelId: model,
                        usage: { inputText: "8", inputAudio: "0", outputText: "2", outputAudio: "10" },
                        policy: { priceVersionIds: { [model]: versionId }, userPriceRules: [], conversion: { ...(await exchange.json()).data, pointsPerCny: "100" }, usdPerCurrency: {}, pointsPerCurrency: {}, rateEvidence: {} },
                    },
                });
                expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
                const preview = (await previewResponse.json()).data;
                expect(preview.quote.exactPoints).toBe("189/5000");
                const published = await request.patch("/api/admin/model-pricing", { data: { action: "publish", policy: preview.policy, currentSalesVersionId: preview.currentSalesVersionId, previewToken: preview.previewToken } });
                expect(published.ok(), await published.text()).toBe(true);
                salesId = (await published.json()).data.id;
            }
            const created = await page.request.post("/api/audio-tasks", { data: body });
            expect(created.ok(), await created.text()).toBe(true);
            const task = ((await created.json()) as { task: { id: string } }).task;
            const finished = await pollTask(page.request, `/api/audio-tasks/${task.id}`);
            expect(finished).toMatchObject({ status: "success", result: { mimeType: "audio/wav" }, billing: { pointsCost: 0.25, refunded: false } });
            expect(JSON.stringify(finished)).not.toMatch(/usageObservations|outputAudioTokens|inputTextTokens/);
            const replay = await page.request.post("/api/audio-tasks", { data: body });
            expect((await replay.json()).task.id).toBe(task.id);
            expect((await (await page.request.get("/api/auth/session")).json()).user.pointsBalance).toBe(9.75);
            if (!process.env.VOZEB_PRO_E2E_DATABASE_URL) {
                const records = JSON.parse(await readFile(path.join(e2eDataDir, "generation-tasks.json"), "utf8")) as Array<{
                    id: string;
                    payload: { usageObservations?: Array<{ pointsRecordId?: string; observation: { quantities: Record<string, string> } }> };
                }>;
                const receipts = records.find((item) => item.id === task.id)!.payload.usageObservations!;
                expect(receipts).toHaveLength(1);
                expect(receipts[0].pointsRecordId).toBeTruthy();
                expect(receipts[0].observation.quantities).toMatchObject({ inputTextTokens: "8", inputAudioTokens: "0", outputAudioTokens: "10", outputTextTokens: "2" });
                expect(JSON.stringify(receipts)).not.toMatch(/Read this sentence|fixture audio|transcript|base64/);
            }
            if (shadow) {
                const account = await (async () => {
                    if (!process.env.VOZEB_PRO_E2E_DATABASE_URL) return JSON.parse(await readFile(path.join(e2eDataDir, "model-pricing-shadow", `${createHash("sha256").update(userId!).digest("hex")}.json`), "utf8"));
                    const { Pool } = await import("pg");
                    const pool = new Pool({ connectionString: process.env.VOZEB_PRO_E2E_DATABASE_URL });
                    try {
                        const total = await pool.query("SELECT exact_points FROM vozeb_pro_model_pricing_shadow_accounts WHERE user_id = $1", [userId]);
                        const calls = await pool.query("SELECT data FROM vozeb_pro_model_pricing_shadow_calls WHERE user_id = $1", [userId]);
                        const receipts = await pool.query("SELECT data FROM vozeb_pro_model_pricing_shadow_receipts WHERE user_id = $1", [userId]);
                        return { exactPoints: total.rows[0]?.exact_points, calls: calls.rows.map((row) => row.data), receipts: receipts.rows.map((row) => row.data) };
                    } finally {
                        await pool.end();
                    }
                })();
                expect(account.exactPoints).toBe("189/5000");
                expect(account.receipts).toHaveLength(1);
                expect(account.receipts[0].snapshot.quote.lines).toHaveLength(4);
                expect(account.calls).toMatchObject([
                    {
                        kind: "audio",
                        protocol: "openai-chat-audio",
                        frozen: { policy: { id: salesId }, bound: { maximumQuantities: { inputTextTokens: "128000", inputAudioTokens: "0", outputTextTokens: "16384", outputAudioTokens: "16384" } } },
                        result: { status: "priced" },
                    },
                ]);
                expect(JSON.stringify(account)).not.toMatch(/Read this sentence|fixture-key|transcript|base64/);
                expect(JSON.stringify(finished)).not.toMatch(/frozen|receiptId|exactPoints/);
            }
            expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/chat/completions") && item.model === model)).toHaveLength(1);
            await page.goto("/profile", { waitUntil: "domcontentloaded" });
            expect(
                await page.evaluate(async (url: string) => {
                    const audio = new Audio();
                    const loaded = new Promise<void>((resolve, reject) => {
                        audio.onloadedmetadata = () => resolve();
                        audio.onerror = () => reject(new Error("audio decode failed"));
                    });
                    audio.src = url;
                    await loaded;
                    return audio.duration;
                }, finished.result.url),
            ).toBeGreaterThan(0);
        } finally {
            if (userId) expect((await request.delete(`/api/admin/users/${userId}`)).ok()).toBe(true);
            expect((await request.patch("/api/admin/settings", { data: { modelPointCosts: before.modelPointCosts } })).ok()).toBe(true);
        }
    });

for (const protocol of ["gemini", "dataeyes-gemini"] as const)
    for (const shadowModel of [undefined, "gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"])
        test(shadowModel ? `Gemini audio shadow ${protocol} ${shadowModel} preserves original prices and fixed billing` : `Gemini audio usage ${protocol} keeps fixed billing and private meters`, async ({ page, request }) => {
            const before = (await (await request.get("/api/admin/settings")).json()).settings;
            const model = shadowModel || "gemini-3.1-flash-tts-preview";
            const channel = applyChannelProtocol({ id: `e2e-audio-${protocol}`, name: "TTS usage fixture", baseUrl: E2E_PROTOCOL_ORIGIN, apiKey: "fixture-key", apiFormat: "gemini", models: [model], enabled: true }, protocol);
            const saved = await request.patch("/api/admin/settings", {
                data: {
                    systemChannels: [...before.systemChannels, channel],
                    logicalModels: [...before.logicalModels, { id: model, name: model, manufacturer: "Google", capability: "audio", enabled: true, bindings: [{ channelId: channel.id, upstreamModel: model, enabled: true, priority: 0 }] }],
                    modelPointCosts: { ...before.modelPointCosts, [model]: 0.25 },
                },
            });
            expect(saved.ok(), await saved.text()).toBe(true);
            let userId: string | undefined;
            try {
                const username = `e2e_audio_${randomUUID().slice(0, 8)}`;
                const createdUser = await request.post("/api/admin/users", { data: { username, password: E2E_ADMIN.password, role: "user", pointsBalance: 10 } });
                expect(createdUser.ok(), await createdUser.text()).toBe(true);
                userId = (await createdUser.json()).user.id;
                const login = await page.request.post("/api/auth/login", {
                    data: { username, password: E2E_ADMIN.password },
                    headers: { "user-agent": `vozeb-e2e-${username}` },
                });
                expect(login.ok(), await login.text()).toBe(true);
                const body = { config: { model, voice: "Kore", format: "wav" }, prompt: "private audio usage fixture", source: "agent", context: { clientRequestId: `e2e-tts:${randomUUID()}`, usageObservations: [{ pointsRecordId: "forged-charge" }] } };
                let salesId: string | undefined;
                if (shadowModel) {
                    const candidate = await request.post("/api/admin/model-pricing", {
                        data: {
                            action: "candidate",
                            price: {
                                logicalModelId: model,
                                manufacturer: "Google",
                                series: "TTS",
                                officialVersion: `e2e-shadow-${randomUUID()}`,
                                sku: model,
                                tier: "paid",
                                conditions: "仅本地夹具：全球标准音频单价",
                                sourceKind: "manual",
                                sourceUrl: "https://example.com/fixture-audio-shadow",
                                evidence: "本地合成价格",
                                observedAt: new Date().toISOString(),
                                items: [
                                    { key: "input", unit: "token", per: "1000000", price: "1", currency: "USD" },
                                    { key: "output", unit: "token", per: "1000000", price: "20", currency: "USD" },
                                ],
                            },
                        },
                    });
                    expect(candidate.ok(), await candidate.text()).toBe(true);
                    const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: (await candidate.json()).data.id, approved: true, note: "本地音频影子验收" } });
                    expect(reviewed.ok(), await reviewed.text()).toBe(true);
                    const versionId = (await reviewed.json()).data.versionId;
                    const contract = await request.post("/api/admin/model-pricing/audio-contracts", {
                        data: {
                            officialVersionId: versionId,
                            expectedCurrentId: null,
                            contract: {
                                channelId: channel.id,
                                requestedModel: model,
                                reportedModel: model,
                                declaredProtocol: protocol,
                                protocol: "gemini-tts",
                                scope: "global-standard-gemini-tts",
                                modelIdentity: "reviewed-request",
                                inputTextItem: "input",
                                outputAudioItem: "output",
                                evidence: "本地 TTS 原响应夹具",
                            },
                        },
                    });
                    expect(contract.ok(), await contract.text()).toBe(true);
                    const overview = (await (await request.get("/api/admin/model-pricing")).json()).data;
                    const exchange = await request.patch("/api/admin/model-pricing", {
                        data: { action: "exchange-rate", exchangeRate: { cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "本地音频汇率" }, expectedObservedAt: overview.exchangeRate?.observedAt || null },
                    });
                    expect(exchange.ok(), await exchange.text()).toBe(true);
                    const previewResponse = await request.post("/api/admin/model-pricing", {
                        data: {
                            action: "preview",
                            modelId: model,
                            usage: { input: "8", output: "12" },
                            policy: { priceVersionIds: { [model]: versionId }, userPriceRules: [], conversion: { ...(await exchange.json()).data, pointsPerCny: "100" }, usdPerCurrency: {}, pointsPerCurrency: {}, rateEvidence: {} },
                        },
                    });
                    expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
                    const preview = (await previewResponse.json()).data;
                    const published = await request.patch("/api/admin/model-pricing", { data: { action: "publish", policy: preview.policy, currentSalesVersionId: preview.currentSalesVersionId, previewToken: preview.previewToken } });
                    expect(published.ok(), await published.text()).toBe(true);
                    salesId = (await published.json()).data.id;
                }
                const created = await page.request.post("/api/audio-tasks", { data: body });
                expect(created.ok(), await created.text()).toBe(true);
                const task = (await created.json()).task;
                const finished = await pollTask(page.request, `/api/audio-tasks/${task.id}`);
                expect(finished).toMatchObject({ status: "success", result: { mimeType: "audio/wav" }, billing: { pointsCost: 0.25, refunded: false } });
                expect(JSON.stringify(finished)).not.toMatch(/usageObservations|outputAudioTokens|forged-charge/);
                const replay = await page.request.post("/api/audio-tasks", { data: body });
                expect((await replay.json()).task.id).toBe(task.id);
                expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith(`/${model}:generateContent`))).toHaveLength(1);
                expect((await (await page.request.get("/api/auth/session")).json()).user.pointsBalance).toBe(9.75);
                if (!process.env.VOZEB_PRO_E2E_DATABASE_URL) {
                    const records = JSON.parse(await readFile(path.join(e2eDataDir, "generation-tasks.json"), "utf8")) as Array<{
                        id: string;
                        payload: { usageObservations?: Array<{ pointsRecordId?: string; observation: { quantities: Record<string, string> } }> };
                    }>;
                    const receipts = records.find((item) => item.id === task.id)!.payload.usageObservations!;
                    expect(receipts).toHaveLength(1);
                    expect(receipts[0]).toMatchObject({ observation: { quantities: { inputTextTokens: "8", outputAudioTokens: "12" } } });
                    expect(receipts[0].pointsRecordId).toBeTruthy();
                    expect(JSON.stringify(receipts)).not.toMatch(/private audio|forged-charge|inlineData|base64/);
                }
                if (shadowModel && !process.env.VOZEB_PRO_E2E_DATABASE_URL) {
                    const account = JSON.parse(await readFile(path.join(e2eDataDir, "model-pricing-shadow", `${createHash("sha256").update(userId!).digest("hex")}.json`), "utf8"));
                    expect(account.exactPoints).toBe("217/1250");
                    expect(account.receipts).toHaveLength(1);
                    expect(account.calls).toMatchObject([
                        { kind: "audio", declaredProtocol: protocol, frozen: { policy: { id: salesId }, bound: { maximumQuantities: { inputTextTokens: "8192", outputAudioTokens: "16384" } } }, result: { status: "priced" } },
                    ]);
                    expect(JSON.stringify(account)).not.toMatch(/private audio usage fixture|fixture-key|inlineData|base64/);
                    expect(JSON.stringify(finished)).not.toMatch(/frozen|receiptId|exactPoints/);
                }
                await page.goto("/profile", { waitUntil: "domcontentloaded" });
                expect(
                    await page.evaluate(async (url) => {
                        const audio = new Audio();
                        const loaded = new Promise<void>((resolve, reject) => {
                            audio.onloadedmetadata = () => resolve();
                            audio.onerror = () => reject(new Error("audio decode failed"));
                        });
                        audio.src = url;
                        await loaded;
                        return audio.duration;
                    }, finished.result.url),
                ).toBeGreaterThan(0);
            } finally {
                if (userId) expect((await request.delete(`/api/admin/users/${userId}`)).ok()).toBe(true);
                const restored = await request.patch("/api/admin/settings", { data: { systemChannels: before.systemChannels, logicalModels: before.logicalModels, modelPointCosts: before.modelPointCosts } });
                expect(restored.ok(), await restored.text()).toBe(true);
            }
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

for (const perImage of [false, true])
    test(`${perImage ? "per-image" : "token"} image pricing contract review persists separate operations across themes and widths`, async ({ page, request }, testInfo) => {
        const before = await (await request.get("/api/admin/settings")).json();
        const logicalModel = perImage ? "e2e-count-pro" : "e2e-image";
        const sku = perImage ? "flux-kontext-pro" : `IMAGE-TOKEN-${randomUUID()}`;
        if (perImage) {
            const channel = applyChannelProtocol({ id: "e2e-count", name: "E2E 按张渠道", baseUrl: E2E_PROTOCOL_ORIGIN, apiKey: "fixture-key", apiFormat: "openai", models: [sku], enabled: true }, "dataeyes-flux");
            const saved = await request.patch("/api/admin/settings", {
                data: {
                    systemChannels: [...before.settings.systemChannels, channel],
                    logicalModels: [
                        ...before.settings.logicalModels,
                        { id: logicalModel, name: logicalModel, manufacturer: "Black Forest Labs", capability: "image", enabled: true, bindings: [{ channelId: channel.id, upstreamModel: sku, enabled: true, priority: 0 }] },
                    ],
                },
            });
            expect(saved.ok(), await saved.text()).toBe(true);
            const current = (await (await request.get("/api/admin/settings")).json()).settings;
            expect(current.logicalModels.find((model: { id: string }) => model.id === logicalModel)?.bindings).toMatchObject([{ channelId: channel.id, upstreamModel: sku }]);
        }
        try {
            const candidateResponse = await request.post("/api/admin/model-pricing", {
                data: {
                    action: "candidate",
                    price: {
                        logicalModelId: logicalModel,
                        manufacturer: perImage ? "Black Forest Labs" : "Google",
                        series: "Fixture",
                        officialVersion: "e2e-image-token",
                        sku,
                        tier: "paid",
                        conditions: perImage ? "本地夹具：全球标准 DataEyes FLUX 每张单档" : "本地夹具：全球标准直接 Images 全尺寸 Token 单档",
                        sourceKind: "manual",
                        sourceUrl: "https://example.com/fixture-pricing",
                        evidence: "合成测试数据，不是真实官方价格",
                        observedAt: new Date().toISOString(),
                        items: perImage
                            ? [{ key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" }]
                            : [
                                  { key: "textInput", unit: "token", per: "1000000", price: "5", currency: "USD" },
                                  { key: "imageInput", unit: "token", per: "1000000", price: "10", currency: "USD" },
                                  { key: "imageOutput", unit: "token", per: "1000000", price: "40", currency: "USD" },
                              ],
                    },
                },
            });
            expect(candidateResponse.ok(), await candidateResponse.text()).toBe(true);
            const candidate = (await candidateResponse.json()).data;
            const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: candidate.id, approved: true, note: "仅本地 fixture 验收" } });
            expect(reviewed.ok(), await reviewed.text()).toBe(true);
            const versionId = (await reviewed.json()).data.versionId;
            const open = async () => {
                await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
                await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
                await selectSalesModel(page, logicalModel, perImage ? "Black Forest Labs" : "未标厂商", "image");
                await page.getByLabel("已审核官方价版本").click();
                await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: sku }).click();
                await page.getByRole("button", { name: "核对图片用量契约" }).click();
                const drawer = page.getByRole("dialog", { name: "核对图片用量契约" });
                await drawer.getByLabel("图片契约渠道绑定").click();
                await page
                    .locator(".ant-select-dropdown:visible .ant-select-item-option")
                    .filter({ hasText: perImage ? "E2E 按张渠道 / flux-kontext-pro" : "E2E 主渠道 / e2e-image" })
                    .click();
                await expect(drawer.getByLabel("图片契约响应型号")).toBeVisible();
                return drawer;
            };
            let drawer = await open();
            await expect(drawer.getByRole("button", { name: "审核并保存图片契约" })).toBeDisabled();
            await drawer.getByLabel("图片契约型号依据").click();
            await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "已核对请求型号，可缺响应型号" }).click();
            await drawer.getByLabel("图片契约响应型号").fill(perImage ? sku : "e2e-image");
            if (perImage) {
                await expect(drawer.getByRole("checkbox")).toHaveCount(0);
                await drawer.getByLabel("图片按张上界来源").fill("https://example.com/one-image");
                await drawer.getByLabel("图片按张上界依据").fill("本地夹具单请求只返回一张，n 不改变数量");
            } else {
                for (const [key, meter] of [
                    ["textInput", "inputTextTokens"],
                    ["imageInput", "inputImageTokens"],
                    ["imageOutput", "outputImageTokens"],
                ])
                    await drawer.getByRole("checkbox", { name: `图片 ${key} 映射 ${meter}`, exact: true }).check();
                await drawer.getByRole("checkbox", { name: "图片必须为零 outputTextTokens", exact: true }).check();
                await drawer.getByLabel("图片预留档位 1 尺寸").fill("1024x1024");
                for (const meter of ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"]) await drawer.getByLabel(`图片预留档位 1 ${meter}`).fill(meter === "inputTextTokens" ? "285" : "0");
                await drawer.getByLabel("图片预留档位 1 来源").fill("https://example.com/e2e-image-estimate");
                await drawer.getByLabel("图片预留档位 1 依据").fill("本地 low / 1024x1024 合成样本的四个模态估算与真实结果差额已核对");
            }
            await drawer.getByLabel("图片契约核对依据").fill("本地合成创建样本：请求型号已核对，输出文本明确为零");
            await drawer.getByRole("button", { name: "审核并保存图片契约" }).click();
            await expect(drawer.getByText("当前", { exact: true })).toBeVisible();
            const historyUrl = `/api/admin/model-pricing/image-contracts?officialVersionId=${versionId}&channelId=${perImage ? "e2e-count" : "e2e-primary"}&requestedModel=${perImage ? sku : "e2e-image"}&operation=generations`;
            const history = (await (await request.get(historyUrl)).json()).data.contracts;
            expect(history).toMatchObject([
                {
                    current: true,
                    operation: "generations",
                    ...(perImage
                        ? { scope: "global-standard-dataeyes-flux-image", imageLimit: { maxImages: 1 } }
                        : { zeroMeters: ["outputTextTokens"], holdEstimates: [{ quality: "low", size: "1024x1024", meterQuantities: { inputTextTokens: "285", outputTextTokens: "0" } }] }),
                },
            ]);
            const stale = await request.post("/api/admin/model-pricing/image-contracts", { data: { officialVersionId: versionId, expectedCurrentId: null, contract: history[0] } });
            expect(stale.status()).toBe(409);
            await drawer.getByLabel("图片契约操作").click();
            await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "编辑（edits）" }).click();
            await expect(drawer.getByLabel("图片契约响应型号")).toHaveValue("");
            await expect(drawer.getByText("此操作尚无审核记录")).toBeVisible();
            await expect(drawer.getByRole("button", { name: "审核并保存图片契约" })).toBeDisabled();
            if (!perImage) {
                await drawer.getByLabel("图片契约响应型号").fill("e2e-image");
                for (const [key, meter] of [
                    ["textInput", "inputTextTokens"],
                    ["imageInput", "inputImageTokens"],
                    ["imageOutput", "outputImageTokens"],
                ])
                    await drawer.getByRole("checkbox", { name: `图片 ${key} 映射 ${meter}`, exact: true }).check();
                await drawer.getByRole("checkbox", { name: "图片必须为零 outputTextTokens", exact: true }).check();
                await drawer.getByLabel("图片预留档位 1 尺寸").fill("1024x1024");
                await drawer.getByLabel("图片预留档位 1 参考图尺寸").fill("1024x1024");
                for (const [meter, tokens] of Object.entries({ inputTextTokens: "31", inputImageTokens: "1024", outputTextTokens: "0", outputImageTokens: "515" })) await drawer.getByLabel(`图片预留档位 1 ${meter}`).fill(tokens);
                await drawer.getByLabel("图片预留档位 1 来源").fill("https://example.com/e2e-image-edit-estimate");
                await drawer.getByLabel("图片预留档位 1 依据").fill("单张 1024x1024 合成参考图的编辑用量和请求档位已核对");
                await drawer.getByLabel("图片契约核对依据").fill("直接 Images 编辑：参考图尺寸及四模态用量已核对");
                await drawer.getByRole("button", { name: "审核并保存图片契约" }).click();
                await expect(drawer.getByText(/参考图 1024x1024/)).toBeVisible();
                const editHistory = (await (await request.get(`${historyUrl.replace("operation=generations", "operation=edits")}`)).json()).data.contracts;
                expect(editHistory).toMatchObject([{ current: true, operation: "edits", holdEstimates: [{ referenceSize: "1024x1024", meterQuantities: { inputImageTokens: "1024" } }] }]);
            }
            for (const theme of ["light", "dark"] as const) {
                await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
                drawer = await open();
                await expect(drawer.getByLabel("图片契约核对依据")).toHaveValue("本地合成创建样本：请求型号已核对，输出文本明确为零");
                for (const width of [1440, 390, 430]) {
                    await page.setViewportSize({ width, height: 900 });
                    await expect
                        .poll(() =>
                            drawer.evaluate((element) => {
                                const bounds = element.getBoundingClientRect();
                                const body = element.querySelector(".ant-drawer-body")!;
                                const grids = [...element.querySelectorAll(".grid")];
                                const fields = [...grids[0].children].map((child) => child.getBoundingClientRect());
                                const aligned = window.innerWidth >= 640 ? Math.abs(fields[0].top - fields[1].top) < 1 && fields[1].left > fields[0].left : Math.abs(fields[0].left - fields[1].left) < 1 && fields[1].top > fields[0].top;
                                return (
                                    aligned &&
                                    bounds.width > 0 &&
                                    bounds.left >= 0 &&
                                    bounds.right <= window.innerWidth + 1 &&
                                    body.scrollWidth <= body.clientWidth + 1 &&
                                    grids.every((grid) => getComputedStyle(grid).display === "grid") &&
                                    [...element.querySelectorAll('[aria-label^="图片预留档位"]')].every((control) => {
                                        const rect = control.getBoundingClientRect();
                                        return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
                                    }) &&
                                    [...element.querySelectorAll(".ant-checkbox-wrapper, .ant-select, textarea, button")].every((control) => {
                                        const rect = control.getBoundingClientRect();
                                        return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
                                    })
                                );
                            }),
                        )
                        .toBe(true);
                    await drawer.getByRole("button", { name: "审核并保存图片契约" }).scrollIntoViewIfNeeded();
                    await page.screenshot({ path: testInfo.outputPath(`image-contract-${perImage ? "count" : "tokens"}-${theme}-${width}.png`) });
                }
                await drawer.locator(".ant-drawer-close").click();
            }
            expect((await (await request.get(historyUrl)).json()).data.contracts).toEqual(history);
            expect((await (await request.get(historyUrl.replace("operation=generations", "operation=edits"))).json()).data.contracts).toHaveLength(perImage ? 0 : 1);
            expect((await (await request.get("/api/admin/settings")).json()).settings.modelPointCosts).toEqual(before.settings.modelPointCosts);
        } finally {
            if (perImage) {
                const restored = await request.patch("/api/admin/settings", { data: { systemChannels: before.settings.systemChannels, logicalModels: before.settings.logicalModels } });
                expect(restored.ok(), await restored.text()).toBe(true);
            }
        }
    });

for (const perImage of [false, true])
    test(`${perImage ? "per-image" : "token"} image shadow pricing persists a frozen quote while real generation keeps fixed billing`, async ({ request }) => {
        const beforeSettings = (await (await request.get("/api/admin/settings")).json()).settings;
        const logicalModel = perImage ? "e2e-count-pro" : "e2e-image";
        const upstreamModel = perImage ? "flux-kontext-pro" : "e2e-image";
        if (perImage) {
            const channel = applyChannelProtocol({ id: "e2e-count", name: "E2E 按张渠道", baseUrl: E2E_PROTOCOL_ORIGIN, apiKey: "fixture-key", apiFormat: "openai", models: [upstreamModel], enabled: true }, "dataeyes-flux");
            const saved = await request.patch("/api/admin/settings", {
                data: {
                    systemChannels: [...beforeSettings.systemChannels, channel],
                    logicalModels: [
                        ...beforeSettings.logicalModels,
                        { id: logicalModel, name: logicalModel, manufacturer: "Black Forest Labs", capability: "image", enabled: true, bindings: [{ channelId: channel.id, upstreamModel, enabled: true, priority: 0 }] },
                    ],
                    modelPointCosts: { ...beforeSettings.modelPointCosts, [logicalModel]: 0 },
                },
            });
            expect(saved.ok(), await saved.text()).toBe(true);
            const current = (await (await request.get("/api/admin/settings")).json()).settings;
            expect(current.logicalModels.find((model: { id: string }) => model.id === logicalModel)?.bindings).toMatchObject([{ channelId: channel.id, upstreamModel }]);
        }
        try {
            const session = await (await request.get("/api/auth/session")).json();
            const dataFile = path.join(e2eDataDir, "model-pricing-shadow", `${createHash("sha256").update(session.user.id).digest("hex")}.json`);
            type ShadowAccount = {
                exactPoints: string;
                calls: Array<{ requestId: string; modelId: string; frozen?: { policy: { id: string } }; result?: { status: string; receiptId?: string } }>;
                receipts: Array<{ id: string; requestId: string; kind: string; changeExactPoints: string }>;
            };
            const readShadow = async (): Promise<ShadowAccount> => {
                try {
                    return JSON.parse(await readFile(dataFile, "utf8"));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exactPoints: "0", calls: [], receipts: [] };
                    throw error;
                }
            };
            const before = await readShadow();
            const candidateResponse = await request.post("/api/admin/model-pricing", {
                data: {
                    action: "candidate",
                    price: {
                        logicalModelId: logicalModel,
                        manufacturer: perImage ? "Black Forest Labs" : "Google",
                        series: "Fixture",
                        officialVersion: "e2e-image-shadow",
                        sku: perImage ? upstreamModel : randomUUID(),
                        tier: "paid",
                        conditions: perImage ? "仅本地夹具：DataEyes FLUX 全球按张单档" : "仅本地夹具：直接 Images Token 全球单档",
                        sourceKind: "manual",
                        sourceUrl: "https://example.com/fixture-shadow",
                        evidence: "合成价格，本地验收",
                        observedAt: new Date().toISOString(),
                        items: perImage ? [{ key: "images", unit: "image", per: "1", price: "0.04", currency: "USD" }] : [{ key: "tokens", unit: "token", per: "1000000", price: "1", currency: "USD" }],
                    },
                },
            });
            expect(candidateResponse.ok(), await candidateResponse.text()).toBe(true);
            const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: (await candidateResponse.json()).data.id, approved: true, note: "本地影子账单夹具" } });
            expect(reviewed.ok(), await reviewed.text()).toBe(true);
            const versionId = (await reviewed.json()).data.versionId;
            const contractResponse = await request.post("/api/admin/model-pricing/image-contracts", {
                data: {
                    officialVersionId: versionId,
                    expectedCurrentId: null,
                    contract: {
                        channelId: perImage ? "e2e-count" : "e2e-primary",
                        requestedModel: upstreamModel,
                        reportedModel: upstreamModel,
                        protocol: "openai-images",
                        operation: "generations",
                        modelIdentity: "reviewed-request",
                        scope: perImage ? "global-standard-dataeyes-flux-image" : "global-standard-direct-image-tokens",
                        region: "global",
                        itemMeters: perImage ? {} : { tokens: ["inputTextTokens", "inputImageTokens", "outputTextTokens", "outputImageTokens"] },
                        zeroMeters: [],
                        ...(perImage ? { imageLimit: { maxImages: 1, sourceUrl: "https://example.com/one-image", evidence: "local fixture single image" } } : {}),
                        ...(!perImage
                            ? {
                                  holdEstimates: [
                                      {
                                          quality: "low",
                                          size: "64x64",
                                          meterQuantities: { inputTextTokens: "7", inputImageTokens: "0", outputTextTokens: "0", outputImageTokens: "0" },
                                          sourceUrl: "https://example.com/image-estimate",
                                          evidence: "本地合成图片用量样本的四个模态估算",
                                      },
                                  ],
                              }
                            : {}),
                        evidence: "本地夹具的全部模态 Token 已核对",
                    },
                },
            });
            expect(contractResponse.ok(), await contractResponse.text()).toBe(true);
            const overview = (await (await request.get("/api/admin/model-pricing")).json()).data;
            const exchangeResponse = await request.patch("/api/admin/model-pricing", {
                data: { action: "exchange-rate", exchangeRate: { cnyPerUsd: "7", observedAt: new Date().toISOString(), evidence: "本地影子测试业务汇率" }, expectedObservedAt: overview.exchangeRate?.observedAt || null },
            });
            expect(exchangeResponse.ok(), await exchangeResponse.text()).toBe(true);
            const exchangeRate = (await exchangeResponse.json()).data;
            const previewResponse = await request.post("/api/admin/model-pricing", {
                data: {
                    action: "preview",
                    modelId: logicalModel,
                    usage: perImage ? { images: "1" } : { tokens: "7" },
                    policy: { priceVersionIds: { [logicalModel]: versionId }, userPriceRules: [], conversion: { ...exchangeRate, pointsPerCny: "100" }, usdPerCurrency: {}, pointsPerCurrency: {}, rateEvidence: {} },
                },
            });
            expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
            const preview = (await previewResponse.json()).data;
            const publishedResponse = await request.patch("/api/admin/model-pricing", { data: { action: "publish", policy: preview.policy, currentSalesVersionId: preview.currentSalesVersionId, previewToken: preview.previewToken } });
            expect(publishedResponse.ok(), await publishedResponse.text()).toBe(true);
            const published = (await publishedResponse.json()).data;
            const clientRequestId = `image-shadow:${randomUUID()}`;
            const body = { kind: "generation", config: { model: logicalModel, quality: "low", size: "64x64" }, prompt: "private shadow image request", source: "image-workbench", context: { clientRequestId } };
            const created = await request.post("/api/image-tasks", { data: body, headers: { "X-VOZEB-PRO-Client-Request-Id": clientRequestId } });
            expect(created.ok(), await created.text()).toBe(true);
            const task = (await created.json()).task;
            const completed = await pollTask(request, `/api/image-tasks/${task.id}`);
            expect(completed).toMatchObject({ status: "success", result: { width: 64, height: 64 } });
            expect(JSON.stringify(completed)).not.toContain("frozen");
            const after = await readShadow();
            const calls = after.calls.filter((call) => !before.calls.some((prior) => prior.requestId === call.requestId));
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({ modelId: logicalModel, frozen: { policy: { id: published.id } }, result: { status: "priced", receiptId: expect.any(String) } });
            expect(after.receipts.find((receipt) => receipt.id === calls[0].result?.receiptId)?.changeExactPoints).toBe(preview.quote.exactPoints);
            expect(JSON.stringify(calls)).not.toContain("private shadow image request");
            const replay = await request.post("/api/image-tasks", { data: body, headers: { "X-VOZEB-PRO-Client-Request-Id": clientRequestId } });
            expect((await replay.json()).task.id).toBe(task.id);
            expect(await readShadow()).toEqual(after);
            const state = await protocolFixtureState(request);
            expect(state.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(1);
            expect((await (await request.get("/api/auth/session")).json()).user.pointsBalance).toBe(session.user.pointsBalance);
            const failedRequestId = `image-shadow-failure:${randomUUID()}`;
            const failedBody = { ...body, prompt: "fixture-invalid-image-after-usage", context: { clientRequestId: failedRequestId } };
            const failedResponse = await request.post("/api/image-tasks", { data: failedBody, headers: { "X-VOZEB-PRO-Client-Request-Id": failedRequestId } });
            expect(failedResponse.ok(), await failedResponse.text()).toBe(true);
            const failedTask = (await failedResponse.json()).task;
            expect(await pollTask(request, `/api/image-tasks/${failedTask.id}`)).toMatchObject({ status: "error" });
            const refunded = await readShadow();
            const failedCalls = refunded.calls.filter((call) => !after.calls.some((prior) => prior.requestId === call.requestId));
            expect(failedCalls).toHaveLength(1);
            expect(failedCalls[0].result?.status).toBe("priced");
            const receipts = refunded.receipts.filter((receipt) => receipt.requestId === failedCalls[0].requestId);
            expect(receipts).toHaveLength(2);
            expect(receipts.find((receipt) => receipt.kind === "reversal")?.changeExactPoints).toBe(`-${preview.quote.exactPoints}`);
            expect(refunded.exactPoints).toBe(after.exactPoints);
            const failedReplay = await request.post("/api/image-tasks", { data: failedBody, headers: { "X-VOZEB-PRO-Client-Request-Id": failedRequestId } });
            expect((await failedReplay.json()).task.id).toBe(failedTask.id);
            expect(await readShadow()).toEqual(refunded);
            expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/generations"))).toHaveLength(2);
            expect((await (await request.get("/api/auth/session")).json()).user.pointsBalance).toBe(session.user.pointsBalance);
        } finally {
            if (perImage) {
                const restored = await request.patch("/api/admin/settings", { data: { systemChannels: beforeSettings.systemChannels, logicalModels: beforeSettings.logicalModels, modelPointCosts: beforeSettings.modelPointCosts } });
                expect(restored.ok(), await restored.text()).toBe(true);
            }
        }
    });

for (const { sku, protocol } of [...["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"].flatMap((sku) => (["gemini", "dataeyes-gemini"] as const).map((protocol) => ({ sku, protocol }))), { sku: "gpt-audio-1.5", protocol: "openai" as const }])
    test(`${sku} ${protocol} audio pricing contract review preserves normal charges and history`, async ({ page, request }, testInfo) => {
        const openai = protocol === "openai";
        const fields = openai ? ["inputTextTokens", "inputAudioTokens", "outputTextTokens", "outputAudioTokens"] : ["inputTextItem", "outputAudioItem"];
        const rateKeys = openai ? ["inputText", "inputAudio", "outputText", "outputAudio"] : ["text", "audio"];
        const before = (await (await request.get("/api/admin/settings")).json()).settings;
        const channelId = `e2e-audio-contract-${randomUUID()}`;
        let modelId = `e2e-audio-contract-model-${randomUUID()}`;
        let selectionVendor = openai ? "OpenAI" : "Google";
        const channel = applyChannelProtocol({ id: channelId, name: "E2E 音频计费渠道", baseUrl: E2E_PROTOCOL_ORIGIN, apiKey: "fixture-key", apiFormat: openai ? "openai" : "gemini", models: [sku], enabled: true }, protocol);
        const patched = await request.patch("/api/admin/settings", {
            data: {
                systemChannels: [...before.systemChannels, channel],
                logicalModels: [...before.logicalModels, { id: modelId, name: "E2E 音频计费模型", manufacturer: openai ? "OpenAI" : "Google", capability: "audio", enabled: true, bindings: [{ channelId, upstreamModel: sku, enabled: true, priority: 0 }] }],
            },
        });
        expect(patched.ok(), await patched.text()).toBe(true);
        try {
            if (openai) {
                const configured = (await patched.json()).settings.logicalModels.find((model: { id: string; manufacturer?: string; bindings: Array<{ channelId: string; upstreamModel: string }> }) =>
                    model.bindings.some((binding) => binding.channelId === channelId && binding.upstreamModel === sku),
                );
                expect(configured).toBeTruthy();
                modelId = configured.id;
                selectionVendor = configured.manufacturer || "未标厂商";
            }
            const officialVersion = `${sku}-fixture-${randomUUID()}`;
            const candidate = await request.post("/api/admin/model-pricing", {
                data: {
                    action: "candidate",
                    price: {
                        logicalModelId: modelId,
                        manufacturer: openai ? "OpenAI" : "Google",
                        series: "Fixture",
                        officialVersion,
                        sku,
                        tier: "paid",
                        conditions: "本地合成：全球标准文本输入与音频输出常规单价",
                        sourceKind: "manual",
                        sourceUrl: "https://example.com/audio-fixture",
                        evidence: "仅测试，不是真实官方价格",
                        observedAt: new Date().toISOString(),
                        items: rateKeys.map((key, index) => ({ key, unit: "token", per: "1000000", price: String(index + 1), currency: "USD" })),
                    },
                },
            });
            expect(candidate.ok(), await candidate.text()).toBe(true);
            const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: (await candidate.json()).data.id, approved: true, note: "local fixture" } });
            expect(reviewed.ok(), await reviewed.text()).toBe(true);
            const versionId = (await reviewed.json()).data.versionId;
            const historyUrl = `/api/admin/model-pricing/audio-contracts?${new URLSearchParams({ officialVersionId: versionId, channelId, requestedModel: sku })}`;
            const selectOption = async (label: string, text: string) => {
                const control = page.getByLabel(label);
                await control.click();
                const listId = await control.getAttribute("aria-controls");
                expect(listId).toBeTruthy();
                const popup = page.locator(".ant-select-dropdown").filter({ has: page.locator(`[id="${listId}"]`) });
                await popup.locator(".ant-select-item-option").filter({ hasText: text }).click();
                await expect(popup).not.toBeVisible();
            };
            const open = async () => {
                await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
                await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
                await selectSalesModel(page, modelId, selectionVendor, "audio");
                await selectOption("已审核官方价版本", sku);
                await page.getByRole("button", { name: "核对音频用量契约" }).click();
                const drawer = page.getByRole("dialog", { name: "核对音频用量契约" });
                await selectOption("音频契约渠道绑定", "E2E 音频计费渠道");
                await expect(drawer.getByLabel("音频契约核对依据")).toBeVisible();
                return drawer;
            };
            let drawer = await open();
            await expect(drawer.getByRole("button", { name: "审核并保存音频契约" })).toBeDisabled();
            for (const [index, field] of fields.entries()) await selectOption(`音频 ${field} 价项`, `${rateKeys[index]} ·`);
            if (!openai) await selectOption("音频型号核对方式", "已核实渠道请求型号");
            else {
                await expect(drawer.getByLabel("音频型号核对方式")).toHaveCount(0);
                await expect(drawer.getByLabel("音频响应型号")).toBeDisabled();
            }
            await drawer.getByLabel("音频契约核对依据").fill("第一版：全量常规单价，纯文本输入与音频输出，已核实标准档位和请求型号");
            await drawer.getByRole("button", { name: "审核并保存音频契约" }).click();
            await expect(drawer.getByTestId("audio-contract-history").getByText("当前", { exact: true })).toBeVisible();
            const first = (await (await request.get(historyUrl)).json()).data.contracts[0];
            expect(first).toMatchObject({
                current: true,
                requestedModel: sku,
                declaredProtocol: protocol,
                ...(openai ? { protocol: "openai-chat-audio", itemKeys: Object.fromEntries(fields.map((field, index) => [field, rateKeys[index]])) } : { inputTextItem: "text", outputAudioItem: "audio", modelIdentity: "reviewed-request" }),
            });
            await expect(drawer.getByRole("button", { name: "审核并保存音频契约" })).toBeEnabled();
            await drawer.getByLabel("音频契约核对依据").fill("第二版：核对证据更新，官方免费仍按常规单价收费");
            await drawer.getByRole("button", { name: "审核并保存音频契约" }).click();
            await expect(drawer.getByTestId("audio-contract-history").getByText("历史", { exact: true })).toBeVisible();
            const history = (await (await request.get(historyUrl)).json()).data.contracts;
            expect(history).toHaveLength(2);
            expect(history[1]).toEqual({ ...first, current: false });
            const stale = await request.post("/api/admin/model-pricing/audio-contracts", { data: { officialVersionId: versionId, expectedCurrentId: first.id, contract: first } });
            expect(stale.status()).toBe(409);
            for (const theme of ["light", "dark"] as const) {
                await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
                drawer = await open();
                await expect(drawer.getByLabel("音频契约核对依据")).toHaveValue("第二版：核对证据更新，官方免费仍按常规单价收费");
                await expect(drawer.getByLabel("音频响应型号")).toHaveValue(sku);
                for (const width of [1440, 390, 430]) {
                    await page.setViewportSize({ width, height: 900 });
                    await expect
                        .poll(() =>
                            drawer.evaluate((element) => {
                                const bounds = element.getBoundingClientRect();
                                const body = element.querySelector(".ant-drawer-body")!;
                                const grid = element.querySelector('[data-testid="audio-contract-grid"]')!;
                                const fields = [...grid.children].map((child) => child.getBoundingClientRect());
                                const aligned = fields.every(
                                    (field, index) =>
                                        index === 0 ||
                                        (window.innerWidth >= 640 && index % 2 === 1
                                            ? Math.abs(field.top - fields[index - 1].top) < 1 && field.left > fields[index - 1].left
                                            : field.top > fields[index - 1].top && Math.abs(field.left - fields[0].left) < 1),
                                );
                                const footer = element.querySelector(".ant-drawer-footer")!.getBoundingClientRect();
                                return (
                                    aligned &&
                                    getComputedStyle(grid).display === "grid" &&
                                    bounds.left >= 0 &&
                                    bounds.right <= window.innerWidth + 1 &&
                                    body.scrollWidth <= body.clientWidth + 1 &&
                                    footer.bottom <= window.innerHeight + 1 &&
                                    [...element.querySelectorAll(".ant-select, input, textarea, button")].every((control) => {
                                        const rect = control.getBoundingClientRect();
                                        return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
                                    })
                                );
                            }),
                        )
                        .toBe(true);
                    await selectOption(`音频 ${fields.at(-1)} 价项`, `${rateKeys.at(-1)} ·`);
                    await page.screenshot({ path: testInfo.outputPath(`audio-contract-${sku}-${protocol}-${theme}-${width}.png`) });
                }
                await drawer.locator(".ant-drawer-close").click();
            }
            expect((await (await request.get(historyUrl)).json()).data.contracts).toEqual(history);
            expect((await (await request.get("/api/admin/settings")).json()).settings.modelPointCosts).toEqual(before.modelPointCosts);
            expect((await (await request.get("/api/admin/settings")).json()).settings.systemChannels).toEqual([...before.systemChannels, expect.objectContaining({ id: channelId, enabled: true })]);
        } finally {
            const restored = await request.patch("/api/admin/settings", { data: { systemChannels: before.systemChannels, logicalModels: before.logicalModels } });
            expect(restored.ok(), await restored.text()).toBe(true);
        }
    });

for (const sku of ["MiniMax-H3", "MiniMax-H3-Max", "MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast"])
    test(`${sku} video pricing contract review preserves normal charges and history`, async ({ page, request }, testInfo) => {
        const hailuo = sku.startsWith("MiniMax-Hailuo");
        const tiers = ["768P-6", "768P-10", "1080P-6"];
        const before = (await (await request.get("/api/admin/settings")).json()).settings;
        const channelId = `e2e-video-contract-${randomUUID()}`;
        const channel = applyChannelProtocol({ id: channelId, name: "E2E 视频计费渠道", baseUrl: E2E_PROTOCOL_ORIGIN, apiKey: "fixture-key", apiFormat: "openai", models: [sku], enabled: true }, "minimax");
        const patched = await request.patch("/api/admin/settings", { data: { systemChannels: [...before.systemChannels, channel] } });
        expect(patched.ok(), await patched.text()).toBe(true);
        try {
            const settings = (await (await request.get("/api/admin/settings")).json()).settings;
            const logical = settings.logicalModels.find((model: { bindings: Array<{ channelId: string; upstreamModel: string }> }) => model.bindings.some((binding) => binding.channelId === channelId && binding.upstreamModel === sku));
            expect(logical?.capability).toBe("video");
            const resolutions = sku === "MiniMax-H3" ? ["768P", "2K"] : ["480P", "768P"];
            const items = hailuo
                ? tiers.map((key) => ({ key, unit: "video", per: "1", price: "0.123", currency: "USD" }))
                : [
                      ...resolutions.flatMap((resolution) => ["inputSeconds", "outputSeconds"].map((meter) => ({ key: `${resolution}-${meter}`, unit: "second", per: "1", price: "0.0553", currency: "USD" }))),
                      { key: "images", unit: "image", per: "1", price: "0.074", currency: "USD" },
                      { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
                  ];
            const officialVersion = `${sku}-fixture-${randomUUID()}`;
            const candidate = await request.post("/api/admin/model-pricing", {
                data: {
                    action: "candidate",
                    price: {
                        logicalModelId: logical.id,
                        manufacturer: "MiniMax",
                        series: "Fixture",
                        officialVersion,
                        sku,
                        tier: "paid",
                        conditions: hailuo ? "本地合成：Hailuo 三档整段视频常规单价" : "本地合成：标准视频输入输出与图片常规单价",
                        sourceKind: "manual",
                        sourceUrl: "https://example.com/video-fixture",
                        evidence: "仅测试，不是真实官方价格",
                        observedAt: new Date().toISOString(),
                        items,
                    },
                },
            });
            expect(candidate.ok(), await candidate.text()).toBe(true);
            const reviewed = await request.patch("/api/admin/model-pricing", { data: { action: "review", candidateId: (await candidate.json()).data.id, approved: true, note: "local fixture" } });
            expect(reviewed.ok(), await reviewed.text()).toBe(true);
            const versionId = (await reviewed.json()).data.versionId;
            const historyUrl = `/api/admin/model-pricing/video-contracts?${new URLSearchParams({ officialVersionId: versionId, channelId, requestedModel: sku })}`;
            const selectOption = async (label: string, text: string) => {
                const control = page.getByLabel(label);
                await control.click();
                const listId = await control.getAttribute("aria-controls");
                expect(listId).toBeTruthy();
                const popup = page.locator(".ant-select-dropdown").filter({ has: page.locator(`[id="${listId}"]`) });
                await popup.locator(".ant-select-item-option").filter({ hasText: text }).click();
            };
            const open = async () => {
                await page.goto("/admin?section=pricing", { waitUntil: "domcontentloaded" });
                await expect(page.locator(".admin-dashboard-shell")).toHaveAttribute("data-hydrated", "true");
                await selectSalesModel(page, logical.id, logical.manufacturer || "未标厂商", "video");
                await selectOption("已审核官方价版本", sku);
                await page.getByRole("button", { name: "核对视频用量契约" }).click();
                const drawer = page.getByRole("dialog", { name: "核对视频用量契约" });
                await selectOption("视频契约渠道绑定", "E2E 视频计费渠道");
                await expect(drawer.getByLabel("视频契约核对依据")).toBeVisible();
                return drawer;
            };
            let drawer = await open();
            await expect(drawer.getByRole("button", { name: "审核并保存视频契约" })).toBeDisabled();
            if (hailuo) {
                await expect(drawer.getByLabel("视频输入图片价项")).toHaveCount(0);
                for (const tier of tiers) await selectOption(`视频 ${tier} 整段价项`, tier);
            } else {
                for (const resolution of resolutions)
                    for (const meter of ["inputSeconds", "outputSeconds"]) {
                        await selectOption(`视频 ${resolution} ${meter} 价项`, `${resolution}-${meter}`);
                    }
                await selectOption("视频输入图片价项", "images ·");
                await selectOption("视频输入音频零价项", "inputAudioSeconds ·");
            }
            await drawer.getByLabel("视频契约核对依据").fill(hailuo ? "第一版：三个整段常规价；原任务成功文件核对" : "第一版：全部图片按正常单价；长期免费输入音频零积分");
            await drawer.getByRole("button", { name: "审核并保存视频契约" }).click();
            await expect(drawer.getByTestId("video-contract-history").getByText("当前", { exact: true })).toBeVisible();
            const first = (await (await request.get(historyUrl)).json()).data.contracts[0];
            expect(first).toMatchObject({
                current: true,
                requestedModel: sku,
                ...(hailuo
                    ? { protocol: "minimax-hailuo-v1", tierItems: Object.fromEntries(tiers.map((tier) => [tier, tier])) }
                    : { protocol: "minimax-video-v2", inputImagePricing: "all-at-standard-rate", inputAudioItem: "inputAudioSeconds", inputImageItem: "images" }),
            });
            await expect(drawer.getByRole("button", { name: "审核并保存视频契约" })).toBeEnabled();
            await drawer.getByLabel("视频契约核对依据").fill("第二版：渠道证据更新，原收费规则保留");
            await drawer.getByRole("button", { name: "审核并保存视频契约" }).click();
            await expect(drawer.getByTestId("video-contract-history").getByText("历史", { exact: true })).toBeVisible();
            const history = (await (await request.get(historyUrl)).json()).data.contracts;
            expect(history).toHaveLength(2);
            expect(history[1]).toEqual({ ...first, current: false });
            const stale = await request.post("/api/admin/model-pricing/video-contracts", { data: { officialVersionId: versionId, expectedCurrentId: first.id, contract: first } });
            expect(stale.status()).toBe(409);
            for (const theme of ["light", "dark"] as const) {
                await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
                drawer = await open();
                await expect(drawer.getByLabel("视频契约核对依据")).toHaveValue("第二版：渠道证据更新，原收费规则保留");
                for (const width of [1440, 390, 430]) {
                    await page.setViewportSize({ width, height: 900 });
                    await expect
                        .poll(() =>
                            drawer.evaluate((element) => {
                                const bounds = element.getBoundingClientRect();
                                const body = element.querySelector(".ant-drawer-body")!;
                                const grid = element.querySelector('[data-testid="video-contract-grid"]')!;
                                const fields = [...grid.children].map((child) => child.getBoundingClientRect());
                                const aligned = window.innerWidth >= 640 ? Math.abs(fields[0].top - fields[1].top) < 1 && fields[1].left > fields[0].left : fields[1].top > fields[0].top && Math.abs(fields[0].left - fields[1].left) < 1;
                                const footer = element.querySelector(".ant-drawer-footer")!.getBoundingClientRect();
                                return (
                                    aligned &&
                                    getComputedStyle(grid).display === "grid" &&
                                    bounds.left >= 0 &&
                                    bounds.right <= window.innerWidth + 1 &&
                                    body.scrollWidth <= body.clientWidth + 1 &&
                                    footer.bottom <= window.innerHeight + 1 &&
                                    [...element.querySelectorAll(".ant-select, textarea, button")].every((control) => {
                                        const rect = control.getBoundingClientRect();
                                        return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
                                    })
                                );
                            }),
                        )
                        .toBe(true);
                    await selectOption(hailuo ? "视频 768P-6 整段价项" : "视频输入图片价项", hailuo ? "768P-6 ·" : "images ·");
                    await page.screenshot({ path: testInfo.outputPath(`video-contract-${sku}-${theme}-${width}.png`) });
                }
                await drawer.locator(".ant-drawer-close").click();
            }
            expect((await (await request.get(historyUrl)).json()).data.contracts).toEqual(history);
            expect((await (await request.get("/api/admin/settings")).json()).settings.modelPointCosts).toEqual(before.modelPointCosts);
        } finally {
            const restored = await request.patch("/api/admin/settings", { data: { systemChannels: before.systemChannels, logicalModels: before.logicalModels } });
            expect(restored.ok(), await restored.text()).toBe(true);
        }
    });
