import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { buildSceneEditProtection, compositeSceneEdit } from "./ecommerce-product-regions";

import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { recordEcommerceGenerationSnapshot } from "./ecommerce-generation-snapshot";
import { buildEcommerceGenerationTrace, normalizeEcommerceGenerationTrace } from "./ecommerce-generation-trace";
import {
    ECOMMERCE_QUALITY_CHECK_KEYS,
    checkEcommerceResult,
    checkEcommerceResultWithFallback,
    checkEcommerceTechnicalResult,
    ecommerceResultDeliveryGate,
    evaluateEcommerceCanvas,
    ecommerceQualityGate,
    shouldBlockEcommerceResult,
    unavailableEcommerceQualityCheck,
    type EcommerceQualityCheckRequest,
} from "./ecommerce-quality-check";

const mocks = vi.hoisted(() => ({
    requestStructuredText: vi.fn(),
    refundUserPoints: vi.fn(async () => undefined),
}));

vi.mock("./text-planning-runtime", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./text-planning-runtime")>();
    return { ...actual, requestStructuredText: mocks.requestStructuredText };
});

vi.mock("@/lib/auth/store", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/auth/store")>();
    return { ...actual, refundUserPoints: mocks.refundUserPoints };
});

describe("ecommerce quality check", () => {
    it("delivers a real 8 x 5 pixel-grid native on the original 12 x 8 canvas with verified mapping facts", async () => {
        const { input } = await uniformLocalRequest({ width: 8, height: 5 });
        const checked = await checkEcommerceTechnicalResult(input);
        expect(checked.status).toBe("passed");
        expect(ecommerceResultDeliveryGate(checked)).toMatchObject({ action: "publish" });
        expect(checked.canvasEvidence).toEqual([
            expect.objectContaining({ nativeSize: { width: 8, height: 5 }, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, normalization: "pixel_grid_scale", mappingVerified: true, hardFailures: [] }),
        ]);
        expect(checked.sceneProtectionEvidence[0].evidence).toMatchObject({ nativeSize: { width: 8, height: 5 }, sourceSize: { width: 12, height: 8 }, normalization: "pixel_grid_scale", compositeOutsideChangedPixels: 0 });
        expect(checked.sceneProtectionEvidence[0].evidence).not.toHaveProperty("nativeOutsideChangedPixels");
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "unmodified_region", source: "protection", status: "passed" }));
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "canvas_geometry", source: "media", status: "passed" }));
        const trace = buildEcommerceGenerationTrace({ runId: "fixture-run", task: { id: "fixture-task" } as never, snapshot: { technicalCheck: checked } as never, imageTaskIds: ["fixture-child"], generationStatus: "completed", finalStatus: "completed" });
        const restored = normalizeEcommerceGenerationTrace(JSON.parse(JSON.stringify(trace)))!;
        expect(restored.stages.find((stage) => stage.key === "image_generation")?.output).toMatchObject({
            technicalCheck: { canvasEvidence: [expect.objectContaining({ nativeSize: { width: 8, height: 5 }, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, normalization: "pixel_grid_scale", mappingVerified: true })] },
        });
        expect(JSON.stringify(restored)).not.toContain("data:image/png;base64");
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it.each(["uniform_mode", "none_mode", "native_digest", "replacement_native_rehashed", "replacement_composite_rehashed", "wrong_ratio_native", "missing_mask", "native_counter"] as const)(
        "rejects pixel-grid mapping with %s evidence without releasing a forged result",
        async (condition) => {
            const { input, composite } = await uniformLocalRequest({ width: 8, height: 5 });
            const result = input.resultImages[0];
            const proof = result.sceneProtectionEvidence!;
            const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
            const url = (bytes: Buffer) => "data:image/png;base64," + bytes.toString("base64");
            if (condition === "uniform_mode") proof.normalization = "uniform_scale";
            if (condition === "none_mode") proof.normalization = "none";
            if (condition === "native_digest") proof.nativeDigest = "a".repeat(64);
            if (condition === "replacement_native_rehashed" || condition === "wrong_ratio_native") {
                const nativeSize = condition === "wrong_ratio_native" ? { width: 8, height: 8 } : { width: 8, height: 5 };
                const replacement = await sharp({ create: { ...nativeSize, channels: 4, background: condition === "wrong_ratio_native" ? "blue" : "red" } })
                    .png()
                    .toBuffer();
                result.nativeUrl = url(replacement);
                result.nativeSize = nativeSize;
                proof.nativeUrl = result.nativeUrl;
                proof.nativeSize = nativeSize;
                proof.nativeDigest = sha256(replacement);
            }
            if (condition === "replacement_composite_rehashed") {
                const { data, info } = await sharp(composite.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                Buffer.from([0, 255, 0, 255]).copy(data, (3 * info.width + 3) * 4);
                const replacement = await sharp(data, { raw: info }).png().toBuffer();
                result.url = url(replacement);
                proof.compositeUrl = result.url;
                proof.compositeDigest = sha256(replacement);
            }
            if (condition === "missing_mask") proof.maskUrl = undefined;
            if (condition === "native_counter") proof.nativeOutsideChangedPixels = 1;
            const checked = await checkEcommerceTechnicalResult(input);
            expect(checked.status).not.toBe("passed");
            expect(ecommerceResultDeliveryGate(checked)).toMatchObject({ action: "pause" });
            if (condition === "missing_mask")
                expect(checked.canvasEvidence).toEqual([
                    expect.objectContaining({ nativeSize: { width: 8, height: 5 }, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, normalization: "pixel_grid_scale", mappingVerified: false }),
                ]);
            expect(mocks.requestStructuredText).not.toHaveBeenCalled();
        },
    );

    it("does not apply pixel-grid local mapping to an ordinary global exact canvas", async () => {
        const { input } = await uniformLocalRequest({ width: 8, height: 5 });
        input.plan.operation = "scene_edit";
        input.plan.protection = { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true };
        const checked = await checkEcommerceTechnicalResult(input);
        expect(checked.status).not.toBe("passed");
        expect(ecommerceResultDeliveryGate(checked)).toMatchObject({ action: "pause" });
        expect(checked.canvasEvidence).toEqual([expect.objectContaining({ nativeSize: { width: 8, height: 5 }, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, hardFailures: ["canvas_geometry"] })]);
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it.each([
        { width: 6, height: 4 },
        { width: 24, height: 16 },
    ])("delivers an independently verified local $width x $height native mapping without claiming native exact resolution", async (nativeSize) => {
        const { input } = await uniformLocalRequest(nativeSize);
        const checked = await checkEcommerceTechnicalResult(input);
        expect(checked.status).toBe("passed");
        expect(ecommerceResultDeliveryGate(checked)).toMatchObject({ action: "publish" });
        expect(checked.canvasEvidence).toEqual([expect.objectContaining({ nativeSize, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, normalization: "uniform_scale", mappingVerified: true, hardFailures: [] })]);
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "unmodified_region", source: "protection", status: "passed" }));
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "canvas_geometry", source: "media", status: "passed" }));
        expect(checked.sceneProtectionEvidence[0].evidence).toMatchObject({ nativeSize, normalization: "uniform_scale", compositeOutsideChangedPixels: 0 });
        expect(checked.sceneProtectionEvidence[0].evidence).not.toHaveProperty("nativeOutsideChangedPixels");
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
        const trace = buildEcommerceGenerationTrace({ runId: "fixture-run", task: { id: "fixture-task" } as never, snapshot: { technicalCheck: checked } as never, imageTaskIds: ["fixture-child"], generationStatus: "completed", finalStatus: "completed" });
        const restored = normalizeEcommerceGenerationTrace(JSON.parse(JSON.stringify(trace)))!;
        expect(restored.stages.find((stage) => stage.key === "image_generation")?.output).toMatchObject({
            technicalCheck: { canvasEvidence: [expect.objectContaining({ nativeSize, nativeMatches: false, storedMatches: true, normalization: "uniform_scale", mappingVerified: true })] },
        });
        expect(JSON.stringify(restored)).not.toContain("data:image/png;base64");
    });

    it.each([
        "normalization",
        "native_size",
        "native_digest",
        "source_digest",
        "native_counter",
        "replacement_native",
        "replacement_native_rehashed",
        "wrong_ratio_native",
        "reverse_mask_rehashed",
        "replacement_composite_rehashed",
        "missing_native",
        "missing_mask",
    ] as const)("refuses a local mapping with %s evidence instead of bypassing technical delivery", async (condition) => {
        const { input, protection, composite } = await uniformLocalRequest({ width: 6, height: 4 });
        const result = input.resultImages[0];
        const proof = result.sceneProtectionEvidence!;
        const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
        const url = (bytes: Buffer) => "data:image/png;base64," + bytes.toString("base64");
        if (condition === "normalization") proof.normalization = "none";
        if (condition === "native_size") proof.nativeSize = { width: 12, height: 8 };
        if (condition === "native_digest") proof.nativeDigest = "a".repeat(64);
        if (condition === "source_digest") proof.sourceDigest = "a".repeat(64);
        if (condition === "native_counter") proof.nativeOutsideChangedPixels = 1;
        if (condition === "replacement_native" || condition === "replacement_native_rehashed" || condition === "wrong_ratio_native") {
            const size = condition === "wrong_ratio_native" ? { width: 5, height: 5 } : { width: 6, height: 4 };
            const replacement = await sharp({ create: { ...size, channels: 4, background: "red" } })
                .png()
                .toBuffer();
            result.nativeUrl = url(replacement);
            proof.nativeUrl = result.nativeUrl;
            if (condition !== "replacement_native") {
                proof.nativeDigest = sha256(replacement);
                proof.nativeSize = size;
                result.nativeSize = size;
            }
        }
        if (condition === "reverse_mask_rehashed") {
            const { data, info } = await sharp(Buffer.from(protection.mask.dataUrl.split(",")[1], "base64"))
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            for (let index = 3; index < data.length; index += 4) data[index] = 255 - data[index];
            const reversed = await sharp(data, { raw: info }).png().toBuffer();
            proof.maskUrl = url(reversed);
            proof.maskDigest = sha256(reversed);
        }
        if (condition === "replacement_composite_rehashed") {
            const { data, info } = await sharp(composite.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            Buffer.from([0, 255, 0, 255]).copy(data, (3 * info.width + 3) * 4);
            const replacement = await sharp(data, { raw: info }).png().toBuffer();
            result.url = url(replacement);
            proof.compositeUrl = result.url;
            proof.compositeDigest = sha256(replacement);
        }
        if (condition === "missing_native") {
            result.nativeUrl = undefined;
            proof.nativeUrl = undefined;
            result.nativeSize = undefined;
        }
        if (condition === "missing_mask") proof.maskUrl = undefined;
        const checked = await checkEcommerceTechnicalResult(input);
        expect(checked.status).not.toBe("passed");
        expect(ecommerceResultDeliveryGate(checked)).toMatchObject({ action: "pause" });
        if (condition === "missing_mask")
            expect(checked.canvasEvidence).toEqual([
                expect.objectContaining({ nativeSize: { width: 6, height: 4 }, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, normalization: "uniform_scale", mappingVerified: false }),
            ]);
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it("keeps ordinary global native exact geometry strict even with a copied valid local mapping proof", async () => {
        const { input } = await uniformLocalRequest({ width: 6, height: 4 });
        input.plan.operation = "scene_edit";
        input.plan.protection = { scope: "global", protectedObjectIds: [], preserveOutsideMask: false, allowLightingChange: true };
        const checked = await checkEcommerceTechnicalResult(input);
        expect(checked.status).not.toBe("passed");
        expect(ecommerceResultDeliveryGate(checked)).toMatchObject({ action: "pause" });
        expect(checked.canvasEvidence).toEqual([expect.objectContaining({ nativeSize: { width: 6, height: 4 }, storedSize: { width: 12, height: 8 }, nativeMatches: false, storedMatches: true, hardFailures: ["canvas_geometry"] })]);
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it("checks saved media without a visual model and publishes visual misjudgements only as advice", async () => {
        const input = await independentRequest();
        const technical = await checkEcommerceTechnicalResult(input);
        expect(technical.status).toBe("passed");
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
        const visual = { ...unavailableEcommerceQualityCheck("private diagnosis", candidate().snapshot), status: "blocked" as const };
        expect(ecommerceResultDeliveryGate(technical, visual)).toMatchObject({ action: "publish", publicStatus: "needs_adjustment" });
        expect(ecommerceResultDeliveryGate(technical)).toMatchObject({ action: "publish" });
        input.resultImages[0].url = "data:image/png;base64,YnJva2Vu";
        expect(ecommerceResultDeliveryGate(await checkEcommerceTechnicalResult(input))).toMatchObject({ action: "pause", publicStatus: "needs_review" });
        input.resultImages = [];
        expect(ecommerceResultDeliveryGate(await checkEcommerceTechnicalResult(input)).action).toBe("pause");
    });

    it.each(["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"] as const)("defines image inspectability for every independent observation (%s)", async (planVersion) => {
        const input = await independentRequest();
        input.plan.planVersion = planVersion;
        input.productAnchorReference = { assetId: "original-product", url: input.baselineReference.url };
        const value = { ...independentResult(3), productAnchorObservation: observation(3) };
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));

        const checked = await checkEcommerceResult(input, candidate());
        const { tool, messages } = mocks.requestStructuredText.mock.calls[0][0];
        const schemas = [tool.parameters.properties.baselineObservation, tool.parameters.properties.productAnchorObservation, tool.parameters.properties.results.items.properties.observation];
        for (const schema of schemas) {
            expect(schema.required).toContain("readable");
            expect(schema.properties.readable).toEqual({ type: "boolean", description: expect.any(String) });
            expect(schema.properties.readable).toEqual(schemas[0].properties.readable);
        }
        for (const contract of [schemas[0].properties.readable.description, messages[0].content]) {
            expect(contract).toContain("实际图像整体是否足以进行独立视觉检查");
            expect(contract).toContain("不表示图片中有无可阅读文字");
            expect(contract).toContain("无文字、无 Logo 商品或场景图可以为 true");
            expect(contract).toContain("logo 和 packagingText");
            expect(contract).toContain("不可访问、损坏、严重模糊或不足以检查时为 false，不得猜测");
            expect(contract).toContain("true 不保证每个局部细节都可确认");
            expect(contract).toContain("局部遮挡或文字模糊仍使用对应 uncertain/unreadable");
            expect(contract).toContain("true 不等于一致性通过");
        }
        expect(checked).toMatchObject({ version: "ecommerce-quality.v2", status: "passed", publicStatus: "passed", hardFailures: [] });
        expect(checked.observations).toEqual({ baseline: value.baselineObservation, productAnchor: value.productAnchorObservation, results: [{ resultId: "result-1", observation: value.results[0].observation }] });
        expect(ecommerceQualityGate(checked).action).toBe("publish");
    });

    it.each(["baseline", "result", "anchor", "baseline_and_result"] as const)("preserves false readability and pauses despite confirmed structure and passed checks (%s)", async (source) => {
        const input = await independentRequest();
        input.plan.planVersion = "ecommerce-edit.v5";
        input.productAnchorReference = { assetId: "original-product", url: input.baselineReference.url };
        const value = { ...independentResult(3, { brand_logo: "passed", packaging_text: "passed" }), productAnchorObservation: observation(3) };
        const observations = [value.baselineObservation, value.results[0].observation, value.productAnchorObservation];
        for (const item of observations) item.visibleStructure = (["drawers", "doors", "handles", "legs"] as const).map((feature) => ({ ...structure(feature === "legs" ? 4 : 2), feature }));
        value.baselineObservation.readable = source !== "baseline" && source !== "baseline_and_result";
        value.results[0].observation.readable = source !== "result" && source !== "baseline_and_result";
        value.productAnchorObservation.readable = source !== "anchor";
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));

        const checked = await checkEcommerceResult(input, candidate());

        expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review", hardFailures: [] });
        expect(checked.observations).toEqual({ baseline: value.baselineObservation, productAnchor: value.productAnchorObservation, results: [{ resultId: "result-1", observation: value.results[0].observation }] });
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "protected_structure", status: "not_applicable", source: "independent_structure" }));
        expect(checked.checks.filter((check) => check.source === "vision")).toHaveLength(ECOMMERCE_QUALITY_CHECK_KEYS.length - 2);
        expect(checked.checks.filter((check) => check.source === "vision").every((check) => check.status === "passed")).toBe(true);
        expect(ecommerceQualityGate(checked)).toMatchObject({ action: "pause", publicStatus: "needs_review" });
    });

    it.each([true, false])("preserves readability and its gate across snapshot and trace round-trips (%s)", async (readable) => {
        const input = await independentRequest();
        input.plan.planVersion = "ecommerce-edit.v5";
        input.productAnchorReference = { assetId: "original-product", url: input.baselineReference.url };
        const value = { ...independentResult(3), productAnchorObservation: observation(3) };
        for (const item of [value.baselineObservation, value.results[0].observation, value.productAnchorObservation]) item.readable = readable;
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        const checked = await checkEcommerceResult(input, candidate());
        const expected = structuredClone(checked);
        const saved = recordEcommerceGenerationSnapshot(
            { id: "fixture-run", userId: "fixture-user" },
            { version: "ecommerce-generation.v1", mode: "active", input: { userRequest: "edit", assetIds: ["scene-1"], conversationId: "fixture", surface: "chat" }, qualityCheck: checked, createdAt: 1 },
        );
        checked.observations!.baseline.readable = !readable;
        checked.observations!.results[0].observation.visibleStructure[0].count = 99;
        const reloaded = JSON.parse(JSON.stringify(saved));
        expect(reloaded.qualityCheck).toEqual(expected);
        const trace = buildEcommerceGenerationTrace({ runId: "fixture-run", task: { id: "fixture-task" } as never, snapshot: reloaded, imageTaskIds: [], generationStatus: "completed", finalStatus: expected.publicStatus });
        const restoredTrace = normalizeEcommerceGenerationTrace(JSON.parse(JSON.stringify(trace)));
        expect(restoredTrace?.stages.find((stage) => stage.key === "quality_check")?.output).toMatchObject({ status: expected.status, publicStatus: expected.publicStatus, observations: expected.observations });
        expect(ecommerceQualityGate(reloaded.qualityCheck).action).toBe(readable ? "publish" : "pause");
    });

    it.each([undefined, null, "false", "true", 0, 1])("rejects non-boolean readability in every observation (%s)", async (readable) => {
        const input = await independentRequest();
        input.plan.planVersion = "ecommerce-edit.v5";
        input.productAnchorReference = { assetId: "original-product", url: input.baselineReference.url };
        for (const source of ["baseline", "result", "anchor"]) {
            const value = { ...independentResult(3), productAnchorObservation: observation(3) };
            Object.assign(source === "baseline" ? value.baselineObservation : source === "result" ? value.results[0].observation : value.productAnchorObservation, { readable });
            mocks.requestStructuredText.mockResolvedValue(modelCall(value));

            const checked = await checkEcommerceResult(input, candidate());

            expect(mocks.requestStructuredText.mock.calls.at(-1)![0].validateArguments(JSON.stringify(value))).toBe(false);
            expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review" });
            expect(checked).not.toHaveProperty("observations");
            expect(ecommerceQualityGate(checked).action).toBe("pause");
        }
    });

    it.each(["wrong", "valid", "unknown"] as const)("preserves legacy durable native facts when actual QA media cannot be decoded (%s)", async (condition) => {
        const input = await independentRequest();
        input.plan.canvas = { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false };
        const bytes = await sharp({ create: { width: 120, height: condition === "wrong" ? 120 : 160, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        const size = await sharp(bytes).metadata();
        input.resultImages = [{ resultId: "legacy-result", nativeUrl: "data:image/png;base64,AA==", url: "data:image/png;base64,AA==", ...(condition === "unknown" ? {} : { nativeSize: { width: size.width!, height: size.height! } }) }];
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked).toMatchObject({ status: condition === "wrong" ? "blocked" : "unavailable", publicStatus: "needs_review" });
        const evidence = checked.canvasEvidence![0];
        expect(evidence).toMatchObject({ resultId: "legacy-result", nativeMatches: condition === "unknown" ? null : condition !== "wrong", storedStatus: "unavailable", storedMatches: null });
        if (condition === "unknown") expect(evidence).not.toHaveProperty("nativeSize");
        else expect(evidence.nativeSize).toEqual({ width: size.width, height: size.height });
        expect(evidence).not.toHaveProperty("resultIndex");
        expect(checked.hardFailures).toEqual(condition === "wrong" ? [expect.objectContaining({ resultId: "legacy-result", key: "canvas_geometry", status: "failed", source: "media" })] : []);
        expect(ecommerceQualityGate(checked).action).toBe("pause");
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it.each(["unreadable", "save_failed", "wrong_native", "all_unreadable"] as const)("checks every durable original canvas slot when %s was omitted from stored media", async (condition) => {
        const input = await independentRequest();
        input.plan.canvas = { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false };
        input.resultImages[0].nativeUrl = input.resultImages[0].url;
        const native = await sharp({ create: { width: 120, height: condition === "wrong_native" ? 120 : 160, channels: 3, background: "white" } })
            .png()
            .toBuffer();
        const decoded = await sharp(native).metadata();
        input.batchEvidence = [
            { resultId: "result-1", resultIndex: 1, nativeStatus: "readable", nativeSize: { width: 120, height: 160 }, storageStatus: "stored", storedSize: { width: 120, height: 160 }, storedUrl: input.resultImages[0].url },
            {
                resultId: "result-2",
                resultIndex: 2,
                nativeStatus: condition === "unreadable" || condition === "all_unreadable" ? "unavailable" : "readable",
                ...(condition === "save_failed" || condition === "wrong_native" ? { nativeSize: { width: decoded.width!, height: decoded.height! } } : {}),
                storageStatus: "unavailable",
                failureStage: condition === "save_failed" || condition === "wrong_native" ? "store" : "read",
                failureReason: "安全失败证据",
            },
        ];
        if (condition === "all_unreadable") {
            input.resultImages = [];
            input.batchEvidence[0] = { resultId: "result-1", resultIndex: 1, nativeStatus: "unavailable", storageStatus: "unavailable", failureStage: "read", failureReason: "安全失败证据" };
        }
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3)));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked).toMatchObject({ status: condition === "wrong_native" ? "blocked" : "unavailable", publicStatus: "needs_review" });
        expect(checked.canvasEvidence?.map((slot) => slot.resultId)).toEqual(["result-1", "result-2"]);
        expect(checked.canvasEvidence?.[1]).toMatchObject({ resultIndex: 2, storedStatus: "unavailable", storedMatches: null, failureReason: "安全失败证据" });
        if (condition === "wrong_native") expect(checked.hardFailures).toContainEqual(expect.objectContaining({ resultId: "result-2", key: "canvas_geometry", status: "failed" }));
        else expect(checked.hardFailures).toEqual([]);
        expect(ecommerceQualityGate(checked)).toMatchObject({ action: "pause", publicStatus: "needs_review" });
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it.each(["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"] as const)("publishes independently checked product local edits without claiming outside pixels (%s)", async (planVersion) => {
        const input = await productLocalRequest(planVersion);
        mocks.requestStructuredText.mockResolvedValue(modelCall({ ...independentResult(3), productAnchorObservation: observation(3) }));

        const checked = await checkEcommerceResult(input, candidate());

        expect(checked).toMatchObject({ version: "ecommerce-quality.v2", status: "passed", publicStatus: "passed", hardFailures: [], sceneProtectionEvidence: [] });
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "unmodified_region", status: "not_applicable", source: "protection" }));
        expect(checked.checks.find((item) => item.key === "unmodified_region")).not.toHaveProperty("evidence");
        expect(checked.observations?.productAnchor?.visibleStructure[0].count).toBe(3);
        expect(ecommerceQualityGate(checked).action).toBe("publish");
    });
    it.each(["structure", "material", "native_canvas", "missing_observation"] as const)("independent product local edits retain required %s evidence", async (condition) => {
        const input = await productLocalRequest("ecommerce-edit.v5");
        const value = { ...independentResult(condition === "structure" ? 4 : 3, condition === "material" ? { protected_material: "failed" } : {}), productAnchorObservation: observation(3) };
        if (condition === "native_canvas")
            input.resultImages[0].nativeUrl =
                "data:image/png;base64," +
                (
                    await sharp({ create: { width: 120, height: 120, channels: 3, background: "white" } })
                        .png()
                        .toBuffer()
                ).toString("base64");
        if (condition === "missing_observation") value.results[0].observation.visibleStructure = [];
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));

        const checked = await checkEcommerceResult(input, candidate());

        expect(checked.status).toBe(condition === "missing_observation" ? "unavailable" : "blocked");
        expect(ecommerceQualityGate(checked).action).toBe("pause");
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "unmodified_region", status: "not_applicable" }));
        if (condition !== "missing_observation")
            expect(checked.hardFailures).toContainEqual(expect.objectContaining({ key: condition === "structure" ? "protected_structure" : condition === "material" ? "protected_material" : "canvas_geometry", status: "failed" }));
    });
    it.each([false, true])("requires scene-local pixel evidence even when preserveOutsideMask=%s", async (preserveOutsideMask) => {
        const input = await independentRequest();
        input.plan.planVersion = "ecommerce-edit.v5";
        input.plan.protection = { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask, allowLightingChange: false };
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3)));

        const checked = await checkEcommerceResult(input, candidate());

        expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review" });
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "unmodified_region", status: "not_applicable" }));
        expect(ecommerceQualityGate(checked).action).toBe("pause");
    });
    it.each(["protected_material", "composition_lighting"] as const)("checks v5 photography targets while keeping %s severity", async (key) => {
        const input = await independentRequest();
        input.plan.planVersion = "ecommerce-edit.v5";
        input.plan.photography = {
            materials: [{ objectId: "cabinet", textureDirection: "沿原图木纹方向", textureScale: "保留细木纹", roughness: "细哑光", gloss: "保留原有低光泽" }],
            lighting: { keyLight: "左侧大面积柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "真实接触阴影" },
            composition: { focalSubject: "边柜层次", depth: "空间纵深", negativeSpace: "适当留白" },
        };
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3, { [key]: "failed" })));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.version).toBe("ecommerce-quality.v2");
        expect(checked.status).toBe(key === "protected_material" ? "blocked" : "needs_adjustment");
        expect(checked.observations?.baseline.visibleStructure[0].count).toBe(3);
        const messages = mocks.requestStructuredText.mock.calls[0][0].messages;
        const target = messages[1].content.find((part: { text?: string }) => part.text?.includes('"photography"'));
        expect(JSON.parse(target.text).plan.photography).toEqual(input.plan.photography);
        expect(messages[0].content).toContain("木纹方向与尺度");
        expect(messages[0].content).toContain("主光方向与面积");
    });
    it.each([3, 4])("independently observes a three-drawer scene when the plan says four and the result has %s", async (drawers) => {
        const input = request(scenePlan());
        input.plan = {
            ...input.plan,
            planVersion: "ecommerce-edit.v4",
            preserve: { productCore: [], sceneElements: ["cabinet"] },
            protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
            visibleStructure: [structure(4)],
        } as EcommerceEditPlan;
        input.baselineReference = { assetId: "scene-1", role: "scene", url: await drawerImage(3) };
        input.resultImages = [{ resultId: "result-1", url: await drawerImage(drawers) }];
        input.analysisVisibleStructure = [structure(4)] as NonNullable<EcommerceEditPlan["visibleStructure"]>;
        mocks.requestStructuredText.mockImplementation(async ({ messages }) => {
            const images = messages[1].content.filter((part: { type: string }) => part.type === "image_url");
            const baselineCount = await observeDrawerFixture(images[0].image_url.url);
            const resultPart = messages[1].content.findIndex((part: { text?: string }) => part.text === "resultId=result-1");
            const resultCount = await observeDrawerFixture(messages[1].content[resultPart + 1].image_url.url);
            return modelCall({ ...modelResult(), baselineObservation: observation(baselineCount), results: [{ ...modelResult().results[0], observation: observation(resultCount) }] });
        });
        const checked = await checkEcommerceResult(input, candidate());
        if (drawers === 3) expect(checked.hardFailures).toHaveLength(0);
        else expect(checked.hardFailures).toContainEqual(expect.objectContaining({ key: "protected_structure", status: "failed" }));
        expect(checked.status).toBe(drawers === 3 ? "passed" : "blocked");
        expect(checked).toHaveProperty("observations.baseline.visibleStructure.0.count", 3);
        expect(checked).toHaveProperty("contradictions.0", expect.objectContaining({ source: "plan", observedCount: 3, reportedCount: 4 }));
        expect(checked.contradictions).toContainEqual(expect.objectContaining({ source: "analysis", observedCount: 3, reportedCount: 4 }));
        expect(checked).toHaveProperty("visionEvidence.imageCount", 4);
        expect(JSON.stringify(mocks.requestStructuredText.mock.calls[0][0].messages)).not.toContain('"count":4');
    });

    it("keeps a visual structure failure even when independently counted drawers are equal", async () => {
        const input = await independentRequest();
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3, { protected_structure: "failed" })));
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({ status: "blocked", hardFailures: [expect.objectContaining({ key: "protected_structure", status: "failed" })] });
    });

    it.each(["doors", "handles"] as const)("blocks an independently observed %s count change", async (feature) => {
        const input = await independentRequest();
        const value = independentResult(4);
        value.baselineObservation.visibleStructure[0].feature = feature;
        value.results[0].observation.visibleStructure[0].feature = feature;
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        expect((await checkEcommerceResult(input, candidate())).hardFailures).toContainEqual(expect.objectContaining({ key: "protected_structure", status: "failed", evidence: expect.objectContaining({ feature, baselineCount: 3, resultCount: 4 }) }));
    });

    it.each(["protected_material", "product_identity"] as const)("keeps %s hard while aesthetics pass", async (key) => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3, { [key]: "failed" })));
        expect((await checkEcommerceResult(await independentRequest(), candidate())).hardFailures).toContainEqual(expect.objectContaining({ key, status: "failed", source: "vision" }));
    });

    it.each(["structure", "unreadable_image", "soft_uncheckable"])("leaves %s evidence for review", async (condition) => {
        const value = independentResult(3);
        if (condition === "structure") value.baselineObservation.visibleStructure = [];
        if (condition === "unreadable_image") value.baselineObservation.readable = false;
        if (condition === "soft_uncheckable") value.results[0].checks.find((check) => check.key === "scene_intent")!.status = "not_applicable";
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        expect(await checkEcommerceResult(await independentRequest(), candidate())).toMatchObject({ status: "unavailable", publicStatus: "needs_review" });
    });
    it("keeps the original product anchor as independent evidence beside the main scene", async () => {
        const input = await independentRequest();
        input.productAnchorReference = { assetId: "original-product", url: await drawerImage(3) };
        const value = { ...independentResult(3), productAnchorObservation: observation(4) };
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.hardFailures).toContainEqual(expect.objectContaining({ key: "protected_structure", evidence: expect.objectContaining({ baselineCount: 4, resultCount: 3 }) }));
        expect(checked.observations?.productAnchor?.visibleStructure[0].count).toBe(4);
        expect(checked.visionEvidence?.imageCount).toBe(5);
    });
    it.each(["same", "different"])("uses the same gate with %s logical role models", async (mode) => {
        const input = await independentRequest();
        input.plan.modelRoles.visionAnalysis = mode === "same" ? "quality-model" : "vision-model";
        input.plan.modelRoles.editPlanning = mode === "same" ? "quality-model" : "planning-model";
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(4)));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe("blocked");
        expect(checked.modelRole).toEqual(candidate().snapshot);
    });
    it("rejects an undecodable v4 image and malformed independent observations without regeneration", async () => {
        const input = await independentRequest();
        input.resultImages[0].url = "data:image/png;base64,AA==";
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({ status: "unavailable" });
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
        input.resultImages[0].url = await drawerImage(3);
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult()));
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({ status: "unavailable" });
    });

    it("keeps a native geometry failure when a second result cannot be decoded", async () => {
        const input = await independentRequest();
        input.plan.canvas = { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false };
        const square =
            "data:image/png;base64," +
            (
                await sharp({ create: { width: 120, height: 120, channels: 3, background: "white" } })
                    .png()
                    .toBuffer()
            ).toString("base64");
        input.resultImages[0].nativeUrl = square;
        input.resultImages.push({ resultId: "result-2", url: "data:image/png;base64,AA==", nativeUrl: square });
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe("blocked");
        expect(checked.hardFailures).toEqual([expect.objectContaining({ key: "canvas_geometry", resultId: "result-1" }), expect.objectContaining({ key: "canvas_geometry", resultId: "result-2" })]);
        expect(checked.canvasEvidence?.[1]).toMatchObject({ resultId: "result-2", nativeSize: { width: 120, height: 120 }, nativeStatus: "readable", storedStatus: "unavailable", nativeMatches: false, storedMatches: null });
    });

    it("verifies actual composite pixels and refuses a copied proof on a different result", async () => {
        const input = await independentRequest();
        input.plan.protection = { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false };
        const source = Buffer.from(input.baselineReference.url.split(",")[1], "base64");
        const native = await sharp({ create: { width: 120, height: 160, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const protection = await buildSceneEditProtection(source, "scene-1", { x: 0, y: 0, width: 10, height: 10 }, ["add prop"], "user_selection");
        protection.confirmation = { actorUserId: "fixture-user", confirmedAt: 1 };
        const composite = await compositeSceneEdit(source, native, protection);
        input.resultImages[0] = { resultId: "result-1", url: "data:image/png;base64," + composite.bytes.toString("base64"), sceneProtectionEvidence: composite.evidence };
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3)));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe("passed");
        expect(checked.checks).toContainEqual(expect.objectContaining({ key: "unmodified_region", status: "passed", source: "protection" }));
        expect(checked.sceneProtectionEvidence?.[0].evidence.nativeOutsideChangedPixels).toBeGreaterThan(0);
        input.resultImages[0].url = await drawerImage(4);
        mocks.requestStructuredText.mockRejectedValue(new Error("fixture model unavailable"));
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({
            status: "blocked",
            hardFailures: [expect.objectContaining({ key: "unmodified_region", status: "failed" })],
            sceneProtectionEvidence: [{ resultId: "result-1", evidence: composite.evidence }],
        });
    });
    it("requires independent coverage of named protected facts without trusting their planned count", async () => {
        const input = await independentRequest();
        const value = independentResult(3);
        value.baselineObservation.visibleStructure[0].objectId = "other-furniture";
        value.results[0].observation.visibleStructure[0].objectId = "other-furniture";
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe("unavailable");
        expect(checked.contradictions).toContainEqual(expect.objectContaining({ source: "plan", objectId: "cabinet", observedCount: null }));
    });

    it.each(["both", "baseline", "result", "second_result"])("requires protected object coverage with empty planned facts when %s observations omit the cabinet", async (missing) => {
        const input = await independentRequest();
        input.plan.visibleStructure = [];
        input.analysisVisibleStructure = [];
        const value = independentResult(3);
        if (missing === "both" || missing === "baseline") value.baselineObservation.visibleStructure[0].objectId = "other-furniture";
        if (missing === "both" || missing === "result") value.results[0].observation.visibleStructure[0].objectId = "other-furniture";
        if (missing === "second_result") {
            input.resultImages.push({ resultId: "result-2", url: await drawerImage(3) });
            value.results.push({ ...structuredClone(value.results[0]), resultId: "result-2", observation: { ...observation(3), visibleStructure: [{ ...structure(3), objectId: "other-furniture" }] } });
        }
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review", hardFailures: [] });
        expect(ecommerceQualityGate(checked).action).toBe("pause");
        expect(checked.checks.some((check) => check.key === "protected_structure" && check.status === "not_applicable" && check.reason.includes("cabinet"))).toBe(true);
        expect(checked.observations).toEqual({ baseline: value.baselineObservation, results: value.results.map(({ resultId, observation }) => ({ resultId, observation })) });
    });

    it("keeps independently covered protected objects valid without creating a planned count", async () => {
        const input = await independentRequest();
        input.plan.visibleStructure = [];
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3)));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe("passed");
        expect(input.plan.visibleStructure).toEqual([]);
        expect(JSON.stringify(mocks.requestStructuredText.mock.calls[0][0].messages)).not.toContain('"count"');
    });

    it.each([true, false])("binds descriptive scene preservation to existing protected identities without inventing IDs (resolved=%s)", async (resolved) => {
        const input = await independentRequest();
        input.plan.visibleStructure = [];
        input.plan.protection!.protectedObjectIds = resolved ? ["cabinet"] : [];
        input.plan.preserve.sceneElements = ["keep the original cabinet beside the window", "keep camera position and composition"];
        mocks.requestStructuredText.mockResolvedValue(modelCall(independentResult(3)));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe(resolved ? "passed" : "unavailable");
        expect(checked.observations?.baseline.visibleStructure[0].objectId).toBe("cabinet");
        expect(JSON.stringify(checked.observations)).not.toContain("the original cabinet");
    });

    it.each(["baseline", "result"])("requires every protected object, including a second table omitted from the %s", async (missing) => {
        const input = await independentRequest();
        input.plan.visibleStructure = [];
        input.plan.protection!.protectedObjectIds = ["cabinet", "table"];
        const value = independentResult(3);
        const table = { ...structure(4), objectId: "table", feature: "legs" as const };
        if (missing !== "baseline") value.baselineObservation.visibleStructure.push(table);
        if (missing !== "result") value.results[0].observation.visibleStructure.push(table);
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe("unavailable");
        expect(checked.checks.some((check) => check.key === "protected_structure" && check.status === "not_applicable" && check.reason.includes("table"))).toBe(true);
    });

    it.each([true, false])("uses the known product asset relationship for protected object coverage (covered=%s)", async (covered) => {
        const input = await independentRequest();
        input.plan.visibleStructure = [];
        input.plan.source.productAnchorId = "original-product";
        input.productAnchorReference = { assetId: "original-product", url: await drawerImage(3) };
        input.plan.protection!.protectedObjectIds = ["original-product"];
        input.plan.preserve.sceneElements = ["original-product"];
        const value = { ...independentResult(3), productAnchorObservation: observation(3) };
        if (!covered) value.results[0].observation.visibleStructure[0].objectId = "other-furniture";
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.status).toBe(covered ? "passed" : "unavailable");
        expect(checked.observations?.productAnchor?.visibleStructure[0].objectId).toBe("cabinet");
    });

    it.each(["native_failed", "stored_failed", "native_valid", "stored_valid", "both_unreadable"])("retains each actual media observation within one result (%s)", async (condition) => {
        const input = await independentRequest();
        input.plan.canvas = { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false };
        const unreadable = "data:image/png;base64,AA==";
        const square =
            "data:image/png;base64," +
            (
                await sharp({ create: { width: 120, height: 120, channels: 3, background: "white" } })
                    .png()
                    .toBuffer()
            ).toString("base64");
        const nativeReadable = condition === "native_failed" || condition === "native_valid";
        const storedReadable = condition === "stored_failed" || condition === "stored_valid";
        input.resultImages[0] = {
            resultId: "result-1",
            nativeUrl: nativeReadable ? (condition === "native_failed" ? square : input.baselineReference.url) : unreadable,
            url: storedReadable ? (condition === "stored_failed" ? square : input.baselineReference.url) : unreadable,
        };
        const checked = await checkEcommerceResult(input, candidate());
        const failed = condition.endsWith("_failed");
        expect(checked.status).toBe(failed ? "blocked" : "unavailable");
        expect(checked.hardFailures).toHaveLength(failed ? 1 : 0);
        if (failed) expect(checked.hardFailures[0]).toMatchObject({ resultId: "result-1", key: "canvas_geometry", status: "failed", source: "media" });
        const evidence = checked.canvasEvidence?.[0];
        expect(evidence).toMatchObject({
            resultId: "result-1",
            nativeStatus: nativeReadable ? "readable" : "unavailable",
            storedStatus: storedReadable ? "readable" : "unavailable",
            nativeMatches: nativeReadable ? condition !== "native_failed" : null,
            storedMatches: storedReadable ? condition !== "stored_failed" : null,
        });
        if (nativeReadable) expect(evidence?.nativeSize).toEqual({ width: 120, height: condition === "native_failed" ? 120 : 160 });
        else expect(evidence).not.toHaveProperty("nativeSize");
        if (storedReadable) expect(evidence?.storedSize).toEqual({ width: 120, height: condition === "stored_failed" ? 120 : 160 });
        else expect(evidence).not.toHaveProperty("storedSize");
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it.each(["ecommerce-edit.v4", "ecommerce-edit.v5", "ecommerce-edit.v6"] as const)("does not pass unreadable or uncertain logo and packaging text despite image readability (%s)", async (planVersion) => {
        const input = await independentRequest();
        input.plan.planVersion = planVersion;
        for (const textStatus of ["unreadable", "uncertain"]) {
            for (const field of ["logo", "packagingText"] as const) {
                const value = independentResult(3);
                value.baselineObservation[field] = textStatus;
                mocks.requestStructuredText.mockResolvedValue(modelCall(value));
                const checked = await checkEcommerceResult(input, candidate());
                expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review" });
                expect(checked.observations?.baseline).toMatchObject({ readable: true, [field]: textStatus });
                expect(ecommerceQualityGate(checked).action).toBe("pause");
            }
        }
    });

    it("does not claim unmodified pixels for legacy product local edits without composite evidence", async () => {
        const input = request();
        input.plan = {
            ...input.plan,
            planVersion: "ecommerce-edit.v3",
            operation: "local_edit",
            source: { ...input.plan.source, currentSceneBaselineId: "scene-1" },
            protection: { scope: "local", protectedObjectIds: ["product-1"], preserveOutsideMask: false, allowLightingChange: false },
        };
        input.baselineReference = { assetId: "scene-1", role: "scene", url: await drawerImage(3) };
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult()));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked.checks.find((item) => item.key === "unmodified_region")?.status).not.toBe("passed");
        expect(checked.publicStatus).toBe("needs_review");
    });
    it("never lets a normalized stored canvas conceal the native square", () => {
        expect(evaluateEcommerceCanvas({ mode: "exact", size: { width: 3840, height: 2160 }, source: "baseline", allowReframe: false }, { width: 2880, height: 2880 }, { width: 3840, height: 2160 })).toEqual({
            hardFailures: ["canvas_geometry"],
            nativeMatches: false,
            storedMatches: true,
        });
    });
    it("compares ratios without promoting interpolation to native exact resolution", () => {
        const canvas = { mode: "ratio" as const, size: { width: 16, height: 9 }, source: "user_text" as const, allowReframe: true };
        expect(evaluateEcommerceCanvas(canvas, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }).hardFailures).toEqual([]);
        expect(evaluateEcommerceCanvas({ ...canvas, mode: "exact", size: { width: 3840, height: 2160 } }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }).nativeMatches).toBe(false);
    });
    it("actual native and stored bytes beat QA passed claims and supplied dimensions", async () => {
        const image = async (width: number, height: number) =>
            "data:image/png;base64," +
            (
                await sharp({ create: { width, height, channels: 3, background: "#aaa" } })
                    .png()
                    .toBuffer()
            ).toString("base64");
        const input = request(scenePlan());
        input.plan.canvas = { mode: "exact", size: { width: 3840, height: 2160 }, source: "user_text", allowReframe: false };
        input.baselineReference = { assetId: "scene-1", role: "scene", url: await image(3840, 2160) };
        input.resultImages = [{ resultId: "result-1", url: await image(3840, 2160), nativeUrl: await image(2880, 2880), nativeSize: { width: 3840, height: 2160 } }];
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult()));
        const checked = await checkEcommerceResult(input, candidate());
        expect(checked).toMatchObject({
            status: "blocked",
            publicStatus: "needs_review",
            canvasEvidence: [{ resultId: "result-1", nativeSize: { width: 2880, height: 2880 }, storedSize: { width: 3840, height: 2160 }, nativeMatches: false, storedMatches: true }],
        });
        expect(mocks.requestStructuredText).toHaveBeenCalledOnce();
        expect(checked.hardFailures).toContainEqual(expect.objectContaining({ key: "canvas_geometry", status: "failed" }));
    });

    it("requires native evidence and fails closed when actual stored media cannot be decoded", async () => {
        const image =
            "data:image/png;base64," +
            (
                await sharp({ create: { width: 384, height: 216, channels: 3, background: "#aaa" } })
                    .png()
                    .toBuffer()
            ).toString("base64");
        const input = request(scenePlan());
        input.plan.canvas = { mode: "exact", size: { width: 384, height: 216 }, source: "baseline", allowReframe: false };
        input.baselineReference = { assetId: "scene-1", role: "scene", url: image };
        input.resultImages = [{ resultId: "result-1", url: image }];
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({ status: "unavailable", publicStatus: "needs_review", internalReason: "上游原生画幅证据缺失" });
        input.resultImages = [{ resultId: "result-1", url: "data:image/png;base64,AA==", nativeUrl: image }];
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({ status: "unavailable", publicStatus: "needs_review" });
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each(["ecommerce-edit.v1", "ecommerce-edit.v2", "ecommerce-edit.v3"] as const)("keeps the eight-check QA contract for an already-started %s task", async (planVersion) => {
        const input = request();
        input.plan.planVersion = planVersion;
        const value = modelResult();
        value.results[0].checks = value.results[0].checks.slice(0, 8);
        mocks.requestStructuredText.mockResolvedValue(modelCall(value));
        expect(await checkEcommerceResult(input, candidate())).toMatchObject({ version: "ecommerce-quality.v1", status: "passed", checks: expect.any(Array) });
        const { tool, messages } = mocks.requestStructuredText.mock.calls[0][0];
        const resultSchema = tool.parameters.properties.results.items;
        expect(resultSchema.properties.checks).toMatchObject({ minItems: 8, maxItems: 8 });
        expect(resultSchema.properties.checks.items.properties.key.enum).toHaveLength(8);
        expect(resultSchema.properties).not.toHaveProperty("observation");
        expect(messages[0].content).not.toContain("baselineObservation");
    });

    it("blocks publication when a generated result changes the product silhouette", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ product_silhouette: "failed" })));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked.status).toBe("blocked");
        expect(checked.publicStatus).toBe("needs_review");
        expect(checked.hardFailures).toEqual([expect.objectContaining({ resultId: "result-1", key: "product_silhouette", status: "failed" })]);
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
        expect(ecommerceQualityGate(checked)).toEqual({ action: "pause", publicStatus: "needs_review", publicMessage: "商品一致性检查未通过，需要复核。" });
    });

    it("fails closed when a required product invariant cannot be evaluated", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ product_identity: "not_applicable" })));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked.status).toBe("blocked");
        expect(checked.hardFailures).toEqual([expect.objectContaining({ resultId: "result-1", key: "product_identity", status: "not_applicable" })]);
    });

    it("only allows logo and packaging checks to be not applicable when the baseline has no brand text", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ brand_logo: "not_applicable", packaging_text: "not_applicable" })));
        const withoutBrandText = await checkEcommerceResult(request(), candidate());
        const brandedRequest = request();
        brandedRequest.plan.baseline.productFacts!.brandText = ["ACME"];
        const withBrandText = await checkEcommerceResult(brandedRequest, candidate());

        expect(withoutBrandText.status).toBe("passed");
        expect(withBrandText.status).toBe("blocked");
        expect(withBrandText.hardFailures.map((item) => item.key)).toEqual(["brand_logo", "packaging_text"]);
    });

    it("publishes a result with a short adjustment status for scene-only drift", async () => {
        mocks.requestStructuredText.mockResolvedValue(modelCall(modelResult({ scene_intent: "failed" })));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked.status).toBe("needs_adjustment");
        expect(checked.publicStatus).toBe("needs_adjustment");
        expect(checked.hardFailures).toEqual([]);
        expect(shouldBlockEcommerceResult(checked)).toBe(false);
        expect(ecommerceQualityGate(checked)).toEqual({ action: "publish", publicStatus: "needs_adjustment", publicMessage: "图片已生成，场景细节可继续调整。" });
    });

    it("retains hard furniture failures when the baseline role is scene", async () => {
        mocks.requestStructuredText.mockResolvedValue(
            modelCall(
                modelResult({
                    product_identity: "failed",
                    product_silhouette: "failed",
                    product_color_material: "failed",
                    product_proportions_view: "failed",
                }),
            ),
        );
        const sceneRequest = request(scenePlan());
        sceneRequest.baselineReference = { assetId: "scene-1", url: "https://cdn.example.com/scene.png", role: "scene" };

        const checked = await checkEcommerceResult(sceneRequest, candidate());

        expect(checked.status).toBe("blocked");
        expect(checked.hardFailures).toContainEqual(expect.objectContaining({ key: "product_silhouette", status: "failed" }));
    });

    it("fails closed when the frozen quality-check model is unavailable", async () => {
        mocks.requestStructuredText.mockRejectedValue(new Error("quality model offline"));

        const checked = await checkEcommerceResult(request(), candidate());

        expect(checked).toMatchObject({ status: "unavailable", publicStatus: "needs_review", hardFailures: [], internalReason: "quality model offline" });
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
        expect(ecommerceQualityGate(checked).action).toBe("pause");
    });

    it("uses the next quality-check candidate only when the preferred candidate is unavailable", async () => {
        const preferred = candidate("quality-primary", "gemini-3.8-flash-high", "quality-primary-channel");
        const fallback = candidate("quality-fallback", "gpt-5.6-sol", "quality-fallback-channel");
        mocks.requestStructuredText.mockRejectedValueOnce(new Error("Verify your account to continue.")).mockResolvedValueOnce(modelCall(modelResult()));

        const checked = await checkEcommerceResultWithFallback(request(), [preferred, fallback]);

        expect(checked.status).toBe("passed");
        expect(checked.modelRole).toEqual(fallback.snapshot);
        expect(mocks.requestStructuredText).toHaveBeenCalledTimes(2);
        expect(mocks.requestStructuredText.mock.calls.map(([input]) => input.candidate.snapshot)).toEqual([preferred.snapshot, fallback.snapshot]);
    });

    it("does not turn an unavailable snapshot into a pass", () => {
        const checked = unavailableEcommerceQualityCheck("quality route missing", candidate().snapshot);

        expect(checked.status).toBe("unavailable");
        expect(checked.publicStatus).toBe("needs_review");
        expect(shouldBlockEcommerceResult(checked)).toBe(true);
    });
});

