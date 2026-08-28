"use client";

import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { isFullscreenWorkspacePath } from "@/components/layout/app-workspace-path";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { SiteLogo } from "@/components/layout/site-logo";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { defaultWorkspaceHref, navigationToolForPathname } from "@/constant/navigation-tools";
import type { VozebCmsModuleId } from "@/lib/vozeb-cms/module-contract";
import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

const PAGE_TITLES: Record<string, string> = {
    billing: "充值中心",
    help: "帮助中心",
    profile: "个人中心",
};

export function AppWorkspaceShell({ children, enabledModuleIds }: { children: ReactNode; enabledModuleIds?: readonly VozebCmsModuleId[] }) {
    const pathname = usePathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [sidebarExpanded, setSidebarExpanded] = useState(true);
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const siteTitle = resolveSiteTitle(site.title);
    const tool = navigationToolForPathname(pathname);
    const fullscreen = isFullscreenWorkspacePath(pathname);
    const rootSlug = pathname.split("/").filter(Boolean)[0] || "";
    const pageTitle = tool?.label || PAGE_TITLES[rootSlug] || "工作空间";
    const workspaceHref = defaultWorkspaceHref(enabledModuleIds);

    if (fullscreen) return <div className="h-dvh min-h-0 overflow-hidden">{children}</div>;

    return (
        <div className="workspace-shell flex h-dvh min-h-0 overflow-hidden bg-white text-foreground dark:bg-[#111316]">
            <AppSidebar activeToolSlug={tool?.slug} expanded={sidebarExpanded} enabledModuleIds={enabledModuleIds} />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[#eaecf0] bg-white/96 px-3 backdrop-blur-xl sm:px-4 lg:px-7 dark:border-[#292d33] dark:bg-[#111316]/95">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <button
                            type="button"
                            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 lg:hidden dark:text-stone-300 dark:hover:bg-stone-900 dark:hover:text-white"
                            onClick={() => setMobileNavOpen(true)}
                            aria-label="打开导航菜单"
                            title="导航菜单"
                        >
                            <Menu className="size-5" />
                        </button>
                        <Link href={workspaceHref} className="inline-flex shrink-0 items-center lg:hidden" aria-label={siteTitle}>
                            <SiteLogo logoUrl={site.logoUrl} className="size-6" />
                        </Link>
                        <button
                            type="button"
                            className="hidden size-8 shrink-0 items-center justify-center rounded-lg text-[#68717c] transition hover:bg-[#f1f3f5] hover:text-[#20242a] lg:inline-flex dark:text-[#a5adb8] dark:hover:bg-[#22262c] dark:hover:text-white"
                            onClick={() => setSidebarExpanded((value) => !value)}
                            aria-label={sidebarExpanded ? "收起侧边栏" : "展开侧边栏"}
                            title={sidebarExpanded ? "收起侧边栏" : "展开侧边栏"}
                            aria-pressed={sidebarExpanded}
                        >
                            {sidebarExpanded ? <PanelLeftClose className="size-[17px]" /> : <PanelLeftOpen className="size-[17px]" />}
                        </button>
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-[#20242a] dark:text-[#f3f5f7]">{pageTitle}</div>
                        </div>
                    </div>
                    <div className="min-w-0 max-w-[calc(100vw-6.5rem)] shrink-0 overflow-visible sm:max-w-[calc(100vw-8rem)] lg:max-w-none">
                        <UserStatusActions />
                    </div>
                </header>
                <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-white dark:bg-[#111316]">{children}</div>
            </div>
            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={tool?.slug} enabledModuleIds={enabledModuleIds} onClose={() => setMobileNavOpen(false)} />
        </div>
    );
}
