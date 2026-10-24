import Decimal from "decimal.js";
import Fraction from "fraction.js";

import { PricingInputError, quoteSalesPrice, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import type { HailuoObservation, HailuoPriceContract, HailuoRequestBound } from "./model-pricing-hailuo-contract";
import type { VideoPriceContract } from "./model-pricing-video-contract";
import type { VideoRequestBound } from "./model-pricing-video-request";
import type { VideoUsageObservation } from "./model-pricing-video-usage";

export type VideoUsageFact = {
    schemaVersion: 1;
    factId: string;
    meter: string;
    value?: string;
    unit: "second" | "image" | "video";
    scope: { kind: "attempt"; scopeId: string };
    sourcePaths: string[];
    sourceKind?: "upstream-response" | "approved-derivation" | "manual-review";
    formula?: string;
    relation?: { kind: "derived-from"; inputFactIds: string[] };
    status: "reported" | "derived" | "reviewed" | "missing" | "invalid";
    evidenceId: string;
    sourceEvidenceId?: string;
};
type VideoContract = (VideoPriceContract | HailuoPriceContract) & { id: string };
type VideoBound = VideoRequestBound | HailuoRequestBound;
type VideoObservation = VideoUsageObservation | HailuoObservation;
const id = (attemptId: string, evidenceId: string, meter: string) => [attemptId, evidenceId, meter].map(encodeURIComponent).join(":");
const numeric = (value: string | undefined) => value !== undefined && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) && new Decimal(value).isFinite();

