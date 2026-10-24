import type { ApiCallFormat, SystemChannelAdvancedConfig, SystemChannelModelConfig, SystemChannelProtocol } from "@/lib/auth/store";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";

export type ResolvedTextProtocolKind = "chat" | "responses" | "gemini" | "claude" | "custom";

export type ResolvedTextProtocol = {
    kind: ResolvedTextProtocolKind;
    path: string;
    providerKind: ResolvedTextProtocolKind;
    providerPath: string;
    requestTemplate?: string;
    resultField?: string;
};

type TextProtocolInput = {
    model: string;
    apiFormat: ApiCallFormat;
    advancedConfig?: SystemChannelAdvancedConfig;
    throughSystemProxy?: boolean;
};

export function resolveTextProtocol(input: TextProtocolInput): ResolvedTextProtocol {
    const advanced = input.advancedConfig;
    const modelConfig = resolveChannelModelConfig(advanced, input.model);
    const preset = resolveGlobalAiOpcPreset(advanced, input.model);

    if (preset?.id === "text-gemini-native") {
        return proxyAdapted(input, "gemini", interpolateModelPath(preset.createPath, input.model));
    }
    if (preset?.id === "text-claude-native") return proxyAdapted(input, "claude", preset.createPath);
    if (preset?.id === "text-openai-responses") return resolved("responses", preset.createPath);
    if (preset?.id === "text-openai-chat") return resolved("chat", preset.createPath);

    const modelProtocol = modelConfig?.protocol;
    const modelPath = modelConfig?.createPath?.trim() || "";
    if (modelProtocol === "anthropic") return resolved("claude", modelPath || "/v1/messages");
    if (modelProtocol === "custom") return customProtocol(advanced, modelConfig, modelPath);
    if (isChatPreset(modelProtocol)) return resolved("chat", "/chat/completions");
    if (modelProtocol === "globalaiopc") return resolved("chat", "/chat/completions");
    if (isResponsesPath(modelPath)) return resolved("responses", modelPath);
    if (isChatPath(modelPath)) return resolved("chat", modelPath);
    if (isClaudePath(modelPath)) return resolved("claude", modelPath);
    if (modelConfig && (modelConfig.apiFormat === "gemini" || input.apiFormat === "gemini" || isGeminiPath(modelPath))) {
        return resolved("gemini", interpolateModelPath(modelPath || "/models/:model:generateContent", input.model));
    }

    const channelProtocol = advanced?.protocol || "auto";
    const channelPath = advanced?.createPath?.trim() || "";
    if (channelProtocol === "anthropic") return resolved("claude", channelPath || "/v1/messages");
    if (channelProtocol === "custom") return customProtocol(advanced, modelConfig, modelPath || channelPath);
    if (isChatPreset(channelProtocol)) return resolved("chat", "/chat/completions");
    if (channelProtocol === "globalaiopc") return resolved("chat", "/chat/completions");
    if (isResponsesPath(channelPath)) return resolved("responses", channelPath);
    if (isChatPath(channelPath)) return resolved("chat", channelPath);
    if (isClaudePath(channelPath)) return resolved("claude", channelPath);
    if (input.apiFormat === "gemini" || isGeminiPath(channelPath)) {
        return resolved("gemini", interpolateModelPath(channelPath || "/models/:model:generateContent", input.model));
    }

    if (channelPath && (modelConfig?.requestTemplate || advanced?.requestTemplate) && (modelConfig?.resultField || advanced?.resultField)) {
        return customProtocol(advanced, modelConfig, channelPath);
    }
    return resolved("chat", "/chat/completions");
}

function proxyAdapted(input: TextProtocolInput, providerKind: "gemini" | "claude", providerPath: string): ResolvedTextProtocol {
    if (!input.throughSystemProxy) return resolved(providerKind, providerPath);
    return { ...resolved("chat", "/chat/completions"), providerKind, providerPath };
}

function customProtocol(advanced: SystemChannelAdvancedConfig | undefined, modelConfig: SystemChannelModelConfig | undefined, path: string): ResolvedTextProtocol {
    const requestTemplate = modelConfig?.requestTemplate || advanced?.requestTemplate;
    const resultField = modelConfig?.resultField || advanced?.resultField;
    if (!path || !requestTemplate || !resultField) throw new Error("自定义文本协议缺少创建路径、请求模板或结果字段");
    return { ...resolved("custom", path), requestTemplate, resultField };
}

function resolved(kind: ResolvedTextProtocolKind, path: string): ResolvedTextProtocol {
    return { kind, path, providerKind: kind, providerPath: path };
}

function isChatPreset(protocol: SystemChannelProtocol | undefined) {
    return protocol === "openai" || protocol === "sub2api" || protocol === "sub2api-grok" || protocol === "newapi";
}

function isResponsesPath(value: string) {
    return /\/responses(?:$|[/?#])/i.test(value);
}

function isChatPath(value: string) {
    return /\/chat\/completions(?:$|[/?#])/i.test(value);
}

function isGeminiPath(value: string) {
    return /generateContent(?:$|[/?#])/i.test(value);
}

function isClaudePath(value: string) {
    return /\/messages(?:$|[/?#])/i.test(value);
}

export function interpolateModelPath(path: string, model: string) {
    const encoded = encodeURIComponent(model.replace(/^models\//, ""));
    return path.replace(/:(?:model|model_id)\b/g, encoded).replace(/\{(?:model|model_id)\}/g, encoded);
}
