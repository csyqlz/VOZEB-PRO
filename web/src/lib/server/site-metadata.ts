import { unstable_cache, revalidateTag } from "next/cache";

import { DEFAULT_SITE_SETTINGS, getAuthSettings, type SiteSettings } from "@/lib/auth/store";

export const SITE_SETTINGS_CACHE_TAG = "vozeb-site-settings";

const readCachedSiteSettings = unstable_cache(
    async (): Promise<SiteSettings> => {
        try {
            return (await getAuthSettings()).site;
        } catch {
            return DEFAULT_SITE_SETTINGS;
        }
    },
    [SITE_SETTINGS_CACHE_TAG],
    { revalidate: 60, tags: [SITE_SETTINGS_CACHE_TAG] },
);

export function getPublicSiteSettings() {
    return readCachedSiteSettings();
}

export function invalidatePublicSiteSettings() {
    try {
        revalidateTag(SITE_SETTINGS_CACHE_TAG, "max");
    } catch {}
}

export function siteMetadataBase() {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
    try {
        return new URL(siteUrl);
    } catch {
        return new URL("http://localhost:3000");
    }
}

export function absoluteSiteUrl(value: string, base = siteMetadataBase()) {
    try {
        return new URL(value, base).toString();
    } catch {
        return value;
    }
}

export function browserIconHref(site: Pick<SiteSettings, "iconUrl" | "logoUrl">) {
    const iconUrl = site.iconUrl.trim();
    const logoUrl = site.logoUrl.trim();
    const directIconUrl = iconUrl === "/favicon.ico" || iconUrl === "/api/site-icon" || iconUrl === "/icon.svg" ? "" : iconUrl;
    if (directIconUrl && (directIconUrl !== DEFAULT_SITE_SETTINGS.iconUrl || logoUrl === DEFAULT_SITE_SETTINGS.logoUrl)) return directIconUrl;
    return logoUrl || directIconUrl || DEFAULT_SITE_SETTINGS.iconUrl;
}
