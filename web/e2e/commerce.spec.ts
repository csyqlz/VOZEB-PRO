import { expect, test, type Page } from "@playwright/test";

import { expectDialogWithinViewport, expectNoHorizontalOverflow } from "./responsive-helpers";

const PAGE_SIZE = 8;
const TIMESTAMP = "2026-08-11T00:00:00.000Z";

test("pricing wallet shows holds, frozen calculations, filtered pages and recoverable read failures", async ({ page, request }, testInfo) => {
    // The real API must remain usable before adding UI-only accounting fixtures.
    const live = await request.get("/api/points/pricing?pageSize=1");
    expect(live.ok(), await live.text()).toBe(true);
    expect((await live.json()).code).toBe(0);
    let failRead = false;
    let debtPoints = "0";
    const queries: string[] = [];
    const records = Array.from({ length: 9 }, (_, index) => ({
        id: `pricing-${index}`,
        modelId: `pricing-model-${index}`,
        status: index === 0 ? "reserved" : index === 8 ? "released" : "settled",
        stage: index === 0 ? "outcome_unknown" : index === 8 ? "released" : "settled",
        createdAt: TIMESTAMP,
        heldPoints: "5.03",
        chargedPoints: index > 0 && index < 8 ? "0.01" : undefined,
        unpaidAtSettlement: undefined as string | undefined,
        restoredPoints: index > 0 ? "5.02" : undefined,
        expiredPoints: "0",
        refundedPoints: "0",
        expiredRefundPoints: "0",
        calculation:
            index > 0 && index < 8
                ? {
                      manufacturer: "Fixture",
                      officialModel: "fixture-text",
                      officialVersionId: "official-v1",
                      salesVersionId: "sales-v1",
                      sourceUrl: "https://example.com/pricing",
                      conditions: "global standard",
                      cnyPerUsd: "7",
                      pointsPerCny: "100",
                      coefficient: "1",
                      calculatedPoints: "0.004",
                      lines: [{ key: "input", quantity: "0.004", unit: "token", per: "1", price: "0.01", currency: "CNY", officialAmount: "0.00004" }],
                      currencies: [],
                  }
                : undefined,
    }));
    await page.route(/\/api\/points\/pricing(?:\?.*)?$/, (route) => {
        const query = new URL(route.request().url()).searchParams;
        queries.push(query.toString());
        if (failRead) return route.fulfill({ status: 503, json: { code: 503, data: null, msg: "计费记录暂时无法读取" } });
        const selected = records.filter((item) => !query.get("status") || item.status === query.get("status"));
        const pageNumber = Number(query.get("page") || 1);
        const pageSize = Number(query.get("pageSize") || PAGE_SIZE);
        return route.fulfill({
            json: {
                code: 0,
                msg: "ok",
                data: {
                    page: pageNumber,
                    pageSize,
                    total: selected.length,
                    items: selected.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
                    summary: { availablePoints: debtPoints === "0" ? "94.97" : "0", dailyPoints: "0", permanentPoints: debtPoints === "0" ? "94.97" : `-${debtPoints}`, debtPoints, pendingCount: 1, pendingPoints: "5.03", inactiveDailyPoints: "2.50" },
                },
            },
        });
    });
    await page.goto("/profile?section=points", { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("pricing-wallet");
    await expect(panel.getByTestId("pricing-available")).toHaveText("94.97");
    await expect(panel.getByTestId("pricing-held")).toHaveText("5.03");
    await expect(panel.getByText("待核对", { exact: true })).toBeVisible();
    await expect(panel).toContainText("2.5 日赠积分所属额度已失效");
    await panel.locator(".ant-pagination-next button").click();
    await expect(panel).toContainText("pricing-model-8");
    await expect(panel.locator("[data-pricing-status]")).toHaveCount(1);
    await panel.getByRole("combobox", { name: "计费状态" }).click();
    await page
        .locator(".ant-select-item-option-content")
        .filter({ hasText: /^已结算$/ })
        .click();
    await expect(panel.locator("[data-pricing-status='settled']")).toHaveCount(7);
    expect(queries.some((query) => query.includes("page=1") && query.includes("status=settled"))).toBe(true);
    await panel.locator("summary").first().click();
    await expect(panel.locator("details[open]")).toContainText("本次计算积分约 0.004；实际扣除 0.01");
    await expect(panel.locator("details[open]")).toContainText("1 USD = 7 CNY");
    await expect(panel.locator("details[open]").getByRole("link", { name: "查看官方价格来源" })).toHaveAttribute("href", "https://example.com/pricing");
    const layout = await panel.getByRole("combobox", { name: "计费状态" }).evaluate((element) => {
        const select = element.closest(".ant-select")!;
        const box = select.getBoundingClientRect();
        return { display: getComputedStyle(select).display, width: box.width, left: box.left, right: box.right, viewport: innerWidth };
    });
    expect(layout.display).not.toBe("none");
    expect(layout.width).toBeGreaterThan(100);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
    await expectNoHorizontalOverflow(page, "pricing wallet light");
    await page.screenshot({ path: testInfo.outputPath("pricing-wallet-light.png") });
    failRead = true;
    await page.getByRole("button", { name: "刷新计费记录" }).click();
    await expect(panel.getByRole("alert")).toHaveText("计费记录暂时无法读取");
    await expect(panel.getByTestId("pricing-available")).toHaveCount(0);
    failRead = false;
    records[0].stage = "submitted";
    await page.getByRole("button", { name: /^(刷新|刷新记录)$/ }).click();
    await panel.getByRole("combobox", { name: "计费状态" }).click();
    await page
        .locator(".ant-select-item-option-content")
        .filter({ hasText: /^全部状态$/ })
        .click();
    await expect(panel.getByText("生成中", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("pricing-held")).toHaveText("5.03");
    await page.addInitScript(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(panel.getByText("生成中", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("pricing-held")).toHaveText("5.03");
    await page.getByTitle("积分余额", { exact: true }).click();
    const popover = page.locator(".user-points-panel");
    await expect(popover).toContainText("待结算预留 5.03 积分");
    await expect(popover.getByRole("link", { name: "查看计费记录" })).toHaveAttribute("href", "/profile?section=points");
    await expectNoHorizontalOverflow(page, "pricing wallet dark");
    await page.screenshot({ path: testInfo.outputPath("pricing-wallet-dark.png") });
    await page.getByTitle("积分余额", { exact: true }).click();
    await expect(popover).toBeHidden();
    debtPoints = "12.34";
    records[1].unpaidAtSettlement = "12.34";
    await page.getByRole("button", { name: /^(刷新|刷新记录)$/ }).click();
    await expect(panel.getByRole("alert")).toContainText("待补扣 12.34 积分");
    await expect(panel).toContainText("结算时待补扣 12.34");
    await expectNoHorizontalOverflow(page, "pricing wallet debt");
});

test("pricing task review keeps original attempts, proof and pending recovery explicit", async ({ page, request }, testInfo) => {
    const live = await request.get("/api/admin/generation-operations?pageSize=1");
    expect(live.ok(), await live.text()).toBe(true);
    const base = (await live.json()).data;
    const missing = await request.get("/api/admin/generation-operations/text/fixture-missing/billing-review");
    expect(missing.status()).toBe(400);
    const task = {
        id: "priced-task-fixture",
        userId: "fixture-user",
        accountId: "0001",
        username: "fixture",
        displayName: "账务测试用户",
        type: "text",
        status: "running",
        model: "priced-text",
        prompt: "公开需求",
        durationMs: 1000,
        pointsCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        canCancel: false,
        canReview: true,
        leaseExpired: false,
        executionPhase: "needs_review",
        billingMode: "official-usage",
        attemptNo: 3,
    };
    await page.route(/\/api\/admin\/generation-operations\?(.*)$/, (route) => route.fulfill({ json: { code: 0, data: { ...base, items: [task], total: 1, page: 1 }, msg: "ok" } }));
    let reviewed = false;
    let canStopPreparation = false;
    let canCorrectUsage = false;
    let pending = true;
    const submitted: Array<Record<string, unknown>> = [];
    await page.route("**/api/admin/generation-operations/text/priced-task-fixture/billing-review", (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            submitted.push(body);
            reviewed = body.action !== "resume_billing";
            return route.fulfill({ json: { code: 0, data: { executionPhase: pending ? "needs_review" : "completed" }, msg: "ok" } });
        }
        return route.fulfill({
            json: {
                code: 0,
                data: {
                    attemptNo: 3,
                    model: "priced-text",
                    pending: true,
                    stage: "outcome_unknown",
                    canStopPreparation,
                    canCorrectUsage,
                    canReviewSubmission: true,
                    canResumeBilling: true,
                    invalidUsage: canCorrectUsage ? "缓存读取用量超过输入总量" : undefined,
                    heldPoints: "12.34",
                    reviewed,
                    hasSavedResponse: canCorrectUsage,
                    officialVersionId: "official-original",
                    salesVersionId: "sales-original",
                },
                msg: "ok",
            },
        });
    });
    await page.goto("/admin/generation-operations", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "核对按量账务" });
    await expect(dialog).toContainText("第 3 次尝试 · 预留 12.34 积分");
    await expect(dialog.getByRole("button", { name: "录入文本结果" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认未计费", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "确认未计费并退回" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商工单 fixture-123 明确确认原请求未计费");
    await expectDialogWithinViewport(dialog);
    await page.screenshot({ path: testInfo.outputPath("pricing-review-light.png") });
    await dialog.getByRole("button", { name: "确认未计费并退回" }).click();
    await expect(dialog).toContainText("已保存人工核对依据");
    await expect(dialog.getByRole("button", { name: "确认未计费", exact: true })).toBeDisabled();
    expect(submitted[0]).toEqual({ action: "confirm_no_charge", attemptNo: 3, evidence: "供应商工单 fixture-123 明确确认原请求未计费" });
    pending = false;
    await dialog.getByRole("button", { name: "确认并恢复" }).click();
    await expect(dialog).toBeHidden();
    expect(submitted[1]).toEqual({ action: "resume_billing", attemptNo: 3 });
    reviewed = false;
    canStopPreparation = true;
    await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
    await dialog.getByRole("button", { name: "撤销未提交准备" }).click();
    await dialog.getByRole("textbox", { name: "核对依据" }).fill("排障记录 fixture-789：撤销中断的准备");
    await expectDialogWithinViewport(dialog);
    await expectNoHorizontalOverflow(page, "preparation stop light");
    await page.screenshot({ path: testInfo.outputPath("pricing-preparation-stop-light.png") });
    await dialog.getByRole("button", { name: "取 消" }).click();
    await expect(dialog).toBeHidden();
    expect(submitted).toHaveLength(2);
    canStopPreparation = false;
    await page.evaluate(() => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
    await dialog.getByRole("button", { name: "补录完整响应" }).click();
    await dialog.getByRole("textbox", { name: "供应商完整响应 JSON" }).fill('{"fixture":"complete response"}');
    await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商回执 fixture-456");
    await expectDialogWithinViewport(dialog);
    await expectNoHorizontalOverflow(page, "priced task review dark");
    await page.screenshot({ path: testInfo.outputPath("pricing-review-dark.png") });
    await dialog.getByRole("button", { name: "确认并恢复" }).click();
    await expect(dialog).toBeHidden();
    expect(submitted[2]).toEqual({ action: "provide_metered_result", attemptNo: 3, evidence: "供应商回执 fixture-456", response: '{"fixture":"complete response"}' });
    reviewed = false;
    canStopPreparation = true;
    await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
    await dialog.getByRole("button", { name: "撤销未提交准备" }).click();
    await expect(dialog.getByRole("button", { name: "确认未计费", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "撤销准备并退回" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "核对依据" }).fill("排障记录 fixture-789：撤销中断的准备");
    await expectDialogWithinViewport(dialog);
    await expectNoHorizontalOverflow(page, "preparation stop dark");
    await page.screenshot({ path: testInfo.outputPath("pricing-preparation-stop-dark.png") });
    await dialog.getByRole("button", { name: "撤销准备并退回" }).click();
    await expect(dialog).toBeHidden();
    expect(submitted[3]).toEqual({ action: "stop_preparation", attemptNo: 3, evidence: "排障记录 fixture-789：撤销中断的准备" });
    canStopPreparation = false;
    canCorrectUsage = true;
    for (const theme of ["light", "dark"]) {
        reviewed = false;
        await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
        await page.reload({ waitUntil: "domcontentloaded" });
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await expect(dialog).toContainText("原用量矛盾：缓存读取用量超过输入总量");
        await expect(dialog).toContainText("已有响应凭据");
        await dialog.getByRole("button", { name: "更正矛盾用量" }).click();
        await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeDisabled();
        await dialog.getByRole("textbox", { name: "供应商完整响应 JSON" }).fill('{"fixture":"corrected response"}');
        await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeDisabled();
        await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商更正凭据 fixture-correction");
        const grid = await dialog.getByRole("button", { name: "更正矛盾用量" }).evaluate((button) => {
            const parent = button.parentElement!;
            return {
                display: getComputedStyle(parent).display,
                rects: Array.from(parent.children).map((child) => {
                    const r = child.getBoundingClientRect();
                    return { left: r.left, top: r.top, width: r.width, right: r.right };
                }),
                right: parent.getBoundingClientRect().right,
            };
        });
        expect(grid.display).toBe("grid");
        expect(grid.rects).toHaveLength(4);
        expect(grid.rects[0].top).toBe(grid.rects[1].top);
        expect(grid.rects[2].top).toBeGreaterThan(grid.rects[0].top);
        expect(grid.rects.every((r) => r.width > 0 && r.right <= grid.right + 1)).toBe(true);
        await expectDialogWithinViewport(dialog);
        await expectNoHorizontalOverflow(page, `pricing correction ${theme}`);
        await page.screenshot({ path: testInfo.outputPath(`pricing-correction-${theme}.png`) });
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toBeHidden();
        expect(submitted.at(-1)).toEqual({ action: "correct_metered_result", attemptNo: 3, evidence: "供应商更正凭据 fixture-correction", response: '{"fixture":"corrected response"}' });
    }
});

test("Kimi K3 pricing review fills only the missing cache TTL without replacing the saved response", async ({ page, request }, testInfo) => {
    const live = await request.get("/api/admin/generation-operations?pageSize=1");
    expect(live.ok(), await live.text()).toBe(true);
    const base = (await live.json()).data;
    const task = {
        id: "k3-review-fixture",
        userId: "fixture-user",
        accountId: "0001",
        username: "fixture",
        displayName: "账务测试用户",
        type: "text",
        status: "running",
        model: "kimi-k3",
        prompt: "公开需求",
        durationMs: 1000,
        pointsCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        canCancel: false,
        canReview: true,
        leaseExpired: false,
        executionPhase: "needs_review",
        billingMode: "official-usage",
        attemptNo: 1,
    };
    await page.route(/\/api\/admin\/generation-operations\?(.*)$/, (route) => route.fulfill({ json: { code: 0, data: { ...base, items: [task], total: 1, page: 1 }, msg: "ok" } }));
    const submitted: Record<string, unknown>[] = [];
    await page.route("**/api/admin/generation-operations/text/k3-review-fixture/billing-review", (route) => {
        if (route.request().method() === "POST") {
            submitted.push(route.request().postDataJSON() as Record<string, unknown>);
            return route.fulfill({ json: { code: 0, data: { executionPhase: "completed" }, msg: "ok" } });
        }
        return route.fulfill({
            json: {
                code: 0,
                data: {
                    attemptNo: 1,
                    model: "kimi-k3",
                    pending: true,
                    stage: "response_received",
                    heldPoints: "3",
                    reviewed: false,
                    hasSavedResponse: true,
                    usesCacheWriteTtl: true,
                    canSupplyCacheWriteTtl: true,
                    knownCacheWrite5mTokens: "60",
                    canStopPreparation: false,
                    canReviewSubmission: true,
                    canCorrectUsage: false,
                    canResumeBilling: true,
                    officialVersionId: "k3-original",
                    salesVersionId: "sales-original",
                },
                msg: "ok",
            },
        });
    });
    await page.goto("/admin/generation-operations", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "核对按量账务" });
    await dialog.getByRole("button", { name: "补齐分档" }).click();
    await expect(dialog.getByRole("textbox", { name: "供应商完整响应 JSON" })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "5 分钟缓存写入 Token" })).toHaveValue("60");
    await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "1 小时缓存写入 Token" }).fill("40");
    await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商账单中的原请求缓存写入分档凭据");
    await expectDialogWithinViewport(dialog);
    await expectNoHorizontalOverflow(page, "K3 cache TTL pricing review");
    await page.screenshot({ path: testInfo.outputPath("k3-cache-ttl-pricing-review.png") });
    await dialog.getByRole("button", { name: "确认并恢复" }).click();
    await expect(dialog).toBeHidden();
    expect(submitted).toEqual([{ action: "provide_metered_result", attemptNo: 1, evidence: "供应商账单中的原请求缓存写入分档凭据", response: "", cacheWrite5mTokens: "60", cacheWrite1hTokens: "40" }]);
});

function couponTemplate(page: number, index: number) {
    return {
        id: `template-${page}-${index}`,
        code: `TEMPLATE-${page}-${index}`,
        name: `可领取活动 ${page}-${index}`,
        description: "浏览器分页回归",
        discountType: "fixed",
        discountValue: 500,
        minimumAmountCents: 0,
        maximumDiscountCents: 500,
        stackWithPromotion: true,
        claimable: true,
        enabled: true,
        startsAt: TIMESTAMP,
        endsAt: "2027-08-11T00:00:00.000Z",
        totalLimit: 100,
        perUserLimit: 1,
        issuedCount: 0,
        redeemedCount: 0,
        productIds: [],
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
    };
}

function claimedCoupon(page: number, index: number) {
    const template = couponTemplate(page, index);
    template.name = `已领取券页 ${page}-${index}`;
    return {
        id: `coupon-${page}-${index}`,
        templateId: template.id,
        userId: "e2e-user",
        status: "available",
        grantSource: "claim",
        claimedAt: TIMESTAMP,
        expiresAt: "2027-08-11T00:00:00.000Z",
        template,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
    };
}

async function mockCouponPages(page: Page) {
    const requests: Array<{ page: number; templatePage: number; includeTemplates: boolean }> = [];
    await page.route(/\/api\/billing\/coupons(?:\?.*)?$/, async (route) => {
        const query = new URL(route.request().url()).searchParams;
        const couponsPage = Number(query.get("page") || "1");
        const templatePage = Number(query.get("templatePage") || "1");
        const includeTemplates = query.get("includeTemplates") === "true";
        requests.push({ page: couponsPage, templatePage, includeTemplates });
        const templatePayload = includeTemplates
            ? {
                  templates: [couponTemplate(templatePage, 1)],
                  templatesTotal: PAGE_SIZE * 2,
                  templatePage,
                  templatePageSize: PAGE_SIZE,
              }
            : {};
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                code: 0,
                data: {
                    coupons: [claimedCoupon(couponsPage, 1)],
                    total: PAGE_SIZE * 2,
                    page: couponsPage,
                    pageSize: PAGE_SIZE,
                    ...templatePayload,
                },
                msg: "OK",
            }),
        });
    });
    return requests;
}