async function uniformLocalRequest(nativeSize: { width: number; height: number }) {
    const input = request(scenePlan());
    input.plan.planVersion = "ecommerce-edit.v6";
    input.plan.operation = "local_edit";
    input.plan.canvas = { mode: "exact", size: { width: 12, height: 8 }, source: "baseline", allowReframe: false };
    input.plan.protection = { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false };
    const sourcePixels = Buffer.from(Array.from({ length: 12 * 8 * 4 }, (_, index) => (index % 4 === 3 ? 255 : (index * 7) % 256)));
    const source = await sharp(sourcePixels, { raw: { width: 12, height: 8, channels: 4 } })
        .png()
        .toBuffer();
    const native = await sharp({ create: { ...nativeSize, channels: 4, background: "blue" } })
        .png()
        .toBuffer();
    const protection = await buildSceneEditProtection(source, "scene-1", { x: 2, y: 2, width: 4, height: 4 }, ["add prop"], "user_selection");
    protection.confirmation = { actorUserId: input.userId, confirmedAt: 1 };
    const composite = await compositeSceneEdit(source, native, protection);
    const url = (bytes: Buffer) => "data:image/png;base64," + bytes.toString("base64");
    input.baselineReference = { assetId: "scene-1", role: "scene", url: url(source) };
    input.resultImages = [
        { resultId: "result-1", url: url(composite.bytes), nativeUrl: url(native), nativeSize, sceneProtectionEvidence: { ...composite.evidence, nativeUrl: url(native), maskUrl: protection.mask.dataUrl, compositeUrl: url(composite.bytes) } },
    ];
    return { input, source, native, protection, composite };
}

