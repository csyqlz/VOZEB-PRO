import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { SystemChannelProtocol } from "@/lib/auth/store-types";
import { compileEcommerceImageCandidates, compileEcommerceImageRequest, resolveEcommerceImageProviderProfile } from "./ecommerce-image-compiler";
import { assertEcommerceImageExecutionSnapshot, prepareEcommerceImageTask } from "./ecommerce-image-task-orchestration";
import { resolveEcommerceRoleCandidates, routeEcommerceRole, type EcommerceModelRoutingSettings } from "./ecommerce-model-routing";
import { buildSceneEditProtection } from "./ecommerce-product-regions";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";
import type { ImageTaskConfig } from "./image-task-store";

const plan: EcommerceEditPlan = {
    planVersion: "ecommerce-edit.v3",
    operation: "scene_edit",
    source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
    baseline: { productFacts: null, sceneFacts: { space: "room", composition: "front", lighting: "soft" } },
    canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
    protection: { scope: "local", protectedObjectIds: ["cabinet"], preserveOutsideMask: true, allowLightingChange: false },
    delta: { requestedChanges: ["add vase"], targetObjects: ["vase"], targetRegions: ["cabinet top"] },
    preserve: { productCore: [], sceneElements: ["room"] },
    strategy: "integrated_scene",
    modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: null },
    continuity: { branchId: "branch", parentResultId: null },
    validation: { requiredChecks: ["outside_mask"] },
};