function referralCenter(referralsPage: number, rewardsPage: number) {
    return {
        program: {
            enabled: true,
            inviterPoints: 100,
            inviteeRewardType: "points",
            inviteePoints: 50,
            minimumPaidCents: 100,
            coolingOffDays: 7,
        },
        code: "E2E-REFERRAL",
        link: "http://127.0.0.1/register?ref=E2E-REFERRAL",
        stats: { clicks: 20, registrations: 16, qualified: 8, pending: 2, settled: 6, revoked: 0 },
        referrals: [{ id: `referral-${referralsPage}`, inviteeName: `受邀用户页 ${referralsPage}`, riskStatus: "clear", registeredAt: TIMESTAMP }],
        referralsTotal: PAGE_SIZE * 2,
        referralsPage,
        referralsPageSize: PAGE_SIZE,
        rewards: [
            {
                id: `reward-${rewardsPage}`,
                relationshipId: `relationship-${rewardsPage}`,
                beneficiaryUserId: "e2e-user",
                beneficiaryRole: "inviter",
                rewardType: "points",
                pointsAmount: rewardsPage * 100,
                triggerOrderId: `order-${rewardsPage}`,
                status: "settled",
                settleAfter: TIMESTAMP,
                reason: `奖励页 ${rewardsPage}`,
                createdAt: TIMESTAMP,
            },
        ],
        rewardsTotal: PAGE_SIZE * 2,
        rewardsPage,
        rewardsPageSize: PAGE_SIZE,
    };
}

