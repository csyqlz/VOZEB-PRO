import { resolve, sep } from "node:path";
import { NextResponse } from "next/server";

import { getPublicAvatarStorageKey } from "@/lib/auth/store";
import { getServerDataDir } from "@/lib/server/data-dir";
import { getLocalMediaRegistration } from "@/lib/server/local-media-registry";
import { createLocalMediaResponse, createMediaHeadResponse, mediaContentDisposition } from "@/lib/server/local-media-response";
import { acquireMediaConcurrency, withMediaConcurrency } from "@/lib/server/media-concurrency";
import { createExternalMediaReadUrl } from "@/lib/server/object-storage-service";
import { readReferenceAsset } from "@/lib/server/reference-asset-store";
import { checkPublicMediaRateLimit, rateLimitHeaders } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ userId: string }> };

export async function GET(request: Request, context: Context) {
    return serveAvatar(request, context);
}

export async function HEAD(request: Request, context: Context) {
    return serveAvatar(request, context);
}

async function serveAvatar(request: Request, context: Context) {
    const { userId } = await context.params;
    if (new URL(request.url).searchParams.get("download")) return notFound();
    const rate = await checkPublicMediaRateLimit(`avatar:${userId}`, request);
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "头像访问过于频繁" }, { status: 429, headers: rateLimitHeaders(rate) });

    const storageKey = await getPublicAvatarStorageKey(userId);
    if (!storageKey) return notFound();
    const registration = await getLocalMediaRegistration(storageKey);
    if (!registration || registration.ownerUserId !== userId || registration.source !== "profile-avatar" || registration.storageClass !== "permanent" || registration.mimeType !== "image/webp") return notFound();

    const headers = {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        "Content-Disposition": mediaContentDisposition("inline", registration.originalName || "avatar.webp", registration.mimeType),
        "Cross-Origin-Resource-Policy": "same-site",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
    };
    if (request.method === "HEAD" && registration.storageProvider === "object") return createMediaHeadResponse("image/webp", registration.bytes, headers);

    const permit = acquireMediaConcurrency("public", `avatar:${userId}`);
    if (!permit) return NextResponse.json({ code: 429, data: null, msg: "头像访问并发过多" }, { status: 429, headers: { "Retry-After": "2" } });
    try {
        if (registration.storageProvider === "object") {
            const url = await createExternalMediaReadUrl(request, registration);
            permit.release();
            if (!url) return notFound();
            const response = NextResponse.redirect(url, 307);
            Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
            return response;
        }
        const filePath = registration.scope === "reference" ? (await readReferenceAsset(storageKey))?.filePath : safeGenerationPath(storageKey);
        if (!filePath) {
            permit.release();
            return notFound();
        }
        const response = await createLocalMediaResponse(request, filePath, "image/webp", headers);
        if (!response) {
            permit.release();
            return notFound();
        }
        return withMediaConcurrency(response, permit, request.signal);
    } catch (error) {
        permit.release();
        console.error("Public avatar read failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "头像读取失败" }, { status: 500 });
    }
}

function safeGenerationPath(storageKey: string) {
    const root = resolve(getServerDataDir(), "generation-assets");
    const filePath = resolve(root, storageKey);
    return filePath === root || filePath.startsWith(`${root}${sep}`) ? filePath : undefined;
}

function notFound() {
    return NextResponse.json({ code: 404, data: null, msg: "头像不存在" }, { status: 404 });
}
