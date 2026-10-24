import { PricingConflictError } from "@/lib/model-pricing";
import { isDeepStrictEqual } from "node:util";
import type { TokenUsageObservation } from "./model-pricing-token-usage";

import type { HailuoObservation } from "./model-pricing-hailuo-contract";
import type { VideoUsageObservation } from "./model-pricing-video-usage";
import type { AudioUsageObservation } from "./model-pricing-audio-usage";
import type { ImageUsageObservation } from "./model-pricing-image-usage";

export type PricingSubmissionReview<T extends TokenUsageObservation | ImageUsageObservation | VideoUsageObservation | HailuoObservation | AudioUsageObservation = TokenUsageObservation> = {
    id: string;
    claimId: string;
    reviewedBy: string;
    reviewedAt: string;
    evidence: string;
    outcome: { kind: "not_charged" } | { kind: "response"; observation: T; correctedObservation?: T };
};

/** A reviewed supplement fills missing meters; it cannot rewrite already observed facts. */
export function assertPricingObservationSupplement(original: TokenUsageObservation | undefined, next: TokenUsageObservation, correctedObservation?: TokenUsageObservation) {
    if (correctedObservation) {
        if (!original?.invalid || next.invalid || !isDeepStrictEqual(original, correctedObservation) || original.protocol !== next.protocol || (["reportedModel", "serviceTier", "inferenceGeo"] as const).some((key) => original[key] !== next[key])) {
            throw new PricingConflictError("更正必须对应已保存的矛盾用量，且不能改变原协议、型号或计费范围");
        }
        return;
    }
    if (!original) return;
    if (
        original.invalid ||
        original.protocol !== next.protocol ||
        Object.entries(original.quantities).some(([key, value]) => next.quantities[key] !== value) ||
        (["reportedModel", "serviceTier", "inferenceGeo"] as const).some((key) => original[key] !== undefined && original[key] !== next[key])
    ) {
        throw new PricingConflictError("补录用量与原响应已确认的字段冲突，不能覆盖原凭据");
    }
}

/** Corrections retain the exact invalid receipt, image count and billing scope; media identity is checked by the task. */
export function assertImageObservationSupplement(original: ImageUsageObservation | undefined, next: ImageUsageObservation, correctedObservation?: ImageUsageObservation) {
    if (correctedObservation) {
        if (
            !original?.invalid.length ||
            next.invalid.length ||
            !isDeepStrictEqual(original, correctedObservation) ||
            original.protocol !== next.protocol ||
            (["reportedModel", "quality", "size"] as const).some((key) => original[key] !== next[key]) ||
            (original.hasResults && !next.hasResults) ||
            (original.quantities.images !== undefined && original.quantities.images !== next.quantities.images)
        ) {
            throw new PricingConflictError("图片更正必须对应原矛盾凭据，不能改变型号、计费范围或已确认张数");
        }
        return;
    }
    if (!original) return;
    if (
        original.invalid.length ||
        original.protocol !== next.protocol ||
        (original.hasResults && !next.hasResults) ||
        Object.entries(original.quantities).some(([key, value]) => next.quantities[key] !== value) ||
        (["reportedModel", "quality", "size"] as const).some((key) => original[key] !== undefined && original[key] !== next[key])
    ) {
        throw new PricingConflictError("补录图片用量与原响应已确认的字段冲突，不能覆盖原凭据");
    }
}

/** Video reviews preserve the original task and billing scope; corrections require the exact invalid receipt. */
export function assertVideoObservationSupplement(original: VideoUsageObservation | HailuoObservation | undefined, next: VideoUsageObservation | HailuoObservation, correctedObservation?: VideoUsageObservation | HailuoObservation) {
    if (next.protocol === "minimax-hailuo-v1") {
        if ((original && original.protocol !== next.protocol) || (correctedObservation && correctedObservation.protocol !== next.protocol)) throw new PricingConflictError("视频补录协议与原凭据不一致");
        const fields = ["upstreamTaskId", "status", "fileId", "width", "height"] as const;
        if (correctedObservation) {
            if (!original?.invalid.length || next.invalid.length || !isDeepStrictEqual(original, correctedObservation) || fields.some((key) => original[key] !== undefined && original[key] !== next[key]))
                throw new PricingConflictError("Hailuo 更正必须对应原矛盾凭据，不能改变任务、终态或原文件事实");
        } else if (original && (original.invalid.length || fields.some((key) => original[key] !== undefined && original[key] !== next[key]))) throw new PricingConflictError("Hailuo 补录与原响应事实冲突，不能覆盖原文件凭据");
        return;
    }
    if ((original && original.protocol !== next.protocol) || (correctedObservation && correctedObservation.protocol !== next.protocol)) throw new PricingConflictError("视频补录协议与原凭据不一致");
    const identityFields = ["upstreamTaskId", "reportedModel", "status", "resolution", "taskType", "modality"] as const;
    if (correctedObservation) {
        if (
            !original?.invalid.length ||
            next.invalid.length ||
            !isDeepStrictEqual(original, correctedObservation) ||
            original.protocol !== next.protocol ||
            identityFields.some((key) => original[key] !== next[key]) ||
            (original.hasResult && !next.hasResult)
        )
            throw new PricingConflictError("视频更正必须对应原矛盾凭据，不能改变任务、型号、终态或计费范围");
        return;
    }
    if (!original) return;
    if (
        original.invalid.length ||
        original.protocol !== next.protocol ||
        (original.hasResult && !next.hasResult) ||
        identityFields.some((key) => original[key] !== undefined && original[key] !== next[key]) ||
        Object.entries(original.quantities).some(([key, value]) => next.quantities[key] !== value)
    )
        throw new PricingConflictError("补录视频用量与原响应事实冲突，不能覆盖原凭据");
}

/** Audio supplements retain all known meters; correction keeps the exact invalid observation and billing scope. */
export function assertAudioObservationSupplement(original: AudioUsageObservation | undefined, next: AudioUsageObservation, correctedObservation?: AudioUsageObservation) {
    if (correctedObservation) {
        if (
            !original?.invalid.length ||
            next.invalid.length ||
            !isDeepStrictEqual(original, correctedObservation) ||
            original.protocol !== next.protocol ||
            (["reportedModel", "serviceTier", "hasAudio"] as const).some((key) => original[key] !== next[key])
        )
            throw new PricingConflictError("音频更正必须对应原矛盾凭据，不能改变协议、型号、档位或音频结果");
        return;
    }
    if (!original) return;
    if (
        original.invalid.length ||
        original.protocol !== next.protocol ||
        (original.hasAudio && !next.hasAudio) ||
        (["reportedModel", "serviceTier"] as const).some((key) => original[key] !== undefined && original[key] !== next[key]) ||
        Object.entries(original.quantities).some(([key, value]) => next.quantities[key] !== value)
    )
        throw new PricingConflictError("音频补录与原响应已确认的字段冲突，不能覆盖原凭据");
}
