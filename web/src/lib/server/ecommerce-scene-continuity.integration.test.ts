import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageTask } from "./image-task-store";

const transport = vi.hoisted(() => ({ request: vi.fn(), settings: {} as never }));
vi.mock("./database", async (original) => ({ ...(await original<typeof import("./database")>()), getDatabaseProvider: () => "file" }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: async () => transport.settings, refundUserPoints: vi.fn() }));
vi.mock("./internal-origin", () => ({ fetchInternalApi: transport.request }));
vi.mock("./safe-outbound-fetch", () => ({
    fetchSafeOutbound: () => {
        throw new Error("fixture forbids external requests");
    },
}));
vi.mock("./generation-task-scheduler", async (original) => ({ ...(await original<typeof import("./generation-task-scheduler")>()), scheduleGenerationTask: vi.fn() }));
vi.mock("./generation-log-store", () => ({ attachEcommerceTraceToGenerationLogs: async () => ({ updated: 1 }) }));

import { createAgentRun, getAgentRun, selectCurrentSceneBaseline, updateAgentRunById } from "./agent-run-store";
import { executeAgentRun } from "./agent-run-executor";
import { processAgentRunReview } from "./agent-run-execution";
import { createCreativeConversation, getCreativeAssetsByIds, listCreativeRunEvents, registerCreativeAssets } from "./creative-runtime-store";
import { createStoredGenerationTask } from "./generation-task-store";
import { getImageTask } from "./image-task-store";
import { ECOMMERCE_QUALITY_CHECK_KEYS } from "./ecommerce-quality-check";
import { prepareEcommerceSceneSelectionResume } from "./ecommerce-generation-service";
import { compileEcommerceImageRequest } from "./ecommerce-image-compiler";
import { compositeSceneEdit } from "./ecommerce-product-regions";
import { referenceUsesFromEcommerceDecision } from "./ecommerce-reference-purpose";
import { settings } from "./agent-run-executor.test-fixtures";

