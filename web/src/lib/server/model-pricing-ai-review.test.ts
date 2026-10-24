import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), refund: vi.fn(), page: vi.fn(), ai: vi.fn(), classify: vi.fn(), links: vi.fn(), versions: vi.fn(), pending: vi.fn(), observations: vi.fn(), sales: vi.fn(), saveMark: vi.fn(), clearMark: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings, refundUserPoints: mocks.refund }));
vi.mock("@/lib/server/official-price-browser", () => ({ readRenderedOfficialPageText: mocks.page }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModelCandidates: () => [{ channelId: "text-channel", upstreamModel: "text-model" }] }));
vi.mock("@/lib/server/text-planning-runtime", () => ({
    rankTextPlanningCandidates: (candidates: unknown[]) => candidates,
    requestStructuredText: (input: { tool: { name: string } }) => (input.tool.name === "classify_official_model_vendor" ? mocks.classify(input) : mocks.ai(input)),
    TextPlanningRequestError: class TextPlanningRequestError extends Error {
        constructor(
            message: string,
            readonly status = 502,
            readonly retryable = false,
            readonly reason = "http",
            readonly failureCode?: string,
        ) {
            super(message);
        }
    },
}));
vi.mock("./model-pricing-store", () => ({
    listOfficialPriceReviewLinks: mocks.links,
    listPriceReviewVersions: mocks.versions,
    listPriceReviewCandidates: mocks.pending,
    getCurrentSalesVersion: mocks.sales,
    savePriceLifecycleMark: mocks.saveMark,
    clearPriceLifecycleMark: mocks.clearMark,
}));
vi.mock("./model-pricing-observation-store", () => ({ listActiveObservationModelIds: mocks.observations }));

import { isByteDanceSeedPilotModel, markByteDanceSeedRetired, officialModelIdsInPriceText, parseFindings, reviewOfficialPrices } from "./model-pricing-ai-review";

const model = { id: "ByteDance-Seedream-4.5", name: "ByteDance-Seedream-4.5", capability: "image", bindings: [{ upstreamModel: "ByteDance-Seedream-4.5" }] };
const sourceUrl = "https://docs.byteplus.com/en/docs/ModelArk/1544106";
const officialId = "seedream-4-5-251128";
const evidence = `${officialId} Input free Output 0.04 USD / image`;
const reviewInput = { origin: "http://localhost:3000", cookie: "session=test", userId: "admin", requestId: "0d8798e2-c4ef-4bfc-b55a-82ee8ea7ce22", manufacturer: "ByteDance / Volcengine", sourceUrl };
const finding = { logicalModelId: model.id, officialModelId: officialId, status: "new", reason: "官网有价，平台尚未审核", evidence, conditions: "标准图片生成", items: [{ key: "outputImages", unit: "image", per: "1", price: "0.04", currency: "USD" }] };

