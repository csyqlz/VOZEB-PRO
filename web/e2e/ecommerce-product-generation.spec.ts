import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import sharp from "sharp";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { EcommerceCanvasConstraint, EcommercePhotographyPlan, EcommerceVisibleStructure } from "../src/lib/server/ecommerce-edit-plan";
import type { EcommerceCanvasQualityEvidence, EcommerceQualityCheck } from "../src/lib/server/ecommerce-quality-check";
import type { SceneEditProtectionEvidence } from "../src/lib/server/ecommerce-product-regions";
import type { CreativeAgentRun, CreativeSceneSelection } from "../src/services/api/creative";
import type { CreativeReferenceRecovery, CreativeReferenceReview } from "../src/lib/creative-runtime-contract";
import type { AdminGenerationTask } from "../src/lib/admin-generation-operations";

import { expectNoHorizontalOverflow } from "./responsive-helpers";
import { E2E_PROTOCOL_ORIGIN, e2eSettingsPatch, protocolFixtureState, resetProtocolFixture } from "./support";

type GoldenCase = {
    caseId?: string;
    id: string;
    category: string;
    productFileName: string;
    fixturePath: string;
    fixtureSha256: string;
    sceneFixturePath?: string;
    sceneFixtureSha256?: string;
    userRequest: string;
    expectedOperation: string;
    hardProtections: string[];
};
type GoldenRegression = {
    caseId: string;
    scenario: string;
    userRequest: string;
    followupRequest?: string;
    source?: { kind: "deterministic_scene"; width: number; height: number };
    residualSize?: string;
    expectedOperation: string;
    hardProtections: string[];
    expectedQuality: string;
    manualAcceptance: "pending";
};
type PublicRun = {
    id: string;
    status: string;
    failure?: string;
    conversationId: string;
    assetIds?: string[];
    tasks?: Array<{
        id: string;
        status: string;
        error?: string;
    }>;
    ecommerceQualityStatus?: string;
    ecommerceSceneSelection?: CreativeAgentRun["ecommerceSceneSelection"];
    ecommerceReferenceReview?: CreativeReferenceReview | null;
};
type TraceModel = {
    logicalRole?: string;
    capability?: string;
    logicalModelId?: string;
    channelId?: string;
    upstreamModel?: string;
    apiFormat?: string;
};
type TraceReference = { assetId: string; role?: "product" | "scene"; contentType?: string };
type TraceQualityCheck = {
    resultId: string;
    key: string;
    status: "passed" | "failed" | "not_applicable";
    reason: string;
};
type TraceStage = {
    key: "visual_analysis" | "edit_planning" | "image_generation" | "quality_check";
    status: string;
    model?: TraceModel;
    output: {
        references?: TraceReference[];
        analysisVersion?: string;
        planVersion?: string;
        compilerVersion?: string;
        version?: string;
        photography?: EcommercePhotographyPlan;
        visibleStructure?: EcommerceVisibleStructure[];
        protection?: { scope: string; preserveOutsideMask: boolean; allowLightingChange: boolean };
        observations?: EcommerceQualityCheck["observations"];
        sceneProtectionEvidence?: Array<{ resultId: string; evidence: SceneEditProtectionEvidence }>;
        operation?: string;
        source?: {
            productAnchorId?: string;
            currentSceneBaselineId?: string | null;
            sceneReferenceIds?: string[];
        };
        preserve?: { productCore?: string[] };
        continuity?: { parentResultId?: string | null; sceneRootAssetId?: string | null; branchId?: string; parentQualityCheck?: EcommerceQualityCheck };
        executionPrompt?: string;
        referenceRoles?: TraceReference[];
        mask?: { mode?: string; required?: boolean };
        imageTaskIds?: string[];
        checks?: TraceQualityCheck[];
        hardFailures?: TraceQualityCheck[];
        canvas?: EcommerceCanvasConstraint;
        canvasEvidence?: EcommerceCanvasQualityEvidence[];
        policy?: "disabled" | "advisory";
        technicalCheck?: { status: string };
        modelRoles?: { qualityCheck: string | null };
    };
};
type EcommerceTrace = {
    runId: string;
    imageTaskIds: string[];
    stages: TraceStage[];
    finalStatus: string;
};

const QUALITY_CHECKS = [
    "product_identity",
    "product_silhouette",
    "product_color_material",
    "product_proportions_view",
    "brand_logo",
    "packaging_text",
    "scene_intent",
    "composition_lighting",
    "protected_structure",
    "protected_material",
    "unmodified_region",
] as const;
const MODEL_ROUTES: Record<TraceStage["key"], Required<TraceModel>> = {
    visual_analysis: {
        logicalRole: "vision_analysis",
        capability: "text",
        logicalModelId: "e2e-ecommerce-vision",
        channelId: "e2e-primary",
        upstreamModel: "e2e-ecommerce-vision-upstream",
        apiFormat: "openai",
    },
    edit_planning: {
        logicalRole: "edit_planning",
        capability: "text",
        logicalModelId: "e2e-ecommerce-planner",
        channelId: "e2e-primary",
        upstreamModel: "e2e-ecommerce-planner-upstream",
        apiFormat: "openai",
    },
    image_generation: {
        logicalRole: "image_generation",
        capability: "image",
        logicalModelId: "e2e-ecommerce-image",
        channelId: "e2e-primary",
        upstreamModel: "gpt-image-2.5-flare",
        apiFormat: "openai",
    },
    quality_check: {
        logicalRole: "quality_check",
        capability: "text",
        logicalModelId: "e2e-ecommerce-quality",
        channelId: "e2e-primary",
        upstreamModel: "e2e-ecommerce-quality-upstream",
        apiFormat: "openai",
    },
};

const manifest = JSON.parse(readFileSync(new URL("./fixtures/ecommerce-product-cases.json", import.meta.url), "utf8")) as Array<GoldenCase | GoldenRegression>;
const cases = manifest.filter((item): item is GoldenCase => "id" in item);
const regressions = manifest.filter((item): item is GoldenRegression => "scenario" in item);
const fixtureBytes = new Map<string, { buffer: Buffer; sha256: string }>();
let pausedRunForCleanup: { runId: string; conversationId: string } | undefined;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    pausedRunForCleanup = undefined;
    await resetProtocolFixture(request);
    const saved = await request.patch("/api/admin/settings", { data: { ...e2eSettingsPatch(), ecommerceVisualQualityCheckEnabled: true } });
    expect(saved.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
    const saved = await request.patch("/api/admin/settings", { data: { ecommerceVisualQualityCheckEnabled: false } });
    expect(saved.ok()).toBe(true);
    if (!pausedRunForCleanup) return;
    const response = await request.post(`/api/agent/runs/${encodeURIComponent(pausedRunForCleanup.runId)}/cancel`, {
        data: { conversationId: pausedRunForCleanup.conversationId },
    });
    if (!response.ok()) throw new Error(`Unable to clean up paused ecommerce run: ${response.status()} ${await response.text()}`);
    pausedRunForCleanup = undefined;
});

test("optional-quality-toggle:后台双向保存立即回读并刷新保持", async ({ page, request }) => {
    await request.patch("/api/admin/settings", { data: { ecommerceVisualQualityCheckEnabled: false } });
    await page.goto("/admin?section=channels", { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "电商流程", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "启用可选视觉质检", exact: true });
    await expect(toggle).not.toBeChecked();
    for (const enabled of [true, false]) {
        await toggle.setChecked(enabled);
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/admin/settings");
        await page.getByRole("button", { name: "保存模型渠道配置", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        const persisted = await request.get("/api/admin/settings");
        expect(persisted.ok()).toBe(true);
        expect((await persisted.json()).settings.ecommerceVisualQualityCheckEnabled).toBe(enabled);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "电商流程", exact: true }).click();
        await expect(toggle).toBeChecked({ checked: enabled });
    }
});

test("optional-quality-disabled:默认关闭零质检调用且图片可下载引用连续编辑", async ({ page, request }) => {
    const saved = await request.patch("/api/admin/settings", { data: { ecommerceVisualQualityCheckEnabled: false, ecommerceModelRoles: { ...e2eSettingsPatch().ecommerceModelRoles, quality_check: [] } } });
    expect(saved.ok()).toBe(true);
    const first = await submitProductScene(page, cases[0]);
    const firstRun = await waitForRun(request, first.runId, "completed");
    expect(firstRun.assetIds).toHaveLength(1);
    const firstTrace = await expectAdminTrace(request, firstRun.id, "not_run");
    expect(traceStage(firstTrace, "quality_check")).toMatchObject({ status: "not_run", output: { policy: "disabled" } });
    expect(traceStage(firstTrace, "quality_check").model).toBeUndefined();
    expect(traceStage(firstTrace, "edit_planning").output.modelRoles?.qualityCheck).toBeNull();
    expect(traceStage(firstTrace, "image_generation").output.technicalCheck?.status).toBe("passed");
    await expectProductResult(page);
    await expect(page.getByTestId("creative-quality-review")).toHaveCount(0);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载", exact: true }).last().click();
    expect(await (await downloading).failure()).toBeNull();
    await page.getByRole("button", { name: "更多本轮创作操作", exact: true }).last().click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();
    await page.getByRole("button", { name: "更多本轮创作操作", exact: true }).last().click();
    await page.getByRole("menuitem", { name: "取消引用", exact: true }).click();
    const second = await submitPrompt(page, "让场景光线再亮一点。", { reusePage: true });
    const secondRun = await waitForRun(request, second.runId, "completed");
    const secondTrace = await expectAdminTrace(request, secondRun.id, "not_run");
    expect(traceStage(secondTrace, "edit_planning").output).toMatchObject({ source: { currentSceneBaselineId: firstRun.assetIds![0] }, continuity: { parentResultId: firstRun.assetIds![0] } });
    expect(traceStage(secondTrace, "image_generation").output.technicalCheck?.status).toBe("passed");
    expect(secondRun.assetIds).toHaveLength(1);
    await expect(page.getByTestId("creative-media-result")).toHaveCount(2);
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && item.model === MODEL_ROUTES.quality_check.upstreamModel)).toHaveLength(0);
    expect(state.requests.filter((item) => item.method === "POST" && /\/images\//.test(item.path))).toHaveLength(2);
});

