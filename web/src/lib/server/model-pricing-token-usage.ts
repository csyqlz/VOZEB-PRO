export type TokenUsageProtocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-generate";
import { inspectUsageFields } from "./model-pricing-usage-fields";
export type TokenUsageObservation = {
    protocol: TokenUsageProtocol;
    reportedModel?: string;
    serviceTier?: string;
    inferenceGeo?: string;
    quantities: Record<string, string>;
    meterSources?: Record<string, { paths: string[]; kind: "upstream-response" | "approved-derivation"; formula?: string; inputMeters?: string[] }>;
    missing: string[];
    invalid?: string;
    usageFields?: Record<string, string>;
    unmappedUsageFields?: string[];
};

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function tokenCount(value: unknown) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const zeroOnlyOpenAiDetailPaths = [
    "prompt_tokens_details.audio_tokens",
    "prompt_tokens_details.text_tokens",
    "prompt_tokens_details.image_tokens",
    "input_tokens_details.audio_tokens",
    "input_tokens_details.text_tokens",
    "input_tokens_details.image_tokens",
    "completion_tokens_details.audio_tokens",
    "completion_tokens_details.text_tokens",
    "completion_tokens_details.image_tokens",
    "output_tokens_details.audio_tokens",
    "output_tokens_details.text_tokens",
    "output_tokens_details.image_tokens",
    "completion_tokens_details.accepted_prediction_tokens",
    "completion_tokens_details.rejected_prediction_tokens",
    "output_tokens_details.accepted_prediction_tokens",
    "output_tokens_details.rejected_prediction_tokens",
];

/** Re-check saved zero-valued detail fields without changing the original observation. */
export function reinterpretOpenAiZeroTokenDetails(observation: TokenUsageObservation): TokenUsageObservation {
    if (observation.protocol !== "openai-chat" && observation.protocol !== "openai-responses") return observation;
    const oldUnknown = observation.unmappedUsageFields?.length ? `未解释的文本用量字段：${observation.unmappedUsageFields.join("、")}` : undefined;
    if (!oldUnknown || observation.invalid !== oldUnknown) return observation;
    const unmappedUsageFields = observation.unmappedUsageFields!.filter((path) => !zeroOnlyOpenAiDetailPaths.includes(path) || observation.usageFields?.[path] !== "0");
    return { ...observation, unmappedUsageFields, invalid: unmappedUsageFields.length ? `未解释的文本用量字段：${unmappedUsageFields.join("、")}` : undefined };
}

