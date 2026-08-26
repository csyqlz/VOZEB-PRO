import { NextResponse } from "next/server";

import { browserIconHref, getPublicSiteSettings } from "@/lib/server/site-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const site = await getPublicSiteSettings();
    const configured = safeIconHref(browserIconHref(site), request.url);
    const target = configured && !isFaviconLoop(configured, request.url) ? configured : "/sub2-logo.png";
    const response = new NextResponse(null, { status: 307, headers: { Location: target } });
    response.headers.set("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return response;
}

function safeIconHref(value: string, base: string) {
    try {
        const url = new URL(value, base);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (value.trim().startsWith("/")) return `${url.pathname}${url.search}${url.hash}`;
        return url.toString();
    } catch {
        return null;
    }
}

function isFaviconLoop(value: string, requestUrl: string) {
    try {
        const target = new URL(value, requestUrl);
        const request = new URL(requestUrl);
        return target.origin === request.origin && target.pathname === "/favicon.ico";
    } catch {
        return false;
    }
}
