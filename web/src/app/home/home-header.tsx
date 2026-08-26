"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeStore } from "@/stores/use-theme-store";
import { HOME_NAVIGATION, type HomeNavigationItem } from "./home-data";
import { useHomeActions } from "./home-actions";
import styles from "./home.module.css";

export function HomeHeader() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const [navIndicator, setNavIndicator] = useState({ left: 0, width: 0, visible: false });
    const navItemRefs = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([]);
    const hoveredNavIndex = useRef<number | null>(null);
    const { authenticated, site, openRegister, openBillingPlans, openProtectedPath } = useHomeActions();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);

    const moveNavIndicator = useCallback((index: number) => {
        const item = navItemRefs.current[index];
        if (!item) return;
        setNavIndicator({ left: item.offsetLeft, width: item.offsetWidth, visible: true });
    }, []);

    const hideNavIndicator = useCallback(() => {
        hoveredNavIndex.current = null;
        setNavIndicator((current) => ({ ...current, visible: false }));
    }, []);

    useLayoutEffect(() => {
        const updateIndicator = () => {
            if (hoveredNavIndex.current !== null) moveNavIndicator(hoveredNavIndex.current);
        };
        window.addEventListener("resize", updateIndicator);
        return () => window.removeEventListener("resize", updateIndicator);
    }, [moveNavIndicator]);

    const activate = (item: HomeNavigationItem) => {
        setMobileOpen(false);
        if (item.action === "billing") openBillingPlans();
        if (item.action === "protected") openProtectedPath(item.href);
    };

    const trackNavItem = (index: number) => {
        hoveredNavIndex.current = index;
        moveNavIndicator(index);
    };

    return (
        <header className={styles.header}>
            <div className={styles.headerInner}>
                <Link href="/" className={styles.brand} aria-label={`${site.title} 首页`}>
                    <SiteLogo logoUrl={site.logoUrl} className={styles.brandLogo} />
                    <span>{site.title}</span>
                </Link>

                <nav
                    className={styles.desktopNav}
                    aria-label="官网主导航"
                    onPointerLeave={hideNavIndicator}
                    onBlur={(event) => {
                        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) hideNavIndicator();
                    }}
                >
                    <span className={styles.navGlassIndicator} data-testid="home-nav-glass" aria-hidden="true" style={{ left: navIndicator.left, opacity: navIndicator.visible ? 1 : 0, width: navIndicator.width }} />
                    {HOME_NAVIGATION.map((item, index) =>
                        item.action !== "link" ? (
                            <button
                                key={item.href}
                                ref={(node) => {
                                    navItemRefs.current[index] = node;
                                }}
                                type="button"
                                className={styles.navLink}
                                onClick={() => activate(item)}
                                onPointerEnter={() => trackNavItem(index)}
                                onFocus={() => trackNavItem(index)}
                            >
                                {item.label}
                            </button>
                        ) : (
                            <Link
                                key={item.href}
                                ref={(node) => {
                                    navItemRefs.current[index] = node;
                                }}
                                href={item.href}
                                className={styles.navLink}
                                onPointerEnter={() => trackNavItem(index)}
                                onFocus={() => trackNavItem(index)}
                            >
                                {item.label}
                            </Link>
                        ),
                    )}
                </nav>

                <div className={styles.headerActions}>
                    <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={styles.themeButton} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
                    <button type="button" className={styles.primarySmallButton} onClick={() => (authenticated ? openProtectedPath("/create") : openRegister("/create"))}>
                        {authenticated ? "开始创作" : "立即体验"}
                    </button>
                    <button type="button" className={styles.mobileMenuButton} onClick={() => setMobileOpen((value) => !value)} aria-expanded={mobileOpen} aria-controls="home-mobile-menu" aria-label={mobileOpen ? "关闭导航菜单" : "打开导航菜单"}>
                        {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
                    </button>
                </div>
            </div>

            {mobileOpen ? (
                <nav id="home-mobile-menu" className={styles.mobileNav} aria-label="移动端导航">
                    {HOME_NAVIGATION.map((item) =>
                        item.action !== "link" ? (
                            <button key={item.href} type="button" onClick={() => activate(item)}>
                                {item.label}
                                <ArrowRight aria-hidden="true" />
                            </button>
                        ) : (
                            <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}>
                                {item.label}
                                <ArrowRight aria-hidden="true" />
                            </Link>
                        ),
                    )}
                </nav>
            ) : null}
        </header>
    );
}