function settings(protocol: SystemChannelProtocol = "sub2api"): EcommerceModelRoutingSettings {
    return {
        defaultModels: { textModel: "", imageModel: "image", videoModel: "", audioModel: "" },
        systemChannels: [
            {
                id: "image-channel",
                name: "image",
                baseUrl: "https://image.example.com",
                apiKey: "fixture-key",
                apiFormat: "openai",
                models: ["gpt-image-2.5-sunburst"],
                enabled: true,
                advancedConfig: { ...emptyAdvancedConfig(), protocol, createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
            },
        ],
        logicalModels: [{ id: "image", name: "image", capability: "image", enabled: true, bindings: [{ id: "binding", channelId: "image-channel", upstreamModel: "gpt-image-2.5-sunburst", enabled: true, priority: 1 }] }],
    };
}

function config(configured: EcommerceModelRoutingSettings): ImageTaskConfig {
    const channel = configured.systemChannels[0];
    return { model: channel.models[0], apiKey: "fixture-key", apiFormat: channel.apiFormat, baseUrl: channel.baseUrl, channelId: channel.id, advancedConfig: channel.advancedConfig };
}

describe("ecommerce local mask binding contract", () => {
    it("chooses a mask-capable binding within the requested logical model before selection, while global edits keep channel order", () => {
        const configured = settings("openai");
        const first = configured.systemChannels[0];
        first.advancedConfig!.referenceRule = "JSON images[].image_url";
        configured.systemChannels.push({ ...structuredClone(first), id: "native-channel", advancedConfig: { ...emptyAdvancedConfig(), protocol: "sub2api" } });
        configured.logicalModels[0].bindings.push({ id: "native-binding", channelId: "native-channel", upstreamModel: first.models[0], enabled: true, priority: 2 });
        const candidates = resolveEcommerceRoleCandidates(configured, "image_generation", "image");
        const local = compileEcommerceImageCandidates(plan, candidates)!;
        expect(local.candidate).toMatchObject({ logicalModelId: "image", channelId: "native-channel" });
        expect(local.execution).toMatchObject({ state: "ready", mask: { required: true }, modelSnapshot: { channelId: "native-channel" } });
        const global = compileEcommerceImageCandidates({ ...plan, protection: { ...plan.protection!, scope: "global", preserveOutsideMask: false, allowLightingChange: true } }, candidates)!;
        expect(global.candidate.channelId).toBe("image-channel");
        expect(global.execution.mask).toBeUndefined();
        expect(compileEcommerceImageCandidates(plan, candidates.slice(0, 1))?.execution.state).toBe("needs_review");
    });
    it.each(["openai", "sub2api"] as const)("continues confirmed selection using the actual %s independent mask binding", async (protocol) => {
        const configured = settings(protocol);
        const route = routeEcommerceRole(configured, "image_generation")!;
        const execution = compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(route.snapshot)!);
        const source = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        const sceneProtection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase"], "user_selection");
        const prepared = prepareEcommerceImageTask({
            kind: "edit",
            prompt: execution.prompt,
            references: [{ id: "scene", ecommerceRole: "scene", dataUrl: "data:image/png;base64," + source.toString("base64") }],
            ecommerceExecution: execution,
            compatibleConfigs: [config(configured)],
            sceneProtection,
        });
        expect(execution.state).toBe("ready");
        expect(prepared.reviewReason).toBe("");
        expect(prepared.mask).toEqual(sceneProtection.mask);
        expect(prepared.sceneProtection).toEqual(sceneProtection);
        expect(prepared.config.advancedConfig?.protocol).toBe(protocol);
    });

    it("does not ask the user to frame an area when the actual JSON transport has no independent mask contract", () => {
        const configured = settings("openai");
        configured.systemChannels[0].advancedConfig!.referenceRule = "JSON images[].image_url";
        const route = routeEcommerceRole(configured, "image_generation")!;
        const execution = compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(route.snapshot)!);
        expect(execution).toMatchObject({ state: "needs_review", reason: "independent_mask_unsupported" });
        const readyShape = { ...execution, state: "ready" as const, mask: { mode: "independent" as const, required: true as const } };
        const prepared = prepareEcommerceImageTask({ kind: "edit", prompt: execution.prompt, references: [{ id: "scene", ecommerceRole: "scene", dataUrl: "fixture" }], ecommerceExecution: readyShape, compatibleConfigs: [config(configured)] });
        expect(prepared.reviewReason).toContain("独立蒙版");
        expect(prepared.reviewReason).not.toContain("请在原图");
    });

    it.each(["openai", "json"] as const)("rejects changed %s transport for an unsubmitted legacy mask task without imageEdit in its snapshot", (transport) => {
        const configured = settings();
        const original = routeEcommerceRole(configured, "image_generation")!;
        const frozenConfig = config(configured);
        const execution = compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(original.snapshot)!);
        delete execution.modelSnapshot.imageEdit;
        expect(() => assertEcommerceImageExecutionSnapshot(configured, execution, frozenConfig)).not.toThrow();
        configured.systemChannels[0].advancedConfig = { ...emptyAdvancedConfig(), protocol: "openai", ...(transport === "json" ? { referenceRule: "JSON images[].image_url" } : {}) };
        expect(() => assertEcommerceImageExecutionSnapshot(configured, execution, frozenConfig)).toThrow("失效");
    });

    it("freezes effective model-level protocol and rejects changed edit transport on replay", () => {
        const configured = settings("openai");
        configured.systemChannels[0].advancedConfig!.modelConfigs = {
            "gpt-image-2.5-sunburst": { capability: "image", protocol: "sub2api", apiFormat: "openai", createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
        };
        const original = resolveEcommerceRoleCandidates(configured, "image_generation", "image")[0];
        expect(original.snapshot).toMatchObject({ imageEdit: { protocol: "sub2api", editPath: "/images/edits", transport: "json", supportsIndependentMask: true } });
        const execution = compileEcommerceImageRequest(plan, resolveEcommerceImageProviderProfile(original.snapshot)!);
        configured.systemChannels[0].advancedConfig!.modelConfigs!["gpt-image-2.5-sunburst"].editPath = "/images/generations";
        expect(routeEcommerceRole(configured, "image_generation", original.snapshot)).toBeNull();
        expect(() => assertEcommerceImageExecutionSnapshot(configured, execution)).toThrow("失效");
    });
});
