import { resolve, sep } from "node:path";
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getServerDataDir } from "@/lib/server/data-dir";
import { canAccessGenerationAsset } from "@/lib/server/generation-log-store";
import { createLocalMediaResponse, createMediaHeadResponse, mediaContentDisposition } from "@/lib/server/local-media-response";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import { acquireMediaConcurrency, withMediaConcurrency } from "@/lib/server/media-concurrency";
import { createExternalMediaReadUrl } from "@/lib/server/object-storage-service";
import { verifyGenerationAssetSignature } from "@/lib/server/reference-asset-access";
import { checkLocalMediaRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
    return serveGenerationAsset(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
    return serveGenerationAsset(request, context);
}

async function serveGenerationAsset(request: Request, context: RouteContext) {
    const { path } = await context.params;
    const storagePath = (path || []).join("/");
    const url = new URL(request.url);
    const signature = url.searchParams.get("signature") || "";
    let registration: Awaited<ReturnType<typeof getLocalMediaRegistration>> = null;
    if (signature) registration = await getLocalMediaRegistration(storagePath);
    if (signature && !registration) return NextResponse.json({ error: "资源不存在" }, { status: 404 });
    const signed = Boolean(registration && verifyGenerationAssetSignature(storagePath, url.searchParams.get("purpose"), url.searchParams.get("expires"), signature, registration.ownerUserId));
    if (signed && url.searchParams.get("download") === "original") return NextResponse.json({ code: 403, data: null, msg: "上游读取签名不提供原件下载" }, { status: 403 });
    let rateIdentity = `signature:${signature}`;
    let currentUser: Awaited<ReturnType<typeof getCurrentUser>> = null;
    if (!signed) {
        currentUser = await getCurrentUser(request);
        if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
        rateIdentity = `user:${currentUser.id}`;
    }
    const rate = await checkLocalMediaRateLimit(rateIdentity, request);
    if (!rate.allowed) return NextResponse.json({ error: "媒体访问过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    const root = resolve(getServerDataDir(), "generation-assets");
    const filePath = resolve(root, ...(path || []));
    const downloadOriginal = url.searchParams.get("download") === "original";
    if (!isInsideRoot(filePath, root)) return NextResponse.json({ error: "资源不存在" }, { status: 404 });
    const assetUrl = `/api/generation-log-assets/${(path || []).join("/")}`;
    if (currentUser && !(await canAccessGenerationAsset(currentUser.id, currentUser.role, assetUrl))) return NextResponse.json({ error: "资源不存在" }, { status: 404 });

    registration ||= await getLocalMediaRegistration((path || []).join("/"));
    if (request.method === "HEAD" && registration?.storageProvider === "object") {
        return createMediaHeadResponse(registration.mimeType, registration.bytes, {
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": mediaContentDisposition(downloadOriginal ? "attachment" : "inline", registration.originalName || path.at(-1) || "media", registration.mimeType, downloadOriginal ? registration.storageKey || path.join("/") : ""),
        });
    }
    const permit = acquireMediaConcurrency("local", rateIdentity);
    if (!permit) return NextResponse.json({ error: "媒体并发访问过多，请稍后重试" }, { status: 429, headers: { "Retry-After": "2" } });
    if (registration?.storageProvider === "object") {
        try {
            const externalUrl = await createExternalMediaReadUrl(request, registration);
            permit.release();
            return externalUrl ? externalMediaRedirect(externalUrl) : NextResponse.json({ error: "资源不存在" }, { status: 404 });
        } catch (error) {
            permit.release();
            console.error("Generation object storage read failed", error);
            return NextResponse.json({ error: "外部存储文件读取失败" }, { status: 502 });
        }
    }
    try {
        const mimeType = registration?.mimeType || contentType(filePath);
        const response = await createLocalMediaResponse(request, filePath, mimeType, {
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": mediaContentDisposition(downloadOriginal ? "attachment" : "inline", registration?.originalName || path.at(-1) || "media", mimeType, downloadOriginal ? registration?.storageKey || (path || []).join("/") : ""),
        });
        if (!response) {
            permit.release();
            return NextResponse.json({ error: "资源不存在" }, { status: 404 });
        }
        return withMediaConcurrency(response, permit, request.signal);
    } catch (error) {
        permit.release();
        throw error;
    }
}

function externalMediaRedirect(url: string) {
    const response = NextResponse.redirect(url, 307);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Cross-Origin-Resource-Policy", "same-site");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return response;
}

function isInsideRoot(filePath: string, root: string) {
    return filePath === root || filePath.startsWith(`${root}${sep}`);
}

function contentType(filePath: string) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mov")) return "video/quicktime";
    return lower.includes("\\videos\\") || lower.includes("/videos/") ? "video/mp4" : "image/png";
}