async function mockReferralPages(page: Page) {
    const requests: Array<{ referralsPage: number; rewardsPage: number }> = [];
    await page.route(/\/api\/referrals(?:\?.*)?$/, async (route) => {
        const query = new URL(route.request().url()).searchParams;
        const referralsPage = Number(query.get("referralsPage") || "1");
        const rewardsPage = Number(query.get("rewardsPage") || "1");
        requests.push({ referralsPage, rewardsPage });
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ code: 0, data: referralCenter(referralsPage, rewardsPage), msg: "OK" }),
        });
    });
    return requests;
}

function billingOrder(status: "pending" | "paid") {
    return {
        id: "e2e-sse-order",
        orderNo: "VZ-E2E-SSE-001",
        userId: "e2e-user",
        productKind: "points",
        status,
        subject: "E2E 支付结果",
        listAmountCents: 1000,
        promotionDiscountCents: 0,
        couponDiscountCents: 0,
        amountCents: 1000,
        currency: "CNY",
        pointsAmount: 100,
        dailyPoints: 0,
        periodDays: 0,
        quantity: 1,
        provider: "e2e",
        createdAt: TIMESTAMP,
        updatedAt: status === "paid" ? "2026-08-11T00:00:01.000Z" : TIMESTAMP,
    };
}

