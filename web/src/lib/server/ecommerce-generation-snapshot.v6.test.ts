import { describe, expect, it } from "vitest";

import { ecommerceSceneSelectionTask, recordEcommerceGenerationSnapshot, type EcommerceGenerationSnapshot } from "./ecommerce-generation-snapshot";

describe("ecommerce v6 scene selection projection", () => {
    it("freezes a cue-evidence pause without converting it into purpose ambiguity", () => {
        const snapshot: EcommerceGenerationSnapshot = {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: "参考图片1光线，修改图片2灯光", assetIds: ["reference", "target"], conversationId: "fixture", surface: "chat" },
            referenceDecision: {
                version: "ecommerce-reference-decision.v1",
                state: "needs_confirmation",
                editTargetId: "target",
                productAnchorId: "target",
                currentSceneBaselineId: null,
                bindings: [
                    { assetId: "reference", alias: "图片1", purposes: ["lighting"], source: "explicit" },
                    { assetId: "target", alias: "图片2", purposes: ["edit_target", "product_identity"], source: "explicit" },
                ],
                appliedCues: [],
                issues: [{ code: "reference_cue_unreliable", assetId: "reference", path: "cues.lighting", message: "光线线索不足" }],
            },
            fallback: { reason: "reference_cue_unreliable" },
            stageTimings: { analysisCompletedAt: 10 },
            createdAt: 10,
        };
        const original = structuredClone(snapshot);
        const saved = recordEcommerceGenerationSnapshot({ id: "run", userId: "user" }, snapshot);
        snapshot.referenceDecision!.issues[0].path = "bindings";
        snapshot.referenceDecision!.bindings[0].purposes = ["style"];
        expect(saved).toMatchObject(original);
        expect(saved.plan).toBeUndefined();
        expect(saved.compilerVersion).toBeUndefined();
    });
    it("returns a paused v6 local scene-edit task awaiting user selection", () => {
        const task = {
            status: "needs_review",
            attempts: 0,
            ecommerceExecution: { state: "ready" },
        };
        const run = {
            status: "paused",
            cancellation: null,
            tasks: [task],
            ecommerceSnapshot: {
                mode: "active",
                fallback: { reason: "scene_selection_required" },
                plan: {
                    planVersion: "ecommerce-edit.v6",
                    operation: "scene_edit",
                    source: { currentSceneBaselineId: "scene-baseline" },
                    protection: { scope: "local" },
                },
            },
        } as never;

        expect(ecommerceSceneSelectionTask(run)).toBe(task);
    });
});