/** Preserve H3's reported seconds; derive Hailuo's one confirmed file and frozen-tier zero rows separately. */
export function videoUsageFacts(input: {
    attemptId: string;
    evidenceId: string;
    observation: VideoObservation;
    originalObservation?: VideoObservation;
    originalEvidenceId?: string;
    manualReviewId?: string;
    contract: VideoContract;
    bound: VideoBound;
    version: OfficialPriceVersion;
}): VideoUsageFact[] {
    if (
        !input.attemptId ||
        !input.evidenceId ||
        (input.originalObservation && (!input.originalEvidenceId || input.originalEvidenceId === input.evidenceId)) ||
        input.contract.protocol !== input.observation.protocol ||
        input.bound.protocol !== input.observation.protocol
    )
        throw new PricingInputError("视频计量事实缺少原尝试、证据或匹配契约");
    const base = (meter: string, unit: VideoUsageFact["unit"]) => ({
        schemaVersion: 1 as const,
        factId: id(input.attemptId, input.evidenceId, meter),
        meter,
        unit,
        scope: { kind: "attempt" as const, scopeId: input.attemptId },
        evidenceId: input.evidenceId,
    });
    const synthetic = (meter: string, unit: VideoUsageFact["unit"], value: string, sourcePaths: string[], formula: string, inputFactIds: string[] = []): VideoUsageFact => ({
        ...base(meter, unit),
        value,
        sourcePaths,
        sourceKind: "approved-derivation",
        status: "derived",
        formula,
        ...(inputFactIds.length ? { relation: { kind: "derived-from" as const, inputFactIds } } : {}),
    });
    if (input.observation.protocol === "minimax-hailuo-v1") {
        if (input.bound.protocol !== "minimax-hailuo-v1" || input.contract.protocol !== "minimax-hailuo-v1") throw new PricingInputError("Hailuo 事实与冻结档位不匹配");
        const contract = input.contract;
        const bound = input.bound;
        const observation = input.observation;
        const original = input.originalObservation?.protocol === "minimax-hailuo-v1" ? input.originalObservation : undefined;
        const unchanged = Boolean(
            original &&
            original.upstreamTaskId === observation.upstreamTaskId &&
            original.status === observation.status &&
            original.fileId === observation.fileId &&
            original.width === observation.width &&
            original.height === observation.height &&
            original.businessStatusCode === observation.businessStatusCode,
        );
        const reviewed = Boolean(input.manualReviewId && !unchanged);
        const complete = !observation.invalid.length && !observation.missing.length && observation.status === "Success" && Boolean(observation.fileId) && observation.businessStatusCode === 0 && Boolean(observation.width && observation.height);
        return input.version.items.map((item) => {
            const value = contract.tierItems[bound.tier] === item.key ? "1" : "0";
            const fact = synthetic(
                `item:${item.key}`,
                "video",
                value,
                reviewed ? [`review:${input.manualReviewId}`, "bound.tier"] : ["task_id", "status", "file_id", "video_width", "video_height", "base_resp.status_code", "bound.tier"],
                value === "1" ? "count one confirmed original file in the frozen tier" : "other frozen tiers receive zero videos",
            );
            return {
                ...fact,
                ...(complete ? {} : { value: undefined }),
                sourceKind: reviewed ? "manual-review" : fact.sourceKind,
                status: complete ? (reviewed ? "reviewed" : "derived") : "invalid",
                ...(unchanged ? { sourceEvidenceId: input.originalEvidenceId } : {}),
            };
        });
    }
    if (input.bound.protocol !== "minimax-video-v2" || input.contract.protocol !== "minimax-video-v2") throw new PricingInputError("H3 事实与冻结分辨率不匹配");
    const contract = input.contract;
    const bound = input.bound;
    const observation = input.observation;
    const original = input.originalObservation?.protocol === "minimax-video-v2" ? input.originalObservation : undefined;
    const raw = ["inputSeconds", "outputSeconds", "inputImageCount", "inputAudioSeconds", "totalSeconds"].map((meter): VideoUsageFact => {
        const value = observation.quantities[meter];
        const unchanged = Boolean(original && original.quantities[meter] === value && original.meterSources?.[meter]?.paths.length);
        const source = unchanged ? original!.meterSources?.[meter] : observation.meterSources?.[meter];
        const reviewed = Boolean(input.manualReviewId && !unchanged);
        const valid = !observation.invalid.length && numeric(value) && (reviewed || Boolean(source?.paths.length));
        return {
            ...base(meter, meter === "inputImageCount" ? "image" : "second"),
            ...(valid ? { value: new Decimal(value!).toFixed() } : {}),
            sourcePaths: reviewed ? [`review:${input.manualReviewId}`] : [...(source?.paths || [])],
            ...(reviewed ? { sourceKind: "manual-review" as const } : source?.kind ? { sourceKind: source.kind } : {}),
            status: value === undefined ? "missing" : valid ? (reviewed ? "reviewed" : "reported") : "invalid",
            ...(unchanged ? { sourceEvidenceId: input.originalEvidenceId } : {}),
        };
    });
    const selected = contract.resolutionItems[bound.resolution];
    if (!selected) throw new PricingInputError("视频原分辨率没有已审核价目");
    const zeroRows = input.version.items.filter((item) => ![selected.inputSeconds, selected.outputSeconds, contract.inputImageItem].includes(item.key));
    return [
        ...raw,
        ...zeroRows.map((item) =>
            synthetic(
                `item:${item.key}`,
                item.unit === "image" ? "image" : "second",
                "0",
                item.key === contract.inputAudioItem ? ["contract.inputAudioItem", "task.usage.input_audio_seconds"] : ["bound.resolution", `contract.resolutionItems.${bound.resolution}`],
                item.key === contract.inputAudioItem ? "standing-free input audio is retained as a reported fact but not billed" : "unselected resolution price row",
                item.key === contract.inputAudioItem ? [id(input.attemptId, input.evidenceId, "inputAudioSeconds")] : [],
            ),
        ),
    ];
}