test("coupon wallet paginates claimable templates and owned coupons independently", async ({ page }) => {
    const requests = await mockCouponPages(page);
    await page.goto("/profile?section=coupons", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("可领取活动 1-1", { exact: true })).toBeVisible();
    await expect(page.getByText("已领取券页 1-1", { exact: true })).toBeVisible();
    const paginations = page.locator(".ant-pagination");
    await expect(paginations).toHaveCount(2);

    await paginations.nth(0).locator(".ant-pagination-next button").click();
    await expect(page.getByText("可领取活动 2-1", { exact: true })).toBeVisible();
    await expect(page.getByText("已领取券页 1-1", { exact: true })).toBeVisible();
    expect(requests).toContainEqual({ page: 1, templatePage: 2, includeTemplates: true });

    await paginations.nth(1).locator(".ant-pagination-next button").click();
    await expect(page.getByText("已领取券页 2-1", { exact: true })).toBeVisible();
    await expect(page.getByText("可领取活动 2-1", { exact: true })).toBeVisible();
    expect(requests.some((request) => request.page === 2 && !request.includeTemplates)).toBe(true);
    await expectNoHorizontalOverflow(page, "coupon wallet pagination");
});

test("referral progress and rewards retain separate server pages", async ({ page }) => {
    const requests = await mockReferralPages(page);
    await page.goto("/profile?section=referrals", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("受邀用户页 1", { exact: true })).toBeVisible();
    await expect(page.getByText(/奖励页 1/)).toBeVisible();
    const paginations = page.locator(".ant-pagination");
    await expect(paginations).toHaveCount(2);

    await paginations.nth(0).locator(".ant-pagination-next button").click();
    await expect(page.getByText("受邀用户页 2", { exact: true })).toBeVisible();
    await expect(page.getByText(/奖励页 1/)).toBeVisible();
    expect(requests).toContainEqual({ referralsPage: 2, rewardsPage: 1 });

    await paginations.nth(1).locator(".ant-pagination-next button").click();
    await expect(page.getByText(/奖励页 2/)).toBeVisible();
    await expect(page.getByText("受邀用户页 2", { exact: true })).toBeVisible();
    expect(requests).toContainEqual({ referralsPage: 2, rewardsPage: 2 });
    await expectNoHorizontalOverflow(page, "referral pagination");
});

