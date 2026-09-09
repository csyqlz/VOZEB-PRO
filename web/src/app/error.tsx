"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { DEFAULT_SITE_TITLE } from "@/lib/site-brand";

export default function GlobalErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <main className="app-scroll-page grid min-h-dvh place-items-center bg-[#f8fafc] px-5 py-10 text-[#20242a] dark:bg-[#111316] dark:text-[#f3f5f7]">
            <section className="w-full max-w-md rounded-2xl border border-[#e2e7eb] bg-white p-7 text-center shadow-[0_18px_60px_rgba(32,36,42,0.08)] dark:border-[#30363e] dark:bg-[#181b20] dark:shadow-black/25 sm:p-9">
                <SiteLogo logoUrl="/logo.svg" className="mx-auto size-14" />
                <span className="mx-auto mt-6 grid size-10 place-items-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300">
                    <AlertTriangle className="size-5" aria-hidden="true" />
                </span>
                <h1 className="mt-4 text-xl font-semibold">页面暂时无法打开</h1>
                <p className="mt-2 text-sm leading-6 text-[#697381] dark:text-[#a7afb9]">{DEFAULT_SITE_TITLE}遇到了一点临时问题。你可以重新加载当前页面，或返回首页继续创作。</p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                    <button
                        type="button"
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#20242a] px-4 text-sm font-medium text-white transition hover:bg-[#343b44] dark:bg-white dark:text-[#20242a] dark:hover:bg-[#e8ebef]"
                        onClick={() => reset()}
                    >
                        <RefreshCw className="size-4" aria-hidden="true" />
                        重新加载
                    </button>
                    <Link
                        href="/"
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-[#dfe4e8] px-4 text-sm font-medium text-[#4d5662] transition hover:bg-[#f5f7f8] dark:border-[#3b424c] dark:text-[#dce1e7] dark:hover:bg-[#242930]"
                    >
                        <ArrowLeft className="size-4" aria-hidden="true" />
                        返回首页
                    </Link>
                </div>
            </section>
        </main>
    );
}
