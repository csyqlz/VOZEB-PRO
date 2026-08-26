import type { ComponentProps } from "react";
export function CreditSymbol({ className, ...props }: ComponentProps<"span">) {
    return (
        <span {...props} className={`inline-flex items-center justify-center font-semibold leading-none ${className || ""}`}>
            ¥
        </span>
    );
}

type ModelCreditCost = {
    model: string;
    credits: number;
};

type GenerationPointMultipliers = {
    imageQuality: Record<string, number>;
    videoQuality: Record<string, number>;
    videoSeconds: Record<string, number>;
};

export const DEFAULT_MODEL_POINT_COST_KEY = "__default__";

function modelName(value: string) {
    const separator = value.indexOf("::");
    return separator >= 0 ? value.slice(separator + 2) : value;
}

function modelCreditCost(modelCosts: Record<string, number> | ModelCreditCost[] | undefined, model: string) {
    const name = modelName(model).trim();
    if (Array.isArray(modelCosts)) return modelCosts.find((item) => item.model === name)?.credits ?? 1;
    if (!modelCosts) return 1;
    const direct = modelCosts[name];
    if (direct !== undefined) return direct;
    const insensitiveKey = Object.keys(modelCosts).find((key) => key.toLowerCase() === name.toLowerCase());
    if (insensitiveKey) return modelCosts[insensitiveKey] ?? 1;
    return modelCosts[DEFAULT_MODEL_POINT_COST_KEY] ?? 1;
}

export function formatCreditAmount(value: number) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return "0";
    return numberValue.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function requestCreditCost(options: { apiSource?: "system" | "custom"; modelPointCosts?: Record<string, number>; modelCosts?: ModelCreditCost[]; model: string; count?: string | number } & CreditCostOptions) {
    if (options.apiSource !== "system") return 0;
    const count = Math.max(1, Math.floor(Math.abs(Number(options.count)) || 1));
    const parameterMultiplier = generationParameterMultiplier(options);
    const cost = modelCreditCost(options.modelPointCosts || options.modelCosts, options.model) * count * parameterMultiplier;
    return Number.isFinite(cost) ? Number(Math.max(0, cost).toFixed(2)) : 0;
}

type CreditCostOptions = {
    generationPointMultipliers?: GenerationPointMultipliers;
    kind?: "image" | "video" | "text" | "audio" | "api";
    quality?: string;
    videoQuality?: string;
    videoSeconds?: string | number;
};

function generationParameterMultiplier(options: CreditCostOptions) {
    const multipliers = options.generationPointMultipliers;
    const kind = options.kind || (options.videoQuality !== undefined || options.videoSeconds !== undefined ? "video" : options.quality !== undefined ? "image" : undefined);
    if (!multipliers) return 1;
    if (kind === "image") return multiplierValue(multipliers.imageQuality, normalizeImageQualityKey(options.quality));
    if (kind === "video") {
        return multiplierValue(multipliers.videoQuality, normalizeVideoQualityKey(options.videoQuality)) * multiplierValue(multipliers.videoSeconds, normalizeVideoSecondsKey(options.videoSeconds));
    }
    return 1;
}

function multiplierValue(values: Record<string, number> | undefined, key: string) {
    const value = values?.[key];
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 1;
}

function normalizeImageQualityKey(value: unknown) {
    const key = String(value || "auto")
        .trim()
        .toLowerCase();
    if (key === "hd") return "high";
    if (key === "standard") return "medium";
    return key || "auto";
}

function normalizeVideoQualityKey(value: unknown) {
    const key = String(value || "720")
        .trim()
        .toLowerCase();
    if (key === "low") return "480";
    if (key === "auto" || key === "medium" || key === "high") return "720";
    return key.replace(/p$/, "") || "720";
}

function normalizeVideoSecondsKey(value: unknown) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return "5";
    return String(Math.max(-1, Math.floor(seconds)));
}
