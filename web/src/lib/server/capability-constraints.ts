import type { LogicalModelCapabilityProfile } from "@/lib/auth/store";

export type CapabilityConstraintInput = {
    capability: "image" | "video" | "audio" | "text";
    referenceCount?: number;
    durationSeconds?: number;
    batchSize?: number;
    aspectRatio?: string;
    resolution?: string;
};

export function assertCapabilityConstraints(profile: LogicalModelCapabilityProfile | undefined, input: CapabilityConstraintInput) {
    if (!profile) return;
    if (input.referenceCount && profile.maxReferenceImages && input.referenceCount > profile.maxReferenceImages) throw new Error(`当前模型最多支持 ${profile.maxReferenceImages} 张参考图`);
    if (input.batchSize && profile.maxBatchSize && input.batchSize > profile.maxBatchSize) throw new Error(`当前模型最多支持批量生成 ${profile.maxBatchSize} 个结果`);
    if (input.durationSeconds && profile.minDurationSeconds && input.durationSeconds < profile.minDurationSeconds) throw new Error(`当前模型最短视频时长为 ${profile.minDurationSeconds} 秒`);
    if (input.durationSeconds && profile.maxDurationSeconds && input.durationSeconds > profile.maxDurationSeconds) throw new Error(`当前模型最长视频时长为 ${profile.maxDurationSeconds} 秒`);
    if (input.durationSeconds && profile.durationSeconds?.length && !profile.durationSeconds.includes(input.durationSeconds)) throw new Error(`当前模型不支持 ${input.durationSeconds} 秒时长`);
    const aspectRatio = normalizedAspectRatio(input.aspectRatio);
    if (aspectRatio && aspectRatio !== "auto" && profile.aspectRatios?.length && !profile.aspectRatios.some((item) => normalizedAspectRatio(item) === aspectRatio)) throw new Error(`当前模型不支持 ${input.aspectRatio} 比例`);
    const resolution = normalizedResolution(input.resolution);
    if (resolution && resolution !== "auto" && profile.resolutions?.length && !profile.resolutions.some((item) => normalizedResolution(item) === resolution)) throw new Error(`当前模型不支持 ${input.resolution} 分辨率`);
}

function normalizedResolution(value: string | undefined) {
    return value?.trim().replace(/p$/i, "").toLowerCase() || "";
}

function normalizedAspectRatio(value: string | undefined) {
    const text = value?.trim().toLowerCase() || "";
    const dimensions = text.match(/^(\d+)x(\d+)$/);
    if (!dimensions) return text;
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b) [a, b] = [b, a % b];
    return a || 1;
}
