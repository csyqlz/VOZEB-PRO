"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Mail, Send } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { DEFAULT_SUPPORT_EMAIL } from "@/lib/site-brand";
import { HOME_NAVIGATION, type HomeNavigationItem } from "./home-data";
import { useHomeActions } from "./home-actions";
import styles from "./home.module.css";

export function HomeCta() {
    const { site, startCreating } = useHomeActions();
    return (
        <section className={styles.cta} aria-labelledby="home-cta-title">
            <span className={`${styles.ctaCrystal} ${styles.ctaCrystalLeft}`} aria-hidden="true" />
            <span className={`${styles.ctaCrystal} ${styles.ctaCrystalRight}`} aria-hidden="true" />
            <div>
                <h2 id="home-cta-title">开启你的 AI 创作工作流</h2>
                <p>加入 {site.title}，释放你的创作潜力，让 AI 成为你最强的创作伙伴。</p>
            </div>
            <button type="button" onClick={() => startCreating()}>
                注册后开始创作 <ArrowRight aria-hidden="true" />
            </button>
        </section>
    );
}

export function HomeFooter() {
    const { site, openBillingPlans, openProtectedPath } = useHomeActions();
    const friendLinks = site.friendLinks.filter((item) => item.enabled && item.label.trim() && item.url.trim());
    const socials = Object.entries(site.socials).filter(([, item]) => item.enabled && item.label.trim() && item.url.trim());
    const supportEmail = extractMailtoAddress(site.socials.email?.url) || DEFAULT_SUPPORT_EMAIL;
    const copyright = site.footerCopyright?.trim();
    const policies = [site.privacyUrl?.trim() ? { label: "隐私政策", href: site.privacyUrl.trim() } : null, site.termsUrl?.trim() ? { label: "服务条款", href: site.termsUrl.trim() } : null].filter((item): item is { label: string; href: string } =>
        Boolean(item),
    );
    const navigationGroups: Array<{ title: string; items: readonly HomeNavigationItem[] }> = [
        { title: "产品", items: HOME_NAVIGATION },
        { title: "平台", items: [{ label: "公告中心", href: "/announcements", action: "link" }] },
    ];

    return (
        <footer className={styles.footer}>
            <div className={styles.footerGrid}>
                <div className={styles.footerBrand}>
                    <Link href="/" className={styles.footerLogo}>
                        <SiteLogo logoUrl={site.logoUrl} className={styles.brandLogo} />
                        <span>{site.title}</span>
                    </Link>
                    {site.seoDescription?.trim() ? <p>{site.seoDescription}</p> : null}
                    {supportEmail ? (
                        <a className="mt-3 inline-flex max-w-full break-all text-sm text-stone-500 underline-offset-4 transition hover:text-stone-950 hover:underline dark:text-stone-400 dark:hover:text-white" href={`mailto:${supportEmail}`}>
                            客服邮箱：{supportEmail}
                        </a>
                    ) : null}
                    {socials.length ? (
                        <div className={styles.footerSocials}>
                            {socials.map(([key, item]) => {
                                return (
                                    <a key={key} href={item.url} target={externalTarget(item.url)} rel={externalTarget(item.url) ? "noreferrer" : undefined} aria-label={item.label} title={item.label}>
                                        {socialIcon(key)}
                                    </a>
                                );
                            })}
                        </div>
                    ) : null}
                </div>

                <div className={styles.footerNavigation}>
                    {navigationGroups.map((group) => (
                        <FooterColumn key={group.title} title={group.title}>
                            {group.items.map((item) =>
                                item.action === "protected" ? (
                                    <button key={item.href} type="button" onClick={() => openProtectedPath(item.href)}>
                                        {item.label}
                                    </button>
                                ) : item.action === "billing" ? (
                                    <button key={item.href} type="button" onClick={openBillingPlans}>
                                        {item.label}
                                    </button>
                                ) : (
                                    <Link key={item.href} href={item.href}>
                                        {item.label}
                                    </Link>
                                ),
                            )}
                        </FooterColumn>
                    ))}
                    {friendLinks.length ? (
                        <FooterColumn title="友情链接">
                            {friendLinks.map((item) => (
                                <a key={item.id} href={item.url} target={externalTarget(item.url)} rel={externalTarget(item.url) ? "noreferrer" : undefined}>
                                    {item.label}
                                </a>
                            ))}
                        </FooterColumn>
                    ) : null}
                </div>
            </div>
            {copyright || policies.length ? (
                <div className={styles.footerBottom} data-testid="home-footer-bottom">
                    {copyright ? <span>{copyright}</span> : null}
                    {policies.length ? (
                        <div>
                            {policies.map((item) => (
                                <a key={item.label} href={item.href} target={externalTarget(item.href)} rel={externalTarget(item.href) ? "noreferrer" : undefined}>
                                    {item.label}
                                </a>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </footer>
    );
}

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
    return (
        <nav className={styles.footerColumn} aria-label={title}>
            <h2>{title}</h2>
            {children}
        </nav>
    );
}

function externalTarget(url: string) {
    return /^(https?:)?\/\//.test(url) ? "_blank" : undefined;
}

function extractMailtoAddress(value: string | undefined) {
    const match = value?.trim().match(/^mailto:([^?\s]+)(?:\?.*)?$/i);
    return match?.[1] || "";
}

function socialIcon(key: string) {
    if (key === "telegram") return <Send aria-hidden="true" />;
    if (key === "x") return <span aria-hidden="true">X</span>;
    if (key === "instagram") return <span aria-hidden="true">◎</span>;
    return <Mail aria-hidden="true" />;
}
