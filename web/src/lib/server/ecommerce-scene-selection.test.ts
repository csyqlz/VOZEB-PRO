import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "./agent-run-store";

const mocks = vi.hoisted(() => ({ assets: vi.fn(), fetch: vi.fn() }));
vi.mock("./creative-runtime-store", () => ({ getCreativeAssetsByIds: mocks.assets }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetch }));
import { prepareEcommerceSceneSelectionResume } from "./ecommerce-generation-service";
import { compileEcommerceImageRequest } from "./ecommerce-image-compiler";
import type { EcommerceEditPlan } from "./ecommerce-edit-plan";

const selection = { baselineAssetId: "scene", region: { x: 2, y: 1, width: 2, height: 2 } };
const baseline = { id: "scene", type: "image", userId: "user", conversationId: "conversation", serverUrl: "/api/reference-assets/scene.png", status: "ready", metadata: {}, title: "scene", width: 6, height: 4 };

function pausedRun(): AgentRun {
    const plan: EcommerceEditPlan = {
        planVersion: "ecommerce-edit.v3",
        operation: "scene_edit",
        source: { productAnchorId: null, currentSceneBaselineId: "scene", sceneReferenceIds: [] },
        baseline: { productFacts: null, sceneFacts: { space: "room", composition: "front", lighting: "soft" } },
        canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
        protection: { scope: "local", protectedObjectIds: ["doors", "drawers", "handles", "background"], preserveOutsideMask: true, allowLightingChange: false },
        delta: { requestedChanges: ["add vase and contact shadow"], targetObjects: ["vase"], targetRegions: ["cabinet top"], manualRegion: { x: 0, y: 0, width: 1, height: 1 } },
        preserve: { productCore: [], sceneElements: ["cabinet", "room"] },
        strategy: "integrated_scene",
        modelRoles: { visionAnalysis: "vision", editPlanning: "planner", generation: "image", qualityCheck: "quality" },
        continuity: { branchId: "branch", parentResultId: null },
        validation: { requiredChecks: ["outside_mask"] },
    };
    const execution = compileEcommerceImageRequest(plan, {
        profileId: "gpt-image-2.5-flare",
        compilerFamily: "openai-image-2.5",
        supportsIndependentMask: true,
        modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
    });
    return {
        id: "run",
        userId: "user",
        conversationId: "conversation",
        prompt: "add vase",
        status: "paused",
        tasks: [{ id: "scene-task", status: "needs_review", attempts: 0, count: 1, ecommerceExecution: execution }],
        ecommerceSnapshot: {
            version: "ecommerce-generation.v1",
            mode: "active",
            input: { userRequest: "add vase", assetIds: ["scene"], conversationId: "conversation", surface: "chat" },
            plan,
            fallback: { reason: "scene_selection_required" },
            createdAt: 1,
        },
    } as AgentRun;
}