test("reference-confirm:真实用途歧义刷新后确认同一轮并复用有效分析", async ({ page, request }) => {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    const product = cases[0];
    const scene = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#567789" } })
        .png()
        .toBuffer();
    await page.locator('input[type="file"][multiple]').setInputFiles([uploadFixture(product.fixturePath, product.productFileName, product.fixtureSha256), { name: "reference-scene.png", mimeType: "image/png", buffer: scene }]);
    const created = await submitPrompt(page, "图片1和图片2", { reusePage: true });
    pausedRunForCleanup = created;
    const waiting = await waitForRun(request, created.runId, "paused");
    expect(waiting.ecommerceReferenceReview?.kind).toBe("confirm_purposes");
    expectPublicWhitelist(waiting);
    const beforeMessages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((response) => response.json());
    const before = await protocolFixtureState(request);
    expect(before.requests.filter((item) => item.method === "POST" && /\/images\//.test(item.path))).toHaveLength(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("creative-reference-review");
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-review-id", waiting.ecommerceReferenceReview!.reviewId);
    const entries = panel.getByTestId("creative-reference-review-asset");
    await expect(entries).toHaveCount(2);
    for (const [index, asset] of waiting.ecommerceReferenceReview!.assets.entries()) await expect(entries.nth(index).getByRole("img", { name: asset.alias, exact: true })).toHaveAttribute("src", `${asset.previewUrl}?format=webp&width=320`);
    await entries.nth(0).getByRole("radio", { name: "修改这张图", exact: true }).check();
    await entries.nth(0).getByRole("checkbox", { name: "保留商品身份", exact: true }).check();
    await entries.nth(1).getByRole("checkbox", { name: "参考光线", exact: true }).check();
    const response = page.waitForResponse((value) => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent/runs/${created.runId}/resume`);
    await panel.getByRole("button", { name: "确认用途并继续", exact: true }).click();
    const resumed = await response;
    expect(resumed.ok(), await resumed.text()).toBe(true);
    const body = resumed.request().postDataJSON() as { conversationId: string; referenceRecovery: CreativeReferenceRecovery };
    expect(body).toMatchObject({ conversationId: created.conversationId, referenceRecovery: { reviewId: waiting.ecommerceReferenceReview!.reviewId, action: "confirm_purposes", decisionVersion: "ecommerce-reference-decision.v1" } });
    expect(((await resumed.json()).data.run as PublicRun).ecommerceReferenceReview).toBeNull();
    expect((await request.post(`/api/agent/runs/${created.runId}/resume`, { data: body })).status()).toBe(409);
    const completed = await waitForRun(request, created.runId, "completed");
    pausedRunForCleanup = undefined;
    const trace = await expectAdminTrace(request, created.runId, "passed");
    expectLatestTraceVersions(trace);
    const after = await protocolFixtureState(request);
    const analyses = (state: typeof after) => state.requests.filter((item) => item.method === "POST" && item.model === MODEL_ROUTES.visual_analysis.upstreamModel).length;
    expect(analyses(after)).toBe(analyses(before));
    expect(after.requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
    const afterMessages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((value) => value.json());
    expect(afterMessages.data.messages.map((message: { id: string }) => message.id)).toEqual(beforeMessages.data.messages.map((message: { id: string }) => message.id));
    await expectProductResult(page);
    await expectNoHorizontalOverflow(page);
});

test("reference-retry:真实分析服务失败刷新后重新分析原Run并完成v4v6路径", async ({ page, request }) => {
    const control = (enabled: boolean) => request.post(`${E2E_PROTOCOL_ORIGIN}/__ecommerce-analysis-failure`, { data: { enabled } });
    expect((await control(true)).ok()).toBe(true);
    try {
        const created = await submitProductScene(page, cases[0]);
        pausedRunForCleanup = created;
        const waiting = await waitForRun(request, created.runId, "paused");
        expect(waiting.ecommerceReferenceReview?.kind).toBe("retry_analysis");
        expectPublicWhitelist(waiting);
        const messages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((response) => response.json());
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && /\/images\//.test(item.path))).toHaveLength(0);
        expect((await control(false)).ok()).toBe(true);
        await page.reload({ waitUntil: "domcontentloaded" });
        const panel = page.getByTestId("creative-reference-review");
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("img")).toHaveCount(1);
        await expect(panel.getByRole("radio")).toHaveCount(0);
        const response = page.waitForResponse((value) => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent/runs/${created.runId}/resume`);
        await panel.getByRole("button", { name: "重新分析", exact: true }).click();
        const resumed = await response;
        expect(resumed.ok(), await resumed.text()).toBe(true);
        expect(resumed.request().postDataJSON()).toEqual({ conversationId: created.conversationId, referenceRecovery: { reviewId: waiting.ecommerceReferenceReview!.reviewId, action: "retry_analysis" } });
        const completed = await waitForRun(request, created.runId, "completed");
        pausedRunForCleanup = undefined;
        expectLatestTraceVersions(await expectAdminTrace(request, created.runId, "passed"));
        const afterMessages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`).then((value) => value.json());
        expect(afterMessages.data.messages.map((message: { id: string }) => message.id)).toEqual(messages.data.messages.map((message: { id: string }) => message.id));
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        await expectProductResult(page);
        await expectNoHorizontalOverflow(page);
    } finally {
        expect((await control(false)).ok()).toBe(true);
    }
});

for (const kind of ["confirm_purposes", "retry_analysis"] as const)
    test(`reference-ui-${kind}:完成态助手刷新复核缩略图并保留409与单次提交`, async ({ page }) => {
        const fixture = await installReferenceReviewFixture(page, kind);
        await page.goto(`/create?conversationId=${fixture.run.conversationId}`, { waitUntil: "domcontentloaded" });
        let panel = page.getByTestId("creative-reference-review");
        await expect(panel).toBeVisible();
        await expect(page.getByText("已为你生成图片", { exact: true })).toHaveCount(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        panel = page.getByTestId("creative-reference-review");
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("img", { name: "图片1", exact: true })).toHaveAttribute("src", `${fixture.run.ecommerceReferenceReview!.assets[0].previewUrl}?format=webp&width=320`);
        const button = panel.getByRole("button");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAccessibleName(kind === "confirm_purposes" ? "确认用途并继续" : "重新分析");
        if (kind === "confirm_purposes") {
            await expect(panel.getByRole("img", { name: "当前图片", exact: true })).toHaveAttribute("src", `${fixture.run.ecommerceReferenceReview!.inheritedEditTarget!.previewUrl}?format=webp&width=320`);
            await expect(panel.getByRole("radio", { name: "继续修改当前图片", exact: true })).toBeChecked();
            await expect(panel.getByRole("radio", { name: "修改这张图", exact: true })).toHaveCount(0);
            await expect(panel.getByRole("checkbox", { name: "保留商品身份", exact: true })).toHaveCount(0);
            await expect(button).toBeDisabled();
            await panel.getByRole("checkbox", { name: "参考光线", exact: true }).check();
            await expect(button).toBeEnabled();
            await panel.getByRole("checkbox", { name: "参考光线", exact: true }).uncheck();
            await expect(button).toBeDisabled();
            await panel.getByRole("checkbox", { name: "参考光线", exact: true }).check();
        }
        await expect(button).toBeEnabled();
        await button.dblclick();
        await expect(button).toBeDisabled();
        await expect(panel.locator(".anticon-loading")).toBeVisible();
        await fixture.requestReceived;
        expect(fixture.controls).toHaveLength(1);
        fixture.release();
        await expect(panel.getByRole("alert")).toContainText("参考复核已变化，请刷新后重试。");
        await expect(button).toBeEnabled();
        expect(fixture.controls).toHaveLength(1);
        expect(fixture.controls[0]).toEqual({
            conversationId: fixture.run.conversationId,
            referenceRecovery:
                kind === "retry_analysis"
                    ? { reviewId: "r3-review", action: kind }
                    : { reviewId: "r3-review", action: kind, decisionVersion: "ecommerce-reference-decision.v1", bindings: [{ assetId: "r3-product", assetVersion: "r3-product-version", purposes: ["lighting"] }] },
        });
        expect(fixture.createdRuns()).toBe(0);
        await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
        await expectNoHorizontalOverflow(page);
    });

for (const action of ["retry_source", "check_status"] as const)
    test(`reference-ui-${action}:刷新后恢复原Run且不创建第二轮`, async ({ page }) => {
        const fixture = await installReferenceReviewFixture(page, action, true);
        const original = { id: fixture.run.id, conversationId: fixture.run.conversationId, inputMessageId: fixture.run.inputMessageId, assistantMessageId: fixture.run.assistantMessageId };
        await page.goto(`/create?conversationId=${original.conversationId}`, { waitUntil: "domcontentloaded" });
        const label = action === "retry_source" ? "重试并继续" : "检查状态";
        await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
        await page.reload({ waitUntil: "domcontentloaded" });
        const waitingPanel = page.getByTestId("creative-generation-waiting");
        const button = waitingPanel.getByRole("button");
        await expect(button).toHaveCount(1);
        await expect(button).toHaveAccessibleName(label);
        await expect(button).toBeVisible();
        const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/agent/runs/${original.id}/resume` && response.request().method() === "POST");
        await button.dblclick();
        await expect(button).toBeDisabled();
        if (action === "check_status") await expect(button).toHaveText("正在检查");
        await fixture.requestReceived;
        expect(fixture.controls).toHaveLength(1);
        expect(fixture.controls[0]).toEqual({ conversationId: original.conversationId, ...(action === "retry_source" ? { referenceRecovery: { reviewId: "r3-review", action } } : {}) });
        fixture.release();
        const response = await responsePromise;
        expect(response.ok()).toBe(true);
        expect(fixture.controls).toHaveLength(1);
        expect((await response.json()).data.run).toMatchObject({ ...original, status: action === "retry_source" ? "planning" : "running", ecommerceReferenceReview: null, canCheckStatus: false });
        await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
        await expect(waitingPanel.getByRole("button")).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-waiting")).toBeVisible();
        expect(fixture.createdRuns()).toBe(0);
        await expect(page.getByTestId("creative-round-request")).toHaveCount(1);
        await expectNoHorizontalOverflow(page);
    });

async function installReferenceReviewFixture(page: Page, kind: CreativeReferenceReview["kind"] | "check_status", continueOriginal = false) {
    const timestamp = Date.now();
    const conversation = { id: "r3-conversation", userId: "fixture-user", surface: "chat", source: "agent", title: "参考复核", createdAt: timestamp, updatedAt: timestamp };
    const run: CreativeAgentRun = {
        id: "r3-run",
        conversationId: conversation.id,
        inputMessageId: "r3-input",
        assistantMessageId: "r3-assistant",
        surface: "chat",
        status: "paused",
        prompt: kind === "confirm_purposes" ? "参考图片1的光线继续修改当前图片" : "修改图片1",
        createdAt: timestamp,
        updatedAt: timestamp,
        assetIds: [],
        generationPreferences: { mode: "image" },
        tasks: kind === "check_status" ? [{ id: "r3-image-task", title: "商品场景图", type: "image", model: "fixture-image", status: "needs_review", error: "参考图片暂时无法读取，请检查状态后继续原任务。" }] : [],
        canCheckStatus: kind === "check_status",
        ecommerceReferenceReview:
            kind === "check_status"
                ? null
                : {
                      version: "ecommerce-reference-review.v1",
                      reviewId: "r3-review",
                      kind,
                      question: kind === "retry_source" ? "参考图片暂时无法读取，可重试后继续这次创作。" : "请确认参考用途后继续这次创作。",
                      ...(kind === "confirm_purposes" ? { inheritedEditTarget: { assetId: "r3-current", previewUrl: "/api/reference-assets/r3-current.png" } } : {}),
                      assets: [
                          {
                              assetId: "r3-product",
                              assetVersion: "r3-product-version",
                              alias: "图片1",
                              previewUrl: "/api/reference-assets/r3-product.png",
                              purposes: kind === "confirm_purposes" ? [] : ["edit_target", "product_identity"],
                              allowedPurposes: kind === "confirm_purposes" ? ["lighting"] : ["edit_target", "product_identity"],
                          },
                      ],
                  },
    };
    const controls: unknown[] = [];
    let created = 0;
    const gate = Promise.withResolvers<void>();
    const requestReceived = Promise.withResolvers<void>();
    const messages = [
        { id: run.inputMessageId, conversationId: conversation.id, runId: run.id, sequence: 1, role: "user", status: "completed", content: run.prompt, metadata: {}, createdAt: timestamp, updatedAt: timestamp },
        { id: run.assistantMessageId, conversationId: conversation.id, runId: run.id, sequence: 2, role: "assistant", status: "completed", content: "已保存这次任务进度", metadata: {}, createdAt: timestamp, updatedAt: timestamp },
    ];
    const preview = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#987654" } })
        .png()
        .toBuffer();
    await page.route(/\/api\/reference-assets\/r3-(?:product|current)\.png(?:\?.*)?$/, (route) => route.fulfill({ body: preview, contentType: "image/png" }));
    await page.route(/\/api\/creative\/conversations(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { conversations: [conversation], hasMore: false } } }));
    await page.route(/\/api\/creative\/conversations\/r3-conversation$/, (route) => route.fulfill({ json: { code: 0, data: { conversation } } }));
    await page.route(/\/api\/creative\/conversations\/r3-conversation\/messages(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { messages, hasMore: false } } }));
    await page.route(/\/api\/creative\/conversations\/r3-conversation\/assets(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { assets: [] } } }));
    await page.route(/\/api\/agent\/runs(?:\?.*)?$/, (route) => {
        if (route.request().method() === "POST") created++;
        return route.fulfill({ json: { code: 0, data: { runs: [run] } } });
    });
    await page.route(/\/api\/agent\/runs\/r3-run$/, (route) => route.fulfill({ json: { code: 0, data: { run } } }));
    await page.route(/\/api\/agent\/runs\/r3-run\/events(?:\?.*)?$/, (route) => route.fulfill({ contentType: "text/event-stream", body: `event: run.snapshot\ndata: ${JSON.stringify(run)}\n\n` }));
    await page.route(/\/api\/agent\/runs\/r3-run\/resume$/, async (route) => {
        controls.push(route.request().postDataJSON());
        requestReceived.resolve();
        await gate.promise;
        if (continueOriginal) {
            run.status = kind === "check_status" ? "running" : "planning";
            run.ecommerceReferenceReview = null;
            run.canCheckStatus = false;
            run.tasks = run.tasks.map((task) => ({ ...task, status: "running" }));
            await route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
            return;
        }
        await route.fulfill({ status: 409, json: { code: 409, data: null, msg: "参考复核已变化，请刷新后重试。" } });
    });
    return { run, controls, requestReceived: requestReceived.promise, release: () => gate.resolve(), createdRuns: () => created };
}

