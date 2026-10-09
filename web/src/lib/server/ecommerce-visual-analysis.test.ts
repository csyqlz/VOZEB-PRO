import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";

import type { EcommercePlanningInput } from "./ecommerce-generation-snapshot";
import type { EcommerceRoleCandidate } from "./ecommerce-model-routing";
import { analyzeEcommerceReferences, normalizeEcommerceVisualAnalysis, validateEcommerceVisualAnalysisV4, visualAnalysisDebugSummary, type EcommerceVisualReferenceV4 } from "./ecommerce-visual-analysis";
import { requestStructuredText, type TextPlanningCandidate } from "./text-planning-runtime";
import { authorizedWorkerUserId, maintenanceWorkerContext } from "./maintenance-auth";
import { createEcommerceReferenceCheckpoint, referenceSourcesLoaded } from "./ecommerce-reference-recovery";
import type { AgentRun } from "./agent-run-store";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";

const mocks = vi.hoisted(() => ({ refundUserPoints: vi.fn(async () => undefined) }));

vi.mock("@/lib/auth/store", () => ({ refundUserPoints: mocks.refundUserPoints }));

vi.mock("./text-planning-runtime", async () => ({
    ...(await vi.importActual<typeof import("./text-planning-runtime")>("./text-planning-runtime")),
    requestStructuredText: vi.fn(),
    rankTextPlanningCandidates: <T>(candidates: T[]) => candidates,
}));

const mockedRequest = vi.mocked(requestStructuredText);
let fixtureImage = "";

