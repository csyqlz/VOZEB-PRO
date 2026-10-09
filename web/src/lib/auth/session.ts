import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { deleteSession, getPublicUsersByIds, getUserBySession, sessionMaxAgeSeconds, type AuthSettings, type PublicUser } from "./store";
import { authorizedWorkerUserId } from "@/lib/server/maintenance-auth";
import { getTrustedProxyHops } from "@/lib/server/trusted-proxy";
import { normalizeModelId } from "@/lib/model-capability";
import { parseSessionCookie } from "./store-normalizers";

const SESSION_COOKIE_NAME = "vozeb_pro_session";

type CurrentUser = PublicUser;

async function getSessionCookieValue() {
    const cookieStore = await cookies();
    return cookieStore.get(SESSION_COOKIE_NAME)?.value;
}

export async function getCurrentUser(request?: Request) {
    const sessionUser = await getUserBySession(await getSessionCookieValue());
    if (sessionUser || !request) return sessionUser;
    const workerUserId = authorizedWorkerUserId(request);
    if (!workerUserId) return null;
    const workerUser = (await getPublicUsersByIds([workerUserId]))[0];
    return workerUser?.status === "active" ? workerUser : null;
}

export async function clearCurrentSession() {
    await deleteSession(await getSessionCookieValue());
}

export async function getCurrentSessionId() {
    return parseSessionCookie(await getSessionCookieValue())?.id;
}

export function setSessionCookie(response: NextResponse, value: string, request?: Request) {
    response.cookies.set(SESSION_COOKIE_NAME, value, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureSessionCookie(request),
        maxAge: sessionMaxAgeSeconds(),
        path: "/",
    });
}

export function clearSessionCookie(response: NextResponse, request?: Request) {
    const secure = shouldUseSecureSessionCookie(request);
    response.cookies.set(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure,
        maxAge: 0,
        path: "/",
    });
}

function shouldUseSecureSessionCookie(request?: Request) {
    const override = process.env.VOZEB_PRO_COOKIE_SECURE?.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(override || "")) return true;
    if (["0", "false", "no", "off"].includes(override || "")) return false;

    if (getTrustedProxyHops() > 0) {
        const forwardedProto = request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
        if (forwardedProto) return forwardedProto === "https";

        const forwarded = request?.headers.get("forwarded") || "";
        const forwardedProtoMatch = forwarded.match(/(?:^|;|,)\s*proto=([^;,]+)/i);
        if (forwardedProtoMatch?.[1]) return forwardedProtoMatch[1].replace(/^"|"$/g, "").toLowerCase() === "https";
    }

    if (request?.url) {
        try {
            return new URL(request.url).protocol === "https:";
        } catch {
            return false;
        }
    }

    return false;
}

export function serializeCurrentUser(user: CurrentUser) {
    return {
        id: user.id,
        accountId: user.accountId,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        role: user.role,
        adminPermissions: [...user.adminPermissions],
        status: user.status,
        planId: user.planId,
        planName: user.planName,
        hasActivePlan: user.hasActivePlan,
        pointsBalance: user.pointsBalance,
        permanentPointsBalance: user.permanentPointsBalance,
        dailyPointsBalance: user.dailyPointsBalance,
        dailyPointsExpiresAt: user.dailyPointsExpiresAt,
        mfaEnabled: user.mfaEnabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
    };
}

export function serializePublicSettings(settings: AuthSettings) {
    return {
        site: {
            title: settings.site.title,
            logoUrl: settings.site.logoUrl,
            iconUrl: settings.site.iconUrl,
            seoDescription: settings.site.seoDescription,
            footerCopyright: settings.site.footerCopyright,
            termsUrl: settings.site.termsUrl,
            termsVersion: settings.site.termsVersion,
            privacyUrl: settings.site.privacyUrl,
            privacyVersion: settings.site.privacyVersion,
            friendLinks: settings.site.friendLinks.map((item) => ({ id: item.id, label: item.label, url: item.url, enabled: item.enabled })),
            socials: Object.fromEntries(Object.entries(settings.site.socials).map(([key, item]) => [key, { enabled: item.enabled, label: item.label, url: item.url }])),
        },
        registrationEnabled: settings.registrationEnabled,
        emailRegistrationEnabled: settings.emailRegistrationEnabled,
        modelPointCosts: { ...settings.modelPointCosts },
        generationPointMultipliers: {
            imageQuality: { ...settings.generationPointMultipliers.imageQuality },
            videoQuality: { ...settings.generationPointMultipliers.videoQuality },
            videoSeconds: { ...settings.generationPointMultipliers.videoSeconds },
        },
        generationConcurrency: { ...settings.generationConcurrency },
        generationDefaults: {
            canvasImageCount: settings.generationDefaults.canvasImageCount,
            imageSize: settings.generationDefaults.imageSize,
            imageQuality: settings.generationDefaults.imageQuality,
            imageCount: settings.generationDefaults.imageCount,
            videoQuality: settings.generationDefaults.videoQuality,
            videoSeconds: settings.generationDefaults.videoSeconds,
            audioVoice: settings.generationDefaults.audioVoice,
            audioFormat: settings.generationDefaults.audioFormat,
        },
        defaultModels: { ...settings.defaultModels },
        logicalModels: settings.logicalModels
            .filter((model) => model.enabled)
            .map((model) => ({
                id: model.id,
                name: model.name,
                capability: model.capability,
                enabled: true,
                bindings: model.bindings
                    .filter((binding) => binding.enabled)
                    .map((binding) => {
                        const capabilityProfile = publicCapabilityProfile(binding.capabilityProfile);
                        return {
                            id: binding.id,
                            channelId: binding.channelId,
                            upstreamModel: binding.upstreamModel,
                            enabled: true,
                            priority: binding.priority,
                            ...(capabilityProfile ? { capabilityProfile } : {}),
                        };
                    }),
            })),
        systemChannels: settings.systemChannels
            .filter((channel) => channel.enabled)
            .map((channel) => {
                const protocol = channel.advancedConfig?.protocol;
                const modelProtocols = Object.fromEntries(
                    channel.models.flatMap((model) => {
                        const key = normalizeModelId(model);
                        const modelProtocol = channel.advancedConfig?.modelConfigs?.[key]?.protocol || protocol;
                        return key && modelProtocol ? [[key, modelProtocol] as const] : [];
                    }),
                );
                return {
                    id: channel.id,
                    name: channel.name,
                    baseUrl: `/api/ai/system/${channel.id}`,
                    apiKey: "system",
                    apiFormat: channel.apiFormat,
                    models: channel.models,
                    enabled: channel.enabled,
                    hasApiKey: Boolean(channel.apiKey),
                    ...(protocol ? { protocol } : {}),
                    ...(Object.keys(modelProtocols).length ? { modelProtocols } : {}),
                };
            }),
    };
}

function publicCapabilityProfile(profile: AuthSettings["logicalModels"][number]["bindings"][number]["capabilityProfile"]) {
    if (!profile) return undefined;
    const result = {
        aspectRatios: profile.aspectRatios?.slice(),
        resolutions: profile.resolutions?.slice(),
        durationSeconds: profile.durationSeconds?.slice(),
        minDurationSeconds: profile.minDurationSeconds,
        maxDurationSeconds: profile.maxDurationSeconds,
        maxBatchSize: profile.maxBatchSize,
    };
    return Object.values(result).some((value) => value !== undefined && (!Array.isArray(value) || value.length)) ? result : undefined;
}
