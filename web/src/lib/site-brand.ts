export const DEFAULT_SITE_TITLE = "星启智域";
export const BRAND_ENGLISH_NAME = "XINGQI ZHIYU";
export const DEFAULT_SUPPORT_EMAIL = "service@xingqizhiyu.cn";

export function resolveSiteTitle(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SITE_TITLE;
}