describe("scene continuity with real services and file persistence", () => {
    let directory: string;
    let bytes: Buffer;
    let styleBytes: Buffer;
    let submissions: Array<{ id: string; body: Record<string, unknown> }>;
    let interruptAfterSubmission: boolean;
    let adjustment: boolean;
    let storedMedia: Map<string, Buffer>;
    const structure = [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 20, y: 25, width: 60, height: 45 } }] as const;
    const photography = {
        materials: [{ objectId: "cabinet", textureDirection: "vertical", textureScale: "fine", roughness: "matte", gloss: "low" }],
        lighting: { keyLight: "daylight", fillLight: "ambient fill", whiteBalance: "neutral", contactShadow: "existing contact shadow" },
        composition: { focalSubject: "cabinet", depth: "existing room depth", negativeSpace: "above cabinet" },
    };
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "vozeb-scene-continuity-"));
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("ECOMMERCE_GENERATION_ROLLOUT", "off");
        submissions = [];
        interruptAfterSubmission = false;
        adjustment = false;
        storedMedia = new Map();
        bytes = await sharp(
            Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#ddd"/><rect x="20" y="25" width="60" height="45" fill="#987654"/><path d="M20 40H80M20 55H80M45 33H55M45 48H55M45 63H55" stroke="#432"/></svg>',
            ),
        )
            .png()
            .toBuffer();
        styleBytes = await sharp({ create: { width: 70, height: 120, channels: 3, background: "#abc" } })
            .png()
            .toBuffer();
        const configured = settings("image-model", "image-channel") as unknown as {
            ecommerceGenerationEnabled: boolean;
            systemChannels: Array<{ id: string; models: string[] }>;
            logicalModels: Array<{ id: string; bindings: Array<{ upstreamModel: string }> }>;
        };
        configured.ecommerceGenerationEnabled = true;
        configured.systemChannels.find((channel) => channel.id === "image-channel")!.models = ["gpt-image-2.5-flare"];
        configured.logicalModels.find((model) => model.id === "image-model")!.bindings[0].upstreamModel = "gpt-image-2.5-flare";
        transport.settings = configured as never;
        transport.request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
            try {
                if (/\/api\/(reference-assets|generation-log-assets)\//.test(url))
                    return new Response(new Uint8Array(storedMedia.get(new URL(url).pathname) || (url.endsWith("/style-scene-upload.png") ? styleBytes : bytes)), { headers: { "content-type": "image/png" } });
                if (init?.method === "POST" && url.endsWith("/api/image-tasks")) {
                    const body = JSON.parse(String(init.body));
                    const id = `fixture-image-${submissions.length + 1}`;
                    submissions.push({ id, body });
                    const baseline = body.sceneProtection ? (await getCreativeAssetsByIds([body.sceneProtection.sourceAssetId], "scene-user"))[0] : undefined;
                    const baselineBytes = (baseline?.serverUrl && storedMedia.get(baseline.serverUrl)) || bytes;
                    const composite = body.sceneProtection ? await compositeSceneEdit(baselineBytes, bytes, body.sceneProtection) : undefined;
                    storedMedia.set(`/api/generation-log-assets/${id}.png`, composite?.bytes || bytes);
                    storedMedia.set(`/api/generation-log-assets/${id}-native.png`, bytes);
                    const image = {
                        id,
                        userId: "scene-user",
                        status: "success",
                        config: body.config,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        result: {
                            dataUrl: `/api/generation-log-assets/${id}.png`,
                            serverUrl: `/api/generation-log-assets/${id}.png`,
                            canvasEvidence: { constraint: body.ecommerceExecution.canvas, nativeSize: { width: 100, height: 80 }, storedSize: { width: 100, height: 80 }, nativeUrl: `/api/generation-log-assets/${id}-native.png`, normalization: "none" },
                            ...(composite ? { sceneProtectionEvidence: composite.evidence } : {}),
                        },
                    } as ImageTask;
                    await createStoredGenerationTask("image", image, 60_000);
                    return Response.json({ task: { id } });
                }
                if (url.includes("/api/image-tasks/")) {
                    if (interruptAfterSubmission) {
                        interruptAfterSubmission = false;
                        return new Response("temporarily unavailable", { status: 503 });
                    }
                    const child = await getImageTask(url.split("/").at(-1)!);
                    return Response.json({ task: child });
                }
                const body = JSON.parse(String(init?.body));
                const nativeTool = body.tools?.[0]?.name || body.tools?.[0]?.function?.name;
                const messages = body.messages || body.input;
                const content = messages.find((message: { role: string }) => message.role === "user").content;
                const payloads = (typeof content === "string" ? [content] : content.filter((item: { text?: string }) => item.text?.startsWith("{")).map((item: { text: string }) => item.text)).map((text: string) => JSON.parse(text));
                const payload = payloads.find((value: { assets?: unknown[]; sources?: unknown; resultIds?: string[] }) => Array.isArray(value.assets) || Boolean(value.sources) || Array.isArray(value.resultIds));
                if (!payload) throw new Error("Fixture request is missing its stage payload");
                const tool = nativeTool || (Array.isArray(payload.assets) ? "analyze_ecommerce_references" : payload.sources ? "plan_ecommerce_edit" : "check_ecommerce_results");
                let argumentsValue;
                if (tool === "analyze_ecommerce_references")
                    argumentsValue = {
                        analysisVersion: "ecommerce-visual-analysis.v4",
                        purposeSuggestions: payload.assets.filter((asset: { id: string }) => asset.id === "style-scene-upload").map((asset: { id: string }) => ({ assetId: asset.id, purposes: ["style", "lighting"], confidence: "high" })),
                        references: payload.assets.map((asset: { id: string }) => ({
                            assetId: asset.id,
                            contentType: "interior_scene",
                            confidence: "high",
                            visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                            productFacts: null,
                            sceneFacts: { space: "living room", composition: "eye level", lighting: "daylight" },
                            productCore: null,
                            fusionHalo: null,
                            editableTargets: [{ id: "lighting", kind: "lighting", label: "lighting", region: { x: 0, y: 0, width: 1, height: 1 } }],
                            visibleStructure: asset.id === "style-scene-upload" ? [] : structure,
                            photographyFacts: photography,
                            cues:
                                asset.id === "style-scene-upload"
                                    ? [
                                          { id: "scene-light", facet: "lighting", confidence: "high", description: "soft window daylight" },
                                          { id: "scene-style", facet: "style", confidence: "high", description: "minimal interior styling" },
                                      ]
                                    : [],
                        })),
                    };
                else if (tool === "plan_ecommerce_edit") {
                    const local = payload.userRequest.includes("花瓶");
                    argumentsValue = {
                        planVersion: "ecommerce-edit.v6",
                        operation: "scene_edit",
                        source: { productAnchorId: null, currentSceneBaselineId: payload.sources.currentSceneBaselineId, sceneReferenceIds: payload.sources.sceneReferenceIds },
                        referenceUses: referenceUsesFromEcommerceDecision({ decision: payload.referenceDecision, sourceOrder: [payload.sources.currentSceneBaselineId, ...payload.sources.sceneReferenceIds] }),
                        baseline: { productFacts: null, sceneFacts: payload.visualAnalysis.references.find((reference: { assetId: string }) => reference.assetId === payload.sources.currentSceneBaselineId).sceneFacts },
                        delta: {
                            requestedChanges: [payload.userRequest, ...payload.visualAnalysis.references.flatMap((reference: { cues: Array<{ description: string }> }) => reference.cues.map((cue) => cue.description))],
                            targetObjects: [local ? "vase" : "lighting"],
                            targetRegions: [local ? "cabinet-top" : "whole-scene"],
                        },
                        preserve: { productCore: [], sceneElements: ["layout", "camera"] },
                        protection: { scope: local ? "local" : "global", protectedObjectIds: ["cabinet"], preserveOutsideMask: local, allowLightingChange: !local },
                        visibleStructure: structure,
                        photography,
                        strategy: "integrated_scene",
                        modelRoles: payload.requiredModelRoles,
                        continuity: payload.continuity,
                        validation: { requiredChecks: ["requested_edit", "scene_preservation", "composition_lighting"] },
                    };
                } else if (tool === "check_ecommerce_results") {
                    const independent = Object.hasOwn(payload.plan, "structureRegionHints");
                    // Deterministic observations are independent of the planner's counts.
                    const observation = {
                        readable: true,
                        logo: "absent",
                        packagingText: "absent",
                        visibleStructure: [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 20, y: 25, width: 60, height: 45 } }],
                    };
                    argumentsValue = {
                        ...(independent ? { baselineObservation: observation } : {}),
                        results: payload.resultIds.map((resultId: string) => ({
                            resultId,
                            ...(independent ? { observation } : {}),
                            checks: (independent ? ECOMMERCE_QUALITY_CHECK_KEYS : ECOMMERCE_QUALITY_CHECK_KEYS.slice(0, 8)).map((key, index) => ({
                                key,
                                status: index === 4 || index === 5 ? "not_applicable" : adjustment && key === "scene_intent" ? "failed" : "passed",
                                reason: adjustment && key === "scene_intent" ? "vase is too large" : "visible scene evidence",
                            })),
                        })),
                    };
                } else throw new Error(`unexpected fixture tool ${tool}`);
                const argumentsText = JSON.stringify(argumentsValue);
                return body.messages
                    ? Response.json({
                          choices: [{ message: { role: "assistant", content: nativeTool ? null : argumentsText, ...(nativeTool ? { tool_calls: [{ id: `fixture-${tool}`, type: "function", function: { name: tool, arguments: argumentsText } }] } : {}) } }],
                      })
                    : Response.json(nativeTool ? { output: [{ type: "function_call", name: tool, arguments: argumentsText }] } : { output_text: argumentsText });
            } catch (error) {
                console.error("unexpected scene fixture request failure", error);
                throw error;
            }
        });
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    async function confirmLocalScene(runId: string) {
        const waiting = (await getAgentRun(runId))!;
        expect(waiting).toMatchObject({
            status: "paused",
            ecommerceSnapshot: { fallback: { reason: "scene_selection_required" }, plan: { planVersion: "ecommerce-edit.v6", protection: { scope: "local" } } },
            tasks: [{ attempts: 0, status: "needs_review" }],
        });
        const tasks = await prepareEcommerceSceneSelectionResume(
            waiting,
            { baselineAssetId: waiting.ecommerceSnapshot!.plan!.source.currentSceneBaselineId, region: { x: 40, y: 5, width: 20, height: 20 } },
            "http://fixture.local",
            "session=fixture",
            "scene-user",
        );
        const confirmed = (await updateAgentRunById(runId, { status: "running", tasks }, undefined, ["paused"], undefined, waiting.tasks))!;
        expect(confirmed.tasks[0]).toMatchObject({ id: waiting.tasks[0].id, attempts: 0, sceneProtection: { selectionSource: "user_selection", confirmation: { actorUserId: "scene-user" } } });
        return confirmed;
    }

    it("preserves an explicit historical scene while applying its authorized new style reference", async () => {
        const conversation = await createCreativeConversation("scene-user", { surface: "chat" });
        const [root, style] = await registerCreativeAssets([
            { id: "old-root", userId: "scene-user", conversationId: conversation.id, sourceRunId: "upload", sourceTaskId: "old-upload", ordinal: 0, type: "image", title: "old scene", serverUrl: "/api/reference-assets/old-root.png", metadata: {} },
            {
                id: "style-scene-upload",
                userId: "scene-user",
                conversationId: conversation.id,
                sourceRunId: "upload",
                sourceTaskId: "style-upload",
                ordinal: 1,
                type: "image",
                title: "new lighting style",
                serverUrl: "/api/reference-assets/style-scene-upload.png",
                metadata: {},
            },
        ]);
        const first = (await createAgentRun("scene-user", { clientRequestId: "old-scene", conversationId: conversation.id, surface: "chat", prompt: "改成午后阳光", assetIds: [root.id], skillIds: [], modelIds: [] })).run;
        await executeAgentRun(first, "http://fixture.local", "session=fixture");
        const completedFirst = (await getAgentRun(first.id))!;
        expect(completedFirst.status, completedFirst.ecommerceSnapshot?.qualityCheck?.internalReason).toBe("completed");
        expect(completedFirst).toMatchObject({ status: "completed", ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } } });
        expect(completedFirst.ecommerceSnapshot?.qualityCheck).toBeUndefined();
        const oldResultId = completedFirst.assetIds[0];
        const originalSnapshot = JSON.stringify(completedFirst.ecommerceSnapshot);
        const branch = (
            await createAgentRun("scene-user", {
                clientRequestId: "style-branch",
                conversationId: conversation.id,
                surface: "chat",
                prompt: "保持旧图构图，参考图片2的灯光和风格，修改图片1整体光线为午后阳光",
                assetIds: [oldResultId, style.id],
                skillIds: [],
                modelIds: [],
            })
        ).run;

        await executeAgentRun(branch, "http://fixture.local", "session=fixture");

        const completedBranch = (await getAgentRun(branch.id))!;
        expect(completedBranch).toMatchObject({ status: "completed", tasks: [{ status: "completed", attempts: 1, taskIds: ["fixture-image-2"] }], ecommerceSnapshot: { qualityPolicy: "disabled", technicalCheck: { status: "passed" } } });
        expect(completedBranch.ecommerceSnapshot).not.toHaveProperty("fallback");
        expect(submissions).toHaveLength(2);
        expect(completedBranch.ecommerceSnapshot).toMatchObject({
            input: { assetIds: [oldResultId, style.id] },
            continuity: { sceneRootAssetId: root.id, parentResultId: oldResultId },
            visualAnalysis: { analysisVersion: "ecommerce-visual-analysis.v4", references: [{ assetId: oldResultId }, { assetId: style.id }] },
            plan: {
                planVersion: "ecommerce-edit.v6",
                operation: "scene_edit",
                source: { productAnchorId: null, currentSceneBaselineId: oldResultId, sceneReferenceIds: [style.id] },
                continuity: { parentResultId: oldResultId },
                canvas: { mode: "exact", source: "baseline", size: { width: 100, height: 80 }, allowReframe: false },
            },
        });
        expect(completedBranch.ecommerceSnapshot!.referenceDecision).toMatchObject({
            state: "resolved",
            editTargetId: oldResultId,
            currentSceneBaselineId: oldResultId,
            bindings: [
                { assetId: oldResultId, alias: "图片1", purposes: ["edit_target"], source: "explicit" },
                { assetId: style.id, alias: "图片2", purposes: ["style", "lighting"], source: "explicit" },
            ],
        });
        expect(completedBranch.ecommerceSnapshot!.plan!.referenceUses).toEqual([
            { assetId: oldResultId, alias: "图片1", purposes: ["edit_target"], usedCueIds: [] },
            { assetId: style.id, alias: "图片2", purposes: ["style", "lighting"], usedCueIds: ["scene-style", "scene-light"] },
        ]);
        expect((submissions[1].body.references as Array<{ id: string }>).map((reference) => reference.id)).toEqual([oldResultId, style.id]);
        expect(submissions[1].body.ecommerceExecution).toMatchObject({
            compilerVersion: "ecommerce-openai-image-2.5.v4",
            referenceMapping: [
                { assetId: oldResultId, userAlias: "图片1", providerIndex: 0, purposes: ["edit_target"] },
                { assetId: style.id, userAlias: "图片2", providerIndex: 1, purposes: ["style", "lighting"] },
            ],
            prompt: expect.stringContaining("soft window daylight"),
        });
        const disk = JSON.parse(await readFile(join(directory, "generation-tasks.json"), "utf8"));
        expect(disk.find((task: { id: string }) => task.id === branch.id).payload.ecommerceSnapshot).toEqual(completedBranch.ecommerceSnapshot);
        await executeAgentRun(completedBranch, "http://fixture.local", "session=fixture");
        expect((await getAgentRun(branch.id))!.ecommerceSnapshot).toEqual(completedBranch.ecommerceSnapshot);
        for (const current of [completedFirst, completedBranch]) {
            expect(submissions.filter((submission) => current.tasks[0].taskIds!.includes(submission.id))).toHaveLength(1);
            expect((await listCreativeRunEvents(current.id)).filter((event) => event.type === "task.created")).toHaveLength(1);
        }
        expect(submissions).toHaveLength(2);
        expect(JSON.stringify((await getAgentRun(first.id))!.ecommerceSnapshot)).toBe(originalSnapshot);
    });

    it("persists two scene rounds, recovers the submitted child and branches from adjustment evidence", async () => {
        transport.settings = { ...(transport.settings as Record<string, unknown>), ecommerceVisualQualityCheckEnabled: true } as never;
        const conversation = await createCreativeConversation("scene-user", { surface: "chat" });
        const [root] = await registerCreativeAssets([
            { id: "scene-root", userId: "scene-user", conversationId: conversation.id, sourceRunId: "upload", sourceTaskId: "scene-upload", ordinal: 0, type: "image", title: "scene", serverUrl: "/api/reference-assets/scene-root.png", metadata: {} },
        ]);
        const create = async (prompt: string, ids: string[] = []) => (await createAgentRun("scene-user", { clientRequestId: prompt, conversationId: conversation.id, surface: "chat", prompt, assetIds: ids, skillIds: [], modelIds: [] })).run;
        const first = await create("改成午后阳光", [root.id]);
        await executeAgentRun(first, "http://fixture.local", "session=fixture");
        await processAgentRunReview((await getAgentRun(first.id))!, "http://fixture.local", "session=fixture");
        const completedFirst = (await getAgentRun(first.id))!;
        expect(completedFirst).toMatchObject({
            status: "completed",
            ecommerceSnapshot: {
                visualAnalysis: { analysisVersion: "ecommerce-visual-analysis.v4" },
                plan: { planVersion: "ecommerce-edit.v6", photography: { materials: [{ objectId: "cabinet", textureDirection: expect.stringContaining("vertical") }], lighting: { keyLight: "daylight" } } },
                continuity: { sceneRootAssetId: root.id, parentResultId: null },
                qualityCheck: { version: "ecommerce-quality.v2", status: "passed" },
            },
        });
        const firstAsset = (await getCreativeAssetsByIds(completedFirst.assetIds, "scene-user"))[0];
        expect(firstAsset.metadata).toMatchObject({ ecommerceContinuity: { sceneRootAssetId: root.id } });
        const unchangedFirst = JSON.stringify(completedFirst.ecommerceSnapshot);
        const second = await create("再加一个花瓶");
        await executeAgentRun(second, "http://fixture.local", "session=fixture");
        expect(submissions).toHaveLength(1);
        const confirmedSecond = await confirmLocalScene(second.id);
        interruptAfterSubmission = true;
        await executeAgentRun(confirmedSecond, "http://fixture.local", "session=fixture");
        const waiting = (await getAgentRun(second.id))!;
        expect(waiting).toMatchObject({ status: "running", tasks: [{ taskIds: ["fixture-image-2"] }] });
        expect(submissions).toHaveLength(2);
        const disk = JSON.parse(await readFile(join(directory, "generation-tasks.json"), "utf8"));
        expect(disk.find((task: { id: string }) => task.id === second.id).payload.tasks[0].taskIds).toEqual(["fixture-image-2"]);
        adjustment = true;
        await executeAgentRun(waiting, "http://fixture.local", "session=fixture");
        await processAgentRunReview((await getAgentRun(second.id))!, "http://fixture.local", "session=fixture");
        const completedSecond = (await getAgentRun(second.id))!;
        expect(submissions).toHaveLength(2);
        expect(completedSecond).toMatchObject({
            status: "completed",
            ecommerceSnapshot: {
                continuity: { sceneRootAssetId: root.id, parentResultId: firstAsset.id },
                plan: { planVersion: "ecommerce-edit.v6", delta: { targetObjects: ["vase"], targetRegions: ["cabinet-top"] } },
                qualityCheck: { version: "ecommerce-quality.v2", status: "needs_adjustment", sceneProtectionEvidence: [{ evidence: { compositeOutsideChangedPixels: 0 } }] },
            },
        });
        expect(submissions[1].body.references).toMatchObject([{ id: firstAsset.id }]);
        const secondAsset = (await getCreativeAssetsByIds(completedSecond.assetIds, "scene-user"))[0];
        expect(await selectCurrentSceneBaseline(conversation.id, undefined, "scene-user")).toMatchObject({ id: secondAsset.id });
        expect(secondAsset.metadata).toMatchObject({ ecommerceContinuity: { parentResultId: firstAsset.id } });
        expect(JSON.stringify(secondAsset.metadata)).not.toContain("vase is too large");
        const branch = await create("修改图片1，继续调整花瓶", [secondAsset.id]);
        adjustment = false;
        await executeAgentRun(branch, "http://fixture.local", "session=fixture");
        expect((await getAgentRun(branch.id))!.ecommerceSnapshot!.referenceDecision).toMatchObject({
            state: "resolved",
            editTargetId: secondAsset.id,
            currentSceneBaselineId: secondAsset.id,
            bindings: [{ assetId: secondAsset.id, alias: "图片1", purposes: ["edit_target"], source: "explicit" }],
        });
        const confirmedBranch = await confirmLocalScene(branch.id);
        await executeAgentRun(confirmedBranch, "http://fixture.local", "session=fixture");
        await processAgentRunReview((await getAgentRun(branch.id))!, "http://fixture.local", "session=fixture");
        const completedBranch = (await getAgentRun(branch.id))!;
        expect(completedBranch.status).toBe("completed");
        expect(completedBranch.ecommerceSnapshot?.continuity).toMatchObject({
            sceneRootAssetId: root.id,
            parentResultId: secondAsset.id,
            parentQualityCheck: { status: "needs_adjustment", checks: expect.arrayContaining([expect.objectContaining({ reason: "vase is too large" })]) },
        });
        expect(JSON.stringify((await getAgentRun(first.id))!.ecommerceSnapshot)).toBe(unchangedFirst);
        expect(submissions.map((submission) => submission.id)).toEqual(["fixture-image-1", "fixture-image-2", "fixture-image-3"]);
        for (const current of [completedFirst, completedSecond, completedBranch]) {
            expect(submissions.filter((submission) => current.tasks[0].taskIds!.includes(submission.id))).toHaveLength(1);
            const events = await listCreativeRunEvents(current.id);
            const stages = events.filter((event) => event.type === "ecommerce.progress").map((event) => (event.data as { stage: string }).stage);
            // Selection pauses before the planner's generating_image event;
            // resumed local execution records the real same-task creation.
            expect(stages).toEqual(expect.arrayContaining(current.id === completedFirst.id ? ["identifying_product", "planning_scene", "generating_image", "checking_result"] : ["identifying_product", "planning_scene", "checking_result"]));
            expect(events.filter((event) => event.type === "task.created")).toHaveLength(1);
            expect((await getImageTask(current.tasks[0].taskIds![0]))?.ecommerceTrace).toMatchObject({ runId: current.id, imageTaskIds: current.tasks[0].taskIds });
        }
        expect(completedFirst.tasks[0].taskIds).not.toEqual(completedSecond.tasks[0].taskIds);
        expect(await selectCurrentSceneBaseline(conversation.id, secondAsset.id, "other-user")).toBeNull();
        expect(await selectCurrentSceneBaseline("other-conversation", secondAsset.id, "scene-user")).toBeNull();
    });

    it("recovers an already-started v1 child without upgrading its immutable plan or compiler", async () => {
        const conversation = await createCreativeConversation("scene-user", { surface: "chat" });
        const [root] = await registerCreativeAssets([
            {
                id: "legacy-scene-root",
                userId: "scene-user",
                conversationId: conversation.id,
                sourceRunId: "upload",
                sourceTaskId: "legacy-scene-upload",
                ordinal: 0,
                type: "image",
                title: "scene",
                serverUrl: "/api/reference-assets/legacy-scene-root.png",
                metadata: {},
            },
        ]);
        const first = (await createAgentRun("scene-user", { clientRequestId: "current-seed", conversationId: conversation.id, surface: "chat", prompt: "改成午后阳光", assetIds: [root.id], skillIds: [], modelIds: [] })).run;
        await executeAgentRun(first, "http://fixture.local", "session=fixture");
        const completedFirst = (await getAgentRun(first.id))!;
        expect(completedFirst.status).toBe("completed");
        const legacy = (await createAgentRun("scene-user", { clientRequestId: "started-v1-fixture", conversationId: conversation.id, surface: "chat", prompt: "恢复旧任务", assetIds: [], skillIds: [], modelIds: [] })).run;
        const legacySnapshot = structuredClone(completedFirst.ecommerceSnapshot!);
        legacySnapshot.runId = legacy.id;
        legacySnapshot.plan!.planVersion = "ecommerce-edit.v1";
        delete legacySnapshot.plan!.canvas;
        delete legacySnapshot.plan!.protection;
        delete legacySnapshot.plan!.visibleStructure;
        delete legacySnapshot.plan!.photography;
        delete legacySnapshot.continuity!.sceneRootAssetId;
        delete legacySnapshot.qualityCheck;
        delete legacySnapshot.qualityPolicy;
        delete legacySnapshot.technicalCheck;
        delete legacySnapshot.visualAnalysis;
        const legacyTask = structuredClone(completedFirst.tasks[0]);
        legacyTask.status = "running";
        legacyTask.childTasks = [{ id: "fixture-image-1", status: "pending", attempt: 1 }];
        legacyTask.assetIds = [];
        legacyTask.ecommerceExecution = compileEcommerceImageRequest(legacySnapshot.plan!, {
            profileId: "gpt-image-2.5-flare",
            compilerFamily: "openai-image-2.5",
            supportsIndependentMask: true,
            modelSnapshot: legacyTask.ecommerceExecution!.modelSnapshot,
        });
        legacyTask.prompt = legacyTask.ecommerceExecution.prompt;
        const frozenPlan = JSON.stringify(legacySnapshot.plan);
        const frozenExecution = JSON.stringify(legacyTask.ecommerceExecution);
        const savedLegacy = (await updateAgentRunById(legacy.id, { status: "running", tasks: [legacyTask], ecommerceSnapshot: legacySnapshot }, undefined, ["planning"]))!;
        await executeAgentRun(savedLegacy, "http://fixture.local", "session=fixture");
        const recoveredLegacy = (await getAgentRun(legacy.id))!;
        expect(recoveredLegacy.status).toBe("completed");
        expect(JSON.stringify(recoveredLegacy.ecommerceSnapshot!.plan)).toBe(frozenPlan);
        expect(JSON.stringify(recoveredLegacy.tasks[0].ecommerceExecution)).toBe(frozenExecution);
        expect(recoveredLegacy.ecommerceSnapshot!.qualityCheck).toMatchObject({ version: "ecommerce-quality.v1", status: "passed" });
        expect(recoveredLegacy.ecommerceSnapshot!.qualityCheck).not.toHaveProperty("observations");
        expect(recoveredLegacy.ecommerceSnapshot!.continuity).not.toHaveProperty("sceneRootAssetId");
        expect(submissions).toHaveLength(1);
    });
});
