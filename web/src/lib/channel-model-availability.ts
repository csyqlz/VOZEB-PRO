import type { SystemModelChannel } from "@/lib/auth/store-types";
import { normalizeModelId } from "@/lib/model-capability";

type CatalogChannel = Pick<SystemModelChannel, "baseUrl" | "models" | "advancedConfig">;

export function isDataEyesCatalogUrl(baseUrl: string) {
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase();
        return hostname === "dataeyes.ai" || hostname.endsWith(".dataeyes.ai");
    } catch {
        return false;
    }
}

export function currentChannelModels(channel: CatalogChannel) {
    if (!isDataEyesCatalogUrl(channel.baseUrl) || !Array.isArray(channel.advancedConfig?.providerModels)) return channel.models;
    const available = new Set(channel.advancedConfig.providerModels.map(normalizeModelId));
    return channel.models.filter((model) => available.has(normalizeModelId(model)));
}
