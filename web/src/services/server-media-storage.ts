"use client";

import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { CREATIVE_UPLOAD_MAX_BYTES, isCreativeUploadMimeType } from "@/lib/creative-upload";

export type ServerMediaType = "image" | "video" | "audio";
export type StoredServerMedia = { url: string; storageKey: string; bytes: number; mimeType: string };
export type ServerMediaReference = { url: string; storageKey: string; scope: "generation" | "reference" };

const SERVER_MEDIA_ROUTES = [
    { prefix: "/api/generation-log-assets/", scope: "generation" as const },
    { prefix: "/api/reference-assets/", scope: "reference" as const },
];

export async function uploadServerMedia(input: string | Blob, type: ServerMediaType, maxBytes = CREATIVE_UPLOAD_MAX_BYTES): Promise<StoredServerMedia> {
    const existing = typeof input === "string" ? parseServerMediaUrl(input) : null;
    if (existing?.storageKey.startsWith("permanent/")) return readExistingServerMedia(existing, type);

    const blob = typeof input === "string" ? await fetchMediaBlob(input) : input;
    const originalName = input instanceof File ? input.name.trim() : "";
    if (!blob.size) throw new Error("上传文件为空");
    if (blob.size > maxBytes) throw new Error(maxBytes === CREATIVE_UPLOAD_MAX_BYTES ? "单个文件不能超过 20MB" : "生成媒体文件过大");
    const declaredMimeType = blob.type.split(";", 1)[0]?.trim().toLowerCase() || "";
    const unknownMimeType = !declaredMimeType || declaredMimeType === "application/octet-stream";
    if (!unknownMimeType && (!isCreativeUploadMimeType(declaredMimeType) || !declaredMimeType.startsWith(`${type}/`))) throw new Error(`仅支持${type === "image" ? "图片" : type === "video" ? "视频" : "音频"}格式`);

    const form = new FormData();
    form.append("type", type);
    form.append("persistent", "true");
    form.append("file", blob, originalName || defaultUploadFileName(type, blob.type));
    const response = await fetch("/api/reference-assets", {
        method: "POST",
        body: form,
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; url?: string; token?: string; key?: string; bytes?: number; mimeType?: string };
    if (!response.ok || !payload.token) throw new Error(payload.error || "文件保存到服务器失败");
    return {
        url: payload.url || serverMediaUrl(payload.token),
        storageKey: payload.key || payload.token,
        bytes: payload.bytes || blob.size,
        mimeType: payload.mimeType || blob.type,
    };
}

export function serverMediaUrl(storageKey?: string, fallback = "") {
    const direct = parseServerMediaUrl(storageKey || "");
    if (direct) return direct.url;
    const key = (storageKey || "").trim().replace(/\\/g, "/");
    const fallbackReference = parseServerMediaUrl(fallback);
    if (fallbackReference && (!key || fallbackReference.storageKey === key)) return fallbackReference.url;
    if (!key) return browserReadableMediaUrl(fallback);
    if (key.startsWith("/") || /^https?:\/\//i.test(key)) return browserReadableMediaUrl(key);
    if (!/^(?:temporary|permanent)\//.test(key)) return browserReadableMediaUrl(fallback);
    return `/api/reference-assets/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseServerMediaUrl(value: string): ServerMediaReference | null {
    const source = (value || "").trim();
    if (!source) return null;
    try {
        const absolute = /^https?:\/\//i.test(source);
        if (absolute && (typeof window === "undefined" || new URL(source).origin !== window.location.origin)) return null;
        const parsed = new URL(source, "http://vozeb.local");
        const route = SERVER_MEDIA_ROUTES.find(({ prefix }) => parsed.pathname.startsWith(prefix));
        if (!route) return null;
        const storageKey = parsed.pathname.slice(route.prefix.length).split("/").map(decodeURIComponent).join("/");
        if (!/^(?:temporary|permanent)\//.test(storageKey)) return null;
        return { url: `${route.prefix}${storageKey.split("/").map(encodeURIComponent).join("/")}`, storageKey, scope: route.scope };
    } catch {
        return null;
    }
}

export function isPermanentServerMedia(storageKey?: string, serverUrl?: string) {
    const reference = parseServerMediaUrl(serverUrl || "") || parseServerMediaUrl(storageKey || "");
    const key = (storageKey || "").trim().replace(/\\/g, "/");
    return Boolean(reference?.storageKey.startsWith("permanent/") && (!key || key === reference.storageKey || parseServerMediaUrl(key)?.storageKey === reference.storageKey));
}

export async function getServerMediaBlob(storageKey: string, fallback = "") {
    const key = (storageKey || "").trim().replace(/\\/g, "/");
    const urls = new Set([serverMediaUrl(storageKey, fallback)]);
    if (!parseServerMediaUrl(storageKey) && !parseServerMediaUrl(fallback) && /^(?:temporary|permanent)\//.test(key)) {
        urls.add(`/api/generation-log-assets/${key.split("/").map(encodeURIComponent).join("/")}`);
    }
    for (const url of urls) {
        if (!url) continue;
        try {
            return await fetchMediaBlob(url);
        } catch {
            // The storage key is unique, but legacy records may not include its media scope.
        }
    }
    return null;
}

export function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(blob);
    });
}

async function fetchMediaBlob(url: string) {
    if (url.startsWith("data:")) return dataUrlToBlob(url);
    const response = await fetch(browserReadableMediaUrl(url), { cache: "no-store" });
    if (!response.ok) throw new Error("读取媒体失败");
    return response.blob();
}

async function readExistingServerMedia(reference: ServerMediaReference, type: ServerMediaType): Promise<StoredServerMedia> {
    const response = await fetch(reference.url, { method: "HEAD", cache: "no-store" });
    if (!response.ok) throw new Error("读取站内媒体失败");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || defaultMediaMimeType(type);
    if (!isCreativeUploadMimeType(mimeType) || !mimeType.startsWith(`${type}/`)) throw new Error(`站内媒体不是${type === "image" ? "图片" : type === "video" ? "视频" : "音频"}格式`);
    return {
        url: reference.url,
        storageKey: reference.storageKey,
        bytes: Math.max(0, Number(response.headers.get("content-length")) || 0),
        mimeType,
    };
}

function defaultMediaMimeType(type: ServerMediaType) {
    return type === "image" ? "image/png" : type === "video" ? "video/mp4" : "audio/mpeg";
}

function defaultUploadFileName(type: ServerMediaType, mimeType: string) {
    const extension = mimeType.split("/", 2)[1]?.replace("jpeg", "jpg").replace("mpeg", "mp3") || (type === "image" ? "png" : type === "video" ? "mp4" : "mp3");
    return `${type}.${extension}`;
}

function dataUrlToBlob(dataUrl: string) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) throw new Error("文件格式不正确");
    const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: match[1] });
}
