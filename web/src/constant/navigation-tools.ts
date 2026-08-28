import { BookMarked, Clapperboard, Compass, FileText, GalleryVerticalEnd, Images, Maximize2, Sparkles, UserRound } from "lucide-react";

import type { VozebCmsModuleId } from "@/lib/vozeb-cms/module-contract";

export const navigationGroups = [
    { id: "create", label: "创作" },
    { id: "projects", label: "项目" },
    { id: "assets", label: "资产" },
    { id: "community", label: "社区" },
] as const;

export const landingNavigationTools = [
    { slug: "create", label: "Agent" },
    { slug: "drama", label: "短剧" },
    { slug: "gallery", label: "广场" },
] as const;

export const navigationTools = [
    {
        slug: "create",
        label: "Agent",
        description: "统一创作入口",
        group: "create",
        icon: Sparkles,
        primary: true,
        moduleId: "create",
    },
    {
        slug: "canvas",
        label: "画布",
        description: "节点式多媒体创作",
        group: "projects",
        icon: Maximize2,
        moduleId: "canvas",
    },
    {
        slug: "drama",
        label: "短剧",
        description: "剧本、分镜与成片",
        group: "projects",
        icon: Clapperboard,
        moduleId: "drama",
    },
    {
        slug: "works",
        label: "作品",
        description: "发布、审核与分享",
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
        label: "提示词",
        description: "个人提示词",
        group: "assets",
        icon: BookMarked,
    },
    {
        slug: "prompts",
        label: "词库",
        description: "公共提示词",
        group: "assets",
        icon: FileText,
    },
    {
        slug: "community",
        label: "广场",
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

export function navigationGroupsForModules(enabledModuleIds?: readonly VozebCmsModuleId[]) {
    return navigationGroups
        .map((group) => ({
            ...group,
            tools: navigationTools.filter((tool) => tool.group === group.id && (!("moduleId" in tool) || !enabledModuleIds || enabledModuleIds.includes(tool.moduleId))),
        }))
        .filter((group) => group.tools.length);
}

export function defaultWorkspaceHref(enabledModuleIds?: readonly VozebCmsModuleId[]) {
    const visibleTools = navigationGroupsForModules(enabledModuleIds).flatMap((group) => group.tools);
    const preferredSlugs: readonly NavigationToolSlug[] = ["create", "canvas", "drama", "assets"];
    const preferredTool = preferredSlugs.map((slug) => visibleTools.find((tool) => tool.slug === slug)).find(Boolean);
    return preferredTool ? `/${preferredTool.slug}` : "/";
}

export function navigationToolForPathname(pathname: string) {
    const slug = pathname.split("/").filter(Boolean)[0];
    return navigationTools.find((tool) => tool.slug === slug);
}
