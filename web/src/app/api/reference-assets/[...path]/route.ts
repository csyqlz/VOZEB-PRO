import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { acquireMediaConcurrency, withMediaConcurrency } from "@/lib/server/media-concurrency";
import { verifyReferenceAssetSignature } from "@/lib/server/reference-asset-access";
import { createLocalMediaResponse, createMediaHeadResponse, mediaContentDisposition } from "@/lib/server/local-media-response";
import { getLocalMediaRegistration, isLocalMediaRegistrationExpired, type LocalMediaRegistration } from "@/lib/server/local-media-registry";
import { createExternalMediaReadUrl } from "@/lib/server/object-storage-service";
import { isReferenceAssetPath, readReferenceAsset } from "@/lib/server/reference-asset-store";
import { checkLocalMediaRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
    return serveReferenceAsset(request, context);
}

export async function HEAD(request: Request, context: RouteContext) {
    return serveReferenceAsset(request, context);
}

async function serveReferenceAsset(request: Request, context: RouteContext) {
    const { path } = await context.params;
    const storagePath = path.join("/");
    if (!isReferenceAssetPath(storagePath)) return NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
    const url = new URL(request.url);
    const signature = url.searchParams.get("signature") || "";
    let registration: LocalMediaRegistration | null = null;
    if (signature) registration = await getLocalMediaRegistration(storagePath);
    if (signature && (!registration || isLocalMediaRegistrationExpired(registration))) return NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
    const signed = Boolean(registration && !isLocalMediaRegistrationExpired(registration) && verifyReferenceAssetSignature(storagePath, url.searchParams.get("purpose"), url.searchParams.get("expires"), signature, registration.ownerUserId));
    if (signed && url.searchParams.get("download") === "original") return NextResponse.json({ code: 403, data: null, msg: "上游读取签名不提供原件下载" }, { status: 403 });
    let rateIdentity = `signature:${signature}`;
    let currentUser: Awaited<ReturnType<typeof getCurrentUser>> = null;
    if (!signed) {
        currentUser = await getCurrentUser(request);
        if (!currentUser) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
        rateIdentity = `user:${currentUser.id}`;
    }
    const rate = await checkLocalMediaRateLimit(rateIdentity, request);
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "媒体访问过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    registration ||= await getLocalMediaRegistration(storagePath);
    if (!registration) return NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
    if (isLocalMediaRegistrationExpired(registration)) return NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
    if (currentUser && currentUser.role !== "admin" && registration.ownerUserId !== currentUser.id) return NextResponse.json({ code: 404, data: null, msg: "媒体文件不存在" }, { status: 404 });
    if (request.method === "HEAD" && registration.storageProvider === "object") {
        return createMediaHeadResponse(registration.mimeType, registration.bytes, {
            "Cache-Control": storagePath.startsWith("permanent/") ? "private, max-age=86400" : "private, max-age=300",
            "Content-Disposition": mediaContentDisposition(
                url.searchParams.get("download") === "original" ? "attachment" : "inline",
                registration.originalName || path.at(-1) || "media",
                registration.mimeType,
                url.searchParams.get("download") === "original" ? registration.storageKey || storagePath : "",
            ),
        });
    }

    const permit = acquireMediaConcurrency("local", rateIdentity);
    if (!permit) return NextResponse.json({ code: 429, data: null, msg: "媒体并发访问过多，请稍后重试" }, { status: 429, headers: { "Retry-After": "2" } });
    if (registration.storageProvider === "object") {
        try {
            const externalUrl = await createExternalMediaReadUrl(request, registration);
            permit.release();
            return externalUrl ? externalMediaRedirect(externalUrl) : NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
        } catch (error) {
            permit.release();
            console.error("Reference object storage read failed", error);
            return NextResponse.json({ error: "外部存储文件读取失败" }, { status: 502 });
        }
    }
    try {
        const asset = await readReferenceAsset(storagePath);
        if (!asset) {
            permit.release();
            return NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
        }
        const response = await createLocalMediaResponse(request, asset.filePath, asset.mimeType, {
            "Cache-Control": storagePath.startsWith("permanent/") ? "private, max-age=86400" : "private, max-age=300",
            "Content-Disposition": mediaContentDisposition(
                url.searchParams.get("download") === "original" ? "attachment" : "inline",
                registration.originalName || path.at(-1) || "media",
                asset.mimeType,
                url.searchParams.get("download") === "original" ? registration.storageKey : "",
            ),
        });
        if (!response) {
            permit.release();
            return NextResponse.json({ error: "媒体文件不存在或已过期" }, { status: 404 });
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