for (const goldenCase of cases) {
    test(`${goldenCase.caseId || goldenCase.id}:${goldenCase.category}白底或透明底商品可从一句话生成场景`, async ({ page, request }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "完整类别回归只在桌面 Chromium 执行");

        const created = await submitProductScene(page, goldenCase);
        const run = await waitForRun(request, created.runId, "completed");
        await expectProductResult(page);
        await expectPublicProgress(request, run.id);
        const trace = await expectAdminTrace(request, run.id, "passed");
        expectSuccessfulTrace(trace, {
            operation: goldenCase.expectedOperation,
            hardProtections: goldenCase.hardProtections,
            userRequest: goldenCase.userRequest,
        });

        const state = await protocolFixtureState(request);
        expect(state.requests.some((item) => item.path.endsWith("/images/edits") && item.contentType.includes("multipart/form-data"))).toBe(true);
    });
}

for (const golden of regressions.filter((item) => item.scenario === "selection")) {
    test(`${golden.caseId}:真实等待态确认原任务并回读独立保护证据`, async ({ page, request }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "真实服务端链路在桌面执行；布局矩阵另有DTO测试");
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        if (golden.residualSize) {
            const trigger = page.getByRole("button", { name: /生成参数：/ });
            await trigger.click();
            await page.getByRole("button", { name: `选择图片比例 ${golden.residualSize}`, exact: true }).click();
            await trigger.click();
        }
        const source = await deterministicScene(golden.source!);
        await page.locator('input[type="file"][multiple]').setInputFiles({ name: `${golden.caseId}.png`, mimeType: "image/png", buffer: source });
        const created = await submitPrompt(page, golden.userRequest, { reusePage: true });
        pausedRunForCleanup = created;
        const waiting = await waitForRun(request, created.runId, "paused");
        const selection = waiting.ecommerceSceneSelection!;
        expect(selection).toMatchObject({ action: "confirm_scene_selection", width: golden.source!.width, height: golden.source!.height });
        expectPublicWhitelist(waiting);
        const taskId = waiting.tasks?.[0].id;
        expect((await protocolFixtureState(request)).requests.some((item) => item.path.endsWith("/images/edits"))).toBe(false);
        const stale = await request.post(`/api/agent/runs/${created.runId}/resume`, {
            data: { conversationId: `${created.conversationId}-other`, sceneSelection: { baselineAssetId: selection.baselineAssetId, region: { x: 1, y: 1, width: 2, height: 2 } } },
        });
        expect(stale.status()).toBe(409);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
        const image = page.getByRole("img", { name: "选择修改位置的原图", exact: true });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0 && (element as HTMLImageElement).naturalHeight > 0)).toBe(true);
        const box = await image.boundingBox();
        if (!box) throw new Error("Real selection image has no geometry");
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
        await page.mouse.up();
        const resumeResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/runs/${created.runId}/resume`);
        await page.getByRole("button", { name: "确认修改位置", exact: true }).click();
        const resumed = await resumeResponse;
        expect(resumed.ok(), await resumed.text()).toBe(true);
        const body = resumed.request().postDataJSON() as { conversationId: string; sceneSelection: CreativeSceneSelection };
        expect(body).toMatchObject({ conversationId: created.conversationId, sceneSelection: { baselineAssetId: selection.baselineAssetId } });
        const resumedRun = ((await resumed.json()) as { data: { run: PublicRun } }).data.run;
        expect(resumedRun).toMatchObject({ id: created.runId, tasks: [{ id: taskId }] });
        expectPublicWhitelist(resumedRun);
        const completed = await waitForRun(request, created.runId, "completed");
        pausedRunForCleanup = undefined;
        expect(completed.tasks?.[0].id).toBe(taskId);
        const trace = await expectAdminTrace(request, created.runId, "passed");
        expectLatestTraceVersions(trace);
        const plan = traceStage(trace, "edit_planning").output;
        expect(plan).toMatchObject({
            operation: "scene_edit",
            canvas: { mode: "exact", source: "user_text", size: { width: golden.source!.width, height: golden.source!.height } },
            protection: { scope: "local", preserveOutsideMask: true, allowLightingChange: false },
        });
        expect(trace.imageTaskIds).toHaveLength(1);
        const evidence = traceStage(trace, "quality_check").output.sceneProtectionEvidence?.[0].evidence;
        expect(evidence).toMatchObject({
            sourceAssetId: selection.baselineAssetId,
            sourceSize: { width: golden.source!.width, height: golden.source!.height },
            nativeSize: { width: golden.source!.width, height: golden.source!.height },
            targetRegion: body.sceneSelection.region,
            compositeOutsideChangedPixels: 0,
        });
        if (!evidence?.maskUrl || !evidence.nativeUrl || !evidence.compositeUrl) throw new Error("Real local edit lacks full mask/native/composite evidence");
        const proof = await Promise.all(
            [selection.url, evidence.maskUrl, evidence.nativeUrl, evidence.compositeUrl].map(async (url) => {
                const response = await request.get(url);
                expect(response.ok()).toBe(true);
                return response.body();
            }),
        );
        const decoded = await Promise.all(proof.map((bytes) => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
        for (const image of decoded) {
            expect(image.info).toMatchObject({ width: golden.source!.width, height: golden.source!.height, channels: 4 });
            expect(image.data.length).toBe(golden.source!.width * golden.source!.height * 4);
        }
        const diff = Buffer.alloc(decoded[0].data.length);
        let outsideChanges = 0;
        for (let offset = 0; offset < diff.length; offset += 4) {
            const changed = !decoded[0].data.subarray(offset, offset + 4).equals(decoded[3].data.subarray(offset, offset + 4));
            if (changed && decoded[1].data[offset + 3] !== 0) outsideChanges++;
            if (changed) {
                diff[offset] = 255;
                diff[offset + 3] = 255;
            }
        }
        expect(outsideChanges).toBe(0);
        for (const [index, label] of ["source", "mask", "native", "composite"].entries()) await testInfo.attach(`${golden.caseId}-${label}.png`, { body: proof[index], contentType: "image/png" });
        await testInfo.attach(`${golden.caseId}-diff.png`, {
            body: await sharp(diff, { raw: { width: golden.source!.width, height: golden.source!.height, channels: 4 } })
                .png()
                .toBuffer(),
            contentType: "image/png",
        });
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        const duplicate = await request.post(`/api/agent/runs/${created.runId}/resume`, { data: body });
        expect(duplicate.status()).toBe(409);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectProductResult(page);
        expectPublicWhitelist(completed);
    });
}

for (const golden of regressions.filter((item) => ["hard_structure", "quality_unavailable", "soft_quality"].includes(item.scenario))) {
    test(`${golden.caseId}:真实生成先交付再提供可选视觉建议`, async ({ page, request }, testInfo) => {
        test.skip(testInfo.project.name !== "chromium", "服务端门禁专项");
        const created = await submitProductScene(page, { ...cases[0], userRequest: golden.userRequest });
        const run = await waitForRun(request, created.runId, "completed");
        const trace = await expectAdminTrace(request, created.runId, golden.scenario === "hard_structure" ? "blocked" : golden.scenario === "quality_unavailable" ? "unavailable" : "needs_adjustment");
        expectLatestTraceVersions(trace);
        const quality = traceStage(trace, "quality_check").output;
        if (golden.scenario === "hard_structure") {
            expect(quality.observations).toMatchObject({ baseline: { visibleStructure: [{ count: 3 }] }, results: [{ observation: { visibleStructure: [{ count: 4 }] } }] });
            expect(quality.hardFailures).toEqual(expect.arrayContaining([expect.objectContaining({ key: "protected_structure", status: "failed" })]));
        } else if (golden.scenario === "soft_quality") expect(quality.hardFailures).toEqual([]);
        const assets = await conversationAssets(request, run.conversationId);
        expect(assets.some((asset) => asset.sourceRunId === run.id && asset.status === "ready")).toBe(true);
        expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "参考建议", level: 3, exact: true })).toBeVisible();
        await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
        expectPublicWhitelist(run);
    });
}

test("scene-no-product-continuity:真实两轮编排保持根父结果与历史分支", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "场景连续性专项");
    const golden = regressions.find((item) => item.caseId === "scene-no-product-continuity")!;
    const product = { ...cases[5], productFileName: "scene-only.webp", fixturePath: cases[5].sceneFixturePath!, fixtureSha256: cases[5].sceneFixtureSha256!, userRequest: golden.userRequest };
    const first = await submitProductScene(page, product);
    const firstRun = await waitForRun(request, first.runId, "completed");
    const firstTrace = await expectAdminTrace(request, firstRun.id, "passed");
    const firstSource = traceStage(firstTrace, "edit_planning").output.source!.currentSceneBaselineId;
    expect(traceStage(firstTrace, "edit_planning").output.source!.productAnchorId).toBeNull();
    const second = await submitPrompt(page, golden.followupRequest!, { reusePage: true });
    pausedRunForCleanup = second;
    const waiting = await waitForRun(request, second.runId, "paused");
    const selection = waiting.ecommerceSceneSelection!;
    expect(selection).toMatchObject({ action: "confirm_scene_selection", baselineAssetId: firstRun.assetIds![0], width: 1024, height: 1024 });
    expect(waiting.tasks).toEqual([expect.objectContaining({ id: "ecommerce-scene-edit", status: "needs_review" })]);
    expectPublicWhitelist(waiting);
    const taskId = waiting.tasks![0].id;
    expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(1);
    let resumeSubmissions = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === `/api/agent/runs/${second.runId}/resume`) resumeSubmissions++;
    });
    await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
    const image = page.getByRole("img", { name: "选择修改位置的原图", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0 && (element as HTMLImageElement).naturalHeight > 0)).toBe(true);
    await image.scrollIntoViewIfNeeded();
    const box = await image.boundingBox();
    if (!box) throw new Error("Continuity selection image has no geometry");
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await page.mouse.up();
    const confirm = page.getByTestId("creative-scene-selection").getByRole("button", { name: /确认修改位置$/ });
    await expect(confirm).toBeEnabled();
    const resumeResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent/runs/${second.runId}/resume`);
    await confirm.click();
    const resumed = await resumeResponse;
    expect(resumed.ok(), await resumed.text()).toBe(true);
    const body = resumed.request().postDataJSON() as { conversationId: string; sceneSelection: CreativeSceneSelection };
    expect(body).toMatchObject({ conversationId: second.conversationId, sceneSelection: { baselineAssetId: selection.baselineAssetId } });
    const resumedRun = ((await resumed.json()) as { data: { run: PublicRun } }).data.run;
    expect(resumedRun).toMatchObject({ id: second.runId, conversationId: second.conversationId, tasks: [{ id: taskId }] });
    expectPublicWhitelist(resumedRun);
    const secondRun = await waitForRun(request, second.runId, "completed");
    pausedRunForCleanup = undefined;
    expect(secondRun.tasks?.[0].id).toBe(taskId);
    expect(resumeSubmissions).toBe(1);
    expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && item.path.endsWith("/images/edits"))).toHaveLength(2);
    const secondTrace = await expectAdminTrace(request, secondRun.id, "passed");
    expectLatestTraceVersions(secondTrace);
    expect(traceStage(secondTrace, "edit_planning").output.protection).toMatchObject({ scope: "local", preserveOutsideMask: true, allowLightingChange: false });
    expect(traceStage(secondTrace, "image_generation").output.mask).toEqual({ mode: "independent", required: true });
    const evidence = traceStage(secondTrace, "quality_check").output.sceneProtectionEvidence?.[0].evidence;
    expect(evidence).toMatchObject({ sourceAssetId: selection.baselineAssetId, targetRegion: body.sceneSelection.region, compositeOutsideChangedPixels: 0 });
    if (!evidence?.maskUrl) throw new Error("Continuity edit lacks a real selection mask");
    const maskResponse = await request.get(evidence.maskUrl);
    expect(maskResponse.ok()).toBe(true);
    const mask = await sharp(await maskResponse.body())
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    expect(mask.info).toMatchObject({ width: selection.width, height: selection.height, channels: 4 });
    const region = body.sceneSelection.region;
    const insideMaskOffset = (Math.floor(region.y + region.height / 2) * selection.width + Math.floor(region.x + region.width / 2)) * 4;
    expect(mask.data[insideMaskOffset + 3]).toBe(0);
    expect(mask.data[3]).toBe(255);
    expect(traceStage(secondTrace, "image_generation").output.continuity).toMatchObject({ sceneRootAssetId: firstSource, parentResultId: firstRun.assetIds![0], parentQualityCheck: { version: "ecommerce-quality.v2", status: "passed" } });
    expect(secondRun.assetIds![0]).not.toBe(firstRun.assetIds![0]);
    await page.getByRole("button", { name: "更多本轮创作操作" }).first().click();
    await page.getByRole("menuitem", { name: "引用结果" }).click();
    const branch = await submitPrompt(page, "无商品锚点场景，从较早结果改成午后阳光。", { reusePage: true });
    pausedRunForCleanup = branch;
    const branchRun = await waitForRun(request, branch.runId, "completed");
    pausedRunForCleanup = undefined;
    expect(branchRun.ecommerceReferenceReview).toBeNull();
    const branchTrace = await expectAdminTrace(request, branchRun.id, "passed");
    expect(traceStage(branchTrace, "image_generation").output.continuity).toMatchObject({ sceneRootAssetId: firstSource, parentResultId: firstRun.assetIds![0], parentQualityCheck: { status: "passed" } });
    expect(traceStage(branchTrace, "edit_planning").output.continuity?.branchId).not.toBe(traceStage(secondTrace, "edit_planning").output.continuity?.branchId);
    const unchanged = await request.get(`/api/agent/runs/${first.runId}`);
    expect(((await unchanged.json()) as { data: { run: PublicRun } }).data.run.assetIds).toEqual(firstRun.assetIds);
});