describe("ecommerce visual analysis", () => {
    it("accepts v4 detail cues without promoting partial content to a complete scene", () => {
        const value = v4Fixture();
        const result = normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates);
        expect(result).toMatchObject({
            analysisVersion: "ecommerce-visual-analysis.v4",
            references: [expect.anything(), { assetId: "scene", contentType: "product_detail", confidence: "medium", visualEvidence: { completeScene: false }, sceneFacts: null, cues: [expect.objectContaining({ id: "light", confidence: "high" })] }],
        });
        expect(result?.references[1]).not.toHaveProperty("photographyFacts");
    });

    it("normalizes only safe uncertain v4 counts and retains original values with paths", () => {
        const value = v4Fixture();
        value.references[1].visibleStructure = [
            { objectId: "cabinet", feature: "drawers", count: 2, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } },
            { objectId: "cabinet", feature: "doors", count: 0, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } },
            { objectId: "cabinet", feature: "legs", count: 3, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } },
        ];
        const result = normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates);
        expect(result).toMatchObject({
            references: [
                expect.anything(),
                { visibleStructure: [expect.objectContaining({ count: null, certainty: "uncertain" }), expect.objectContaining({ count: null, certainty: "uncertain" }), expect.objectContaining({ count: 3, certainty: "confirmed" })] },
            ],
            normalizationAudit: [
                { path: "references[1].visibleStructure[0].count", rawValue: 2, normalizedValue: null, reason: "uncertain_count" },
                { path: "references[1].visibleStructure[1].count", rawValue: 0, normalizedValue: null, reason: "uncertain_count" },
            ],
            rawAnalysis: value,
        });
        expect(value.references[1].visibleStructure[0].count).toBe(2);
        expect(value.references[1].visibleStructure[1].count).toBe(0);
    });

    it.each([-1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1])("rejects illegal v4 uncertain counts: %s", (count) => {
        const value = v4Fixture();
        value.references[1].visibleStructure = [{ objectId: "cabinet", feature: "drawers", count, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } }];
        expect(normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates)).toBeNull();
    });

    it.each([-1, 0.5, null, "3"])("keeps confirmed v4 counts strict: %s", (count) => {
        const value = v4Fixture();
        value.references[0].visibleStructure = [{ objectId: "table", feature: "legs", count, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } }];
        const result = validateEcommerceVisualAnalysisV4(value, planningInput().assetCandidates);
        expect(result.analysis).toBeNull();
        expect(result.issues).toContainEqual(expect.objectContaining({ path: "references[0].visibleStructure[0].count" }));
    });

    it("reports the actual missing or invalid fields without changing facts to satisfy purposes", () => {
        const value = v4Fixture();
        const malformed = {
            ...value,
            references: value.references.map((reference, index) =>
                index ? { ...reference, visualEvidence: { ...reference.visualEvidence, completeScene: "false" }, sceneFacts: { lighting: "soft" } } : { ...reference, productFacts: { ...reference.productFacts, identity: "" } },
            ),
        };
        const result = validateEcommerceVisualAnalysisV4(malformed, planningInput().assetCandidates);
        expect(result.analysis).toBeNull();
        expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["references[0].productFacts.identity", "references[1].visualEvidence.completeScene", "references[1].sceneFacts.space", "references[1].sceneFacts.composition"]));
    });

    it("summarizes rejected v4 references with content types and validator issue paths", () => {
        const value = v4Fixture();
        const rejected = { ...value, references: [value.references[0], { assetId: "product", purposes: ["edit_target"], confidence: "high" }] };
        const summary = visualAnalysisDebugSummary(rejected, planningInput().assetCandidates);

        expect(summary).toMatchObject({
            analysisVersion: "ecommerce-visual-analysis.v4",
            referenceCount: 2,
            referenceAssetIds: ["product", "product"],
            duplicateAssetIds: ["product"],
            purposeSuggestionAssetIds: ["scene"],
        });
        expect(summary.issuePaths).toEqual(expect.arrayContaining(["references[1].assetId", "references[1].contentType", "references[1].visualEvidence"]));
        expect(summary).not.toHaveProperty("referenceRoles");
        expect(summary).not.toHaveProperty("referenceValidation");
    });

    it("retains rejected-response raw evidence and conservative audits beside field issues", () => {
        const value = v4Fixture();
        value.references[1].visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 2, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } }];
        const malformed = { ...value, references: value.references.map((reference, index) => (index ? { ...reference, visualEvidence: { ...reference.visualEvidence, completeScene: "false" } } : reference)) };
        const result = validateEcommerceVisualAnalysisV4(malformed, planningInput().assetCandidates);
        expect(result).toMatchObject({ analysis: null, rawAnalysis: malformed, normalizationAudit: [{ path: "references[1].visibleStructure[0].count", rawValue: 2, normalizedValue: null, reason: "uncertain_count" }] });
        expect(result.issues).toContainEqual(expect.objectContaining({ path: "references[1].visualEvidence.completeScene" }));
    });

    it("uses original pixel dimensions for cue bounds and isolates the raw audit from mutations", () => {
        const value = v4Fixture();
        value.references[1].cues[0].evidenceRegion = { x: 90, y: 0, width: 20, height: 20 };
        const assets = planningInput().assetCandidates.map((asset) => ({ ...asset, width: 100, height: 100 }));
        expect(validateEcommerceVisualAnalysisV4(value, assets).issues).toContainEqual(expect.objectContaining({ path: "references[1].cues[0].evidenceRegion" }));
        value.references[1].cues[0].evidenceRegion.width = 10;
        const result = normalizeEcommerceVisualAnalysis(value, assets);
        expect(result).not.toBeNull();
        value.references[1].cues[0].description = "changed";
        if (result?.analysisVersion !== "ecommerce-visual-analysis.v4") throw new Error("Missing v4 analysis");
        expect(result.rawAnalysis).not.toEqual(value);
        expect(result.references[1].cues[0].description).toBe("左侧大面积柔光");
    });

    it("retains legacy v3 scene evidence and guessed-count rejection", () => {
        const scene = analysisFixture();
        scene.references[1].visualEvidence.completeScene = false;
        expect(normalizeEcommerceVisualAnalysis(scene, planningInput().assetCandidates)).toBeNull();
        const structure = analysisFixture() as Record<string, unknown> & { references: Array<Record<string, unknown>> };
        structure.references[0].visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 2, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 50, height: 50 } }];
        expect(normalizeEcommerceVisualAnalysis(structure, planningInput().assetCandidates)).toBeNull();
    });

    it("prepares v4 purposes in the same opted-in vision call while default calls remain v3", async () => {
        mockedRequest.mockResolvedValue(modelCall(v4Fixture()));
        const input = requestInput();
        const result = await analyzeEcommerceReferences(
            {
                ...input,
                analysisVersion: "ecommerce-visual-analysis.v4",
                planningInput: {
                    ...input.planningInput,
                    userRequest: "参考图片2的光线，修改图片1",
                    referenceAliases: [
                        { assetId: "product", alias: "图片1" },
                        { assetId: "scene", alias: "图片2" },
                    ],
                },
            },
            role("vision_analysis", [candidate("primary")]),
        );
        expect(result.analysisVersion).toBe("ecommerce-visual-analysis.v4");
        expect(mockedRequest).toHaveBeenCalledOnce();
        const request = mockedRequest.mock.calls[0][0];
        expect(JSON.stringify(request.messages)).toContain("assetId=scene;alias=图片2");
        expect(JSON.stringify(request.messages)).toContain("purposeSuggestions");
        expect(request.tool.parameters).toMatchObject({ properties: { analysisVersion: { enum: ["ecommerce-visual-analysis.v4"] } } });

        mockedRequest.mockReset();
        mockedRequest.mockResolvedValue(modelCall(analysisFixture()));
        expect((await analyzeEcommerceReferences(requestInput(), role("vision_analysis", [candidate("primary")]))).analysisVersion).toBe("ecommerce-visual-analysis.v3");
        expect(mockedRequest.mock.calls[0][0].tool.parameters).toMatchObject({ properties: { analysisVersion: { enum: ["ecommerce-visual-analysis.v3"] } } });
    });

    it("keeps two explicit images and one inherited product anchor in the same accurately sized v4 call", async () => {
        const base = requestInput();
        const input = {
            ...base.planningInput,
            assetCandidates: [...base.planningInput.assetCandidates, { id: "original", type: "image" as const, title: "original product", url: fixtureImage }],
            referenceAliases: [
                { assetId: "product", alias: "图片1" },
                { assetId: "scene", alias: "图片2" },
            ],
            inheritedReferences: { editTargetId: "product", productAnchorId: "original" },
        };
        const value = v4Fixture();
        value.references.push({ ...value.references[0], assetId: "original" });
        mockedRequest.mockResolvedValue(modelCall(value));
        const result = await analyzeEcommerceReferences({ ...base, planningInput: input, analysisVersion: "ecommerce-visual-analysis.v4" }, role("vision_analysis", [candidate("primary")]));
        expect(result.references.map((reference) => reference.assetId)).toEqual(["product", "scene", "original"]);
        expect(mockedRequest).toHaveBeenCalledOnce();
        const request = mockedRequest.mock.calls[0][0];
        expect(request.tool.parameters).toMatchObject({ properties: { references: { minItems: 3, maxItems: 3 } } });
        expect(JSON.stringify(request.messages)).toContain("assetId=original;alias=");
        expect(JSON.stringify(request.messages)).toContain("inheritedReferences");
        await expect(analyzeEcommerceReferences({ ...base, planningInput: input }, role("vision_analysis", [candidate("primary")]))).rejects.toThrow("一至两张");
        await expect(analyzeEcommerceReferences({ ...base, planningInput: { ...input, inheritedReferences: undefined }, analysisVersion: "ecommerce-visual-analysis.v4" }, role("vision_analysis", [candidate("primary")]))).rejects.toThrow("一至两张");
    });

    it("provides specific v4 validator paths for the existing structured repair request", async () => {
        mockedRequest.mockResolvedValue(modelCall(v4Fixture()));
        await analyzeEcommerceReferences({ ...requestInput(), analysisVersion: "ecommerce-visual-analysis.v4" }, role("vision_analysis", [candidate("primary")]));
        const invalid = v4Fixture();
        invalid.references[0].productFacts!.identity = "";
        const validation = mockedRequest.mock.calls[0][0].validateArguments!(JSON.stringify(invalid));
        expect(validation).toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "visual_field_invalid", path: "references[0].productFacts.identity" })] });
    });

    it("awaits persisted original-byte source identity before the actual vision POST without re-reading media", async () => {
        const fixture = await visionSourceFixture();
        const actual = await vi.importActual<typeof import("./text-planning-runtime")>("./text-planning-runtime");
        mockedRequest.mockImplementation(actual.requestStructuredText);
        const entered = Promise.withResolvers<void>();
        const persisted = Promise.withResolvers<void>();
        const onSourcesLoaded = vi.fn(async () => {
            entered.resolve();
            await persisted.promise;
        });
        const operation = analyzeEcommerceReferences({ ...requestInput(), ...fixture.input, analysisVersion: "ecommerce-visual-analysis.v4", onSourcesLoaded }, role("vision_analysis", [candidate("source-order")]));
        try {
            const first = await Promise.race([entered.promise.then(() => "sources"), operation.then(() => "model")]);
            expect(first).toBe("sources");
            expect(mockedRequest).not.toHaveBeenCalled();
            expect(fixture.posts).toHaveLength(0);
            expect(onSourcesLoaded).toHaveBeenCalledExactlyOnceWith([
                { assetId: "product", contentSha256: createHash("sha256").update(fixture.bytes[0]).digest("hex"), sourceSize: { width: 100, height: 100 } },
                { assetId: "scene", contentSha256: createHash("sha256").update(fixture.bytes[1]).digest("hex"), sourceSize: { width: 100, height: 100 } },
            ]);
            persisted.resolve();
            await expect(operation).resolves.toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v4" });
            expect(fixture.reads).toEqual(["product", "scene"]);
            expect(fixture.posts).toHaveLength(1);
            const outgoingImages = fixture.posts[0].messages
                .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
                .filter((content) => content.type === "image_url")
                .map((content) => content.image_url!.url);
            expect(outgoingImages.map((url) => Buffer.from(url.split(",")[1], "base64"))).toEqual(fixture.bytes);
        } finally {
            persisted.resolve();
            await operation.catch(() => undefined);
            await fixture.close();
        }
    });

    it("rejects a source replaced after recovery preflight before any actual vision POST and keeps the frozen input version", async () => {
        const fixture = await visionSourceFixture();
        const actual = await vi.importActual<typeof import("./text-planning-runtime")>("./text-planning-runtime");
        mockedRequest.mockImplementation(actual.requestStructuredText);
        const planning = fixture.input.planningInput;
        const assets = planning.assetCandidates.map(
            (asset, index) =>
                ({
                    id: asset.id,
                    userId: "user",
                    conversationId: planning.conversationId,
                    ordinal: index,
                    type: "image",
                    status: "ready",
                    sourceRunId: "upload",
                    title: asset.title,
                    serverUrl: asset.url,
                    metadata: {},
                    createdAt: 1,
                    updatedAt: 1,
                }) as CreativeAsset,
        );
        const captured = referenceSourcesLoaded(
            createEcommerceReferenceCheckpoint({ id: "run" } as AgentRun, planning, assets),
            assets.map((asset, index) => ({ assetId: asset.id, contentSha256: createHash("sha256").update(fixture.bytes[index]).digest("hex"), sourceSize: { width: 100, height: 100 } })),
        );
        const frozen = structuredClone(captured);
        fixture.bytes[0] = Buffer.from(fixture.bytes[1]);
        const onSourcesLoaded = vi.fn(async (sources) => {
            referenceSourcesLoaded(captured, sources);
        });
        try {
            await expect(analyzeEcommerceReferences({ ...requestInput(), ...fixture.input, analysisVersion: "ecommerce-visual-analysis.v4", onSourcesLoaded }, role("vision_analysis", [candidate("source-replacement")]))).rejects.toThrow(
                "参考图片内容已变化",
            );
            expect(fixture.posts).toHaveLength(0);
            expect(mockedRequest).not.toHaveBeenCalled();
            expect(onSourcesLoaded).toHaveBeenCalledOnce();
            expect(captured).toEqual(frozen);
        } finally {
            await fixture.close();
        }
    });

    it("makes zero actual vision POSTs when persisting loaded source identity fails", async () => {
        const fixture = await visionSourceFixture();
        const actual = await vi.importActual<typeof import("./text-planning-runtime")>("./text-planning-runtime");
        mockedRequest.mockImplementation(actual.requestStructuredText);
        const persistenceFailure = new Error("reference checkpoint persistence failed");
        const onSourcesLoaded = vi.fn(async () => {
            throw persistenceFailure;
        });
        try {
            const error = await analyzeEcommerceReferences({ ...requestInput(), ...fixture.input, analysisVersion: "ecommerce-visual-analysis.v4", onSourcesLoaded }, role("vision_analysis", [candidate("source-failure")])).catch((error) => error);
            expect(fixture.posts).toHaveLength(0);
            expect(mockedRequest).not.toHaveBeenCalled();
            expect(onSourcesLoaded).toHaveBeenCalledOnce();
            expect(error).toBe(persistenceFailure);
        } finally {
            await fixture.close();
        }
    });

    it("classifies unreadable input media independently from exhausted vision service failures", async () => {
        const input = requestInput();
        const error = await analyzeEcommerceReferences(
            { ...input, analysisVersion: "ecommerce-visual-analysis.v4", planningInput: { ...input.planningInput, assetCandidates: [{ ...input.planningInput.assetCandidates[0], url: "unreadable-source" }] } },
            role("vision_analysis", [candidate("primary"), candidate("backup")]),
        ).catch((error) => error);
        expect(error.failure).toMatchObject({ analysisVersion: "ecommerce-visual-analysis.v4", kind: "input_media", attempts: [] });
        expect(mockedRequest).not.toHaveBeenCalled();
    });

    it("retains actual candidate failures with rejected raw fields and conservative audit", async () => {
        const invalid = v4Fixture();
        invalid.references[0].productFacts!.identity = "";
        invalid.references[1].visibleStructure = [{ objectId: "cabinet", feature: "drawers", count: 2, certainty: "uncertain", evidenceRegion: { x: 0, y: 0, width: 20, height: 20 } }];
        const runtime = await vi.importActual<typeof import("./text-planning-runtime")>("./text-planning-runtime");
        mockedRequest
            .mockImplementationOnce(async (request) => {
                request.validateArguments?.(JSON.stringify(invalid));
                throw new runtime.TextPlanningRequestError("contract rejected", 502, false, "invalid-structure", "invalid-structured-result");
            })
            .mockRejectedValueOnce(new runtime.TextPlanningRequestError("service unavailable", 503, true, "http"));
        const error = await analyzeEcommerceReferences({ ...requestInput(), analysisVersion: "ecommerce-visual-analysis.v4" }, role("vision_analysis", [candidate("primary"), candidate("backup")])).catch((error) => error);
        expect(error.failure).toMatchObject({
            analysisVersion: "ecommerce-visual-analysis.v4",
            kind: "service_unavailable",
            attempts: [
                {
                    modelRole: { channelId: "primary" },
                    kind: "invalid_structure",
                    validation: {
                        rawAnalysis: invalid,
                        issues: [expect.objectContaining({ path: "references[0].productFacts.identity" })],
                        normalizationAudit: [{ path: "references[1].visibleStructure[0].count", rawValue: 2, normalizedValue: null, reason: "uncertain_count" }],
                    },
                },
                { modelRole: { channelId: "backup" }, kind: "service_unavailable", status: 503 },
            ],
        });
        expect(mockedRequest).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(error.failure)).not.toContain("secret");
    });
    it.each([
        [401, "http", "authentication"],
        [403, "http", "authentication"],
        [429, "http", "rate_limited"],
        [503, "http", "service_unavailable"],
        [502, "transport", "transport"],
    ] as const)("preserves the actual final %s %s failure after an earlier rejected response", async (status, reason, kind) => {
        const invalid = v4Fixture();
        invalid.references[0].productFacts!.identity = "";
        const runtime = await vi.importActual<typeof import("./text-planning-runtime")>("./text-planning-runtime");
        mockedRequest.mockImplementationOnce(async (request) => {
            request.validateArguments?.(JSON.stringify(invalid));
            throw new runtime.TextPlanningRequestError("final request failed", status, true, reason);
        });
        const error = await analyzeEcommerceReferences({ ...requestInput(), analysisVersion: "ecommerce-visual-analysis.v4" }, role("vision_analysis", [candidate("primary")])).catch((error) => error);
        expect(error.failure).toMatchObject({ kind, attempts: [{ kind, status, validation: { rawAnalysis: invalid, issues: [expect.objectContaining({ path: "references[0].productFacts.identity" })] } }] });
        expect(mockedRequest).toHaveBeenCalledTimes(1);
    });
    it.each(["worker", "cookie"] as const)("reads protected planning images with %s credentials", async (credentialKind) => {
        const bytes = Buffer.from(fixtureImage.split(",")[1], "base64");
        const server = createServer((request, response) => {
            const worker = authorizedWorkerUserId(new Request("http://127.0.0.1", { headers: { authorization: request.headers.authorization || "", "x-vozeb-pro-worker-user-id": String(request.headers["x-vozeb-pro-worker-user-id"] || "") } }));
            if (worker !== "worker-user" && request.headers.cookie !== "session=test") {
                response.writeHead(401).end();
                return;
            }
            response.writeHead(200, { "content-type": "image/png" }).end(bytes);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", "visual-worker-test-token-32-characters");
        vi.stubEnv("VOZEB_PRO_MAINTENANCE_TOKEN", "visual-maintenance-test-token-32-characters");
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Planning image fixture is unavailable");
            mockedRequest.mockResolvedValue(modelCall(analysisFixture()));
            const input = requestInput();
            const analysis = await analyzeEcommerceReferences(
                {
                    ...input,
                    origin: `http://127.0.0.1:${address.port}`,
                    cookie: credentialKind === "worker" ? maintenanceWorkerContext("worker-user") : input.cookie,
                    planningInput: { ...input.planningInput, assetCandidates: input.planningInput.assetCandidates.map((asset) => ({ ...asset, url: `/api/references/${asset.id}` })) },
                },
                role("vision_analysis", [candidate("primary")]),
            );
            expect(analysis.references).toHaveLength(2);
            expect(analysis.references.map((reference) => reference.sourceSize)).toEqual([
                { width: 100, height: 100 },
                { width: 100, height: 100 },
            ]);
            expect(mockedRequest).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllEnvs();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it("stores observed photography facts in v3 and refuses to attach them to started v2 analysis", () => {
        const fixture = analysisFixture();
        const photographyFacts = {
            materials: [{ objectId: "cabinet", textureDirection: "纵向木纹", textureScale: "细木纹", roughness: "哑光", gloss: "低光泽" }],
            lighting: { keyLight: "左侧大面积柔光", fillLight: "弱补光", whiteBalance: "中性", contactShadow: "接触阴影" },
            composition: { focalSubject: "边柜", depth: "纵深", negativeSpace: "留白" },
        };
        const value = { ...fixture, analysisVersion: "ecommerce-visual-analysis.v3", references: fixture.references.map((reference) => ({ ...reference, photographyFacts })) };
        expect(normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates)?.references[1]).toMatchObject({ photographyFacts });
        expect(normalizeEcommerceVisualAnalysis({ ...value, analysisVersion: "ecommerce-visual-analysis.v2" }, planningInput().assetCandidates)).toBeNull();
    });
    it("records visible structure on scene references and rejects guessed uncertain counts", () => {
        const fixture = analysisFixture();
        const value = {
            ...fixture,
            analysisVersion: "ecommerce-visual-analysis.v2",
            references: fixture.references.map((reference) => ({ ...reference, visibleStructure: [{ objectId: "cabinet", feature: "drawers", count: 3, certainty: "confirmed", evidenceRegion: { x: 0, y: 0, width: 100, height: 100 } }] })),
        };
        expect(normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates)?.references[1]).toMatchObject({ visibleStructure: [expect.objectContaining({ count: 3 })] });
        value.references[1].visibleStructure[0].certainty = "uncertain";
        expect(normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates)).toBeNull();
    });
    beforeEach(async () => {
        fixtureImage =
            "data:image/png;base64," +
            (
                await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } })
                    .png()
                    .toBuffer()
            ).toString("base64");
        mockedRequest.mockReset();
        mocks.refundUserPoints.mockClear();
    });

    it("keeps product and scene evidence in separate reference roles", async () => {
        mockedRequest.mockResolvedValue(modelCall(analysisFixture()));

        const result = await analyzeEcommerceReferences(requestInput(), role("vision_analysis", [candidate("primary")]));

        expect(result.references).toEqual([
            expect.objectContaining({ assetId: "product", role: "product", productFacts: expect.objectContaining({ identity: "oak side table" }), sceneFacts: null }),
            expect.objectContaining({ assetId: "scene", role: "scene", productFacts: null, sceneFacts: expect.objectContaining({ space: "living room" }) }),
        ]);
        expect(result.modelRole).toMatchObject({ logicalRole: "vision_analysis", logicalModelId: "vision-model", channelId: "primary" });
    });

    it("requires product references to return both protection regions", async () => {
        mockedRequest.mockResolvedValue(modelCall(analysisFixture()));

        await analyzeEcommerceReferences(requestInput(), role("vision_analysis", [candidate("primary")]));

        const messages = mockedRequest.mock.calls[0]?.[0].messages;
        expect(JSON.stringify(messages)).toContain("role=product");
        expect(JSON.stringify(messages)).toContain("productCore 与 fusionHalo 均不得为 null");
    });

    it("rejects output that attaches scene facts or scene regions to a product reference", () => {
        const value = analysisFixture() as { references: Array<Record<string, unknown>> } & Record<string, unknown>;
        value.references[0] = { ...value.references[0], sceneFacts: sceneFacts(), role: "product" };

        expect(normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates)).toBeNull();
    });

    it("accepts protected product regions and structured editable targets on a generated scene baseline", () => {
        const value = analysisFixture() as { references: Array<Record<string, unknown>> } & Record<string, unknown>;
        value.references[1] = {
            ...value.references[1],
            productCore: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
            fusionHalo: { x: 0.31, y: 0.21, width: 0.38, height: 0.58 },
            editableTargets: [
                { id: "background-main", kind: "background", label: "main room background", region: { x: 0, y: 0, width: 1, height: 1 } },
                { id: "plant-right", kind: "prop", label: "right green plant", region: { x: 0.78, y: 0.28, width: 0.18, height: 0.55 } },
            ],
        };

        const result = normalizeEcommerceVisualAnalysis(value, planningInput().assetCandidates);

        expect(result?.references[1]).toMatchObject({
            role: "scene",
            productCore: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
            editableTargets: [
                { id: "background-main", kind: "background" },
                { id: "plant-right", kind: "prop" },
            ],
        });
    });

    it("fails over between logical models in the same role and attributes billing to the actual candidate", async () => {
        mockedRequest.mockResolvedValueOnce(modelCall({ invalid: true }, new Headers({ "x-vozeb-pro-points-cost": "3", "x-vozeb-pro-points-record-id": "vision-primary-charge" }))).mockResolvedValueOnce(modelCall(analysisFixture()));

        const result = await analyzeEcommerceReferences(requestInput(), [roleCandidate("vision_analysis", "vision-primary", "primary"), roleCandidate("vision_analysis", "vision-backup", "secondary")]);

        expect(mockedRequest).toHaveBeenCalledTimes(2);
        expect(result.modelRole).toMatchObject({ logicalModelId: "vision-backup", channelId: "secondary", upstreamModel: "vendor/secondary" });
        expect(mockedRequest.mock.calls[0]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "vision-primary", "x-vozeb-pro-upstream-model": "vendor/primary" });
        expect(mockedRequest.mock.calls[1]?.[0].headers).toMatchObject({ "x-vozeb-pro-logical-model": "vision-backup", "x-vozeb-pro-upstream-model": "vendor/secondary" });
        expect(new Headers(mockedRequest.mock.calls[0]?.[0].headers).get("x-vozeb-pro-points-idempotency-key")).not.toBe(new Headers(mockedRequest.mock.calls[1]?.[0].headers).get("x-vozeb-pro-points-idempotency-key"));
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "vision-primary", 3, "text", 1, undefined, "vision-primary-charge");
    });

    it("rejects a cross-role candidate group before calling a model", async () => {
        await expect(analyzeEcommerceReferences(requestInput(), role("edit_planning", [candidate("planner")]))).rejects.toThrow("vision_analysis");
        expect(mockedRequest).not.toHaveBeenCalled();
    });
});

