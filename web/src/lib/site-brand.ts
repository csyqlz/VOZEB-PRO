export const DEFAULT_SITE_TITLE = "VOZEB PRO";

export function resolveSiteTitle(value: unknown) {
    const title = typeof value === "string" ? value.trim() : "";
    return !title || title.toUpperCase() === "VOZEB" ? DEFAULT_SITE_TITLE : title;
}
