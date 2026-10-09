import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./store-foundation";
import { normalizeSettings } from "./store-normalizers";
import type { AuthSettings } from "./store-types";
import { serializePublicSettings, setSessionCookie } from "./session";

afterEach(() => {
    delete process.env.VOZEB_PRO_COOKIE_SECURE;
    delete process.env.VOZEB_PRO_TRUSTED_PROXY_HOPS;
    delete process.env.VOZEB_PRO_DEEPSEEK_API_KEY;
    delete process.env.VOZEB_PRO_DEEPSEEK_TEXT_MODEL;
    delete process.env.VOZEB_PRO_DEEPSEEK_BASE_URL;
    delete process.env.VOZEB_PRO_SILICONFLOW_API_KEY;
    delete process.env.VOZEB_PRO_SILICONFLOW_BASE_URL;
    delete process.env.VOZEB_PRO_SILICONFLOW_IMAGE_MODEL;
});

describe("serializePublicSettings", () => {
    it("only exposes the browser settings allowlist", () => {
        const settings: AuthSettings = structuredClone(DEFAULT_SETTINGS);
        settings.mail = { ...settings.mail, host: "smtp.internal", username: "mail-user", password: "mail-secret" };
        settings.allowUserApiConfig = true;
        settings.freeDailyPointsEnabled = true;
        settings.freeDailyPoints = 99;
        settings.agentSkills = [
            {
                id: "secret-skill",
                name: "内部 Skill",
                description: "内部说明",
                instructions: "不得进入公开会话的完整指令",
                enabled: true,
                keywords: ["内部"],
            },
        ];
        settings.systemChannels = [
            {
                id: "channel-one",
                name: "渠道一",
                baseUrl: "https://internal-provider.example/v1",
                apiKey: "provider-secret",
                apiFormat: "openai",
                models: ["vendor-image"],
                enabled: true,
                advancedConfig: {
                    protocol: "custom",
                    authHeader: "X-Secret-Key",
                    authPrefix: "Private ",
                    textModel: "",
                    imageModel: "vendor-image",
                    videoModel: "",
                    createPath: "/private/create",
                    queryPath: "/private/query/:id",
                    requestTemplate: '{"secret":true}',
                    resultField: "private.result",
                    statusField: "private.status",
                    durationRange: "",
                    referenceRule: "",
                    supportsReferenceImage: true,
                    supportsReferenceVideo: false,
                    supportsReferenceAudio: false,
                    modelCatalogPaths: ["/private/models"],
                },
            },
        ];
        settings.logicalModels = [
            {
                id: "image-main",
                name: "图片模型",
                capability: "image",
                enabled: true,
                bindings: [
                    {
                        id: "binding-one",
                        channelId: "channel-one",
                        upstreamModel: "vendor-image",
                        enabled: true,
                        priority: 1,
                        weight: 8,
                        capabilityProfile: { unitCost: 3, unitCostCurrency: "USD", timeoutMs: 60_000 },
                    },
                ],
            },
        ];
        settings.site.socials = {
            email: { enabled: true, label: "邮箱", url: "mailto:owner@example.com" },
            telegram: { enabled: true, label: "Telegram", url: "https://t.me/vozeb_group" },
            x: { enabled: true, label: "X", url: "https://x.com/vozeb_pro" },
            instagram: { enabled: true, label: "Instagram", url: "https://instagram.com/vozeb.pro" },
        };

        const result = serializePublicSettings(settings);
        const serialized = JSON.stringify(result);

        expect(result.systemChannels).toEqual([
            {
                id: "channel-one",
                name: "渠道一",
                baseUrl: "/api/ai/system/channel-one",
                apiKey: "system",
                apiFormat: "openai",
                models: ["vendor-image"],
                enabled: true,
                hasApiKey: true,
            },
        ]);
        expect(result.logicalModels[0]?.bindings[0]).toEqual({ id: "binding-one", channelId: "channel-one", upstreamModel: "vendor-image", enabled: true, priority: 1 });
        expect(serialized).not.toContain("provider-secret");
        expect(serialized).not.toContain("internal-provider.example");
        expect(serialized).not.toContain("smtp.internal");
        expect(serialized).not.toContain("mail-secret");
        expect(serialized).not.toContain("private/create");
        expect(serialized).not.toContain("完整指令");
        expect(result).not.toHaveProperty("mail");
        expect(result).not.toHaveProperty("agentSkills");
        expect(result).not.toHaveProperty("entitlements");
        expect(result).not.toHaveProperty("allowUserApiConfig");
        expect(result).not.toHaveProperty("freeDailyPoints");
        expect(result.site).not.toHaveProperty("homeShowcaseMode");
        expect(result.site).not.toHaveProperty("homeShowcaseItems");
        expect(result.site.socials).toEqual(settings.site.socials);
    });

    it("does not expose an environment-provided DeepSeek default text API key", () => {
        vi.stubEnv("VOZEB_PRO_DEEPSEEK_API_KEY", "test-deepseek-secret");
        const settings = normalizeSettings(structuredClone(DEFAULT_SETTINGS));

        const result = serializePublicSettings(settings);
        const serialized = JSON.stringify(result);

        expect(result.defaultModels.textModel).toBe("deepseek-default-text");
        expect(result.systemChannels).toEqual([
            expect.objectContaining({
                id: "deepseek-env",
                baseUrl: "/api/ai/system/deepseek-env",
                apiKey: "system",
                hasApiKey: true,
            }),
        ]);
        expect(serialized).not.toContain("test-deepseek-secret");
        expect(serialized).not.toContain("api.deepseek.com");
    });

    it("does not expose an environment-provided SiliconFlow default image API key", () => {
        vi.stubEnv("VOZEB_PRO_SILICONFLOW_API_KEY", "test-siliconflow-secret");
        const settings = normalizeSettings(structuredClone(DEFAULT_SETTINGS));

        const result = serializePublicSettings(settings);
        const serialized = JSON.stringify(result);

        expect(result.defaultModels.imageModel).toBe("siliconflow-default-image");
        expect(result.logicalModels).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "siliconflow-default-image",
                capability: "image",
                bindings: [expect.objectContaining({ channelId: "siliconflow-env", upstreamModel: "Kwai-Kolors/Kolors" })],
            }),
            expect.objectContaining({
                id: "siliconflow-qwen-image",
                capability: "image",
                bindings: [expect.objectContaining({ channelId: "siliconflow-env", upstreamModel: "Qwen/Qwen-Image" })],
            }),
            expect.objectContaining({
                id: "siliconflow-qwen-image-edit",
                capability: "image",
                bindings: [expect.objectContaining({ channelId: "siliconflow-env", upstreamModel: "Qwen/Qwen-Image-Edit" })],
            }),
        ]));
        expect(result.systemChannels).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "siliconflow-env",
                baseUrl: "/api/ai/system/siliconflow-env",
                apiKey: "system",
                hasApiKey: true,
                models: ["Kwai-Kolors/Kolors", "Qwen/Qwen-Image", "Qwen/Qwen-Image-Edit"],
            }),
        ]));
        expect(serialized).not.toContain("test-siliconflow-secret");
        expect(serialized).not.toContain("api.siliconflow.cn");
    });
});

describe("session cookie security", () => {
    it("ignores forwarded protocol headers unless proxy trust is configured", () => {
        const response = NextResponse.json({ ok: true });
        setSessionCookie(response, "session", new Request("http://localhost", { headers: { "x-forwarded-proto": "https" } }));

        expect(response.headers.get("set-cookie")).not.toContain("Secure");
    });

    it("uses Secure behind a configured HTTPS reverse proxy", () => {
        process.env.VOZEB_PRO_TRUSTED_PROXY_HOPS = "1";
        const response = NextResponse.json({ ok: true });
        setSessionCookie(response, "session", new Request("http://localhost", { headers: { "x-forwarded-proto": "https" } }));

        expect(response.headers.get("set-cookie")).toContain("Secure");
    });

    it("uses Secure for direct HTTPS requests", () => {
        const response = NextResponse.json({ ok: true });
        setSessionCookie(response, "session", new Request("https://example.test/login"));

        expect(response.headers.get("set-cookie")).toContain("Secure");
    });
});