function requestInput() {
    return {
        origin: "http://127.0.0.1:3000",
        cookie: "session=test",
        userId: "user-one",
        requestId: "run-one",
        planningInput: planningInput(),
    };
}

async function visionSourceFixture() {
    const bytes = await Promise.all(
        ["white", "blue"].map((background) =>
            sharp({ create: { width: 100, height: 100, channels: 3, background } })
                .png()
                .toBuffer(),
        ),
    );
    const reads: string[] = [];
    const posts: Array<{ messages: Array<{ content: string | Array<{ type: string; image_url?: { url: string } }> }> }> = [];
    const server = createServer(async (request, response) => {
        if (request.method === "GET") {
            const assetId = request.url?.split("/").at(-1) || "";
            const index = ["product", "scene"].indexOf(assetId);
            if (index < 0) {
                response.writeHead(404).end();
                return;
            }
            reads.push(assetId);
            response.writeHead(200, { "content-type": "image/png" }).end(bytes[index]);
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "analyze_ecommerce_references", arguments: JSON.stringify(v4Fixture()) } }] } }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Vision source fixture is unavailable");
    const planning = planningInput();
    return {
        bytes,
        reads,
        posts,
        input: { origin: `http://127.0.0.1:${address.port}`, planningInput: { ...planning, assetCandidates: planning.assetCandidates.map((asset) => ({ ...asset, url: `/api/reference-assets/${asset.id}` })) } },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}