export function inspectProviderTokenUsage(protocol: TokenUsageProtocol, response: unknown, responseHeaders?: Headers): TokenUsageObservation {
    const body = record(response);
    const usage = record(protocol === "gemini-generate" ? body.usageMetadata : body.usage);
    const anthropicDetails = protocol === "anthropic-messages" ? inspectAnthropicDetails(usage) : undefined;
    const zeroOnlyOpenAiDetails = zeroOnlyOpenAiDetailPaths.filter((path) => {
        const [group, field] = path.split(".");
        return tokenCount(record(usage[group])[field]) === 0;
    });
    const knownPaths =
        protocol === "anthropic-messages"
            ? ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation.ephemeral_5m_input_tokens", "cache_creation.ephemeral_1h_input_tokens", ...(anthropicDetails?.knownPaths || [])]
            : protocol === "gemini-generate"
              ? ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount", "promptTokensDetails[TEXT].tokenCount", "candidatesTokensDetails[TEXT].tokenCount", "cacheTokensDetails[TEXT].tokenCount"]
              : [
                    "prompt_tokens",
                    "completion_tokens",
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                    "cached_tokens",
                    "reasoning_tokens",
                    "prompt_cache_hit_tokens",
                    "prompt_cache_miss_tokens",
                    "prompt_tokens_details.cached_tokens",
                    "prompt_tokens_details.cache_write_tokens",
                    "prompt_tokens_details.cache_creation_input_tokens",
                    "input_tokens_details.cached_tokens",
                    "input_tokens_details.cache_write_tokens",
                    "input_tokens_details.cache_creation_input_tokens",
                    "completion_tokens_details.reasoning_tokens",
                    "output_tokens_details.reasoning_tokens",
                    ...zeroOnlyOpenAiDetails,
                    ...["engine_tbt_ms", "engine_ttft_ms", "engine_ttlt_ms", "pre_inference_ms", "service_tbt_ms", "service_ttft_ms", "service_ttlt_ms", "user_visible_ttft_ms"].map((field) => `latency_checkpoint.${field}`),
                ];
    const inventory = inspectUsageFields(usage, knownPaths);
    const quantities: Record<string, string> = {};
    const meterSources: NonNullable<TokenUsageObservation["meterSources"]> = {};
    const missing: string[] = [];
    const result: TokenUsageObservation = {
        protocol,
        ...(typeof (protocol === "gemini-generate" ? body.modelVersion : body.model) === "string" ? { reportedModel: String(protocol === "gemini-generate" ? body.modelVersion : body.model) } : {}),
        ...(typeof (protocol === "gemini-generate" ? usage.serviceTier : protocol === "anthropic-messages" ? usage.service_tier : body.service_tier) === "string"
            ? { serviceTier: String(protocol === "gemini-generate" ? usage.serviceTier : protocol === "anthropic-messages" ? usage.service_tier : body.service_tier) }
            : {}),
        ...(typeof usage.inference_geo === "string" ? { inferenceGeo: usage.inference_geo } : {}),
        quantities,
        meterSources,
        missing,
        usageFields: inventory.fields,
        unmappedUsageFields: inventory.unmapped,
    };
    const finish = () => {
        if (inventory.unmapped.length) result.invalid ||= `未解释的文本用量字段：${inventory.unmapped.join("、")}`;
        return result;
    };
    const put = (target: string, value: number | string, paths: string[], formula?: string, inputMeters?: string[]) => {
        const prefix = protocol === "gemini-generate" ? "usageMetadata" : "usage";
        quantities[target] = String(value);
        meterSources[target] = {
            paths: paths.map((path) => (path.startsWith("header:") || path.startsWith("usage.") || path.startsWith("usageMetadata.") ? path : `${prefix}.${path}`)),
            kind: formula ? "approved-derivation" : "upstream-response",
            ...(formula ? { formula, inputMeters } : {}),
        };
    };
    const read = (source: Record<string, unknown>, field: string, target: string, path = field) => {
        const value = tokenCount(source[field]);
        if (value === null) {
            missing.push(field);
            if (source[field] !== undefined) result.invalid ||= `${field} 用量无效`;
        } else put(target, value, [path]);
        return value;
    };
    if (protocol === "anthropic-messages") {
        if (anthropicDetails?.invalid) result.invalid ||= anthropicDetails.invalid;
        read(usage, "input_tokens", "inputTokens");
        read(usage, "output_tokens", "outputTokens");
        read(usage, "cache_read_input_tokens", "cachedInputTokens");
        const writes = read(usage, "cache_creation_input_tokens", "cacheWriteTotalTokens");
        const detail = record(usage.cache_creation);
        if (writes === 0) {
            if ([detail.ephemeral_5m_input_tokens, detail.ephemeral_1h_input_tokens].some((value) => value !== undefined && tokenCount(value) !== 0)) result.invalid ||= "缓存写入分档用量与总量不一致";
            if (detail.ephemeral_5m_input_tokens !== undefined) read(detail, "ephemeral_5m_input_tokens", "cacheWrite5mTokens", "cache_creation.ephemeral_5m_input_tokens");
            else put("cacheWrite5mTokens", 0, ["cache_creation_input_tokens"], "zero total implies zero 5m bucket", ["cacheWriteTotalTokens"]);
            if (detail.ephemeral_1h_input_tokens !== undefined) read(detail, "ephemeral_1h_input_tokens", "cacheWrite1hTokens", "cache_creation.ephemeral_1h_input_tokens");
            else put("cacheWrite1hTokens", 0, ["cache_creation_input_tokens"], "zero total implies zero 1h bucket", ["cacheWriteTotalTokens"]);
        } else if (writes !== null) {
            const five = read(detail, "ephemeral_5m_input_tokens", "cacheWrite5mTokens", "cache_creation.ephemeral_5m_input_tokens");
            const hour = read(detail, "ephemeral_1h_input_tokens", "cacheWrite1hTokens", "cache_creation.ephemeral_1h_input_tokens");
            if (five !== null && hour !== null && (!Number.isSafeInteger(five + hour) || five + hour !== writes)) result.invalid = "缓存写入分档用量与总量不一致";
        } else if (detail.ephemeral_5m_input_tokens !== undefined || detail.ephemeral_1h_input_tokens !== undefined) {
            result.invalid ||= "缓存写入分档存在但总量缺失";
        }
        return finish();
    }
    if (protocol === "gemini-generate") {
        const prompt = read(usage, "promptTokenCount", "inputTotalTokens");
        const cached = read(usage, "cachedContentTokenCount", "cachedInputTokens");
        const candidates = read(usage, "candidatesTokenCount", "candidateOutputTokens");
        const thoughts = read(usage, "thoughtsTokenCount", "thoughtOutputTokens");
        if (prompt !== null && cached !== null) {
            if (cached > prompt) result.invalid = "缓存读取用量超过输入总量";
            else put("inputTokens", prompt - cached, ["promptTokenCount", "cachedContentTokenCount"], "promptTokenCount - cachedContentTokenCount", ["inputTotalTokens", "cachedInputTokens"]);
        }
        if (candidates !== null && thoughts !== null) {
            if (!Number.isSafeInteger(candidates + thoughts)) result.invalid = "输出用量超过安全整数范围";
            else put("outputTokens", candidates + thoughts, ["candidatesTokenCount", "thoughtsTokenCount"], "candidatesTokenCount + thoughtsTokenCount", ["candidateOutputTokens", "thoughtOutputTokens"]);
        }
        return finish();
    }
    const inputField = protocol === "openai-chat" ? "prompt_tokens" : "input_tokens";
    const outputField = protocol === "openai-chat" ? "completion_tokens" : "output_tokens";
    const primaryDetails = record(usage[protocol === "openai-chat" ? "prompt_tokens_details" : "input_tokens_details"]);
    const alternateDetails = record(usage[protocol === "openai-chat" ? "input_tokens_details" : "prompt_tokens_details"]);
    const primaryPath = protocol === "openai-chat" ? "prompt_tokens_details" : "input_tokens_details";
    const alternatePath = protocol === "openai-chat" ? "input_tokens_details" : "prompt_tokens_details";
    const alias = (values: Array<{ path: string; value: unknown }>, target: string, missingName: string) => {
        const reported = values.filter((item) => item.value !== undefined);
        if (!reported.length) {
            missing.push(missingName);
            return null;
        }
        const parsed = reported.map((item) => tokenCount(item.value));
        if (parsed.some((item) => item === null)) {
            missing.push(missingName);
            result.invalid ||= `${target} 用量无效`;
            return null;
        }
        if (new Set(parsed).size !== 1) {
            result.invalid ||= `${target} 同义字段不一致`;
            return null;
        }
        put(
            target,
            parsed[0]!,
            reported.map((item) => item.path),
        );
        return parsed[0];
    };
    const total = alias(
        [
            { path: inputField, value: usage[inputField] },
            { path: inputField === "prompt_tokens" ? "input_tokens" : "prompt_tokens", value: usage[inputField === "prompt_tokens" ? "input_tokens" : "prompt_tokens"] },
        ],
        "inputTotalTokens",
        inputField,
    );
    const output = alias(
        [
            { path: outputField, value: usage[outputField] },
            { path: outputField === "completion_tokens" ? "output_tokens" : "completion_tokens", value: usage[outputField === "completion_tokens" ? "output_tokens" : "completion_tokens"] },
        ],
        "outputTokens",
        outputField,
    );
    const compatibleHit = alias(
        [
            { path: `${primaryPath}.cached_tokens`, value: primaryDetails.cached_tokens },
            { path: `${alternatePath}.cached_tokens`, value: alternateDetails.cached_tokens },
            { path: "cached_tokens", value: usage.cached_tokens },
        ],
        "cachedInputTokens",
        "cached_tokens",
    );
    const nativeHit = protocol === "openai-chat" ? tokenCount(usage.prompt_cache_hit_tokens) : null;
    const nativeMiss = protocol === "openai-chat" ? tokenCount(usage.prompt_cache_miss_tokens) : null;
    const cached = compatibleHit ?? nativeHit;
    if (cached !== null) {
        if (compatibleHit === null) put("cachedInputTokens", cached, ["prompt_cache_hit_tokens"]);
        if (nativeHit !== null && !valuesEqual(compatibleHit, nativeHit)) result.invalid ||= "原生缓存命中量与兼容字段不一致";
        if (nativeHit !== null) {
            if (compatibleHit !== null) meterSources.cachedInputTokens.paths.push("usage.prompt_cache_hit_tokens");
            const missingIndex = missing.indexOf("cached_tokens");
            if (missingIndex >= 0) missing.splice(missingIndex, 1);
        }
    }
    if (nativeMiss !== null) put("cacheMissTokens", nativeMiss, ["prompt_cache_miss_tokens"]);
    const standardWrite = alias(
        [
            { path: `${primaryPath}.cache_write_tokens`, value: primaryDetails.cache_write_tokens },
            { path: `${alternatePath}.cache_write_tokens`, value: alternateDetails.cache_write_tokens },
        ],
        "cacheWriteTokens",
        "cache_write_tokens",
    );
    const creationWrite =
        protocol === "openai-chat" && (primaryDetails.cache_creation_input_tokens !== undefined || alternateDetails.cache_creation_input_tokens !== undefined)
            ? alias(
                  [
                      { path: `${primaryPath}.cache_creation_input_tokens`, value: primaryDetails.cache_creation_input_tokens },
                      { path: `${alternatePath}.cache_creation_input_tokens`, value: alternateDetails.cache_creation_input_tokens },
                  ],
                  "cacheCreationTokens",
                  "cache_creation_input_tokens",
              )
            : null;
    const written = standardWrite ?? creationWrite;
    if (written !== null) {
        put("cacheWriteTokens", written, [...(standardWrite !== null ? meterSources.cacheWriteTokens.paths : []), ...(creationWrite !== null ? meterSources.cacheCreationTokens.paths : [])]);
    }
    if (written !== null) {
        const missingIndex = missing.indexOf("cache_write_tokens");
        if (missingIndex >= 0) missing.splice(missingIndex, 1);
    }
    delete quantities.cacheCreationTokens;
    delete meterSources.cacheCreationTokens;
    if (standardWrite !== null && creationWrite !== null && standardWrite !== creationWrite) result.invalid = "缓存写入用量字段不一致";
    if ((primaryDetails.cache_write_tokens !== undefined || alternateDetails.cache_write_tokens !== undefined) && standardWrite === null) result.invalid ||= "缓存写入用量无效";
    if (protocol === "openai-chat" && (primaryDetails.cache_creation_input_tokens !== undefined || alternateDetails.cache_creation_input_tokens !== undefined) && creationWrite === null) result.invalid ||= "缓存写入用量无效";
    if (protocol === "openai-chat" && body.model === "kimi-k3" && written !== null) {
        const split = (["5m", "1h"] as const).map((ttl) => {
            const field = `Msh-Usage-Cache-Write-Tokens-${ttl}`;
            const raw = responseHeaders?.get(field);
            const count = raw !== null && raw !== undefined && /^\d+$/.test(raw) ? tokenCount(Number(raw)) : null;
            if (raw !== null && raw !== undefined && count === null) result.invalid = "缓存写入分档响应头无效";
            if (written > 0 && raw == null) missing.push(field);
            return count;
        });
        if (written === 0) {
            if (split.some((count) => count !== null && count !== 0)) result.invalid = "缓存写入分档用量与总量不一致";
            if (split[0] !== null) put("cacheWrite5mTokens", split[0], ["header:Msh-Usage-Cache-Write-Tokens-5m"]);
            else put("cacheWrite5mTokens", 0, meterSources.cacheWriteTokens.paths, "zero cache write total implies zero 5m bucket", ["cacheWriteTokens"]);
            if (split[1] !== null) put("cacheWrite1hTokens", split[1], ["header:Msh-Usage-Cache-Write-Tokens-1h"]);
            else put("cacheWrite1hTokens", 0, meterSources.cacheWriteTokens.paths, "zero cache write total implies zero 1h bucket", ["cacheWriteTokens"]);
        } else {
            if (split[0] !== null) put("cacheWrite5mTokens", split[0], ["header:Msh-Usage-Cache-Write-Tokens-5m"]);
            if (split[1] !== null) put("cacheWrite1hTokens", split[1], ["header:Msh-Usage-Cache-Write-Tokens-1h"]);
            if (split[0] !== null && split[1] !== null && (!Number.isSafeInteger(split[0] + split[1]) || split[0] + split[1] !== written)) result.invalid = "缓存写入分档用量与总量不一致";
        }
    }
    if (total !== null && cached !== null) {
        if (cached > total) result.invalid = "缓存读取用量超过输入总量";
        else put("uncachedInputTokens", total - cached, [...meterSources.inputTotalTokens.paths, ...meterSources.cachedInputTokens.paths], "inputTotalTokens - cachedInputTokens", ["inputTotalTokens", "cachedInputTokens"]);
    }
    if (total !== null && cached !== null && written !== null) {
        if (cached + written > total) result.invalid = "缓存读写用量超过输入总量";
        else
            put("inputTokens", total - cached - written, [...meterSources.inputTotalTokens.paths, ...meterSources.cachedInputTokens.paths, ...meterSources.cacheWriteTokens.paths], "inputTotalTokens - cachedInputTokens - cacheWriteTokens", [
                "inputTotalTokens",
                "cachedInputTokens",
                "cacheWriteTokens",
            ]);
    }
    if (protocol === "openai-chat" && (usage.prompt_cache_hit_tokens !== undefined || usage.prompt_cache_miss_tokens !== undefined)) {
        if (nativeHit === null) missing.push("prompt_cache_hit_tokens");
        if (nativeMiss === null) missing.push("prompt_cache_miss_tokens");
        if ((usage.prompt_cache_hit_tokens != null && nativeHit === null) || (usage.prompt_cache_miss_tokens != null && nativeMiss === null)) result.invalid = "原生缓存用量无效";
        else if (compatibleHit !== null && nativeHit !== null && compatibleHit !== nativeHit) result.invalid = "原生缓存命中量与兼容字段不一致";
        else if (nativeHit !== null && nativeMiss !== null && total !== null && (!Number.isSafeInteger(nativeHit + nativeMiss) || nativeHit + nativeMiss !== total)) result.invalid = "原生缓存命中与未命中量之和不等于输入总量";
    }
    const reasoning = alias(
        [
            { path: "reasoning_tokens", value: usage.reasoning_tokens },
            { path: "completion_tokens_details.reasoning_tokens", value: record(usage.completion_tokens_details).reasoning_tokens },
            { path: "output_tokens_details.reasoning_tokens", value: record(usage.output_tokens_details).reasoning_tokens },
        ],
        "reasoningTokens",
        "reasoning_tokens",
    );
    const missingReasoningIndex = missing.indexOf("reasoning_tokens");
    if (missingReasoningIndex >= 0) missing.splice(missingReasoningIndex, 1);
    delete quantities.reasoningTokens;
    delete meterSources.reasoningTokens;
    if (output !== null && reasoning !== null && reasoning > output) result.invalid ||= "推理用量超过输出总量";
    if (usage.total_tokens !== undefined && (tokenCount(usage.total_tokens) === null || (total !== null && output !== null && BigInt(tokenCount(usage.total_tokens)!) !== BigInt(total) + BigInt(output)))) result.invalid ||= "总用量与输入输出用量不一致";
    return finish();
}

