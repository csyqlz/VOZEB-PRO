"use client";

import { ChevronRight, CircleHelp } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { SiteLogo } from "@/components/layout/site-logo";
import { defaultWorkspaceHref, navigationGroupsForModules, type NavigationToolSlug } from "@/constant/navigation-tools";
import type { VozebCmsModuleId } from "@/lib/vozeb-cms/module-contract";
import { cn } from "@/lib/utils";
import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

export function AppSidebar({ activeToolSlug, expanded, enabledModuleIds }: { activeToolSlug?: NavigationToolSlug; expanded: boolean; enabledModuleIds?: readonly VozebCmsModuleId[] }) {
    const pathname = usePathname();
    const router = useRouter();
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const siteTitle = resolveSiteTitle(site.title);
    const helpActive = pathname.startsWith("/help");
    const navigationGroups = navigationGroupsForModules(enabledModuleIds);
    const workspaceHref = defaultWorkspaceHref(enabledModuleIds);

    return (
        <aside className={cn("hidden h-full shrink-0 flex-col border-r border-[#eaecf0] bg-white text-[#111827] transition-[width] duration-200 lg:flex dark:border-[#292d33] dark:bg-[#111316] dark:text-[#f3f5f7]", expanded ? "w-44" : "w-[72px]")}>
            <Link href={workspaceHref} className={cn("flex h-16 shrink-0 items-center border-b border-[#eaecf0] px-3 dark:border-[#292d33]", expanded ? "justify-start px-5" : "justify-center")} aria-label={siteTitle}>
                <SiteLogo logoUrl={site.logoUrl} className="size-8" />
                {expanded ? <span className="ml-3 min-w-0 truncate text-[15px] font-semibold">{siteTitle}</span> : null}
            </Link>

            <nav className={cn("hide-scrollbar min-h-0 flex-1 overflow-y-auto py-5", expanded ? "px-3" : "px-2")} aria-label="工作空间导航">
                {navigationGroups.map((group, groupIndex) => {
                    const tools = group.tools;
                    return (
                        <div key={group.id} className={cn(groupIndex > 0 && "mt-[22px]")}>
                            {expanded ? <div className="mb-1.5 px-2 text-xs font-normal text-[#98a2b3] dark:text-[#737d89]">{group.label}</div> : null}
                            <div className="space-y-1">
                                {tools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    const primary = "primary" in tool && tool.primary;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            href={`/${tool.slug}`}
                                            prefetch
                                            title={tool.label}
                                            onMouseEnter={() => router.prefetch(`/${tool.slug}`)}
                                            onFocus={() => router.prefetch(`/${tool.slug}`)}
                                            className={cn(
                                                "group relative flex h-[42px] items-center rounded-lg px-2 text-sm font-medium transition-colors duration-150",
                                                expanded ? "justify-start gap-3 px-3" : "justify-center",
                                                active
                                                    ? "bg-[#f5f4ff] text-[#111827] dark:bg-[#26243a] dark:text-[#f3f5f7]"
                                                    : primary
                                                      ? "text-[#111827] hover:bg-[#f8f9fb] dark:text-[#d4d9df] dark:hover:bg-[#20242a]"
                                                      : "text-[#111827] hover:bg-[#f8f9fb] dark:text-[#c7cdd5] dark:hover:bg-[#20242a] dark:hover:text-[#f3f5f7]",
                                            )}
                                            aria-current={active ? "page" : undefined}
                                        >
                                            <Icon className={cn("size-[18px] shrink-0", active && "text-[#5965ff]")} />
                                            {expanded ? <span className="min-w-0 truncate">{tool.label}</span> : null}
                                            {active ? <span className="absolute right-2.5 h-[18px] w-0.5 rounded-full bg-[#5965ff]" /> : null}
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </nav>

            <div className={cn("shrink-0 border-t border-[#eaecf0] dark:border-[#292d33]", expanded ? "px-3 pb-3 pt-3.5" : "p-2")}>
                <Link
                    href="/help"
                    prefetch
                    title="帮助"
                    onMouseEnter={() => router.prefetch("/help")}
                    onFocus={() => router.prefetch("/help")}
                    className={cn(
                        "relative flex min-h-[46px] items-center rounded-lg px-2 text-sm font-medium text-[#111827] transition-colors duration-150 hover:bg-[#f8f9fb] dark:text-[#c7cdd5] dark:hover:bg-[#20242a] dark:hover:text-[#f3f5f7]",
                        expanded ? "justify-start gap-3 px-2" : "justify-center",
                        helpActive && "bg-[#f0f2f4] text-[#1d2127] dark:bg-[#22262c] dark:text-[#f3f5f7]",
                    )}
                    aria-current={helpActive ? "page" : undefined}
                >
                    <CircleHelp className="size-[18px] shrink-0" />
                    {expanded ? (
                        <>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">帮助</span>
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-[#7f8995]" />
                        </>
                    ) : null}
                    {helpActive ? <span className="absolute right-0 h-4 w-0.5 rounded-full bg-[#5965ff]" /> : null}
                </Link>
            </div>
        </aside>
    );
}
