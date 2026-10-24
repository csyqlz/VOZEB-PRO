import { describe, expect, it } from "vitest";
import type { OfficialPriceVersion, SalesVersion } from "@/lib/model-pricing";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { HAILUO_PRICE_MODELS, HAILUO_PRICE_TIERS, inspectHailuoObservation, inspectHailuoRequestBound, prepareHailuoPriceBound, previewHailuoQuote, validateHailuoPriceContract, type HailuoPriceContract } from "./model-pricing-hailuo-contract";
import type { VideoPriceCallContext } from "./model-pricing-video-contract";

const now = "2026-10-10T00:00:00Z";
function pricing(model: (typeof HAILUO_PRICE_MODELS)[number] = "MiniMax-Hailuo-2.3") {
    // Deliberately synthetic rates. No official approval or live channel admission.
    const version: OfficialPriceVersion = {
        id: "official",
        candidateId: "candidate",
        logicalModelId: "logical",
        manufacturer: "MiniMax",
        series: "Hailuo",
        officialVersion: model,
        sku: model,
        tier: "paid",
        conditions: "standard generation",
        sourceKind: "manual",
        sourceUrl: "https://platform.minimax.io/docs/guides/pricing-paygo",
        evidence: "fixture",
        observedAt: now,
        publishedAt: now,
        reviewedBy: "admin",
        effectiveTo: "2026-11-01T00:00:00Z",
        items: HAILUO_PRICE_TIERS.map((key, i) => ({ key, unit: "video", per: "1", price: ["0.0015", "0.123", "0.789"][i], currency: "USD" })),
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
    const contract: HailuoPriceContract = {
        officialVersionId: version.id,
        channelId: "channel",
        requestedModel: model,
        protocol: "minimax-hailuo-v1",
        scope: "global-standard-minimax-hailuo-generation",
        tierItems: { "768P-6": "768P-6", "768P-10": "768P-10", "1080P-6": "1080P-6" },
        evidence: "fixture",
        reviewedBy: "admin",
        reviewedAt: now,
    };
    const call: VideoPriceCallContext = {
        officialVersionId: version.id,
        salesVersionId: policy.id,
        logicalModelId: "logical",
        channelId: "channel",
        requestedModel: model,
        declaredProtocol: "minimax",
        operation: "generation",
        region: "global",
        billingMode: "standard",
        occurredAt: now,
    };
    return { version, policy, contract, call };
}
const request = (model = "MiniMax-Hailuo-2.3", image = false) => ({ model, prompt: "private prompt", ...(image ? { first_frame_image: "https://fixture.example/private.png" } : {}), duration: 6, resolution: "768P" });
const response = () => ({ task_id: "original", status: "Success", file_id: "original-file", video_width: 1366, video_height: 768, base_resp: { status_code: 0, status_msg: "private message" } });
function quote() {
    return { ...pricing(), bound: inspectHailuoRequestBound(request(), "MiniMax-Hailuo-2.3", "minimax"), observation: inspectHailuoObservation(response(), "original"), upstreamTaskId: "original", responseComplete: true };
}

describe("Hailuo V1 independent per-video contract", () => {
    it("quotes a frozen ownerless selection using the logical model's sale coefficient", () => {
        const original = pricing();
        const priceSelection = { logicalModelId: "logical", scope: "video:generation:standard", bindingId: "binding", bindingRevision: "revision", officialVersionId: original.version.id };
        const input = {
            ...original,
            version: { ...original.version, logicalModelId: "", capability: "video" as const },
            policy: { ...original.policy, priceVersionIds: {}, selectedPriceBindings: [priceSelection], userPriceRules: [{ scope: "model" as const, modelId: "logical", coefficient: "2" }] },
            priceSelection,
        };
        const prepared = prepareHailuoPriceBound({ ...input, payload: request() });
        expect(prepared).toMatchObject({ ready: true, maximumExactPoints: "21/10" });
        if (!prepared.ready) throw new Error(prepared.reasons.join());
        expect(previewHailuoQuote({ ...input, bound: prepared.bound, observation: inspectHailuoObservation(response(), "original"), upstreamTaskId: "original", responseComplete: true })).toMatchObject({
            ready: true,
            quote: { modelId: "logical", exactPoints: "21/10" },
        });
        expect(prepareHailuoPriceBound({ ...input, priceSelection: { ...priceSelection, bindingRevision: "stale" }, payload: request() }).ready).toBe(false);
    });
    it.each(HAILUO_PRICE_MODELS)("quotes every %s tariff and supported mode once", (model) => {
        for (const [index, tier] of HAILUO_PRICE_TIERS.entries())
            for (const image of model.endsWith("Fast") ? [true] : [false, true]) {
                const [resolution, duration] = tier.split("-");
                const payload = { ...request(model, image), resolution, duration: Number(duration) };
                const input = pricing(model);
                const before = structuredClone(payload);
                const prepared = prepareHailuoPriceBound({ ...input, payload });
                expect(prepared).toMatchObject({ ready: true, maximumExactPoints: ["21/20", "861/10", "5523/10"][index] });
                if (!prepared.ready) throw new Error(prepared.reasons.join());
                const result = previewHailuoQuote({ ...input, bound: prepared.bound, observation: inspectHailuoObservation(response(), "original"), upstreamTaskId: "original", responseComplete: true });
                expect(result).toMatchObject({ ready: true, quote: { exactPoints: prepared.maximumExactPoints, points: ["1.05", "86.10", "552.30"][index] } });
                if (!result.ready) throw new Error(result.reasons.join());
                expect(result.usage).toEqual(Object.fromEntries(HAILUO_PRICE_TIERS.map((key) => [key, key === tier ? "1" : "0"])));
                expect(payload).toEqual(before);
                expect(JSON.stringify(prepared)).not.toMatch(/private|first_frame_image/);
            }
    });
    it("freezes documented omitted defaults without changing the outgoing payload", () => {
        const payload = { model: "MiniMax-Hailuo-2.3", prompt: "test" };
        const before = structuredClone(payload);
        expect(inspectHailuoRequestBound(payload, payload.model, "minimax")).toMatchObject({ tier: "768P-6", maximumVideos: "1", mode: "text" });
        expect(payload).toEqual(before);
        expect(inspectHailuoRequestBound({ model: "MiniMax-Hailuo-2.3-Fast", first_frame_image: "data:image/png;base64,YQ==" }, "MiniMax-Hailuo-2.3-Fast", "minimax").mode).toBe("image");
    });
    it("uses only one sales coefficient and preserves the actual reviewer", () => {
        const input = quote();
        const before = structuredClone(input);
        expect(
            previewHailuoQuote({
                ...input,
                policy: {
                    ...input.policy,
                    userPriceRules: [
                        { scope: "default", coefficient: "9" },
                        { scope: "model", modelId: "logical", coefficient: "1.5" },
                    ],
                },
            }),
        ).toMatchObject({ ready: true, quote: { exactPoints: "63/40" } });
        expect(validateHailuoPriceContract({ ...input.contract, reviewedBy: "forged" }, input.version, "real", now).reviewedBy).toBe("real");
        expect(input).toEqual(before);
    });
    it.each([
        { model: "MiniMax-H3" },
        { model: "minimax-hailuo-2.3" },
        { duration: 5 },
        { duration: "6" },
        { duration: null },
        { resolution: "auto" },
        { resolution: "768p" },
        { resolution: null },
        { resolution: "1080P", duration: 10 },
        { n: 2 },
        { last_frame_image: "x" },
        { content: [] },
        { service_tier: "priority" },
        { prompt: " " },
        { prompt: 1 },
        { first_frame_image: " " },
        { first_frame_image: [] },
        { prompt_optimizer: 1 },
        { fast_pretreatment: "true" },
        { callback_url: {} },
    ])("rejects an unsupported request without normalization %j", (patch) => {
        const payload = { ...request(), ...patch };
        const before = structuredClone(payload);
        expect(prepareHailuoPriceBound({ ...pricing(), payload }).ready).toBe(false);
        expect(payload).toEqual(before);
    });
    it("rejects Fast text-only and another protocol", () => {
        expect(prepareHailuoPriceBound({ ...pricing("MiniMax-Hailuo-2.3-Fast"), payload: request("MiniMax-Hailuo-2.3-Fast") }).ready).toBe(false);
        expect(() => inspectHailuoRequestBound(request(), request().model, "custom")).toThrow();
    });
    it.each(["0", "-1", "NaN", "Infinity", "1/2"])("does not publish or charge invalid/free standard price %s", (price) => {
        const input = pricing();
        input.version.items[0].price = price;
        expect(() => validateHailuoPriceContract(input.contract, input.version, "admin", now)).toThrow();
        expect(prepareHailuoPriceBound({ ...input, payload: request() }).ready).toBe(false);
    });
    it("rejects missing, duplicate, wrong-unit, mixed-model and unapproved tariffs", () => {
        const { version, contract } = pricing();
        for (const patch of [
            { sku: "MiniMax-H3" },
            { tier: "free" as const },
            { reviewedBy: "" },
            { publishedAt: "bad" },
            { items: version.items.slice(1) },
            { items: [...version.items, version.items[0]] },
            { items: version.items.map((x) => ({ ...x, unit: "second" })) },
            { items: version.items.map((x) => ({ ...x, per: "6" })) },
        ])
            expect(() => validateHailuoPriceContract(contract, { ...version, ...patch }, "admin", now)).toThrow();
        for (const patch of [
            { tierItems: {} },
            { tierItems: { ...contract.tierItems, "1080P-6": "768P-6" } },
            { tierItems: { ...contract.tierItems, extra: "extra" } },
            { protocol: "minimax-video-v2" },
            { scope: "regeneration" },
            { channelId: " " },
            { evidence: "" },
        ])
            expect(() => validateHailuoPriceContract({ ...contract, ...patch }, version, "admin", now)).toThrow();
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
        expect(previewHailuoQuote(changed).ready).toBe(false);
        expect(prepareHailuoPriceBound({ ...changed, payload: request() }).ready).toBe(false);
    });
    it.each(["task_id", "status", "file_id", "video_width", "video_height", "base_resp"])("preserves missing %s rather than fabricating usage", (key) => {
        const payload = { ...response() } as Record<string, unknown>;
        delete payload[key];
        const observation = inspectHailuoObservation(payload, "original");
        expect(observation.missing.length).toBeGreaterThan(0);
        expect(previewHailuoQuote({ ...quote(), observation }).ready).toBe(false);
    });
    it.each([
        { task_id: "other" },
        { status: "Processing" },
        { status: "Fail" },
        { status: "Success", file_id: " " },
        { base_resp: { status_code: "0" } },
        { base_resp: { status_code: 1000 } },
        { error: { message: "bad" } },
        { video_width: -1 },
        { video_height: 1.5 },
    ])("refuses incomplete or contradictory original facts %j", (patch) => {
        expect(previewHailuoQuote({ ...quote(), observation: inspectHailuoObservation({ ...response(), ...patch }, "original") }).ready).toBe(false);
    });
    it("never turns failures, missing status or truncated transport into zero-priced success", () => {
        expect(previewHailuoQuote({ ...quote(), responseComplete: false }).ready).toBe(false);
        expect(previewHailuoQuote({ ...quote(), upstreamTaskId: "wrong" }).ready).toBe(false);
        const observation = inspectHailuoObservation({ ...response(), usage: { output_seconds: 0 }, prompt: "secret", download_url: "https://private" }, "original");
        expect(observation).toMatchObject({ ...inspectHailuoObservation(response(), "original"), usageFields: { output_seconds: "0" } });
        expect(JSON.stringify(observation)).not.toMatch(/secret|private|model|duration/);
    });
    it("rejects tampered protocol, bounds, scope and invalid observed dimensions", () => {
        const input = quote();
        for (const patch of [{ sourceUrl: "https://fake" }, { maximumVideos: "2" }, { tier: "1080P-10" }, { protocol: "minimax-video-v2" }, { mode: "other" }, { requestedModel: "MiniMax-H3" }])
            expect(previewHailuoQuote({ ...input, bound: { ...input.bound, ...patch } as typeof input.bound }).ready).toBe(false);
        for (const patch of [{ protocol: "minimax-video-v2" }, { missing: ["file"] }, { invalid: ["wrong"] }, { width: 0 }, { height: 1.5 }])
            expect(previewHailuoQuote({ ...input, observation: { ...input.observation, ...patch } as typeof input.observation }).ready).toBe(false);
        expect(previewHailuoQuote({ ...input, contract: { ...input.contract, officialVersionId: "other" } }).ready).toBe(false);
        expect(previewHailuoQuote({ ...input, policy: { ...input.policy, priceVersionIds: {} } }).ready).toBe(false);
    });
    it.each(HAILUO_PRICE_MODELS)("quotes %s against original V1 TCP create/query/file facts", async (model) => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        try {
            const address = fixture.server.address();
            if (!address || typeof address === "string") throw new Error("fixture bind failed");
            const origin = `http://127.0.0.1:${address.port}`;
            for (const tier of HAILUO_PRICE_TIERS) {
                const [resolution, duration] = tier.split("-");
                const payload = { ...request(model, true), resolution, duration: Number(duration) };
                const input = pricing(model);
                const prepared = prepareHailuoPriceBound({ ...input, payload });
                if (!prepared.ready) throw new Error(prepared.reasons.join());
                const created = await fetch(`${origin}/v1/video_generation`, { method: "POST", headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((r) => r.json());
                const result = await fetch(`${origin}/v1/query/video_generation?task_id=${created.task_id}`).then((r) => r.json());
                const observation = inspectHailuoObservation(result, created.task_id);
                expect(previewHailuoQuote({ ...input, bound: prepared.bound, observation, upstreamTaskId: created.task_id, responseComplete: true })).toMatchObject({ ready: true, quote: { exactPoints: prepared.maximumExactPoints } });
                const file = await fetch(`${origin}/v1/files/retrieve?file_id=${result.file_id}`).then((r) => r.json());
                const media = await fetch(file.file.download_url);
                expect(media.ok).toBe(true);
                expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(0);
            }
            expect(fixture.requests.filter((r) => r.method === "POST")).toHaveLength(3);
        } finally {
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
