import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AudioTask } from "./audio-task-store";
import { generationModelId } from "./generation-channel";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import { mutateStoredGenerationTask } from "./generation-task-store";
import { inspectUsageFields } from "./model-pricing-usage-fields";

export type AudioUsageObservation = {
    reportedModel?: string;
    serviceTier?: string;
    quantities: Record<string, string>;
    missing: string[];
    invalid: string[];
    hasAudio: boolean;
    usageFields?: Record<string, string>;
    unmappedUsageFields?: string[];
    meterSources?: Record<string, { paths: string[]; kind: "upstream-response" }>;
} & ({ protocol: "openai-chat-audio" } | { protocol: "gemini-tts" });
export type AudioUsageReceipt = {
    id: string;
    attemptNo: number;
    channelId?: string;
    requestedModel: string;
    logicalModel: string;
    observedAt: string;
    pointsRecordId?: string;
    observation: AudioUsageObservation;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Response facts only: no inferred text/cache split, duration, prices or missing-zero defaults. */
export function inspectAudioUsage(protocol: AudioUsageObservation["protocol"], payload: unknown): AudioUsageObservation {
    const body = object(payload);
    const gemini = protocol === "gemini-tts";
    const usage = object(gemini ? body.usageMetadata : body.usage);
    const knownPaths = gemini
        ? [
              "promptTokenCount",
              "candidatesTokenCount",
              "totalTokenCount",
              "cachedContentTokenCount",
              "thoughtsTokenCount",
              "toolUsePromptTokenCount",
              "serviceTier",
              ...["promptTokensDetails", "candidatesTokensDetails", "cacheTokensDetails", "toolUsePromptTokensDetails"].flatMap((field) => ["TEXT", "AUDIO", "IMAGE", "VIDEO"].map((modality) => `${field}[${modality}].tokenCount`)),
          ]
        : [
              "prompt_tokens",
              "completion_tokens",
              "total_tokens",
              ...["text", "audio", "image", "cached", "cache_write"].map((field) => `prompt_tokens_details.${field}_tokens`),
              ...["text", "audio", "reasoning", "accepted_prediction", "rejected_prediction"].map((field) => `completion_tokens_details.${field}_tokens`),
          ];
    const inventory = inspectUsageFields(usage, knownPaths);
    const observation: AudioUsageObservation = { protocol, quantities: {}, missing: [], invalid: [], hasAudio: false, usageFields: inventory.fields, unmappedUsageFields: inventory.unmapped, meterSources: {} };
    const model = gemini ? body.modelVersion : body.model;
    const tier = gemini ? usage.serviceTier : body.service_tier;
    if (typeof model === "string" && model.trim()) observation.reportedModel = model;
    else if (model !== undefined) observation.invalid.push("上游响应型号格式无效");
    if (typeof tier === "string" && tier.trim()) observation.serviceTier = tier;
    else if (tier !== undefined) observation.invalid.push("上游服务档位格式无效");
    if (body.error) observation.invalid.push("上游响应包含错误");
    const read = (source: Record<string, unknown>, field: string, target: string, path = field) => {
        const value = source[field];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            observation.quantities[target] = String(value);
            observation.meterSources![target] = { paths: [`${gemini ? "usageMetadata" : "usage"}.${path}`], kind: "upstream-response" };
        } else {
            observation.missing.push(path);
            if (value !== undefined && value !== null) observation.invalid.push(`${path} 不是有效的非负整数`);
        }
    };
    const sumMatches = (total: string, parts: string[]) => {
        const q = observation.quantities;
        if (q[total] !== undefined && parts.every((key) => q[key] !== undefined) && parts.reduce((sum, key) => sum + BigInt(q[key]), BigInt(0)) !== BigInt(q[total])) observation.invalid.push(`${total} 与分项合计不一致`);
    };
    const within = (part: string, total: string) => {
        const q = observation.quantities;
        if (q[part] !== undefined && q[total] !== undefined && BigInt(q[part]) > BigInt(q[total])) observation.invalid.push(`${part} 超过 ${total}`);
    };
    if (!gemini) {
        for (const [field, target] of [
            ["prompt_tokens", "inputTotalTokens"],
            ["completion_tokens", "outputTotalTokens"],
            ["total_tokens", "totalTokens"],
        ])
            read(usage, field, target);
        for (const [field, prefix, fields] of [
            ["prompt_tokens_details", "input", ["text", "audio", "image", "cached", "cache_write"]],
            ["completion_tokens_details", "output", ["text", "audio", "reasoning", "accepted_prediction", "rejected_prediction"]],
        ] as const) {
            for (const meter of fields) {
                const target = `${prefix}${meter
                    .split("_")
                    .map((part) => part[0].toUpperCase() + part.slice(1))
                    .join("")}Tokens`;
                read(object(usage[field]), `${meter}_tokens`, target, `${field}.${meter}_tokens`);
                within(target, `${prefix}TotalTokens`);
            }
        }
        for (const [total, parts] of [
            ["inputTotalTokens", ["inputTextTokens", "inputAudioTokens", "inputImageTokens"]],
            ["outputTotalTokens", ["outputTextTokens", "outputAudioTokens"]],
        ] as const) {
            const q = observation.quantities;
            const known = parts.filter((key) => q[key] !== undefined);
            if (q[total] !== undefined && known.reduce((sum, key) => sum + BigInt(q[key]), BigInt(0)) > BigInt(q[total])) observation.invalid.push(`${total} 小于已知模态合计`);
        }
        sumMatches("totalTokens", ["inputTotalTokens", "outputTotalTokens"]);
        observation.hasAudio =
            Array.isArray(body.choices) &&
            body.choices.some((choice) => {
                const data = object(object(object(choice).message).audio).data;
                return typeof data === "string" && data.length > 0;
            });
    } else {
        for (const [field, target] of [
            ["promptTokenCount", "inputTotalTokens"],
            ["candidatesTokenCount", "outputTotalTokens"],
            ["totalTokenCount", "totalTokens"],
            ["cachedContentTokenCount", "cachedInputTokens"],
            ["thoughtsTokenCount", "thoughtTokens"],
            ["toolUsePromptTokenCount", "toolInputTokens"],
        ])
            read(usage, field, target);
        for (const [field, prefix, total] of [
            ["promptTokensDetails", "input", "inputTotalTokens"],
            ["candidatesTokensDetails", "output", "outputTotalTokens"],
            ["cacheTokensDetails", "cachedInput", "cachedInputTokens"],
            ["toolUsePromptTokensDetails", "toolInput", "toolInputTokens"],
        ]) {
            const details = usage[field];
            if (!Array.isArray(details) || !details.length) {
                observation.missing.push(field);
                continue;
            }
            const keys: string[] = [];
            for (const [index, item] of details.entries()) {
                const entry = object(item);
                if (typeof entry.modality !== "string" || !["TEXT", "AUDIO", "IMAGE", "VIDEO"].includes(entry.modality)) {
                    observation.invalid.push(`${field}[${index}].modality 未识别`);
                    continue;
                }
                const key = `${prefix}${entry.modality[0]}${entry.modality.slice(1).toLowerCase()}Tokens`;
                if (keys.includes(key)) {
                    observation.invalid.push(`${field} 模态重复`);
                    continue;
                }
                keys.push(key);
                read(entry, "tokenCount", key, `${field}[${index}].tokenCount`);
                within(key, total);
            }
            if (keys.length === details.length) sumMatches(total, keys);
        }
        within("cachedInputTokens", "inputTotalTokens");
        for (const modality of ["Text", "Audio", "Image", "Video"]) within(`cachedInput${modality}Tokens`, `input${modality}Tokens`);
        sumMatches("totalTokens", ["inputTotalTokens", "thoughtTokens", "outputTotalTokens"]);
        observation.hasAudio =
            Array.isArray(body.candidates) &&
            body.candidates.some((candidate) => {
                const parts = object(object(candidate).content).parts;
                return (
                    Array.isArray(parts) &&
                    parts.some((part) => {
                        const audio = object(object(part).inlineData);
                        return typeof audio.mimeType === "string" && audio.mimeType.startsWith("audio/") && typeof audio.data === "string" && audio.data.length > 0;
                    })
                );
            });
    }
    if (inventory.unmapped.length && !observation.invalid.length) observation.invalid.push(`未解释的音频用量字段：${inventory.unmapped.join("、")}`);
    return observation;
}

