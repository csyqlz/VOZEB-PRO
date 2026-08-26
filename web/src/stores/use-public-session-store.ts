"use client";

import { create } from "zustand";

import { resolveSiteTitle } from "@/lib/site-brand";
import type { LocalUser } from "@/stores/use-user-store";
import type { PublicSystemSettings } from "@/stores/use-config-store";

export type PublicSiteSettings = {
    title: string;
    logoUrl: string;
    iconUrl?: string;
    seoDescription?: string;
    footerCopyright?: string;
    termsUrl?: string;
    termsVersion?: string;
    privacyUrl?: string;
    privacyVersion?: string;
    friendLinks?: Array<{ id: string; label: string; url: string; enabled: boolean }>;
    socials?: Record<string, { enabled: boolean; label: string; url: string }>;
};

type PublicSessionPayload = {
    user?: LocalUser | null;
    install?: { firstAdminRequired?: boolean; database?: { healthy?: boolean } };
    settings?: PublicSystemSettings & { site?: PublicSiteSettings };
};

type PublicSessionStore = {
    payload: PublicSessionPayload | null;
    ready: boolean;
};

export const usePublicSessionStore = create<PublicSessionStore>(() => ({ payload: null, ready: false }));

export const PUBLIC_SETTINGS_CHANGED_EVENT = "vozeb-pro-public-settings-changed";
export const PUBLIC_SETTINGS_CHANGED_STORAGE_KEY = "vozeb-pro-public-settings-changed-at";
const SESSION_CACHE_TTL_MS = 30_000;
let sessionRequest: Promise<PublicSessionPayload> | null = null;
let sessionLoadedAt = 0;
let sessionRequestVersion = 0;

export function loadPublicSession({ force = false }: { force?: boolean } = {}) {
    const cached = usePublicSessionStore.getState().payload;
    if (!force && sessionRequest) return sessionRequest;
    if (!force && cached && Date.now() - sessionLoadedAt < SESSION_CACHE_TTL_MS) return Promise.resolve(cached);

    const requestVersion = ++sessionRequestVersion;
    const request = fetch("/api/auth/session", { cache: "no-store" })
        .then(async (response) => {
            if (!response.ok) throw new Error("会话加载失败");
            return (await response.json()) as PublicSessionPayload;
        })
        .then((payload) => {
            if (requestVersion === sessionRequestVersion) {
                sessionLoadedAt = Date.now();
                usePublicSessionStore.setState({ payload, ready: true });
            }
            return payload;
        })
        .catch((error) => {
            if (requestVersion === sessionRequestVersion) usePublicSessionStore.setState({ payload: cached, ready: true });
            throw error;
        })
        .finally(() => {
            if (sessionRequest === request) sessionRequest = null;
        });
    sessionRequest = request;
    return request;
}

export function notifyPublicSettingsChanged() {
    sessionLoadedAt = 0;
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(PUBLIC_SETTINGS_CHANGED_EVENT));
        try {
            window.localStorage.setItem(PUBLIC_SETTINGS_CHANGED_STORAGE_KEY, String(Date.now()));
        } catch {
            // Storage can be unavailable in restricted browser contexts; same-tab refresh still works above.
        }
    }
}

export function applyPublicSiteSettings(site: PublicSiteSettings) {
    usePublicSessionStore.setState((state) => {
        const payload = state.payload || {};
        return {
            payload: {
                ...payload,
                settings: {
                    ...(payload.settings || {}),
                    site: {
                        ...(payload.settings?.site || {}),
                        ...site,
                        title: resolveSiteTitle(site.title),
                        logoUrl: site.logoUrl?.trim() || "/logo.svg",
                    },
                },
            },
        };
    });
}

export function resetPublicSession() {
    sessionRequestVersion += 1;
    sessionRequest = null;
    sessionLoadedAt = 0;
    usePublicSessionStore.setState({ payload: null, ready: false });
}