test("billing result applies the paid SSE event and closes the subscription", async ({ page }) => {
    await page.addInitScript(() => {
        const trackedWindow = window as typeof window & { __billingSseStats?: { created: number; closed: number; active: number } };
        const NativeEventSource = window.EventSource;
        trackedWindow.__billingSseStats = { created: 0, closed: 0, active: 0 };
        class TrackedEventSource extends NativeEventSource {
            constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
                super(url, eventSourceInitDict);
                trackedWindow.__billingSseStats!.created += 1;
                trackedWindow.__billingSseStats!.active += 1;
            }

            override close() {
                const tracked = this as EventSource & { __billingTrackedClosed?: boolean };
                if (!tracked.__billingTrackedClosed) {
                    tracked.__billingTrackedClosed = true;
                    trackedWindow.__billingSseStats!.closed += 1;
                    trackedWindow.__billingSseStats!.active -= 1;
                }
                super.close();
            }
        }
        Object.defineProperty(window, "EventSource", { configurable: true, writable: true, value: TrackedEventSource });
    });

    let eventRequests = 0;
    await page.route(/\/api\/billing\/orders\/e2e-sse-order\/events$/, async (route) => {
        eventRequests += 1;
        const serialize = (status: "pending" | "paid") => `data: ${JSON.stringify({ code: 0, data: { order: billingOrder(status) }, msg: "" })}\n\n`;
        await route.fulfill({
            status: 200,
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
            },
            body: `${serialize("pending")}${serialize("paid")}`,
        });
    });

    await page.goto("/billing/success?orderId=e2e-sse-order", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "支付成功" })).toBeVisible();
    await expect(page.getByText("VZ-E2E-SSE-001", { exact: true })).toBeVisible();
    await expect(page.getByText("已支付", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新检查" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __billingSseStats?: { created: number; closed: number; active: number } }).__billingSseStats)).toEqual({ created: 1, closed: 1, active: 0 });
    expect(eventRequests).toBe(1);
    await expectNoHorizontalOverflow(page, "billing paid result");
});

