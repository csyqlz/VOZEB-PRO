import { defineVozebTheme } from "../theme-contract";

export const vozebThemeManifest = defineVozebTheme({
    id: "vozeb",
    name: "VOZEB 紫蓝",
    version: "1.0.0",
    author: "VOZEB PRO",
    description: "VOZEB PRO 原生紫蓝品牌主题，沿用当前公开首页的光晕、渐变与创作平台气质。",
    minAppVersion: "0.0.8",
    tokens: { primary: "#665cf6", background: "#f9fbff", surface: "#ffffff", text: "#10182f", muted: "#65708a", font: "modern", radius: "soft", contentWidth: "wide", spacing: "comfortable" },
    templates: [
        {
            id: "creative-home",
            name: "VOZEB PRO 默认首页",
            description: "沿用当前紫蓝首页的品牌视觉与信息结构，包含创作入口、生产流程、作品、平台优势与行动入口。",
            path: "/",
            regions: [
                { id: "header", name: "页头", required: true },
                { id: "main", name: "主内容", required: true },
                { id: "footer", name: "页脚", required: true },
            ],
            blocks: [
                { componentId: "site.header", region: "header", props: { variant: "installed" } },
                { componentId: "agent.entry", region: "main", props: { variant: "installed" } },
                { componentId: "site.steps", region: "main", props: { variant: "installed" } },
                { componentId: "site.gallery", region: "main", props: { variant: "installed" } },
                { componentId: "site.feature-grid", region: "main", props: { variant: "installed" } },
                { componentId: "site.cta", region: "main", props: { variant: "installed" } },
                { componentId: "site.footer", region: "footer", props: { variant: "installed" } },
            ],
        },
    ],
});