function planningInput(): EcommercePlanningInput {
    return {
        userRequest: "把商品放进简约客厅",
        conversationId: "conversation-one",
        surface: "chat",
        assetCandidates: [
            { id: "product", type: "image", title: "product.png", url: fixtureImage },
            { id: "scene", type: "image", title: "scene.png", url: fixtureImage },
        ],
        conversationContext: { summary: "", recentMessages: [] },
    };
}

function analysisFixture() {
    return {
        analysisVersion: "ecommerce-visual-analysis.v3" as const,
        references: [
            {
                assetId: "product",
                role: "product" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: true, transparentBackground: false, isolatedSubject: true, completeScene: false },
                productFacts: productFacts(),
                sceneFacts: null,
                productCore: { x: 0.2, y: 0.15, width: 0.6, height: 0.7 },
                fusionHalo: { x: 0.16, y: 0.11, width: 0.68, height: 0.78 },
                editableTargets: [],
                visibleStructure: [],
            },
            {
                assetId: "scene",
                role: "scene" as const,
                confidence: "high" as const,
                visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: true },
                productFacts: null,
                sceneFacts: sceneFacts(),
                productCore: null,
                fusionHalo: null,
                editableTargets: [],
                visibleStructure: [],
            },
        ],
    };
}

function v4Fixture(): {
    analysisVersion: string;
    references: Array<Omit<EcommerceVisualReferenceV4, "visibleStructure"> & { visibleStructure: Array<{ objectId: string; feature: string; count: unknown; certainty: string; evidenceRegion: { x: number; y: number; width: number; height: number } }> }>;
    purposeSuggestions: Array<Record<string, unknown>>;
} {
    const legacy = analysisFixture();
    return {
        analysisVersion: "ecommerce-visual-analysis.v4",
        references: legacy.references.map(({ role, ...reference }) => ({
            ...reference,
            contentType: role === "product" ? "isolated_product" : "product_detail",
            ...(role === "scene" ? { confidence: "medium" as const, sceneFacts: null, visualEvidence: { whiteBackground: false, transparentBackground: false, isolatedSubject: false, completeScene: false } } : {}),
            cues: role === "scene" ? [{ id: "light", facet: "lighting", description: "左侧大面积柔光", confidence: "high" }] : [],
        })),
        purposeSuggestions: [{ assetId: "scene", purposes: ["lighting"], confidence: "high" }],
    };
}