test("image pricing task review withdraws preparation and preserves a recoverable decision", async ({ page, request }, testInfo) => {
    const live = await request.get("/api/admin/generation-operations?pageSize=1");
    expect(live.ok(), await live.text()).toBe(true);
    const base = (await live.json()).data;
    expect((await request.get("/api/admin/generation-operations/image/fixture-missing/billing-review")).status()).toBe(400);
    const task = {
        id: "priced-image-review-fixture",
        userId: "fixture-user",
        accountId: "0001",
        username: "fixture",
        displayName: "图片账务测试",
        type: "image",
        status: "running",
        model: "priced-image",
        prompt: "公开图片需求",
        durationMs: 1000,
        pointsCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        canCancel: false,
        canReview: true,
        leaseExpired: false,
        executionPhase: "needs_review",
        billingMode: "official-usage",
        attemptNo: 2,
    };
    await page.route(/\/api\/admin\/generation-operations\?(.*)$/, (route) => route.fulfill({ json: { code: 0, data: { ...base, items: [task], total: 1, page: 1 }, msg: "ok" } }));
    let reviewed = false;
    let claimed = false;
    let invalid = false;
    const submitted: Array<Record<string, unknown>> = [];
    await page.route("**/api/admin/generation-operations/image/priced-image-review-fixture/billing-review", (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            submitted.push(body);
            reviewed = true;
            return route.fulfill({ json: { code: 0, data: { executionPhase: body.action === "resume_billing" ? "completed" : "needs_review" }, msg: "ok" } });
        }
        return route.fulfill({
            json: {
                code: 0,
                data: {
                    attemptNo: 2,
                    model: "priced-image",
                    pending: true,
                    stage: invalid ? "response_received" : claimed ? "outcome_unknown" : "reserved",
                    heldPoints: "28",
                    reviewed,
                    hasSavedResponse: invalid,
                    invalidUsage: invalid ? "原图片成功结果与错误状态矛盾" : undefined,
                    canStopPreparation: !reviewed && !claimed,
                    canReviewSubmission: claimed,
                    canCorrectUsage: invalid && !reviewed,
                    canResumeBilling: reviewed || invalid,
                    officialVersionId: "image-original",
                    salesVersionId: "sales-original",
                },
                msg: "ok",
            },
        });
    });
    for (const theme of ["light", "dark"]) {
        reviewed = false;
        await page.goto("/admin/generation-operations", { waitUntil: "domcontentloaded" });
        await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
        await page.reload({ waitUntil: "domcontentloaded" });
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        const dialog = page.getByRole("dialog", { name: "核对按量账务" });
        await expect(dialog).toContainText("第 2 次尝试 · 预留 28 积分");
        await expect(dialog.getByRole("button", { name: "补录完整响应" })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "确认未计费", exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "恢复已有凭据" })).toBeDisabled();
        await dialog.getByRole("button", { name: "撤销未提交准备" }).click();
        await expect(dialog.getByRole("button", { name: "撤销准备并退回" })).toBeDisabled();
        await dialog.getByRole("textbox", { name: "核对依据" }).fill("图片准备中断 fixture-withdrawal，撤销原尝试");
        await expectDialogWithinViewport(dialog);
        await expectNoHorizontalOverflow(page, `image preparation ${theme}`);
        await page.screenshot({ path: testInfo.outputPath(`image-preparation-${theme}.png`) });
        await dialog.getByRole("button", { name: "撤销准备并退回" }).click();
        await expect(dialog).toContainText("已保存人工核对依据");
        await expect(dialog.getByRole("button", { name: "撤销未提交准备" })).toHaveCount(0);
        await dialog.getByRole("button", { name: "取 消" }).click();
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await expect(dialog).toContainText("已保存人工核对依据");
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toBeHidden();
    }
    expect(submitted).toEqual(
        Array.from({ length: 2 }, () => [
            { action: "stop_preparation", attemptNo: 2, evidence: "图片准备中断 fixture-withdrawal，撤销原尝试" },
            { action: "resume_billing", attemptNo: 2 },
        ]).flat(),
    );
    reviewed = false;
    claimed = true;
    await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "核对按量账务" });
    await expect(dialog).toContainText("图片补录须包含供应商原请求的完整结果 URL");
    await expect(dialog.getByRole("button", { name: "撤销未提交准备" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeDisabled();
    await dialog.getByRole("button", { name: "取 消" }).click();
    for (const theme of ["light", "dark"]) {
        reviewed = false;
        await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
        await page.reload({ waitUntil: "domcontentloaded" });
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await dialog.getByRole("button", { name: "补录完整响应" }).click();
        await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeDisabled();
        await dialog.getByRole("textbox", { name: "供应商完整响应 JSON" }).fill('{"data":[{"url":"https://example.com/fixture-original-image.png"}]}');
        await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商图片回执 fixture-image-result");
        await expectDialogWithinViewport(dialog);
        await expectNoHorizontalOverflow(page, `image metering ${theme}`);
        await page.screenshot({ path: testInfo.outputPath(`image-metering-${theme}.png`) });
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toContainText("已保存人工核对依据");
        await expect(dialog.getByRole("button", { name: "补录完整响应" })).toBeDisabled();
        await dialog.getByRole("button", { name: "取 消" }).click();
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toBeHidden();
        expect(submitted.at(-2)).toEqual({ action: "provide_metered_result", attemptNo: 2, evidence: "供应商图片回执 fixture-image-result", response: '{"data":[{"url":"https://example.com/fixture-original-image.png"}]}' });
        reviewed = false;
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await dialog.getByRole("button", { name: "确认未计费", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "确认未计费并退回" })).toBeDisabled();
        await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商账单 fixture-image-no-charge 确认原图片未计费");
        await expectDialogWithinViewport(dialog);
        await dialog.getByRole("button", { name: "确认未计费并退回" }).click();
        await expect(dialog).toContainText("已保存人工核对依据");
        await expect(dialog.getByRole("button", { name: "确认未计费", exact: true })).toBeDisabled();
        expect(submitted.at(-1)).toEqual({ action: "confirm_no_charge", attemptNo: 2, evidence: "供应商账单 fixture-image-no-charge 确认原图片未计费" });
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toBeHidden();
    }
    invalid = true;
    for (const theme of ["light", "dark"]) {
        reviewed = false;
        await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
        await page.reload({ waitUntil: "domcontentloaded" });
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await expect(dialog).toContainText("原用量矛盾");
        await expect(dialog.getByRole("button", { name: "恢复已有凭据" })).toBeEnabled();
        await dialog.getByRole("button", { name: "更正矛盾用量" }).click();
        await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeDisabled();
        const response = '{"data":[{"url":"https://example.com/fixture-original-image.png"}]}';
        await dialog.getByRole("textbox", { name: "供应商完整响应 JSON" }).fill(response);
        await dialog.getByRole("textbox", { name: "核对依据" }).fill("供应商工单 fixture-image-correction 确认原张数及结果");
        await expectDialogWithinViewport(dialog);
        await expectNoHorizontalOverflow(page, `image correction ${theme}`);
        await page.screenshot({ path: testInfo.outputPath(`image-correction-${theme}.png`) });
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toContainText("已保存人工核对依据");
        await expect(dialog.getByRole("button", { name: "更正矛盾用量" })).toHaveCount(0);
        expect(submitted.at(-1)).toEqual({ action: "correct_metered_result", attemptNo: 2, evidence: "供应商工单 fixture-image-correction 确认原张数及结果", response });
        await dialog.getByRole("button", { name: "取 消" }).click();
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
        await expect(dialog).toContainText("已保存人工核对依据");
        await dialog.getByRole("button", { name: "确认并恢复" }).click();
        await expect(dialog).toBeHidden();
    }
});

