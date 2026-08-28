import type { VozebThemeBundle } from "./theme-contract";
import { vozebThemeBundle } from "./vozeb";

const themeBundles = [vozebThemeBundle] as const satisfies readonly VozebThemeBundle[];
const bundleByThemeId = new Map(themeBundles.map((bundle) => [bundle.manifest.id, bundle]));
const templateEntries = themeBundles.flatMap((bundle) => bundle.manifest.templates.map((template) => [template.id, { theme: bundle.manifest, template }] as const));
const templateById = new Map(templateEntries);

if (bundleByThemeId.size !== themeBundles.length) throw new Error("主题注册表存在重复 ID");
if (templateById.size !== templateEntries.length) throw new Error("页面模板注册表存在重复 ID");

export const DEFAULT_VOZEB_THEME_ID = vozebThemeBundle.manifest.id;
export const DEFAULT_VOZEB_TEMPLATE_ID = vozebThemeBundle.manifest.templates[0].id;

export function listVozebThemeBundles() {
    return [...themeBundles];
}

export function listVozebThemes() {
    return themeBundles.map((bundle) => bundle.manifest);
}

export function getVozebThemeBundle(themeId: string) {
    return bundleByThemeId.get(themeId);
}

export function getVozebTheme(themeId: string) {
    return getVozebThemeBundle(themeId)?.manifest;
}

export function resolveVozebTheme(themeId: string | undefined) {
    return (themeId && getVozebTheme(themeId)) || vozebThemeBundle.manifest;
}

export function getVozebThemeTemplate(themeId: string, templateId: string) {
    return getVozebTheme(themeId)?.templates.find((template) => template.id === templateId);
}

export function getVozebTemplate(templateId: string) {
    return templateById.get(templateId);
}
