import { DEFAULT_VOZEB_THEME_ID, getVozebThemeBundle, listVozebThemeBundles } from "./registry";

export function getVozebThemeRuntimeClassName(themeId: string | undefined) {
    return ((themeId && getVozebThemeBundle(themeId)) || getVozebThemeBundle(DEFAULT_VOZEB_THEME_ID))?.runtimeClassName || "";
}

export function validateVozebThemeRuntimes() {
    for (const bundle of listVozebThemeBundles()) if (!bundle.runtimeClassName.trim()) throw new Error(`主题运行时未注册样式：${bundle.manifest.id}`);
}

validateVozebThemeRuntimes();