test("video pricing task review preserves original identity, supplements and corrections", async ({ page, request }, testInfo) => {
    const base = (await (await request.get("/api/admin/generation-operations?pageSize=1")).json()).data;
    expect((await request.get("/api/admin/generation-operations/video/fixture-missing/billing-review")).status()).toBe(400);
    const task = {
        id: "priced-video-review-fixture",
        userId: "fixture-user",
        accountId: "0001",
        username: "fixture",
        displayName: "视频账务测试",
        type: "video",
        status: "running",
        model: "priced-video",
        prompt: "公开视频需求",
        durationMs: 1000,
        pointsCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        canCancel: false,
        canReview: true,
        leaseExpired: false,
        executionPhase: "needs_review",
        billingMode: "official-usage",
        attemptNo: 4,
    };
    await page.route(/\/api\/admin\/generation-operations\?(.*)$/, (route) => route.fulfill({ json: { code: 0, data: { ...base, items: [task], total: 1, page: 1 }, msg: "ok" } }));
    let scenario = "preparation";
    let reviewed = false;
    const submitted: Array<Record<string, unknown>> = [];
    await page.route("**/api/admin/generation-operations/video/priced-video-review-fixture/billing-review", (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            submitted.push(body);
            reviewed = true;
            return route.fulfill({ json: { code: 0, data: { executionPhase: body.action === "resume_billing" ? "completed" : "needs_review" }, msg: "ok" } });
        }
        return route.fulfill({
            json: {
                code: 0,
                data: {
                    attemptNo: 4,
                    model: "priced-video",
                    pending: true,
                    stage: scenario === "preparation" ? "preparing" : "outcome_unknown",
                    heldPoints: "3.00",
                    reviewed,
                    hasSavedResponse: scenario === "correction",
                    invalidUsage: scenario === "correction" ? "输出秒数不是有效的非负数值" : undefined,
                    canStopPreparation: scenario === "preparation" && !reviewed,
                    canReviewSubmission: scenario !== "preparation",
                    canProvideResult: scenario !== "unknown",
                    canCorrectUsage: scenario === "correction" && !reviewed,
                    canResumeBilling: reviewed,
                    officialVersionId: "video-original",
                    salesVersionId: "sales-original",
                },
                msg: "ok",
            },
        });
    });
    const response = JSON.stringify({
        task: {
            id: "original-video",
            model: "MiniMax-H3",
            status: "succeeded",
            resolution: "768P",
            task_type: "generation",
            modality: "video",
            content: { url: "https://example.com/original-video.mp4" },
            usage: { total_seconds: 5.25, input_seconds: 0, output_seconds: 5.25, input_image_count: 0, input_audio_seconds: 0 },
        },
    });
    for (const theme of ["light", "dark"]) {
        await page.goto("/admin/generation-operations", { waitUntil: "domcontentloaded" });
        await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
        for (const item of [
            { kind: "preparation", label: "撤销未提交准备", action: "stop_preparation", confirm: "撤销准备并退回" },
            { kind: "unknown", label: "确认未计费", action: "confirm_no_charge", confirm: "确认未计费并退回" },
            { kind: "supplement", label: "补录完整响应", action: "provide_metered_result", confirm: "确认并恢复" },
            { kind: "correction", label: "更正矛盾用量", action: "correct_metered_result", confirm: "确认并恢复" },
        ]) {
            scenario = item.kind;
            reviewed = false;
            await page.reload({ waitUntil: "domcontentloaded" });
            if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
            else await expect(page.locator("html")).not.toHaveClass(/dark/);
            await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
            const dialog = page.getByRole("dialog", { name: "核对按量账务" });
            await expect(dialog).toContainText("视频补录必须对应原创建任务");
            await expect(dialog).toContainText("第 4 次尝试 · 预留 3.00 积分");
            await expect(dialog.getByRole("button", { name: "恢复已有凭据" })).toBeDisabled();
            if (scenario === "unknown") await expect(dialog.getByRole("button", { name: "补录完整响应" })).toHaveCount(0);
            await dialog.getByRole("button", { name: item.label, exact: true }).click();
            await expect(dialog.getByRole("button", { name: item.confirm, exact: true })).toBeDisabled();
            const needsResponse = ["supplement", "correction"].includes(scenario);
            if (needsResponse) await dialog.getByRole("textbox", { name: "供应商完整响应 JSON" }).fill(response);
            const evidence = `供应商原视频凭据 ${scenario}-${theme}`;
            await dialog.getByRole("textbox", { name: "核对依据" }).fill(evidence);
            await expectDialogWithinViewport(dialog);
            await expectNoHorizontalOverflow(page, `video review ${scenario} ${theme}`);
            await page.screenshot({ path: testInfo.outputPath(`video-review-${scenario}-${theme}.png`) });
            await dialog.getByRole("button", { name: item.confirm, exact: true }).click();
            await expect(dialog).toContainText("已保存人工核对依据");
            expect(submitted.at(-1)).toEqual({ action: item.action, attemptNo: 4, evidence, ...(needsResponse ? { response } : {}) });
            await dialog.getByRole("button", { name: "取 消" }).click();
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
            await expect(dialog).toContainText("已保存人工核对依据");
            await dialog.getByRole("button", { name: "确认并恢复" }).click();
            await expect(dialog).toBeHidden();
            expect(submitted.at(-1)).toEqual({ action: "resume_billing", attemptNo: 4 });
        }
    }
});

