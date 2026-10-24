import { describe, expect, it } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { prepareVideoRequestPriceBound, previewObservedVideoQuote, validateVideoPriceContract, type VideoPriceCallContext, type VideoPriceContract } from "./model-pricing-video-contract";
import { inspectMinimaxVideoRequestBound, validateObservedVideoRequestBound, type MinimaxVideoModel } from "./model-pricing-video-request";
import { inspectMinimaxVideoUsage } from "./model-pricing-video-usage";

const now = "2026-10-09T00:00:00Z";
function pricing(model: MinimaxVideoModel = "MiniMax-H3") {
    // Synthetic reviewed versions, not published production prices or real channel admission.
    const rates: Record<string, string[]> = model === "MiniMax-H3" ? { "768P": ["0.08", "0.08"], "2K": ["0.13", "0.13"] } : { "480P": ["0.0553", "0.05"], "768P": ["0.143", "0.08"] };
    const version: OfficialPriceVersion = {
        id: "official",
        candidateId: "candidate",
        logicalModelId: "logical",
        manufacturer: "MiniMax",
        series: "H3",
        officialVersion: model,
        sku: model,
        tier: "paid",
        conditions: "global standard generation",
        sourceKind: "manual",
        sourceUrl: "https://platform.minimax.io/docs/pricing/overview",
        evidence: "fixture",
        observedAt: now,
        publishedAt: now,
        reviewedBy: "admin",
        effectiveTo: "2026-11-01T00:00:00Z",
        items: [
            ...Object.entries(rates).flatMap(([r, prices]) => prices.map((price, index) => ({ key: `${r}-${index}`, unit: "second", per: "1", price, currency: "USD" }))),
            { key: "images", unit: "image", per: "1", price: model === "MiniMax-H3" ? "0.04" : "0.074", currency: "USD" },
            { key: "inputAudioSeconds", unit: "second", per: "1", price: "0", currency: "USD" },
        ],
    };
    const policy: SalesVersion = {
        id: "sales",
        publishedAt: now,
        publishedBy: "admin",
        priceVersionIds: { logical: "official" },
        userPriceRules: [],
        conversion: { cnyPerUsd: "7", pointsPerCny: "100", observedAt: now, evidence: "fixture" },
        pointsPerCurrency: { USD: "700", CNY: "100" },
        usdPerCurrency: { USD: "1" },
        rateEvidence: { USD: "fixture" },
    };
    const contract: VideoPriceContract = {
        officialVersionId: version.id,
        channelId: "channel",
        requestedModel: model,
        protocol: "minimax-video-v2",
        scope: "global-standard-minimax-h3-generation",
        resolutionItems: Object.fromEntries(Object.keys(rates).map((r) => [r, { inputSeconds: `${r}-0`, outputSeconds: `${r}-1` }])),
        inputImageItem: "images",
        inputImagePricing: "all-at-standard-rate",
        inputAudioItem: "inputAudioSeconds",
        evidence: "fixture standard paid rates; supplier allowances are not customer allowances",
        reviewedAt: now,
        reviewedBy: "admin",
    };
    const call: VideoPriceCallContext = {
        officialVersionId: version.id,
        salesVersionId: policy.id,
        logicalModelId: version.logicalModelId,
        channelId: contract.channelId,
        requestedModel: model,
        declaredProtocol: "minimax",
        operation: "generation",
        region: "global",
        billingMode: "standard",
        occurredAt: now,
    };
    return { version, policy, contract, call };
}
const media = (type: "image" | "video" | "audio", role = `reference_${type}`) => ({ type: `${type}_url`, [`${type}_url`]: { url: `https://fixture.example.com/private-${type}` }, role });
const request = (model: MinimaxVideoModel = "MiniMax-H3", resolution = "768P", images = 6) => ({
    model,
    resolution,
    duration: 5,
    ratio: "16:9",
    content: [{ type: "text", text: "private prompt" }, ...Array.from({ length: images }, () => media("image")), media("video")],
});
const response = (model: MinimaxVideoModel = "MiniMax-H3", resolution = "768P", images = 6) => ({
    task: {
        id: "original",
        model,
        resolution,
        status: "succeeded",
        task_type: "generation",
        modality: "video",
        content: { url: "https://fixture.example.com/private-result.mp4" },
        usage: { total_seconds: 999, input_seconds: 1.25, output_seconds: 5.25, input_image_count: images, input_audio_seconds: 0 },
    },
});
function quote(model: MinimaxVideoModel = "MiniMax-H3", resolution = "768P", images = 6) {
    const input = pricing(model);
    const bound = inspectMinimaxVideoRequestBound(request(model, resolution, images), model, "minimax");
    const observation = inspectMinimaxVideoUsage(response(model, resolution, images), "original", model);
    return { ...input, bound, observation, upstreamTaskId: "original", responseComplete: true };
}