test("unsupported-mask:真实协议能力门禁保留原任务且不整图重绘", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "真实协议否定对照在桌面执行");
    const golden = regressions.find((item) => item.caseId === "unsupported-mask")!;
    const settings = e2eSettingsPatch();
    const model = "nano-banana-2";
    const channelId = "e2e-maskless-gemini";
    const logicalModelId = "e2e-maskless-image";
    const operation = { capability: "image", source: "manual", protocol: "compatible", apiFormat: "gemini", createPath: `/models/${model}:generateContent`, supportsReferenceImage: true };
    const configured = await request.patch("/api/admin/settings", {
        data: {
            ...settings,
            systemChannels: [
                ...settings.systemChannels,
                {
                    ...settings.systemChannels[0],
                    id: channelId,
                    name: "E2E 无独立蒙版协议",
                    apiFormat: "gemini",
                    models: [model],
                    advancedConfig: {
                        ...settings.systemChannels[0].advancedConfig,
                        protocol: "compatible",
                        authMode: "custom-header",
                        authHeader: "x-goog-api-key",
                        authPrefix: "",
                        modelCatalogPaths: ["/v1beta/models"],
                        modelCapabilities: { [model]: "image" },
                        modelConfigs: { [model]: operation },
                        operationConfigs: { image: operation },
                    },
                },
            ],
            logicalModels: [...settings.logicalModels, { id: logicalModelId, name: "E2E 无独立蒙版图片", capability: "image", enabled: true, bindings: [{ id: "e2e-maskless-binding", channelId, upstreamModel: model, enabled: true, priority: 1 }] }],
            ecommerceModelRoles: { ...settings.ecommerceModelRoles, image_generation: [logicalModelId] },
            modelPointCosts: { ...settings.modelPointCosts, [model]: 0, [logicalModelId]: 0 },
        },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    try {
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        await page.locator('input[type="file"][multiple]').setInputFiles({ name: "unsupported-mask-scene.png", mimeType: "image/png", buffer: await deterministicScene(golden.source!) });
        const created = await submitPrompt(page, golden.userRequest, { reusePage: true });
        pausedRunForCleanup = created;
        const paused = await waitForRun(request, created.runId, "paused");
        expect(paused.tasks).toMatchObject([{ status: "needs_review" }]);
        expect(paused.ecommerceSceneSelection).toBeUndefined();
        expectPublicWhitelist(paused);
        const detail = await request.get("/api/admin/generation-operations?type=agent");
        expect(detail.ok(), await detail.text()).toBe(true);
        const internal = ((await detail.json()).data.items as Array<{ id: string; status: string; model: string; error?: string; childTasks?: unknown[] }>).find((item) => item.id === created.runId);
        expect(internal).toMatchObject({ id: created.runId, status: "paused", model: logicalModelId, error: "当前渠道尚未配置可用的独立蒙版编辑方式，请联系管理员。" });
        const creates = (state: Awaited<ReturnType<typeof protocolFixtureState>>) => state.requests.filter((item) => item.method === "POST" && (/\/images\//.test(item.path) || /:generateContent$/.test(item.path))).length;
        expect(creates(await protocolFixtureState(request))).toBe(0);
        const rejected = await request.post(`/api/agent/runs/${created.runId}/resume`, { data: { conversationId: created.conversationId, sceneSelection: { baselineAssetId: "invalid-selection", region: { x: 1, y: 1, width: 2, height: 2 } } } });
        expect(rejected.status()).toBe(409);
        const restoration = page
            .waitForEvent("framenavigated", (frame) => frame === page.mainFrame())
            .then(() => page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === `/api/agent/runs/${created.runId}`))
            .then((request) => request.response());
        await page.reload({ waitUntil: "domcontentloaded" });
        const restoredResponse = await restoration;
        expect(restoredResponse).not.toBeNull();
        expect(restoredResponse!.ok(), await restoredResponse!.text()).toBe(true);
        expect(((await restoredResponse!.json()) as { data: { run: PublicRun } }).data.run).toMatchObject({ id: created.runId, conversationId: created.conversationId, status: "paused" });
        await expect(page.getByText("当前渠道尚未配置可用的独立蒙版编辑方式，请联系管理员。", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-media-result")).toHaveCount(0);
        const restored = await waitForRun(request, created.runId, "paused");
        expect(restored.tasks?.[0].id).toBe(paused.tasks?.[0].id);
        expect(creates(await protocolFixtureState(request))).toBe(0);
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: settings });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

test("custom-mask-preflight:不可信自定义蒙版协议提前复核且原因刷新保留", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "真实协议否定对照在桌面执行");
    const golden = regressions.find((item) => item.caseId === "landscape-prop-add")!;
    const settings = e2eSettingsPatch();
    const model = MODEL_ROUTES.image_generation.upstreamModel;
    const reason = "当前渠道尚未配置可用的独立蒙版编辑方式，请联系管理员。";
    // The shared protocol contract rejects untrusted custom masks before asking for a selection.
    const configured = await request.patch("/api/admin/settings", {
        data: {
            ...settings,
            systemChannels: settings.systemChannels.map((channel) => ({
                ...channel,
                advancedConfig: {
                    ...channel.advancedConfig,
                    modelConfigs: { ...channel.advancedConfig.modelConfigs, [model]: { ...(channel.advancedConfig.modelConfigs[model] as Record<string, unknown>), protocol: "custom" } },
                },
            })),
        },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    try {
        await page.goto("/create", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
        await page.locator('input[type="file"][multiple]').setInputFiles({ name: "child-review-scene.png", mimeType: "image/png", buffer: await deterministicScene(golden.source!) });
        const created = await submitPrompt(page, golden.userRequest, { reusePage: true });
        pausedRunForCleanup = created;
        const paused = await waitForRun(request, created.runId, "paused");
        const taskId = paused.tasks?.[0].id;
        expect(taskId).toBeDefined();
        expect(paused.tasks).toEqual([expect.objectContaining({ id: taskId, status: "needs_review", error: reason })]);
        expect(paused.ecommerceSceneSelection).toBeUndefined();
        expectPublicWhitelist(paused);
        const children = async () => {
            const response = await request.get("/api/admin/generation-operations?type=image");
            expect(response.ok(), await response.text()).toBe(true);
            return ((await response.json()).data.items as AdminGenerationTask[]).filter((task) => task.runId === created.runId);
        };
        expect(await children()).toHaveLength(0);
        const rejected = await request.post(`/api/agent/runs/${created.runId}/resume`, { data: { conversationId: created.conversationId, sceneSelection: { baselineAssetId: "invalid-selection", region: { x: 1, y: 1, width: 2, height: 2 } } } });
        expect(rejected.status()).toBe(409);
        await expect(page.getByText(reason, { exact: true })).toBeVisible();
        const assertPersistedReason = async () => {
            const messages = await request.get(`/api/creative/conversations/${created.conversationId}/messages`);
            expect(messages.ok(), await messages.text()).toBe(true);
            const assistant = ((await messages.json()).data.messages as Array<{ runId?: string; role: string; content: string }>).find((message) => message.runId === created.runId && message.role === "assistant");
            expect(assistant?.content).toBe(reason);
            await expect(page.getByText(/上游创建状态待确认|上游创建结果待确认/)).toHaveCount(0);
            expect((await protocolFixtureState(request)).requests.filter((item) => item.method === "POST" && (/\/images\//.test(item.path) || /:generateContent$/.test(item.path)))).toHaveLength(0);
            expect(await children()).toHaveLength(0);
        };
        await assertPersistedReason();
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-media-result")).toHaveCount(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText(reason, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-media-result")).toHaveCount(0);
        expect((await waitForRun(request, created.runId, "paused")).tasks).toEqual(paused.tasks);
        await assertPersistedReason();
    } finally {
        const restored = await request.patch("/api/admin/settings", { data: settings });
        expect(restored.ok(), await restored.text()).toBe(true);
    }
});

async function deterministicScene(size: { width: number; height: number }) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#d8d3c9"/><rect x="900" y="900" width="1600" height="1000" fill="#805b3e"/><path d="M900 1233H2500M900 1566H2500" stroke="#402d20" stroke-width="12"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

function expectPublicWhitelist(run: PublicRun) {
    const serialized = JSON.stringify(run);
    for (const internal of ["ecommerceSnapshot", "ecommerceExecution", "sceneProtection", "photography", "observations", "executionPrompt", "internalReason"]) expect(serialized).not.toContain(`"${internal}"`);
    const string = expect.any(String);
    const number = expect.any(Number);
    const boolean = expect.any(Boolean);
    const array = expect.any(Array);
    const object = expect.any(Object);
    // publicAgentRun[ForRequest] and CreativeAgentRun publish result assetIds;
    // task child identities/results are internal and have no allowed DTO shape.
    const value = expectPublicObject(
        run,
        {
            id: string,
            conversationId: string,
            inputMessageId: string,
            assistantMessageId: string,
            surface: string,
            projectId: string,
            status: string,
            prompt: string,
            referencedAssetIds: array,
            selectedSkillIds: array,
            requestedModelIds: array,
            generationPreferences: object,
            assetIds: array,
            ecommerceQualityStatus: string,
            ecommerceQualityReview: object,
            ecommerceSceneSelection: object,
            ecommerceReferenceReview: object,
            canCheckStatus: boolean,
            tasks: array,
            cancellation: object,
            timings: object,
            createdAt: number,
            updatedAt: number,
        },
        ["id", "conversationId", "inputMessageId", "assistantMessageId", "surface", "status", "prompt", "assetIds", "tasks", "createdAt", "updatedAt"],
    );
    expect(["planning", "running", "paused", "completed", "failed", "cancelled"]).toContain(value.status);
    for (const key of ["assetIds", "referencedAssetIds", "selectedSkillIds", "requestedModelIds"]) for (const id of (value[key] || []) as unknown[]) expect(id).toEqual(string);
    for (const task of value.tasks as unknown[]) {
        const publicTask = expectPublicObject(
            task,
            {
                id: string,
                title: string,
                type: string,
                model: string,
                optimizedPrompt: string,
                ratio: string,
                quality: string,
                seconds: number,
                voice: string,
                format: string,
                generateAudio: boolean,
                watermark: boolean,
                speed: number,
                count: number,
                status: string,
                error: string,
            },
            ["id", "title", "type", "model", "status"],
        );
        expect(["ready", "running", "needs_review", "completed", "failed", "cancelled"]).toContain(publicTask.status);
    }
    if (value.ecommerceSceneSelection) {
        const selection = expectPublicObject(value.ecommerceSceneSelection, { action: "confirm_scene_selection", baselineAssetId: string, url: string, width: number, height: number }, ["action", "baselineAssetId", "url", "width", "height"]);
        expect(selection.url).toMatch(/^\/api\/(reference-assets|generation-log-assets)\//);
        for (const key of ["width", "height"]) {
            expect(Number.isSafeInteger(selection[key])).toBe(true);
            expect(selection[key]).toBeGreaterThan(0);
        }
    }
    if (value.ecommerceReferenceReview) {
        const review = expectPublicObject(value.ecommerceReferenceReview, { version: "ecommerce-reference-review.v1", reviewId: string, kind: string, question: string, assets: array, inheritedEditTarget: object }, [
            "version",
            "reviewId",
            "kind",
            "question",
            "assets",
        ]);
        expect(["confirm_purposes", "retry_analysis", "retry_source"]).toContain(review.kind);
        if (review.inheritedEditTarget) {
            const inherited = expectPublicObject(review.inheritedEditTarget, { assetId: string, previewUrl: string }, ["assetId", "previewUrl"]);
            expect(review.kind).toBe("confirm_purposes");
            expect(inherited.previewUrl).toMatch(/^\/api\/(reference-assets|generation-log-assets)\//);
            expect((review.assets as Array<{ assetId: string }>).some((asset) => asset.assetId === inherited.assetId)).toBe(false);
        }
        for (const item of review.assets as unknown[]) {
            const asset = expectPublicObject(item, { assetId: string, assetVersion: string, alias: string, previewUrl: string, purposes: array, allowedPurposes: array }, ["assetId", "assetVersion", "alias", "previewUrl", "purposes", "allowedPurposes"]);
            expect(asset.previewUrl).toMatch(/^\/api\/(reference-assets|generation-log-assets)\//);
        }
    }
    if (value.ecommerceQualityReview) {
        const review = expectPublicObject(value.ecommerceQualityReview, { kind: string, failureKeys: array, message: string, advisory: boolean }, ["kind", "failureKeys"]);
        expect(["hard_failure", "check_unavailable", "needs_adjustment"]).toContain(review.kind);
        for (const key of review.failureKeys as unknown[])
            expect([
                "product_identity",
                "product_silhouette",
                "product_color_material",
                "product_proportions_view",
                "brand_logo",
                "packaging_text",
                "scene_intent",
                "composition_lighting",
                "canvas_geometry",
                "protected_structure",
                "protected_material",
                "unmodified_region",
                "stored_media",
            ]).toContain(key);
    }
    if (value.cancellation) expectPublicObject(value.cancellation, { pendingCount: number }, ["pendingCount"]);
    if (value.timings)
        expectPublicObject(
            value.timings,
            Object.fromEntries(["requestAcceptedAt", "planningStartedAt", "plannerFirstByteAt", "planningCompletedAt", "firstTaskSubmittedAt", "firstResultReadyAt", "allResultsReadyAt", "reviewCompletedAt", "runCompletedAt"].map((key) => [key, number])),
            ["requestAcceptedAt"],
        );
    if (value.generationPreferences) {
        const preferences = expectPublicObject(value.generationPreferences, { mode: string, image: object, video: object, audio: object });
        if (preferences.image) expectPublicObject(preferences.image, { size: string, quality: string, count: number });
        if (preferences.video)
            expectPublicObject(preferences.video, { size: string, quality: string, seconds: number, count: number, generateAudio: boolean, watermark: boolean, referenceMode: string, firstFrameAssetId: string, lastFrameAssetId: string });
        if (preferences.audio) expectPublicObject(preferences.audio, { voice: string, format: string, speed: number });
    }
}

function expectPublicObject(value: unknown, shape: Record<string, unknown>, required: string[] = []) {
    expect(value).toBeTruthy();
    expect(typeof value).toBe("object");
    expect(Array.isArray(value)).toBe(false);
    const record = value as Record<string, unknown>;
    expect(
        Object.keys(record).filter((key) => !Object.hasOwn(shape, key)),
        "unpublished public DTO keys",
    ).toEqual([]);
    expect(Object.keys(record)).toEqual(expect.arrayContaining(required));
    for (const [key, field] of Object.entries(record)) {
        if (key === "ecommerceReferenceReview" && field === null) continue;
        expect(field, `public DTO ${key}`).toEqual(shape[key]);
    }
    return record;
}

test("public-contract:公开Run逐层拒绝未发布字段", () => {
    const run: CreativeAgentRun = {
        id: "public-contract-run",
        conversationId: "public-contract-conversation",
        inputMessageId: "public-contract-input",
        assistantMessageId: "public-contract-assistant",
        surface: "chat",
        status: "paused",
        prompt: "只加花瓶",
        createdAt: 1,
        updatedAt: 1,
        assetIds: [],
        generationPreferences: { mode: "image", image: { size: "100x80", quality: "high", count: 1 } },
        tasks: [{ id: "public-contract-task", title: "生成图片", type: "image", model: "fixture-image", status: "needs_review" }],
        ecommerceSceneSelection: { action: "confirm_scene_selection", baselineAssetId: "public-contract-baseline", url: "/api/reference-assets/public-contract.png", width: 100, height: 80 },
        ecommerceQualityReview: { kind: "hard_failure", failureKeys: ["protected_structure"] },
    };
    expectPublicWhitelist(run);
    for (const extra of [{ plannerContext: {} }, { results: [] }, { childTasks: [] }]) expect(() => expectPublicWhitelist({ ...run, ...extra })).toThrow();
    expect(() => expectPublicWhitelist({ ...run, tasks: [{ ...run.tasks[0], childTasks: [] }] } as PublicRun)).toThrow();
    expect(() => expectPublicWhitelist({ ...run, tasks: [{ ...run.tasks[0], results: [] }] } as PublicRun)).toThrow();
    expect(() => expectPublicWhitelist({ ...run, ecommerceSceneSelection: { ...run.ecommerceSceneSelection!, confirmation: {} } } as PublicRun)).toThrow();
    expect(() => expectPublicWhitelist({ ...run, generationPreferences: { image: { providerRequest: {} } } } as PublicRun)).toThrow();
    expect(() => expectPublicWhitelist({ ...run, ecommerceQualityReview: { ...run.ecommerceQualityReview!, observations: {} } } as PublicRun)).toThrow();
});

function expectLatestTraceVersions(trace: EcommerceTrace) {
    expect(traceStage(trace, "visual_analysis").output.analysisVersion).toBe("ecommerce-visual-analysis.v4");
    expect(traceStage(trace, "edit_planning").output).toMatchObject({ planVersion: "ecommerce-edit.v6", visibleStructure: expect.any(Array) });
    expect(traceStage(trace, "image_generation").output.compilerVersion).toBe("ecommerce-openai-image-2.5.v4");
    expect(traceStage(trace, "image_generation").output.photography).toEqual(traceStage(trace, "edit_planning").output.photography);
    expect(traceStage(trace, "quality_check").output.version).toBe("ecommerce-quality.v2");
}

test("white-product-style-reference:可选场景参考仍以商品为锚点并在刷新后恢复结果", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "连续性回归只在桌面 Chromium 执行");
    const goldenCase = cases[5];
    const created = await submitProductScene(page, goldenCase, {
        sceneReference: true,
    });
    const run = await waitForRun(request, created.runId, "completed");
    const trace = await expectAdminTrace(request, run.id, "passed");
    expectSuccessfulTrace(trace, {
        operation: goldenCase.expectedOperation,
        hardProtections: goldenCase.hardProtections,
        userRequest: goldenCase.userRequest,
        sceneReferenceCount: 1,
    });
    const visualStage = traceStage(trace, "visual_analysis");
    const planningStage = traceStage(trace, "edit_planning");
    const productReference = visualStage.output.references?.find((reference) => reference.contentType === "isolated_product");
    const sceneReference = visualStage.output.references?.find((reference) => reference.contentType === "interior_scene");
    expect(productReference).toBeDefined();
    expect(sceneReference).toBeDefined();
    expect(productReference?.assetId).not.toBe(sceneReference?.assetId);
    expect(planningStage.output.source).toMatchObject({
        productAnchorId: productReference?.assetId,
        sceneReferenceIds: [sceneReference?.assetId],
    });
    await expectProductResult(page);
    const resultSource = await page.getByTestId("creative-media-result").last().getByRole("img").getAttribute("src");
    expect(resultSource).toMatch(/^\/api\/generation-log-assets\/permanent\/.+\.png(?:\?.*)?$/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByTestId("creative-media-result").last().getByRole("img")).toHaveAttribute("src", resultSource!);
    expect(run.assetIds?.length).toBeGreaterThan(0);
});

test("historical-branch:连续编辑默认继承最近结果并可从较早结果建立分支", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "连续性回归只在桌面 Chromium 执行");
    const first = await submitProductScene(page, cases[0]);
    const firstRun = await waitForRun(request, first.runId, "completed");
    const firstTrace = await expectAdminTrace(request, firstRun.id, "passed");
    expectSuccessfulTrace(firstTrace, {
        operation: cases[0].expectedOperation,
        hardProtections: cases[0].hardProtections,
        userRequest: cases[0].userRequest,
    });
    const originalProductAnchorId = traceStage(firstTrace, "edit_planning").output.source?.productAnchorId;
    expect(originalProductAnchorId).toBeTruthy();
    await expectProductResult(page);

    const secondPrompt = "让场景光线再亮一点。";
    const second = await submitPrompt(page, secondPrompt, { reusePage: true });
    const secondRun = await waitForRun(request, second.runId, "completed");
    const secondTrace = await expectAdminTrace(request, secondRun.id, "passed");
    expectSuccessfulTrace(secondTrace, {
        operation: "local_edit",
        hardProtections: cases[0].hardProtections,
        userRequest: secondPrompt,
    });
    expect(traceStage(secondTrace, "edit_planning").output).toMatchObject({
        operation: "local_edit",
        source: {
            productAnchorId: originalProductAnchorId,
            currentSceneBaselineId: firstRun.assetIds?.[0],
        },
        continuity: { parentResultId: firstRun.assetIds?.[0] },
    });
    expect(secondRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);

    const roundActionButtons = page.getByRole("button", {
        name: "更多本轮创作操作",
    });
    await expect(roundActionButtons).toHaveCount(2);
    await roundActionButtons.first().click();
    await page.getByRole("menuitem", { name: "引用结果" }).click();
    const branchPrompt = "从这张较早结果把背景改成现代厨房。";
    const branch = await submitPrompt(page, branchPrompt, { reusePage: true });
    const branchRun = await waitForRun(request, branch.runId, "completed");
    const branchTrace = await expectAdminTrace(request, branchRun.id, "passed");
    expectSuccessfulTrace(branchTrace, {
        operation: "local_edit",
        hardProtections: cases[0].hardProtections,
        userRequest: branchPrompt,
    });
    expect(traceStage(branchTrace, "edit_planning").output).toMatchObject({
        operation: "local_edit",
        source: {
            productAnchorId: originalProductAnchorId,
            currentSceneBaselineId: firstRun.assetIds?.[0],
        },
        continuity: { parentResultId: firstRun.assetIds?.[0] },
    });
    expect(branchRun.assetIds?.[0]).not.toBe(firstRun.assetIds?.[0]);
    expect(branchRun.assetIds?.[0]).not.toBe(secondRun.assetIds?.[0]);

    const assets = await conversationAssets(request, branchRun.conversationId);
    const branchAsset = assets.find((asset) => asset.id === branchRun.assetIds?.[0]);
    expect(branchAsset?.metadata?.ecommerceContinuity).toMatchObject({
        parentResultId: firstRun.assetIds?.[0],
    });
    expect(assets.map((asset) => asset.id)).toEqual(expect.arrayContaining([firstRun.assetIds?.[0], secondRun.assetIds?.[0], branchRun.assetIds?.[0]]));
});

test("角色歧义会暂停并且不会提交图片 provider", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const ambiguous = {
        ...cases[0],
        productFileName: "ambiguous-reference.webp",
        userRequest: "根据这张无法判断角色的图片生成一个家居场景。",
    };
    const created = await submitProductScene(page, ambiguous);
    pausedRunForCleanup = created;
    const waiting = await waitForRun(request, created.runId, "paused");
    expect(waiting.ecommerceReferenceReview?.kind).toBe("retry_analysis");
    expectPublicWhitelist(waiting);
    const panel = page.getByTestId("creative-reference-review");
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-review-id", waiting.ecommerceReferenceReview!.reviewId);
    await expect(page.getByText("当前参考图片缺少可用于确定完整用途的视觉线索，可重新分析后继续这次创作。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重新分析", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "确认用途并继续", exact: true })).toHaveCount(0);
    const state = await protocolFixtureState(request);
    expect(state.requests.some((item) => item.path.endsWith("/images/edits") || item.path.endsWith("/images/generations"))).toBe(false);
});

test("可选视觉轮廓建议保留已交付结果与连续编辑入口", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "异常路径回归只在桌面 Chromium 执行");
    const strictFailure = {
        ...cases[0],
        userRequest: "生成现代客厅场景，保持商品不变。[qa-silhouette-failure]",
    };
    const created = await submitProductScene(page, strictFailure);
    const run = await waitForRun(request, created.runId, "completed");
    const trace = await expectAdminTrace(request, run.id, "blocked");
    expect(run.assetIds).toHaveLength(1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "参考建议", exact: true })).toBeVisible();
    await expect(page.getByTestId("creative-media-result")).toHaveCount(1);
    await expect(page.getByRole("list", { name: "未通过项" }).getByRole("listitem").filter({ hasText: "商品轮廓与原图不一致" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重新生成未通过的商品图", exact: true })).toHaveCount(0);
    expectTraceRoutes(trace);
    expect(traceStage(trace, "image_generation").status).toBe("completed");
    const qualityStage = traceStage(trace, "quality_check");
    expect(qualityStage.status).toBe("blocked");
    expect(qualityStage.output.hardFailures).toEqual(expect.arrayContaining([expect.objectContaining({ key: "product_silhouette", status: "failed" })]));
    expect(trace.finalStatus).toBe("completed");
    const state = await protocolFixtureState(request);
    expect(state.requests.filter((item) => item.method === "POST" && (item.path.endsWith("/images/edits") || item.path.endsWith("/images/generations")))).toHaveLength(1);
    expect(state.requests.filter((item) => item.method === "POST" && item.model === MODEL_ROUTES.quality_check.upstreamModel)).toHaveLength(1);
    const assets = await conversationAssets(request, run.conversationId);
    expect(assets).toHaveLength(2);
    const uploadedProduct = assets.find((asset) => asset.metadata?.source === "upload");
    expect(uploadedProduct).toMatchObject({
        type: "image",
        metadata: { source: "upload" },
    });
    const internalResult = assets.find((asset) => asset.sourceRunId === run.id);
    expect(internalResult).toMatchObject({
        type: "image",
        status: "ready",
    });
    expect(internalResult?.sourceTaskId).toBeTruthy();
    expect(run.assetIds).toContain(internalResult?.id);
    const overviewResponse = await request.get("/api/create/overview");
    expect(overviewResponse.ok()).toBe(true);
    const overview = (await overviewResponse.json()) as { data: { overview: { recentAssets: Array<{ url: string }> } } };
    expect(overview.data.overview.recentAssets.some((asset) => asset.url === internalResult?.serverUrl || asset.url === internalResult?.remoteUrl)).toBe(true);
});

test("移动端可完成一句话商品场景生成且没有横向溢出", async ({ page, request }, testInfo) => {
    test.skip(!["mobile-390", "mobile-430"].includes(testInfo.project.name), "移动端专项");
    const created = await submitProductScene(page, cases[6]);
    await waitForRun(request, created.runId, "completed");
    await expectProductResult(page);
    await expectNoHorizontalOverflow(page, `ecommerce product generation ${testInfo.project.name}`);
});

test("paused-observer:暂停进度保留同一订阅且确认后继续原任务", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "真实 React effect 与受控 HTTP/SSE 边界回归");
    await page.addInitScript(() => {
        const sources: ControlledEventSource[] = [];
        class ControlledEventSource extends EventTarget {
            closed = false;
            onerror: (() => void) | null = null;
            onopen: (() => void) | null = null;
            constructor(readonly url: string) {
                super();
                sources.push(this);
            }
            close() {
                this.closed = true;
            }
            emit(type: string, data: unknown) {
                if (!this.closed) this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
            }
        }
        Object.assign(window, { __ecommerceRunEvents: { sources } });
        Object.defineProperty(window, "EventSource", { value: ControlledEventSource });
    });
    const fixture = await mockPublicEcommerceRound(page, "selection", true);
    const selection = fixture.run.ecommerceSceneSelection!;
    fixture.run.status = "running";
    fixture.run.tasks[0].status = "running";
    delete fixture.run.ecommerceSceneSelection;
    await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
    const observer = () => page.evaluate(() => (window as unknown as RunEventWindow).__ecommerceRunEvents.sources.map(({ url, closed }) => ({ url, closed })));
    await expect.poll(observer).toEqual([{ url: `/api/agent/runs/${fixture.runId}/events`, closed: false }]);
    const initialReads = fixture.statusReads();
    fixture.run.status = "paused";
    fixture.run.tasks[0].status = "needs_review";
    fixture.run.ecommerceSceneSelection = selection;
    await page.evaluate((run) => {
        const source = (window as unknown as RunEventWindow).__ecommerceRunEvents.sources.at(-1)!;
        source.emit("task.needs_review", { data: { error: "请确认需要修改的位置" } });
        source.emit("run.snapshot", run);
    }, fixture.run);
    await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toBeVisible();
    await page.getByRole("textbox").fill("同一任务已暂停，等待确认");
    await flushRunEventRendering(page);
    expect(await observer()).toEqual([{ url: `/api/agent/runs/${fixture.runId}/events`, closed: false }]);
    expect(fixture.statusReads() - initialReads).toBe(1);
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("creative-generation-elapsed")).toHaveCount(0);

    await page.evaluate((run) => {
        const source = (window as unknown as RunEventWindow).__ecommerceRunEvents.sources.at(-1)!;
        source.emit("run.snapshot", run);
        source.onerror?.();
    }, fixture.run);
    await expect.poll(() => fixture.statusReads() - initialReads).toBe(2);
    await page.evaluate(() => (window as unknown as RunEventWindow).__ecommerceRunEvents.sources.at(-1)!.onopen?.());
    await flushRunEventRendering(page);
    expect(await observer()).toEqual([{ url: `/api/agent/runs/${fixture.runId}/events`, closed: false }]);
    expect(fixture.statusReads() - initialReads).toBe(2);
    await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
    await dragSceneSelection(page);
    await page
        .getByTestId("creative-scene-selection")
        .getByRole("button", { name: /确认修改位置$/ })
        .click();
    await expect.poll(() => fixture.controls.length).toBe(1);
    expect(fixture.controls[0]).toEqual({ conversationId: fixture.conversationId, sceneSelection: { baselineAssetId: selection.baselineAssetId, region: { x: 251, y: 125, width: 752, height: 377 } } });
    fixture.releaseResume();
    await expect.poll(observer).toEqual([
        { url: `/api/agent/runs/${fixture.runId}/events`, closed: true },
        { url: `/api/agent/runs/${fixture.runId}/events`, closed: false },
    ]);
    await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
    fixture.run.status = "completed";
    fixture.run.tasks[0].status = "completed";
    await page.evaluate(() => (window as unknown as RunEventWindow).__ecommerceRunEvents.sources.at(-1)!.emit("run.completed", { data: { reply: "原任务已完成" } }));
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
    expect((await observer()).every((source) => source.closed)).toBe(true);
    expect(fixture.createdRuns()).toBe(0);
    expect(fixture.controls).toHaveLength(1);
});

