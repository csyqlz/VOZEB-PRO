import { describe, expect, it } from "vitest";

import type { AuthSettings, LogicalModel } from "@/lib/auth/store";
import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";
import { normalizeSettings } from "@/lib/auth/store-normalizers";
import { EMPTY_ECOMMERCE_MODEL_ROLES, ecommerceModelRoleValidationErrors, normalizeEcommerceModelRoles } from "./ecommerce-model-role-config";

const logicalModels: LogicalModel[] = [
    { id: "vision-fast", name: "Vision Fast", capability: "text", enabled: true, bindings: [] },
    { id: "planner-pro", name: "Planner Pro", capability: "text", enabled: true, bindings: [] },
    { id: "image-2.5", name: "Image 2.5", capability: "image", enabled: true, bindings: [] },
];

describe("ecommerce model role config", () => {
    it("gives legacy settings empty role lists so runtime defaults remain the fallback", () => {
        const legacy = { ...structuredClone(DEFAULT_SETTINGS), ecommerceModelRoles: undefined } as unknown as AuthSettings;

        expect(normalizeSettings(legacy).ecommerceModelRoles).toEqual(EMPTY_ECOMMERCE_MODEL_ROLES);
    });

    it("keeps configured priority while trimming duplicates and capability mismatches", () => {
        expect(
            normalizeEcommerceModelRoles(
                {
                    vision_analysis: [" planner-pro ", "vision-fast", "planner-pro", "image-2.5"],
                    edit_planning: ["planner-pro"],
                    image_generation: ["image-2.5", "vision-fast"],
                    quality_check: ["vision-fast"],
                },
                logicalModels,
            ),
        ).toEqual({
            vision_analysis: ["planner-pro", "vision-fast"],
            edit_planning: ["planner-pro"],
            image_generation: ["image-2.5"],
            quality_check: ["vision-fast"],
        });
    });

    it("reports unknown and capability-mismatched assignments before an admin save", () => {
        expect(
            ecommerceModelRoleValidationErrors(
                {
                    vision_analysis: ["missing"],
                    edit_planning: [],
                    image_generation: ["planner-pro"],
                    quality_check: [],
                },
                logicalModels,
            ),
        ).toEqual([expect.stringContaining("missing"), expect.stringContaining("planner-pro")]);
    });

    it("preserves every administrator-configured candidate without an invented fixed cap", () => {
        const candidates = Array.from({ length: 25 }, (_, index) => ({
            id: `vision-${index}`,
            name: `Vision ${index}`,
            capability: "text" as const,
            enabled: true,
            bindings: [],
        }));

        expect(normalizeEcommerceModelRoles({ vision_analysis: candidates.map((model) => model.id) }, candidates).vision_analysis).toEqual(candidates.map((model) => model.id));
    });
});
