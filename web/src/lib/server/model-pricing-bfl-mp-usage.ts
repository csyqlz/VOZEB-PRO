type Dimensions = { width: number; height: number };
const PIXELS_PER_MP = BigInt(1024 * 1024);
const ONE = BigInt(1);
const FOUR = BigInt(4);
const ZERO = BigInt(0);

function megapixels(value: Dimensions) {
    if (![value.width, value.height].every((part) => Number.isSafeInteger(part) && part > 0)) return null;
    return (BigInt(value.width) * BigInt(value.height) + PIXELS_PER_MP - ONE) / PIXELS_PER_MP;
}

/** BFL FLUX.2 MP units only; callers must independently verify the upstream-processed inputs and outputs. */
export function inspectBflFlux2MpUsage(input: { outputs: Array<Dimensions | null>; referenceImages: Array<Dimensions | null> | undefined }) {
    if (!input.outputs.length || !input.referenceImages) return { ready: false as const, reason: "缺少完整输出或参考图事实" };
    const outputMp = input.outputs.map((value) => value && megapixels(value));
    const referenceMp = input.referenceImages.map((value) => value && megapixels(value));
    if (outputMp.some((value) => value === null || value > FOUR) || referenceMp.some((value) => value === null)) return { ready: false as const, reason: "图片尺寸无效或输出超出 BFL 4 MP 范围" };
    const outputs = outputMp as bigint[];
    const references = referenceMp as bigint[];
    const referenceUnits = references.length > 1 ? BigInt(references.length) : references.reduce((sum, value) => sum + (value > FOUR ? FOUR : value), ZERO);
    return {
        ready: true as const,
        quantities: {
            "first-output-mp": String(outputs.length),
            "additional-output-mp": String(outputs.reduce((sum, value) => sum + value - ONE, ZERO)),
            "reference-mp": String(referenceUnits * BigInt(outputs.length)),
        },
    };
}

/** Published DataEyes FLUX.2 limits (https://doczh.dataeyes.ai/doc-9128290); real-channel proof is still required before wallet admission. */
export function inspectDataeyesBflFlux2MpUpperBound(referenceCount: number) {
    if (!Number.isSafeInteger(referenceCount) || referenceCount < 0 || referenceCount > 8) return { ready: false as const, reason: "参考图数量超出 DataEyes FLUX.2 已公开范围" };
    return {
        ready: true as const,
        quantities: {
            "first-output-mp": "1",
            "additional-output-mp": "3",
            "reference-mp": String(referenceCount === 1 ? 4 : referenceCount),
        },
    };
}