type RunEventWindow = Window & {
    __ecommerceRunEvents: { sources: Array<{ url: string; closed: boolean; emit: (type: string, data: unknown) => void; onerror: (() => void) | null; onopen: (() => void) | null }> };
};

async function flushRunEventRendering(page: Page) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("selection-large-preview:待确认直接显示完整图片并在大图保留原像素选区", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "桌面大图框选专项");
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await mockPublicEcommerceRound(page, "selection");
    await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
    const preview = page.getByRole("img", { name: "待修改的原图", exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(418);
    const small = await preview.boundingBox();
    if (!small) throw new Error("Inline selection preview has no browser geometry");
    expect(small.width / small.height).toBeCloseTo(2, 2);
    await expect(page.getByRole("dialog", { name: "选择修改位置", exact: true })).toHaveCount(0);
    await preview.click();
    const dialog = page.getByRole("dialog", { name: "选择修改位置", exact: true });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole("img", { name: "选择修改位置的原图", exact: true });
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(418);
    const large = await sceneSelectionImageGeometry(page);
    expect(large.width).toBeGreaterThan(small.width * 1.6);
    expect(large.width / large.height).toBeCloseTo(2, 2);
    expect(large.x).toBeGreaterThanOrEqual(0);
    expect(large.y).toBeGreaterThanOrEqual(0);
    expect(large.x + large.width).toBeLessThanOrEqual(1440);
    expect(large.y + large.height).toBeLessThanOrEqual(900);
    const confirm = dialog.getByRole("button", { name: /确认修改位置$/ });
    await expect(confirm).toBeDisabled();
    await dragSceneSelection(page);
    await expect(confirm).toBeEnabled();
    const selected = dialog.getByTestId("creative-scene-selection-region");
    const expectedOverlay = await selected.getAttribute("style");
    await dialog.getByRole("button", { name: "关闭大图", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("creative-scene-selection-preview").getByTestId("creative-scene-selection-region")).toHaveAttribute("style", expectedOverlay!);
    expect(fixture.controls).toHaveLength(0);
    await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(selected).toHaveAttribute("style", expectedOverlay!);
    await expect(confirm).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("creative-scene-selection-preview").getByTestId("creative-scene-selection-region")).toHaveAttribute("style", expectedOverlay!);
    expect(fixture.controls).toHaveLength(0);
    await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(selected).toHaveAttribute("style", expectedOverlay!);
    await testInfo.attach("selection-large-preview", { body: await page.screenshot(), contentType: "image/png" });
    await confirm.dblclick();
    await expect(confirm).toBeDisabled();
    await expect.poll(() => fixture.controls.length).toBe(1);
    expect(fixture.controls[0]).toEqual({ conversationId: fixture.conversationId, sceneSelection: { baselineAssetId: "task16-baseline", region: { x: 251, y: 125, width: 752, height: 377 } } });
    fixture.releaseResume();
    await expect(dialog).toHaveCount(0);
    expect(fixture.createdRuns()).toBe(0);
    expect(fixture.controls).toHaveLength(1);
});

