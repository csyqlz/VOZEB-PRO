import type { LogicalModelPricing } from "@/lib/auth/store";
import { resolveLogicalModelPricing, textTokenSalePrice } from "@/lib/model-pricing";

export type TokenUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
};

export function resolveTextPricing(
    logicalModels: Array<{ id: string; bindings: Array<{ channelId?: string; upstreamModel: string; enabled?: boolean; priority?: number; capabilityProfile?: { pricing?: LogicalModelPricing } }> }> | undefined,
    model: string,
    channelId = "",
) {
    return textTokenSalePrice(resolveLogicalModelPricing(logicalModels, model, channelId));
}

export function estimateTextCharge(input: {
    logicalModels?: Array<{ id: string; bindings: Array<{ channelId?: string; upstreamModel: string; enabled?: boolean; priority?: number; capabilityProfile?: { pricing?: LogicalModelPricing } }> }>;
    model: string;
    channelId?: string;
    body: unknown;
}) {
    const pricing = resolveTextPricing(input.logicalModels, input.model, input.channelId);
    if (!pricing) return undefined;
    const payload = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {};
    const inputTokens = Math.max(1, Math.ceil(estimateInputCharacters(payload) / 4));
    const outputTokens = Math.max(256, readMaxTokens(payload));
    return priceTokens(pricing, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

export function extractTokenUsage(payload: unknown): TokenUsage | undefined {
    const candidates: unknown[] = [payload];
    if (typeof payload === "string") {
        for (const line of payload.split(/\r?\n/)) {
            const data = line.trim().replace(/^data:\s*/, "");
            if (!data || data === "[DONE]") continue;
            try {
                candidates.push(JSON.parse(data));
            } catch {
                continue;
            }
        }
    }
    for (const candidate of candidates) {
        const usage = findUsage(candidate);
        if (usage) return usage;
    }
    return undefined;
}

export function chargeFromUsage(pricing: ReturnType<typeof textTokenSalePrice>, usage: TokenUsage) {
    if (!pricing) return undefined;
    return priceTokens(pricing, usage);
}

function findUsage(value: unknown): TokenUsage | undefined {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["usage", "usageMetadata", "usage_metadata", "tokenUsage", "token_usage"]) {
        const usage = normalizeUsage(record[key]);
        if (usage) return usage;
    }
    for (const child of Object.values(record)) {
        if (child && typeof child === "object") {
            const usage = findUsage(child);
            if (usage) return usage;
        }
    }
    return undefined;
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const inputTokens = readNumber(record.prompt_tokens, record.promptTokens, record.input_tokens, record.inputTokens, record.promptTokenCount, record.inputTokenCount);
    const outputTokens = readNumber(record.completion_tokens, record.completionTokens, record.output_tokens, record.outputTokens, record.candidatesTokenCount, record.outputTokenCount);
    const promptDetails = record.prompt_tokens_details || record.promptTokensDetails;
    const cacheReadTokens = readNumber(record.cache_read_input_tokens, record.cacheReadInputTokens, record.cachedContentTokenCount, nestedNumber(promptDetails, "cached_tokens", "cachedTokens"));
    const cacheWriteTokens = readNumber(record.cache_creation_input_tokens, record.cacheWriteInputTokens, nestedNumber(record.cache_creation_input_tokens_details, "token_count", "tokenCount"));
    if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) return undefined;
    return { inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, cacheReadTokens: cacheReadTokens || 0, cacheWriteTokens: cacheWriteTokens || 0 };
}

function priceTokens(pricing: { input: number; output: number; cacheRead: number; cacheWrite: number }, usage: TokenUsage) {
    const regularInputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
    const amount = (regularInputTokens / 1_000_000) * pricing.input + (usage.outputTokens / 1_000_000) * pricing.output + (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead + (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
    return Number(Math.max(0, amount).toFixed(8));
}

function estimateInputCharacters(payload: Record<string, unknown>) {
    const messages = payload.messages || payload.input || payload.contents || payload.prompt || "";
    return JSON.stringify(messages).length + JSON.stringify(payload.system || payload.system_instruction || "").length;
}

function readMaxTokens(payload: Record<string, unknown>) {
    for (const key of ["max_tokens", "max_completion_tokens", "maxOutputTokens"]) {
        const value = Number(payload[key]);
        if (Number.isFinite(value) && value > 0) return Math.min(100_000, Math.floor(value));
    }
    return 4096;
}

function readNumber(...values: unknown[]) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return Math.floor(number);
    }
    return undefined;
}

function nestedNumber(value: unknown, ...keys: string[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return readNumber(...keys.map((key) => record[key]));
}