/** Diagnostics cannot fail media delivery or create a second paid attempt. */
export async function observeAudioTaskUsage(task: AudioTask, response: Response, payload: unknown, path: string, protocol: AudioUsageObservation["protocol"]) {
    if (!response.ok || !(protocol === "openai-chat-audio" ? /\/chat\/completions$/.test(path) : /\/models\/[^/]+:generateContent$/.test(path))) return;
    try {
        const observation = inspectAudioUsage(protocol, payload);
        const receipt: AudioUsageReceipt = {
            id: randomUUID(),
            attemptNo: task.attemptNo || 1,
            channelId: task.config.channelId,
            requestedModel: task.config.model,
            logicalModel: generationModelId(task.config),
            observedAt: new Date().toISOString(),
            ...(response.headers.get("x-vozeb-pro-points-record-id") ? { pointsRecordId: response.headers.get("x-vozeb-pro-points-record-id")! } : {}),
            observation,
        };
        await mutateStoredGenerationTask<AudioTask>("audio", task.id, GENERATION_TASK_RETENTION_MS, (current) => {
            if (current.userId !== task.userId) throw new Error("音频用量身份不匹配");
            const existing = current.usageObservations || [];
            if (
                existing.some(
                    (item) =>
                        item.attemptNo === receipt.attemptNo && item.channelId === receipt.channelId && item.requestedModel === receipt.requestedModel && item.pointsRecordId === receipt.pointsRecordId && isDeepStrictEqual(item.observation, observation),
                )
            )
                return null;
            return { ...current, usageObservations: [...existing, receipt] };
        });
    } catch (error) {
        console.error("Audio usage observation unavailable", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
}
