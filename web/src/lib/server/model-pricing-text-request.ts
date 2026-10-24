import type { FlatTextCallContext } from "./model-pricing-token-contract";
import type { TokenUsageProtocol } from "./model-pricing-token-usage";

export type RequestContext = Pick<FlatTextCallContext, "inputModalities" | "outputModalities" | "usesExternalTools" | "billingMode"> & { region?: string; serviceTier?: string };
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export function onlyTextContent(value: unknown): boolean {
    if (typeof value === "string") return true;
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((part) => {
            const item = object(part);
            return ["text", "input_text", "output_text"].includes(String(item.type)) && typeof item.text === "string";
        })
    );
}

export function inspectFlatTextRequestContext(protocol: TokenUsageProtocol | null, payload: unknown): RequestContext {
    const body = object(payload);
    let isText = false;
    if (protocol === "gemini-generate") {
        const contents = [...(Array.isArray(body.contents) ? body.contents : []), ...(body.systemInstruction || body.system_instruction ? [body.systemInstruction || body.system_instruction] : [])];
        isText =
            contents.length > 0 &&
            contents.every((content) => {
                const parts = object(content).parts;
                return Array.isArray(parts) && parts.length > 0 && parts.every((part) => typeof object(part).text === "string" && !object(part).inlineData && !object(part).fileData && !object(part).functionCall && !object(part).functionResponse);
            }) &&
            !body.cachedContent;
    } else if (protocol === "openai-responses" && typeof body.input === "string") isText = true;
    else {
        const messages = protocol === "openai-responses" ? body.input : body.messages;
        isText =
            Array.isArray(messages) &&
            messages.length > 0 &&
            messages.every((message) => {
                const item = object(message);
                return ["system", "developer", "user", "assistant"].includes(String(item.role)) && (!item.type || item.type === "message") && !item.tool_calls && !item.function_call && onlyTextContent(item.content);
            });
    }
    if (body.previous_response_id || body.conversation || body.context_management || (body.system !== undefined && !onlyTextContent(body.system))) isText = false;
    const modalities = body.modalities || object(body.generationConfig).responseModalities;
    return {
        inputModalities: [isText ? "text" : "unknown"],
        outputModalities: Array.isArray(modalities) ? modalities.map((value) => String(value).toLowerCase()) : body.audio ? ["audio"] : ["text"],
        usesExternalTools: Boolean((Array.isArray(body.tools) && body.tools.length) || (Array.isArray(body.functions) && body.functions.length) || body.tool_choice || body.function_call),
        billingMode: body.background || body.batch ? "unsupported" : "standard",
        ...(text(body.inference_geo) ? { region: text(body.inference_geo) } : {}),
        ...(text(body.service_tier) ? { serviceTier: text(body.service_tier) } : {}),
    };
}
