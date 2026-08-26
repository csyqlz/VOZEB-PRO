import { BookMarked, Clapperboard, Compass, FileText, GalleryVerticalEnd, Images, Maximize2, Sparkles, UserRound } from "lucide-react";

export const navigationGroups = [
    { id: "create", label: "创作" },
    { id: "projects", label: "项目" },
    { id: "assets", label: "资产" },
    { id: "community", label: "社区" },
] as const;

export const landingNavigationTools = [
    { slug: "create", label: "智能创作" },
    { slug: "drama", label: "短剧" },
    { slug: "gallery", label: "作品广场" },
] as const;

export const navigationTools = [
    {
        slug: "create",
        label: "智能创作",
        description: "从想法到成品的创作入口",
        group: "create",
        icon: Sparkles,
        primary: true,
    },
    {
        slug: "canvas",
        label: "画布",
        description: "节点式多媒体创作",
        group: "projects",
        icon: Maximize2,
    },
    {
        slug: "drama",
        label: "短剧",
        description: "剧本、分镜与成片",
        group: "projects",
        icon: Clapperboard,
    },
    {
        slug: "works",
        label: "我的作品",
        description: "管理发布、审核与分享",
        group: "assets",
        icon: GalleryVerticalEnd,
    },
    {
        slug: "assets",
        label: "素材",
        description: "图片、视频与音频",
        group: "assets",
        icon: Images,
    },
    {
        slug: "my-prompts",
        label: "我的模板",
        description: "保存常用创作模板",
        group: "assets",
        icon: BookMarked,
    },
    {
        slug: "prompts",
        label: "灵感模板",
        description: "浏览公开创作模板",
        group: "assets",
        icon: FileText,
    },
    {
        slug: "community",
        label: "灵感广场",
        description: "发现公开作品",
        group: "community",
        icon: Compass,
    },
    {
        slug: "me",
        label: "主页",
        description: "已发布与我的喜欢",
        group: "community",
        icon: UserRound,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
export type NavigationGroupId = (typeof navigationGroups)[number]["id"];

export function navigationToolForPathname(pathname: string) {
    const slug = pathname.split("/").filter(Boolean)[0];
    return navigationTools.find((tool) => tool.slug === slug);
}
