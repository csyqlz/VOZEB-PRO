import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { UnsupportedMediaContentError } from "@/lib/server/media-content-validation";
import { acquireMediaConcurrency, withMediaConcurrency } from "@/lib/server/media-concurrency";
import { MediaProxyResponseError, fetchSafeUpstreamMedia } from "@/lib/server/media-proxy-service";
import { MAX_MEDIA_PROXY_BYTES, MAX_MEDIA_PROXY_RANGE_BYTES, normalizeMediaProxyRange } from "@/lib/server/media-response-limit";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { checkMediaProxyRateLimit, isSafeOutboundUrl, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEDIA_PROXY_TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 4;

export async function GET(request: Request) {
    return proxyMedia(request, "GET");
}

export async function HEAD(request: Request) {
    return proxyMedia(request, "HEAD");
}

async function proxyMedia(request: Request, method: "GET" | "HEAD") {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rate = await checkMediaProxyRateLimit(currentUser.id, request);
    if (!rate.allowed) return NextResponse.json({ error: "媒体访问过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });

    const target = await readTargetUrl(request);
    if (!target) return NextResponse.json({ error: "Invalid media url" }, { status: 400 });
    const range = normalizeMediaProxyRange(request.headers.get("range"));
    if (range === "invalid") return NextResponse.json({ error: "Invalid media range" }, { status: 416 });
    const permit = acquireMediaConcurrency("proxy", `user:${currentUser.id}`);
    if (!permit) return NextResponse.json({ error: "媒体并发访问过多，请稍后重试" }, { status: 429, headers: { "Retry-After": "2" } });

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(MEDIA_PROXY_TIMEOUT_MS)]);
    try {
        const maxBytes = range ? MAX_MEDIA_PROXY_RANGE_BYTES : MAX_MEDIA_PROXY_BYTES;
        const media = await fetchSafeUpstreamMedia({ method, range, maxBytes, timeoutMs: MEDIA_PROXY_TIMEOUT_MS, fetcher: (nextMethod, nextRange) => fetchMedia(target, nextMethod, nextRange, signal) });
        const headers = mediaHeaders(media.response.headers, media.mimeType);
        if (method === "HEAD") {
            permit.release();
            return new NextResponse(null, { status: media.response.status, headers });
        }
        return withMediaConcurrency(new NextResponse(media.body, { status: media.response.status, headers }), permit, request.signal);
    } catch (error) {
        permit.release();
        if (error instanceof UnsupportedMediaContentError || error instanceof MediaProxyResponseError) return NextResponse.json({ error: error.message }, { status: error.status });
        return NextResponse.json({ error: "Media fetch failed" }, { status: 502 });
    }
}

async function readTargetUrl(request: Request) {
    const raw = new URL(request.url).searchParams.get("url") || "";
    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        return null;
    }
    return (await isSafeTarget(target)) ? target : null;
}

async function fetchMedia(target: URL, method: "GET" | "HEAD", range: string | null, signal: AbortSignal) {
    let current = target;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const response = await fetchSafeOutbound(current, {
            method,
            headers: {
                "User-Agent": "VOZEB-PRO-Media-Proxy/0.0.7",
                ...(range ? { Range: range } : {}),
            },
            cache: "no-store",
            redirect: "manual",
            signal,
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) throw new Error("Too many media redirects");
        current = new URL(location, current);
    }
    throw new Error("Media redirect failed");
}

function mediaHeaders(source: Headers, mimeType: string) {
    const headers = new Headers();
    headers.set("Content-Type", mimeType);
    headers.set("Cache-Control", "private, max-age=600");
    headers.set("Cross-Origin-Resource-Policy", "same-site");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    for (const key of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
        const value = source.get(key);
        if (value) headers.set(key, value);
    }
    return headers;
}

async function isSafeTarget(target: URL) {
    return isSafeOutboundUrl(target.toString(), { allowCredentials: false });
}
