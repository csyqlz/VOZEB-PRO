import { describe, expect, it } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { ecommerceGenerationEnabled } from "./ecommerce-generation-service";
import { classifyReferenceRoles, resolveDualBaseline } from "./ecommerce-reference-roles";

describe("ecommerce dual-baseline continuity", () => {
    const product = image("product-original");
    const older = image("result-older", { sourceRunId: "run-older", parentAssetId: product.id, createdAt: 10 });
    const latest = image("result-latest", { sourceRunId: "run-latest", parentAssetId: product.id, createdAt: 20 });

    it("inherits the latest successful scene while retaining the original product anchor", () => {
        const sources = resolveDualBaseline(run([]), { assets: [], decision: classifyReferenceRoles([], []), results: [older, latest] });

        expect(sources).toMatchObject({ status: "resolved", productAnchorId: product.id, currentSceneBaselineId: latest.id, parentResultId: latest.id });
        expect(ecommerceGenerationEnabled("internal", { surface: "chat", referencedAssetIds: [], generationPreferences: { mode: "image" } }, Boolean(sources.currentSceneBaselineId))).toBe(true);
    });

    it("branches from the exact older result selected by stable asset ID", () => {
        const sources = resolveDualBaseline(run([older.id]), { assets: [], decision: classifyReferenceRoles([], []), results: [latest, older] });

        expect(sources).toMatchObject({ status: "resolved", productAnchorId: product.id, currentSceneBaselineId: older.id, parentResultId: older.id, createsBranch: true });
    });

    it("starts a new product anchor when a new white-background product is uploaded", () => {
        const replacement = image("product-replacement");
        const decision = classifyReferenceRoles([replacement], [{ assetId: replacement.id, confidence: "high", whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false }]);

        expect(resolveDualBaseline(run([replacement.id]), { assets: [replacement], decision, results: [latest] })).toMatchObject({
            status: "resolved",
            productAnchorId: replacement.id,
            currentSceneBaselineId: null,
            parentResultId: null,
            startsNewProductAnchor: true,
        });
    });

    it("keeps the prior result only as branch parent for a replacement product and new room", () => {
        const replacement = image("product-replacement");
        const room = image("room-reference");
        const decision = classifyReferenceRoles(
            [replacement, room],
            [
                { assetId: replacement.id, confidence: "high", whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                { assetId: room.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
            ],
        );

        expect(resolveDualBaseline(run([replacement.id, room.id]), { assets: [replacement, room], decision, results: [latest] })).toMatchObject({
            status: "resolved",
            productAnchorId: replacement.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [room.id],
            parentResultId: latest.id,
            startsNewProductAnchor: true,
            createsBranch: true,
        });
    });

    it("keeps a newly uploaded room separate from the product anchor and prior result lineage", () => {
        const scene = image("scene-reference");
        const decision = classifyReferenceRoles([scene], [{ assetId: scene.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true }]);

        expect(resolveDualBaseline(run([scene.id]), { assets: [scene], decision, results: [latest] })).toMatchObject({
            status: "resolved",
            productAnchorId: product.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [scene.id],
            parentResultId: latest.id,
        });
    });

    it("uses an explicitly selected older result as branch parent when a new scene is uploaded", () => {
        const scene = image("scene-reference");
        const decision = classifyReferenceRoles([scene], [{ assetId: scene.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true }]);

        expect(resolveDualBaseline(run([older.id, scene.id]), { assets: [scene], decision, results: [latest, older] })).toMatchObject({
            status: "resolved",
            productAnchorId: product.id,
            currentSceneBaselineId: null,
            sceneReferenceIds: [scene.id],
            parentResultId: older.id,
        });
    });

    it("does not infer a product anchor from a title or prompt", () => {
        const unlinked = image("result-unlinked", { sourceRunId: "run-unlinked", title: "product-original result", metadata: { prompt: "use product-original" } });

        expect(resolveDualBaseline(run([]), { assets: [], decision: classifyReferenceRoles([], []), results: [unlinked] })).toMatchObject({
            status: "needs_clarification",
            ambiguityReason: "missing_product_anchor",
        });
    });

    it("continues a scene root without a product and branches from the selected older result", () => {
        const metadata = { ecommerceContinuity: { productAnchorId: null, sceneRootAssetId: "scene-root", branchId: "scene-branch", parentResultId: null } };
        const earlier = image("scene-earlier", { sourceRunId: "scene-run-earlier", parentAssetId: "scene-root", metadata, createdAt: 10 });
        const newer = image("scene-newer", { sourceRunId: "scene-run-newer", parentAssetId: "scene-root", metadata, createdAt: 20 });
        expect(resolveDualBaseline(run([]), { assets: [], decision: classifyReferenceRoles([], []), results: [earlier, newer] })).toMatchObject({
            status: "resolved",
            productAnchorId: null,
            sceneRootAssetId: "scene-root",
            currentSceneBaselineId: newer.id,
            parentResultId: newer.id,
        });
        expect(resolveDualBaseline(run([earlier.id]), { assets: [], decision: classifyReferenceRoles([], []), results: [newer, earlier] })).toMatchObject({
            status: "resolved",
            productAnchorId: null,
            sceneRootAssetId: "scene-root",
            currentSceneBaselineId: earlier.id,
            parentResultId: earlier.id,
            createsBranch: true,
        });
    });

    it("starts a new scene root on a fresh room upload after a scene-only chain", () => {
        const prior = image("scene-prior", { sourceRunId: "scene-run", metadata: { ecommerceContinuity: { productAnchorId: null, sceneRootAssetId: "old-root" } } });
        const room = image("new-root", { sourceRunId: "upload" });
        const decision = classifyReferenceRoles([room], [{ assetId: room.id, confidence: "high", whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true }]);
        expect(resolveDualBaseline(run([room.id]), { assets: [room], decision, results: [prior] })).toMatchObject({
            status: "resolved",
            productAnchorId: null,
            sceneRootAssetId: room.id,
            currentSceneBaselineId: room.id,
            parentResultId: null,
        });
    });

    it("lets an established image chain enter orchestration with a short continuation and no media classification", () => {
        expect(ecommerceGenerationEnabled("internal", { surface: "chat", referencedAssetIds: [] }, true)).toBe(true);
        expect(ecommerceGenerationEnabled("internal", { surface: "chat", referencedAssetIds: [] }, false)).toBe(false);
    });
});

function run(referencedAssetIds: string[]) {
    return { id: "run-current", referencedAssetIds };
}

function image(id: string, overrides: Partial<CreativeAsset> = {}): CreativeAsset {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image",
        status: "ready",
        title: id,
        serverUrl: `/api/reference-assets/permanent/${id}.png`,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}
