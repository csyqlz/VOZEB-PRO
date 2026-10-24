import { resolveGlobalAiOpcPreset, resolveGlobalAiOpcPresets } from "@/lib/globalaiopc-catalog";
import type { SystemChannelAdvancedConfig } from "@/lib/auth/store";

type ProxyAdapter = "gemini" | "claude";

export type GlobalAiOpcProxyAdaptation = {
    path: string[];
    body: BodyInit;
    adapter: ProxyAdapter;
};

export function isGlobalAiOpcChannel(config?: SystemChannelAdvancedConfig) {
    return Boolean(resolveGlobalAiOpcPresets(config).length);
}

export function adaptGlobalAiOpcTextRequest(config: SystemChannelAdvancedConfig | undefined, path: string[], body: BodyInit | undefined) {
    const payload = jsonObject(body);
    const anthropic = config?.protocol === "anthropic";
    const preset = resolveGlobalAiOpcPreset(config, payload?.model);
    if (!anthropic && (!preset || (preset.id !== "text-gemini-native" && preset.id !== "text-claude-native"))) return null;
    const cleanPath = path[0] === "v1" ? path.slice(1) : path;
    if (cleanPath.join("/") === "responses") return "responses-unsupported" as const;
    if (cleanPath.join("/") !== "chat/completions") return null;
    if (!payload) return null;
    if (anthropic) return { path: ["v1", "messages"], body: JSON.stringify(toClaudeRequest(payload)), adapter: "claude" as const };
    if (!preset) return null;
    return preset.id === "text-gemini-native"
        ? { path: ["models", `${modelName(payload.model)}:generateContent`], body: JSON.stringify(toGeminiRequest(payload)), adapter: "gemini" as const }
        : { path: ["messages"], body: JSON.stringify(toClaudeRequest(payload)), adapter: "claude" as const };
}

export function adaptGlobalAiOpcTextResponse(adapter: ProxyAdapter, payload: unknown) {
    const record = object(payload);
    if (!record) return payload;
    if (adapter === "gemini") return geminiToChatCompletion(record);
    return claudeToChatCompletion(record);
}

function toGeminiRequest(payload: Record<string, unknown>) {
    const messages = array(payload.messages);
    const systemText = messages
        .filter((item) => object(item)?.role === "system")
        .map((item) => contentText(object(item)?.content))
        .filter(Boolean)
        .join("\n\n");
    const tools = array(payload.tools)
        .map((item) => object(item)?.function)
        .map(object)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({ name: text(item.name), description: text(item.description), parameters: item.parameters || { type: "object", properties: {} } }));
    const choice = object(payload.tool_choice);
    const functionChoice = object(choice?.function);
    return {
        contents: messages
            .filter((item) => object(item)?.role !== "system")
            .map((item) => {
                const message = object(item) || {};
                return { role: message.role === "assistant" ? "model" : "user", parts: contentParts(message.content) };
            }),
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
        ...(text(functionChoice?.name) ? { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [text(functionChoice?.name)] } } } : {}),
        ...(typeof payload.temperature === "number" || typeof payload.max_tokens === "number"
            ? { generationConfig: { ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}), ...(typeof payload.max_tokens === "number" ? { maxOutputTokens: payload.max_tokens } : {}) } }
            : {}),
    };
}

function toClaudeRequest(payload: Record<string, unknown>) {
    const messages = array(payload.messages);
    const systemText = messages
        .filter((item) => object(item)?.role === "system")
        .map((item) => contentText(object(item)?.content))
        .filter(Boolean)
        .join("\n\n");
    const tools = array(payload.tools)
        .map((item) => object(item)?.function)
        .map(object)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({ name: text(item.name), description: text(item.description), input_schema: item.parameters || { type: "object", properties: {} } }));
    const choice = object(payload.tool_choice);
    const functionChoice = object(choice?.function);
    return {
        model: modelName(payload.model),
        max_tokens: number(payload.max_tokens, 4096),
        messages: messages.filter((item) => object(item)?.role !== "system").map((item) => ({ role: object(item)?.role === "assistant" ? "assistant" : "user", content: contentText(object(item)?.content) })),
        ...(systemText ? { system: systemText } : {}),
        ...(tools.length ? { tools } : {}),
        ...(text(functionChoice?.name) ? { tool_choice: { type: "tool", name: text(functionChoice?.name) } } : {}),
    };
}

function geminiToChatCompletion(payload: Record<string, unknown>) {
    const candidate = object(array(payload.candidates)[0]) || {};
    const parts = array(object(candidate.content)?.parts);
    const calls = parts
        .map((part) => object(part)?.functionCall)
        .map(object)
        .filter((item): item is Record<string, unknown> => Boolean(item));
    return {
        choices: [
            {
                message: {
                    role: "assistant",
                    content: parts.map((part) => text(object(part)?.text)).join(""),
                    ...(calls.length ? { tool_calls: calls.map((call, index) => ({ id: `globalaiopc-${index + 1}`, type: "function", function: { name: text(call.name), arguments: JSON.stringify(call.args || {}) } })) } : {}),
                },
                finish_reason: text(candidate.finishReason) || "stop",
            },
        ],
    };
}

function claudeToChatCompletion(payload: Record<string, unknown>) {
    const content = array(payload.content);
    const calls = content.map(object).filter((item): item is Record<string, unknown> => item?.type === "tool_use");
    return {
        choices: [
            {
                message: {
                    role: "assistant",
                    content: content.map((item) => text(object(item)?.text)).join(""),
                    ...(calls.length ? { tool_calls: calls.map((call) => ({ id: text(call.id), type: "function", function: { name: text(call.name), arguments: JSON.stringify(call.input || {}) } })) } : {}),
                },
                finish_reason: text(payload.stop_reason) || "stop",
            },
        ],
    };
}

function jsonObject(body: BodyInit | undefined) {
    const value = typeof body === "string" ? body : body instanceof ArrayBuffer ? new TextDecoder().decode(body) : null;
    if (!value) return null;
    try {
        return object(JSON.parse(value));
    } catch {
        return null;
    }
}

function contentParts(value: unknown) {
    const content = Array.isArray(value) ? value : [{ type: "text", text: contentText(value) }];
    return content.map((item) => {
        const record = object(item) || {};
        if (record.type === "image_url") return { fileData: { fileUri: text(object(record.image_url)?.url) || text(record.image_url), mimeType: "image/png" } };
        return { text: text(record.text) || contentText(record) };
    });
}

function contentText(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value))
        return value
            .map((item) => contentText(item))
            .filter(Boolean)
            .join("\n");
    const record = object(value);
    return text(record?.text) || text(record?.content) || "";
}

function modelName(value: unknown) {
    return text(value).replace(/^models\//, "");
}

function array(value: unknown) {
    return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown, fallback: number) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
