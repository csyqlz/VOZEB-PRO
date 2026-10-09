import { describe, expect, it } from "vitest";

import type { LogicalModel } from "@/lib/auth/store";
import { addEcommerceRoleModel, availableEcommerceRoleModels, moveEcommerceRoleModel, removeEcommerceRoleModel } from "./ecommerce-model-role-settings";

const models: LogicalModel[] = [
    { id: "vision-fast", name: "Vision Fast", capability: "text", enabled: true, bindings: [] },
    { id: "planner-pro", name: "Planner Pro", capability: "text", enabled: true, bindings: [] },
    { id: "image-2.5", name: "Image 2.5", capability: "image", enabled: true, bindings: [] },
    { id: "image-disabled", name: "Image Disabled", capability: "image", enabled: false, bindings: [] },
];

describe("admin ecommerce model role settings", () => {
    it("offers only enabled models with the capability required by the role", () => {
        expect(availableEcommerceRoleModels(models, "vision_analysis").map((model) => model.id)).toEqual(["vision-fast", "planner-pro"]);
        expect(availableEcommerceRoleModels(models, "image_generation").map((model) => model.id)).toEqual(["image-2.5"]);
    });

    it("adds, removes, and reorders candidates without duplicates", () => {
        expect(addEcommerceRoleModel(["planner-pro"], "vision-fast")).toEqual(["planner-pro", "vision-fast"]);
        expect(addEcommerceRoleModel(["planner-pro"], "planner-pro")).toEqual(["planner-pro"]);
        expect(moveEcommerceRoleModel(["planner-pro", "vision-fast"], 1, -1)).toEqual(["vision-fast", "planner-pro"]);
        expect(moveEcommerceRoleModel(["planner-pro", "vision-fast"], 0, -1)).toEqual(["planner-pro", "vision-fast"]);
        expect(removeEcommerceRoleModel(["planner-pro", "vision-fast"], "planner-pro")).toEqual(["vision-fast"]);
    });
});