/** Every official row consumes one fact; unselected and standing-free rows consume explicit zero facts. */
export function quoteVideoFacts(input: { version: OfficialPriceVersion; policy: SalesVersion; modelId: string; contract: VideoContract; bound: VideoBound; facts: VideoUsageFact[] }) {
    const first = input.facts[0];
    if (!first?.scope.scopeId || !first.evidenceId || !input.contract.id || input.contract.protocol !== input.bound.protocol) throw new PricingInputError("视频结算缺少原尝试、观察或契约身份");
    const byMeter = new Map<string, VideoUsageFact>();
    for (const fact of input.facts) {
        if (
            fact.schemaVersion !== 1 ||
            byMeter.has(fact.meter) ||
            fact.scope.kind !== "attempt" ||
            fact.scope.scopeId !== first.scope.scopeId ||
            fact.evidenceId !== first.evidenceId ||
            fact.factId !== id(first.scope.scopeId, first.evidenceId, fact.meter)
        )
            throw new PricingInputError("视频计量事实跨尝试、证据或字段重复");
        byMeter.set(fact.meter, fact);
    }
    const requireFact = (meter: string, unit: VideoUsageFact["unit"]) => {
        const fact = byMeter.get(meter);
        if (
            !fact ||
            fact.unit !== unit ||
            !fact.sourcePaths.length ||
            !((fact.status === "reported" && fact.sourceKind === "upstream-response") || (fact.status === "reviewed" && fact.sourceKind === "manual-review") || (fact.status === "derived" && fact.sourceKind === "approved-derivation")) ||
            !numeric(fact.value)
        )
            throw new PricingInputError(`缺少 ${meter} 的可结算视频计量事实`);
        return fact;
    };
    const meterByItem = new Map<string, string>();
    if (input.contract.protocol === "minimax-hailuo-v1") {
        if (input.bound.protocol !== "minimax-hailuo-v1") throw new PricingInputError("Hailuo 冻结档位不匹配");
        for (const item of input.version.items) meterByItem.set(item.key, `item:${item.key}`);
        for (const item of input.version.items) if (requireFact(`item:${item.key}`, "video").value !== (input.contract.tierItems[input.bound.tier] === item.key ? "1" : "0")) throw new PricingInputError("Hailuo 事实与冻结档位不一致");
    } else {
        if (input.bound.protocol !== "minimax-video-v2") throw new PricingInputError("H3 冻结分辨率不匹配");
        const selected = input.contract.resolutionItems[input.bound.resolution];
        if (!selected) throw new PricingInputError("H3 原分辨率没有已审核价目");
        requireFact("inputAudioSeconds", "second");
        meterByItem.set(selected.inputSeconds, "inputSeconds");
        meterByItem.set(selected.outputSeconds, "outputSeconds");
        meterByItem.set(input.contract.inputImageItem, "inputImageCount");
        for (const item of input.version.items) {
            if (meterByItem.has(item.key)) continue;
            const fact = requireFact(`item:${item.key}`, item.unit === "image" ? "image" : "second");
            if (fact.value !== "0" || fact.status !== "derived" || fact.sourceKind !== "approved-derivation") throw new PricingInputError("未选视频档位或免费音频分项必须为契约零量");
            if (item.key === input.contract.inputAudioItem && !fact.relation?.inputFactIds.includes(requireFact("inputAudioSeconds", "second").factId)) throw new PricingInputError("免费视频输入缺少原响应事实关联");
            meterByItem.set(item.key, `item:${item.key}`);
        }
    }
    if (meterByItem.size !== input.version.items.length) throw new PricingInputError("视频计量事实与官方分项映射不完整");
    const usage: Record<string, string> = {};
    for (const item of input.version.items) {
        const meter = meterByItem.get(item.key);
        if (!meter) throw new PricingInputError(`视频分项 ${item.key} 缺少计量事实`);
        usage[item.key] = new Decimal(requireFact(meter, item.unit === "image" ? "image" : item.unit === "video" ? "video" : "second").value!).toFixed();
    }
    const quoted = quoteSalesPrice({ version: input.version, policy: input.policy, usage, modelId: input.modelId });
    return {
        usage,
        quote: {
            ...quoted,
            purpose: "settlement" as const,
            schemaVersion: 1 as const,
            algorithmRevision: "video-fact-quote-v1" as const,
            salesVersionId: input.policy.id,
            contractId: input.contract.id,
            attemptId: first.scope.scopeId,
            evidenceId: first.evidenceId,
            lines: quoted.lines.map((line) => ({
                ...line,
                consumedFactIds: [requireFact(meterByItem.get(line.key)!, line.unit === "image" ? "image" : line.unit === "video" ? "video" : "second").factId],
                exactOfficialAmount: new Fraction(line.quantity).div(line.per).mul(line.price).toFraction(),
            })),
        },
    };
}
