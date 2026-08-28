import type { VozebCmsLayoutNode } from "./layout-contract";
import { listVozebThemes } from "@/themes/registry";
import type { VozebThemeManifest } from "@/themes/theme-contract";

export type VozebCmsSiteBlockField = {
    key: string;
    label: string;
    type: "text" | "textarea" | "select" | "switch";
    placeholder?: string;
    options?: readonly { label: string; value: string }[];
};

export type VozebCmsLayoutComponent = {
    id: string;
    name: string;
    description: string;
    category: "structure" | "conversion" | "content" | "product" | "legacy";
    moduleId: string;
    actions: readonly string[];
    defaultProps: Readonly<Record<string, string | boolean>>;
    fields: readonly VozebCmsSiteBlockField[];
    siteBlock: boolean;
};

const linkField = (key: string, label: string): VozebCmsSiteBlockField => ({ key, label, type: "text", placeholder: "/create" });
const variantField: VozebCmsSiteBlockField = {
    key: "variant",
    label: "展示形式",
    type: "select",
    options: [
        { label: "主题标准区块", value: "standard" },
        { label: "初始安装首页区块", value: "installed" },
    ],
};

export const VOZEB_CMS_LAYOUT_COMPONENTS = [
    {
        id: "site.header",
        name: "全局页头",
        description: "品牌、导航和登录入口。",
        category: "structure",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { variant: "standard", brand: "VOZEB PRO", primaryLabel: "开始创作", primaryHref: "/create" },
        fields: [variantField, { key: "brand", label: "品牌文字", type: "text" }, { key: "primaryLabel", label: "主按钮", type: "text" }, linkField("primaryHref", "主按钮链接")],
        siteBlock: true,
    },
    {
        id: "site.hero",
        name: "主视觉 Hero",
        description: "首页核心价值与主行动入口。",
        category: "conversion",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: {
            eyebrow: "AI CREATIVE OPERATING SYSTEM",
            title: "从一个想法，到一部作品",
            description: "Agent、Canvas 与短剧生产流程在同一项目中协作。",
            primaryLabel: "开始创作",
            primaryHref: "/create",
            secondaryLabel: "浏览作品",
            secondaryHref: "/gallery",
        },
        fields: [
            { key: "eyebrow", label: "眉题", type: "text" },
            { key: "title", label: "主标题", type: "textarea" },
            { key: "description", label: "说明", type: "textarea" },
            { key: "primaryLabel", label: "主按钮", type: "text" },
            linkField("primaryHref", "主按钮链接"),
            { key: "secondaryLabel", label: "次按钮", type: "text" },
            linkField("secondaryHref", "次按钮链接"),
        ],
        siteBlock: true,
    },
    {
        id: "agent.entry",
        name: "Agent 创作入口",
        description: "把访客直接带入统一创作 Agent。",
        category: "product",
        moduleId: "create",
        actions: ["agent.run", "navigate"],
        defaultProps: { variant: "standard", title: "今天想创作什么？", description: "描述目标，VOZEB PRO 会规划模型、参数和生产步骤。", buttonLabel: "打开 Agent", href: "/create" },
        fields: [variantField, { key: "title", label: "标题", type: "text" }, { key: "description", label: "说明", type: "textarea" }, { key: "buttonLabel", label: "按钮", type: "text" }, linkField("href", "按钮链接")],
        siteBlock: true,
    },
    {
        id: "site.steps",
        name: "创作步骤",
        description: "初始安装首页的四步创作流程。",
        category: "content",
        moduleId: "platform",
        actions: [],
        defaultProps: { variant: "installed" },
        fields: [],
        siteBlock: true,
    },
    {
        id: "site.module-grid",
        name: "创作模块",
        description: "展示当前启用的核心创作模块。",
        category: "product",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { eyebrow: "WORKSPACES", title: "一套平台，贯通完整生产链路", description: "模块状态由后台实时控制，停用后入口与能力同时失效。" },
        fields: [
            { key: "eyebrow", label: "眉题", type: "text" },
            { key: "title", label: "标题", type: "text" },
            { key: "description", label: "说明", type: "textarea" },
        ],
        siteBlock: true,
    },
    {
        id: "site.feature-grid",
        name: "平台优势",
        description: "以三项核心卖点说明平台价值。",
        category: "content",
        moduleId: "platform",
        actions: [],
        defaultProps: { variant: "standard", title: "不是工具拼盘，而是一条生产线", item1: "项目上下文贯通", item2: "任务与资产可追踪", item3: "商业权限可治理" },
        fields: [variantField, { key: "title", label: "标题", type: "text" }, { key: "item1", label: "卖点一", type: "text" }, { key: "item2", label: "卖点二", type: "text" }, { key: "item3", label: "卖点三", type: "text" }],
        siteBlock: true,
    },
    {
        id: "site.gallery",
        name: "作品展示",
        description: "读取真实作品广场内容。",
        category: "content",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { variant: "standard", eyebrow: "COMMUNITY", title: "正在发生的创作", description: "展示公开审核通过的真实作品。", href: "/gallery" },
        fields: [variantField, { key: "eyebrow", label: "眉题", type: "text" }, { key: "title", label: "标题", type: "text" }, { key: "description", label: "说明", type: "textarea" }, linkField("href", "更多作品链接")],
        siteBlock: true,
    },
    {
        id: "site.pricing",
        name: "套餐入口",
        description: "说明商业套餐价值并进入真实套餐页。",
        category: "conversion",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { eyebrow: "PLANS", title: "按创作节奏选择能力", description: "套餐能力、模块权限和积分消耗保持一致。", buttonLabel: "查看套餐", href: "/billing" },
        fields: [{ key: "eyebrow", label: "眉题", type: "text" }, { key: "title", label: "标题", type: "text" }, { key: "description", label: "说明", type: "textarea" }, { key: "buttonLabel", label: "按钮", type: "text" }, linkField("href", "按钮链接")],
        siteBlock: true,
    },
    {
        id: "site.announcement",
        name: "公告横幅",
        description: "突出版本、活动或服务通知。",
        category: "content",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { label: "最新动态", title: "VOZEB PRO v0.0.8 平台化升级", linkLabel: "查看公告", href: "/announcements" },
        fields: [{ key: "label", label: "标签", type: "text" }, { key: "title", label: "内容", type: "text" }, { key: "linkLabel", label: "链接文字", type: "text" }, linkField("href", "链接地址")],
        siteBlock: true,
    },
    {
        id: "site.cta",
        name: "行动号召",
        description: "页面末段的强转化入口。",
        category: "conversion",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { variant: "standard", title: "把下一部作品，放进同一个创作系统", description: "从需求、生成、审核到资产交付，保持上下文不断线。", buttonLabel: "免费开始", href: "/create" },
        fields: [variantField, { key: "title", label: "标题", type: "textarea" }, { key: "description", label: "说明", type: "textarea" }, { key: "buttonLabel", label: "按钮", type: "text" }, linkField("href", "按钮链接")],
        siteBlock: true,
    },
    {
        id: "site.footer",
        name: "全局页脚",
        description: "品牌说明和站点导航。",
        category: "structure",
        moduleId: "platform",
        actions: ["navigate"],
        defaultProps: { variant: "standard", brand: "VOZEB PRO", description: "以项目为中心的 AI 创作平台。", copyright: "VOZEB PRO" },
        fields: [variantField, { key: "brand", label: "品牌文字", type: "text" }, { key: "description", label: "说明", type: "textarea" }, { key: "copyright", label: "版权文字", type: "text" }],
        siteBlock: true,
    },
    { id: "module.header", name: "模块标题", description: "兼容旧布局。", category: "legacy", moduleId: "platform", actions: [], defaultProps: {}, fields: [], siteBlock: false },
    { id: "module.summary", name: "模块摘要", description: "兼容旧布局。", category: "legacy", moduleId: "platform", actions: ["navigate"], defaultProps: {}, fields: [], siteBlock: false },
    { id: "canvas.workspace", name: "Canvas 工作区", description: "兼容旧布局。", category: "legacy", moduleId: "canvas", actions: ["navigate"], defaultProps: {}, fields: [], siteBlock: false },
    { id: "drama.workspace", name: "短剧工作区", description: "兼容旧布局。", category: "legacy", moduleId: "drama", actions: ["navigate", "workflow.start"], defaultProps: {}, fields: [], siteBlock: false },
    { id: "media.generator", name: "媒体生成器", description: "兼容旧布局。", category: "legacy", moduleId: "platform", actions: ["image.generate", "video.generate"], defaultProps: {}, fields: [], siteBlock: false },
    { id: "task.board", name: "任务状态板", description: "兼容旧布局。", category: "legacy", moduleId: "platform", actions: ["task.open"], defaultProps: {}, fields: [], siteBlock: false },
    { id: "asset.library", name: "资产库", description: "兼容旧布局。", category: "legacy", moduleId: "platform", actions: ["asset.open"], defaultProps: {}, fields: [], siteBlock: false },
] as const satisfies readonly VozebCmsLayoutComponent[];