function productFacts() {
    return { identity: "oak side table", outline: "round top and three legs", color: "natural oak", material: "wood", brandText: [], view: "front three-quarter" };
}

function sceneFacts() {
    return { space: "living room", composition: "eye-level wide view", lighting: "soft window daylight" };
}

function role(logicalRole: "vision_analysis" | "edit_planning", candidates: TextPlanningCandidate[]) {
    const logicalModelId = logicalRole === "vision_analysis" ? "vision-model" : "planner-model";
    return candidates.map((value) => roleCandidate(logicalRole, logicalModelId, value.channelId));
}

function roleCandidate(logicalRole: "vision_analysis" | "edit_planning", logicalModelId: string, channelId: string): EcommerceRoleCandidate {
    const value = candidate(channelId);
    return {
        channelId: value.channelId,
        upstreamModel: value.upstreamModel,
        channel: value.channel,
        logicalRole,
        capability: "text",
        logicalModelId,
        snapshot: { logicalRole, capability: "text", logicalModelId, channelId, upstreamModel: value.upstreamModel, apiFormat: "openai" },
    };
}

function candidate(id: string): TextPlanningCandidate {
    return {
        channelId: id,
        upstreamModel: "vendor/" + id,
        channel: {
            id,
            name: id,
            baseUrl: "https://example.com/v1",
            apiKey: "secret",
            apiFormat: "openai",
            models: ["vendor/" + id],
            enabled: true,
        },
    };
}

function modelCall(value: unknown, headers = new Headers()) {
    return { arguments: JSON.stringify(value), headers, protocol: "chat" as const, elapsedMs: 10 };
}
