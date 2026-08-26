import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, Mail, RefreshCw } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { DEFAULT_SITE_TITLE, DEFAULT_SUPPORT_EMAIL } from "@/lib/site-brand";
import { getPublicSiteSettings } from "@/lib/server/site-metadata";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false, noarchive: true, nosnippet: true } };

export default async function ServiceUnavailablePage() {
    const site = await getPublicSiteSettings();
    const title = site.title?.trim() || DEFAULT_SITE_TITLE;
    const supportEmail = extractMailtoAddress(site.socials.email?.url) || DEFAULT_SUPPORT_EMAIL;

    return (
        <main className="app-scroll-page grid min-h-dvh place-items-center bg-[#f8fafc] px-5 py-10 text-[#20242a] dark:bg-[#111316] dark:text-[#f3f5f7]">
            <section className="w-full max-w-md rounded-2xl border border-[#e2e7eb] bg-white p-7 text-center shadow-[0_18px_60px_rgba(32,36,42,0.08)] dark:border-[#30363e] dark:bg-[#181b20] dark:shadow-black/25 sm:p-9">
                <SiteLogo logoUrl={site.logoUrl || "/logo.svg"} className="mx-auto size-14" />
                <span className="mx-auto mt-6 grid size-10 place-items-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300">
                    <AlertTriangle className="size-5" aria-hidden="true" />
                </span>
                <h1 className="mt-4 text-xl font-semibold">服务暂时不可用</h1>
                <p className="mt-2 text-sm leading-6 text-[#697381] dark:text-[#a7afb9]">{title}正在处理临时故障，数据不会因为刷新丢失。请稍后重新加载，或联系客户支持。</p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                    <Link
                        href="/service-unavailable"
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#20242a] px-4 text-sm font-medium text-white transition hover:bg-[#343b44] dark:bg-white dark:text-[#20242a] dark:hover:bg-[#e8ebef]"
                    >
                        <RefreshCw className="size-4" aria-hidden="true" />
                        重新加载
                    </Link>
                    <a
                        href={`mailto:${supportEmail}`}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#dfe4e8] px-4 text-sm font-medium text-[#4d5662] transition hover:bg-[#f5f7f8] dark:border-[#3b424c] dark:text-[#dce1e7] dark:hover:bg-[#242930]"
                    >
                        <Mail className="size-4" aria-hidden="true" />
                        联系客服
                    </a>
                </div>
                <Link href="/" className="mt-5 inline-flex text-sm font-medium text-[#697381] hover:text-[#20242a] dark:text-[#a7afb9] dark:hover:text-white">
                    返回首页
                </Link>
            </section>
        </main>
    );
}

function extractMailtoAddress(value: string | undefined) {
    const match = value?.trim().match(/^mailto:([^?\s]+)(?:\?.*)?$/i);
    return match?.[1] || "";
}
