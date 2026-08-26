import type { ImageTaskReference } from "@/lib/server/image-task-store";
import { isRemoteMediaUrl } from "@/lib/browser-media-url";
import { writeReferenceImageDataUrl } from "@/lib/server/reference-asset-store";
import { createSignedReferenceAssetUrl, signGenerationAssetInputUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { requireManagedMediaInputOwner } from "@/lib/server/managed-media-input-access";

export function referenceRequestUrl(reference: ImageTaskReference, origin = "") {
    return referenceRequestUrlCandidates(reference, origin)[0] || "";
}

export function jsonImageReferenceRequestUrl(reference: ImageTaskReference, origin = "") {
    const remoteUrl = referenceRequestUrlCandidates(reference, origin).find((value) => isExternalPublicMediaUrl(value));
    if (remoteUrl) return remoteUrl;
    return referenceRequestUrl(reference, origin);
}

export async function publicImageReferenceRequestUrl(reference: ImageTaskReference, origin: string, publicOrigin: string, context: { ownerUserId: string; taskId: string }) {
    const candidates = referenceRequestUrlCandidates(reference, origin);
    const managedCandidate = candidates.map((value) => managedMediaInput(value, origin, publicOrigin)).find((value): value is { value: string; pathname: string; scope: "reference" | "generation" } => Boolean(value));
    if (managedCandidate) {
        const registeredOwnerUserId = await requireManagedMediaInputOwner(managedCandidate.pathname, { id: context.ownerUserId, role: "user" }, managedCandidate.scope);
        const signedUrl = managedCandidate.scope === "reference" ? signReferenceAssetInputUrl(managedCandidate.value, publicOrigin, registeredOwnerUserId) : signGenerationAssetInputUrl(managedCandidate.value, publicOrigin, registeredOwnerUserId);
        if (signedUrl !== managedCandidate.value) return signedUrl;
        throw new Error("站内参考素材签名不可用，请配置 VOZEB_PRO_ENCRYPTION_KEY");
    }
    const publicCandidate = candidates.find((value) => isExternalPublicMediaUrl(value));
    if (publicCandidate) return publicCandidate;

    const dataUrl = (reference.dataUrl || "").trim();
    if (!/^data:image\//i.test(dataUrl)) throw new Error("\u53c2\u8003\u56fe\u9700\u8981\u516c\u7f51\u56fe\u7247 URL\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\u53c2\u8003\u56fe");
    const asset = await writeReferenceImageDataUrl(dataUrl, { ownerUserId: context.ownerUserId, source: "image-task-reference", taskId: context.taskId });
    if (asset.url) return asset.url;
    if (!isExternalPublicOrigin(publicOrigin)) throw new Error("参考图需要公网图片 URL；本地开发 localhost 不能直接提交给上游，请部署后配置 NEXT_PUBLIC_SITE_URL");
    const signedUrl = createSignedReferenceAssetUrl(asset.token, publicOrigin, context.ownerUserId);
    if (!signedUrl) throw new Error("站内参考素材签名不可用，请配置 VOZEB_PRO_ENCRYPTION_KEY");
    return asset.url || signedUrl;
}

function managedMediaInput(value: string, internalOrigin: string, publicOrigin: string) {
    try {
        const publicSiteOrigin = new URL(publicOrigin).origin;
        const internalSiteOrigin = new URL(internalOrigin).origin;
        const url = new URL(value, internalSiteOrigin);
        if (url.origin !== publicSiteOrigin && url.origin !== internalSiteOrigin) return null;
        if (url.pathname.startsWith("/api/reference-assets/")) return { value, pathname: url.pathname, scope: "reference" as const };
        if (url.pathname.startsWith("/api/generation-log-assets/")) return { value, pathname: url.pathname, scope: "generation" as const };
    } catch {
        return null;
    }
    return null;
}

export function referenceRequestUrlCandidates(reference: ImageTaskReference, origin = "") {
    return uniqueStrings([reference.remoteUrl, reference.url, reference.serverUrl, reference.dataUrl].map((value) => normalizeReferenceRequestUrl(value || "", origin)).filter(Boolean));
}

export function rawReferenceRequestUrlCandidates(reference: ImageTaskReference) {
    return uniqueStrings([reference.remoteUrl, reference.url, reference.serverUrl, reference.dataUrl].map((value) => (value || "").trim()).filter(Boolean));
}

export function uniqueStrings(values: string[]) {
    return Array.from(new Set(values));
}

export function normalizeReferenceRequestUrl(value: string, origin: string) {
    const url = value.trim();
    if (!url || isRemoteMediaUrl(url) || /^(data|blob):/i.test(url) || !origin) return url;
    try {
        const absolute = new URL(url, origin);
        const proxiedUrl = absolute.searchParams.get("url") || "";
        if ((absolute.pathname === "/api/media-proxy" || /^\/api\/ai\/system\/[^/]+\/_media$/.test(absolute.pathname)) && isRemoteMediaUrl(proxiedUrl)) return proxiedUrl;
        if (url.startsWith("/")) return absolute.toString();
    } catch {
        return url;
    }
    return url;
}

export function requestPublicOrigin(request: Request) {
    return resolvePublicRequestOrigin(request);
}

export function normalizePublicOrigin(value: string) {
    try {
        const url = new URL(value.trim().replace(/\/+$/, ""));
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        return url.origin;
    } catch {
        return "";
    }
}

export function isExternalPublicOrigin(value: string) {
    if (!value) return false;
    try {
        return isExternalPublicHost(new URL(value).hostname);
    } catch {
        return false;
    }
}

export function isExternalPublicMediaUrl(value: string) {
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        return isExternalPublicHost(new URL(url).hostname);
    } catch {
        return false;
    }
}

export function isExternalPublicHost(hostname: string) {
    const host = hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return false;
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
        const [a, b] = parts;
        return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0);
    }
    return host.includes(".");
}
