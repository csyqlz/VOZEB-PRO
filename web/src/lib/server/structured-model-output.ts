import { jsonrepair } from "jsonrepair";

export function strictJsonObjectText(value: unknown) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() || "";
    return parseObjectText(text) || parseObjectText(fenced);
}

export function extractJsonObjectText(value: unknown) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    const strict = strictJsonObjectText(text);
    if (strict) return strict;
    for (let start = 0; start < text.length; start += 1) {
        if (text[start] !== "{") continue;
        let depth = 0;
        let escaped = false;
        let inString = false;
        for (let index = start; index < text.length; index += 1) {
            const character = text[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === "\\" && inString) {
                escaped = true;
                continue;
            }
            if (character === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (character === "{") depth += 1;
            if (character !== "}") continue;
            depth -= 1;
            if (depth !== 0) continue;
            const candidate = text.slice(start, index + 1);
            const parsed = parseObjectText(candidate);
            if (parsed) return parsed;
            const repaired = repairObjectText(candidate);
            if (repaired) return repaired;
            break;
        }
    }
    for (let start = 0; start < text.length; start += 1) {
        if (text[start] !== "{") continue;
        const repaired = repairObjectText(text.slice(start));
        if (repaired) return repaired;
    }
    return "";
}

function parseObjectText(value: string) {
    if (!value.startsWith("{") || !value.endsWith("}")) return "";
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? value : "";
    } catch {
        return "";
    }
}

function repairObjectText(value: string) {
    if (!value.startsWith("{")) return "";
    try {
        const repaired = jsonrepair(value);
        const parsed = JSON.parse(repaired);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? repaired : "";
    } catch {
        return "";
    }
}