for (const theme of ["light", "dark"] as const) {
    test(`待选区同一任务可取消、刷新恢复并按原图像素确认-${theme}`, async ({ page }, testInfo) => {
        test.skip(!["chromium", "mobile-390", "mobile-430"].includes(testInfo.project.name), "桌面与390/430专项");
        await page.addInitScript((value) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
        const fixture = await mockPublicEcommerceRound(page, "selection");
        await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-generation-elapsed")).toHaveCount(0);
        await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
        const confirm = page.getByTestId("creative-scene-selection").getByRole("button", { name: /确认修改位置$/ });
        await expect(confirm).toBeDisabled();
        await dragSceneSelection(page);
        await expect(confirm).toBeEnabled();
        await page.getByRole("button", { name: "取消选择", exact: true }).click();
        expect(fixture.controls).toHaveLength(0);
        await expect(page.getByRole("dialog", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await expect(page.getByTestId("creative-scene-selection-preview").getByTestId("creative-scene-selection-region")).toHaveCount(0);
        await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
        await expect(confirm).toBeDisabled();
        await expect(page.getByTestId("creative-scene-selection").getByTestId("creative-scene-selection-region")).toHaveCount(0);
        await page.getByRole("button", { name: "关闭大图", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
        await expect(confirm).toBeDisabled();
        await page.goto(`/create?conversationId=${fixture.otherConversationId}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByText("另一个对话自己的消息", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
        await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "选择修改位置", exact: true }).click();
        await expect(confirm).toBeDisabled();
        await dragSceneSelection(page);
        await expectNoHorizontalOverflow(page, `scene selection ${theme} ${testInfo.project.name}`);
        await testInfo.attach(`scene-selection-${theme}-${testInfo.project.name}`, { body: await page.screenshot(), contentType: "image/png" });
        await confirm.dblclick();
        await expect(confirm).toBeDisabled();
        await expect.poll(() => fixture.controls.length).toBe(1);
        expect(fixture.controls[0]).toEqual({ conversationId: fixture.conversationId, sceneSelection: { baselineAssetId: "task16-baseline", region: { x: 251, y: 125, width: 752, height: 377 } } });
        fixture.releaseResume();
        await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
        expect(fixture.createdRuns()).toBe(0);
        expect(fixture.controls).toHaveLength(1);
    });

    test(`验收公开状态刷新和切换对话保持可读-${theme}`, async ({ page }, testInfo) => {
        test.skip(!["chromium", "mobile-390", "mobile-430"].includes(testInfo.project.name), "桌面与390/430专项");
        await page.addInitScript((value) => localStorage.setItem("vozeb-pro:theme_store", JSON.stringify({ state: { theme: value }, version: 0 })), theme);
        for (const quality of ["soft", "hard", "unavailable"] as const) {
            const fixture = await mockPublicEcommerceRound(page, quality);
            await page.goto(`/create?conversationId=${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
            const label = quality === "soft" ? "需要调整" : "待复核";
            await expect(page.getByRole("heading", { name: label, exact: true, level: 3 })).toBeVisible();
            await expect(page.getByTestId("creative-media-result")).toHaveCount(quality === "soft" ? 1 : 0);
            await expect(page.getByRole("button", { name: "选择修改位置", exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "重新生成未通过的商品图", exact: true })).toHaveCount(0);
            await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
            if (quality === "hard") await expect(page.getByText("画幅与要求不一致：要求 1024×1024，上游原图 1254×1254。", { exact: true })).toBeVisible();
            await expectNoHorizontalOverflow(page, `${quality} ${theme} ${testInfo.project.name}`);
            await testInfo.attach(`quality-${quality}-${theme}-${testInfo.project.name}`, { body: await page.screenshot(), contentType: "image/png" });
            await page.reload({ waitUntil: "domcontentloaded" });
            await expect(page.getByRole("heading", { name: label, exact: true, level: 3 })).toBeVisible();
            await page.goto(`/create?conversationId=${fixture.otherConversationId}`, { waitUntil: "domcontentloaded" });
            await expect(page.getByText("另一个对话自己的消息", { exact: true })).toBeVisible();
            await expect(page.getByRole("heading", { name: label, exact: true, level: 3 })).toHaveCount(0);
            expect(fixture.controls).toHaveLength(0);
            expect(fixture.createdRuns()).toBe(0);
        }
    });
}

async function sceneSelectionImageGeometry(page: Page) {
    const image = page.getByRole("img", { name: "选择修改位置的原图", exact: true });
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(418);
    await image.scrollIntoViewIfNeeded();
    let previous: Awaited<ReturnType<typeof image.boundingBox>> = null;
    let stableSamples = 0;
    // Modal motion can start after its first visible frame; wait for stable geometry.
    await expect
        .poll(
            async () => {
                const box = await image.boundingBox();
                stableSamples = box && previous && (["x", "y", "width", "height"] as const).every((key) => Math.abs(box[key] - previous![key]) < 0.5) ? stableSamples + 1 : 0;
                previous = box;
                return stableSamples;
            },
            { intervals: [100, 100, 100] },
        )
        .toBeGreaterThanOrEqual(2);
    if (!previous) throw new Error("Selection image has no stable browser geometry");
    return previous;
}

async function dragSceneSelection(page: Page) {
    const box = await sceneSelectionImageGeometry(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await page.mouse.up();
}

async function mockPublicEcommerceRound(page: Page, state: "selection" | "soft" | "hard" | "unavailable", runningMessage = false) {
    const conversationId = `task16-${state}`;
    const otherConversationId = `${conversationId}-other`;
    const timestamp = Date.now();
    const conversation = (id: string) => ({
        id,
        userId: "fixture-user",
        surface: "chat",
        source: "agent",
        title: id,
        status: "active",
        contextSummary: "",
        contextSummaryThroughSequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: timestamp,
    });
    const run: CreativeAgentRun = {
        id: `task16-run-${state}`,
        conversationId,
        inputMessageId: "task16-input",
        assistantMessageId: "task16-assistant",
        status: state === "soft" ? "completed" : "paused",
        surface: "chat",
        prompt: "保持原图，只调整场景",
        generationPreferences: { mode: "image" },
        createdAt: timestamp,
        updatedAt: timestamp,
        assetIds: state === "soft" ? ["task16-preview"] : [],
        tasks: [{ id: "task16-task", title: "生成图片", type: "image", model: "fixture-image", status: state === "soft" ? "completed" : "needs_review" }],
        ...(state === "selection"
            ? { ecommerceSceneSelection: { action: "confirm_scene_selection", baselineAssetId: "task16-baseline", url: "/api/reference-assets/task16-baseline.png", width: 1254, height: 627 } }
            : {
                  ecommerceQualityStatus: state === "soft" ? "needs_adjustment" : "needs_review",
                  ecommerceQualityReview: {
                      kind: state === "soft" ? "needs_adjustment" : state === "hard" ? "hard_failure" : "check_unavailable",
                      failureKeys: state === "hard" ? ["canvas_geometry"] : state === "soft" ? ["composition_lighting"] : [],
                      ...(state === "hard" ? { message: "画幅与要求不一致：要求 1024×1024，上游原图 1254×1254。" } : {}),
                  },
              }),
    };
    const controls: Array<{ conversationId: string; sceneSelection?: CreativeSceneSelection }> = [];
    let created = 0;
    let statusReads = 0;
    let releaseResume = () => {};
    const resumeRelease = new Promise<void>((resolve) => {
        releaseResume = resolve;
    });
    const preview = await sharp({ create: { width: 418, height: 209, channels: 3, background: "#899d8e" } })
        .webp()
        .toBuffer();
    await page.route(/\/api\/reference-assets\/task16-baseline\.png(?:\?.*)?$/, (route) => route.fulfill({ body: preview, contentType: "image/webp" }));
    await page.route(/\/api\/creative\/conversations(?:\?.*)?$/, (route) => route.fulfill({ json: { code: 0, data: { conversations: [conversation(conversationId), conversation(otherConversationId)], hasMore: false }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${conversationId}(?:-other)?$`), (route) => route.fulfill({ json: { code: 0, data: { conversation: conversation(new URL(route.request().url()).pathname.split("/").at(-1)!) }, msg: "OK" } }));
    await page.route(new RegExp(`/api/creative/conversations/${conversationId}(?:-other)?/messages(?:\\?.*)?$`), (route) => {
        const other = new URL(route.request().url()).pathname.includes(`${otherConversationId}/`);
        const messages = [
            {
                id: run.inputMessageId,
                conversationId: other ? otherConversationId : conversationId,
                ...(other ? {} : { runId: run.id }),
                sequence: 1,
                role: "user",
                status: "completed",
                content: other ? "另一个对话自己的消息" : run.prompt,
                metadata: {},
                createdAt: timestamp,
                updatedAt: timestamp,
            },
            {
                id: run.assistantMessageId,
                conversationId,
                runId: run.id,
                sequence: 2,
                role: "assistant",
                status: runningMessage && !["completed", "failed", "cancelled"].includes(run.status) ? "running" : "completed",
                content: "本次任务进度已保存",
                metadata: {},
                createdAt: timestamp,
                updatedAt: timestamp,
            },
        ];
        return route.fulfill({ json: { code: 0, data: { messages: other ? messages.slice(0, 1) : messages }, msg: "OK" } });
    });
    const assets =
        state === "soft"
            ? [
                  {
                      id: "task16-preview",
                      userId: "fixture-user",
                      conversationId,
                      sourceRunId: run.id,
                      sourceTaskId: "task16-task",
                      ordinal: 1,
                      type: "image",
                      status: "ready",
                      title: "待调整预览",
                      serverUrl: "/api/reference-assets/task16-baseline.png",
                      width: 1254,
                      height: 627,
                      metadata: {},
                      createdAt: timestamp,
                      updatedAt: timestamp,
                  },
              ]
            : [];
    await page.route(new RegExp(`/api/creative/conversations/${conversationId}(?:-other)?/assets$`), (route) => route.fulfill({ json: { code: 0, data: { assets: route.request().url().includes(`${otherConversationId}/`) ? [] : assets }, msg: "OK" } }));
    await page.route(new RegExp(`/api/agent/runs/${run.id}$`), (route) => {
        statusReads += 1;
        return route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
    });
    await page.route(/\/api\/agent\/runs(?:\?.*)?$/, (route) => {
        if (route.request().method() === "POST") created += 1;
        return route.fulfill({ json: { code: 0, data: { runs: [] }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/agent/runs/${run.id}/resume$`), async (route) => {
        controls.push(route.request().postDataJSON());
        await resumeRelease;
        run.status = "running";
        delete run.ecommerceSceneSelection;
        await route.fulfill({ json: { code: 0, data: { run }, msg: "OK" } });
    });
    await page.route(new RegExp(`/api/agent/runs/${run.id}/events$`), (route) => route.fulfill({ contentType: "text/event-stream", body: `event: run.snapshot\ndata: ${JSON.stringify({ ...run, status: "running" })}\n\n` }));
    return { conversationId, otherConversationId, runId: run.id, run, controls, releaseResume: () => releaseResume(), createdRuns: () => created, statusReads: () => statusReads };
}

async function submitProductScene(page: Page, goldenCase: GoldenCase, options: { sceneReference?: boolean } = {}) {
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".creative-composer")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await selectImageMode(page);
    const product = uploadFixture(goldenCase.fixturePath, goldenCase.productFileName, goldenCase.fixtureSha256);
    let files = [product];
    if (options.sceneReference) {
        if (!goldenCase.sceneFixturePath || !goldenCase.sceneFixtureSha256) throw new Error(`${goldenCase.id} is missing its scene fixture path or SHA-256`);
        files = [product, uploadFixture(goldenCase.sceneFixturePath, "modern-living-room.webp", goldenCase.sceneFixtureSha256)];
    }
    await page.locator('input[type="file"][multiple]').setInputFiles(files);
    for (const file of files)
        await expect(page.getByLabel(`已上传图片 ${file.name}`)).toBeVisible({
            timeout: 30_000,
        });
    return submitPrompt(page, goldenCase.userRequest, { reusePage: true });
}

async function submitPrompt(page: Page, prompt: string, options: { reusePage?: boolean } = {}) {
    if (!options.reusePage) await page.goto("/create", { waitUntil: "domcontentloaded" });
    const textbox = page.getByRole("textbox", {
        name: "描述你想生成或修改的图片",
    });
    await textbox.fill(prompt);
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/runs");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBe(true);
    const payload = (await response.json()) as { data: { run: PublicRun } };
    return {
        runId: payload.data.run.id,
        conversationId: payload.data.run.conversationId,
    };
}

async function selectImageMode(page: Page) {
    await expect(page.getByRole("button", { name: /当前创作类型：/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /生成模型：/ })).toBeVisible();
}

function uploadFixture(relativePath: string, name: string, expectedSha256: string) {
    let fixture = fixtureBytes.get(relativePath);
    if (!fixture) {
        const buffer = readFileSync(new URL(relativePath, import.meta.url));
        fixture = {
            buffer,
            sha256: createHash("sha256").update(buffer).digest("hex"),
        };
        fixtureBytes.set(relativePath, fixture);
    }
    if (fixture.sha256 !== expectedSha256.toLowerCase()) {
        throw new Error(`Fixture SHA-256 mismatch for ${relativePath}: expected ${expectedSha256}, received ${fixture.sha256}`);
    }
    return {
        name,
        mimeType: fixtureMimeType(relativePath),
        buffer: fixture.buffer,
    };
}

function fixtureMimeType(relativePath: string) {
    const extension = extname(relativePath).toLowerCase();
    if (extension === ".webp") return "image/webp";
    if (extension === ".png") return "image/png";
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    throw new Error(`Unsupported ecommerce fixture extension: ${extension || "(none)"}`);
}

async function waitForRun(request: APIRequestContext, runId: string, expectedStatus: "completed" | "paused") {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const response = await request.get(`/api/agent/runs/${runId}`);
        expect(response.ok(), await response.text()).toBe(true);
        const run = ((await response.json()) as { data: { run: PublicRun } }).data.run;
        if (run.status === expectedStatus) return run;
        if (["failed", "cancelled"].includes(run.status)) throw new Error(`Agent run ${runId} ended as ${run.status}: ${run.failure || "no failure detail"}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Agent run ${runId} did not reach ${expectedStatus} within 90000ms`);
}

async function expectProductResult(page: Page) {
    const result = page.getByTestId("creative-media-result").last();
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.getByTestId("creative-primary-result").getByRole("img")).toHaveAttribute("src", /\/api\/generation-log-assets\/permanent\/.+\.png/);
}

async function expectPublicProgress(request: APIRequestContext, runId: string) {
    const response = await request.get(`/api/agent/runs/${runId}/events`, {
        headers: { "Last-Event-ID": "0" },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.text();
    expect(body).toContain("正在识别商品");
    expect(body).toContain("正在规划场景");
    expect(body).toContain("正在生成图片");
    expect(body).not.toContain("ecommerceSnapshot");
}

async function expectAdminTrace(request: APIRequestContext, runId: string, qualityStatus: EcommerceQualityCheck["status"] | "not_run") {
    let matchedTrace: EcommerceTrace | undefined;
    await expect
        .poll(
            async () => {
                const response = await request.get("/api/admin/generation-logs?page=1&pageSize=100");
                if (!response.ok()) return null;
                const payload = (await response.json()) as {
                    logs: Array<{ ecommerceTrace?: EcommerceTrace }>;
                };
                matchedTrace = payload.logs.find((log) => log.ecommerceTrace?.runId === runId)?.ecommerceTrace;
                if (qualityStatus !== "not_run" && matchedTrace && traceStage(matchedTrace, "quality_check").status === "not_run") {
                    // This isolated fixture has no resident worker; process the real durable queue.
                    const advanced = await request.post("/api/maintenance/generation-tasks/run", { headers: { authorization: "Bearer vozeb-pro-e2e-worker-token-separate-32chars", "x-vozeb-pro-worker-id": "e2e-optional-visual-quality" } });
                    expect(advanced.ok()).toBe(true);
                }
                return matchedTrace || null;
            },
            { timeout: 30_000 },
        )
        .toMatchObject({
            runId,
            finalStatus: "completed",
            stages: expect.arrayContaining([
                expect.objectContaining({ key: "visual_analysis" }),
                expect.objectContaining({ key: "edit_planning" }),
                expect.objectContaining({ key: "image_generation" }),
                expect.objectContaining({ key: "quality_check", status: qualityStatus }),
            ]),
        });
    if (!matchedTrace) throw new Error(`Ecommerce trace for run ${runId} disappeared after polling`);
    const current = (await request.get(`/api/agent/runs/${runId}`).then((response) => response.json())).data.run as CreativeAgentRun;
    expect(current.status).toBe("completed");
    if (qualityStatus === "not_run") {
        expect(current.ecommerceQualityStatus).toBeUndefined();
        expect(current.ecommerceQualityReview).toBeUndefined();
    } else {
        expect(current.ecommerceQualityStatus).toBe(qualityStatus === "passed" ? "passed" : "needs_adjustment");
        if (qualityStatus !== "passed") expect(current.ecommerceQualityReview?.advisory).toBe(true);
    }
    return matchedTrace;
}

function expectSuccessfulTrace(
    trace: EcommerceTrace,
    expected: {
        operation: string;
        hardProtections: string[];
        userRequest: string;
        sceneReferenceCount?: number;
    },
) {
    expectTraceRoutes(trace);
    expectLatestTraceVersions(trace);
    expect(trace.finalStatus).toBe("completed");
    expect(trace.imageTaskIds).toHaveLength(1);

    const planningStage = traceStage(trace, "edit_planning");
    expect(planningStage.status).toBe("completed");
    expect(planningStage.output.operation).toBe(expected.operation);
    expect(planningStage.output.preserve?.productCore).toEqual(expected.hardProtections);

    const source = planningStage.output.source;
    expect(source?.productAnchorId).toBeTruthy();
    expect(source?.sceneReferenceIds ?? []).toHaveLength(expected.sceneReferenceCount ?? 0);
    const expectedReferences: TraceReference[] = [];
    if (expected.operation === "local_edit" && source?.currentSceneBaselineId)
        expectedReferences.push({
            assetId: source.currentSceneBaselineId,
            role: "scene",
        });
    if (source?.productAnchorId)
        expectedReferences.push({
            assetId: source.productAnchorId,
            role: "product",
        });
    for (const assetId of source?.sceneReferenceIds ?? []) expectedReferences.push({ assetId, role: "scene" });

    const generationStage = traceStage(trace, "image_generation");
    expect(generationStage.status).toBe("completed");
    expect(generationStage.output.executionPrompt).toContain(expected.userRequest);
    expect(generationStage.output.executionPrompt).toContain(expected.operation);
    for (const protection of expected.hardProtections) expect(generationStage.output.executionPrompt).toContain(protection);
    expect(generationStage.output.mask).toEqual({
        mode: "independent",
        required: true,
    });
    expect(generationStage.output.referenceRoles).toEqual(expectedReferences);
    expect(generationStage.output.imageTaskIds).toEqual(trace.imageTaskIds);
    const canvas = planningStage.output.canvas;
    expect(canvas).toMatchObject({ mode: expected.operation === "product_to_scene" ? "ratio" : "exact", source: "baseline" });
    expect(generationStage.output.canvas).toEqual(canvas);

    const qualityStage = traceStage(trace, "quality_check");
    expect(qualityStage.status).toBe("passed");
    const checks = qualityStage.output.checks ?? [];
    expect(checks).toHaveLength(QUALITY_CHECKS.length + 1);
    expect(checks.map((check) => check.key).sort()).toEqual([...QUALITY_CHECKS, "canvas_geometry"].sort());
    const resultId = `${trace.imageTaskIds[0]}:1`;
    for (const check of checks) {
        expect(check.resultId).toBe(resultId);
        expect(check.reason).not.toBe("");
        expect(check.status).toBe(["brand_logo", "packaging_text", "unmodified_region"].includes(check.key) ? "not_applicable" : "passed");
    }
    expect(qualityStage.output.hardFailures).toEqual([]);
    const canvasEvidence = qualityStage.output.canvasEvidence ?? [];
    expect(canvasEvidence).toHaveLength(1);
    const evidence = canvasEvidence[0];
    expect(evidence).toMatchObject({ resultId, constraint: canvas, nativeMatches: true, storedMatches: true, normalization: "none", hardFailures: [] });
    expect(evidence.nativeUrl).toMatch(/^\/api\/generation-log-assets\/permanent\//);
    expect(evidence.storedUrl).toMatch(/^\/api\/generation-log-assets\/permanent\//);
    for (const size of [evidence.nativeSize, evidence.storedSize]) {
        expect(Number.isSafeInteger(size.width) && size.width > 0).toBe(true);
        expect(Number.isSafeInteger(size.height) && size.height > 0).toBe(true);
        if (canvas!.mode === "exact") expect(size).toEqual(canvas!.size);
        else expect(BigInt(size.width) * BigInt(canvas!.size.height)).toBe(BigInt(size.height) * BigInt(canvas!.size.width));
    }
    expect(checks.at(-1)?.reason).toBe(
        `native=${evidence.nativeSize.width}x${evidence.nativeSize.height};stored=${evidence.storedSize.width}x${evidence.storedSize.height};constraint=${canvas!.mode}:${canvas!.size.width}x${canvas!.size.height};normalization=none`,
    );
}

function expectTraceRoutes(trace: EcommerceTrace) {
    expect(trace.stages.map((stage) => stage.key)).toEqual(["visual_analysis", "edit_planning", "image_generation", "quality_check"]);
    for (const stage of trace.stages) expect(stage.model).toMatchObject(MODEL_ROUTES[stage.key]);
}

function traceStage(trace: EcommerceTrace, key: TraceStage["key"]) {
    const stage = trace.stages.find((candidate) => candidate.key === key);
    if (!stage) throw new Error(`Ecommerce trace for run ${trace.runId} is missing ${key}`);
    return stage;
}

async function conversationAssets(request: APIRequestContext, conversationId: string) {
    const response = await request.get(`/api/creative/conversations/${conversationId}/assets`);
    expect(response.ok(), await response.text()).toBe(true);
    const payload = (await response.json()) as {
        data: {
            assets: Array<{
                id: string;
                type?: string;
                sourceRunId?: string;
                status?: string;
                metadata?: {
                    source?: string;
                    agentTaskId?: string;
                    ecommerceContinuity?: Record<string, unknown>;
                };
            }>;
        };
    };
    return payload.data.assets;
}
