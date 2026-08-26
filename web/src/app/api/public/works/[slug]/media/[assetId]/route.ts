import { resolve, sep } from "node:path";
import { NextResponse } from "next/server";

import { getServerDataDir } from "@/lib/server/data-dir";
import { createLocalMediaResponse, createMediaHeadResponse, mediaContentDisposition } from "@/lib/server/local-media-response";
import { acquireMediaConcurrency, withMediaConcurrency } from "@/lib/server/media-concurrency";
import { createExternalMediaReadUrl } from "@/lib/server/object-storage-service";
import { readReferenceAsset } from "@/lib/server/reference-asset-store";
import { checkPublicMediaRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { authorizePublicWorkPublicationAsset, WorkPublicationServiceError } from "@/lib/server/work-publication-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string; assetId: string }> };

export async function GET(request: Request, context: Context) {
    return servePublicWorkMedia(request, context);
}

export async function HEAD(request: Request, context: Context) {
    return servePublicWorkMedia(request, context);
}

async function servePublicWorkMedia(request: Request, context: Context) {
    const { slug, assetId } = await context.params;
    if (new URL(request.url).searchParams.get("download") === "original") return NextResponse.json({ code: 403, data: null, msg: "公开作品暂不提供原件下载" }, { status: 403 });
    const rate = await checkPublicMediaRateLimit(`${slug}:${assetId}`, request);
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "媒体访问过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });
    try {
        const { registration } = await authorizePublicWorkPublicationAsset(slug, assetId);
        if (request.method === "HEAD" && registration.storageProvider === "object") {
            return createMediaHeadResponse(registration.mimeType, registration.bytes, {
                "Cache-Control": "private, no-store",
                "Content-Disposition": mediaContentDisposition("inline", registration.originalName || registration.storageKey.split("/").at(-1) || "media", registration.mimeType),
            });
        }
        const permit = acquireMediaConcurrency("public", `${slug}:${assetId}`);
        if (!permit) return NextResponse.json({ code: 429, data: null, msg: "媒体并发访问过多，请稍后重试" }, { status: 429, headers: { "Retry-After": "2" } });
        if (registration.storageProvider === "object") {
            try {
                const url = await createExternalMediaReadUrl(request, registration);
                permit.release();
                if (!url) return notFound();
                const response = NextResponse.redirect(url, 307);
                response.headers.set("Cache-Control", "private, no-store");
                response.headers.set("Cross-Origin-Resource-Policy", "same-site");
                response.headers.set("X-Content-Type-Options", "nosniff");
                response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
                return response;
            } catch (error) {
                permit.release();
                throw error;
            }
        }

        try {
            const filePath = await localFilePath(registration.scope, registration.storageKey);
            if (!filePath) {
                permit.release();
                return notFound();
            }
            const response = await createLocalMediaResponse(request, filePath, registration.mimeType, {
                "Cache-Control": "private, no-store",
                "Content-Disposition": mediaContentDisposition("inline", registration.originalName || registration.storageKey.split("/").at(-1) || "media", registration.mimeType),
            });
            if (!response) {
                permit.release();
                return notFound();
            }
            return withMediaConcurrency(response, permit, request.signal);
        } catch (error) {
            permit.release();
            throw error;
        }
    } catch (error) {
        if (error instanceof WorkPublicationServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Public work media read failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "读取作品媒体失败" }, { status: 500 });
    }
}

async function localFilePath(scope: "generation" | "reference", storageKey: string) {
    if (scope === "reference") return (await readReferenceAsset(storageKey))?.filePath || null;
    const root = resolve(getServerDataDir(), "generation-assets");
    const filePath = resolve(root, storageKey);
    return filePath === root || filePath.startsWith(`${root}${sep}`) ? filePath : null;
}

function notFound() {
    return NextResponse.json({ code: 404, data: null, msg: "媒体不存在" }, { status: 404 });
}