describe("authenticated scene selection refinement", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.assets.mockResolvedValue([baseline]);
        const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } })
            .png()
            .toBuffer();
        mocks.fetch.mockImplementation(async () => new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    });
    it("uses only user-confirmed pixels while preserving the original plan, role and task identity", async () => {
        const run = pausedRun();
        const original = structuredClone(run);
        const [task] = await prepareEcommerceSceneSelectionResume(run, selection, "http://fixture.local", "fixture-session", "user");
        expect(run).toEqual(original);
        expect(task).toMatchObject({ id: "scene-task", status: "ready", attempts: 0, referenceAssetId: "scene", sceneProtection: { selectionSource: "user_selection", targetRegion: selection.region, sourceSize: { width: 6, height: 4 } } });
        expect(task.ecommerceExecution).toEqual(run.tasks[0].ecommerceExecution);
        expect(task.sceneProtection?.confirmation).toEqual({ actorUserId: "user", confirmedAt: expect.any(Number) });
        expect(task.sceneProtection?.targetRegion).not.toEqual(run.ecommerceSnapshot?.plan?.delta.manualRegion);
        expect(mocks.assets).toHaveBeenCalledWith(["scene"], "user");
    });
    it.each(["ecommerce-edit.v1", "ecommerce-edit.v2"])("never upgrades a saved %s snapshot through selection", async (version) => {
        const run = pausedRun();
        run.ecommerceSnapshot!.plan!.planVersion = version as EcommerceEditPlan["planVersion"];
        await expect(prepareEcommerceSceneSelectionResume(run, selection, "http://fixture.local", "fixture", "user")).rejects.toThrow("不能确认");
    });
    it.each(["ecommerce-edit.v4", "ecommerce-edit.v5"])("confirms a %s selection without rewriting its original facts or protection semantics", async (version) => {
        const run = pausedRun();
        run.ecommerceSnapshot!.plan!.planVersion = version as EcommerceEditPlan["planVersion"];
        run.ecommerceSnapshot!.plan!.visibleStructure = [{ objectId: "cabinet", feature: "doors", count: 2, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 6, height: 4 } }];
        if (version === "ecommerce-edit.v5") {
            const photography = {
                materials: [{ objectId: "cabinet", textureDirection: "纵向木纹", textureScale: "细木纹", roughness: "哑光", gloss: "低光泽" }],
                lighting: { keyLight: "柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "局部接触阴影" },
                composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
            };
            run.ecommerceSnapshot!.plan!.photography = photography;
            run.tasks[0].ecommerceExecution!.photography = structuredClone(photography);
            run.tasks[0].ecommerceExecution!.compilerVersion = "ecommerce-openai-image-2.5.v3";
        }
        const before = structuredClone(run);
        expect(await prepareEcommerceSceneSelectionResume(run, selection, "http://fixture.local", "fixture", "user")).toHaveLength(1);
        expect(run).toEqual(before);
        if (version === "ecommerce-edit.v4") expect(run.ecommerceSnapshot!.plan).not.toHaveProperty("photography");
    });
    it.each(["submitted", "qa", "scope", "running", "already_confirmed"])("rejects selection for $0", async (state) => {
        const run = pausedRun();
        if (state === "submitted") run.tasks[0].taskId = "existing-child";
        if (state === "qa") run.ecommerceSnapshot!.qualityCheck = {} as NonNullable<AgentRun["ecommerceSnapshot"]>["qualityCheck"];
        if (state === "scope") run.ecommerceSnapshot!.plan!.protection!.scope = "global";
        if (state === "running") run.status = "running";
        if (state === "already_confirmed") run.tasks[0].sceneProtection = {} as NonNullable<AgentRun["tasks"][number]["sceneProtection"]>;
        await expect(prepareEcommerceSceneSelectionResume(run, selection, "http://fixture.local", "fixture", "user")).rejects.toThrow("不能确认");
    });
    it.each([null, { ...selection, baselineAssetId: "other" }, { ...selection, region: { x: 5, y: 1, width: 2, height: 2 } }])("rejects invalid or stale selection %j", async (input) => {
        await expect(prepareEcommerceSceneSelectionResume(pausedRun(), input, "http://fixture.local", "fixture", "user")).rejects.toThrow();
    });
    it("rejects another user's asset and mismatched real canvas dimensions", async () => {
        mocks.assets.mockResolvedValue([{ ...baseline, userId: "other" }]);
        await expect(prepareEcommerceSceneSelectionResume(pausedRun(), selection, "http://fixture.local", "fixture", "user")).rejects.toThrow("访问权限");
        mocks.assets.mockResolvedValue([baseline]);
        const run = pausedRun();
        run.ecommerceSnapshot!.plan!.canvas!.size.width = 8;
        await expect(prepareEcommerceSceneSelectionResume(run, selection, "http://fixture.local", "fixture", "user")).rejects.toThrow("画幅");
    });
});