const componentById = new Map<string, VozebCmsLayoutComponent>(VOZEB_CMS_LAYOUT_COMPONENTS.map((component) => [component.id, component]));

for (const theme of listVozebThemes()) validateVozebThemeBlocks(theme);

export function getVozebCmsLayoutComponent(componentId: string) {
    return componentById.get(componentId);
}

export function listVozebCmsSiteBlocks() {
    return VOZEB_CMS_LAYOUT_COMPONENTS.filter((component) => component.siteBlock);
}

export function validateVozebThemeBlocks(theme: VozebThemeManifest) {
    for (const template of theme.templates) {
        for (const block of template.blocks) {
            const component = componentById.get(block.componentId);
            if (!component?.siteBlock) throw new Error(`主题模板引用未注册站点区块：${theme.id}/${template.id}/${block.componentId}`);
        }
    }
}

export function normalizeVozebCmsBlockProps(componentId: string, value: unknown) {
    const component = getVozebCmsLayoutComponent(componentId);
    const input = record(value);
    if (!component?.siteBlock) return input;
    const result: Record<string, string | boolean> = { ...component.defaultProps };
    for (const field of component.fields) {
        const raw = input[field.key];
        if (field.type === "switch") result[field.key] = raw === true;
        else if (typeof raw === "string") result[field.key] = field.key.toLowerCase().includes("href") ? safeInternalHref(raw) : raw.trim().slice(0, field.type === "textarea" ? 600 : 180);
    }
    return result;
}

export function createDefaultVozebCmsHomepageNodes(): VozebCmsLayoutNode[] {
    const blocks = listVozebThemes()[0].templates[0].blocks;
    return blocks.map((block, index) => ({
        id: `home-block-${index + 1}`,
        componentId: block.componentId,
        region: block.region,
        props: normalizeVozebCmsBlockProps(block.componentId, block.props || {}),
        actions: [...(getVozebCmsLayoutComponent(block.componentId)?.actions || [])],
    }));
}

function safeInternalHref(value: string) {
    const href = value.trim().slice(0, 240);
    if (!href) return "#";
    if (/^\/(?!\/)[a-z0-9/_#?&=.%+-]*$/i.test(href) || /^#[a-z0-9_-]+$/i.test(href)) return href;
    throw new Error(`站点区块链接无效：${href}`);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
