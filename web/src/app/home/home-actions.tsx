"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Modal } from "antd";
import { useRouter } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { BillingPlansModal } from "@/components/billing/billing-plans-modal";
import { SiteLogo } from "@/components/layout/site-logo";
import { createAgentPromptHref, type CreateAgentMode } from "@/lib/create-agent-prompt";
import { DEFAULT_SITE_SOCIALS } from "@/lib/auth/store-types";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { useUserStore } from "@/stores/use-user-store";
import type { HomeSiteSettings } from "./home-data";
import { resolveSiteTitle } from "@/lib/site-brand";

type HomeActions = {
    authenticated: boolean;
    sessionReady: boolean;
    site: HomeSiteSettings;
    openLogin: (nextPath?: string) => void;
    openBillingPlans: () => void;
    openProtectedPath: (path: string) => void;
    startCreating: (prompt?: string, mode?: CreateAgentMode) => void;
};

const HomeActionsContext = createContext<HomeActions | null>(null);
const previewSite: HomeSiteSettings = {
    title: "VOZEB PRO",
    logoUrl: "/logo.svg",
    seoDescription: "以项目为中心的 AI 创作平台。",
    footerCopyright: "VOZEB PRO",
    termsUrl: "/terms",
    privacyUrl: "/privacy",
    friendLinks: [],
    socials: DEFAULT_SITE_SOCIALS,
};
const previewActions: HomeActions = {
    authenticated: false,
    sessionReady: true,
    site: previewSite,
    openLogin: () => undefined,
    openBillingPlans: () => undefined,
    openProtectedPath: () => undefined,
    startCreating: () => undefined,
};

export function HomeActionsProvider({ initialSite, children }: { initialSite: HomeSiteSettings; children: ReactNode }) {
    const router = useRouter();
    const [authOpen, setAuthOpen] = useState(false);
    const [authNextPath, setAuthNextPath] = useState("/create");
    const [billingPlansOpen, setBillingPlansOpen] = useState(false);
    const user = useUserStore((state) => state.user);
    const session = usePublicSessionStore((state) => state.payload);
    const sessionReady = usePublicSessionStore((state) => state.ready);
    const sessionSite = session?.settings?.site;
    const site = useMemo<HomeSiteSettings>(
        () => ({
            ...initialSite,
            ...(sessionSite || {}),
            title: resolveSiteTitle(sessionSite?.title || initialSite.title),
            logoUrl: sessionSite?.logoUrl?.trim() || initialSite.logoUrl || "/logo.svg",
            friendLinks: sessionSite?.friendLinks || initialSite.friendLinks,
            socials: (sessionSite?.socials as HomeSiteSettings["socials"] | undefined) || initialSite.socials,
        }),
        [initialSite, sessionSite],
    );
    const authenticated = sessionReady && Boolean(user);

    const openLogin = (nextPath = "/create") => {
        setAuthNextPath(nextPath);
        setAuthOpen(true);
    };
    const openProtectedPath = (path: string) => {
        if (authenticated) router.push(path);
        else openLogin(path);
    };
    const startCreating = (prompt = "", mode: CreateAgentMode = "agent") => openProtectedPath(createAgentPromptHref(prompt, { source: "home", mode }));

    return (
        <HomeActionsContext.Provider value={{ authenticated, sessionReady, site, openLogin, openBillingPlans: () => setBillingPlansOpen(true), openProtectedPath, startCreating }}>
            {children}
            <Modal centered open={authOpen} width={740} footer={null} title={null} destroyOnHidden onCancel={() => setAuthOpen(false)} className="landing-auth-modal">
                <div className="landing-auth-modal-shell">
                    <section className="landing-auth-modal-brand">
                        <div className="inline-flex items-center gap-3 text-stone-950 dark:text-white">
                            <SiteLogo logoUrl={site.logoUrl} className="landing-auth-brand-logo bg-stone-950 dark:bg-white" />
                            <span className="text-xl font-semibold">{site.title}</span>
                        </div>
                        <div className="landing-auth-modal-copy">
                            <p className="landing-auth-modal-kicker text-sm font-medium">继续创作</p>
                            <h2 className="mt-3 text-3xl font-semibold leading-tight text-stone-950 dark:text-white">登录后回到刚才的位置</h2>
                            <p className="mt-4 text-sm leading-7 text-stone-500 dark:text-stone-300">已输入的内容会保留，登录成功后直接进入当前创作。</p>
                        </div>
                        <div className="landing-auth-modal-bullets grid gap-2 text-sm text-stone-600 dark:text-stone-300">
                            {["创作会话持续保存", "图片、视频与音频统一创作", "画布与短剧项目随时继续"].map((item) => (
                                <div key={item} className="flex items-center gap-2">
                                    <span className="landing-auth-feature-dot size-1.5 rounded-full" />
                                    <span>{item}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                    <div className="landing-auth-modal-form">
                        <AuthForm mode="login" variant="embedded" nextPath={authNextPath} className="min-h-0 bg-transparent p-0 shadow-none" />
                    </div>
                </div>
            </Modal>
            <BillingPlansModal open={billingPlansOpen} onClose={() => setBillingPlansOpen(false)} onSelect={(product) => openProtectedPath(`/billing/checkout?product=${encodeURIComponent(product.id)}`)} />
        </HomeActionsContext.Provider>
    );
}

export function HomeActionsPreviewProvider({ children }: { children: ReactNode }) {
    return <HomeActionsContext.Provider value={previewActions}>{children}</HomeActionsContext.Provider>;
}

export function useHomeActions() {
    const value = useContext(HomeActionsContext);
    if (!value) throw new Error("useHomeActions must be used within HomeActionsProvider");
    return value;
}
