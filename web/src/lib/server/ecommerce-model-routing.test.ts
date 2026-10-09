import { describe, expect, it } from "vitest";

import type { AuthSettings } from "@/lib/auth/store";

import { resolveEcommerceRoleCandidates, routeEcommerceRole, type EcommerceModelRoutingSettings } from "./ecommerce-model-routing";

describe("ecommerce model routing", () => {
    it("keeps each logical role in its administrator-defined model order", () => {
        const settings = routingSettings();

        expect(resolveEcommerceRoleCandidates(settings, "vision_analysis", "text").map((candidate) => candidate.logicalModelId)).toEqual(["vision-primary", "vision-backup"]);
        expect(resolveEcommerceRoleCandidates(settings, "edit_planning", "text").map((candidate) => candidate.logicalModelId)).toEqual(["planner"]);
        expect(resolveEcommerceRoleCandidates(settings, "quality_check", "text").map((candidate) => candidate.logicalModelId)).toEqual(["quality"]);
        expect(resolveEcommerceRoleCandidates(settings, "image_generation", "image").map((candidate) => candidate.logicalModelId)).toEqual(["flare", "sunburst", "nano"]);
    });

    it("never admits a model from another role or capability", () => {
        const settings = routingSettings();
        settings.ecommerceModelRoles!.vision_analysis = ["flare", "vision-primary"];

        expect(resolveEcommerceRoleCandidates(settings, "vision_analysis", "text").map((candidate) => candidate.logicalModelId)).toEqual(["vision-primary"]);
        expect(resolveEcommerceRoleCandidates(settings, "vision_analysis", "image")).toEqual([]);
    });

    it("replays an exact saved route after administrators reorder role candidates", () => {
        const settings = routingSettings();
        const original = routeEcommerceRole(settings, "image_generation");
        expect(original?.logicalModelId).toBe("flare");

        settings.ecommerceModelRoles!.image_generation = ["nano", "sunburst", "flare"];
        const replayed = routeEcommerceRole(settings, "image_generation", original?.snapshot);

        expect(replayed?.snapshot).toEqual(original?.snapshot);
        expect(replayed?.logicalModelId).toBe("flare");
    });

    it("fails closed when a saved route no longer exists instead of selecting a replacement", () => {
        const settings = routingSettings();
        const original = routeEcommerceRole(settings, "image_generation");
        settings.logicalModels = settings.logicalModels.filter((model) => model.id !== "flare");

        expect(routeEcommerceRole(settings, "image_generation", original?.snapshot)).toBeNull();
        expect(routeEcommerceRole(settings, "vision_analysis", original?.snapshot)).toBeNull();
    });
});

function routingSettings(): EcommerceModelRoutingSettings {
    const models = [
        ["vision-primary", "text", "openai", "vendor/vision-primary"],
        ["vision-backup", "text", "openai", "vendor/vision-backup"],
        ["planner", "text", "openai", "vendor/planner"],
        ["quality", "text", "openai", "vendor/quality"],
        ["flare", "image", "openai", "gpt-image-2.5-flare"],
        ["sunburst", "image", "openai", "gpt-image-2.5-sunburst"],
        ["nano", "image", "gemini", "nano-banana-2"],
    ] as const;
    return {
        defaultModels: { textModel: "vision-primary", imageModel: "flare", videoModel: "", audioModel: "" },
        systemChannels: models.map(([id, capability, apiFormat, upstreamModel]) => ({
            id: `${id}-channel`,
            name: id,
            baseUrl: `https://${id}.example.com`,
            apiKey: "secret",
            apiFormat,
            models: [upstreamModel],
            enabled: true,
        })),
        logicalModels: models.map(([id, capability, , upstreamModel]) => ({
            id,
            name: id,
            capability,
            enabled: true,
            bindings: [{ id: `${id}-binding`, channelId: `${id}-channel`, upstreamModel, enabled: true, priority: 1 }],
        })) as AuthSettings["logicalModels"],
        ecommerceModelRoles: {
            vision_analysis: ["vision-primary", "vision-backup"],
            edit_planning: ["planner"],
            quality_check: ["quality"],
            image_generation: ["flare", "sunburst", "nano"],
        },
    };
}
