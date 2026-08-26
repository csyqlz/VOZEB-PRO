type PublicModelCapability = "image" | "video" | "text" | "audio";

const PUBLIC_MODEL_ALIASES: Record<string, string> = {
    "image-2": "gpt-image-2",
};

// This upstream identifier currently returns `not found`; keeping it out of
// the consumer catalog prevents failed generations from being created.
const PUBLIC_MODEL_EXCLUSIONS = new Set(["gpt-image-2-4k"]);

function dedupePublicModelIds(ids: string[]) {
    const available = new Set(ids.map((id) => id.trim().toLowerCase()));
    const seen = new Set<string>();
    return ids.reduce<string[]>((result, id) => {
        const key = id.trim().toLowerCase();
        if (PUBLIC_MODEL_EXCLUSIONS.has(key)) return result;
        const canonical = PUBLIC_MODEL_ALIASES[key];
        const resolved = canonical && available.has(canonical) ? canonical : id;
        const resolvedKey = resolved.trim().toLowerCase();
        if (!resolvedKey || seen.has(resolvedKey)) return result;
        seen.add(resolvedKey);
        result.push(resolved);
        return result;
    }, []);
}

export function resolvePublicCapabilityModels(logicalModels: Array<{ id: string; capability: PublicModelCapability }>, fallback: Record<PublicModelCapability, string[]>) {
    return Object.fromEntries(
        (Object.keys(fallback) as PublicModelCapability[]).map((capability) => {
            const logical = logicalModels.filter((model) => model.capability === capability).map((model) => model.id);
            return [capability, dedupePublicModelIds(logical.length ? logical : fallback[capability])];
        }),
    ) as Record<PublicModelCapability, string[]>;
}

export function flattenPublicCapabilityModels(models: Record<PublicModelCapability, string[]>) {
    return Array.from(new Set([models.image, models.video, models.text, models.audio].flat()));
}
