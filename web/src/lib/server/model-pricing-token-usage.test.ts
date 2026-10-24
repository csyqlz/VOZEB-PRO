import { describe, expect, it } from "vitest";

import { inspectProviderTokenUsage, reinterpretOpenAiZeroTokenDetails } from "./model-pricing-token-usage";

describe("provider token usage inspection", () => {
    it("prices text when a channel reports zero audio and prediction counters plus latency, but rejects nonzero audio", () => {
        const usage = {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25,
            prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 5, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
            latency_checkpoint: { engine_tbt_ms: 7, engine_ttft_ms: 85, service_ttlt_ms: 570 },
        };
        const observed = inspectProviderTokenUsage("openai-chat", { model: "gpt-6-luna", service_tier: "default", usage });
        expect(observed).toMatchObject({ reportedModel: "gpt-6-luna", serviceTier: "default", missing: [], unmappedUsageFields: [], quantities: { inputTotalTokens: "10", outputTokens: "15" } });
        expect(observed.invalid).toBeUndefined();
        expect(inspectProviderTokenUsage("openai-chat", { usage: { ...usage, prompt_tokens_details: { ...usage.prompt_tokens_details, audio_tokens: 1 } } }).invalid).toContain("prompt_tokens_details.audio_tokens");
        expect(inspectProviderTokenUsage("openai-chat", { usage: { ...usage, new_billable_tokens: 1 } }).invalid).toContain("new_billable_tokens");
    });

    it("accepts only zero-valued text and image detail counters and reinterprets saved zero-only evidence", () => {
        const usage = {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 0, text_tokens: 0, image_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0, text_tokens: 0, image_tokens: 0 },
        };
        const parsed = inspectProviderTokenUsage("openai-chat", { model: "gpt-6-luna", usage });
        expect(parsed.invalid).toBeUndefined();
        expect(parsed.unmappedUsageFields).toEqual([]);
        expect(inspectProviderTokenUsage("openai-chat", { usage: { ...usage, prompt_tokens_details: { ...usage.prompt_tokens_details, image_tokens: 1 } } }).invalid).toContain("prompt_tokens_details.image_tokens");
        const paths = ["prompt_tokens_details.text_tokens", "prompt_tokens_details.image_tokens", "completion_tokens_details.text_tokens", "completion_tokens_details.image_tokens"];
        const saved = { ...parsed, unmappedUsageFields: paths, invalid: `未解释的文本用量字段：${paths.join("、")}` };
        expect(reinterpretOpenAiZeroTokenDetails(saved)).toMatchObject({ invalid: undefined, unmappedUsageFields: [] });
        expect(reinterpretOpenAiZeroTokenDetails({ ...saved, usageFields: { ...saved.usageFields, "prompt_tokens_details.image_tokens": "1" } }).invalid).toContain("prompt_tokens_details.image_tokens");
        expect(reinterpretOpenAiZeroTokenDetails({ ...saved, invalid: "其他用量错误" }).invalid).toBe("其他用量错误");
    });

    it("rejects conflicting aliases, explicit null, unknown billing fields and contradictory totals", () => {
        const response = (usage: Record<string, unknown>) => inspectProviderTokenUsage("openai-chat", { usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, ...usage } });
        expect(response({ input_tokens: 11 }).invalid).toContain("同义字段不一致");
        expect(response({ prompt_tokens_details: { cached_tokens: null, cache_write_tokens: 0 } }).invalid).toContain("用量无效");
        expect(response({ prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, input_tokens_details: { cache_write_tokens: 1 } }).invalid).toContain("同义字段不一致");
        expect(response({ total_tokens: 14 }).invalid).toContain("总用量");
        expect(response({ new_billable_tokens: 1 }).invalid).toContain("未解释");
    });
    it("splits OpenAI Responses input into ordinary, cached read and cached write tokens", () => {
        expect(
            inspectProviderTokenUsage("openai-responses", {
                model: "gpt-6-astra",
                service_tier: "default",
                usage: { input_tokens: 1000, output_tokens: 90, input_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } },
            }),
        ).toMatchObject({
            reportedModel: "gpt-6-astra",
            serviceTier: "default",
            missing: [],
            quantities: {
                inputTotalTokens: "1000",
                inputTokens: "500",
                cachedInputTokens: "300",
                cacheWriteTokens: "200",
                outputTokens: "90",
            },
        });
    });

    it("keeps absent cache-write details unknown rather than charging them as ordinary input", () => {
        const result = inspectProviderTokenUsage("openai-chat", {
            usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 300 } },
        });
        expect(result.quantities).toMatchObject({ inputTotalTokens: "1000", uncachedInputTokens: "700", cachedInputTokens: "300", outputTokens: "50" });
        expect(result.quantities.inputTokens).toBeUndefined();
        expect(result.quantities.cacheWriteTokens).toBeUndefined();
        expect(result.missing).toEqual(["cache_write_tokens"]);
        expect(inspectProviderTokenUsage("openai-chat", { usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6 } } })).toMatchObject({ invalid: "缓存读取用量超过输入总量" });
        expect(inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } } }).invalid).toBe("缓存读写用量超过输入总量");
    });

    it("reads Qwen explicit cache creation without silently accepting contradictory write fields", () => {
        const chat = (details: Record<string, unknown>) =>
            inspectProviderTokenUsage("openai-chat", {
                model: "qwen3.8-max",
                usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20, ...details } },
            });
        expect(chat({ cache_creation_input_tokens: 30 })).toMatchObject({ missing: [], quantities: { inputTokens: "50", cachedInputTokens: "20", cacheWriteTokens: "30" } });
        expect(chat({ cache_write_tokens: 30, cache_creation_input_tokens: 30 }).invalid).toBeUndefined();
        expect(chat({ cache_write_tokens: 30, cache_creation_input_tokens: 31 }).invalid).toBe("缓存写入用量字段不一致");
        expect(chat({ cache_write_tokens: -1, cache_creation_input_tokens: 30 }).invalid).toBe("cacheWriteTokens 用量无效");
        expect(chat({}).quantities.inputTokens).toBeUndefined();
        expect(inspectProviderTokenUsage("openai-responses", { usage: { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 20, cache_creation_input_tokens: 30 } } }).missing).toContain("cache_write_tokens");
    });

    it("checks Kimi K3 Chat write TTL headers against the final usage total", () => {
        const payload = { model: "kimi-k3", usage: { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } } };
        const headers = new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "60", "Msh-Usage-Cache-Write-Tokens-1h": "40" });
        expect(inspectProviderTokenUsage("openai-chat", payload, headers)).toMatchObject({
            missing: [],
            quantities: {
                inputTokens: "700",
                cachedInputTokens: "200",
                cacheWriteTokens: "100",
                cacheWrite5mTokens: "60",
                cacheWrite1hTokens: "40",
                outputTokens: "90",
            },
        });
        expect(inspectProviderTokenUsage("openai-chat", payload).quantities.cacheWrite5mTokens).toBeUndefined();
        expect(inspectProviderTokenUsage("openai-chat", payload, new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "60" }))).toMatchObject({ missing: ["Msh-Usage-Cache-Write-Tokens-1h"], quantities: { cacheWrite5mTokens: "60" } });
        expect(inspectProviderTokenUsage("openai-chat", payload, new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "61", "Msh-Usage-Cache-Write-Tokens-1h": "40" })).invalid).toBe("缓存写入分档用量与总量不一致");
        expect(inspectProviderTokenUsage("openai-chat", payload, new Headers({ "Msh-Usage-Cache-Write-Tokens-5m": "not-a-number", "Msh-Usage-Cache-Write-Tokens-1h": "40" })).invalid).toBe("缓存写入分档响应头无效");
        const zero = { ...payload, usage: { ...payload.usage, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 } } };
        expect(inspectProviderTokenUsage("openai-chat", zero).quantities).toMatchObject({ cacheWrite5mTokens: "0", cacheWrite1hTokens: "0" });
        expect(inspectProviderTokenUsage("openai-chat", zero, headers).invalid).toBe("缓存写入分档用量与总量不一致");
    });

    it("cross-checks DeepSeek native hit and miss counters without inferring a free cache write", () => {
        const chat = (usage: Record<string, unknown>) =>
            inspectProviderTokenUsage("openai-chat", {
                model: "deepseek-flash",
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 8,
                    prompt_tokens_details: { cached_tokens: 20 },
                    prompt_cache_hit_tokens: 20,
                    prompt_cache_miss_tokens: 80,
                    ...usage,
                },
            });
        expect(chat({})).toMatchObject({ missing: ["cache_write_tokens"], quantities: { cachedInputTokens: "20", cacheMissTokens: "80", uncachedInputTokens: "80" } });
        expect(chat({}).quantities.inputTokens).toBeUndefined();
        expect(chat({ prompt_tokens_details: {} })).toMatchObject({ missing: ["cache_write_tokens"], quantities: { cachedInputTokens: "20" } });
        expect(chat({ prompt_cache_hit_tokens: 21 }).invalid).toBe("原生缓存命中量与兼容字段不一致");
        expect(chat({ prompt_cache_miss_tokens: 79 }).invalid).toBe("原生缓存命中与未命中量之和不等于输入总量");
        expect(chat({ prompt_cache_hit_tokens: -1 }).invalid).toBe("原生缓存用量无效");
        expect(chat({ prompt_cache_miss_tokens: Number.MAX_SAFE_INTEGER }).invalid).toBe("原生缓存命中与未命中量之和不等于输入总量");
    });

    it("keeps Anthropic cache writes in their TTL buckets without double counting input", () => {
        expect(
            inspectProviderTokenUsage("anthropic-messages", {
                model: "claude-sonnet-5",
                usage: {
                    input_tokens: 42,
                    output_tokens: 12,
                    cache_read_input_tokens: 300,
                    cache_creation_input_tokens: 100,
                    cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
                    service_tier: "standard",
                    inference_geo: "global",
                },
            }),
        ).toMatchObject({
            serviceTier: "standard",
            inferenceGeo: "global",
            missing: [],
            quantities: {
                inputTokens: "42",
                outputTokens: "12",
                cachedInputTokens: "300",
                cacheWriteTotalTokens: "100",
                cacheWrite5mTokens: "60",
                cacheWrite1hTokens: "40",
            },
        });
        expect(
            inspectProviderTokenUsage("anthropic-messages", {
                usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
            }).quantities,
        ).toMatchObject({ cacheWrite5mTokens: "0", cacheWrite1hTokens: "0" });
        expect(
            inspectProviderTokenUsage("anthropic-messages", {
                usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 10,
                },
            }).missing,
        ).toEqual(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);
    });

    it("accepts the verified DataEyes Messages details as validation-only usage", () => {
        const usage = {
            input_tokens: 18,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            iterations: [{ input_tokens: 18, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, type: "message" }],
            output_tokens_details: { thinking_tokens: 0 },
            service_tier: "standard",
            inference_geo: "global",
        };
        const inspect = (patch: Record<string, unknown> = {}) => inspectProviderTokenUsage("anthropic-messages", { model: "claude-fable-5", usage: { ...usage, ...patch } });
        expect(inspect()).toMatchObject({
            reportedModel: "claude-fable-5",
            serviceTier: "standard",
            inferenceGeo: "global",
            missing: [],
            quantities: { inputTokens: "18", outputTokens: "3", cachedInputTokens: "0", cacheWrite5mTokens: "0", cacheWrite1hTokens: "0" },
            unmappedUsageFields: [],
        });
        expect(inspect().quantities).not.toHaveProperty("thinkingTokens");
        expect(inspect({ iterations: [{ ...usage.iterations[0], output_tokens: 4 }] }).invalid).toContain("迭代合计");
        expect(inspect({ output_tokens_details: { thinking_tokens: 1 } }).invalid).toBeUndefined();
        expect(inspect({ output_tokens_details: { thinking_tokens: 1 } }).quantities).toMatchObject({ outputTokens: "3" });
        expect(inspect({ output_tokens_details: { thinking_tokens: 4 } }).invalid).toContain("超过输出总量");
        expect(inspect({ output_tokens_details: { thinking_tokens: null } }).invalid).toContain("思考用量明细无效");
        expect(inspect({ output_tokens_details: { thinking_tokens: 1, new_billable_tokens: 1 } }).invalid).toContain("思考用量明细无效");
        expect(inspect({ iterations: [{ ...usage.iterations[0], type: "tool" }] }).invalid).toContain("结构或类型");
        expect(inspect({ iterations: [{ ...usage.iterations[0], new_billable_tokens: 1 }] }).invalid).toContain("结构或类型");
        expect(inspect({ new_billable_tokens: 1 }).unmappedUsageFields).toContain("new_billable_tokens");
    });

    it("separates Gemini cached prompt tokens and includes thinking in output", () => {
        expect(
            inspectProviderTokenUsage("gemini-generate", {
                modelVersion: "gemini-3.8-flash",
                usageMetadata: {
                    promptTokenCount: 500,
                    cachedContentTokenCount: 200,
                    candidatesTokenCount: 30,
                    thoughtsTokenCount: 70,
                    serviceTier: "STANDARD",
                },
            }),
        ).toMatchObject({
            reportedModel: "gemini-3.8-flash",
            serviceTier: "STANDARD",
            missing: [],
            quantities: {
                inputTotalTokens: "500",
                inputTokens: "300",
                cachedInputTokens: "200",
                candidateOutputTokens: "30",
                thoughtOutputTokens: "70",
                outputTokens: "100",
            },
        });
        const incomplete = inspectProviderTokenUsage("gemini-generate", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
        expect(incomplete.quantities.inputTokens).toBeUndefined();
        expect(incomplete.quantities.outputTokens).toBeUndefined();
        expect(incomplete.missing).toEqual(["cachedContentTokenCount", "thoughtsTokenCount"]);
    });

    it("rejects unusable negative or imprecise counters", () => {
        const result = inspectProviderTokenUsage("openai-responses", {
            usage: {
                input_tokens: Number.MAX_SAFE_INTEGER + 1,
                output_tokens: -1,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            },
        });
        expect(result.missing).toEqual(["input_tokens", "output_tokens"]);
        expect(result.quantities.inputTokens).toBeUndefined();
        expect(
            inspectProviderTokenUsage("gemini-generate", {
                usageMetadata: {
                    promptTokenCount: 0,
                    cachedContentTokenCount: 0,
                    candidatesTokenCount: Number.MAX_SAFE_INTEGER,
                    thoughtsTokenCount: 1,
                },
            }),
        ).toMatchObject({ invalid: "输出用量超过安全整数范围", quantities: { candidateOutputTokens: String(Number.MAX_SAFE_INTEGER), thoughtOutputTokens: "1" } });
        expect(
            inspectProviderTokenUsage("anthropic-messages", {
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 1,
                    cache_creation: { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 1 },
                },
            }).invalid,
        ).toBe("缓存写入分档用量与总量不一致");
    });
});
