export function resolveImageTaskOptions(config: { quality?: unknown; size?: unknown; outputBackground?: unknown; outputMode?: unknown }, defaults: { imageQuality: string; imageSize: string }) {
    return {
        quality: text(config.quality) || defaults.imageQuality,
        size: text(config.size) || defaults.imageSize,
        ...(config.outputBackground === "transparent" ? { outputBackground: "transparent" as const } : {}),
        ...(config.outputMode === "layers" ? { outputMode: "layers" as const } : {}),
    };
}

export function resolveImageGenerationCount(value: unknown) {
    const count = Number(value);
    return Math.max(1, Number.isSafeInteger(count) && count > 0 ? Math.floor(count) : 1);
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
