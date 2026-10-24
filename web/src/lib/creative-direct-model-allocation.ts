import type { CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";

type DirectModel = { id: string; capability: "text" | "image" | "video" | "audio"; capabilityProfile?: { maxBatchSize?: number } };

export function allocateDirectCreativeModels<T extends DirectModel>(models: readonly T[], preferences?: CreativeGenerationPreferences) {
    const counts = new Map<string, number>();
    for (const capability of ["image", "video", "audio"] as const) {
        const peers = models.filter((model) => model.capability === capability);
        if (!peers.length) continue;
        const requested = capability === "image" ? preferences?.image?.count : capability === "video" ? preferences?.video?.count : undefined;
        let remaining = Math.max(requested || peers.length, peers.length) - peers.length;
        peers.forEach((model) => counts.set(model.id, 1));
        while (remaining > 0) {
            const available = peers.filter((model) => !model.capabilityProfile?.maxBatchSize || (counts.get(model.id) || 0) < model.capabilityProfile.maxBatchSize);
            if (!available.length) throw new Error("所选模型无法承载当前生成总数，请减少数量或调整模型");
            const share = Math.max(1, Math.floor(remaining / available.length));
            for (const model of available) {
                if (!remaining) break;
                const current = counts.get(model.id) || 0;
                const capacity = model.capabilityProfile?.maxBatchSize ? model.capabilityProfile.maxBatchSize - current : remaining;
                const added = Math.min(share, capacity, remaining);
                counts.set(model.id, current + added);
                remaining -= added;
            }
        }
    }
    return models.map((model) => ({ model, count: counts.get(model.id) || 1 }));
}
