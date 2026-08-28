import { getVozebTemplate, listVozebThemes, resolveVozebTheme } from "@/themes/registry";
import { VOZEB_THEME_FONTS, VOZEB_THEME_RADII, VOZEB_THEME_SPACING, VOZEB_THEME_WIDTHS, type VozebThemeTokens } from "@/themes/theme-contract";

export const VOZEB_SITE_PATHS = ["/"] as const;
export type VozebSitePath = (typeof VOZEB_SITE_PATHS)[number];

export type VozebCmsSiteTarget = {
    kind: "page" | "template-part";
    path: VozebSitePath;
    title: string;
    description: string;
};

export const VOZEB_SITE_THEME_FONTS = VOZEB_THEME_FONTS;
export const VOZEB_SITE_THEME_RADII = VOZEB_THEME_RADII;
export const VOZEB_SITE_THEME_WIDTHS = VOZEB_THEME_WIDTHS;
export const VOZEB_SITE_THEME_SPACING = VOZEB_THEME_SPACING;
export type VozebCmsSiteThemeTokens = VozebThemeTokens;

export type VozebCmsSiteTheme = {
    presetId: string;
    templateId: string;
    tokens: VozebCmsSiteThemeTokens;
};

export const VOZEB_SITE_THEME_PRESETS = listVozebThemes();

export const DEFAULT_VOZEB_SITE_THEME: VozebCmsSiteTheme = {
    presetId: VOZEB_SITE_THEME_PRESETS[0].id,
    templateId: VOZEB_SITE_THEME_PRESETS[0].templates[0].id,
    tokens: { ...VOZEB_SITE_THEME_PRESETS[0].tokens },
};

export function normalizeVozebCmsSiteTarget(value: unknown): VozebCmsSiteTarget | undefined {
    if (!isRecord(value)) return undefined;
    const path = text(value.path, 120);
    if (!VOZEB_SITE_PATHS.includes(path as VozebSitePath)) throw new Error(`站点页面路径未注册：${path || "空"}`);
    const kind = value.kind === "template-part" ? "template-part" : "page";
    return {
        kind,
        path: path as VozebSitePath,
        title: text(value.title, 160) || "首页",
        description: text(value.description, 320),
    };
}

export function normalizeVozebCmsSiteTheme(value: unknown): VozebCmsSiteTheme {
    const input = isRecord(value) ? value : {};
    const presetId = text(input.presetId, 40);
    const preset = resolveVozebTheme(presetId);
    const templateId = text(input.templateId, 40);
    const template = getVozebTemplate(templateId)?.template || VOZEB_SITE_THEME_PRESETS[0].templates[0];
    const rawTokens = isRecord(input.tokens) ? input.tokens : {};
    return {
        presetId: preset.id,
        templateId: template.id,
        tokens: {
            primary: color(rawTokens.primary, preset.tokens.primary),
            background: color(rawTokens.background, preset.tokens.background),
            surface: color(rawTokens.surface, preset.tokens.surface),
            text: color(rawTokens.text, preset.tokens.text),
            muted: color(rawTokens.muted, preset.tokens.muted),
            font: enumValue(rawTokens.font, VOZEB_SITE_THEME_FONTS, preset.tokens.font),
            radius: enumValue(rawTokens.radius, VOZEB_SITE_THEME_RADII, preset.tokens.radius),
            contentWidth: enumValue(rawTokens.contentWidth, VOZEB_SITE_THEME_WIDTHS, preset.tokens.contentWidth),
            spacing: enumValue(rawTokens.spacing, VOZEB_SITE_THEME_SPACING, preset.tokens.spacing),
        },
    };
}

export function applyVozebCmsSiteThemePreset(current: VozebCmsSiteTheme, presetId: string): VozebCmsSiteTheme {
    const preset = VOZEB_SITE_THEME_PRESETS.find((item) => item.id === presetId);
    return preset ? { presetId: preset.id, templateId: current.templateId, tokens: { ...preset.tokens } } : current;
}

function color(value: unknown, fallback: string) {
    const result = text(value, 9);
    if (!result) return fallback;
    if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(result)) throw new Error(`站点主题颜色无效：${result}`);
    return result.toLowerCase();
}

function enumValue<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
    return options.includes(value as T) ? (value as T) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