describe("ByteDance Seed price review pilot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings.mockResolvedValue({ logicalModels: [model], defaultModels: { textModel: "text-model" } });
        mocks.links.mockResolvedValue([{ label: "当前厂商官网链接", url: sourceUrl }]);
        mocks.page.mockImplementation(async (url: string) => ({ url, text: url === sourceUrl ? evidence : "Model deprecations" }));
        mocks.versions.mockResolvedValue([]);
        mocks.pending.mockResolvedValue([]);
        mocks.observations.mockResolvedValue([]);
        mocks.sales.mockResolvedValue(undefined);
        mocks.ai.mockResolvedValue({ arguments: JSON.stringify({ findings: [finding] }), headers: new Headers() });
        mocks.classify.mockImplementation(async ({ messages }: { messages: Array<{ content: string }> }) => {
            const { manufacturer, candidateIds } = JSON.parse(messages[1].content) as { manufacturer: string; candidateIds: string[] };
            const otherIds = manufacturer === reviewInput.manufacturer ? candidateIds.filter((id) => id.startsWith("deepseek-")) : [];
            return { arguments: JSON.stringify({ selectedIds: candidateIds.filter((id) => !otherIds.includes(id)), otherIds, uncertainIds: [] }), headers: new Headers() };
        });
    });

    it("reads the configured official page, compares platform models and returns a candidate without writing it", async () => {
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.findings[0]).toMatchObject({ logicalModelId: model.id, status: "new", candidate: { sku: officialId, items: finding.items } });
        expect(result.sourceMode).toBe("website");
        expect(mocks.ai).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.stringContaining(officialId) })]) }));
        expect(mocks.saveMark).not.toHaveBeenCalled();
    });

    it("retains only suggestions quoted from the official page and separates table header evidence", () => {
        const page = `Header: Seedream USD / image effective 2026-10-01\n${evidence}`;
        const [result] = parseFindings(
            JSON.stringify({
                findings: [
                    {
                        ...finding,
                        suggestedSeries: "Seedream",
                        suggestedVersion: "invented-version",
                        suggestedTier: "paid",
                        suggestedEffectiveFrom: "2026-10-01",
                        suggestedEffectiveTo: "2027-01-01",
                        headerEvidence: "Header: Seedream USD / image effective 2026-10-01",
                    },
                ],
            }),
            page,
            "",
            [model.id],
            [],
            [],
            sourceUrl,
            "2026-10-01T00:00:00Z",
        );
        expect(result).toMatchObject({ suggestedSeries: "Seedream", suggestedTier: "paid", suggestedEffectiveFrom: "2026-10-01", headerEvidence: "Header: Seedream USD / image effective 2026-10-01" });
        expect(result.suggestedVersion).toBeUndefined();
        expect(result.suggestedEffectiveTo).toBeUndefined();
    });

    it("skips existing discoveries without running price extraction while leaving the full review unchanged", async () => {
        mocks.observations.mockResolvedValue([officialId]);
        const discovery = await reviewOfficialPrices({ ...reviewInput, discoveryOnly: true });
        expect(discovery.skippedExistingModelIds).toEqual([officialId]);
        expect(discovery.findings).toEqual([]);
        expect(mocks.ai).not.toHaveBeenCalled();
        const full = await reviewOfficialPrices(reviewInput);
        expect(full.findings).toHaveLength(1);
        expect(mocks.ai).toHaveBeenCalledOnce();
    });

    it("does not archive a model whose vendor identity is uncertain", async () => {
        mocks.classify.mockResolvedValue({ arguments: JSON.stringify({ selectedIds: [], otherIds: [], uncertainIds: [officialId] }), headers: new Headers() });
        const result = await reviewOfficialPrices({ ...reviewInput, discoveryOnly: true });
        expect(result.uncertainModelIds).toEqual([officialId]);
        expect(result.sourceOfficialModelIds).toEqual([]);
        expect(result.findings).toEqual([]);
        expect(mocks.ai).not.toHaveBeenCalled();
    });

    it("rejects price hallucinations and never treats a missing price page entry as retirement", () => {
        const wrong = { ...finding, items: [{ ...finding.items[0], price: "0.99" }] };
        const [result] = parseFindings(JSON.stringify({ findings: [wrong] }), evidence, "", [model.id], [], [], sourceUrl, "2026-09-30T00:00:00Z");
        expect(result.status).toBe("needs-review");
        expect(result.candidate).toBeNull();
        expect(result.extractionIssue).toContain("官网原文");
        expect(parseFindings(JSON.stringify({ findings: [{ ...finding, evidence: `${officialId} has disappeared` }] }), evidence, "", [model.id], [], [], sourceUrl, "2026-09-30T00:00:00Z")).toEqual([]);
    });

    it("extracts every resolution and input-video price from one official Seedance row", () => {
        const id = "dreamina-seedance-2-0-260128";
        const row = `${id}\nFor 480p and 720p outputs:\nInput without video: 7.0\nInput with video: 4.3\nFor 1080p outputs:\nInput without video: 7.7\nInput with video: 4.7\nFor 4K outputs:\nInput without video: 4.0\nInput with video: 2.4\nNot supported yet`;
        const [result] = parseFindings(
            JSON.stringify({ findings: [{ ...finding, officialModelId: id, logicalModelId: "ByteDance-Seedance-2.0", evidence: row, conditions: "", items: [] }] }),
            `Model ID Online inference (USD / M tokens)\n${row}`,
            "",
            ["ByteDance-Seedance-2.0"],
            [],
            [],
            sourceUrl,
            "2026-10-12T00:00:00Z",
            "website",
            "ByteDance / Volcengine",
            [{ id: "ByteDance-Seedance-2.0", series: "Seedance" }],
        );
        expect(result.observedItems).toHaveLength(6);
        expect(result.observedItems.map((item) => Number(item.price))).toEqual([7, 4.3, 7.7, 4.7, 4, 2.4]);
        expect(result.observedItems.every((item) => item.condition && item.currency === "USD" && item.per === "1000000")).toBe(true);
        expect(result.candidate?.items).toHaveLength(6);
        expect(result.extractionIssue).toBe("");
    });

    it("does not map a standard official model to a Fast logical model", () => {
        const id = "dreamina-seedance-2-0-260128";
        const row = `${id} Output 7.0 USD / M tokens`;
        const [result] = parseFindings(JSON.stringify({ findings: [{ ...finding, officialModelId: id, logicalModelId: "ByteDance-Seedance-2.0-Fast", evidence: row }] }), row, "", ["ByteDance-Seedance-2.0-Fast"], [], [], sourceUrl, "2026-10-12T00:00:00Z");
        expect(result.logicalModelId).toBeNull();
        expect(result.status).toBe("unmatched");
    });

    it("holds a partial video tier row for review instead of accepting one AI item", () => {
        const id = "dreamina-seedance-2-0-260128";
        const row = `${id} For 480p and 720p outputs: Input without video: 7.0`;
        const [result] = parseFindings(
            JSON.stringify({ findings: [{ ...finding, officialModelId: id, evidence: row, items: [{ key: "output", unit: "token", per: "1000000", price: "7.0", currency: "USD" }] }] }),
            `Model ID Online inference (USD / M tokens)\n${row}`,
            "",
            [model.id],
            [],
            [],
            sourceUrl,
            "2026-10-12T00:00:00Z",
        );
        expect(result.observedItems).toEqual([]);
        expect(result.candidate).toBeNull();
        expect(result.extractionIssue).toContain("未完整提取");
    });

    it("counts selected ByteDance models and excludes findings from another manufacturer", async () => {
        const otherId = "seed-2-0-lite-260428";
        const otherEvidence = `${otherId} Prompt length 0.25 USD / 1M tokens`;
        const thirdPartyEvidence = "deepseek-r1-250528 Input 0.10 USD / 1M tokens";
        const sourceText = `${evidence}\n${otherEvidence}\n${thirdPartyEvidence}`;
        expect(officialModelIdsInPriceText(sourceText)).toEqual([officialId, otherId, "deepseek-r1-250528"]);
        mocks.ai.mockResolvedValue({ arguments: JSON.stringify({ findings: [finding, { ...finding, officialModelId: "deepseek-r1-250528", evidence: thirdPartyEvidence }] }), headers: new Headers() });
        const result = await reviewOfficialPrices({ ...reviewInput, sourceText });
        expect(result.findings.map((item) => item.officialModelId)).toEqual([officialId]);
        expect(result).toMatchObject({ sourceOfficialModelIds: [officialId, otherId], missingOfficialModelIds: [otherId], aiReturnedCount: 2 });
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`仍未核对：${otherId}`)]));
        expect(mocks.ai.mock.calls[0][0].messages[1].content).toContain('"sourceOfficialModelIds":["seedream-4-5-251128","seed-2-0-lite-260428"]');
    });

    it("keeps the full official ID for Dola Seedream and Dreamina Seedance price rows", async () => {
        const seedanceId = "dreamina-seedance-2-0-260128";
        const seedreamId = "dola-seedream-5-0-pro-260628";
        const row = `${seedanceId}\nFor 480p and 720p outputs:\nInput without video: 7.0`;
        expect(officialModelIdsInPriceText(`${row}\n${seedreamId} Output 0.3 USD / image`)).toEqual([seedanceId, seedreamId]);
        mocks.settings.mockResolvedValue({ logicalModels: [{ ...model, id: "ByteDance-Seedance-2.0", name: "ByteDance-Seedance-2.0", manufacturer: reviewInput.manufacturer, series: "Seedance" }], defaultModels: { textModel: "text-model" } });
        mocks.page.mockImplementation(async (url: string) =>
            url === sourceUrl
                ? {
                      url,
                      text: `Model ID Online inference (USD / M tokens)\n${row}`,
                      tables: [
                          {
                              id: "t3",
                              header: "Model ID Online inference (USD / M tokens)",
                              rows: [
                                  { id: "t3r0", text: "Model ID Online inference (USD / M tokens)" },
                                  { id: "t3r2", text: row },
                              ],
                          },
                      ],
                  }
                : { url, text: "Model deprecations", tables: [] },
        );
        mocks.ai.mockImplementation(async ({ messages }: { messages: Array<{ content: string }> }) => {
            const payload = JSON.parse(messages[1].content) as { sourceOfficialModelIds: string[] };
            expect(payload.sourceOfficialModelIds).toEqual([seedanceId]);
            return {
                arguments: JSON.stringify({
                    findings: [{ ...finding, logicalModelId: "ByteDance-Seedance-2.0", officialModelId: seedanceId, evidence: row, sourceRowIds: ["t3r2"], items: [{ key: "videoOutput", unit: "token", per: "1000000", price: "7.0", currency: "USD" }] }],
                }),
                headers: new Headers(),
            };
        });
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.sourceOfficialModelIds).toEqual([seedanceId]);
        expect(result.missingOfficialModelIds).toEqual([]);
        expect(result.findings).toMatchObject([{ officialModelId: seedanceId, sourceRowIds: ["t3r2"] }]);
    });

    it("lets AI recognize a new vendor prefix and quarantines uncertain ownership", async () => {
        const renamedId = "studio-seedream-4-5-251128";
        const renamedEvidence = `${renamedId} Output 0.04 USD / image`;
        expect(officialModelIdsInPriceText(renamedEvidence)).toEqual([renamedId]);
        mocks.page.mockImplementation(async (url: string) => ({ url, text: url === sourceUrl ? renamedEvidence : "Model deprecations" }));
        mocks.ai.mockResolvedValue({ arguments: JSON.stringify({ findings: [{ ...finding, officialModelId: renamedId, evidence: renamedEvidence }] }), headers: new Headers() });
        mocks.classify
            .mockResolvedValueOnce({ arguments: JSON.stringify({ selectedIds: [renamedId], otherIds: [], uncertainIds: [] }), headers: new Headers() })
            .mockResolvedValueOnce({ arguments: JSON.stringify({ selectedIds: [], otherIds: [], uncertainIds: [renamedId] }), headers: new Headers() });
        const selected = await reviewOfficialPrices(reviewInput);
        expect(selected.findings).toMatchObject([{ officialModelId: renamedId, status: "new", candidate: { sku: renamedId } }]);
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.sourceOfficialModelIds).toEqual([renamedId]);
        expect(result.findings).toMatchObject([{ officialModelId: renamedId, status: "needs-review", candidate: null }]);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`厂商归属待确认：${renamedId}`)]));
    });

    it("stops safely when all visible models belong to other manufacturers", async () => {
        mocks.page.mockImplementation(async (url: string) => ({ url, text: url === sourceUrl ? "deepseek-r1-250528 Input 0.10 USD / 1M tokens" : "Model deprecations" }));
        await expect(reviewOfficialPrices(reviewInput)).rejects.toThrow("没有可核对的所选厂商型号");
        expect(mocks.ai).not.toHaveBeenCalled();
    });

    it("reviews rendered price rows by model and rejects rows outside the current batch", async () => {
        const secondId = "seedream-4-0-250828";
        const secondEvidence = `${secondId} Input free Output 0.03 USD / image`;
        const foreignEvidence = "deepseek-r1-250528 Output 0.10 USD / 1M tokens";
        const text = `Model ID  Output (USD / image)\n${evidence}\n${foreignEvidence}\n${secondEvidence}`;
        mocks.settings.mockResolvedValue({ logicalModels: [model, { ...model, id: "ByteDance-Seed-2.0", name: "ByteDance-Seed-2.0", series: "Seed" }], defaultModels: { textModel: "text-model" } });
        mocks.page.mockImplementation(async (url: string) =>
            url === sourceUrl
                ? {
                      url,
                      text,
                      tables: [
                          {
                              id: "t0",
                              header: "Model ID  Output (USD / image)",
                              rows: [
                                  { id: "t0r0", text: "Model ID  Output (USD / image)" },
                                  { id: "t0r1", text: evidence },
                                  { id: "t0r2", text: foreignEvidence },
                                  { id: "t0r3", text: secondEvidence },
                              ],
                          },
                      ],
                  }
                : { url, text: "Model deprecations", tables: [] },
        );
        const partial = vi.fn();
        mocks.ai.mockImplementation(async ({ messages }: { messages: Array<{ content: string }> }) => {
            const payload = JSON.parse(messages[1].content) as { sourceOfficialModelIds: string[]; priceText: string; platformModels: Array<{ id: string }> };
            const id = payload.sourceOfficialModelIds[0];
            expect(payload.priceText).not.toContain(id === officialId ? secondEvidence : evidence);
            expect(payload.priceText).not.toContain(foreignEvidence);
            expect(payload.platformModels.map((item) => item.id)).toEqual([model.id]);
            const selected = id === officialId ? { ...finding, sourceRowIds: ["t0r1"] } : { ...finding, officialModelId: secondId, evidence: secondEvidence, sourceRowIds: ["t0r3"], items: [{ ...finding.items[0], price: "0.03" }] };
            return { arguments: JSON.stringify({ findings: [selected, { ...selected, officialModelId: id === officialId ? secondId : officialId }, { ...selected, sourceRowIds: ["unknown-row"] }] }), headers: new Headers() };
        });
        const result = await reviewOfficialPrices({ ...reviewInput, onPartial: partial });
        expect(mocks.ai).toHaveBeenCalledTimes(2);
        expect(partial).toHaveBeenCalledTimes(2);
        expect(result.findings.map((item) => item.officialModelId)).toEqual([officialId, secondId]);
        expect(result.findings.map((item) => item.sourceRowIds)).toEqual([["t0r1"], ["t0r3"]]);
        expect(result.missingOfficialModelIds).toEqual([]);
    });

    it("keeps verified batches when a later model request fails", async () => {
        const secondId = "seedream-4-0-250828";
        const secondEvidence = `${secondId} Input free Output 0.03 USD / image`;
        mocks.page.mockImplementation(async (url: string) =>
            url === sourceUrl
                ? {
                      url,
                      text: `${evidence}\n${secondEvidence}`,
                      tables: [
                          {
                              id: "t0",
                              header: "Model ID  Output (USD / image)",
                              rows: [
                                  { id: "t0r0", text: "Model ID  Output (USD / image)" },
                                  { id: "t0r1", text: evidence },
                                  { id: "t0r2", text: secondEvidence },
                              ],
                          },
                      ],
                  }
                : { url, text: "Model deprecations", tables: [] },
        );
        mocks.ai.mockResolvedValueOnce({ arguments: JSON.stringify({ findings: [{ ...finding, sourceRowIds: ["t0r1"] }] }), headers: new Headers() }).mockRejectedValueOnce(new Error("channel timeout"));
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.findings).toHaveLength(1);
        expect(result.missingOfficialModelIds).toEqual([secondId]);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`${secondId} 本次未核对成功`)]));
    });

    it("splits only a timed-out model batch along its existing table sections", async () => {
        const secondEvidence = `${officialId} Premium output 0.05 USD / image`;
        mocks.page.mockImplementation(async (url: string) =>
            url === sourceUrl
                ? {
                      url,
                      text: `${evidence}\n${secondEvidence}`,
                      tables: [
                          {
                              id: "t0",
                              header: "Standard USD / image",
                              rows: [
                                  { id: "t0r0", text: "Standard USD / image" },
                                  { id: "t0r1", text: evidence },
                              ],
                          },
                          {
                              id: "t1",
                              header: "Premium USD / image",
                              rows: [
                                  { id: "t1r0", text: "Premium USD / image" },
                                  { id: "t1r1", text: secondEvidence },
                              ],
                          },
                      ],
                  }
                : { url, text: "Model deprecations", tables: [] },
        );
        const { TextPlanningRequestError } = await import("@/lib/server/text-planning-runtime");
        mocks.ai
            .mockRejectedValueOnce(new TextPlanningRequestError("timeout", 504, false, "transport"))
            .mockResolvedValueOnce({ arguments: JSON.stringify({ findings: [{ ...finding, sourceRowIds: ["t0r1"] }] }), headers: new Headers() })
            .mockResolvedValueOnce({ arguments: JSON.stringify({ findings: [{ ...finding, evidence: secondEvidence, sourceRowIds: ["t1r1"], conditions: "Premium", items: [{ ...finding.items[0], price: "0.05" }] }] }), headers: new Headers() });
        const result = await reviewOfficialPrices(reviewInput);
        expect(mocks.ai).toHaveBeenCalledTimes(3);
        expect(result.findings.map((item) => item.sourceRowIds)).toEqual([["t0r1"], ["t1r1"]]);
        expect(result.missingOfficialModelIds).toEqual([]);
    });

    it("quarantines conflicting prices from the same official row", async () => {
        const combined = `${officialId} Output 0.04 or 0.05 USD / image`;
        mocks.page.mockImplementation(async (url: string) =>
            url === sourceUrl
                ? {
                      url,
                      text: combined,
                      tables: [
                          {
                              id: "t0",
                              header: "Output USD / image",
                              rows: [
                                  { id: "t0r0", text: "Output USD / image" },
                                  { id: "t0r1", text: combined },
                              ],
                          },
                      ],
                  }
                : { url, text: "Model deprecations", tables: [] },
        );
        mocks.ai.mockResolvedValue({
            arguments: JSON.stringify({
                findings: [
                    { ...finding, evidence: combined, sourceRowIds: ["t0r1"] },
                    { ...finding, evidence: combined, sourceRowIds: ["t0r1"], conditions: "另一档", items: [{ ...finding.items[0], price: "0.05" }] },
                    { ...finding, evidence: combined, sourceRowIds: ["t0r1"], items: [{ ...finding.items[0], currency: "CNY" }] },
                ],
            }),
            headers: new Headers(),
        });
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.findings).toMatchObject([{ status: "needs-review", candidate: null }]);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("同一官网证据产生冲突")]));
    });

    it("warns when a model has visible price rows that the AI did not cite", async () => {
        const extra = `${officialId} High resolution 0.08 USD / image`;
        mocks.page.mockImplementation(async (url: string) =>
            url === sourceUrl
                ? {
                      url,
                      text: `${evidence}\n${extra}`,
                      tables: [
                          {
                              id: "t0",
                              header: "Output USD / image",
                              rows: [
                                  { id: "t0r0", text: "Output USD / image" },
                                  { id: "t0r1", text: evidence },
                                  { id: "t0r2", text: extra },
                              ],
                          },
                      ],
                  }
                : { url, text: "Model deprecations", tables: [] },
        );
        mocks.ai.mockResolvedValue({ arguments: JSON.stringify({ findings: [{ ...finding, sourceRowIds: ["t0r1"] }] }), headers: new Headers() });
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("t0r2 尚未核对")]));
    });

    it("retains a DeepSeek model when DeepSeek is the selected manufacturer", () => {
        const quote = "deepseek-r1-250528 Input 0.10 USD / 1M tokens";
        const rows = parseFindings(
            JSON.stringify({ findings: [{ ...finding, logicalModelId: null, officialModelId: "deepseek-r1-250528", evidence: quote }] }),
            quote,
            "",
            [],
            [],
            [],
            "https://api-docs.deepseek.com/quick_start/pricing",
            "2026-10-01T00:00:00Z",
            "website",
            "DeepSeek",
        );
        expect(rows).toMatchObject([{ officialModelId: "deepseek-r1-250528", status: "unmatched" }]);
    });

    it("does not map a Seed price to a Seedream logical model", () => {
        const seedQuote = "seed-2-0-lite-260428 Output 0.25 USD / 1M tokens";
        const rows = parseFindings(JSON.stringify({ findings: [{ ...finding, officialModelId: "seed-2-0-lite-260428", evidence: seedQuote }] }), seedQuote, "", [model.id], [], [], sourceUrl, "2026-10-01T00:00:00Z", "website", reviewInput.manufacturer, [
            { id: model.id, series: "Seedream" },
        ]);
        expect(rows[0]).toMatchObject({ logicalModelId: null, status: "unmatched", candidate: null });
    });

    it("marks retirement only when the official lifecycle excerpt explicitly names the model", async () => {
        const retirement = `${officialId} was deactivated on January 1, 2026`;
        const rows = parseFindings(JSON.stringify({ findings: [{ ...finding, status: "confirmed-retired", evidence: retirement, deactivationDate: "2026-01-01", items: [] }] }), evidence, retirement, [model.id], [], [], sourceUrl, "2026-09-30T00:00:00Z");
        expect(rows[0]).toMatchObject({ status: "confirmed-retired", candidate: null });
        const upcoming = parseFindings(
            JSON.stringify({ findings: [{ ...finding, status: "confirmed-retired", evidence: `${officialId} will be deactivated on November 11, 2099`, deactivationDate: "2099-11-11", items: [] }] }),
            evidence,
            `${officialId} will be deactivated on November 11, 2099`,
            [model.id],
            [],
            [],
            sourceUrl,
            "2026-09-30T00:00:00Z",
        );
        expect(upcoming[0].status).toBe("retirement-announced");
        mocks.saveMark.mockImplementation(async (mark) => mark);
        const saved = await markByteDanceSeedRetired({ logicalModelId: model.id, officialModelId: officialId, evidence: retirement, evidenceMode: "website", deactivationDate: "2026-01-01", observedAt: "2026-09-30T00:00:00Z", actorId: "admin" });
        expect(saved.sourceUrl).toContain("model-deprecation-notice");
    });

    it("keeps the pilot limited to Seedream and Seed rather than Seedance", () => {
        expect(isByteDanceSeedPilotModel(model)).toBe(true);
        expect(isByteDanceSeedPilotModel({ id: "doubao-seed-2-0", name: "Seed 2.0" })).toBe(true);
        expect(isByteDanceSeedPilotModel({ id: "doubao-seedance-2-0", name: "Seedance" })).toBe(false);
        expect(isByteDanceSeedPilotModel({ id: "other-seed-2-0", name: "Seed 2.0" })).toBe(false);
    });

    it("rejects a price document redirected away from the official site", async () => {
        mocks.page.mockResolvedValue({ url: "https://example.com/pricing", text: evidence });
        await expect(reviewOfficialPrices(reviewInput)).rejects.toThrow("非所选官网");
        expect(mocks.ai).not.toHaveBeenCalled();
    });

    it("offers an official excerpt fallback when the price site is unreachable", async () => {
        mocks.page.mockRejectedValue(new Error("network unavailable"));
        await expect(reviewOfficialPrices(reviewInput)).rejects.toThrow("粘贴所选官网价格表原文");
        expect(mocks.ai).not.toHaveBeenCalled();
    });

    it("reports models absent from the supplied evidence without claiming retirement", async () => {
        mocks.settings.mockResolvedValue({ logicalModels: [model, { ...model, id: "ByteDance-Seedream-5.0", name: "ByteDance-Seedream-5.0" }], defaultModels: { textModel: "text-model" } });
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("ByteDance-Seedream-5.0；不能据此判定下架")]));
        expect(result.findings).toHaveLength(1);
    });

    it("reviews another manufacturer using only its saved source and model series", async () => {
        const other = { ...model, id: "openai-image-model", name: "OpenAI image", manufacturer: "OpenAI", series: "GPT Image" };
        const otherUrl = "https://developers.openai.com/api/docs/pricing";
        const otherEvidence = "gpt-image-1 output 0.04 USD / image";
        mocks.settings.mockResolvedValue({ logicalModels: [other], defaultModels: { textModel: "text-model" } });
        mocks.links.mockResolvedValue([{ url: otherUrl, label: "当前厂商官网链接" }]);
        mocks.page.mockResolvedValue({ url: otherUrl, text: otherEvidence });
        mocks.ai.mockResolvedValue({ arguments: JSON.stringify({ findings: [{ ...finding, logicalModelId: other.id, officialModelId: "gpt-image-1", evidence: otherEvidence }] }), headers: new Headers() });
        const result = await reviewOfficialPrices({ ...reviewInput, manufacturer: "OpenAI", sourceUrl: otherUrl });
        expect(result).toMatchObject({ manufacturer: "OpenAI", retirementUrl: "", retirementMode: "unavailable" });
        expect(result.findings[0].candidate).toMatchObject({ manufacturer: "OpenAI", series: "GPT Image", sourceUrl: otherUrl });
        expect(mocks.page).toHaveBeenCalledTimes(1);
        await expect(reviewOfficialPrices({ ...reviewInput, manufacturer: "OpenAI", sourceUrl: sourceUrl })).rejects.toThrow("不属于该厂商");
    });

    it("keeps an unconfirmed non-ByteDance series out of importable candidates", () => {
        const otherId = "openai-image-model";
        const quote = "gpt-image-1 output 0.04 USD / image";
        const rows = parseFindings(
            JSON.stringify({ findings: [{ ...finding, logicalModelId: otherId, officialModelId: "gpt-image-1", evidence: quote }] }),
            quote,
            "",
            [otherId],
            [],
            [],
            "https://developers.openai.com/api/docs/pricing",
            "2026-10-01T00:00:00Z",
            "website",
            "OpenAI",
            [{ id: otherId, series: "" }],
        );
        expect(rows[0]).toMatchObject({ status: "needs-review", candidate: null });
    });

    it("retains verified price rows for an official model without a platform match", () => {
        const rows = parseFindings(JSON.stringify({ findings: [{ ...finding, logicalModelId: null }] }), evidence, "", [model.id], [], [], sourceUrl, "2026-10-01T00:00:00Z");
        expect(rows[0]).toMatchObject({ status: "unmatched", candidate: null, observedItems: finding.items, observedConditions: finding.conditions });
    });

    it("keeps evidenced price numbers when applicability conditions still need human review", () => {
        const rows = parseFindings(JSON.stringify({ findings: [{ ...finding, conditions: "" }] }), evidence, "", [model.id], [], [], sourceUrl, "2026-10-01T00:00:00Z");
        expect(rows[0]).toMatchObject({ status: "needs-review", candidate: null, observedItems: finding.items, observedConditions: "" });
    });

    it("can discover a vendor's official model before any platform model is configured", async () => {
        mocks.settings.mockResolvedValue({ logicalModels: [], defaultModels: { textModel: "text-model" } });
        mocks.ai.mockResolvedValue({ arguments: JSON.stringify({ findings: [{ ...finding, logicalModelId: null }] }), headers: new Headers() });
        const result = await reviewOfficialPrices(reviewInput);
        expect(result.findings).toMatchObject([{ status: "unmatched", observedItems: finding.items, candidate: null }]);
    });

    it("shows the upstream 404 cause instead of a generic model failure", async () => {
        const { TextPlanningRequestError } = await import("@/lib/server/text-planning-runtime");
        mocks.ai.mockRejectedValue(new TextPlanningRequestError("upstream 404", 404));
        await expect(reviewOfficialPrices(reviewInput)).rejects.toThrow("接口路径与模型 ID");
    });
});