for (const protocol of ["gemini", "openai"] as const)
    test(`audio pricing task review withdraws preparation and recovers original receipts (${protocol})`, async ({ page, request }, testInfo) => {
        const live = await request.get("/api/admin/generation-operations?pageSize=1");
        expect(live.ok(), await live.text()).toBe(true);
        const base = (await live.json()).data;
        expect((await request.get("/api/admin/generation-operations/audio/fixture-missing/billing-review")).status()).toBe(400);
        const task = {
            id: "priced-audio-review-fixture",
            userId: "fixture-user",
            accountId: "0001",
            username: "fixture",
            displayName: "音频账务测试",
            type: "audio",
            status: "running",
            model: protocol === "openai" ? "gpt-audio-1.5" : "priced-audio",
            prompt: "公开音频需求",
            durationMs: 1000,
            pointsCost: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            canCancel: false,
            canReview: true,
            leaseExpired: false,
            executionPhase: "needs_review",
            billingMode: "official-usage",
            attemptNo: 1,
        };
        await page.route(/\/api\/admin\/generation-operations\?(.*)$/, (route) => route.fulfill({ json: { code: 0, data: { ...base, items: [task], total: 1, page: 1 }, msg: "ok" } }));
        let reviewed = false;
        let submitted = false;
        let receipt = false;
        let invalid = false;
        const writes: Array<Record<string, unknown>> = [];
        await page.route("**/api/admin/generation-operations/audio/priced-audio-review-fixture/billing-review", (route) => {
            if (route.request().method() === "POST") {
                const body = route.request().postDataJSON() as Record<string, unknown>;
                writes.push(body);
                reviewed = true;
                return route.fulfill({ json: { code: 0, data: { executionPhase: body.action === "resume_billing" ? "completed" : "needs_review" }, msg: "ok" } });
            }
            return route.fulfill({
                json: {
                    code: 0,
                    data: {
                        attemptNo: 1,
                        model: task.model,
                        pending: true,
                        stage: submitted ? "outcome_unknown" : "reserved",
                        heldPoints: "28",
                        reviewed,
                        hasSavedResponse: receipt,
                        canStopPreparation: !reviewed && !submitted,
                        canReviewSubmission: submitted,
                        canProvideResult: submitted && !receipt,
                        canConfirmNoCharge: !receipt,
                        canCorrectUsage: invalid && !reviewed,
                        invalidUsage: invalid ? "totalTokens 与分项合计不一致" : undefined,
                        canResumeBilling: reviewed || receipt,
                        officialVersionId: "audio-original",
                        salesVersionId: "sales-original",
                    },
                    msg: "ok",
                },
            });
        });
        const open = async () => {
            await page.getByRole("button", { name: "接管待确认任务" }).filter({ visible: true }).click();
            const dialog = page.getByRole("dialog", { name: "核对按量账务" });
            await expect(dialog).toContainText("音频补录须包含原请求的完整音频与计量");
            if (!submitted || receipt) for (const name of ["补录完整响应", "确认未计费"]) await expect(dialog.getByRole("button", { name, exact: true })).toHaveCount(0);
            if (!invalid) await expect(dialog.getByRole("button", { name: "更正矛盾用量", exact: true })).toHaveCount(0);
            return dialog;
        };
        for (const theme of ["light", "dark"]) {
            reviewed = submitted = receipt = invalid = false;
            await page.goto("/admin/generation-operations", { waitUntil: "domcontentloaded" });
            await page.evaluate((theme) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme }, version: 0 })), theme);
            await page.reload({ waitUntil: "domcontentloaded" });
            if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
            else await expect(page.locator("html")).not.toHaveClass(/dark/);
            const dialog = await open();
            await expect(dialog.getByRole("button", { name: "恢复已有凭据" })).toBeDisabled();
            await dialog.getByRole("button", { name: "撤销未提交准备" }).click();
            await expect(dialog.getByRole("button", { name: "撤销准备并退回" })).toBeDisabled();
            await dialog.getByRole("textbox", { name: "核对依据" }).fill("音频准备中断 fixture-audio-withdrawal");
            await expectDialogWithinViewport(dialog);
            await expectNoHorizontalOverflow(page, `audio preparation ${theme}`);
            await page.screenshot({ path: testInfo.outputPath(`audio-preparation-${theme}.png`) });
            await dialog.getByRole("button", { name: "撤销准备并退回" }).click();
            await expect(dialog).toContainText("已保存人工核对依据");
            await expect(dialog.getByRole("button", { name: "撤销未提交准备" })).toHaveCount(0);
            await dialog.getByRole("button", { name: "取 消" }).click();
            await page.reload({ waitUntil: "domcontentloaded" });
            await open();
            await expect(dialog).toContainText("已保存人工核对依据");
            await dialog.getByRole("button", { name: "确认并恢复" }).click();
            await expect(dialog).toBeHidden();
            submitted = true;
            for (const [action, label] of [
                ["provide_metered_result", "补录完整响应"],
                ["confirm_no_charge", "确认未计费"],
                ["correct_metered_result", "更正矛盾用量"],
            ]) {
                reviewed = false;
                receipt = invalid = action === "correct_metered_result";
                await open();
                await expect(dialog.getByRole("button", { name: "撤销未提交准备" })).toHaveCount(0);
                await dialog.getByRole("button", { name: label, exact: true }).click();
                const confirm = dialog.getByRole("button", { name: action === "confirm_no_charge" ? "确认未计费并退回" : "确认并恢复" });
                await expect(confirm).toBeDisabled();
                const response =
                    protocol === "openai"
                        ? JSON.stringify({
                              model: "gpt-audio-1.5",
                              service_tier: "default",
                              choices: [{ index: 0, message: { audio: { data: "UklGRg==" } } }],
                              usage: {
                                  prompt_tokens: 8,
                                  completion_tokens: 12,
                                  total_tokens: 20,
                                  prompt_tokens_details: { text_tokens: 8, audio_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
                                  completion_tokens_details: { text_tokens: 2, audio_tokens: 10 },
                              },
                          })
                        : '{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/wav","data":"UklGRg=="}}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":12,"totalTokenCount":20}}';
                if (action !== "confirm_no_charge") await dialog.getByRole("textbox", { name: "供应商完整响应 JSON" }).fill(response);
                await dialog.getByRole("textbox", { name: "核对依据" }).fill(`供应商原请求凭据 ${action}`);
                await expect(confirm).toBeEnabled();
                await expectDialogWithinViewport(dialog);
                await expectNoHorizontalOverflow(page, `audio ${action} ${theme}`);
                if (invalid) {
                    await expect(page.getByText("原任务账务已处理完成", { exact: true })).toHaveCount(0);
                    await page.screenshot({ path: testInfo.outputPath(`audio-correction-${theme}.png`) });
                }
                await confirm.click();
                await expect(dialog).toContainText("已保存人工核对依据");
                expect(writes.at(-1)).toEqual({ action, attemptNo: 1, evidence: `供应商原请求凭据 ${action}`, ...(action === "confirm_no_charge" ? {} : { response }) });
                await dialog.getByRole("button", { name: "取 消" }).click();
                await page.reload({ waitUntil: "domcontentloaded" });
                await open();
                await expect(dialog).toContainText("已保存人工核对依据");
                await dialog.getByRole("button", { name: "确认并恢复" }).click();
                await expect(dialog).toBeHidden();
            }
            reviewed = invalid = false;
            receipt = true;
            await open();
            await expect(dialog).toContainText("已有响应凭据");
            await expect(dialog.getByRole("button", { name: "确认并恢复" })).toBeEnabled();
            await expect(page.getByText("原任务账务已处理完成", { exact: true })).toHaveCount(0);
            await expectDialogWithinViewport(dialog);
            await page.screenshot({ path: testInfo.outputPath(`audio-recovery-${theme}.png`) });
            await dialog.getByRole("button", { name: "确认并恢复" }).click();
            await expect(dialog).toBeHidden();
        }
        expect(writes.map((body) => body.action)).toEqual(
            Array.from({ length: 2 }, () => ["stop_preparation", "resume_billing", "provide_metered_result", "resume_billing", "confirm_no_charge", "resume_billing", "correct_metered_result", "resume_billing", "resume_billing"]).flat(),
        );
        expect(writes.every((body) => body.attemptNo === 1)).toBe(true);
        expect(writes.filter((body) => body.action === "stop_preparation")).toEqual(Array.from({ length: 2 }, () => ({ action: "stop_preparation", attemptNo: 1, evidence: "音频准备中断 fixture-audio-withdrawal" })));
    });
