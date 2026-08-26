import type { ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { toSystemGenerationChannel } from "@/lib/server/generation-channel";
import { configuredVideoDurationPolicy, resolveUpstreamVideoDuration } from "@/lib/server/video-task-config";

export type DramaShotDurationPolicy = {
    defaultSeconds: number;
    durationSeconds?: number[];
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
};

export function resolveDramaShotDuration(value: unknown, defaultSeconds: number) {
    const requested = Number(value);
    const seconds = Number.isFinite(requested) && requested > 0 ? requested : defaultSeconds;
    return Math.max(1, Math.round(seconds));
}

export function resolveDramaVideoDurationPolicy(candidates: ResolvedLogicalModel[], defaultSeconds: number, configuredSeconds: Record<string, unknown> = {}): DramaShotDurationPolicy {
    const candidate = candidates[0];
    const channel = candidate ? toSystemGenerationChannel(candidate) : undefined;
    const provider = configuredVideoDurationPolicy(
        candidate
            ? {
                  durationRange: channel?.advancedConfig?.durationRange,
                  minDurationSeconds: candidate.capabilityProfile?.minDurationSeconds,
                  maxDurationSeconds: candidate.capabilityProfile?.maxDurationSeconds,
              }
            : {},
    );
    const modelDurationSeconds = normalizedDurationSeconds(candidate?.capabilityProfile?.durationSeconds);
    const backendDurationSeconds = filterDurationRange(configuredDurationSeconds(configuredSeconds), provider);
    const durationSeconds = modelDurationSeconds.length ? modelDurationSeconds : backendDurationSeconds.length ? backendDurationSeconds : provider.durationSeconds || [];
    const policy = {
        ...(durationSeconds.length ? { durationSeconds } : {}),
        ...(provider.minDurationSeconds ? { minDurationSeconds: provider.minDurationSeconds } : {}),
        ...(provider.maxDurationSeconds ? { maxDurationSeconds: provider.maxDurationSeconds } : {}),
    };
    return {
        defaultSeconds: durationSeconds.length ? nearestDuration(resolveDramaShotDuration(defaultSeconds, 5), durationSeconds) : resolveUpstreamVideoDuration(defaultSeconds, defaultSeconds, policy),
        ...policy,
    };
}

export function dramaShotDurationInstruction(policy: DramaShotDurationPolicy) {
    if (policy.durationSeconds?.length) {
        return `当前视频模型每条仅支持 ${policy.durationSeconds.join("、")} 秒。每个镜头 duration 必须取这些值之一；任何超过最长时长的连续原文、对白、旁白或动作必须按语义顺序拆成多个镜头，不能删句、合并台词或只把时长数字截短。`;
    }
    if (policy.maxDurationSeconds) {
        const range = policy.minDurationSeconds ? `${policy.minDurationSeconds}-${policy.maxDurationSeconds}` : `不超过 ${policy.maxDurationSeconds}`;
        return `当前视频模型每条时长为 ${range} 秒。任何超过最长时长的连续原文、对白、旁白或动作必须按语义顺序拆成多个镜头，不能删句、合并台词或只把时长数字截短。`;
    }
    return "";
}

export function resolveDramaShotDurations(value: unknown, policy: number | DramaShotDurationPolicy) {
    const normalized = typeof policy === "number" ? { defaultSeconds: policy } : policy;
    const requested = resolveDramaShotDuration(value, normalized.defaultSeconds);
    const options = Array.from(new Set((normalized.durationSeconds || []).map((item) => resolveDramaShotDuration(item, 0)).filter((item) => item > 0))).sort((left, right) => left - right);
    if (options.length) return discreteDurationSlices(requested, options);

    const min = normalized.minDurationSeconds ? resolveDramaShotDuration(normalized.minDurationSeconds, 1) : 1;
    const max = normalized.maxDurationSeconds ? Math.max(min, resolveDramaShotDuration(normalized.maxDurationSeconds, min)) : undefined;
    if (!max || requested <= max) return [Math.max(min, max ? Math.min(max, requested) : requested)];
    const count = Math.ceil(requested / max);
    const base = Math.floor(requested / count);
    const remainder = requested % count;
    return Array.from({ length: count }, (_, index) => Math.max(min, Math.min(max, base + (index < remainder ? 1 : 0))));
}

function discreteDurationSlices(requested: number, options: number[]) {
    const max = options.at(-1)!;
    if (requested <= max) return [nearestDuration(requested, options)];
    const fullLengthShots = Math.floor(requested / max);
    const remainder = requested % max;
    return [...Array.from({ length: fullLengthShots }, () => max), ...(remainder ? [nearestDuration(remainder, options)] : [])];
}

function configuredDurationSeconds(value: Record<string, unknown>) {
    return Array.from(
        new Set(
            Object.keys(value)
                .map(Number)
                .filter((seconds) => Number.isFinite(seconds) && Number.isInteger(seconds) && seconds > 0),
        ),
    ).sort((left, right) => left - right);
}

function normalizedDurationSeconds(value: unknown) {
    return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => resolveDramaShotDuration(item, 0)).filter((item) => item > 0))).sort((left, right) => left - right);
}

function filterDurationRange(options: number[], policy: Pick<DramaShotDurationPolicy, "minDurationSeconds" | "maxDurationSeconds">) {
    return options.filter((seconds) => (!policy.minDurationSeconds || seconds >= policy.minDurationSeconds) && (!policy.maxDurationSeconds || seconds <= policy.maxDurationSeconds));
}

function nearestDuration(requested: number, options: number[]) {
    return options.reduce((nearest, seconds) => {
        const distance = Math.abs(seconds - requested);
        const nearestDistance = Math.abs(nearest - requested);
        return distance < nearestDistance || (distance === nearestDistance && seconds > nearest) ? seconds : nearest;
    });
}
