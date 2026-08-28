export const VOZEB_THEME_FONTS = ["modern", "humanist", "editorial"] as const;
export const VOZEB_THEME_RADII = ["sharp", "soft", "round"] as const;
export const VOZEB_THEME_WIDTHS = ["compact", "wide", "full"] as const;
export const VOZEB_THEME_SPACING = ["compact", "comfortable", "airy"] as const;

export type VozebThemeTokens = {
    primary: string;
    background: string;
    surface: string;
    text: string;
    muted: string;
    font: (typeof VOZEB_THEME_FONTS)[number];
    radius: (typeof VOZEB_THEME_RADII)[number];
    contentWidth: (typeof VOZEB_THEME_WIDTHS)[number];
    spacing: (typeof VOZEB_THEME_SPACING)[number];
};

export type VozebThemeTemplateBlock = {
    componentId: string;
    region: string;
    props?: Readonly<Record<string, string | boolean>>;
};

export type VozebThemeTemplate = {
    id: string;
    name: string;
    description: string;
    path: string;
    regions: readonly { id: string; name: string; required: boolean }[];
    blocks: readonly VozebThemeTemplateBlock[];
};

export type VozebThemeManifest = {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    minAppVersion: string;
    tokens: VozebThemeTokens;
    templates: readonly VozebThemeTemplate[];
};

export type VozebThemeBundle = {
    manifest: VozebThemeManifest;
    runtimeClassName: string;
};

export function defineVozebTheme(input: VozebThemeManifest): VozebThemeManifest {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(input.id)) throw new Error(`主题 ID 无效：${input.id}`);
    if (!/^\d+\.\d+\.\d+$/.test(input.version) || !/^\d+\.\d+\.\d+$/.test(input.minAppVersion)) throw new Error(`主题版本无效：${input.id}`);
    if (!input.name.trim() || !input.author.trim() || !input.templates.length) throw new Error(`主题清单不完整：${input.id}`);
    const templateIds = new Set<string>();
    for (const template of input.templates) {
        if (!/^[a-z][a-z0-9-]{1,39}$/.test(template.id) || templateIds.has(template.id)) throw new Error(`主题模板 ID 无效或重复：${input.id}/${template.id}`);
        if (template.path !== "/") throw new Error(`主题模板路径未注册：${input.id}/${template.path}`);
        templateIds.add(template.id);
        const regions = new Set(template.regions.map((region) => region.id));
        if (!regions.has("main")) throw new Error(`主题模板缺少 main 区域：${input.id}/${template.id}`);
        for (const block of template.blocks) if (!regions.has(block.region)) throw new Error(`主题区块引用未知区域：${input.id}/${template.id}/${block.region}`);
    }
    return Object.freeze({ ...input, tokens: Object.freeze({ ...input.tokens }), templates: Object.freeze([...input.templates]) });
}

export function defineVozebThemeBundle(input: VozebThemeBundle): VozebThemeBundle {
    if (!input.runtimeClassName.trim()) throw new Error(`主题运行时样式无效：${input.manifest.id}`);
    return Object.freeze({ manifest: input.manifest, runtimeClassName: input.runtimeClassName });
}
