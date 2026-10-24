import { PricingInputError } from "@/lib/model-pricing";

export const OPENAI_PRICED_AUDIO_MODEL = "gpt-audio-1.5";
export const OPENAI_AUDIO_LIMIT_SOURCE = "https://developers.openai.com/api/docs/models/gpt-audio-1.5";
// Exact model page: 128,000 context tokens and 16,384 output tokens. Never rewrite the request.
const CONTEXT_TOKENS = 128000;
const OUTPUT_TOKENS = 16384;
// Chat Completions create reference publishes n in [1, 128].
const MAX_CANDIDATES = 128;
export type OpenAiAudioRequestBound = {
    protocol: "openai-chat-audio";
    requestedModel: typeof OPENAI_PRICED_AUDIO_MODEL;
    candidateCount: number;
    maxOutputTokens: number;
    maximumQuantities: { inputTextTokens: string; inputAudioTokens: "0"; outputTextTokens: string; outputAudioTokens: string };
    sourceUrl: typeof OPENAI_AUDIO_LIMIT_SOURCE;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const quantities = (count: number, maximum: number): OpenAiAudioRequestBound["maximumQuantities"] => ({
    inputTextTokens: String(CONTEXT_TOKENS),
    inputAudioTokens: "0",
    outputTextTokens: String(BigInt(count) * BigInt(maximum)),
    outputAudioTokens: String(BigInt(count) * BigInt(maximum)),
});

/** Current speech workflow: synchronous text input, text/audio output, no tools or cached audio references. */
export function inspectOpenAiAudioRequestBound(payload: unknown, requestedModel: string, declaredProtocol: string): OpenAiAudioRequestBound {
    const body = object(payload);
    if (requestedModel !== OPENAI_PRICED_AUDIO_MODEL || body.model !== requestedModel || declaredProtocol !== "openai") throw new PricingInputError("音频上界只接受独立核实的 gpt-audio-1.5 原生 Chat Completions 请求，不能替换旧型号价格");
    if (
        Object.keys(body).some(
            (key) =>
                ![
                    "model",
                    "messages",
                    "modalities",
                    "audio",
                    "stream",
                    "n",
                    "max_tokens",
                    "max_completion_tokens",
                    "service_tier",
                    "temperature",
                    "top_p",
                    "frequency_penalty",
                    "presence_penalty",
                    "seed",
                    "stop",
                    "user",
                    "metadata",
                    "store",
                    "safety_identifier",
                ].includes(key),
        )
    )
        throw new PricingInputError("音频请求包含未核实的工具、缓存或扩展参数");
    if ((body.stream !== undefined && body.stream !== false) || (body.service_tier !== undefined && body.service_tier !== "default")) throw new PricingInputError("音频计价仅接受同步标准服务档位");
    if (!Array.isArray(body.modalities) || body.modalities.length !== 2 || [...body.modalities].sort().join() !== "audio,text") throw new PricingInputError("音频请求必须明确文本与音频两种输出");
    const audio = object(body.audio);
    if (Object.keys(audio).some((key) => !["voice", "format"].includes(key)) || typeof audio.voice !== "string" || !audio.voice.trim() || !["wav", "mp3", "flac", "opus", "aac", "pcm16"].includes(String(audio.format)))
        throw new PricingInputError("音频输出配置不完整或不受支持");
    const text = (value: unknown) =>
        typeof value === "string"
            ? value.length > 0
            : Array.isArray(value) &&
              value.length > 0 &&
              value.every((part) => {
                  const item = object(part);
                  return Object.keys(item).length === 2 && item.type === "text" && typeof item.text === "string" && item.text.length > 0;
              });
    if (
        !Array.isArray(body.messages) ||
        !body.messages.length ||
        !body.messages.every((message) => {
            const item = object(message);
            return Object.keys(item).every((key) => ["role", "content", "name"].includes(key)) && ["system", "developer", "user", "assistant"].includes(String(item.role)) && text(item.content);
        })
    )
        throw new PricingInputError("当前音频计价只支持完整的纯文本输入，不接受音频历史或工具消息");
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw new PricingInputError("音频输出 Token 上限不能同时使用两个参数");
    const candidateCount = body.n === undefined ? 1 : body.n;
    const maxOutputTokens = body.max_completion_tokens !== undefined ? body.max_completion_tokens : body.max_tokens !== undefined ? body.max_tokens : OUTPUT_TOKENS;
    if (!positiveInteger(candidateCount) || candidateCount > MAX_CANDIDATES || !positiveInteger(maxOutputTokens) || maxOutputTokens > OUTPUT_TOKENS) throw new PricingInputError("音频输出数量或 Token 上限无效");
    return { protocol: "openai-chat-audio", requestedModel, candidateCount, maxOutputTokens, maximumQuantities: quantities(candidateCount, maxOutputTokens), sourceUrl: OPENAI_AUDIO_LIMIT_SOURCE };
}

export function validateOpenAiAudioRequestBound(bound: OpenAiAudioRequestBound) {
    if (
        !bound ||
        bound.protocol !== "openai-chat-audio" ||
        bound.requestedModel !== OPENAI_PRICED_AUDIO_MODEL ||
        bound.sourceUrl !== OPENAI_AUDIO_LIMIT_SOURCE ||
        !positiveInteger(bound.candidateCount) ||
        bound.candidateCount > MAX_CANDIDATES ||
        !positiveInteger(bound.maxOutputTokens) ||
        bound.maxOutputTokens > OUTPUT_TOKENS
    )
        throw new PricingInputError("音频请求上界与精确公开型号不一致");
    const expected = quantities(bound.candidateCount, bound.maxOutputTokens);
    if (!bound.maximumQuantities || Object.keys(bound.maximumQuantities).sort().join() !== Object.keys(expected).sort().join() || Object.entries(expected).some(([key, value]) => bound.maximumQuantities[key as keyof typeof expected] !== value))
        throw new PricingInputError("音频分项上界与原输出配置不一致");
}
