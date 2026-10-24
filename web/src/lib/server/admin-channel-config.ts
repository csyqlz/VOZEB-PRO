import type { ApiCallFormat, AuthSettings, SystemModelChannel } from "@/lib/auth/store";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";
import { isEncryptedSecretValue } from "@/lib/server/secret-crypto";

type ChannelCredentialInput = {
    channelId?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    apiFormat?: unknown;
};

export function serializeAdminSettings(settings: AuthSettings): AuthSettings {
    return {
        ...settings,
        systemChannels: settings.systemChannels.map((channel) => {
            const serialized = channelWithoutSecretControls(channel);
            return {
                ...serialized,
                apiKey: "",
                webhookSecret: "",
                hasApiKey: isUsableAdminChannelApiKey(channel.apiKey),
                hasWebhookSecret: isUsableAdminChannelWebhookSecret(channel.webhookSecret),
            };
        }),
    };
}

export function serializeAdminSettingsForUser(settings: AuthSettings, user: { role?: unknown; status?: unknown; adminPermissions?: unknown }): AuthSettings {
    const serialized = serializeAdminSettings(settings);
    if (!hasAdminPermission(user, "system.manage")) {
        serialized.mail = { ...DEFAULT_SETTINGS.mail };
        serialized.dataLifecycle = { ...DEFAULT_SETTINGS.dataLifecycle };
    }
    if (!hasAdminPermission(user, "upstream.manage")) {
        serialized.generationCostControl = { ...DEFAULT_SETTINGS.generationCostControl };
        serialized.agentSkills = [];
        serialized.systemChannels = serialized.systemChannels.map(channelSummaryWithoutConfiguration);
    }
    return serialized;
}

export function mergeSystemChannelSecrets(channels: SystemModelChannel[], savedChannels: SystemModelChannel[]) {
    const savedById = new Map(savedChannels.map((channel) => [channel.id, channel]));
    return channels.map((channel) => {
        const saved = savedById.get(channel.id);
        const submittedWebhookSecret = plainSecret(channel.webhookSecret);
        const merged = channelWithoutSecretControls(channel);
        const apiKey = channel.clearApiKey ? "" : usableApiKey(channel.apiKey) || usableApiKey(saved?.apiKey);
        const credentialsChanged = saved && (channel.baseUrl.trim() !== saved.baseUrl.trim() || apiKey !== usableApiKey(saved.apiKey));
        return {
            ...merged,
            ...(credentialsChanged && merged.advancedConfig?.providerModels ? { advancedConfig: { ...merged.advancedConfig, providerModels: [] } } : {}),
            apiKey,
            webhookSecret: channel.clearWebhookSecret ? "" : submittedWebhookSecret || usableWebhookSecret(saved?.webhookSecret),
        };
    });
}

export function systemChannelWebhookSecretValidationError(channel: SystemModelChannel) {
    const secret = plainSecret(channel.webhookSecret);
    if (!secret) return "";
    if (secret.length < 32) return `渠道“${channel.name || channel.id}”的生成回调密钥至少需要 32 个字符`;
    if (secret.length > 4_000) return `渠道“${channel.name || channel.id}”的生成回调密钥不能超过 4000 个字符`;
    return "";
}

export function resolveAdminChannelCredentials(settings: AuthSettings, input: ChannelCredentialInput) {
    const channelId = text(input.channelId);
    const savedChannel = settings.systemChannels.find((channel) => channel.id === channelId);
    const apiFormat: ApiCallFormat = input.apiFormat === "gemini" || input.apiFormat === "openai" ? input.apiFormat : savedChannel?.apiFormat === "gemini" ? "gemini" : "openai";
    return {
        channelId,
        savedChannel,
        baseUrl: text(input.baseUrl) || savedChannel?.baseUrl.trim() || "",
        apiKey: usableApiKey(input.apiKey) || usableApiKey(savedChannel?.apiKey),
        apiFormat,
    };
}

export function isUsableAdminChannelApiKey(value: unknown) {
    const apiKey = text(value);
    return Boolean(apiKey) && !isEncryptedSecretValue(apiKey);
}

export function isUsableAdminChannelWebhookSecret(value: unknown) {
    const secret = text(value);
    return secret.length >= 32 && !isEncryptedSecretValue(secret);
}

export function sanitizeProviderMessage(value: unknown, secrets: string[] = []) {
    let message = typeof value === "string" ? value : value instanceof Error ? value.message : "";
    for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[REDACTED]");
    return message
        .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
        .replace(/\bsk-[a-z0-9_-]{8,}/gi, "[REDACTED]")
        .replace(/([?&](?:api[_-]?key|key|token)=)[^&#\s]+/gi, "$1[REDACTED]")
        .slice(0, 500);
}

export function isProviderTimeoutError(error: unknown) {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function usableApiKey(value: unknown) {
    const apiKey = text(value);
    return isUsableAdminChannelApiKey(apiKey) ? apiKey : "";
}

function usableWebhookSecret(value: unknown) {
    return isUsableAdminChannelWebhookSecret(value) ? text(value) : "";
}

function plainSecret(value: unknown) {
    const secret = text(value);
    return secret && !isEncryptedSecretValue(secret) ? secret : "";
}

function channelWithoutSecretControls(channel: SystemModelChannel) {
    const result = { ...channel };
    delete result.hasApiKey;
    delete result.clearApiKey;
    delete result.hasWebhookSecret;
    delete result.clearWebhookSecret;
    return result;
}

function channelSummaryWithoutConfiguration(channel: SystemModelChannel): SystemModelChannel {
    return {
        id: channel.id,
        name: channel.name,
        baseUrl: "",
        apiKey: "",
        apiFormat: channel.apiFormat,
        models: [...channel.models],
        enabled: channel.enabled,
    };
}