function structure(count: number | null) {
    return { objectId: "cabinet", feature: "drawers" as "drawers" | "doors" | "handles" | "legs", count, certainty: count === null ? ("uncertain" as const) : ("confirmed" as const), evidenceRegion: { x: 0, y: 0, width: 120, height: 160 } };
}
async function productLocalRequest(planVersion: "ecommerce-edit.v4" | "ecommerce-edit.v5" | "ecommerce-edit.v6") {
    const input = await independentRequest();
    input.plan = {
        ...plan(),
        planVersion,
        operation: "local_edit",
        source: { productAnchorId: "product-1", currentSceneBaselineId: "scene-1", sceneReferenceIds: [] },
        delta: { requestedChanges: ["从这张较早结果把背景改成现代厨房。"], targetObjects: ["background-main"], targetRegions: [] },
        visibleStructure: [structure(3)],
        protection: { scope: "local", protectedObjectIds: ["product-1", "cabinet"], preserveOutsideMask: false, allowLightingChange: false },
        canvas: { mode: "exact", size: { width: 120, height: 160 }, source: "baseline", allowReframe: false },
    };
    input.productAnchorReference = { assetId: "product-1", url: await drawerImage(3) };
    input.resultImages[0].nativeUrl = input.resultImages[0].url;
    return input;
}

