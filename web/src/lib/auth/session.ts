import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

import { deleteSession, getPublicUsersByIds, getUserBySession, sessionMaxAgeSeconds, type AuthSettings, type PublicUser } from "./store";
import { authorizedWorkerUserId } from "@/lib/server/maintenance-auth";
import { getTrustedProxyHops } from "@/lib/server/trusted-proxy";
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

export function serializePublicSiteSettings(site: AuthSettings["site"]) {
    return {
        title: site.title,
        logoUrl: site.logoUrl,
        iconUrl: site.iconUrl,
        seoDescription: site.seoDescription,
        footerCopyright: site.footerCopyright,
        termsUrl: site.termsUrl,
        termsVersion: site.termsVersion,
        privacyUrl: site.privacyUrl,
        privacyVersion: site.privacyVersion,
        friendLinks: site.friendLinks.map((item) => ({ id: item.id, label: item.label, url: item.url, enabled: item.enabled })),
        socials: Object.fromEntries(Object.entries(site.socials).map(([key, item]) => [key, { enabled: item.enabled, label: item.label, url: item.url }])),
    };
}

export function serializePublicSettings(settings: AuthSettings) {
    return {
        site: serializePublicSiteSettings(settings.site),
        registrationEnabled: settings.registrationEnabled,
        emailRegistrationEnabled: settings.emailRegistrationEnabled,
        modelPointCosts: publicModelPointCosts(settings),
        generationPointMultipliers: {
            imageQuality: { ...settings.generationPointMultipliers.imageQuality },
            videoQuality: { ...settings.generationPointMultipliers.videoQuality },
            videoSeconds: { ...settings.generationPointMultipliers.videoSeconds },
        },
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
                ...(publicLogicalModelCapabilityProfile(model.bindings) ? { capabilityProfile: publicLogicalModelCapabilityProfile(model.bindings) } : {}),
            })),
    };
}

function publicLogicalModelCapabilityProfile(bindings: AuthSettings["logicalModels"][number]["bindings"]) {
    const profiles = bindings.filter((binding) => binding.enabled && binding.capabilityProfile).map((binding) => binding.capabilityProfile!);
    if (!profiles.length) return undefined;
    const aspectRatios = uniqueTextValues(profiles.flatMap((profile) => profile.aspectRatios || []));
    const resolutions = uniqueTextValues(profiles.flatMap((profile) => profile.resolutions || []));
    const durationSeconds = Array.from(new Set(profiles.flatMap((profile) => profile.durationSeconds || []))).sort((left, right) => left - right);
    const minDurationSeconds = minimumFinite(profiles.map((profile) => profile.minDurationSeconds));
    const maxDurationSeconds = maximumFinite(profiles.map((profile) => profile.maxDurationSeconds));
    const maxBatchSize = maximumFinite(profiles.map((profile) => profile.maxBatchSize));
    const result = {
        ...(aspectRatios.length ? { aspectRatios } : {}),
        ...(resolutions.length ? { resolutions } : {}),
        ...(durationSeconds.length ? { durationSeconds } : {}),
        ...(minDurationSeconds !== undefined ? { minDurationSeconds } : {}),
        ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
        ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
    };
    return Object.keys(result).length ? result : undefined;
}

function uniqueTextValues(values: string[]) {
    const entries = values.map((value) => [value.trim().toLowerCase(), value.trim()] as const).filter(([key]) => Boolean(key));
    return Array.from(new Map(entries).values());
}

function minimumFinite(values: Array<number | undefined>) {
    const configured = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return configured.length ? Math.min(...configured) : undefined;
}

function maximumFinite(values: Array<number | undefined>) {
    const configured = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return configured.length ? Math.max(...configured) : undefined;
}

function publicModelPointCosts(settings: AuthSettings) {
    const costs: Record<string, number> = {};
    const configured = settings.modelPointCosts || {};
    for (const model of settings.logicalModels) {
        const direct = configuredCost(configured, model.id);
        if (direct !== undefined) {
            costs[model.id] = direct;
            continue;
        }
        const alias = model.bindings
            .filter((binding) => binding.enabled)
            .sort((left, right) => left.priority - right.priority)
            .map((binding) => configuredCost(configured, binding.upstreamModel))
            .find((value): value is number => value !== undefined);
        if (alias !== undefined) costs[model.id] = alias;
    }
    const fallback = configuredCost(configured, "__default__");
    if (fallback !== undefined) costs.__default__ = fallback;
    return costs;
}

function configuredCost(costs: Record<string, number>, key: string) {
    const match = Object.keys(costs).find((candidate) => candidate.trim().toLowerCase() === key.trim().toLowerCase());
    if (!match) return undefined;
    const value = Number(costs[match]);
    return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : undefined;
}
