import { describe, expect, it } from "vitest";
import { hasUnresolvedEcommerceCheckpoint } from "./agent-run-checkpoint";

describe("agent run ecommerce checkpoints", () => {
    it.each(["reference_purpose_confirmation_required", "reference_cue_unreliable", "visual_analysis_unavailable", "reference_roles_need_review", "product_edit_not_supported"])(
        "keeps an unresolved %s task paused before any upstream identity exists",
        (reason) => {
            expect(hasUnresolvedEcommerceCheckpoint({ ecommerceSnapshot: { fallback: { reason } } }, { status: "needs_review" })).toBe(true);
        },
    );

    it("allows a checkpoint task to resume after an upstream task identity or confirmed protection exists", () => {
        const run = { ecommerceSnapshot: { fallback: { reason: "scene_selection_required" } } };
        expect(hasUnresolvedEcommerceCheckpoint(run, { status: "needs_review", taskId: "upstream-1" })).toBe(false);
        expect(hasUnresolvedEcommerceCheckpoint(run, { status: "ready", sceneProtection: { sourceAssetId: "scene" } })).toBe(false);
    });

    it("does not gate ordinary tasks or quality review recovery", () => {
        expect(hasUnresolvedEcommerceCheckpoint({ ecommerceSnapshot: { fallback: { reason: "ecommerce_planner_disabled" } } }, { status: "ready" })).toBe(false);
        expect(hasUnresolvedEcommerceCheckpoint({ ecommerceSnapshot: { fallback: { reason: "quality_check" } } }, { status: "needs_review", taskIds: ["upstream-1"] })).toBe(false);
        expect(hasUnresolvedEcommerceCheckpoint({ ecommerceSnapshot: { fallback: { reason: "reference_cue_unreliable" } } }, { status: "needs_review", taskId: "upstream-1" })).toBe(false);
    });
});