async function independentRequest() {
    const input = request(scenePlan());
    input.plan = {
        ...input.plan,
        planVersion: "ecommerce-edit.v4",
        preserve: { productCore: [], sceneElements: ["cabinet"] },
        visibleStructure: [structure(4)],
        protection: { scope: "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: false, allowLightingChange: true },
    };
    input.baselineReference = { assetId: "scene-1", role: "scene", url: await drawerImage(3) };
    input.resultImages = [{ resultId: "result-1", url: await drawerImage(3) }];
    return input;
}
function independentResult(count: number, overrides: Parameters<typeof modelResult>[0] = {}) {
    return { ...modelResult(), baselineObservation: observation(3), results: [{ ...modelResult(overrides).results[0], observation: observation(count) }] };
}
function observation(count: number | null) {
    return { readable: true, logo: "absent", packagingText: "absent", visibleStructure: [structure(count)] };
}
async function drawerImage(count: number) {
    const rectangles = Array.from({ length: count }, (_, index) => `<rect x="20" y="${20 + index * 30}" width="80" height="20" fill="black"/>`).join("");
    return (
        "data:image/png;base64," +
        (
            await sharp(Buffer.from(`<svg width="120" height="160"><rect width="120" height="160" fill="white"/>${rectangles}</svg>`))
                .png()
                .toBuffer()
        ).toString("base64")
    );
}
async function observeDrawerFixture(url: string) {
    const { data, info } = await sharp(Buffer.from(url.split(",")[1], "base64"))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let count = 0;
    let dark = false;
    for (let y = 0; y < info.height; y++) {
        const next = data[(y * info.width + 40) * info.channels] < 32;
        if (next && !dark) count++;
        dark = next;
    }
    return count;
}

function request(requestPlan = plan()): EcommerceQualityCheckRequest {
    return {
        origin: "http://localhost",
        cookie: "session=test",
        userId: "user-1",
        requestId: "run-1",
        plan: requestPlan,
        baselineReference: { assetId: "product-1", url: "https://cdn.example.com/product.png", role: "product" as const },
        resultImages: [{ resultId: "result-1", url: "https://cdn.example.com/result.png" }],
    };
}

function candidate(logicalModelId = "quality-model", upstreamModel = "gpt-5.6-sol", channelId = "quality-channel"): EcommerceRoleCandidate {
    return {
        logicalRole: "quality_check",
        capability: "text",
        logicalModelId,
        channelId,
        upstreamModel,
        channel: { id: channelId, name: "Quality", enabled: true, apiFormat: "openai", baseUrl: "https://example.com", apiKey: "secret", models: [] },
        snapshot: {
            logicalRole: "quality_check",
            capability: "text",
            logicalModelId,
            channelId,
            upstreamModel,
            apiFormat: "openai",
        },
    } as EcommerceRoleCandidate;
}

function modelCall(value: unknown) {
    return { arguments: JSON.stringify(value), headers: new Headers(), protocol: "chat" as const, elapsedMs: 10 };
}

function modelResult(overrides: Partial<Record<(typeof ECOMMERCE_QUALITY_CHECK_KEYS)[number], "passed" | "failed" | "not_applicable">> = {}) {
    return {
        results: [
            {
                resultId: "result-1",
                checks: ECOMMERCE_QUALITY_CHECK_KEYS.map((key) => ({
                    key,
                    status: overrides[key] || (key === "brand_logo" || key === "packaging_text" ? "not_applicable" : "passed"),
                    reason: overrides[key] === "failed" ? `${key} mismatch` : "ok",
                })),
            },
        ],
    };
}

function plan(): EcommerceEditPlan {
    return {
        planVersion: "ecommerce-edit.v1",
        operation: "product_to_scene",
        source: { productAnchorId: "product-1", currentSceneBaselineId: null, sceneReferenceIds: [] },
        baseline: {
            productFacts: { identity: "oak bed", outline: "rectangular bed frame", color: "oak", material: "wood", brandText: [], view: "front three-quarter" },
            sceneFacts: { space: "bedroom", composition: "eye level", lighting: "soft daylight" },
        },
        delta: { requestedChanges: ["place in a modern bedroom"], targetObjects: ["scene"], targetRegions: ["background"] },
        preserve: { productCore: ["outline", "brand_text", "color", "material", "scale", "view"], sceneElements: [] },
        strategy: "strict_product",
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality-model" },
        continuity: { parentResultId: null, branchId: "branch-1" },
        validation: { requiredChecks: ["product_identity"] },
    };
}

function scenePlan(): EcommerceEditPlan {
    return {
        ...plan(),
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene-1", sceneReferenceIds: [] },
        baseline: {
            productFacts: null,
            sceneFacts: { space: "living room", composition: "eye level", lighting: "soft daylight" },
        },
        delta: {
            requestedChanges: ["改成冬日阳光"],
            targetObjects: ["lighting-main"],
            targetRegions: ["whole-scene"],
        },
        preserve: { productCore: [], sceneElements: ["layout", "furniture", "camera"] },
        strategy: "integrated_scene",
        validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
    } as EcommerceEditPlan;
}