describe("H3 normal customer rates and independent quantity bounds", () => {
    it.each([
        ["MiniMax-H3", "768P", "532.00", "532"],
        ["MiniMax-H3", "2K", "759.50", "1519/2"],
        ["MiniMax-H3-Max", "480P", "542.94", "8687/16"],
        ["MiniMax-H3-Max", "768P", "729.93", "29197/40"],
    ] as const)("quotes all input/output splits for %s %s", (model, resolution, points, exactPoints) => {
        const input = quote(model, resolution);
        const result = previewObservedVideoQuote(input);
        expect(result.ready).toBe(true);
        if (!result.ready) throw new Error(result.reasons.join());
        expect(result.usage).toMatchObject({ [`${resolution}-0`]: "1.25", [`${resolution}-1`]: "5.25", images: "6" });
        expect(result.quote.points).toBe(points);
        expect(result.quote.exactPoints).toBe(exactPoints);
        const prospective = prepareVideoRequestPriceBound({ ...input, payload: request(model, resolution) });
        expect(prospective).toMatchObject({ ready: true, bound: { maximumQuantities: { inputSeconds: "15", outputSeconds: "15", inputImageCount: "6", inputAudioSeconds: "0" } } });
        expect(JSON.stringify(prospective)).not.toMatch(/private|prompt|totalSeconds/);
    });
    it.each([0, 1, 2, 3, 5, 6, 9])("charges every actual image including supplier-free allowances: %s", (count) => {
        for (const model of ["MiniMax-H3", "MiniMax-H3-Max"] as const) expect(previewObservedVideoQuote(quote(model, "768P", count))).toMatchObject({ ready: true, usage: { images: String(count) } });
    });
    it.each([
        [1e-7, "0.0000001", "7/1250000"],
        [1e-20, "0.00000000000000000001", "7/12500000000000000000"],
    ] as const)("keeps scientific notation %s as an exact decimal rather than dropping sub-cent charges", (seconds, decimal, exactPoints) => {
        const input = quote();
        const payload = response();
        payload.task.usage = { total_seconds: seconds, input_seconds: 0, output_seconds: seconds, input_image_count: 0, input_audio_seconds: 0 };
        expect(previewObservedVideoQuote({ ...input, observation: inspectMinimaxVideoUsage(payload, "original", "MiniMax-H3") })).toMatchObject({ ready: true, usage: { "768P-1": decimal }, quote: { exactPoints, points: "0.00" } });
        const bound = inspectMinimaxVideoRequestBound({ ...request(), content: [{ type: "text", text: "p" }] }, "MiniMax-H3", "minimax");
        payload.task.usage.input_seconds = seconds;
        expect(previewObservedVideoQuote({ ...input, bound, observation: inspectMinimaxVideoUsage(payload, "original", "MiniMax-H3") }).ready).toBe(false);
    });
    it("keeps standing-free audio unbilled while pricing the other items", () => {
        const input = quote();
        const payload = request();
        payload.content.push(media("audio"));
        const bound = inspectMinimaxVideoRequestBound(payload, "MiniMax-H3", "minimax");
        expect(prepareVideoRequestPriceBound({ ...input, payload })).toMatchObject({ ready: true, bound: { maximumQuantities: { inputAudioSeconds: "15" } }, maximumUsage: { inputAudioSeconds: "0" } });
        const observation = { ...input.observation, quantities: { ...input.observation.quantities, inputAudioSeconds: "3.5" } };
        expect(previewObservedVideoQuote({ ...input, bound, observation })).toMatchObject({ ready: true, usage: { inputAudioSeconds: "0", images: "6" }, quote: { exactPoints: "532" } });
    });
    it("uses one frozen coefficient and never replaces the official evidence or input object", () => {
        const input = quote();
        const before = structuredClone(input);
        expect(
            previewObservedVideoQuote({
                ...input,
                policy: {
                    ...input.policy,
                    userPriceRules: [
                        { scope: "default", coefficient: "8" },
                        { scope: "model", modelId: "logical", coefficient: "1.5" },
                    ],
                },
            }),
        ).toMatchObject({ ready: true, quote: { exactPoints: "798" } });
        expect(input).toEqual(before);
        const reviewed = validateVideoPriceContract({ ...input.contract, reviewedBy: "forged" }, input.version, "actual-admin", now);
        expect(reviewed.reviewedBy).toBe("actual-admin");
    });
    it.each(["inputSeconds", "outputSeconds", "inputImageCount", "inputAudioSeconds"])("rejects absent, negative and excessive %s", (meter) => {
        for (const value of [undefined, "-1", "NaN", "Infinity", "100", "1/2"]) {
            const input = quote();
            const quantities = { ...input.observation.quantities, [meter]: value } as Record<string, string>;
            expect(previewObservedVideoQuote({ ...input, observation: { ...input.observation, quantities } }).ready).toBe(false);
        }
    });
    it.each([
        { reportedModel: "other" },
        { resolution: "480P" },
        { upstreamTaskId: "other" },
        { status: "running" },
        { status: "failed" },
        { status: "cancelled" },
        { hasResult: false },
        { taskType: "regeneration" },
        { modality: "text" },
        { missing: ["task.usage.input_seconds"] },
        { invalid: ["mismatched ID"] },
    ])("rejects incomplete or wrong original receipt %j", (patch) => {
        const input = quote();
        expect(previewObservedVideoQuote({ ...input, observation: { ...input.observation, ...patch } }).ready).toBe(false);
    });
    it.each([
        { channelId: "other" },
        { requestedModel: "other" },
        { declaredProtocol: "custom" },
        { logicalModelId: "other" },
        { officialVersionId: "other" },
        { salesVersionId: "other" },
        { occurredAt: "2026-09-01" },
        { occurredAt: "2026-11-01" },
        { occurredAt: "invalid" },
    ])("rejects an unfrozen call %j", (patch) => {
        const input = quote();
        const changed = { ...input, call: { ...input.call, ...patch } };
        expect(previewObservedVideoQuote(changed).ready).toBe(false);
        expect(prepareVideoRequestPriceBound({ ...changed, payload: request() }).ready).toBe(false);
    });
    it("rejects incomplete tariffs, mixed SKUs, free rates and incorrect unit/mappings", () => {
        const { version, contract } = pricing();
        for (const changed of [
            { ...version, sku: "MiniMax-H3-Max" },
            { ...version, tier: "free" as const },
            { ...version, items: version.items.slice(1) },
            { ...version, items: [...version.items, { ...version.items[0], key: "extra" }] },
            ...["0", "-1", "NaN"].map((price) => ({ ...version, items: version.items.map((item) => (item.key === "inputAudioSeconds" ? item : { ...item, price })) })),
            { ...version, items: version.items.map((item) => (item.key === "inputAudioSeconds" ? { ...item, price: "0.01" } : item)) },
            { ...version, items: version.items.map((item) => ({ ...item, unit: "token" })) },
        ])
            expect(() => validateVideoPriceContract(contract, changed, "admin", now)).toThrow();
        for (const patch of [{ inputImagePricing: "first-five-free" }, { inputAudioItem: "images" }, { resolutionItems: {} }, { inputImageItem: "768P-0" }, { scope: "regeneration" }, { protocol: "minimax-v1" }])
            expect(() => validateVideoPriceContract({ ...contract, ...patch }, version, "admin", now)).toThrow();
    });
    it("supports text, first, last, paired frames, mixed references and the documented Max resolution default", () => {
        for (const content of [
            [{ type: "text", text: "prompt" }],
            [{ type: "text", text: "prompt" }, media("image", "first_frame")],
            [{ type: "text", text: "prompt" }, media("image", "last_frame")],
            [{ type: "text", text: "prompt" }, media("image", "first_frame"), media("image", "last_frame")],
        ]) {
            const payload = { ...request(), content };
            expect(inspectMinimaxVideoRequestBound(payload, payload.model, "minimax").maximumQuantities).toMatchObject({ inputSeconds: "0", inputImageCount: String(content.length - 1) });
        }
        expect(inspectMinimaxVideoRequestBound({ ...request("MiniMax-H3-Max"), resolution: undefined }, "MiniMax-H3-Max", "minimax").resolution).toBe("768P");
        expect(() => inspectMinimaxVideoRequestBound({ ...request(), resolution: undefined }, "MiniMax-H3", "minimax")).toThrow();
    });
    it.each([
        { duration: 3 },
        { duration: 16 },
        { duration: 5.5 },
        { resolution: "auto" },
        { model: "MiniMax-Hailuo-2.3" },
        { content: [] },
        { content: [{ type: "text", text: " " }] },
        { extra: { unknown: true } },
        { service_tier: "priority" },
        { content: [{ type: "text", text: "p" }, media("image", "first_frame"), media("video")] },
    ])("refuses unsupported request bounds without normalizing %j", (patch) => {
        const payload = { ...request(), ...patch };
        const before = structuredClone(payload);
        expect(() => inspectMinimaxVideoRequestBound(payload, "MiniMax-H3", "minimax")).toThrow();
        expect(payload).toEqual(before);
    });
    it("checks declared quantity limits without using requested output duration or free allowances", () => {
        const input = quote();
        expect(validateObservedVideoRequestBound(input.bound, input.observation)).toEqual([]); // Actual 5.25s may exceed requested 5s.
        for (const type of ["image", "video", "audio"] as const) {
            const max = type === "image" ? 9 : 3;
            for (const count of [max, max + 1]) {
                const payload = { ...request(), content: [{ type: "text", text: "p" }, ...Array.from({ length: count }, () => media(type))] };
                if (count === max) expect(() => inspectMinimaxVideoRequestBound(payload, "MiniMax-H3", "minimax")).not.toThrow();
                else expect(() => inspectMinimaxVideoRequestBound(payload, "MiniMax-H3", "minimax")).toThrow();
            }
        }
    });
    it("rejects modified stored bounds and unexpected input instead of billing against a larger ceiling", () => {
        const input = quote();
        for (const patch of [{ outputSeconds: "100" }, { inputSeconds: "100" }, { inputAudioSeconds: "100" }, { inputImageCount: "10" }]) {
            expect(previewObservedVideoQuote({ ...input, bound: { ...input.bound, maximumQuantities: { ...input.bound.maximumQuantities, ...patch } } }).ready).toBe(false);
        }
        const bound = inspectMinimaxVideoRequestBound({ ...request(), content: [{ type: "text", text: "p" }] }, "MiniMax-H3", "minimax");
        expect(previewObservedVideoQuote({ ...input, bound }).ready).toBe(false);
    });
    it.each(["MiniMax-H3", "MiniMax-H3-Max"] as const)("quotes original %s TCP create/query facts with synthetic fractional usage", async (model) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("fixture bind failed");
            const origin = `http://127.0.0.1:${address.port}`;
            for (const resolution of Object.keys(pricing(model).contract.resolutionItems)) {
                const input = quote(model, resolution, 2);
                const created = await fetch(`${origin}/v2/video_generation`, { method: "POST", headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" }, body: JSON.stringify(request(model, resolution, 2)) }).then((r) =>
                    r.json(),
                );
                const stored = fixture.tasks.get(created.task_id);
                Object.assign(stored, { resolution, usage: { ...response(model, resolution, 2).task.usage } });
                const payload = await fetch(`${origin}/v2/query/video_generation/${created.task_id}`).then((r) => r.json());
                const observation = inspectMinimaxVideoUsage(payload, created.task_id, model);
                expect(previewObservedVideoQuote({ ...input, upstreamTaskId: created.task_id, observation })).toMatchObject({ ready: true, usage: { images: "2" } });
                expect(previewObservedVideoQuote({ ...input, upstreamTaskId: "wrong", observation }).ready).toBe(false);
            }
            expect(fixture.requests.filter((r) => r.method === "POST")).toHaveLength(2);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
