import { PricingInputError } from "@/lib/model-pricing";

export const GEMINI_TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"] as const;
export type GeminiTtsModel = (typeof GEMINI_TTS_MODELS)[number];
export type AudioRequestBound = {
    protocol: "gemini-tts";
    requestedModel: GeminiTtsModel;
    candidateCount: number;
    maxOutputTokens: number;
    maximumQuantities: { inputTextTokens: string; outputAudioTokens: string };
    sourceUrl: string;
};
// Each exact model's official model page publishes these limits and text-in/audio-out scope.
const INPUT_LIMIT = 8192;
const OUTPUT_LIMIT = 16384;
const sourceUrl = (model: GeminiTtsModel) => `https://ai.google.dev/gemini-api/docs/models/${model}`;
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const isGeminiTtsModel = (model: string): model is GeminiTtsModel => (GEMINI_TTS_MODELS as readonly string[]).includes(model);

/** Inspect the actual synchronous Developer API request; never rewrite generation settings. */
export function inspectGeminiTtsRequestBound(payload: unknown, requestedModel: string, declaredProtocol: string): AudioRequestBound {
    if (!isGeminiTtsModel(requestedModel) || !["gemini", "dataeyes-gemini"].includes(declaredProtocol)) throw new PricingInputError("音频上界仅支持已核实的 Gemini TTS 型号与协议");
    const body = object(payload);
    if (Object.keys(body).some((key) => !["contents", "generationConfig", "systemInstruction", "safetySettings", "serviceTier"].includes(key))) throw new PricingInputError("音频请求包含未核实的缓存、工具或扩展能力");
    if (body.serviceTier !== undefined && body.serviceTier !== "standard" && body.serviceTier !== "unspecified") throw new PricingInputError("音频请求不是标准服务档位");
    const textOnly = (value: unknown) => {
        const content = object(value);
        return (
            Object.keys(content).every((key) => ["role", "parts"].includes(key)) &&
            Array.isArray(content.parts) &&
            content.parts.length > 0 &&
            content.parts.every((part) => {
                const item = object(part);
                return Object.keys(item).length === 1 && typeof item.text === "string" && item.text.length > 0;
            })
        );
    };
    if (!Array.isArray(body.contents) || !body.contents.length || !body.contents.every(textOnly) || (body.systemInstruction !== undefined && !textOnly(body.systemInstruction))) throw new PricingInputError("音频计费仅支持完整的纯文本输入");
    const config = object(body.generationConfig);
    if (
        Object.keys(config).some((key) => !["responseModalities", "speechConfig", "candidateCount", "maxOutputTokens", "temperature", "topP", "topK", "seed", "stopSequences"].includes(key)) ||
        !Array.isArray(config.responseModalities) ||
        config.responseModalities.length !== 1 ||
        config.responseModalities[0] !== "AUDIO"
    )
        throw new PricingInputError("音频计费仅支持已核实的音频输出配置");
    // generateContent documents one candidate by default and maxOutputTokens per candidate.
    const candidateCount = config.candidateCount === undefined ? 1 : config.candidateCount;
    const maxOutputTokens = config.maxOutputTokens === undefined ? OUTPUT_LIMIT : config.maxOutputTokens;
    if (!positiveInteger(candidateCount) || !positiveInteger(maxOutputTokens) || maxOutputTokens > OUTPUT_LIMIT) throw new PricingInputError("音频输出数量或 Token 上限无效");
    return {
        protocol: "gemini-tts",
        requestedModel,
        candidateCount,
        maxOutputTokens,
        maximumQuantities: { inputTextTokens: String(INPUT_LIMIT), outputAudioTokens: String(BigInt(candidateCount) * BigInt(maxOutputTokens)) },
        sourceUrl: sourceUrl(requestedModel),
    };
}

export function validateAudioRequestBound(bound: AudioRequestBound) {
    if (
        !bound ||
        bound.protocol !== "gemini-tts" ||
        !isGeminiTtsModel(bound.requestedModel) ||
        bound.sourceUrl !== sourceUrl(bound.requestedModel) ||
        !positiveInteger(bound.candidateCount) ||
        !positiveInteger(bound.maxOutputTokens) ||
        bound.maxOutputTokens > OUTPUT_LIMIT ||
        bound.maximumQuantities?.inputTextTokens !== String(INPUT_LIMIT) ||
        bound.maximumQuantities?.outputAudioTokens !== String(BigInt(bound.candidateCount) * BigInt(bound.maxOutputTokens)) ||
        Object.keys(bound.maximumQuantities).sort().join() !== "inputTextTokens,outputAudioTokens"
    )
        throw new PricingInputError("音频请求上界与公开型号契约不一致");
}
