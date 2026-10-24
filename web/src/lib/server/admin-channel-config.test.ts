import { describe, expect, it } from "vitest";

import type { AuthSettings, SystemModelChannel } from "@/lib/auth/store";
import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import {
    isProviderTimeoutError,
    isUsableAdminChannelApiKey,
    mergeSystemChannelSecrets,
    resolveAdminChannelCredentials,
    sanitizeProviderMessage,
    serializeAdminSettings,
    serializeAdminSettingsForUser,
    systemChannelWebhookSecretValidationError,
} from "./admin-channel-config";

const savedChannel = {
    id: "saved",
    name: "已保存",
    baseUrl: "https://api.example.com/v1",
    apiKey: "secret-value",
    webhookSecret: "0123456789abcdef0123456789abcdef",
    apiFormat: "openai",
    models: ["gpt-test"],
    enabled: true,
} satisfies SystemModelChannel;
const settings = { systemChannels: [savedChannel] } as AuthSettings;

describe("admin channel config", () => {
    it("serializes only secret presence for the admin client", () => {
        const result = serializeAdminSettings(settings).systemChannels[0];
        expect(result.apiKey).toBe("");
        expect(result.hasApiKey).toBe(true);
        expect(result.webhookSecret).toBe("");
        expect(result.hasWebhookSecret).toBe(true);
        expect(JSON.stringify(result)).not.toContain("secret-value");
        expect(JSON.stringify(result)).not.toContain(savedChannel.webhookSecret);
    });

    it("limits full settings to the administrator's duties", () => {
        const fullSettings: AuthSettings = {
            ...structuredClone(DEFAULT_SETTINGS),
            mail: { ...DEFAULT_SETTINGS.mail, host: "smtp.internal", password: "mail-secret" },
            dataLifecycle: { ...DEFAULT_SETTINGS.dataLifecycle, maintenanceBatchSize: 81 },
            generationCostControl: { maxPointsPerTask: 9, dailyUserPointSpend: 90, dailyTotalPointSpend: 900 },
            systemChannels: [
                {
                    ...savedChannel,
                    advancedConfig: {
                        protocol: "openai",
                        authMode: "bearer",
                        textModel: "",
                        imageModel: "",
                        videoModel: "",
                        createPath: "",
                        editPath: "",
                        imageToVideoPath: "",
                        queryPath: "",
                        requestTemplate: "",
                        resultField: "",
                        statusField: "",
                        durationRange: "",
                        referenceRule: "",
                        supportsReferenceImage: false,
                        supportsReferenceVideo: false,
                        supportsReferenceAudio: false,
                    },
                },
            ],
            agentSkills: [{ id: "private-skill", name: "内部 Skill", description: "内部", instructions: "内部规则", keywords: [], workspaces: ["image"], enabled: true }],
        };

        const systemView = serializeAdminSettingsForUser(fullSettings, { role: "admin", status: "active", adminPermissions: ["system.manage"] });
        expect(systemView.mail.password).toBe("mail-secret");
        expect(systemView.dataLifecycle.maintenanceBatchSize).toBe(81);
        expect(systemView.systemChannels[0]).toMatchObject({ id: "saved", baseUrl: "", apiKey: "" });
        expect(systemView.systemChannels[0].advancedConfig).toBeUndefined();
        expect(systemView.agentSkills).toEqual([]);
        expect(systemView.generationCostControl).toEqual(DEFAULT_SETTINGS.generationCostControl);

        const upstreamView = serializeAdminSettingsForUser(fullSettings, { role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        expect(upstreamView.mail).toEqual(DEFAULT_SETTINGS.mail);
        expect(upstreamView.dataLifecycle).toEqual(DEFAULT_SETTINGS.dataLifecycle);
        expect(upstreamView.systemChannels[0]).toMatchObject({ id: "saved", baseUrl: savedChannel.baseUrl, apiKey: "", hasApiKey: true });
        expect(upstreamView.systemChannels[0].advancedConfig).toMatchObject({ protocol: "openai" });
        expect(upstreamView.agentSkills).toHaveLength(1);
        expect(upstreamView.generationCostControl.maxPointsPerTask).toBe(9);
    });

    it("keeps, replaces, and explicitly clears saved API keys", () => {
        const base = { ...savedChannel, apiKey: "" };
        expect(mergeSystemChannelSecrets([base], [savedChannel])[0].apiKey).toBe("secret-value");
        expect(mergeSystemChannelSecrets([{ ...base, apiKey: "new-secret" }], [savedChannel])[0].apiKey).toBe("new-secret");
        expect(mergeSystemChannelSecrets([{ ...base, clearApiKey: true }], [savedChannel])[0].apiKey).toBe("");
    });

    it("invalidates a DataEyes provider snapshot when an administrator rotates its key", () => {
        const existing = { ...savedChannel, baseUrl: "https://studio.dataeyes.ai", advancedConfig: { ...emptyAdvancedConfig(), providerModels: ["current"] } };
        const edited = { ...existing, apiKey: "new-secret" };
        expect(mergeSystemChannelSecrets([edited], [existing])[0].advancedConfig?.providerModels).toEqual([]);
        expect(mergeSystemChannelSecrets([{ ...edited, apiKey: "" }], [existing])[0].advancedConfig?.providerModels).toEqual(["current"]);
    });

    it("keeps, replaces, validates, and explicitly clears channel webhook secrets", () => {
        const base = { ...savedChannel, webhookSecret: "" };
        expect(mergeSystemChannelSecrets([base], [savedChannel])[0].webhookSecret).toBe(savedChannel.webhookSecret);
        expect(mergeSystemChannelSecrets([{ ...base, webhookSecret: "a".repeat(32) }], [savedChannel])[0].webhookSecret).toBe("a".repeat(32));
        expect(mergeSystemChannelSecrets([{ ...base, webhookSecret: "short" }], [savedChannel])[0].webhookSecret).toBe("short");
        expect(mergeSystemChannelSecrets([{ ...base, clearWebhookSecret: true }], [savedChannel])[0].webhookSecret).toBe("");
        expect(systemChannelWebhookSecretValidationError({ ...base, webhookSecret: "short" })).toContain("至少需要 32 个字符");
    });

    it("resolves saved credentials when the client sends only a channel id", () => {
        expect(resolveAdminChannelCredentials(settings, { channelId: "saved" })).toMatchObject({ baseUrl: savedChannel.baseUrl, apiKey: savedChannel.apiKey, apiFormat: "openai" });
    });

    it("never treats stored ciphertext as a usable provider credential", () => {
        const ciphertext = "vozeb-pro-secret:v1:iv.tag.payload";
        const encryptedSettings = { systemChannels: [{ ...savedChannel, apiKey: ciphertext }] } as AuthSettings;

        expect(isUsableAdminChannelApiKey(ciphertext)).toBe(false);
        expect(serializeAdminSettings(encryptedSettings).systemChannels[0]).toMatchObject({ apiKey: "", hasApiKey: false, webhookSecret: "", hasWebhookSecret: true });
        expect(resolveAdminChannelCredentials(encryptedSettings, { channelId: "saved", apiKey: ciphertext }).apiKey).toBe("");
        expect(mergeSystemChannelSecrets([{ ...savedChannel, apiKey: ciphertext }], encryptedSettings.systemChannels)[0].apiKey).toBe("");
    });

    it("redacts common provider secret formats", () => {
        const message = sanitizeProviderMessage("Authorization: Bearer token-value https://x.test?api_key=secret-value token-example-123", ["token-value", "secret-value", "token-example-123"]);
        expect(message).not.toContain("token-value");
        expect(message).not.toContain("secret-value");
        expect(message).not.toContain("token-example-123");
    });

    it("recognizes abort and timeout errors", () => {
        expect(isProviderTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
        expect(isProviderTimeoutError(new DOMException("timed out", "TimeoutError"))).toBe(true);
        expect(isProviderTimeoutError(new Error("network failed"))).toBe(false);
    });
});
