import type { AuthSettings, SiteFriendLink, SiteSocialSettings } from "@/lib/auth/store-types";
import type { CreateAgentMode } from "@/lib/create-agent-prompt";
import { WORK_CATEGORIES } from "@/lib/work-publication-options";
import type { PublicGalleryItem } from "@/services/api/work-governance";

export type HomeSiteSettings = {
    title: string;
    logoUrl: string;
    seoDescription: string;
    footerCopyright: string;
    termsUrl: string;
    privacyUrl: string;
    friendLinks: SiteFriendLink[];
    socials: SiteSocialSettings;
};

export type HomeNavigationItem = {
    label: string;
    href: string;
    action: "link" | "protected" | "billing";
};

export const HOME_NAVIGATION = [
    { label: "智能创作", href: "/create", action: "protected" },
    { label: "短剧制作", href: "/drama", action: "protected" },
    { label: "作品广场", href: "/gallery", action: "link" },
    { label: "价格方案", href: "/billing", action: "billing" },
] as const satisfies readonly HomeNavigationItem[];

export const HOME_CREATION_MODES = [
    {
        id: "agent",
        label: "智能模式",
        icon: "agent",
        examples: ["生成一张科幻城市概念图", "制作一段产品宣传视频", "为电商产品生成详情页", "创作一个短剧分镜脚本"],
    },
    {
        id: "image",
        label: "AI 绘图",
        icon: "image",
        examples: ["生成电影感的未来城市概念图", "为美妆新品制作竖版宣传海报", "为电商产品生成详情页", "把参考图改成清透夏日广告"],
    },
    {
        id: "video",
        label: "AI 视频",
        icon: "video",
        examples: ["制作一段 10 秒新品发布短片", "生成竖屏咖啡品牌氛围广告", "让镜头缓慢向前推进", "制作一段产品功能演示视频"],
    },
    {
        id: "audio",
        label: "AI 音频",
        icon: "audio",
        examples: ["生成温暖自然的品牌介绍旁白", "制作沉稳的发布会开场音频", "将文案转换为轻快女声配音", "为短片生成自然男声旁白"],
    },
] as const;

export type HomeCreationMode = CreateAgentMode;

export function resolveHomeCreationModes(settings: Pick<AuthSettings, "logicalModels" | "defaultModels">): HomeCreationMode[] {
    const configured = settings.logicalModels
        .filter((model) => model.enabled && model.bindings.some((binding) => binding.enabled))
        .map((model) => model.capability)
        .filter((capability, index, values) => values.indexOf(capability) === index)
        .filter((capability): capability is Exclude<HomeCreationMode, "agent"> => capability === "image" || capability === "video" || capability === "audio");
    if (configured.length) return configured;
    return (["image", "video", "audio"] as const).filter((capability) => Boolean(settings.defaultModels[`${capability}Model` as "imageModel" | "videoModel" | "audioModel"]));
}

/** The intelligent entry needs a text model for planning and conversation. */
export function resolveHomeAgentAvailability(settings: Pick<AuthSettings, "logicalModels" | "defaultModels">) {
    const configured = settings.logicalModels.filter((model) => model.enabled && model.bindings.some((binding) => binding.enabled));
    if (configured.length) return configured.some((model) => model.capability === "text");
    return Boolean(settings.defaultModels.textModel);
}

export const HOME_STEPS = [
    { number: "01", title: "选择场景", description: "选择合适的创作场景，明确创作类型", icon: "grid" },
    { number: "02", title: "输入需求", description: "描述你的想法，上传必要的参考素材", icon: "edit" },
    { number: "03", title: "生成内容", description: "AI 多模态生成高质量创作内容", icon: "rocket" },
    { number: "04", title: "发布与分享", description: "一键发布并分享创作成果", icon: "share" },
] as const;

export const HOME_ADVANTAGES = [
    { title: "多场景创作", description: "覆盖常用图片、视频与智能创作需求", icon: "layers" },
    { title: "自动匹配能力", description: "根据目标选择合适的创作方式", icon: "network" },
    { title: "进度清晰可查", description: "生成进度和失败状态一目了然", icon: "history" },
    { title: "作品随时可续", description: "保存创作记录，换设备也能继续", icon: "cloud" },
] as const;

export const HOME_GALLERY_TABS = [{ id: "all", label: "全部" }, ...WORK_CATEGORIES.map((category) => ({ id: category, label: category }))] as const;

export type HomeGalleryTab = "all" | (typeof WORK_CATEGORIES)[number];

export function homeGalleryMatches(item: PublicGalleryItem, tab: HomeGalleryTab) {
    const mediaType = item.preview?.mediaType;
    if (mediaType !== "image" && mediaType !== "video") return false;
    return tab === "all" || item.category === tab;
}

export function homeGalleryTypeLabel(item: PublicGalleryItem) {
    return item.category;
}
