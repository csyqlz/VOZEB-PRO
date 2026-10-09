import type { LogicalModelCapability, SystemDefaultModels, SystemModelChannel } from "@/lib/auth/store";
import { channelDetectedCapabilities, normalizeDefaultModelsConfig } from "@/lib/model-routing-config";
import { channelProtocolDefinition } from "@/lib/channel-protocol-registry";
import type { EcommerceModelRoles } from "@/lib/auth/store";
import { normalizeEcommerceModelRoles } from "@/lib/ecommerce-model-role-config";

export type ChannelWorkspaceSettings = {
    systemChannels: SystemModelChannel[];
    logicalModels: import("@/lib/auth/store").LogicalModel[];
    defaultModels: SystemDefaultModels;
    ecommerceGenerationEnabled?: boolean;
    ecommerceVisualQualityCheckEnabled?: boolean;
    ecommerceModelRoles?: EcommerceModelRoles;
};

export type ChannelWorkspaceStatus = "enabled" | "draft" | "disabled";

const capabilityLabels: Record<LogicalModelCapability, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

export function channelWorkspaceStatus(channel: SystemModelChannel): ChannelWorkspaceStatus {
    if (channel.enabled) return "enabled";
    return channel.baseUrl.trim() ? "disabled" : "draft";
}

export function channelWorkspaceStatusLabel(status: ChannelWorkspaceStatus) {
    return { enabled: "已启用", draft: "草稿", disabled: "已停用" }[status];
}

export function channelWorkspaceStatusColor(status: ChannelWorkspaceStatus) {
    return { enabled: "success", draft: "default", disabled: "default" }[status];
}

export function channelCapabilityLabels(channel: SystemModelChannel) {
    return Array.from(channelDetectedCapabilities(channel)).map((capability) => capabilityLabels[capability]);
}

export function channelProtocolLabel(channel: SystemModelChannel) {
    return channelProtocolDefinition(channel.advancedConfig?.protocol || "auto").label;
}

export function removeChannelFromWorkspace(settings: ChannelWorkspaceSettings, channelId: string): ChannelWorkspaceSettings {
    const systemChannels = settings.systemChannels.filter((channel) => channel.id !== channelId);
    const logicalModels = settings.logicalModels.map((model) => ({ ...model, bindings: model.bindings.filter((binding) => binding.channelId !== channelId) })).filter((model) => model.bindings.length);
    const liveIds = new Set(logicalModels.map((model) => model.id));
    return {
        systemChannels,
        logicalModels,
        defaultModels: Object.fromEntries(Object.entries(settings.defaultModels).map(([key, value]) => [key, liveIds.has(value) ? value : ""])) as SystemDefaultModels,
        ...(settings.ecommerceGenerationEnabled !== undefined ? { ecommerceGenerationEnabled: settings.ecommerceGenerationEnabled } : {}),
        ...(settings.ecommerceVisualQualityCheckEnabled !== undefined ? { ecommerceVisualQualityCheckEnabled: settings.ecommerceVisualQualityCheckEnabled } : {}),
        ...(settings.ecommerceModelRoles ? { ecommerceModelRoles: normalizeEcommerceModelRoles(settings.ecommerceModelRoles, logicalModels) } : {}),
    };
}

export function updateChannelInWorkspace(settings: ChannelWorkspaceSettings, channelId: string, patch: Partial<SystemModelChannel>): ChannelWorkspaceSettings {
    const systemChannels = settings.systemChannels.map((channel) => (channel.id === channelId ? { ...channel, ...patch } : channel));
    return {
        ...settings,
        systemChannels,
        defaultModels: normalizeDefaultModelsConfig(settings.defaultModels, settings.logicalModels, systemChannels),
    };
}

export function defaultModelField(capability: LogicalModelCapability): keyof SystemDefaultModels {
    return capability === "text" ? "textModel" : capability === "image" ? "imageModel" : capability === "video" ? "videoModel" : "audioModel";
}

export function channelBindingCount(channelId: string, settings: ChannelWorkspaceSettings) {
    return settings.logicalModels.reduce((count, model) => count + model.bindings.filter((binding) => binding.channelId === channelId).length, 0);
}

export function channelSearchText(channel: SystemModelChannel) {
    return `${channel.name} ${channel.baseUrl} ${channelProtocolLabel(channel)} ${channel.models.join(" ")}`.toLowerCase();
}