function valuesEqual(left: number | null, right: number) {
    return left === null || left === right;
}

function inspectAnthropicDetails(usage: Record<string, unknown>) {
    const knownPaths: string[] = [];
    let invalid: string | undefined;
    if (usage.output_tokens_details !== undefined) {
        const detail = record(usage.output_tokens_details);
        knownPaths.push("output_tokens_details.thinking_tokens");
        const thinking = tokenCount(detail.thinking_tokens);
        const output = tokenCount(usage.output_tokens);
        if (Object.keys(detail).some((key) => key !== "thinking_tokens") || thinking === null || (output !== null && thinking > output)) invalid = "思考用量明细无效或超过输出总量";
    }
    if (usage.iterations === undefined) return { knownPaths, invalid };
    if (!Array.isArray(usage.iterations) || !usage.iterations.length) return { knownPaths, invalid: invalid || "迭代用量结构无效" };
    const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
    const ttlFields = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] as const;
    const sums = Object.fromEntries(fields.map((field) => [field, BigInt(0)])) as Record<(typeof fields)[number], bigint>;
    for (const [index, raw] of usage.iterations.entries()) {
        const item = record(raw);
        const detail = record(item.cache_creation);
        if (
            item.type !== "message" ||
            Object.keys(item).some((key) => key !== "type" && key !== "cache_creation" && !fields.includes(key as (typeof fields)[number])) ||
            (item.cache_creation !== undefined && Object.keys(detail).some((key) => !ttlFields.includes(key as (typeof ttlFields)[number])))
        )
            invalid ||= "迭代用量结构或类型尚未核实";
        for (const field of fields) {
            knownPaths.push(`iterations[${index}].${field}`);
            const count = tokenCount(item[field]);
            if (count === null) invalid ||= `迭代 ${index + 1} 的 ${field} 用量无效`;
            else sums[field] += BigInt(count);
        }
        for (const field of ttlFields) knownPaths.push(`iterations[${index}].cache_creation.${field}`);
        const five = tokenCount(detail.ephemeral_5m_input_tokens);
        const hour = tokenCount(detail.ephemeral_1h_input_tokens);
        if (five === null || hour === null || (tokenCount(item.cache_creation_input_tokens) !== null && BigInt(five) + BigInt(hour) !== BigInt(item.cache_creation_input_tokens as number))) invalid ||= `迭代 ${index + 1} 的缓存写入分档无效`;
    }
    for (const field of fields) {
        const total = tokenCount(usage[field]);
        if (total !== null && sums[field] !== BigInt(total)) invalid ||= `${field} 迭代合计与顶层用量不一致`;
    }
    return { knownPaths, invalid };
}
