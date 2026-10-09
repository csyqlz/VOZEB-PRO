import { describe, expect, it } from "vitest";

import type { AuthSettings } from "@/lib/auth/store";

import { resolveEcommerceModelRole } from "./agent-run-surface-policy";

describe("ecommerce logical model roles", () => {
    it("allows visual analysis and edit planning to select different configurable logical models", () => {
        const settings = routingSettings();

        const vision = resolveEcommerceModelRole(settings, "vision_analysis", { vision_analysis: "vision-pro" });
        const planning = resolveEcommerceModelRole(settings, "edit_planning", { edit_planning: "planner-pro" });

        expect(vision).toMatchObject({ logicalRole: "vision_analysis", logicalModelId: "vision-pro", candidates: [{ upstreamModel: "vendor/vision" }] });
        expect(planning).toMatchObject({ logicalRole: "edit_planning", logicalModelId: "planner-pro", candidates: [{ upstreamModel: "vendor/planner" }] });
    });

    it("does not route a text role through an image logical model", () => {
        const result = resolveEcommerceModelRole(routingSettings(), "vision_analysis", { vision_analysis: "image-default" });

        expect(result).toMatchObject({ logicalModelId: "image-default", candidates: [] });
    });
});

function routingSettings(): Pick<AuthSettings, "defaultModels" | "logicalModels" | "systemChannels"> {
    const channels = [
        { id: "text", name: "text", baseUrl: "https://example.com/v1", apiKey: "secret", apiFormat: "openai" as const, models: ["vendor/vision", "vendor/planner"], enabled: true },
        { id: "image", name: "image", baseUrl: "https://example.com/v1", apiKey: "secret", apiFormat: "openai" as const, models: ["vendor/image"], enabled: true },
    ];
    return {
        systemChannels: channels,
        logicalModels: [
            { id: "vision-pro", name: "Vision", capability: "text", enabled: true, bindings: [{ id: "vision", channelId: "text", upstreamModel: "vendor/vision", enabled: true, priority: 1 }] },
            { id: "planner-pro", name: "Planner", capability: "text", enabled: true, bindings: [{ id: "planner", channelId: "text", upstreamModel: "vendor/planner", enabled: true, priority: 1 }] },
            { id: "image-default", name: "Image", capability: "image", enabled: true, bindings: [{ id: "image", channelId: "image", upstreamModel: "vendor/image", enabled: true, priority: 1 }] },
        ],
        defaultModels: { textModel: "vision-pro", imageModel: "image-default", videoModel: "", audioModel: "" },
    };
}
